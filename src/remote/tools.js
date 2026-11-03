// 远程工具：`remote_exec` / `remote_list_servers` / `remote_upload` / `remote_download`。
// 远端进程的启停不在这里：直接用 IDE 的 run configuration 工具。


//
// 依赖注入而非直接 import 插件上下文：`fetchIdeServers` 由 `plugin.js` 提供
// （它才知道 IDE 端口和项目路径），这里只负责缓存、合并、调用 SSH / SFTP。

import {
    assertDeploymentLocalPath,
    assertExcludePatterns,
    collectDeployments,
    deploymentNotFoundText,
    findServer,
    mergeServers,
    projectHostsPath,
    readHostsFile,
    resolveLocalPath,
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

        // 通配符在这里挡掉：hosts.json 允许写错，但真正同步前必须报给调用方。
        try {
            assertExcludePatterns(target.exclude ?? []);
            assertDeploymentLocalPath(target.server.source, target);
        } catch (error) {
            return {kind: 'invalid-deployment', deployment: target, error};
        }

        // 项目级 localPath 是相对的，传给文件系统前按项目根解析。
        const localPath = resolveLocalPath(projectPath, target.localPath);
        const outcome = await withServer(target.server.name, async (server) => {
            const conn = await connect(server);
            try {
                const sftp = await openSftp(conn);
                const options = {exclude: target.exclude ?? []};
                return direction === 'upload'
                    ? await uploadDirectory(sftp, localPath, target.deployPath, mode, options)
                    : await downloadDirectory(sftp, target.deployPath, localPath, mode, options);
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
            '在远程服务器上执行一条命令，返回输出与退出码。' +
            '用户说“去某台机器上执行 / 看日志”、或提到部署机 / 开发机 / 测试机时用它 —— 不要自己拼 ssh / scp。' +
            '每条命令是一条独立 SSH 连接：cd / export 不会跨命令保留，需要目录就传 workingDirectory。' +
            '命令跑完才返回，没有增量输出、没有 Ctrl-C 通道；长任务自己在远端用 nohup / tmux。' +
            '启动 / 停止远端进程或部署不归这里管，用 IDE 的 run configuration 工具。' +
            '不传 server 时返回当前可用的机器列表；传错服务器名时也会返回全部可用服务器，按列表重新调用即可。',
        input: {
            type: 'object',
            properties: {
                server: {
                    type: 'string',
                    description: '服务器名，来自 remote_list_servers 或上一次报错里列出的候选；不传就返回机器列表。',
                },
                command: {type: 'string', description: '在远端执行的 shell 命令。'},
                workingDirectory: {
                    type: 'string',
                    description: '可选：先 cd 到这个远程目录再执行（支持 ~ 与绝对路径）。',
                },
            },
            required: [],
        },
        execute: async (args) => {
            const server = typeof args?.server === 'string' ? args.server.trim() : '';
            const command = typeof args?.command === 'string' ? args.command : '';
            // 没给机器就当在问“有哪些机器可用”：直接给清单，别让它猜。
            if (!server) return {content: await serverListText(toolset)};
            if (!command.trim()) return {content: 'command 不能为空。'};
            const workingDirectory = typeof args?.workingDirectory === 'string' ? args.workingDirectory : undefined;

            const outcome = await toolset.exec(server, command, workingDirectory);
            switch (outcome.kind) {
                case 'missing': {
                    const ideError = toolset.ideError();
                    const prefix = ideError
                        ? `IDE 的 SSH 配置有问题，这次只用了项目 / 全局的配置：\n${ideError.message}\n\n`
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
            '列出当前可用的远程服务器，以及它们上面的路径映射（deployment）。' +
            '来源有三层，优先级从高到低：IDE 的 SSH 配置 → 项目 hosts.json → 全局 hosts.json；' +
            '同名机器以后者为准，deployment 也按名字合并。' +
            '每台机器带 [IDE] / [项目] / [全局] 标记：只有带 deployment 的机器才能做文件同步' +
            '（remote_upload / remote_download），只有 SSH 配置的机器只能执行命令（remote_exec）。' +
            '不确定机器名或 deployment 名时先调它；remote_exec 不传 server 时也会返回同一份清单。',
        input: {type: 'object', properties: {}, required: []},
        execute: async () => ({content: await serverListText(toolset)}),
    };
}

/**
 * 当前可用机器的清单（IDE 的 SSH 配置 + 项目 / 全局 hosts.json 三层合并）。
 *
 * `remote_list_servers` 和 `remote_exec`（不传 server 时）共用这一段，
 * 两处看到的机器列表必须一致。
 *
 * @param {ReturnType<typeof createRemoteToolset>} toolset
 * @returns {Promise<string>}
 */
export async function serverListText(toolset) {
    const servers = await toolset.load();
    /** @type {string[]} */
    const lines = [];
    const ideError = toolset.ideError();
    if (ideError) {
        lines.push('⚠ IDE 的 SSH 配置有问题，下面只列出项目 / 全局配置里的服务器：');
        lines.push(ideError.message);
        lines.push('');
    }
    if (servers.length === 0) {
        lines.push('当前没有可用的远程服务器。在 IDE 的 SSH Configurations 里添加服务器，或配置 hosts.json。');
        return lines.join('\n');
    }
    for (const entry of servers) {
        const source = entry.source === 'ide' ? 'IDE' : entry.source === 'project' ? '项目' : '全局';
        // 认证方式也报出来：OPEN_SSH 走 agent，不需要密码；KEY_PAIR 看私钥。
        const auth = entry.authType ? `  ${entry.authType}` : '';
        const label = entry.alias ? `${entry.name} (${entry.alias})` : entry.name;
        lines.push(`- ${label}  ${entry.host}:${entry.port}  ${entry.username}  [${source}]${auth}`);
        for (const deployment of entry.deployments ?? []) {
            try {
                assertDeploymentLocalPath(entry.source, deployment);
                lines.push(`    ${deployment.name}  ${deployment.localPath} ↔ ${deployment.deployPath}`);
            } catch (error) {
                lines.push(`    ⚠ ${error.message}`);
            }
        }
    }
    return lines.join('\n');
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
            ? '把一条 deployment 的本地目录同步到它的远程目录 —— deployment 就是一条「本地目录 ↔ 远端目录」的映射，' +
            '名字来自 remote_list_servers。' +
            '只传「大小或修改时间变了」的文件，没变的根本不传，所以重复同步很便宜。' +
            '默认 overwrite：只覆盖 / 新增，目标端多出来的文件保留。' +
            'mode=mirror：目标端多出来的文件会被删掉 —— 不可逆，只在明确要求镜像时用。'
            : '把一条 deployment 的远程目录同步到它的本地目录 —— deployment 就是一条「本地目录 ↔ 远端目录」的映射，' +
            '名字来自 remote_list_servers。' +
            '只传「大小或修改时间变了」的文件，没变的根本不传，所以重复同步很便宜。' +
            '默认 overwrite：只覆盖 / 新增，目标端多出来的文件保留。' +
            'mode=mirror：本地多出来的文件会被删掉 —— 不可逆，只在明确要求镜像时用。',
        input: {
            type: 'object',
            properties: {
                deployment: {
                    type: 'string',
                    description: 'deployment 名，来自 remote_list_servers 里列出的那条映射（本地目录 ↔ 远端目录）。',
                },
                mode: {
                    type: 'string',
                    enum: ['overwrite', 'mirror'],
                    description: 'overwrite（默认，只覆盖 / 新增，保留目标端多余文件）或 mirror（删掉目标端多余文件，不可逆）。',
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
                case 'invalid-deployment':
                    return {content: outcome.error.message};
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
        return `服务器 "${server.name}" 用私钥认证，但没有私钥路径。在 IDE 的 SSH Configurations 里补上私钥路径。`;
    }
    if (server.authType && server.authType !== 'PASSWORD' && server.authType !== 'OPEN_SSH') {
        return `服务器 "${server.name}" 的认证方式 ${server.authType} 暂不支持。`;
    }
    return `服务器 "${server.name}" 用密码认证，但没有密码。在 IDE 的 SSH Configurations 里重新填一次密码（` +
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
