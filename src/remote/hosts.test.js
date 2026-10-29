// 三级合并的纯函数测试：合并顺序、来源标记、坏配置容错。

import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterAll, describe, expect, it} from 'vitest';

import {collectDeployments, deploymentNotFoundText, findServer, mergeServers, readHostsFile, serverNotFoundText} from './hosts.js';

const workDir = mkdtempSync(join(tmpdir(), 'remote-hosts-'));
afterAll(() => rmSync(workDir, {recursive: true, force: true}));

/** @param {string} name @param {string} host @param {'ide'|'project'|'global'} source */
const server = (name, host, source) => ({name, host, port: 22, username: 'u', source});

describe('mergeServers', () => {
    it('同名时后传的层覆盖先传的（global < project < ide）', () => {
        const merged = mergeServers([
            [server('a', 'global-host', 'global'), server('g', 'g-host', 'global')],
            [server('b', 'project-host', 'project')],
            [server('a', 'ide-host', 'ide')],
        ]);
        expect(merged.map((entry) => `${entry.name}:${entry.host}:${entry.source}`)).toEqual([
            'a:ide-host:ide',
            'b:project-host:project',
            'g:g-host:global',
        ]);
    });

    it('空层不丢其它层', () => {
        expect(mergeServers([[], [server('a', 'h', 'project')], []])).toHaveLength(1);
    });

    it('项目级只补 deployment 时沿用低优先级的连接信息', () => {
        const merged = mergeServers([
            [{name: 'mbp', host: 'h', port: 22, username: 'u', password: 'p', deployments: [], source: 'global'}],
            [{name: 'mbp', deployments: [{name: 'app', localPath: '/l', deployPath: '/r'}], source: 'project'}],
        ]);
        expect(merged).toHaveLength(1);
        expect(merged[0].host).toBe('h');
        expect(merged[0].password).toBe('p');
        expect(merged[0].deployments).toEqual([{name: 'app', localPath: '/l', deployPath: '/r'}]);
        // 来源标最高优先级那层
        expect(merged[0].source).toBe('project');
    });

    it('高优先级层给了 authType 时以它的凭据为准（KEY_PAIR 能清掉旧的 password）', () => {
        const merged = mergeServers([
            [{name: 'a', host: 'h', username: 'u', password: 'p', source: 'global'}],
            [{name: 'a', authType: 'KEY_PAIR', privateKeyPath: '/k', source: 'ide'}],
        ]);
        expect(merged[0].password).toBeUndefined();
        expect(merged[0].privateKeyPath).toBe('/k');
    });
});

describe('findServer', () => {
    it('按 alias 也能找到（兼容旧 remote-shell 配置）', () => {
        const servers = [{
            name: 'remote-dev',
            alias: '远程开发机',
            host: 'h',
            port: 22,
            username: 'u',
            source: 'global',
        }];
        expect(findServer(servers, '远程开发机')?.name).toBe('remote-dev');
        expect(findServer(servers, 'remote-dev')?.name).toBe('remote-dev');
    });

    it('只做精确匹配，不猜', () => {
        const servers = [server('deploy1', 'h', 'ide')];
        expect(findServer(servers, 'deploy1')?.name).toBe('deploy1');
        expect(findServer(servers, 'dev1')).toBeUndefined();
    });
});

describe('serverNotFoundText', () => {
    it('列出全部候选并标出来源', () => {
        const text = serverNotFoundText(
            [server('deploy1', '10.0.0.5', 'ide'), server('5090', '10.0.0.9', 'global')],
            'dev1',
        );
        expect(text).toContain('没有名为 "dev1" 的服务器');
        expect(text).toContain('- deploy1  10.0.0.5:22  u  [IDE]');
        expect(text).toContain('- 5090  10.0.0.9:22  u  [全局]');
    });
});

describe('readHostsFile', () => {
    it('读 hosts 并标来源', () => {
        const path = join(workDir, 'good.json');
        writeFileSync(path, JSON.stringify({
            hosts: {dev: {host: '10.0.0.1', port: 2222, username: 'root', password: 'p'}},
        }));
        const servers = readHostsFile(path, 'project');
        expect(servers).toEqual([
            {
                name: 'dev',
                host: '10.0.0.1',
                port: 2222,
                username: 'root',
                password: 'p',
                deployments: [],
                source: 'project',
            },
        ]);
    });

    it('文件不存在 / JSON 坏 / 缺 host 时返回空数组，不抛', () => {
        const missing = join(workDir, 'missing.json');
        expect(readHostsFile(missing, 'global')).toEqual([]);

        const broken = join(workDir, 'broken.json');
        writeFileSync(broken, '{not json');
        expect(readHostsFile(broken, 'global')).toEqual([]);

        const noHost = join(workDir, 'no-host.json');
        writeFileSync(noHost, JSON.stringify({hosts: {bad: {username: 'u'}}}));
        expect(readHostsFile(noHost, 'global')).toEqual([]);
    });
});

describe('deployments', () => {
    it('从 host 条目里解析路径映射，缺一头的丢掉', () => {
        const path = join(workDir, 'with-deployments.json');
        writeFileSync(path, JSON.stringify({
            hosts: {
                dev: {
                    host: '10.0.0.1',
                    username: 'u',
                    deployments: [
                        {name: 'app', localPath: '/local/app', deployPath: '/srv/app'},
                        {name: 'broken', localPath: '/local/x'},
                    ],
                },
            },
        }));
        expect(readHostsFile(path, 'project')[0].deployments).toEqual([
            {name: 'app', localPath: '/local/app', deployPath: '/srv/app'},
        ]);
    });

    it('collectDeployments 摊平成全局表，并挂上所属 server', () => {
        const servers = [
            {...server('a', 'h1', 'global'), deployments: [{name: 'x', localPath: '/l', deployPath: '/r'}]},
            {...server('b', 'h2', 'ide'), deployments: [{name: 'y', localPath: '/l2', deployPath: '/r2'}]},
        ];
        const deployments = collectDeployments(servers);
        expect(deployments.map((entry) => `${entry.name}:${entry.server.name}`)).toEqual(['x:a', 'y:b']);
    });

    it('找不到 deployment 时列出全部候选', () => {
        const deployments = [{name: 'app', localPath: '/l', deployPath: '/r', server: server('a', 'h', 'ide')}];
        expect(deploymentNotFoundText(deployments, 'api')).toContain('app  /l ↔ a:/r');
    });
});

describe('只补 mapping 的条目', () => {
    it('没有 host / username 但带了 deployments 时保留为补丁', () => {
        const path = join(workDir, 'patch-only.json');
        writeFileSync(path, JSON.stringify({
            hosts: {mbp: {deployments: [{name: 'app', localPath: '/l', deployPath: '/r'}]}},
        }));
        const servers = readHostsFile(path, 'project');
        expect(servers).toHaveLength(1);
        expect(servers[0].host).toBeUndefined();
        expect(servers[0].deployments).toHaveLength(1);
    });
});
