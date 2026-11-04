// `/remote-config-sync` 的纯函数测试：只更新连接字段、保留 deployment / exclude 等已有字段。

import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterAll, describe, expect, it} from 'vitest';

import {remoteConfigPath, syncRemoteConfig, toHostEntry} from './persist.js';

const workDir = mkdtempSync(join(tmpdir(), 'sync-config-'));
afterAll(() => rmSync(workDir, {recursive: true, force: true}));

const project = () => mkdtempSync(join(workDir, 'project-'));

const server = (name, overrides = {}) => ({
    name,
    host: '10.0.0.1',
    port: 22,
    username: 'u',
    authType: 'PASSWORD',
    password: 'p',
    deployments: [],
    source: 'ide',
    ...overrides,
});

describe('toHostEntry', () => {
    it('只写连接字段，保留已有的 deployment / exclude 等字段', () => {
        const previous = {
            alias: '自定义名',
            deployments: [{name: 'app', localPath: 'references/app', deployPath: '/srv/app', exclude: ['target']}],
            customField: {keep: true},
        };
        const entry = toHostEntry(server('a'), previous);

        expect(entry.alias).toBe('自定义名');
        expect(entry.host).toBe('10.0.0.1');
        expect(entry.password).toBe('p');
        expect(entry.deployments).toEqual(previous.deployments);
        expect(entry.customField).toEqual(previous.customField);
    });

    it('换认证方式时清掉上一种方式的凭据字段', () => {
        const previous = {password: 'old'};
        const entry = toHostEntry(
            server('b', {authType: 'KEY_PAIR', password: undefined, privateKeyPath: '/k'}),
            previous,
        );

        expect(entry).not.toHaveProperty('password');
        expect(entry.privateKeyPath).toBe('/k');
    });
});

describe('syncRemoteConfig', () => {
    it('项目里没有文件时新建，只写连接信息', () => {
        const projectPath = project();
        const result = syncRemoteConfig({projectPath, servers: [server('a')]});

        expect(result.added).toBe(1);
        expect(result.updated).toBe(0);
        expect(result.kept).toBe(0);
        expect(result.deploymentCount).toBe(0);

        const json = JSON.parse(readFileSync(remoteConfigPath(projectPath), 'utf8'));
        expect(json.hosts.a.alias).toBe('a');
        expect(json.hosts.a.password).toBe('p');
        // deployment 由用户维护，IDE 不提供，这里不能凭空造一条。
        expect(json.hosts.a.deployments).toBeUndefined();
    });

    it('同名覆盖连接字段、项目独有的 server 与 deployment 原样保留', () => {
        const projectPath = project();
        const file = remoteConfigPath(projectPath);
        mkdirSync(join(projectPath, '.opencode', 'remote-shell'), {recursive: true});
        writeFileSync(file, JSON.stringify({
            hosts: {
                a: {
                    host: 'old-host',
                    username: 'old-user',
                    deployments: [{name: 'app', localPath: 'references/app', deployPath: '/r'}],
                },
                manual: {host: 'manual-host', username: 'u'},
            },
        }));

        const result = syncRemoteConfig({projectPath, servers: [server('a', {host: 'new-host'})]});

        expect(result.added).toBe(0);
        expect(result.updated).toBe(1);
        expect(result.kept).toBe(1);
        expect(result.total).toBe(2);
        expect(result.deploymentCount).toBe(1);
        expect(result.syncTargets).toEqual([
            {
                server: 'a',
                deployments: [{name: 'app', localPath: 'references/app', deployPath: '/r', exclude: []}],
            },
        ]);

        const json = JSON.parse(readFileSync(file, 'utf8'));
        expect(json.hosts.a.host).toBe('new-host');
        expect(json.hosts.a.password).toBe('p');
        expect(json.hosts.a.deployments).toEqual([{name: 'app', localPath: 'references/app', deployPath: '/r'}]);
        expect(json.hosts.manual.host).toBe('manual-host');
    });

    it('旧文件坏掉时仍能写入一份合法的配置', () => {
        const projectPath = project();
        const file = remoteConfigPath(projectPath);
        mkdirSync(join(projectPath, '.opencode', 'remote-shell'), {recursive: true});
        writeFileSync(file, '{not json');

        const result = syncRemoteConfig({projectPath, servers: [server('a')]});

        expect(result.added).toBe(1);
        expect(existsSync(`${file}.bak`)).toBe(false);
        expect(JSON.parse(readFileSync(file, 'utf8')).hosts.a.host).toBe('10.0.0.1');
    });
});
