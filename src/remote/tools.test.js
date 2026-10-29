// remote_exec 的编排测试：缓存、未命中全量刷新、IDE 不可用时的降级。
//
// 真正的 SSH 连接不在单测里跑 —— 这里只验证"用哪一份服务器列表"。

import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterAll, describe, expect, it} from 'vitest';

import {createRemoteToolset, remoteDownloadTool, remoteExecTool, remoteListServersTool, remoteUploadTool} from './tools.js';

const workDir = mkdtempSync(join(tmpdir(), 'remote-tools-'));
afterAll(() => rmSync(workDir, {recursive: true, force: true}));

/** 准备一个项目，带可选的 `.opencode/remote-shell/hosts.json`。 */
function projectWith(options = {}) {
    const root = mkdtempSync(join(workDir, 'project-'));
    if (options.projectHosts) {
        const dir = join(root, '.opencode', 'remote-shell');
        mkdirSync(dir, {recursive: true});
        writeFileSync(join(dir, 'hosts.json'), JSON.stringify({hosts: options.projectHosts}));
    }
    const globalPath = join(workDir, `global-${Math.random().toString(36).slice(2)}.json`);
    if (options.globalHosts) {
        writeFileSync(globalPath, JSON.stringify({hosts: options.globalHosts}));
    }
    return {root, globalPath};
}

const ideServer = (name, overrides = {}) => ({
    name,
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    password: 'p',
    source: 'ide',
    ...overrides,
});

describe('createRemoteToolset', () => {
    it('缓存窗口内不重复打 IDE', async () => {
        const {root, globalPath} = projectWith();
        let calls = 0;
        const toolset = createRemoteToolset({
            projectPath: root,
            globalHostsPath: globalPath,
            fetchIdeServers: async () => {
                calls += 1;
                return [ideServer('a')];
            },
        });

        await toolset.load();
        await toolset.load();
        expect(calls).toBe(1);
    });

    it('IDE 不可用时退到项目级 / 全局，且项目级覆盖全局', async () => {
        const {root, globalPath} = projectWith({
            globalHosts: {a: {host: 'global-host', username: 'u'}, b: {host: 'global-only', username: 'u'}},
            projectHosts: {a: {host: 'project-host', username: 'u'}},
        });
        const toolset = createRemoteToolset({
            projectPath: root,
            globalHostsPath: globalPath,
            fetchIdeServers: async () => {
                throw new Error('IDE down');
            },
        });

        const servers = await toolset.load();
        expect(servers.map((entry) => `${entry.name}:${entry.host}:${entry.source}`)).toEqual([
            'a:project-host:project',
            'b:global-only:global',
        ]);
    });

    it('三层都只有 mapping 的条目会被丢掉（没有连接信息）', async () => {
        const {root, globalPath} = projectWith({
            projectHosts: {ghost: {deployments: [{name: 'app', localPath: '/l', deployPath: '/r'}]}},
        });
        const toolset = createRemoteToolset({
            projectPath: root,
            globalHostsPath: globalPath,
            fetchIdeServers: async () => [],
        });
        expect(await toolset.load()).toEqual([]);
    });

    it('未命中会强制全量刷新（不是只查那个 key）', async () => {
        const {root, globalPath} = projectWith();
        let calls = 0;
        const toolset = createRemoteToolset({
            projectPath: root,
            globalHostsPath: globalPath,
            fetchIdeServers: async () => {
                calls += 1;
                // 第一次只有 a；第二次新增了 deploy1 —— 模拟"用户在 IDE 里刚加完"。
                // 新条目故意不带密码：这样 exec 走到 no-credentials 就停，不会真的连 SSH。
                return calls === 1
                    ? [ideServer('a')]
                    : [ideServer('a'), ideServer('deploy1', {password: undefined})];
            },
        });

        const outcome = await toolset.exec('deploy1', 'true');
        expect(calls).toBe(2);
        expect(outcome.kind).toBe('no-credentials');
    }, 20000);
});

describe('工具定义', () => {
    it('remote_exec / remote_list_servers 的 schema', () => {
        const toolset = createRemoteToolset({
            projectPath: workDir,
            globalHostsPath: join(workDir, 'none.json'),
            fetchIdeServers: async () => [],
        });
        const exec = remoteExecTool(toolset);
        expect(exec.name).toBe('remote_exec');
        expect(exec.input.required).toEqual(['server', 'command']);

        const list = remoteListServersTool(toolset);
        expect(list.name).toBe('remote_list_servers');
    });

    it('名字传错时返回全部候选，而不是一句"不存在"', async () => {
        const {root, globalPath} = projectWith({globalHosts: {5090: {host: 'h', username: 'u'}}});
        const toolset = createRemoteToolset({
            projectPath: root,
            globalHostsPath: globalPath,
            fetchIdeServers: async () => [ideServer('deploy1')],
        });
        const exec = remoteExecTool(toolset);
        const {content} = await exec.execute({server: 'dev1', command: 'ls'});
        expect(content).toContain('没有名为 "dev1" 的服务器');
        expect(content).toContain('deploy1');
        expect(content).toContain('5090');
    });
});

describe('文件同步工具', () => {
    it('deployment 名找不到时列出全部候选', async () => {
        const {root, globalPath} = projectWith({
            globalHosts: {
                dev: {
                    host: 'h',
                    username: 'u',
                    password: 'p',
                    deployments: [{name: 'app', localPath: '/local/app', deployPath: '/srv/app'}],
                },
            },
        });
        const toolset = createRemoteToolset({
            projectPath: root,
            globalHostsPath: globalPath,
            fetchIdeServers: async () => [],
        });
        const {content} = await remoteUploadTool(toolset).execute({deployment: 'api'});
        expect(content).toContain('没有名为 "api" 的 deployment');
        expect(content).toContain('app  /local/app ↔ dev:/srv/app');
    });

    it('mapping 名对但没凭据时报错，不尝试连接', async () => {
        const {root, globalPath} = projectWith({
            globalHosts: {
                dev: {
                    host: 'h',
                    username: 'u',
                    deployments: [{name: 'app', localPath: '/local/app', deployPath: '/srv/app'}],
                },
            },
        });
        const toolset = createRemoteToolset({
            projectPath: root,
            globalHostsPath: globalPath,
            fetchIdeServers: async () => [],
        });
        const {content} = await remoteDownloadTool(toolset).execute({deployment: 'app'});
        expect(content).toContain('用密码认证，但没有密码');
    });

    it('remote_list_servers 带出 mapping', async () => {
        const {root, globalPath} = projectWith({
            globalHosts: {
                dev: {
                    host: 'h',
                    username: 'u',
                    password: 'p',
                    deployments: [{name: 'app', localPath: '/local/app', deployPath: '/srv/app'}],
                },
            },
        });
        const toolset = createRemoteToolset({
            projectPath: root,
            globalHostsPath: globalPath,
            fetchIdeServers: async () => [],
        });
        const {content} = await remoteListServersTool(toolset).execute({});
        expect(content).toContain('- dev  h:22  u  [全局]');
        expect(content).toContain('app  /local/app ↔ /srv/app');
    });
});

describe('认证方式', () => {
    it('三种方式各自判断能不能连', async () => {
        const {hasUsableCredentials} = await import('./tools.js');
        expect(hasUsableCredentials({authType: 'PASSWORD', password: 'p'})).toBe(true);
        expect(hasUsableCredentials({authType: 'PASSWORD'})).toBe(false);
        expect(hasUsableCredentials({authType: 'KEY_PAIR', privateKeyPath: '/k'})).toBe(true);
        expect(hasUsableCredentials({authType: 'KEY_PAIR'})).toBe(false);
        // OpenSSH 靠 agent，本地没有字段也是可用的
        expect(hasUsableCredentials({authType: 'OPEN_SSH'})).toBe(true);
    });

    it('配置好的 KEY_PAIR 不会被当成缺凭据', async () => {
        const {root, globalPath} = projectWith({
            globalHosts: {
                dev: {
                    host: 'h',
                    username: 'u',
                    authType: 'KEY_PAIR',
                    privateKeyPath: '/nonexistent/key',
                    deployments: [{name: 'app', localPath: '/l', deployPath: '/r'}],
                },
            },
        });
        const toolset = createRemoteToolset({
            projectPath: root,
            globalHostsPath: globalPath,
            fetchIdeServers: async () => [],
        });
        // 会去连 SSH（私钥不存在 → 读文件失败），但错误不是"没有凭据"
        const {content} = await remoteUploadTool(toolset).execute({deployment: 'app'});
        expect(content).not.toContain('没有可用于 SSH 的凭据');
    });
});
