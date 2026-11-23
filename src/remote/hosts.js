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
 *   deployments: Array<{
 *     name: string,
 *     localPath: string,
 *     deployPath: string,
 *     exclude?: string[],
 *     // deployment **自己**来自哪一层。合并后的 server.source 可能是更高优先级层的
 *     // （例如项目级 deployment 挂到 IDE 的同名机器上），校验必须按这个字段，不能按 server。
 *     source?: 'ide' | 'project' | 'global',
 *   }>,
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
    return readHostsFileReport(path, source).servers;
}

/**
 * 读 hosts.json 并保留解析错误，供 `remote_list_servers` 显式告警。
 *
 * @param {string} path
 * @param {'ide' | 'project' | 'global'} source
 * @returns {{ servers: RemoteServer[], error?: string }}
 */
export function readHostsFileReport(path, source) {
    if (!existsSync(path)) return {servers: []};
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
        return {
            servers: [],
            error: `${path} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
        };
    }
    const hosts = parsed?.hosts;
    if (!hosts || typeof hosts !== 'object' || Array.isArray(hosts)) {
        return {servers: [], error: `${path} 缺少 hosts 对象。`};
    }

    const servers = [];
    for (const [name, entry] of Object.entries(hosts)) {
        const server = toServer(name, entry, source);
        if (server) servers.push(server);
    }
    return {servers};
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
    const deployments = parseDeployments(record.deployments, source);
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
    const password = stringOrUndefined(record.password);
    if (password) server.password = password;
    const passphrase = stringOrUndefined(record.passphrase);
    if (passphrase) server.passphrase = passphrase;
    const privateKeyPath = stringOrUndefined(record.privateKeyPath);
    if (privateKeyPath) server.privateKeyPath = privateKeyPath;
    // `authType` 可以不写：有密码就是 PASSWORD，有私钥就是 KEY_PAIR。两者都没有时
    // 不推断成 OPEN_SSH —— 那可能是“凭据缺失”，直接报错比悄悄尝试 agent 更清楚；
    // 用 ssh-agent 的机器请显式写 `"authType": "OPEN_SSH"`。只补 mapping 的条目
    // （没有 host）不推断，否则它会把低优先级层的凭据当成“切换认证方式”清掉。
    const explicitAuthType = stringOrUndefined(record.authType);
    const authType = explicitAuthType
        ?? (host
            ? password
                ? 'PASSWORD'
                : privateKeyPath
                    ? 'KEY_PAIR'
                    : undefined
            : undefined);
    if (authType) server.authType = authType;
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
 * 每条 mapping 记下**自己这一层**的来源：合并后 `server.source` 会变成最高优先级层，
 * 但 `localPath` 的校验口径应该跟着 mapping 走（项目级写绝对路径不会因为 IDE 也有
 * 同名机器就变成合法）。
 *
 * @param {unknown} raw
 * @param {'ide' | 'project' | 'global'} source
 * @returns {Array<{ name: string, localPath: string, deployPath: string, exclude?: string[], source: 'ide' | 'project' | 'global' }>}
 */
function parseDeployments(raw, source) {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return [];
        const record = /** @type {Record<string, unknown>} */ (entry);
        const name = typeof record.name === 'string' ? record.name.trim() : '';
        const localPath = typeof record.localPath === 'string' ? record.localPath.trim() : '';
        const deployPath = typeof record.deployPath === 'string' ? record.deployPath.trim() : '';
        if (!name || !localPath || !deployPath) return [];
        /** @type {{ name: string, localPath: string, deployPath: string, exclude?: string[], source: 'ide' | 'project' | 'global' }} */
        const deployment = {name, localPath, deployPath, source};
        // 不写 exclude 与写 `[]` 是两种语义：前者在合并时保留低优先级层的排除项，
        // 后者明确表示“清空”。所以这里只在原字段存在时才带上它。
        if (record.exclude !== undefined) deployment.exclude = parseExclude(record.exclude);
        return [deployment];
    });
}

/**
 * deployment 的校验口径：以它**自己来自哪一层**为准，而不是合并后 server 的来源。
 *
 * 项目级 hosts.json 的 deployment 合并到 IDE 的同名机器后，`server.source` 变成 `ide`；
 * 若按它校验，项目级写的绝对路径就被绕过了 —— 同一份配置会得出两种结论。
 * 早期 / 手工构造的 deployment 没有 `source`，退回 server 的来源。
 *
 * @param {{ source: 'ide' | 'project' | 'global' }} server
 * @param {{ source?: 'ide' | 'project' | 'global' }} deployment
 * @returns {'ide' | 'project' | 'global'}
 */
export function deploymentSource(server, deployment) {
    return deployment?.source ?? server.source;
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
    const name = typeof deployment.name === 'string' ? deployment.name.trim() : '';
    const localPath = typeof deployment.localPath === 'string' ? deployment.localPath.trim() : '';
    // 这里保持 `undefined`：校验 localPath 的调用方不会同时给 deployPath，
    // 归一成空串会让它们反被 deployPath 规则拦下。
    const rawDeployPath = deployment.deployPath;
    if (source === 'project') {
        if (localPath === '~' || localPath.startsWith('~/')) {
            throw new Error(
                `deployment "${name}" 的 localPath 不能用 ~ 表示家目录：${localPath}`,
            );
        }
        // hosts.json 跟着仓库走：只用 `/`。不做 `\` → `/` 兼容，Windows 也一样。
        if (/^[A-Za-z]:/.test(localPath) || /^[\\/]{2}/.test(localPath) || localPath.startsWith('/')) {
            throw new Error(
                `deployment "${name}" 的 localPath 必须是相对项目根目录的路径，不能是绝对路径：${localPath}`,
            );
        }
        if (localPath.includes('\\')) {
            throw new Error(
                `deployment "${name}" 的 localPath 必须使用 "/"，不能用 "\\"：${localPath}`,
            );
        }
        if (localPath.split('/').includes('..')) {
            throw new Error(
                `deployment "${name}" 的 localPath 不能包含 ".."，必须落在项目根目录内：${localPath}`,
            );
        }
    }
    if (source === 'global' && !isAbsolute(localPath)) {
        throw new Error(
            `全局配置里 deployment "${name}" 的 localPath 必须是绝对路径：${localPath}`,
        );
    }
    // 远端是 Linux / macOS：只接受 POSIX 绝对路径，不转换成 Windows 形式。
    if (typeof rawDeployPath === 'string') {
        const value = rawDeployPath.trim();
        if (!value.startsWith('/') || value.includes('\\') || value === '/' || value.split('/').includes('..')) {
            throw new Error(
                `deployment "${name}" 的 deployPath 必须是远端绝对路径（/srv/app）：${rawDeployPath}`,
            );
        }
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
 * @returns {Array<{ name: string, localPath: string, deployPath: string, exclude: string[], source?: 'ide' | 'project' | 'global', server: RemoteServer }>}
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
 * 找出跨 server 重名的 deployment。
 *
 * `collectDeployments` 按名字收敛成一条（后写覆盖），运行时不会报错；这个函数给展示层
 * 和上传入口用，让“同名两条、到底传哪条”不再靠排序猜。
 *
 * @param {ReadonlyArray<RemoteServer>} servers
 * @returns {Array<{ name: string, servers: string[] }>}
 */
export function deploymentConflicts(servers) {
    /** @type {Map<string, string[]>} */
    const byName = new Map();
    for (const server of servers) {
        for (const deployment of server.deployments ?? []) {
            const owners = byName.get(deployment.name) ?? [];
            owners.push(server.name);
            byName.set(deployment.name, owners);
        }
    }
    return [...byName.entries()]
        .filter(([, owners]) => owners.length > 1)
        .map(([name, owners]) => ({name, servers: owners}));
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
        // 认证方式**变了**才清掉另一套互斥凭据；同一种方式下高优先级层没给某个字段
        // （例如 IDE 没返回 passphrase）时保留低优先级层的值，不要误删。
        const baseAuthType = merged.authType
            ?? (merged.password ? 'PASSWORD' : merged.privateKeyPath ? 'KEY_PAIR' : undefined);
        const changed = baseAuthType !== undefined && baseAuthType !== override.authType;
        merged.authType = override.authType;
        if (changed) {
            delete merged.password;
            delete merged.passphrase;
            delete merged.privateKeyPath;
        }
        if (override.password !== undefined) merged.password = override.password;
        if (override.passphrase !== undefined) merged.passphrase = override.passphrase;
        if (override.privateKeyPath !== undefined) merged.privateKeyPath = override.privateKeyPath;
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
