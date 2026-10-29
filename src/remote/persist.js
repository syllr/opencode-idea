// `/persist-remote-config`：把 IDE 里配置的 server 与 deployment 写进项目配置。
//
// 位置固定为 `<项目>/.opencode/remote-shell/hosts.json` —— 和 `hosts.js` 读的是同一个文件，
// 所以写完立刻能被 remote_list_servers / remote_exec / remote_upload 看到（项目级优先于全局）。
//
// 合并规则：IDE 有的 server 整体覆盖，IDE 没有的原样保留。不留备份文件 —— 项目里的配置由 git 管。
// 凭据照写（用户自己决定这个文件要不要进 git，工具不替用户做这个判断）。

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
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
 * 一条 `RemoteServer` → hosts.json 里的条目。
 *
 * 只写这个文件认识（且确实有值）的字段：`authType` 决定 `password` / `privateKeyPath` 谁有意义，
 * 空值不写出来，免得读的时候被当成"显式设成空"。
 *
 * @param {import('./hosts.js').RemoteServer} server
 */
export function toHostEntry(server) {
    /** @type {Record<string, unknown>} */
    const entry = {
        // alias 默认和 server 名一致：调用时用哪个都行，想换名字直接改这个字段，
        // map 的 key 保持和 IDE 里一致（下次持久化也能正确覆盖）。
        alias: server.alias ?? server.name,
        host: server.host,
        port: server.port ?? 22,
        username: server.username,
        authType: server.authType,
        deployments: (server.deployments ?? []).map((deployment) => ({
            name: deployment.name,
            localPath: deployment.localPath,
            deployPath: deployment.deployPath,
        })),
    };
    if (server.password) entry.password = server.password;
    if (server.passphrase) entry.passphrase = server.passphrase;
    if (server.privateKeyPath) entry.privateKeyPath = server.privateKeyPath;
    return entry;
}

/**
 * 把 IDE 的服务器写进项目配置。
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
 *   deployments: number,
 * }}
 */
export function persistRemoteConfig({projectPath, servers}) {
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
        if (next[server.name]) updated += 1;
        else added += 1;
        next[server.name] = toHostEntry(server);
    }
    const ideNames = new Set(servers.map((server) => server.name));
    const kept = Object.keys(existing).filter((name) => !ideNames.has(name)).length;

    writeFileSync(file, `${JSON.stringify({hosts: next}, null, 2)}\n`, 'utf8');

    return {
        path: file,
        added,
        updated,
        kept,
        total: Object.keys(next).length,
        deployments: servers.reduce((sum, server) => sum + (server.deployments?.length ?? 0), 0),
    };
}
