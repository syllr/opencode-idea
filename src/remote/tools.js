// 远程工具：`remote_exec` / `remote_list_servers` / `remote_upload` / `remote_download`。
// 远端进程的启停不在这里：直接用 IDE 的 run configuration 工具。


//
// 依赖注入而非直接 import 插件上下文：`fetchIdeServers` 由 `plugin.js` 提供
// （它才知道 IDE 端口和项目路径），这里只负责缓存、合并、调用 SSH / SFTP。

import {
    assertDeploymentLocalPath,
    assertExcludePatterns,
    collectDeployments,
    deploymentConflicts,
    deploymentNotFoundText,
    deploymentSource,
    findServer,
    mergeServers,
    projectHostsPath,
    readHostsFileReport,
    resolveLocalPath,
    serverNotFoundText,
    GLOBAL_HOSTS_PATH,
} from './hosts.js';
import {createRemoteRun, describeSshError, withWorkingDirectory} from './ssh.js';
import {downloadDirectory, openSftp, uploadDirectory, SourceDirectoryMissing} from './sftp.js';
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
 *   reconcileFailure?: () => string | undefined,
 *   deploymentPush?: () => ReadonlyMap<string, string>,
 * }} options
 */
export function createRemoteToolset({
    projectPath,
    fetchIdeServers,
    globalHostsPath = GLOBAL_HOSTS_PATH,
    reconcileFailure,
    deploymentPush,
}) {
    /** @type {{ at: number, servers: Array<import('./hosts.js').RemoteServer> } | undefined} */
    let cache;
    /** 最近一次 IDE 没读成的错误（配置不完整 / 没连上），给展示层转给用户。 */
    /** @type {Error | undefined} */
    let lastIdeError;
    /** 项目 / 全局 hosts.json 的解析错误；之前被静默当成空文件。 */
    /** @type {string | undefined} */
    let lastHostsError;
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
            const projectReport = readHostsFileReport(projectHostsPath(projectPath), 'project');
            const globalReport = readHostsFileReport(globalHostsPath, 'global');
            lastHostsError = [projectReport.error, globalReport.error].filter(Boolean).join('\n') || undefined;
            const project = projectReport.servers;
            const global = globalReport.servers;
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
        } catch (error) {
            // 源目录不存在不是凭据问题，重试只会再扫一遍、再报一次；直接交给调用方。
            if (error instanceof SourceDirectoryMissing) {
                return {kind: 'source-missing', side: error.side, path: error.path};
            }
            // 凭据可能刚在 IDE 里改过：刷新后重试一次，仍失败才把错误交出去。
            const refreshed = await load({force: true}).catch(() => servers);
            const retry = findServer(refreshed, name);
            if (!retry) return {kind: 'missing', servers: refreshed};
            if (!hasUsableCredentials(retry)) return {kind: 'no-credentials', server: retry};
            try {
                return {kind: 'ok', server: retry, value: await action(retry), retried: true};
            } catch (error2) {
                if (error2 instanceof SourceDirectoryMissing) {
                    return {kind: 'source-missing', side: error2.side, path: error2.path};
                }
                return {kind: 'failed', server: retry, error: error2};
            }
        }
    };

    /**
     * 找一条 deployment（按名字全局唯一）。
     *
     * @param {string} name
     */
    const findDeployment = async (name) => {
        let servers = await load();
        let deployments = collectDeployments(servers);
        let conflict = deploymentConflicts(servers).find((entry) => entry.name === name);
        let target = deployments.find((entry) => entry.name === name);
        if (!target || conflict) {
            servers = await load({force: true});
            deployments = collectDeployments(servers);
            conflict = deploymentConflicts(servers).find((entry) => entry.name === name);
            target = deployments.find((entry) => entry.name === name);
        }
        return {target, deployments, conflict};
    };

    /**
     * 按 mapping 同步一个目录。`direction` 决定哪边是源。
     *
     * @param {string} name
     * @param {'overwrite' | 'mirror'} mode
     * @param {'upload' | 'download'} direction
     */
    const sync = async (name, mode, direction) => {
        const {target, deployments, conflict} = await findDeployment(name);
        if (conflict) return {kind: 'deployment-conflict', name, servers: conflict.servers};
        if (!target) return {kind: 'missing', deployments};

        // 通配符在这里挡掉：hosts.json 允许写错，但真正同步前必须报给调用方。
        // 路径口径按 deployment **自己的来源**（项目级 / 全局），不是合并后 server 的来源。
        try {
            assertExcludePatterns(target.exclude ?? []);
            assertDeploymentLocalPath(deploymentSource(target.server, target), target);
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
            if (entry.doneAt !== null && now - entry.doneAt > RUN_KEEP_MS) {
                entry.run.dispose?.();
                runs.delete(id);
            }
        }
        while (runs.size > RUN_MAX) {
            // 只淘汰已经结束的；仍在跑的 run 不能静默丢掉，否则 runID 会变成
            // “找不到（只保留 5 分钟）”，而进程和连接都还活着。
            const oldest = [...runs.entries()].find(([, entry]) => entry.run.done);
            if (!oldest) break;
            oldest[1].run.dispose?.();
            runs.delete(oldest[0]);
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
        startExec,
        continueExec,
        finishRun,
        upload: (name, mode) => sync(name, mode, 'upload'),
        download: (name, mode) => sync(name, mode, 'download'),
        /** 最近一次 IDE 读取失败的原因；成功时为 undefined。 */
        ideError: () => lastIdeError,
        /** 项目 / 全局 hosts.json 的解析错误；成功时为 undefined。 */
        hostsError: () => lastHostsError,
        /** 最近一次 hosts.json → IDE 自动对账的失败原因（空列表 / 路径不合规都算）。 */
        reconcileFailure: () => reconcileFailure?.(),
        /** deployment 名 → 最近一次推送到 IDE 的结果（“已同步到 IDE” / “未推到 IDE：…”）。 */
        deploymentPush: () => deploymentPush?.() ?? new Map(),
        /** 卸载时把仍在服务的远端 run 连接关掉（不杀远端进程）。 */
        dispose: () => {
            for (const entry of runs.values()) entry.run.dispose?.();
            runs.clear();
        },
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
            '- 命令在 15s 内没结束时返回文本里的 `runID`（且没有 `exitCode`）：命令仍在远端运行，**不会因为这次超时被杀**。\n' +
            '- 接着看后续输出就**直接再调 remote_exec 并传 `runID`**。**不要 sleep、不要等待、不要重跑原命令** —— ' +
            '服务端自己按 2s → 4s → 8s 退避等待，命令一结束就立刻返回。\n' +
            '- 返回里出现 `exitCode` = 命令**已经结束**，结果已经给全了：**不要再用这个 runID 调用**。\n' +
            '- 等待只有三种正确形态：有返回值就等它返回；有状态就在同一条命令里轮询终态（sleep 0.5 只放在循环里）；有事件就监听事件，超时只作为失败上界。**不要单独发 sleep N 当等待**：同步接口不要 & 到后台，容器/服务状态用条件轮询。\n' +
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
        const head = text.split('\n').slice(0, HEAD_OUTPUT_LINES).join('\n');
        const tail = buffer.subarray(buffer.length - MAX_OUTPUT_BYTES).toString('utf8').replace(/^\uFFFD+/, '');
        text = `${head}\n… 省略中间输出 …\n${tail}`;
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
            '同名机器以优先级高者为准（IDE > 项目 > 全局），deployment 也按名字合并。' +
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
    const hostsError = toolset.hostsError?.();
    if (hostsError) {
        lines.push('⚠ hosts.json 有内容读不出来（这一层被跳过）：');
        lines.push(hostsError);
        lines.push('修好 JSON 后下一次工具调用会自动重新读取；不要直接覆盖，先备份。');
        lines.push('');
    }
    // hosts.json → IDE 的自动对账失败过：这不是 IDE 的问题，是那份文件本身没通过校验
    // （最常见的是项目级 localPath 写成了绝对路径）。不摆出来，用户只会看到“IDE 里一条
    // deployment 都没有”，永远找不到源头。
    const reconcileFailure = toolset.reconcileFailure?.();
    if (reconcileFailure) {
        lines.push('⚠ 上次把 hosts.json 的 deployment 对账到 IDE 时失败：');
        lines.push(reconcileFailure);
        lines.push('修好 `.opencode/remote-shell/hosts.json` 后执行 /remote-config-sync 重新推送。');
        lines.push('');
    }
    if (servers.length === 0) {
        lines.push('当前没有可用的远程服务器。在 IDE 的 SSH Configurations 里添加服务器，或配置 hosts.json。');
        return lines.join('\n');
    }
    const conflicts = deploymentConflicts(servers);
    if (conflicts.length > 0) {
        lines.push('⚠ deployment 名重复（必须全局唯一，否则无法确定同步哪一条）：');
        for (const conflict of conflicts) {
            lines.push(`  - ${conflict.name}：${conflict.servers.join('、')}`);
        }
        lines.push('');
    }
    const pushStatus = toolset.deploymentPush?.() ?? new Map();
    for (const entry of servers) {
        const source = entry.source === 'ide' ? 'IDE' : entry.source === 'project' ? '项目' : '全局';
        // 认证方式也报出来：OPEN_SSH 走 agent，不需要密码；KEY_PAIR 看私钥。
        const auth = entry.authType ? `  ${entry.authType}` : '';
        const label = entry.alias ? `${entry.name} (${entry.alias})` : entry.name;
        lines.push(`- ${label}  ${entry.host}:${entry.port}  ${entry.username}  [${source}]${auth}`);
        for (const deployment of entry.deployments ?? []) {
            const pushed = pushStatus.get(deployment.name);
            // 全局 deployment 只参与本机执行，不会推到 IDE；明确标出来，别让它看起来像漏推。
            const suffix = pushed
                ? `  [${pushed}]`
                : deployment.source === 'global'
                    ? '  [全局，不推 IDE]'
                    : deployment.source === 'project'
                        ? '  [待对账]'
                        : '';
            try {
                assertDeploymentLocalPath(deploymentSource(entry, deployment), deployment);
                lines.push(`    ${deployment.name}  ${deployment.localPath} ↔ ${deployment.deployPath}${suffix}`);
            } catch (error) {
                lines.push(`    ⚠ ${error.message}${suffix}`);
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
                case 'deployment-conflict':
                    return {
                        content:
                            `deployment "${name}" 在多个 server 上重名：${outcome.servers.join('、')}。` +
                            `名字必须全局唯一，先改名再同步。`,
                    };
                case 'source-missing':
                    return {
                        content: outcome.side === 'local'
                            ? `本地目录不存在：${outcome.path}\n（未做任何修改；检查 hosts.json 的 localPath）`
                            : `远端目录不存在：${outcome.path}\n（未做任何修改；检查 hosts.json 的 deployPath、挂载或服务器）`,
                    };
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
