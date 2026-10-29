// 远程执行与文件同步的工具：`remote_exec` / `remote_list_servers` /
// `remote_upload` / `remote_download`。
//
// 依赖注入而非直接 import 插件上下文：`fetchIdeServers` 由 `plugin.js` 提供
// （它才知道 IDE 端口和项目路径），这里只负责缓存、合并、调用 SSH / SFTP。

import {
    collectDeployments,
    deploymentNotFoundText,
    findServer,
    mergeServers,
    projectHostsPath,
    readHostsFile,
    serverNotFoundText,
    GLOBAL_HOSTS_PATH,
} from './hosts.js';
import {describeSshError, runRemoteCommand} from './ssh.js';
import {downloadDirectory, openSftp, uploadDirectory} from './sftp.js';
import {connect} from './ssh.js';

/** 服务器列表的缓存时长。命中就不打 IDE MCP；miss / 连接失败会强制刷新。 */
export const SERVER_CACHE_TTL_MS = 60000;

/**
 * @param {{
 *   projectPath: string,
 *   fetchIdeServers: () => Promise<Array<import('./hosts.js').RemoteServer>>,
 *   globalHostsPath?: string,
 * }} options
 */
export function createRemoteToolset({projectPath, fetchIdeServers, globalHostsPath = GLOBAL_HOSTS_PATH}) {
    /** @type {{ at: number, servers: Array<import('./hosts.js').RemoteServer> } | undefined} */
    let cache;
    /** 最近一次 IDE 没读成的错误（配置不完整 / 没连上），给展示层转给用户。 */
    /** @type {Error | undefined} */
    let lastIdeError;
    /** @type {Promise<Array<import('./hosts.js').RemoteServer>> | undefined} */
    let inFlight;

    /**
     * 全量加载三层并合并。
     *
     * @param {{ force?: boolean } | undefined} [options]
     */
    const load = async ({force = false} = {}) => {
        if (!force && cache && Date.now() - cache.at < SERVER_CACHE_TTL_MS) return cache.servers;
        if (inFlight) return inFlight;
        const run = (async () => {
            // IDE 失败 ≠ 整体失败：还有项目级与全局两级可以用。但错误要留住 ——
            // 配置不完整（缺 host / 缺凭据）是用户该去 IDE 里修的东西，不能悄悄退化成
            // "项目配置里没有这台机器"。
            const ide = await fetchIdeServers()
                .then((value) => {
                    lastIdeError = undefined;
                    return value;
                })
                .catch((error) => {
                    lastIdeError = error instanceof Error ? error : new Error(String(error));
                    return [];
                });
            const project = readHostsFile(projectHostsPath(projectPath), 'project');
            const global = readHostsFile(globalHostsPath, 'global');
            // 合并后仍然缺 host / username 的条目（只写了 mapping 的补丁）在这里丢掉：
            // 它没有连接信息，执行时只会变成一个看不懂的 SSH 错误。
            const servers = mergeServers([global, project, ide])
                .filter((server) => server.host && server.username)
                .map((server) => ({...server, port: server.port ?? 22}));
            cache = {at: Date.now(), servers};
            return servers;
        })();
        inFlight = run;
        try {
            return await run;
        } finally {
            if (inFlight === run) inFlight = undefined;
        }
    };

    /**
     * 找一台服务器，连接失败时刷新凭据重试一次。
     *
     * @template T
     * @param {string} name
     * @param {(server: import('./hosts.js').RemoteServer) => Promise<T>} action
     * @returns {Promise<{kind: 'ok', value: T, retried: boolean} | {kind: 'missing', servers: Array<import('./hosts.js').RemoteServer>} | {kind: 'no-credentials', server: import('./hosts.js').RemoteServer} | {kind: 'failed', server: import('./hosts.js').RemoteServer, error: unknown}>}
     */
    const withServer = async (name, action) => {
        let servers = await load();
        let server = findServer(servers, name);
        if (!server) {
            servers = await load({force: true});
            server = findServer(servers, name);
        }
        if (!server) return {kind: 'missing', servers};
        if (!hasUsableCredentials(server)) return {kind: 'no-credentials', server};

        try {
            return {kind: 'ok', server, value: await action(server), retried: false};
        } catch {
            // 凭据可能刚在 IDE 里改过：刷新后重试一次，仍失败才把错误交出去。
            const refreshed = await load({force: true}).catch(() => servers);
            const retry = findServer(refreshed, name);
            if (!retry) return {kind: 'missing', servers: refreshed};
            if (!hasUsableCredentials(retry)) return {kind: 'no-credentials', server: retry};
            try {
                return {kind: 'ok', server: retry, value: await action(retry), retried: true};
            } catch (error) {
                return {kind: 'failed', server: retry, error};
            }
        }
    };

    /**
     * 找一条 deployment（按名字全局唯一）。
     *
     * @param {string} name
     */
    const findDeployment = async (name) => {
        let deployments = collectDeployments(await load());
        let target = deployments.find((entry) => entry.name === name);
        if (!target) {
            deployments = collectDeployments(await load({force: true}));
            target = deployments.find((entry) => entry.name === name);
        }
        return {target, deployments};
    };

    /**
     * 执行一条远程命令。
     *
     * @param {string} name
     * @param {string} command
     * @param {string | undefined} workingDirectory
     */
    const exec = async (name, command, workingDirectory) => {
        const outcome = await withServer(name, (server) => runRemoteCommand(server, command, {workingDirectory}));
        if (outcome.kind !== 'ok') return outcome;
        return {kind: 'ok', server: outcome.server, result: outcome.value, retried: outcome.retried};
    };

    /**
     * 按 mapping 同步一个目录。`direction` 决定哪边是源。
     *
     * @param {string} name
     * @param {'overwrite' | 'mirror'} mode
     * @param {'upload' | 'download'} direction
     */
    const sync = async (name, mode, direction) => {
        const {target, deployments} = await findDeployment(name);
        if (!target) return {kind: 'missing', deployments};

        const outcome = await withServer(target.server.name, async (server) => {
            const conn = await connect(server);
            try {
                const sftp = await openSftp(conn);
                return direction === 'upload'
                    ? await uploadDirectory(sftp, target.localPath, target.deployPath, mode)
                    : await downloadDirectory(sftp, target.deployPath, target.localPath, mode);
            } finally {
                conn.end();
            }
        });
        if (outcome.kind !== 'ok') return outcome;
        return {kind: 'ok', deployment: target, stats: outcome.value, retried: outcome.retried};
    };

    return {
        load,
        exec,
        upload: (name, mode) => sync(name, mode, 'upload'),
        download: (name, mode) => sync(name, mode, 'download'),
        /** 最近一次 IDE 读取失败的原因；成功时为 undefined。 */
        ideError: () => lastIdeError,
    };
}

/**
 * `remote_exec` 的工具定义。
 *
 * @param {ReturnType<typeof createRemoteToolset>} toolset
 */
export function remoteExecTool(toolset) {
    return {
        name: 'remote_exec',
        description:
            '用户说“去某台机器上执行 / 重启 / 看日志”、或提到部署机 / 开发机 / 测试机时用它 —— 不要自己拼 ssh / scp。' +
            '在远程服务器上执行一条命令，返回输出与退出码。' +
            '每条命令是一条独立 SSH 连接：cd / export 不会跨命令保留，需要目录就传 workingDirectory。' +
            '传错服务器名时会返回全部可用服务器，按返回的列表重新调用即可。',
        input: {
            type: 'object',
            properties: {
                server: {
                    type: 'string',
                    description: '服务器名，来自 remote_list_servers 或上一次报错里列出的候选。',
                },
                command: {type: 'string', description: '要执行的 shell 命令。'},
                workingDirectory: {
                    type: 'string',
                    description: '可选：先 cd 到这个远程目录再执行（支持 ~ 与绝对路径）。',
                },
            },
            required: ['server', 'command'],
        },
        execute: async (args) => {
            const server = typeof args?.server === 'string' ? args.server.trim() : '';
            const command = typeof args?.command === 'string' ? args.command : '';
            if (!server) return {content: 'server 不能为空。'};
            if (!command.trim()) return {content: 'command 不能为空。'};
            const workingDirectory = typeof args?.workingDirectory === 'string' ? args.workingDirectory : undefined;

            const outcome = await toolset.exec(server, command, workingDirectory);
            switch (outcome.kind) {
                case 'missing': {
                    const ideError = toolset.ideError();
                    const prefix = ideError
                        ? `IDE 的 Deployment 配置有问题，这次只用了项目 / 全局的配置：\n${ideError.message}\n\n`
                        : '';
                    return {content: prefix + serverNotFoundText(outcome.servers, server)};
                }
                case 'no-credentials':
                    return {content: noCredentialsText(outcome.server)};
                case 'failed':
                    return {
                        content:
                            `[${outcome.server.name}] 执行失败\n` +
                            describeSshError(outcome.error, outcome.server),
                    };
                default:
                    return {content: formatRunSummary(outcome.server, outcome.result, outcome.retried === true)};
            }
        },
    };
}

/**
 * `remote_list_servers`：服务器 + 每台机器上挂的 deployment。
 *
 * @param {ReturnType<typeof createRemoteToolset>} toolset
 */
export function remoteListServersTool(toolset) {
    return {
        name: 'remote_list_servers',
        description:
            '列出当前可用的远程服务器与它们上面的路径映射，带 [IDE] / [项目] / [全局] 来源标记。' +
            '不确定服务器名或 deployment 名时先调它。',
        input: {type: 'object', properties: {}, required: []},
        execute: async () => {
            const servers = await toolset.load();
            /** @type {string[]} */
            const lines = [];
            const ideError = toolset.ideError();
            if (ideError) {
                lines.push('⚠ IDE 的 Deployment 配置有问题，下面只列出项目 / 全局配置里的服务器：');
                lines.push(ideError.message);
                lines.push('');
            }
            if (servers.length === 0) {
                lines.push('当前没有可用的远程服务器。在 IDE 的 Deployment 里添加 SFTP 服务器，或配置 hosts.json。');
                return {content: lines.join('\n')};
            }
            for (const entry of servers) {
                const source = entry.source === 'ide' ? 'IDE' : entry.source === 'project' ? '项目' : '全局';
                // 认证方式也报出来：OPEN_SSH 走 agent，不需要密码；KEY_PAIR 看私钥。
                const auth = entry.authType ? `  ${entry.authType}` : '';
                const label = entry.alias ? `${entry.name} (${entry.alias})` : entry.name;
                lines.push(`- ${label}  ${entry.host}:${entry.port}  ${entry.username}  [${source}]${auth}`);
                for (const deployment of entry.deployments ?? []) {
                    lines.push(`    ${deployment.name}  ${deployment.localPath} ↔ ${deployment.deployPath}`);
                }
            }
            return {content: lines.join('\n')};
        },
    };
}

/**
 * `remote_upload` / `remote_download` 的共用定义。
 *
 * @param {ReturnType<typeof createRemoteToolset>} toolset
 * @param {'upload' | 'download'} direction
 */
function transferTool(toolset, direction) {
    const isUpload = direction === 'upload';
    return {
        name: isUpload ? 'remote_upload' : 'remote_download',
        description: isUpload
            ? '把一条 deployment 的本地目录上传到它的远程目录。只传大小或修改时间变了的文件，未变的自动跳过；' +
            '默认 overwrite（只覆盖/新增，远程多余文件保留）；mode=mirror 时还会删掉远程多出来的文件。'
            : '把一条 deployment 的远程目录拉回本地目录。只拉大小或修改时间变了的文件，未变的自动跳过；' +
            '默认 overwrite（只覆盖/新增，本地多余文件保留）；mode=mirror 时还会删掉本地多出来的文件。',
        input: {
            type: 'object',
            properties: {
                deployment: {
                    type: 'string',
                    description: 'deployment 名，来自 remote_list_servers 里列出的那条。',
                },
                mode: {
                    type: 'string',
                    enum: ['overwrite', 'mirror'],
                    description: '默认 overwrite；mirror 会删除目标端多出来的文件（不可逆）。',
                },
            },
            required: ['deployment'],
        },
        execute: async (args) => {
            const name = typeof args?.deployment === 'string' ? args.deployment.trim() : '';
            if (!name) return {content: 'deployment 不能为空。'};
            const mode = args?.mode === 'mirror' ? 'mirror' : 'overwrite';

            const outcome = isUpload ? await toolset.upload(name, mode) : await toolset.download(name, mode);
            switch (outcome.kind) {
                case 'missing':
                    return {content: deploymentNotFoundText(outcome.deployments, name)};
                case 'no-credentials':
                    return {content: noCredentialsText(outcome.server)};
                case 'failed':
                    return {
                        content:
                            `[${outcome.server.name}] 传输失败\n` +
                            describeSshError(outcome.error, outcome.server),
                    };
                default: {
                    const verb = isUpload ? '上传' : '下载';
                    const stats = outcome.stats;
                    const unchanged = stats.unchanged ?? 0;
                    const head = `[${outcome.deployment.name}] ${verb}完成 (${mode})`;
                    const lines = [
                        `${stats.files} files${unchanged > 0 ? ` (${unchanged} unchanged)` : ''}, ` +
                        `${stats.dirs} dirs, ${formatBytes(stats.bytes)}`,
                    ];
                    if (stats.skipped > 0) lines.push(`skipped (symlink/other): ${stats.skipped}`);
                    if (stats.deleted > 0) lines.push(`deleted: ${stats.deleted}`);
                    if (outcome.retried) lines.push('retried after refreshing credentials');
                    return {content: `${head}\n${lines.join('\n')}`};
                }
            }
        },
    };
}

/**
 * @param {ReturnType<typeof createRemoteToolset>} toolset
 */
export function remoteUploadTool(toolset) {
    return transferTool(toolset, 'upload');
}

/**
 * @param {ReturnType<typeof createRemoteToolset>} toolset
 */
export function remoteDownloadTool(toolset) {
    return transferTool(toolset, 'download');
}

/**
 * 一次执行的结果 → 模型可读的文本。
 *
 * @param {import('./hosts.js').RemoteServer} server
 * @param {{ exitCode: number | null, stdout: string, stderr: string }} result
 * @param {boolean} retried
 */
export function formatRunSummary(server, result, retried = false) {
    const head = [`[${server.name}] exitCode ${result.exitCode ?? 'null'}`];
    if (retried) head.push('retried');
    const body = [result.stdout.trimEnd()];
    if (result.stderr.trim()) body.push(`[stderr]\n${result.stderr.trimEnd()}`);
    return `${head.join(', ')}\n${body.filter(Boolean).join('\n')}`;
}

/**
 * 这台能不能连：PASSWORD 看密码，KEY_PAIR 看私钥，OPEN_SSH 靠 agent（不需要本地字段）。
 *
 * @param {import('./hosts.js').RemoteServer} server
 */
export function hasUsableCredentials(server) {
    if (server.authType === 'OPEN_SSH') return true;
    return Boolean(server.password || server.privateKeyPath);
}

/** 缺凭据时给模型 / 用户的说明，按认证方式区分该去改哪里。 */
function noCredentialsText(server) {
    if (server.authType === 'KEY_PAIR') {
        return `服务器 "${server.name}" 用私钥认证，但没有私钥路径。在 IDE 的 Deployment 设置里选一次私钥文件。`;
    }
    if (server.authType && server.authType !== 'PASSWORD' && server.authType !== 'OPEN_SSH') {
        return `服务器 "${server.name}" 的认证方式 ${server.authType} 暂不支持。`;
    }
    return `服务器 "${server.name}" 用密码认证，但没有密码。在 IDE 的 Deployment 设置里重新选一次 SSH 配置（` +
        `引用的那条可能已被删除），或在 hosts.json 里直接填 password。`;
}

/** @param {number} bytes */
export function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
