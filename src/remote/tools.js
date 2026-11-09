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
import {createRemoteRun, describeSshError, runRemoteCommand, withWorkingDirectory} from './ssh.js';
import {downloadDirectory, openSftp, uploadDirectory} from './sftp.js';
import {connect} from './ssh.js';

/** 服务器列表的缓存时长。命中就不打 IDE MCP；miss / 连接失败会强制刷新。 */
export const SERVER_CACHE_TTL_MS = 60000;

/** 第一次等命令结束的时间：超过就转成“后台运行 + runID”。有续等兜底，不必等太久。 */
export const FIRST_WAIT_MS = 15000;

/** 续查时的服务端退避：第 1 次 2s、第 2 次 4s、之后每次 8s。 */
export const RUN_BACKOFF_MS = [2000, 4000, 8000];

/** 已结束的 run 保留多久（供迟到的续查取结果）。 */
export const RUN_KEEP_MS = 5 * 60 * 1000;

/** 同时保留多少个 run。 */
export const RUN_MAX = 20;

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
        const startedAt = Date.now();
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
        const elapsedMs = Date.now() - startedAt;
        if (outcome.kind !== 'ok') return outcome;
        return {kind: 'ok', deployment: target, stats: outcome.value, elapsedMs, retried: outcome.retried};
    };

    /**
     * 进行中的远程执行：`runID → { server, run, polls }`。
     *
     * 命令超时后不杀进程，连接也保持打开 —— 下一次带 `runID` 的调用直接挂在同一个 run 上等，
     * 而不是重跑。只保留最近若干条，避免长会话里无限堆积。
     */
    /** @type {Map<string, { server: import('./hosts.js').RemoteServer, run: ReturnType<typeof createRemoteRun>, polls: number, doneAt: number | null, reported: boolean }>} */
    const runs = new Map();

    const pruneRuns = () => {
        const now = Date.now();
        for (const [id, entry] of runs) {
            if (entry.run.done && entry.doneAt === null) entry.doneAt = now;
            if (entry.doneAt !== null && now - entry.doneAt > RUN_KEEP_MS) runs.delete(id);
        }
        while (runs.size > RUN_MAX) {
            const oldest = runs.keys().next().value;
            if (oldest === undefined) break;
            runs.delete(oldest);
        }
    };

    /**
     * 启动一条命令，但**不等到结束**：调用方拿 run 和 runID 自己决定等多久。
     *
     * @param {string} name
     * @param {string} command
     * @param {string | undefined} workingDirectory
     */
    const startExec = async (name, command, workingDirectory) => {
        const outcome = await withServer(name, async (server) => {
            const conn = await connect(server);
            try {
                return createRemoteRun(conn, withWorkingDirectory(command, workingDirectory));
            } catch (error) {
                conn.end();
                throw error;
            }
        });
        if (outcome.kind !== 'ok') return outcome;
        const runID = `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        runs.set(runID, {server: outcome.server, run: outcome.value, polls: 0, doneAt: null, reported: false});
        pruneRuns();
        return {kind: 'ok', server: outcome.server, runID, run: outcome.value, retried: outcome.retried};
    };

    /**
     * 挂到一个已有的 run 上，等它结束或等满这一轮的退避时间。
     *
     * 退避是**服务端**的事：第 1 次 2s、第 2 次 4s、之后每次 8s。模型只需要“马上再调一次”，
     * 不需要自己 sleep，也不需要传等待时长。
     *
     * @param {string} runID
     */
    const continueExec = async (runID) => {
        const entry = runs.get(runID);
        if (!entry) return {kind: 'missing', runID};
        // 结束结果已经交给模型了：再传同一个 runID 只可能是模型没意识到它已经结束，
        // 必须明确拒绝，而不是把 exitCode 再回一遍 —— 否则它会一直轮询下去。
        if (entry.reported) return {kind: 'finished', entry};
        const waitedMs = RUN_BACKOFF_MS[Math.min(entry.polls, RUN_BACKOFF_MS.length - 1)];
        entry.polls += 1;
        const ended = await entry.run.wait(waitedMs);
        if (ended) entry.reported = true;
        pruneRuns();
        return {kind: 'ok', entry, ended, waitedMs};
    };

    /**
     * 把“这个 run 的结束结果已经交出去了”记下来。
     *
     * 第一次调用（不带 runID）自己等到结束时，也要标记 —— 否则模型随后再传 runID 会再拿到一次
     * `exitCode`，而它分不清“这是新的结果”还是“旧的又给了一遍”。
     *
     * @param {string} runID
     */
    const finishRun = (runID) => {
        const entry = runs.get(runID);
        if (entry) entry.reported = true;
    };

    return {
        load,
        exec,
        startExec,
        continueExec,
        finishRun,
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
            '用户说“去某台机器上执行 / 看日志”、或提到部署机 / 开发机 / 测试机时用它 —— 不要自己拼 ssh / scp。\n' +
            '- 每条命令是一条独立 SSH 连接：cd / export 不会跨命令保留，需要目录就传 workingDirectory。\n' +
            '- 命令在 15s 内没结束时返回 `runID` 和 `stillRunning`：命令仍在远端运行，**不会因为这次超时被杀**。\n' +
            '- 接着看后续输出就**直接再调 remote_exec 并传 `runID`**。**不要 sleep、不要等待、不要重跑原命令** —— ' +
            '服务端自己按 2s → 4s → 8s 退避等待，命令一结束就立刻返回。\n' +
            '- 返回里出现 `exitCode` = 命令**已经结束**，结果已经给全了：**不要再用这个 runID 调用**。\n' +
            '- 常驻型命令别直接调（docker run 不带 -d、compose up、tail -f、watch、前台 server）：' +
            '看已在跑的服务用 docker exec；要放后台就 nohup <cmd> > <日志> 2>&1 &，工具会立刻返回。\n' +
            '- 管道不会终止上游：<cmd> | head 只是截断输出，上游照样跑到自己退出。\n' +
            '- 多条命令别写成 `a && b && nohup c &` —— & 会作用到整条链，cd / 准备步骤一起被扔进后台，' +
            '后面的命令就和它抢时序；要后台就单独一条，其它用 ; 分隔。\n' +
            '- 启动 / 停止远端进程或部署不归这里管，用 IDE 的 run configuration 工具。\n' +
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
                runID: {
                    type: 'string',
                    description: '上一次返回的 runID：命令还没结束时用它接着看结果，不要重跑原命令。',
                },
            },
            required: [],
            additionalProperties: false,
        },
        execute: async (args) => {
            const runID = typeof args?.runID === 'string' ? args.runID.trim() : '';
            if (runID) return {content: await continueRunText(toolset, runID)};

            const server = typeof args?.server === 'string' ? args.server.trim() : '';
            const command = typeof args?.command === 'string' ? args.command : '';
            // 没给机器就当在问“有哪些机器可用”：直接给清单，别让它猜。
            if (!server) return {content: await serverListText(toolset)};
            if (!command.trim()) return {content: 'command 不能为空。'};
            const workingDirectory = typeof args?.workingDirectory === 'string' ? args.workingDirectory : undefined;

            const outcome = await toolset.startExec(server, command, workingDirectory);
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
                    break;
            }

            const ended = await outcome.run.wait(FIRST_WAIT_MS);
            const output = outcome.run.take();
            if (ended) {
                toolset.finishRun(outcome.runID);
                return {content: finishedText(outcome.server, outcome.run.exitCode, output, outcome.retried === true)};
            }
            return {
                content: runningText(outcome.server, outcome.runID, output, FIRST_WAIT_MS),
            };
        },
    };
}

/**
 * 带 `runID` 的续查：服务端按 2s → 4s → 8s 退避等待，结束时立刻返回。
 *
 * @param {ReturnType<typeof createRemoteToolset>} toolset
 * @param {string} runID
 */
async function continueRunText(toolset, runID) {
    const outcome = await toolset.continueExec(runID);
    if (outcome.kind === 'finished') {
        return (
            `runID "${runID}" 对应的命令**已经结束**，结果也返回过了。不要再传这个 runID；\n` +
            '要重跑就重新调用 remote_exec（不带 runID）。'
        );
    }
    if (outcome.kind === 'missing') {
        return (
            `找不到 runID "${runID}"：可能它已经结束并清理（只保留 5 分钟），或者这属于另一个会话。\n` +
            '需要的话重新调用 remote_exec（不带 runID）重跑。'
        );
    }
    const {entry, ended, waitedMs} = outcome;
    const output = entry.run.take();
    if (ended) return finishedText(entry.server, entry.run.exitCode, output);
    return runningText(entry.server, runID, output, waitedMs);
}

/**
 * 命令结束时的文本。
 *
 * @param {import('./hosts.js').RemoteServer} server
 * @param {number | null} exitCode
 * @param {string} output
 * @param {boolean} [retried]
 */
function finishedText(server, exitCode, output, retried = false) {
    const head = [`[${server.name}] 命令已结束，exitCode ${exitCode ?? 'null'}`];
    if (retried) head.push('retried');
    const {text, truncated} = truncateOutput(output);
    const body = text.trimEnd() || '（这段没有新输出；更早的输出已经在上一次返回里）';
    return `${head.join(', ')}\n${body}${truncated ? '\n\n（输出已截断：只保留头 200 行与尾部）' : ''}`;
}

/**
 * 命令还在跑时的文本。
 *
 * @param {import('./hosts.js').RemoteServer} server
 * @param {string} runID
 * @param {string} output
 * @param {number} waitedMs
 */
function runningText(server, runID, output, waitedMs) {
    const {text, truncated} = truncateOutput(output);
    const lines = [
        `[${server.name}] 命令仍在运行（本轮等了 ${Math.round(waitedMs / 1000)}s），进程没有被杀。`,
        `接着看就再调 remote_exec 并传 runID="${runID}"；不要 sleep、不要等待、不要重跑原命令 —— 服务端会自己退避等待。` +
            '返回里出现 `exitCode` 就说明结束了，不要再用这个 runID。',
    ];
    lines.push('', text.trimEnd() || '（这段时间没有新输出）');
    if (truncated) lines.push('', '（输出已截断：只保留头 200 行与尾部）');
    return lines.join('\n');
}

/** 单次返回的输出上限。 */
const MAX_OUTPUT_LINES = 2000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const HEAD_OUTPUT_LINES = 200;

/**
 * 截断超长输出：保留头 200 行 + 尾部，中间标注省略。
 *
 * @param {string} output
 * @returns {{ text: string, truncated: boolean }}
 */
export function truncateOutput(output) {
    if (!output) return {text: '', truncated: false};
    let text = output;
    let truncated = false;

    if (Buffer.byteLength(text, 'utf8') > MAX_OUTPUT_BYTES) {
        const buffer = Buffer.from(text, 'utf8');
        text = buffer.subarray(buffer.length - MAX_OUTPUT_BYTES).toString('utf8').replace(/^\uFFFD+/, '');
        truncated = true;
    }

    const lines = text.split('\n');
    if (lines.length > MAX_OUTPUT_LINES) {
        const removed = lines.length - MAX_OUTPUT_LINES;
        text = [
            ...lines.slice(0, HEAD_OUTPUT_LINES),
            `… 省略 ${removed} 行 …`,
            ...lines.slice(-(MAX_OUTPUT_LINES - HEAD_OUTPUT_LINES)),
        ].join('\n');
        truncated = true;
    }
    return {text, truncated};
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
        input: {type: 'object', properties: {}, required: [], additionalProperties: false},
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
            'mode=mirror：目标端多出来的文件会被删掉 —— 不可逆，只在明确要求镜像时用。' +
            '**只传文件，不启动任何进程** —— 要启动 / 部署远端进程走 IDE 的 run configuration。'
            : '把一条 deployment 的远程目录同步到它的本地目录 —— deployment 就是一条「本地目录 ↔ 远端目录」的映射，' +
            '名字来自 remote_list_servers。' +
            '只传「大小或修改时间变了」的文件，没变的根本不传，所以重复同步很便宜。' +
            '默认 overwrite：只覆盖 / 新增，目标端多出来的文件保留。' +
            'mode=mirror：本地多出来的文件会被删掉 —— 不可逆，只在明确要求镜像时用。' +
            '**只传文件，不启动任何进程。**',
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
            additionalProperties: false,
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
                    const elapsed = typeof outcome.elapsedMs === 'number' ? `, ${(outcome.elapsedMs / 1000).toFixed(1)}s` : '';
                    const head = `[${outcome.deployment.name}] ${verb}完成 (${mode})`;
                    const lines = [
                        `${stats.files} files${unchanged > 0 ? ` (${unchanged} unchanged)` : ''}, ` +
                        `${stats.dirs} dirs, ${formatBytes(stats.bytes)}${elapsed}`,
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
