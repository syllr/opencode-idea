// `/remote-config-sync`：把 IDE 的 SSH 配置与项目 `hosts.json` 做双向对齐。
//
// 方向：
//
//   server     IDE → hosts.json   连接信息与凭据写回；alias / deployments / exclude 等字段不动
//   deployment hosts.json → IDE   由 plugin.js 调 IDE 的 `sync_deployments`（这个文件只产出清单）
//
// 为什么 server 只写连接字段：hosts.json 里的 deployment / exclude 是用户维护的，
// IDE 不提供这些信息，整条覆盖会把它们冲掉。

import {existsSync, mkdirSync, readFileSync, writeFileSync, renameSync} from 'node:fs';

import {assertDeploymentLocalPath} from './hosts.js';
import {join} from 'node:path';

/** 项目级配置目录。 */
export function remoteConfigDir(projectPath) {
    return join(projectPath, '.opencode', 'remote-shell');
}

/** 项目级配置文件。 */
export function remoteConfigPath(projectPath) {
    return join(remoteConfigDir(projectPath), 'hosts.json');
}

/**
 * 一条 `RemoteServer` + 已有的 hosts.json 条目 → 新条目。
 *
 * 只覆盖连接字段；`alias` 只在没有时补，deployments / exclude 等字段原样保留。
 *
 * @param {import('./hosts.js').RemoteServer} server
 * @param {Record<string, unknown>} [previous]
 */
export function toHostEntry(server, previous = {}) {
    /** @type {Record<string, unknown>} */
    const entry = {...previous};

    if (server.host) entry.host = server.host;
    entry.port = server.port ?? (typeof entry.port === 'number' ? entry.port : 22);
    if (server.username) entry.username = server.username;
    if (server.authType) entry.authType = server.authType;
    if (!entry.alias) entry.alias = server.alias ?? server.name;

    // 认证方式决定哪几个凭据字段有意义：旧字段必须清掉，否则 KEY_PAIR 会带着一个
    // 不该用的 password 去连接。
    delete entry.password;
    delete entry.passphrase;
    delete entry.privateKeyPath;
    if (server.authType === 'PASSWORD' && server.password) entry.password = server.password;
    if (server.authType === 'KEY_PAIR') {
        if (server.privateKeyPath) entry.privateKeyPath = server.privateKeyPath;
        if (server.passphrase) entry.passphrase = server.passphrase;
    }
    return entry;
}

/**
 * 把 IDE 的服务器写进项目配置，并产出需要推到 IDE 的 deployment 清单。
 *
 * @param {{
 *   projectPath: string,
 *   servers: ReadonlyArray<import('./hosts.js').RemoteServer>,
 * }} options
 * @returns {{
 *   path: string,
 *   added: number,
 *   updated: number,
 *   kept: number,
 *   total: number,
 *   deploymentCount: number,
 *   syncTargets: Array<{ server: string, deployments: Array<{ name: string, localPath: string, deployPath: string, exclude: string[] }> }>,
 * }}
 */
export function syncRemoteConfig({projectPath, servers}) {
    const dir = remoteConfigDir(projectPath);
    const file = remoteConfigPath(projectPath);
    mkdirSync(dir, {recursive: true});

    /** @type {Record<string, unknown>} */
    let existing = {};
    if (existsSync(file)) {
        try {
            const parsed = JSON.parse(readFileSync(file, 'utf8'));
            existing = parsed?.hosts && typeof parsed.hosts === 'object' ? parsed.hosts : {};
        } catch {
            // 文件坏了也要能覆盖：当成空的，重新写一份合法的。
            existing = {};
        }
    }

    const next = {...existing};
    let added = 0;
    let updated = 0;
    for (const server of servers) {
        const previous = /** @type {Record<string, unknown>} */ (next[server.name] ?? {});
        if (next[server.name]) updated += 1;
        else added += 1;
        next[server.name] = toHostEntry(server, previous);
    }
    const ideNames = new Set(servers.map((server) => server.name));
    const kept = Object.keys(existing).filter((name) => !ideNames.has(name)).length;

    writeFileSync(file, `${JSON.stringify({hosts: next}, null, 2)}\n`, 'utf8');

    const syncTargets = [];
    let deploymentCount = 0;
    for (const [serverName, raw] of Object.entries(next)) {
        const entry = /** @type {Record<string, unknown>} */ (raw ?? {});
        const deployments = Array.isArray(entry.deployments) ? entry.deployments : [];
        if (deployments.length === 0) continue;
        const valid = deployments.flatMap((deployment) => {
            if (!deployment || typeof deployment !== 'object') return [];
            const record = /** @type {Record<string, unknown>} */ (deployment);
            const name = typeof record.name === 'string' ? record.name : '';
            const localPath = typeof record.localPath === 'string' ? record.localPath : '';
            const deployPath = typeof record.deployPath === 'string' ? record.deployPath : '';
            if (!name || !localPath || !deployPath) return [];
            const exclude = Array.isArray(record.exclude)
                ? record.exclude.filter((item) => typeof item === 'string')
                : [];
            const parsed = {name, localPath, deployPath, exclude};
            // 项目级 hosts.json 跟着仓库走：只允许相对路径，否则换台电脑就传错目录。
            assertDeploymentLocalPath('project', parsed);
            return [parsed];
        });
        if (valid.length === 0) continue;
        deploymentCount += valid.length;
        syncTargets.push({server: serverName, deployments: valid});
    }

    return {
        path: file,
        added,
        updated,
        kept,
        total: Object.keys(next).length,
        deploymentCount,
        syncTargets,
    };
}

/**
 * 原子写：临时文件 + rename。给进程状态这类高频写入用，避免读到写了一半的文件。
 *
 * @param {string} file
 * @param {unknown} value
 */
export function writeJsonAtomic(file, value) {
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(temporary, file);
}
