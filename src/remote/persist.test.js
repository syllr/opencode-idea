// `/persist-remote-config` 的纯函数测试：新建、覆盖、保留、备份。

import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterAll, describe, expect, it} from 'vitest';

import {persistRemoteConfig, remoteConfigPath, toHostEntry} from './persist.js';

const workDir = mkdtempSync(join(tmpdir(), 'persist-'));
afterAll(() => rmSync(workDir, {recursive: true, force: true}));

const project = () => mkdtempSync(join(workDir, 'project-'));

const server = (name, overrides = {}) => ({
    name,
    host: '10.0.0.1',
    port: 22,
    username: 'u',
    authType: 'PASSWORD',
    password: 'p',
    deployments: [{name: 'app', localPath: '/local/app', deployPath: '/srv/app'}],
    source: 'ide',
    ...overrides,
});

describe('toHostEntry', () => {
    it('写凭据、mapping，不写空字段', () => {
        expect(toHostEntry(server('a'))).toEqual({
            alias: 'a',
            host: '10.0.0.1',
            port: 22,
            username: 'u',
            authType: 'PASSWORD',
            password: 'p',
            deployments: [{name: 'app', localPath: '/local/app', deployPath: '/srv/app'}],
        });
        expect(toHostEntry(server('b', {password: undefined, privateKeyPath: '/k', authType: 'KEY_PAIR'})))
            .not.toHaveProperty('password');
    });
});

describe('persistRemoteConfig', () => {
    it('项目里没有文件时新建，并写入凭据与 mapping', () => {
        const projectPath = project();
        const result = persistRemoteConfig({projectPath, servers: [server('a')]});

        expect(result.added).toBe(1);
        expect(result.updated).toBe(0);
        expect(result.kept).toBe(0);
        expect(result.deployments).toBe(1);

        const json = JSON.parse(readFileSync(remoteConfigPath(projectPath), 'utf8'));
        expect(json.hosts.a.alias).toBe('a');
        expect(json.hosts.a.password).toBe('p');
        expect(json.hosts.a.deployments).toEqual([
            {name: 'app', localPath: '/local/app', deployPath: '/srv/app'},
        ]);
    });

    it('同名覆盖、项目独有保留', () => {
        const projectPath = project();
        const file = remoteConfigPath(projectPath);
        mkdirSync(join(projectPath, '.opencode', 'remote-shell'), {recursive: true});
        writeFileSync(file, JSON.stringify({
            hosts: {
                a: {host: 'old-host', username: 'old-user'},
                manual: {host: 'manual-host', username: 'u'},
            },
        }));

        const result = persistRemoteConfig({projectPath, servers: [server('a', {host: 'new-host'})]});

        expect(result.added).toBe(0);
        expect(result.updated).toBe(1);
        expect(result.kept).toBe(1);
        expect(result.total).toBe(2);

        const json = JSON.parse(readFileSync(file, 'utf8'));
        expect(json.hosts.a.host).toBe('new-host');
        expect(json.hosts.a.alias).toBe('a');
        expect(json.hosts.a.password).toBe('p');
        // IDE 里没有的那条原样保留
        expect(json.hosts.manual.host).toBe('manual-host');
    });

    it('旧文件坏掉时仍能写入一份合法的配置', () => {
        const projectPath = project();
        const file = remoteConfigPath(projectPath);
        mkdirSync(join(projectPath, '.opencode', 'remote-shell'), {recursive: true});
        writeFileSync(file, '{not json');

        const result = persistRemoteConfig({projectPath, servers: [server('a')]});

        expect(result.added).toBe(1);
        expect(existsSync(`${file}.bak`)).toBe(false);
        expect(JSON.parse(readFileSync(file, 'utf8')).hosts.a.host).toBe('10.0.0.1');
    });
});
