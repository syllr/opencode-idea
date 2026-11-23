// `/remote-config-sync`：把 IDE 的 SSH 配置与项目 `hosts.json` 做双向对齐。
//
// 方向：
//
//   server     IDE → hosts.json   连接信息与凭据写回；alias / deployments / exclude 等字段不动
//   deployment hosts.json → IDE   由 plugin.js 调 IDE 的 `sync_deployments`（这个文件只产出清单）
//
// 为什么 server 只写连接字段：hosts.json 里的 deployment / exclude 是用户维护的，
// IDE 不提供这些信息，整条覆盖会把它们冲掉。

import {copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';

import {assertDeploymentLocalPath} from './hosts.js';
import {join} from 'node:path';

/** hosts.json 本身不合法：调用方应停止自动写回，等用户修文件。 */
export class HostsConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = 'HostsConfigError';
    }
}

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
    if (!entry.alias) entry.alias = server.alias ?? server.name;

    // IDE 是连接信息的源：有值就每次覆盖。但只有**认证方式真的变了**才清掉另一套
    // 互斥凭据；同一种方式下 IDE 没返回某个字段（例如没有 passphrase）时保留原值。
    const previousAuthType = typeof entry.authType === 'string' ? entry.authType : undefined;
    const authType = server.authType
        ?? (server.password ? 'PASSWORD' : server.privateKeyPath ? 'KEY_PAIR' : 'OPEN_SSH');
    entry.authType = authType;
    if (previousAuthType !== undefined && previousAuthType !== authType) {
        delete entry.password;
        delete entry.passphrase;
        delete entry.privateKeyPath;
    }
    if (authType === 'PASSWORD') {
        if (server.password) entry.password = server.password;
        delete entry.privateKeyPath;
    } else if (authType === 'KEY_PAIR') {
        if (server.privateKeyPath) entry.privateKeyPath = server.privateKeyPath;
        if (server.passphrase) entry.passphrase = server.passphrase;
        delete entry.password;
    } else {
        // OPEN_SSH：凭据在 ~/.ssh/config 与 agent 里，配置里不该留密码 / 私钥。
        delete entry.password;
        delete entry.passphrase;
        delete entry.privateKeyPath;
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
 *   changed: boolean,
 *   invalid: Array<{ server: string, deployment: string, localPath: string, message: string }>,
 *   syncTargets: Array<{ server: string, deployments: Array<{ name: string, localPath: string, deployPath: string, exclude: string[] }> }>,
 * }}
 */
export function syncRemoteConfig({projectPath, servers}) {
    const dir = remoteConfigDir(projectPath);
    const file = remoteConfigPath(projectPath);

    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    /** @type {Record<string, unknown>} */
    let document = {hosts: {}};
    if (text.trim() !== '') {
        const backup = () => {
            const target = `${file}.bad`;
            copyFileSync(file, target);
            return target;
        };
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (error) {
            const target = backup();
            throw new HostsConfigError(
                `${file} 不是合法 JSON（已备份到 ${target}，未覆盖）：` +
                (error instanceof Error ? error.message : String(error)),
            );
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            const target = backup();
            throw new HostsConfigError(`${file} 顶层必须是对象（已备份到 ${target}，未覆盖）。`);
        }
        if (!parsed.hosts || typeof parsed.hosts !== 'object' || Array.isArray(parsed.hosts)) {
            const target = backup();
            throw new HostsConfigError(`${file} 缺少 hosts 对象（已备份到 ${target}，未覆盖）。`);
        }
        document = parsed;
    }

    /** @type {Record<string, unknown>} */
    const existing = /** @type {Record<string, unknown>} */ (document.hosts ?? {});
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

    const nextDocument = {...document, hosts: next};
    const serialized = `${JSON.stringify(nextDocument, null, 2)}\n`;
    // 内容没变就不落盘：写回会刷新 mtime，进而让指纹对账自己再次触发。
    const changed = text !== serialized && !(text === '' && Object.keys(next).length === 0);
    if (changed) {
        mkdirSync(dir, {recursive: true});
        writeJsonAtomic(file, nextDocument);
    }

    const syncTargets = [];
    const invalid = [];
    let deploymentCount = 0;
    for (const [serverName, raw] of Object.entries(next)) {
        const entry = /** @type {Record<string, unknown>} */ (raw ?? {});
        const deployments = Array.isArray(entry.deployments) ? entry.deployments : [];
        const serverExclude = Array.isArray(entry.exclude)
            ? entry.exclude.filter((item) => typeof item === 'string')
            : [];
        if (deployments.length === 0) continue;
        /** @type {Array<{ name: string, localPath: string, deployPath: string, exclude: string[] }>} */
        const valid = [];
        for (const deployment of deployments) {
            if (!deployment || typeof deployment !== 'object') continue;
            const record = /** @type {Record<string, unknown>} */ (deployment);
            const name = typeof record.name === 'string' ? record.name.trim() : '';
            const localPath = typeof record.localPath === 'string' ? record.localPath.trim() : '';
            const deployPath = typeof record.deployPath === 'string' ? record.deployPath.trim() : '';
            if (!name || !localPath || !deployPath) continue;
            const exclude = Array.isArray(record.exclude)
                ? record.exclude.filter((item) => typeof item === 'string')
                : [];
            // IDE 的 Deployment 面板只认 deployment 级 excludes；server 级是在这里
            // 合并进去的，否则 remote_upload 排除了、IDE Deploy 却没排除。
            const mergedExclude = [...new Set([...serverExclude, ...exclude])];
            const parsed = {name, localPath, deployPath, exclude: mergedExclude};
            // 项目级 hosts.json 跟着仓库走：只允许相对路径，否则换台电脑就传错目录。
            // 一条写错不能拖垮整份配置：记进 invalid 交给调用方点名，其它条目照常推。
            try {
                assertDeploymentLocalPath('project', parsed);
            } catch (error) {
                invalid.push({
                    server: serverName,
                    deployment: name,
                    localPath,
                    message: error instanceof Error ? error.message : String(error),
                });
                continue;
            }
            valid.push(parsed);
        }
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
        changed,
        invalid,
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
