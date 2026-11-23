// remote-deployment skill 的 hosts.mjs：只测代码契约（校验 / 保留字段 / 删除保护），
// 不测 SKILL.md 的文案。

import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterAll, describe, expect, it} from 'vitest';

import {
    auditHosts,
    hostsConfigPath,
    removeDeployment,
    upsertDeployment,
} from '../skills/remote-deployment/assets/hosts.mjs';

const workDir = mkdtempSync(join(tmpdir(), 'hosts-script-'));
afterAll(() => rmSync(workDir, {recursive: true, force: true}));

function projectWith(hosts) {
    const root = mkdtempSync(join(workDir, 'project-'));
    mkdirSync(join(root, '.opencode', 'remote-shell'), {recursive: true});
    writeFileSync(hostsConfigPath(root), `${JSON.stringify({hosts}, null, 2)}\n`, 'utf8');
    return root;
}

const server = (overrides = {}) => ({
    host: '10.0.0.1',
    port: 22,
    username: 'u',
    password: 'p',
    deployments: [],
    ...overrides,
});

const deployment = (name, overrides = {}) => ({
    name,
    localPath: `apps/${name}`,
    deployPath: `/srv/${name}`,
    ...overrides,
});

describe('auditHosts', () => {
    it('合法配置没有 error', () => {
        const root = projectWith({mbp: server({deployments: [deployment('app')]})});
        const report = auditHosts(root);
        expect(report.findings.filter((finding) => finding.level === 'error')).toEqual([]);
        expect(report.deployments).toBe(1);
    });

    it('项目级绝对 localPath 与相对 deployPath 都点名', () => {
        const root = projectWith({
            mbp: server({
                deployments: [
                    deployment('abs', {localPath: '/Users/me/app'}),
                    deployment('rel', {deployPath: 'srv/app'}),
                ],
            }),
        });
        const errors = auditHosts(root).findings.filter((finding) => finding.level === 'error');
        expect(errors.map((finding) => finding.deployment)).toEqual(['abs', 'rel']);
        expect(errors[0].message).toContain('必须是相对项目根目录');
        expect(errors[1].message).toContain('必须是远端绝对路径');
    });

    it('通配符 exclude 与跨 server 重名都算 error', () => {
        const root = projectWith({
            a: server({deployments: [deployment('app', {exclude: ['logs/*.log']})]}),
            b: server({deployments: [deployment('app')]}),
        });
        const messages = auditHosts(root).findings
            .filter((finding) => finding.level === 'error')
            .map((finding) => finding.message);
        expect(messages.some((message) => message.includes('不支持通配符'))).toBe(true);
        expect(messages.some((message) => message.includes('deployment 名重复'))).toBe(true);
    });

    it('localPath 用反斜杠时 audit 与 upsert 都直接报错', () => {
        const root = projectWith({
            mbp: server({deployments: [deployment('app', {localPath: 'apps\\app'})]}),
        });
        const messages = auditHosts(root).findings
            .filter((finding) => finding.level === 'error')
            .map((finding) => finding.message);
        expect(messages.some((message) => message.includes('必须使用'))).toBe(true);

        expect(() => upsertDeployment(root, {
            server: 'mbp', name: 'new', localPath: 'apps\\new', deployPath: '/srv/new',
        })).toThrow(/必须使用/);
    });

    it('deployPath 的 / 与 ..、localPath 的 ~ 与 .. 都是 error', () => {
        const root = projectWith({
            mbp: server({
                deployments: [
                    deployment('root', {deployPath: '/'}),
                    deployment('up', {deployPath: '/srv/../etc'}),
                    deployment('home', {localPath: '~/app'}),
                    deployment('out', {localPath: '../outside'}),
                ],
            }),
        });
        const errors = auditHosts(root).findings.filter((finding) => finding.level === 'error');
        expect(errors.map((finding) => finding.deployment).sort()).toEqual(['home', 'out', 'root', 'up']);
    });

    it('server 级 exclude 的通配符也会被 audit 抓到', () => {
        const root = projectWith({
            mbp: server({exclude: ['logs/*.log'], deployments: []}),
        });
        const messages = auditHosts(root).findings
            .filter((finding) => finding.level === 'error')
            .map((finding) => finding.message);
        expect(messages.some((message) => message.includes('server 级') && message.includes('不支持通配符'))).toBe(true);
    });

    it('JSON 坏掉时返回 error，而不是抛异常', () => {
        const root = mkdtempSync(join(workDir, 'broken-'));
        mkdirSync(join(root, '.opencode', 'remote-shell'), {recursive: true});
        writeFileSync(hostsConfigPath(root), '{not json', 'utf8');
        const report = auditHosts(root);
        expect(report.findings[0].level).toBe('error');
        expect(report.findings[0].message).toContain('不是合法 JSON');
    });
});

describe('upsertDeployment', () => {
    it('新增一条，保留同 server 的其它 deployment 与其它 server', () => {
        const root = projectWith({
            mbp: server({deployments: [deployment('old', {exclude: ['target']})]}),
            other: server({host: '10.0.0.2', deployments: []}),
        });

        const result = upsertDeployment(root, {
            server: 'mbp',
            name: 'new',
            localPath: 'apps/new',
            deployPath: '/srv/new',
            exclude: ['node_modules'],
        });

        expect(result.action).toBe('created');
        const hosts = JSON.parse(readFileSync(hostsConfigPath(root), 'utf8')).hosts;
        expect(hosts.mbp.deployments).toEqual([
            {name: 'old', localPath: 'apps/old', deployPath: '/srv/old', exclude: ['target']},
            {name: 'new', localPath: 'apps/new', deployPath: '/srv/new', exclude: ['node_modules']},
        ]);
        expect(hosts.other.deployments).toEqual([]);
        // server 的连接字段不能被动
        expect(hosts.mbp.password).toBe('p');
    });

    it('更新已有条目时保留没提到的字段（exclude）', () => {
        const root = projectWith({
            mbp: server({deployments: [deployment('app', {exclude: ['logs']})]}),
        });

        upsertDeployment(root, {
            server: 'mbp',
            name: 'app',
            localPath: 'build/app',
            deployPath: '/srv/app-v2',
        });

        const hosts = JSON.parse(readFileSync(hostsConfigPath(root), 'utf8')).hosts;
        expect(hosts.mbp.deployments).toEqual([
            {name: 'app', localPath: 'build/app', deployPath: '/srv/app-v2', exclude: ['logs']},
        ]);
    });

    it('拒绝绝对 localPath、相对 deployPath 与不存在的 server', () => {
        const root = projectWith({mbp: server({deployments: []})});

        expect(() => upsertDeployment(root, {
            server: 'mbp', name: 'a', localPath: '/abs/a', deployPath: '/srv/a',
        })).toThrow(/必须是相对项目根目录/);
        expect(() => upsertDeployment(root, {
            server: 'mbp', name: 'a', localPath: 'apps/a', deployPath: 'srv/a',
        })).toThrow(/必须是远端绝对路径/);
        expect(() => upsertDeployment(root, {
            server: 'nope', name: 'a', localPath: 'apps/a', deployPath: '/srv/a',
        })).toThrow(/没有 server "nope"/);
    });

    it('拒绝在另一台 server 上重名', () => {
        const root = projectWith({
            a: server({deployments: [deployment('app')]}),
            b: server({host: '10.0.0.2', deployments: []}),
        });
        expect(() => upsertDeployment(root, {
            server: 'b', name: 'app', localPath: 'apps/app', deployPath: '/srv/app',
        })).toThrow(/全局唯一/);
    });
});

describe('removeDeployment', () => {
    it('没有 --yes 时拒绝删除', () => {
        const root = projectWith({mbp: server({deployments: [deployment('app')]})});
        expect(() => removeDeployment(root, {name: 'app'})).toThrow(/--yes/);
        const hosts = JSON.parse(readFileSync(hostsConfigPath(root), 'utf8')).hosts;
        expect(hosts.mbp.deployments).toHaveLength(1);
    });

    it('带 --yes 只删这一条，其它原样保留', () => {
        const root = projectWith({
            mbp: server({deployments: [deployment('keep'), deployment('drop')]}),
        });

        const result = removeDeployment(root, {name: 'drop', yes: true});

        expect(result.removed).toBe('drop');
        const hosts = JSON.parse(readFileSync(hostsConfigPath(root), 'utf8')).hosts;
        expect(hosts.mbp.deployments).toEqual([
            {name: 'keep', localPath: 'apps/keep', deployPath: '/srv/keep'},
        ]);
    });

    it('多台 server 重名时要求指定 --server', () => {
        const root = projectWith({
            a: server({deployments: [deployment('app')]}),
            b: server({host: '10.0.0.2', deployments: [deployment('app')]}),
        });
        expect(() => removeDeployment(root, {name: 'app', yes: true})).toThrow(/--server/);
        expect(removeDeployment(root, {name: 'app', server: 'b', yes: true}).server).toBe('b');
    });
});
