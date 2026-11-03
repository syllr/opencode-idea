// 远程服务器的三级来源：IDE → 项目 `.opencode/remote-shell/hosts.json` → 全局 `~/.config/remote-shell/hosts.json`。
//
// 合并规则（同名以高优先级为准）：
//
//   global（最低） → project → IDE（最高）
//
// IDE 层只提供 SSH 配置与凭据；deployment / exclude 全部由 hosts.json 维护。
//
// 这个文件只做**纯数据**的事：读文件、校验形状、合并。调 IDE 取凭据在 `plugin.js`
// 里（那里才拿得到端口和项目路径），SSH 连接在 `ssh.js` 里。

import {existsSync, readFileSync} from 'node:fs';
import {isAbsolute, resolve} from 'node:path';
import {homedir} from 'node:os';
import {join} from 'node:path';

/** 全局配置。保留 remote-shell 的旧路径，用户的 hosts.json 不用搬。 */
export const GLOBAL_HOSTS_PATH = join(homedir(), '.config', 'remote-shell', 'hosts.json');

/** 项目级配置：与全局同名同格式，跟着仓库走。 */
export function projectHostsPath(projectPath) {
    return join(projectPath, '.opencode', 'remote-shell', 'hosts.json');
}

/**
 * @typedef {{
 *   name: string,
 *   alias?: string,
 *   host?: string,
 *   port?: number,
 *   username?: string,
 *   authType?: string,
 *   password?: string,
 *   passphrase?: string,
 *   privateKeyPath?: string,
 *   dockerCommand?: string,
 *   exclude?: string[],
 *   deployments: Array<{ name: string, localPath: string, deployPath: string, exclude?: string[] }>,
 *   source: 'ide' | 'project' | 'global',
 * }} RemoteServer
 */

/**
 * 读一个 hosts.json，返回服务器列表；文件不存在 / 内容坏 / 字段不全时返回空数组。
 *
 * `source` 由调用方给：同一个文件在"项目级"和"全局"两个位置读时，条目要能区分。
 *
 * @param {string} path
 * @param {'ide' | 'project' | 'global'} source
 * @returns {RemoteServer[]}
 */
export function readHostsFile(path, source) {
    if (!existsSync(path)) return [];
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        // 配置坏了不该让整个 remote_exec 不可用；跳过这一层，其它层照常合并。
        return [];
    }
    const hosts = parsed?.hosts;
    if (!hosts || typeof hosts !== 'object') return [];

    const servers = [];
    for (const [name, entry] of Object.entries(hosts)) {
        const server = toServer(name, entry, source);
        if (server) servers.push(server);
    }
    return servers;
}

/**
 * 一条 hosts.json 条目 → RemoteServer；缺 host 或 username 的直接丢掉。
 *
 * @param {string} name
 * @param {unknown} entry
 * @param {'ide' | 'project' | 'global'} source
 * @returns {RemoteServer | undefined}
 */
function toServer(name, entry, source) {
    if (!entry || typeof entry !== 'object') return undefined;
    const record = /** @type {Record<string, unknown>} */ (entry);
    const host = typeof record.host === 'string' ? record.host.trim() : '';
    const username = typeof record.username === 'string' ? record.username.trim() : '';
    const deployments = parseDeployments(record.deployments);
    // 允许"只补 mapping"的条目：没有 host、但带了 deployments 时也算一条补丁，合并时由
    // 低优先级层补上连接信息。没有 host 又没有 mapping 的条目没有任何用途，直接丢掉。
    if (!host && deployments.length === 0) return undefined;

    /** @type {RemoteServer} */
    const server = {name, source, deployments};
    const alias = stringOrUndefined(record.alias);
    if (alias && alias !== name) server.alias = alias;
    if (host) server.host = host;
    if (username) server.username = username;
    if (typeof record.port === 'number' && Number.isFinite(record.port) && record.port > 0) {
        server.port = record.port;
    }
    const authType = stringOrUndefined(record.authType);
    if (authType) server.authType = authType;
    const password = stringOrUndefined(record.password);
    if (password) server.password = password;
    const passphrase = stringOrUndefined(record.passphrase);
    if (passphrase) server.passphrase = passphrase;
    const privateKeyPath = stringOrUndefined(record.privateKeyPath);
    if (privateKeyPath) server.privateKeyPath = privateKeyPath;
    const dockerCommand = stringOrUndefined(record.dockerCommand);
    if (dockerCommand) server.dockerCommand = dockerCommand;
    const exclude = parseExclude(record.exclude);
    if (exclude.length > 0) server.exclude = exclude;
    return server;
}

/** @param {unknown} value */
function stringOrUndefined(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * 解析排除项。只接受**路径前缀**与**精确文件**，不认通配符。
 *
 * 校验放在使用前（`assertExcludePatterns`），这里保留原样 —— 读文件时不该因为一条
 * 写错的配置就让整个服务器消失，用户要能看到自己的配置并在报错里被点名。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parseExclude(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((entry) => typeof entry === 'string')
        .map((entry) => entry.trim().replace(/^\.\//, '').replace(/\/+$/, ''))
        .filter((entry) => entry !== '');
}

/**
 * 排除项里出现 `*` / `?` 时抛出可读错误。
 *
 * @param {ReadonlyArray<string>} patterns
 * @returns {void}
 */
export function assertExcludePatterns(patterns) {
    for (const pattern of patterns) {
        if (/[*?]/.test(pattern)) {
            throw new Error(
                `exclude 不支持通配符："${pattern}"。写具体路径，例如 "logs/app.log" 或整个目录 "logs"。`,
            );
        }
    }
}

/**
 * 判断一个相对路径是否被排除。
 *
 * 规则：命中 `p === pattern` 或 `p` 以 `pattern + "/"` 开头。
 *
 * @param {string} relative 相对 mapping 根的路径，使用 `/`
 * @param {ReadonlyArray<string>} patterns
 */
export function isExcluded(relative, patterns) {
    if (patterns.length === 0) return false;
    const path = relative.replace(/^\.\//, '').replace(/\/+$/, '');
    return patterns.some((pattern) => path === pattern || path.startsWith(`${pattern}/`));
}

/**
 * 解析一个 server 上的路径映射。缺 name / localPath / deployPath 的条目直接丢掉 ——
 * 少了任何一头都传不了。
 *
 * @param {unknown} raw
 * @returns {Array<{ name: string, localPath: string, deployPath: string, exclude: string[] }>}
 */
function parseDeployments(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return [];
        const record = /** @type {Record<string, unknown>} */ (entry);
        const name = typeof record.name === 'string' ? record.name : '';
        const localPath = typeof record.localPath === 'string' ? record.localPath : '';
        const deployPath = typeof record.deployPath === 'string' ? record.deployPath : '';
        if (!name || !localPath || !deployPath) return [];
        return [{name, localPath, deployPath, exclude: parseExclude(record.exclude)}];
    });
}

/**
 * `localPath` 的来源约束：
 *
 * - 项目级 hosts.json（跟着仓库走）→ 只能是相对路径，换台电脑也能用
 * - 全局 hosts.json（跨项目共用）→ 只能是绝对路径，否则不知道相对谁
 *
 * @param {'ide' | 'project' | 'global'} source
 * @param {{ name: string, localPath: string }} deployment
 */
export function assertDeploymentLocalPath(source, deployment) {
    const {name, localPath} = deployment;
    if (source === 'project' && isAbsolute(localPath)) {
        throw new Error(
            `deployment "${name}" 的 localPath 必须是相对项目根目录的路径，不能是绝对路径：${localPath}`,
        );
    }
    if (source === 'global' && !isAbsolute(localPath)) {
        throw new Error(
            `全局配置里 deployment "${name}" 的 localPath 必须是绝对路径：${localPath}`,
        );
    }
}

/**
 * 项目级相对路径 → 绝对路径；全局/已绝对的原样返回。
 *
 * @param {string} projectPath
 * @param {string} localPath
 */
export function resolveLocalPath(projectPath, localPath) {
    return isAbsolute(localPath) ? localPath : resolve(projectPath, localPath);
}

/**
 * 把合并后的 server 列表摊平成 deployment 表（按 name 全局唯一）。
 *
 * `server` 挂在每条 mapping 上：上传 / 下载既要知道两端目录，也要知道连哪台机器。
 * `exclude` 已经合并了 server 级与 deployment 级（并集、去重）。
 *
 * @param {ReadonlyArray<RemoteServer>} servers
 * @returns {Array<{ name: string, localPath: string, deployPath: string, exclude: string[], server: RemoteServer }>}
 */
export function collectDeployments(servers) {
    const byName = new Map();
    for (const server of servers) {
        for (const deployment of server.deployments ?? []) {
            byName.set(deployment.name, {
                ...deployment,
                exclude: [...new Set([...(server.exclude ?? []), ...(deployment.exclude ?? [])])],
                server,
            });
        }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 按 name 合并多层服务器。**后传的层覆盖先传的层**。
 *
 * 调用方按 `[global, project, ide]` 的顺序传，就是"全局 < 项目 < IDE"。
 *
 * @param {ReadonlyArray<ReadonlyArray<RemoteServer>>} layers
 * @returns {RemoteServer[]}
 */
export function mergeServers(layers) {
    const byName = new Map();
    for (const layer of layers) {
        for (const server of layer) {
            const existing = byName.get(server.name);
            byName.set(server.name, existing ? mergeServer(existing, server) : server);
        }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 两层的同一条 server 合并：高优先级的字段覆盖，没提供的保留。
 *
 * **不是整条替换**，理由是常见的配置方式：项目级只想补一条 deployment，不该被迫把
 * 密码再抄一遍；反过来 IDE 里改了 host 也不该把项目级补的 mapping 冲掉。
 *
 * 凭据字段例外：只要高优先级层给了 `authType`，就以它的凭据为准（KEY_PAIR 必须能清掉
 * 低优先级层的 password，否则会带着一个不该用的密码去连接）。
 *
 * @param {RemoteServer} base 低优先级
 * @param {RemoteServer} override 高优先级
 * @returns {RemoteServer}
 */
function mergeServer(base, override) {
    /** @type {RemoteServer} */
    const merged = {...base};
    for (const [key, value] of Object.entries(override)) {
        if (value === undefined) continue;
        if (key === 'deployments' || key === 'authType') continue;
        // @ts-expect-error 键来自同一个结构
        merged[key] = value;
    }

    if (override.authType) {
        merged.authType = override.authType;
        merged.password = override.password;
        merged.passphrase = override.passphrase;
        merged.privateKeyPath = override.privateKeyPath;
    }

    merged.deployments = mergeDeployments(base.deployments ?? [], override.deployments ?? []);
    return merged;
}

/**
 * deployment 按 name 合并；高优先级层没配任何 mapping 时保留低优先级的。
 *
 * 字段级合并：高优先级层没给 `exclude` 时保留低优先级层的，避免 IDE 层（不提供 exclude）
 * 把项目级手写的排除项冲掉。
 *
 * @param {Array<{ name: string, localPath: string, deployPath: string, exclude?: string[] }>} base
 * @param {Array<{ name: string, localPath: string, deployPath: string, exclude?: string[] }>} override
 */
function mergeDeployments(base, override) {
    if (override.length === 0) return base;
    const byName = new Map(base.map((deployment) => [deployment.name, deployment]));
    for (const deployment of override) {
        const existing = byName.get(deployment.name);
        byName.set(deployment.name, existing
            ? {
                ...existing,
                ...deployment,
                exclude: deployment.exclude ?? existing.exclude,
            }
            : deployment);
    }
    return [...byName.values()];
}

/**
 * 精确按名字找。**不做模糊匹配**：猜错了比列出来更糟，让模型看着全量列表自己选。
 *
 * @param {ReadonlyArray<RemoteServer>} servers
 * @param {string} name
 */
export function findServer(servers, name) {
    return servers.find((server) => server.name === name)
        ?? servers.find((server) => server.alias === name);
}

/**
 * 找不到 deployment 时给模型的文本：列出全部候选（名字 / 两端目录 / 所属服务器）。
 *
 * @param {ReturnType<typeof collectDeployments>} deployments
 * @param {string} wanted
 */
export function deploymentNotFoundText(deployments, wanted) {
    if (deployments.length === 0) {
        return `没有名为 "${wanted}" 的 deployment，当前也没有任何路径映射。` +
            `在 hosts.json 的 host 条目下加 deployments。`;
    }
    const lines = deployments.map((deployment) =>
        `- ${deployment.name}  ${deployment.localPath} ↔ ${deployment.server.name}:${deployment.deployPath}`);
    return [
        `没有名为 "${wanted}" 的 deployment。当前全部可用：`,
        '',
        ...lines,
        '',
        '如果指的是其中一条，用它的名字重新调用。',
    ].join('\n');
}

/**
 * 找不到服务器时给模型的文本：列出全部候选（名字 / 地址 / 用户 / 来源），绝不带凭据。
 *
 * @param {ReadonlyArray<RemoteServer>} servers
 * @param {string} wanted
 */
export function serverNotFoundText(servers, wanted) {
    const lines = servers.map((server) => {
        const source = server.source === 'ide' ? 'IDE' : server.source === 'project' ? '项目' : '全局';
        const label = server.alias ? `${server.name} (${server.alias})` : server.name;
        return `- ${label}  ${server.host}:${server.port}  ${server.username}  [${source}]`;
    });
    return [
        `没有名为 "${wanted}" 的服务器。当前全部可用（IDE → 项目 → 全局，同名以高优先级为准）：`,
        '',
        ...lines,
        '',
        '如果指的是其中某一台，用它的名字重新调用。',
    ].join('\n');
}
