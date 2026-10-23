// opencode-idea — OpenCode plugin entry.
//
// 一个 OpenCode 会话（root 项目）可以接入**多个** JetBrains 项目：root 本身，加上
// root 下任意层级的子目录。每个项目可以被不同的 IDE 打开（root 用 IDEA、modelserver
// 用 PyCharm 是常态），所以每个项目注册一个独立的 MCP server，名字 = 工具前缀：
//
//   * root   → `ide`        与 IDE 产品无关,root 用谁打开都叫它
//   * 子项目  → 目录名        `modelserver` → `modelserver_*`
//
// 数据模型与校验在 `ide-projects.js`；这里只做编排：探测、注册、提示词、命令、工具。
//
// For a root project the user opted in, this plugin:
//   1. registers one IDE MCP server per project (see `activate`), each scoped to
//      its own project through the `IJ_MCP_SERVER_PROJECT_PATH` header; injects
//      per-project direct-call guidance; and hides the IDE tools that must not
//      reach the model (for every prefix);
//   2. registers `/open-in-ide` (接入 root 与其全部子项目), `/delete-in-ide`
//      (删掉整个配置) and `/add-sub-module-in-ide <路径>` (登记一个子项目),
//      plus the `configure_ide_project` tool the MODEL calls to write the IDE a
//      user picked into the config;
//   3. registers the shipped skills (`skills/<id>/SKILL.md`) — marked projects
//      only, and each one also gated on the IDE tools it drives.
//
// A root that was never configured is left untouched. Everything is manual:
// setup does NOT probe or connect any IDE. The commands probe, open the IDE, and
// load the MCP servers + guidance on demand.
//
// `/open-in-ide` opens each configured project in ITS OWN IDE, waits until its
// MCP endpoint is ready, registers it under its prefix, and keeps the config in
// `ctx.storage`. A live endpoint alone does NOT mean our project is open there
// (the running IDE may have a different project open), so the open flow asks the
// IDE directly — one project-scoped MCP call — and runs `open -a` only when the
// project is not open yet.
//
// Recovery is request-driven: there is NO background polling. The config gates it,
// and it fires from three places, each observing a real fact:
//   * the `prompt` hook, when the project is configured but this plugin instance
//     has no IDE server at all. That is exactly what a fresh instance looks like
//     after OpenCode evicted the project's Location services (the Location's
//     LayerMap uses `idleTimeToLive: "60 minutes"`) or after the process
//     restarted — setup deliberately does not connect, so without this the
//     session would stay tool-less until the user ran `/open-in-ide` by hand.
//     `prompt` is awaited before the request is built, so the message that
//     triggers it already carries the tools;
//   * the `context` hook, when a request that HAD IDE tools no longer does;
//   * the `execute.after` hook, when an IDE tool call fails in a way that means
//     the IDE MCP is not usable (the server dropped, or the project is not open
//     in the IDE). A plain business error is classified apart and left alone.
//
// `Plugin.define` from `@opencode/plugin` is an identity function, so a plain
// `{ id, setup }` object is the whole plugin contract. Exporting it directly
// keeps this package dependency-free at runtime.

import {existsSync} from 'node:fs';
import {resolve} from 'node:path';

import {callTool, serverConfig} from './mcp/idea.js';
import {applyIdeToolDefaults, hideForcedArguments, raiseMinimumArguments} from './mcp/idea-tool-defaults.js';
import {appendDirectoryTreeTruncationNotice} from './mcp/idea-tool-output.js';
import {currentProjectPath} from './project.js';
import {
    appNameFor,
    autoLaunchSupported,
    createLaunchGuard,
    detectInstalledIdes,
    openInIde,
} from './ide-launcher.js';
import {
    appendIdeGuidance,
    appendIdeRecoveryGuidance,
} from './ide-guidance.js';
import {
    IDE_LABELS,
    IDE_PORTS,
    SUPPORTED_IDES,
    listProjects,
    markKeyFor,
    parseIdeArgument,
    parseMark,
    parseSubprojectArgument,
    serializeMark,
    toolPrefixes,
    validateSubproject,
    withSubproject,
} from './ide-projects.js';
import {readSkills} from './skill/loader.js';

const DEFAULT_LAUNCH_COOLDOWN_MS = 120000;
const DEFAULT_LAUNCH_MAX_ATTEMPTS = 5;
// 单次「这个 IDE 里打开着这个项目吗」探测的超时。它比单纯的端口存活探测重（IDE 要
// 先解析出目标项目），给 1s 的话 IDE 忙（索引中）时会被误判成"不认得",进而触发一次多余
// 的 `open -a`;给太长又会让用户等。5s 是这两者之间的取舍。注意 IDE 没开时 connect 会
// 立刻失败,根本走不到这个上限。
const DEFAULT_MCP_PROBE_TIMEOUT_MS = 5000;
// A cold IDE can take tens of seconds before its bundled MCP server listens.
// After `open -a`, poll for the endpoint instead of reporting failure once.
const DEFAULT_MCP_START_TIMEOUT_MS = 60000;
const MCP_START_POLL_MS = 1000;
const DEFAULT_TOOL_REFRESH_TIMEOUT_MS = 5000;
// 等工具目录落地时的轮询间隔。这是一次**有界等待**(见 waitForIdeaTools),不是
// 状态轮询:100ms 足够快,又不会在 5s 上限内空转几十次。
const TOOL_REFRESH_POLL_MS = 100;
// Hard cap on ONE IDE MCP tool call. OpenCode's own default is 12 hours, and a
// wedged IDE MCP server can accept a POST and never answer it — so a call made
// after the IDE died would otherwise sit unresolved for 12h. 10 minutes is far
// beyond any normal IDE tool and turns that hang into a normal error the failure
// classifier can act on.
const DEFAULT_EXECUTION_TIMEOUT_MS = 600000;

/**
 * 插件自己注册的工具名（不属于任何 IDE server）。
 *
 * 目前只有 `configure_ide_project`:模型把用户选定的 IDE 写回配置的通道，见
 * `configureIdeTool`。单独列出来是给前缀判断**排除**用的 —— 前缀由配置决定、
 * 动态可变（`ide_` / `<目录名>_`），万一某个目录名恰好拼出同名工具，它也不能被
 * 当成 IDE 工具隐藏掉或写进提示词。
 */
const PLUGIN_TOOL_NAMES = new Set(['configure_ide_project']);

/**
 * IDE MCP tools that must never reach the model, listed by **suffix**.
 *
 * 存后缀而不是完整工具名:每个项目注册一个 server,同一个工具会以 `ide_git_status` /
 * `modelserver_git_status` 等多份出现,写死任何一个前缀都只能清掉一个项目。展开由
 * `removeIdeToolDefinitions` 按当前前缀集合完成。
 *
 * Grouped by the IDE's Exposed Tools page so the list stays auditable. Anything
 * listed here is stripped from every model request, even while the IDE is up.
 *
 * - VCS: `git_status` returns porcelain codes only and `get_repositories` is
 *   covered by the native git tool, which also handles diff/log/blame.
 * - Router: `execute_tool` is the IDE's router-mode dispatcher. Router-only
 *   mode is off, so every routed tool is exposed directly with its full schema
 *   and this dispatcher is redundant. Revisit if router-only mode is enabled.
 * - Debugger (`xdebug_*`): the Debugger MCP toolset. Rarely needed, and a real
 *   debug session is driven from the IDE window anyway.
 * - Dev Kit MCP: IntelliJ Platform plugin-development tools (Split Mode module
 *   kinds, the New IntelliJ Module scaffold, Read/Write lock and EDT threading
 *   analysis). Useless outside IntelliJ Platform plugin work.
 * - Inspection KTS MCP: inspection.kts authoring helpers (PSI tree, API docs,
 *   examples, run). Also IntelliJ Platform plugin-development only.
 * - Python Environment MCP: Python interpreter detection and configuration.
 *   Hidden; a project's interpreter is chosen in the IDE's own settings, and the
 *   model has no business reconfiguring it.
 * - Database: the connection tools (`create` / `edit`) stay hidden because the
 *   user configures data sources in the IDE. The query tools are hidden too —
 *   the IDE is not this plugin's idea of a database client, and a model that
 *   wants to inspect a database should be told to use a real one.
 * - Plain file **search**: `search_text` / `search_regex` / `search_file` each
 *   have a native tool that does the job (`grep` / `grep -E` / `glob`);
 *   routing them through the IDE only adds a hop. `read_file` is NOT hidden —
 *   it is the only way to read a file inside a jar (`<jar>!/<entry>`) or the
 *   JDK's `jrt://` image, so the guidance keeps it for exactly that and sends
 *   ordinary reads to the native tool.
 * - Plain file **write**: `create_new_file` is **hidden** — the native `write`
 *   does the same job without the extra hop. `apply_patch` is **kept**, and the
 *   reason it used to be hidden turned out to be wrong.
 *   It was hidden because "the IDE's patch tool is brittle in a way that costs
 *   real time — it matches hunks by exact context text, so a quote or a corner
 *   bracket normalised somewhere on the way in fails the whole hunk
 *   (`Hunk context not found`)". Measured against a real IDE (2026.2.3), that
 *   brittleness is **contained, not destructive**: a hunk that does not match
 *   fails on its own and leaves the file untouched, and the tool names the file
 *   it failed on ("scratch/a.ts: Hunk context not found"). It is not a reason
 *   to hide the tool.
 *   What made it worth keeping is what it does that nothing else here does:
 *   **one call patches many files** (Codex `*** Update File:` sections or a
 *   unified git diff, both verified). The native `edit` / `write` are
 *   single-file. OpenCode has a multi-file `patch` of its own — a DIFFERENT
 *   tool, with a different parameter and a different patch dialect, and it is
 *   only exposed to GPT models — so on any other model there is nothing for a
 *   "same change across a dozen files" job. Measured, the model answered that
 *   gap by writing a Python script that rewrites whole files: slower, and it
 *   silently reformats the parts it was not asked to touch. `apply_patch`
 *   touches only the lines it declares, reports how many hunks applied, and
 *   names the ones that did not.
 *   The guidance never mentions the native `patch`: most models do not have it
 *   in their tool list, and naming a tool that is not there only makes the
 *   model look for it (or mix the two parameter names up).
 *   `rename_refactoring` and `reformat_file` stay: both are capabilities the
 *   native tools do not have.
 * - IDE terminal: `execute_terminal_command` does NOT inherit the project's
 *   environment. It was exposed on the assumption that it ran with the SDKs the
 *   user configured in the IDE (JDK, Node, Python, ...), but measured against a
 *   real IDE it brings no environment a native `shell` call does not already
 *   have — so it is a strictly worse shell, and hiding it removes an entire
 *   class of "why is it using an old JDK" confusion. Which tool to use instead
 *   is a routing decision, and it is made in `ide-guidance.js`: commands that
 *   need the project's environment go through a RUN CONFIGURATION (the IDE
 *   launches those with exactly the configured SDK), everything else goes
 *   through the native shell.
 */
export const HIDDEN_IDE_TOOL_SUFFIXES = [
    // VCS
    'git_status',
    'get_repositories',
    // Router
    'execute_tool',
    // IDE terminal: no advantage over the native shell (see the note above).
    'execute_terminal_command',
    // Debugger
    'xdebug_control_session',
    'xdebug_evaluate_expression',
    'xdebug_get_debugger_status',
    'xdebug_get_frame_values',
    'xdebug_get_stack',
    'xdebug_get_threads',
    'xdebug_get_value_by_path',
    'xdebug_list_breakpoints',
    'xdebug_remove_breakpoint',
    'xdebug_run_to_line',
    'xdebug_set_breakpoint',
    'xdebug_set_variable',
    'xdebug_start_debugger_session',
    // Dev Kit MCP
    'collect_split_mode_compatibility_issues',
    'create_ij_module',
    'find_lock_requirements_usages',
    'find_threading_requirements_usages',
    'recognize_ij_module_kind',
    'recognize_split_mode_api_kind',
    // Inspection KTS MCP
    'generate_inspection_kts_api',
    'generate_inspection_kts_examples',
    'generate_psi_tree',
    'run_inspection_kts',
    // Python Environment MCP
    'configure_python_interpreter',
    'get_python_environment',
    // Database: connections are the user's, and the IDE is not this plugin's
    // database client.
    'create_database_connection',
    'edit_database_connection',
    'list_database_connections',
    'test_database_connection',
    'list_database_schemas',
    'list_schema_object_kinds',
    'list_schema_objects',
    'introspect_schema',
    'get_database_object_description',
    'execute_sql_query',
    'fetch_query_result',
    'preview_table_data',
    'list_recent_sql_queries',
    'cancel_sql_query',
    // Plain file SEARCH with a native equivalent (`read_file` stays: only it can
    // read inside a jar or the jrt:// image). Plain file WRITE stays visible on
    // purpose — see the note above: writing through the IDE is what keeps the
    // IDE's in-memory copy and the file on disk the same thing.
    'search_text',
    'search_regex',
    'search_file',
    // File WRITE: `create_new_file` is dropped (the native `write` covers it),
    // but `apply_patch` STAYS — it is the only multi-file writer on models that
    // do not get OpenCode's own `patch` tool (a DIFFERENT tool, GPT-only).
    // `edit_file` is the companion plugin's own writer, dropped by the plugin
    // itself — hiding it only covers the older installed copies.
    'create_new_file',
    'edit_file',
];

/**
 * Remove the hidden IDE tools from one request's tool record, for every prefix.
 *
 * 入参是**后缀**列表,这里按当前前缀集合展开成完整工具名 —— 每个项目一份都要删,
 * 否则子项目那几份会原样送到模型面前。
 *
 * @param {Record<string, unknown> | undefined} tools
 * @param {readonly string[]} suffixes
 * @param {readonly string[]} prefixes 当前所有项目的工具前缀（含下划线）。
 */
function removeIdeToolDefinitions(tools, suffixes, prefixes) {
    if (!tools || typeof tools !== 'object') return 0;
    let removed = 0;
    for (const prefix of prefixes) {
        for (const suffix of suffixes) {
            const name = `${prefix}${suffix}`;
            if (!(name in tools)) continue;
            delete tools[name];
            removed += 1;
        }
    }
    return removed;
}

/** @param {ReadonlyArray<{ id?: string }> | undefined} tools */
function toolIds(tools) {
    return (tools ?? []).map((tool) => tool.id).filter((id) => typeof id === 'string').sort();
}

/**
 * Classify an IDE tool failure for the reconnect decision.
 *
 * It must never mistake a plain business error (a bad path, a missing file) for
 * a broken connection, so only two shapes trigger action:
 *
 * - `project`: the IDE is up but the requested project is not open in it, e.g.
 *   "`projectPath`=... doesn't correspond to any open project." Re-opening the
 *   project fixes it.
 * - `mcp`: the IDE MCP server itself is gone — the endpoint stopped answering,
 *   the transport closed, or the connection was refused. See the marker list in
 *   the body; it includes the connect failure OpenCode's own MCP client emits
 *   (`Unable to connect…`, and the structural `code: "ConnectionRefused"`).
 *
 * Everything else is `none`.
 *
 * @param {{ message?: unknown } | undefined} error
 * @param {readonly string[]} serverNames 当前注册的 server 名（`ide` 与各子项目前缀）。
 * @returns {'project' | 'mcp' | 'none'}
 */
function classifyIdeFailure(error, serverNames) {
    const message = typeof error?.message === 'string' ? error.message : '';
    // "Project not open in the IDE" comes in two shapes, both meaning the same
    // thing and both fixed by opening the project again:
    //   - the server could not pick a project for the call: "Unable to determine
    //     the target project for the current MCP tool call." (the project path in
    //     the request header did not resolve — the IDE may still be opening it)
    //   - the project was resolved but is not open: "`projectPath`=...
    //     doesn't correspond to any open project."
    if (
        message.includes('Unable to determine the target project') ||
        message.includes('correspond to any open project')
    ) {
        return 'project';
    }
    // Only transport-level markers, which OpenCode's own MCP client emits. The
    // message of an MCP *tool error* is the tool's own content (`tool/mcp.ts`
    // turns `result.isError` into `ToolFailure({ message: <text> })`), so a
    // generic string such as "Connection refused" from a SQL or run-config tool
    // would otherwise be misread as a dropped connection and rebuild a healthy
    // server.
    //
    // MEASURED (2026-09-30, OpenCode 2.0.19, IDE process killed): a dead remote
    // MCP endpoint does NOT produce any of the shapes above. OpenCode's client
    // reports its own connect failure instead:
    //
    //   level=WARN message="mcp http request failed"
    //     errors="[{\"type\":\"TypeError\",
    //               \"message\":\"Unable to connect. Is the computer able to access the url?\",
    //               \"code\":\"ConnectionRefused\",\"errno\":0}]"
    //
    // so the text is matched on its stable prefix, and the underlying `code` is
    // accepted as a structural signal too (a wording change must not silently
    // disable the heal).
    //
    // serverNames 是当前注册的全部 server 名（`ide` / 各子项目前缀）：错误里点名的是
    // 哪一个 server，取决于失败的是哪个项目的工具，所以只能逐个匹配。
    if (
        serverNames.some((name) => message.includes(`MCP server "${name}" is not available`)) ||
        message.includes('MCP server is not connected') ||
        message.includes('Error POSTing to endpoint') ||
        message.includes('Unable to connect')
    ) {
        return 'mcp';
    }
    const causeCode = error?.error?.code ?? error?.cause?.code ?? error?.code;
    if (causeCode === 'ConnectionRefused' || causeCode === 'ECONNREFUSED') return 'mcp';
    return 'none';
}

/**
 * Replace a tool error's message, so the model sees the replacement. OpenCode
 * returns `event.error` after the `execute.after` hook resolves, so rewriting it
 * is how the plugin steers the model after an automatic reconnect.
 *
 * The error is a `Tool.Error` instance (`ToolFailure` extends it). It is rebuilt
 * through its own constructor — no runtime dependency on `@opencode/ai` — with a
 * direct field mutation as a fallback.
 *
 * @param {{ error?: unknown }} event
 * @param {string} message
 * @returns {boolean}
 */
function rewriteToolError(event, message) {
    const current = event?.error;
    if (!current || typeof current !== 'object') return false;
    try {
        const Ctor = current.constructor;
        if (typeof Ctor === 'function') {
            const next = {message};
            if (current.error !== undefined) next.error = current.error;
            if (current.metadata !== undefined) next.metadata = current.metadata;
            event.error = new Ctor(next);
            return true;
        }
    } catch {
        // fall through to mutation
    }
    try {
        current.message = message;
        return true;
    } catch {
        return false;
    }
}

/**
 * @typedef {{
 *   status:
 *     | 'connected'
 *     | 'tools-loading'
 *     | 'mcp-unavailable'
 *     | 'launch-failed'
 *     | 'disabled'
 *     | 'manual-launch'
 *     | 'deleted'
 *     | 'bad-argument'
 *     | 'not-configured'
 *     | 'invalid-subproject'
 *     | 'needs-ide',
 *   // `manual-launch` = this platform has no launcher at all (the user must
 *   // open the IDE by hand); `disabled` = the user turned launching off. Both
 *   // mean "no app to open", so only `autoLaunchSupported()` tells them apart.
 *   port?: number,
 *   opened?: boolean,
 *   unavailableNoticeSent?: boolean,
 *   project?: { label?: string, app?: string, isRoot?: boolean },
 *   projects?: ReadonlyArray<{ label?: string, app?: string }>,
 *   message?: string
 * }} IdeCommandResult
 */

/**
 * @param {unknown} value
 * @param {number} fallback
 */
const asPositiveNumber = (value, fallback) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

/** 面向用户的状态文案（三个命令与 `configure_ide_project` 共用）。 */
/** @param {IdeCommandResult} result */
export function ideFeedback(result) {
    const appOf = (project) => IDE_LABELS[project?.app] ?? 'IDE';
    const nameOf = (project) =>
        project?.isRoot === false ? `${appOf(project)}(子项目 ${project.label ?? ''})` : appOf(project);
    switch (result?.status) {
        case 'connected': {
            const list = (result.projects ?? []).map((project) => `${project.label}(${appOf(project)})`).join('、');
            return list ? `IDE MCP 已连接并接入:${list}。` : 'IDE MCP 已连接。';
        }
        case 'tools-loading':
            return 'IDE MCP 已连接,但原生 IDE 工具列表尚未完成注册。请稍后再次执行 /open-in-ide。';
        case 'mcp-unavailable': {
            const where = nameOf(result?.project);
            const ide = appOf(result?.project);
            return result?.opened
                ? `已请求打开/激活 ${where} 并等待 MCP 服务启动,但未检测到 MCP 服务。请在 ${ide} 中开启 MCP 服务(Settings → MCP Server,需 2026.2+)并启用 Brave Mode,然后再次执行 /open-in-ide。`
                : `未检测到 ${where} 的 MCP 服务。请确认已打开,在 Settings → MCP Server 开启 MCP 服务并启用 Brave Mode,然后再次执行 /open-in-ide。`;
        }
        case 'launch-failed':
            return `无法拉起 ${nameOf(result?.project)}(未找到应用或启动失败)。请确认它已安装 —— 没装的话先装上,再重试 /open-in-ide。`;
        case 'disabled':
            return '插件已通过 openInIde: false 关闭 IDE 启动。请手动打开 IDE,在 Settings → MCP Server 开启 MCP 服务并启用 Brave Mode,然后重试 /open-in-ide。';
        case 'manual-launch':
            return '当前系统不支持自动打开 IDE(仅 macOS 实现了启动)。请手动打开 IDE,在 Settings → MCP Server 开启 MCP 服务并启用 Brave Mode,然后再次执行 /open-in-ide。';
        case 'deleted':
            return '已删除本项目的 IDE 配置:已注销全部 IDE MCP 并清除配置。如需重新接入,请执行 /open-in-ide。';
        case 'bad-argument':
            return `命令参数有误:${result?.message ?? ''}`;
        case 'not-configured':
            return '当前项目还没有 IDE 配置。请先执行 /open-in-ide 接入根项目,再登记子项目。';
        case 'invalid-subproject':
            return `无法登记子项目:${result?.message ?? ''}`;
        case 'needs-ide':
            return '需要确定用哪个 IDE 打开。请回答 AI 的提问(IntelliJ IDEA 或 PyCharm),AI 会把选择写入配置。';
        default:
            return '已处理。';
    }
}

/**
 * The text the MODEL sees for `/open-in-ide` feedback. It is explicitly a
 * notification, not a task: the model must only acknowledge it. The user sees
 * the clean notice instead, via `metadata.displayText`.
 */
/** Marks the plugin's own session notices, so recovery never reacts to them. */
export const NOTICE_PREFIX = '【插件通知】';

export function idePromptText(result) {
    return [`${NOTICE_PREFIX}${ideFeedback(result)}`, '这是发给用户的通知,你无需处理。请只回复"收到"。'].join('\n\n');
}

/** `metadata` so the UI shows the clean notice while the model sees the instruction. */
export function idePromptMetadata(result) {
    return {displayText: ideFeedback(result), comments: []};
}

export default {
    id: 'opencode-idea',

    /**
     * @param {{
     *   location?: unknown,
     *   options?: {
     *     openInIde?: boolean,
     *     launchCooldownMs?: number,
     *     launchMaxAttempts?: number,
     *     injectGuidance?: boolean,
     *     mcpProbeTimeoutMs?: number,
     *     mcpStartTimeoutMs?: number,
     *     toolRefreshTimeoutMs?: number,
     *     executionTimeoutMs?: number,
     *     feedback?: false | 'message',
     *   },
     *   command?: {
     *     transform: (cb: (editor: { add: (definition: {
     *       name: string,
     *       description?: string,
     *       execute: (input: { sessionID: string, prompt: { text: string }, delivery: unknown }) => Promise<void>,
     *     }) => void }) => void) => Promise<{ dispose: () => Promise<void> | void }>,
     *   },
     *   skill?: {
     *     transform: (cb: (editor: { add: (definition: {
     *       id: string,
     *       name: string,
     *       description?: string,
     *       autoinvoke?: boolean,
     *       path: string,
     *       content: string,
     *     }) => void }) => void) => Promise<{ dispose: () => Promise<void> | void }>,
     *   },
     *   session?: {
     *     prompt: (input: { sessionID: string, text: string, delivery: unknown }) => Promise<unknown>,
     *     hook: (name: string, cb: (event: {
     *       sessionID?: string,
     *       agent?: string,
     *       system?: unknown[],
     *       tools?: Record<string, unknown>,
     *     }) => void | Promise<void>) => Promise<{ dispose: () => Promise<void> | void }>,
     *   },
     *   tool?: {
     *     list?: () => Promise<ReadonlyArray<{ id?: string }>>,
     *     reload?: () => Promise<void>,
     *     transform?: (cb: (editor: {
     *       list: () => ReadonlyArray<{ id?: string, input?: unknown }>,
     *       get: (id: string) => ({ id?: string, input?: unknown } | undefined),
     *       add: (definition: unknown) => void,
     *       update: (id: string, update: (tool: { input?: unknown, description?: string }) => void) => void,
     *       remove: (id: string) => void,
     *     }) => void) => Promise<{ dispose: () => Promise<void> | void }>,
     *     hook?: (name: string, cb: (event: {
     *       tool?: string,
     *       sessionID?: string,
     *       input?: Record<string, unknown>,
     *       status?: string,
     *       result?: unknown,
     *       error?: unknown,
     *     }) => void | Promise<void>) => Promise<{ dispose: () => Promise<void> | void }>,
     *   },
     *   mcp: {
     *     transform: (cb: (editor: { set: (name: string, config: unknown) => void }) => void) => Promise<{ dispose: () => Promise<void> | void }>,
     *     reload?: () => Promise<void>,
     *     list?: () => Promise<{ data?: ReadonlyArray<{ name?: string, status?: { status?: string } }> }>,
     *   },
     *   shell: { hook: (name: string, cb: (input: { env: Record<string, string | undefined> }) => void) => Promise<{ dispose: () => Promise<void> | void }> },
     *   storage?: {
     *     get: (key: string) => Promise<unknown>,
     *     set: (key: string, value: unknown) => Promise<void>,
     *     remove: (key: string) => Promise<void>,
     *   },
     * }} ctx
     */
    async setup(ctx) {
        const projectPath = currentProjectPath(ctx.location);
        if (!projectPath) return;

        const options = ctx.options || {};
        const injectGuidance = options.injectGuidance !== false;
        // 自动拉起 IDE 的总开关。用哪个 IDE 由**每个项目自己的配置**决定
        // （`project.app`），这个选项不再指定应用名，只决定"允不允许拉起"。
        const launchEnabled = options.openInIde !== false;
        const mcpProbeTimeoutMs = asPositiveNumber(options.mcpProbeTimeoutMs, DEFAULT_MCP_PROBE_TIMEOUT_MS);
        const mcpStartTimeoutMs = asPositiveNumber(options.mcpStartTimeoutMs, DEFAULT_MCP_START_TIMEOUT_MS);
        const toolRefreshTimeoutMs = asPositiveNumber(options.toolRefreshTimeoutMs, DEFAULT_TOOL_REFRESH_TIMEOUT_MS);
        // Cap on a single IDE tool call, so a wedged server fails in finite time
        // instead of OpenCode's 12h default. See DEFAULT_EXECUTION_TIMEOUT_MS.
        const executionTimeoutMs = asPositiveNumber(options.executionTimeoutMs, DEFAULT_EXECUTION_TIMEOUT_MS);
        // "message" (default) injects a clearly-labelled notification that the
        // model only acknowledges ("收到"); the user sees the clean notice via
        // metadata.displayText. false is silent.
        const feedback = options.feedback === false ? false : 'message';
        const launchCooldownMs = asPositiveNumber(options.launchCooldownMs, DEFAULT_LAUNCH_COOLDOWN_MS);
        const launchMaxAttempts = asPositiveNumber(options.launchMaxAttempts, DEFAULT_LAUNCH_MAX_ATTEMPTS);

        /** @type {Array<{ dispose: () => Promise<void> | void }>} */
        let registrations = [];
        /** @type {{ dispose: () => Promise<void> | void } | undefined} */
        let sessionRegistration;
        /** @type {{ dispose: () => Promise<void> | void } | undefined} */
        let toolRegistration;
        let toolBeforeRegistration;
        let toolTransformRegistration;
        /** `configure_ide_project` 的注册。 */
        let configToolRegistration;
        /** @type {{ dispose: () => Promise<void> | void } | undefined} */
        let promptRegistration;
        /** @type {{ dispose: () => Promise<void> | void } | undefined} */
        let commandRegistration;
        /** @type {{ dispose: () => Promise<void> | void } | undefined} */
        let skillRegistration;
        let disposed = false;

        // Latches when a request showed the IDE tools are gone. It is cleared
        // only by a successful rebuild. It is set from the `context` hook (a request
        // that HAD the tools no longer does); the `prompt` hook also heals without
        // this latch when the instance has no registration at all.
        let needsRebuild = false;
        // Set once a request in this session actually carried IDE tools, so a
        // later request without them is a DROP of this session's own connection —
        // not a root that simply never connected.
        let wasServing = false;

        // 本会话的 IDE 配置：root 用哪个 IDE，以及登记了哪些子项目、各自用哪个 IDE。
        // 一个插件实例服务一个 root（OpenCode 按 Location 激活插件），所以这就是全部
        // 状态。持久化在 `ctx.storage` 的 `project/<rootPath>` 下。
        //
        // `undefined` = 还没读过；`null` = 读过、但没有配置。两者必须分开：混成一种，
        // 请求钩子就会把"还没读"当成"未配置"，漏掉一次本该发生的自愈。
        const storage = ctx.storage;
        const markKey = markKeyFor(projectPath);
        /** @type {import('./ide-projects.js').IdeConfig | null | undefined} */
        let config;

        /** 读一次持久化配置（最多一次 I/O），之后走内存缓存。 */
        const readConfig = async () => {
            if (config !== undefined) return config;
            if (!storage || typeof storage.get !== 'function') {
                config = null;
                return config;
            }
            try {
                config = parseMark(await storage.get(markKey), projectPath) ?? null;
            } catch {
                // storage is best effort;读不到就当作未配置
                config = null;
            }
            return config;
        };

        /**
         * 写入配置（`null` = 删除），并同步内存缓存。
         *
         * 先写 storage 再更新缓存（write-through）：写失败也要更新缓存，否则用户刚做的
         * 配置在本进程里不可见，行为会自相矛盾。命令与 `configure_ide_project` 是唯一的
         * 写入者。
         *
         * @param {import('./ide-projects.js').IdeConfig | null} next
         */
        const writeConfig = async (next) => {
            try {
                if (next) await storage?.set?.(markKey, serializeMark(next));
                else await storage?.remove?.(markKey);
            } catch {
                // best effort
            }
            config = next;
        };

        /** 当前接入的全部项目（root 在前），每个带工具前缀与展示标签。 */
        const currentProjects = () =>
            config
                ? listProjects(config).map((project) => ({
                    ...project,
                    label: project.isRoot ? '.' : project.path.slice(projectPath.length + 1),
                }))
                : [];

        /** 当前所有项目的工具前缀（含下划线）；未配置时为空。 */
        const prefixes = () => (config ? toolPrefixes(config) : []);

        /** 当前注册的全部 server 名（= 前缀去掉下划线）。 */
        const serverNames = () => (config ? listProjects(config).map((project) => project.server) : []);

        /** 这个工具名是否属于某个 IDE server（插件自己的工具不算）。 */
        const isIdeToolName = (name) => {
            if (PLUGIN_TOOL_NAMES.has(name)) return false;
            return prefixes().some((prefix) => name.startsWith(prefix));
        };

        /**
         * 这个 IDE 工具属于哪个项目？
         *
         * 按**最长前缀**匹配：`modelserver_` 必须先于 `model_` 命中，否则一个叫 `model`
         * 的项目会把 `modelserver_*` 的工具认领走。
         *
         * @param {string} name
         */
        const projectForTool = (name) =>
            currentProjects()
                .filter((project) => name.startsWith(`${project.server}_`))
                .sort((a, b) => b.server.length - a.server.length)[0];

        // 先解析一次，请求钩子之后就能同步读到。
        await readConfig();

        /** 注销当前注册的全部 IDE server。 */
        const deactivateIde = async () => {
            const current = registrations.slice();
            registrations.length = 0;
            if (current.length === 0) return;
            for (const registration of current) {
                try {
                    await registration.dispose();
                } catch {
                    // best effort
                }
            }
        };

        const waitForIdeTools = async () => {
            if (typeof ctx.tool?.list !== 'function') return false;
            const deadline = Date.now() + toolRefreshTimeoutMs;
            while (Date.now() < deadline) {
                try {
                    const ids = toolIds(await ctx.tool.list());
                    if (ids.some((id) => isIdeToolName(id))) return true;
                } catch {
                    // The MCP catalog may still be settling; retry within the bounded wait.
                }
                await new Promise((resolve) => setTimeout(resolve, TOOL_REFRESH_POLL_MS));
            }
            return false;
        };

        /**
         * 一个项目的 MCP 端口,由它的 IDE 唯一决定(`IDE_PORTS`,固定值)。
         *
         * @param {{ path: string, app: string }} project
         * @returns {number | undefined}
         */
        const portFor = (project) => IDE_PORTS[project.app];

        const refreshIdeTools = async () => {
            if (typeof ctx.mcp.reload === 'function') await ctx.mcp.reload();
            // Reconcile the MCP servers above, then replay the tool registry so the
            // refreshed catalog lands in the next model request's tool snapshot.
            // Without this, a session that already captured a snapshot keeps the old
            // tool list until the session is reopened.
            if (typeof ctx.tool?.reload === 'function') await ctx.tool.reload();
            return await waitForIdeTools();
        };

        /**
         * 按配置给**每个**已打开的项目各注册一个 MCP server。
         *
         * server 名就是项目的工具前缀（root = `ide`，子项目 = 目录名），所以 `editor.set`
         * 的 key 与 `serverConfig` 里带的项目路径必须成对出现 —— 一个 server 只服务一个
         * 项目（路径走 header，注册后无法逐次改写）。
         *
         * @param {ReadonlyArray<{ project: { path: string, server: string }, port: number }>} bindings
         */
        const activateIde = async (bindings) => {
            const mcpRegistration = await ctx.mcp.transform((editor) => {
                for (const binding of bindings) {
                    editor.set(
                        binding.project.server,
                        serverConfig(binding.port, binding.project.path, {executionTimeoutMs}),
                    );
                }
            });
            registrations = [mcpRegistration];
            return refreshIdeTools();
        };

        const reconcileOnce = async ({probeIde = true} = {}) => {
            if (disposed) return false;

            // 未配置：没有任何项目要接入。
            if (!config) {
                await deactivateIde();
                return false;
            }
            // Manual: only the commands probe the IDE. Setup calls this with
            // `probeIde: false` so it never connects until a command asks.
            if (!probeIde) {
                await deactivateIde();
                return false;
            }

            const bindings = [];
            for (const project of currentProjects()) {
                const port = await portForProject(project);
                if (port !== undefined) bindings.push({project, port});
            }

            // Always tear the servers down and register them again. OpenCode's reconcile
            // SKIPS a re-`set` whose config is unchanged, so re-registering without a
            // teardown would leave a dropped server in place forever. The commands and
            // the request hooks are rare; rebuilding costs one restart, which is the
            // right trade for never leaving a dead registration behind.
            await deactivateIde();
            if (bindings.length === 0) return false;
            return activateIde(bindings);
        };

        // Serialize reconciles so overlapping callers can never register/activate
        // the IDE concurrently (which would leak registrations).
        let reconcileChain = Promise.resolve();
        // Non-zero while a reconcile is queued or running.
        let reconcileBusy = 0;
        const enqueue = (task) => {
            reconcileBusy += 1;
            const next = reconcileChain.then(task);
            reconcileChain = next.then(
                () => {
                },
                () => {
                },
            );
            return next.finally(() => {
                reconcileBusy -= 1;
            });
        };
        const reconcile = (options) => enqueue(() => reconcileOnce(options));

        /**
         * Is `path` actually OPEN in the IDE that serves `port`?
         *
         * A live endpoint only means the IDE is RUNNING — it may have a different
         * project open (or sit on the Welcome screen), while everything we do is
         * scoped to THIS project. So ask the IDE directly with one project-scoped
         * call: the server resolves the project from `IJ_MCP_SERVER_PROJECT_PATH`
         * BEFORE running the tool, and for a project that is not open it fails with
         * "Unable to determine the target project ..." — the same shape
         * `classifyIdeFailure` maps to `project`. Any other outcome (a real result,
         * or an unrelated tool error) means the project WAS resolved, i.e. open.
         *
         * A transport failure (`undefined`) counts as "not confirmed open", so the
         * caller still asks the IDE to open the project: `open -a` is idempotent,
         * and the only cost is a redundant focus.
         *
         * 这个判定现在只回答一个问题:"这个 IDE 里打开着这个项目吗?" —— 端口本身由
         * `IDE_PORTS` 按 IDE 唯一确定,不再需要靠它去区分端口归属。
         *
         * ⚠️ 实测(2026-10-16,IntelliJ IDEA 2026.2 + PyCharm 2026.2):请求路径**落在某个已打开
         * 项目的目录树内**时,IDE 会把它解析到那个项目 —— `get_project_modules` 正常返回它的模块,
         * 而不是报错。只有路径完全不在任何已打开项目下(`/tmp`、不存在的路径)才报
         * "Unable to determine the target project"。
         *
         * 因此「子项目与 root 用同一个 IDE」时必须知道:只要那个 IDE 打开了 root,子项目就会被判成
         * "已打开" —— 它确实是 root 项目的一部分,工具能操作它的文件,只是语言支持按 **root 项目**
         * 走(Python 子项目被 root 的 Web 模块解析,符号/检查会不准)。这是 IDE 的目录包含语义,
         * 不是探测可以绕过的;要让子项目按自己的模块解析,得让它在那个 IDE 里**单独打开**一个项目
         * —— 或者(正常做法)给它配它真正被打开的那个 IDE。
         *
         * A transport failure (`undefined`) counts as "not confirmed open", so the
         * caller still asks the IDE to open the project: `open -a` is idempotent,
         * and the only cost is a redundant focus.
         *
         * @param {number} port
         * @param {string} path
         */
        const isProjectOpen = async (port, path) => {
            const result = await callTool(port, path, 'get_project_modules', {}, {
                timeoutMs: mcpProbeTimeoutMs,
            }).catch(() => undefined);
            if (!result) return false;
            if (result.isError !== true) return true;
            const text = (result.content ?? [])
                .filter((part) => part?.type === 'text' && typeof part.text === 'string')
                .map((part) => part.text)
                .join('\n');
            return classifyIdeFailure({message: text}, serverNames()) !== 'project';
        };

        /**
         * 这个项目的 IDE 端口上,服务着它吗？是就返回端口,否则 `undefined`。
         *
         * @param {{ path: string, app: string }} project
         */
        const portForProject = async (project) => {
            const port = portFor(project);
            if (port === undefined) return undefined;
            return (await isProjectOpen(port, project.path)) ? port : undefined;
        };

        /**
         * `open -a` only requests activation/opening. A cold IDE needs time before
         * its bundled MCP server listens, so poll until the endpoint appears AND
         * answers for THIS project. This is the step that makes a single
         * `/open-in-ide` enough on a cold start.
         *
         * @param {{ path: string, app: string }} project
         * @returns {Promise<number | undefined>}
         */
        const waitForProjectServer = async (project) => {
            const deadline = Date.now() + mcpStartTimeoutMs;
            while (Date.now() < deadline) {
                const port = await portForProject(project).catch(() => undefined);
                if (port !== undefined) return port;
                const remaining = deadline - Date.now();
                if (remaining <= 0) break;
                await new Promise((resolve) => setTimeout(resolve, Math.min(MCP_START_POLL_MS, remaining)));
            }
            return undefined;
        };

        /**
         * 每个项目各自的启动状态：in-flight、拉起冷却、是否已发过通知。
         *
         * 按项目分开是必需的：IDEA 与 PyCharm 是两个独立进程，一个的冷却不能拖住另一个；
         * 而同一个项目的重复调用仍然共享一次拉起（re-entrant）。
         */
        const launchStates = new Map();
        const launchStateFor = (path) => {
            let state = launchStates.get(path);
            if (!state) {
                state = {
                    /** @type {Promise<IdeCommandResult> | undefined} */
                    inFlight: undefined,
                    noticeSent: false,
                    guard: createLaunchGuard({cooldownMs: launchCooldownMs, maxAttempts: launchMaxAttempts}),
                };
                launchStates.set(path, state);
            }
            return state;
        };

        /**
         * 确保 `project` 的 IDE 正开着、并且打开着这个项目；返回它的端口。
         *
         * @param {{ path: string, server: string, app: string, label: string, isRoot: boolean }} project
         * @param {{ onUnavailable?: (result: IdeCommandResult) => Promise<boolean> }} [options]
         * @returns {Promise<IdeCommandResult>}
         */
        const ensureProject = (project, {onUnavailable} = {}) => {
            const state = launchStateFor(project.path);
            if (state.inFlight) return state.inFlight;
            const reportUnavailable = async (opened) => {
                if (state.noticeSent || typeof onUnavailable !== 'function') return;
                // Fast-fail: notify as soon as the endpoint is known to be missing so
                // the user can enable MCP + Brave Mode and retry the command.
                const delivered = await onUnavailable({status: 'mcp-unavailable', opened, project});
                if (delivered) state.noticeSent = true;
            };
            const run = (async () => {
                // 已经开着并且就打开着这个项目：什么都不用做。
                const serving = await portForProject(project).catch(() => undefined);
                if (serving !== undefined) {
                    state.guard.reset();
                    state.noticeSent = false;
                    return {status: 'connected', port: serving, project, unavailableNoticeSent: false};
                }
                // 需要一个 app 才能拉起。拿不到 app 的原因有两种，交给 autoLaunchSupported 区分。
                const app = launchEnabled ? appNameFor(project.app) : undefined;
                if (!app) {
                    return {status: autoLaunchSupported() ? 'disabled' : 'manual-launch', project};
                }
                if (state.guard.exhausted() || state.guard.coolingDown()) {
                    // There is no reason to wait here: MCP is disabled/not ready, and
                    // the user must enable it in the IDE before retrying the command.
                    await reportUnavailable(false);
                    return {status: 'mcp-unavailable', opened: false, project, unavailableNoticeSent: state.noticeSent};
                }
                state.guard.markSpawn();
                const launched = await openInIde(project.path, {app});
                if (!launched) return {status: 'launch-failed', project};
                const started = await waitForProjectServer(project);
                if (started !== undefined) {
                    state.guard.reset();
                    state.noticeSent = false;
                    return {status: 'connected', port: started, project, unavailableNoticeSent: false};
                }
                await reportUnavailable(true);
                return {status: 'mcp-unavailable', opened: true, project, unavailableNoticeSent: state.noticeSent};
            })();
            state.inFlight = run;
            void run
                .catch(() => {
                })
                .then(() => {
                    if (state.inFlight === run) state.inFlight = undefined;
                });
            return run;
        };

        /**
         * `/open-in-ide` 的主流程：让每个已登记项目的 IDE 都就绪，然后把它们注册进
         * OpenCode。
         *
         * 每个项目各自拉起**自己的** IDE —— root 在 IDEA、某子项目在 PyCharm 是常态，
         * 所以这里不是"连一个 IDE"，而是"连一组"，彼此并行。
         *
         * @param {{ onUnavailable?: (result: IdeCommandResult) => Promise<boolean> }} [options]
         * @returns {Promise<IdeCommandResult>}
         */
        const runOpenInIdea = async ({onUnavailable} = {}) => {
            const projects = currentProjects();
            if (projects.length === 0) return {status: 'not-configured'};
            const results = await Promise.all(
                projects.map((project) => ensureProject(project, {onUnavailable})),
            );
            const connected = results.filter((result) => result.status === 'connected');
            if (connected.length === 0) {
                // 一个都没连上：注销残留注册，并挑一个代表性结果回去（文案已带上具体项目）。
                await reconcile({probeIde: false}).catch(() => {
                });
                return results[0];
            }
            let toolsReady = false;
            try {
                // 重新探测一次并整体注册：ensureProject 只保证 IDE 就绪，注册要按"当前真正
                // 打开着哪些项目"重来一遍，这样 `/open-in-ide` 每次都是同一套结果。
                toolsReady = (await reconcile({probeIde: true})) === true;
            } catch {
                // capability load is best effort; feedback still matters
            }
            const connectedProjects = connected.map((result) => result.project);
            return toolsReady
                ? {status: 'connected', port: connected[0].port, projects: connectedProjects}
                : {...connected[0], status: 'tools-loading', projects: connectedProjects};
        };

        /**
         * Coalesced background reconnect.
         *
         * The `context` hook latches the rebuild the moment a request shows the tools
         * are gone, but a latch alone only fires on the NEXT user message — one whole
         * turn later, which is exactly the gap that made a dead session sit there
         * until `/open-in-ide` was run by hand. This runs out of band (it never
         * blocks the request) so the next request — the following agent-loop step, or
         * any later message — already carries the tools again.
         *
         * @returns {Promise<void>}
         */
        /** @type {Promise<void> | undefined} */
        let reviveInFlight;
        const reviveIde = () => {
            // 配置 gate 住每一次重连，包括后台发起的那些：后台尝试绝不能把用户已经用
            // `/delete-in-ide` 删掉的项目重新拉起来。
            if (disposed || !config) return Promise.resolve();
            if (reviveInFlight) return reviveInFlight;
            const run = (async () => {
                try {
                    const result = await runOpenInIdea();
                    // `/delete-in-ide` 可能在这期间落地；它赢。
                    if (!config) {
                        await deactivateIde();
                        return;
                    }
                    if (result.port !== undefined) {
                        needsRebuild = false;
                    }
                } catch {
                    // best effort: the latch stays set, and the prompt hook retries
                }
            })();
            reviveInFlight = run;
            void run.then(() => {
                if (reviveInFlight === run) reviveInFlight = undefined;
            });
            return run;
        };

        // Setup never probes or connects any IDE — everything is on the commands.
        await reconcile({probeIde: false});

        const sendFeedback = async (input, result) => {
            if (feedback !== 'message' || typeof ctx.session?.prompt !== 'function') return false;
            try {
                await ctx.session.prompt({
                    ...input.prompt,
                    sessionID: input.sessionID,
                    text: idePromptText(result),
                    metadata: idePromptMetadata(result),
                    delivery: input.delivery,
                });
                return true;
            } catch {
                // feedback is best effort
                return false;
            }
        };

        // The shipped skills are static knowledge (`skills/<id>/SKILL.md`) that write
        // a project's own rules into its `AGENTS.md`: `idea-standalone` fixes how
        // resident apps are started, `idea-run-config-manager` fixes which repeated
        // flows are solidified into configurations.
        //
        // They are registered **once, when the plugin loads** — with no condition on
        // the project config and none on the IDE's tool catalog. That is a deliberate
        // reversal of the earlier design, which offered a skill only after the tools
        // it drives were actually served. The gate looked right in isolation and was
        // wrong in use: the client snapshots the skill list when the session starts,
        // so anything registered later (by `/open-in-ide` finishing, or by a catalog
        // refresh) stays invisible until the page is reloaded — the user reads that
        // as "the skill is missing" while the registry already has it.
        //
        // What the old gate protected against is handled where it belongs: the skill
        // text itself says what to do when a tool is absent ("hand it back to the
        // user", "run /open-in-ide"). A missing tool is a fact the model can read and
        // act on; an invisible skill is not.
        //
        // The frontmatter `requires:` key is gone with the gate. It was this
        // package's own metadata, never read by OpenCode, and keeping it after the
        // gate disappeared would look like it still decided something.
        //
        // Deliberately NOT wrapped in a catch: these are core features of the plugin,
        // so a rejected definition must fail loudly. Swallowing it would ship a
        // silently incomplete plugin — which is exactly how 0.0.6 lost
        // `/open-in-ide` without anyone noticing until the command was gone.
        const registerSkills = async () => {
            if (typeof ctx.skill?.transform !== 'function') return;
            skillRegistration = await ctx.skill.transform((editor) => {
                for (const {skill} of readSkills()) editor.add(skill);
            });
        };
        await registerSkills();

        /**
         * 问用户"这个项目用哪个 IDE"，由模型转达并回写。
         *
         * 插件自己不能弹选择框，也不能挂起等待；唯一可靠的通道是让模型去问、再把答案用
         * `configure_ide_project` 结构化地写回来。所以这里发的**不是通知而是任务**：文本
         * 里必须写明"调用了工具才算完成"，否则模型很容易只回一句"好的，用 PyCharm"。
         *
         * @param {{ sessionID?: string, prompt?: unknown, delivery?: unknown }} input
         * @param {{ label: string, isRoot: boolean }} target
         */
        const askIdeChoice = async (input, target) => {
            if (typeof ctx.session?.prompt !== 'function') return;
            const where = target.isRoot ? `根项目(${projectPath})` : `子项目 ${target.label}`;
            const call = target.isRoot
                ? 'configure_ide_project({ ide: "<idea|pycharm>" })'
                : `configure_ide_project({ path: "${target.label}", ide: "<idea|pycharm>" })`;
            // 插件自己摸底,而不是让模型去"找 IDE" —— 它找到的办法通常是 `ps aux | grep`(只能
            // 看到**正在运行**的进程,装了没开就漏),又慢又不准。这里是按应用目录读一次得到的。
            const installed = detectInstalledIdes();
            const missing = SUPPORTED_IDES.filter((app) => !installed.includes(app));
            const detectLines = installed.length
                ? [
                    `插件已探测本机安装情况:装有 ${installed.map((app) => IDE_LABELS[app] ?? app).join('、')}` +
                    (missing.length
                        ? `;没找到 ${missing.map((app) => IDE_LABELS[app] ?? app).join('、')}(用户若要用它,需要自己先装)`
                        : '') +
                    '。',
                    '**不要再自己去跑命令或翻进程** —— 这是按应用目录得到的结论,进程里没有不代表没装。',
                    '',
                ]
                : [];
            const text = [
                `${NOTICE_PREFIX}需要确定 ${where} 用哪个 IDE 打开。`,
                '',
                ...detectLines,
                '请向用户提问,并**在得到答复后调用 `configure_ide_project` 工具**写入配置。可选值只有两个:',
                '- `idea` → IntelliJ IDEA',
                '- `pycharm` → PyCharm',
                '',
                '要选它**真正被打开**的那个 IDE(例如 Python 子项目通常是 PyCharm;选错了,IDE 会把请求解析到',
                '包含它的另一个已打开项目上,符号检索与检查会按那个项目的语言支持走)。',
                '',
                `调用形式:${call}`,
                '',
                '不要替用户决定,也不要只回答"已配置" —— 没有真正调用工具就等于没配置。',
            ].join('\n');
            try {
                await ctx.session.prompt({
                    ...input.prompt,
                    sessionID: input.sessionID,
                    text,
                    metadata: {
                        displayText: `请选择 ${where} 使用的 IDE:IntelliJ IDEA 还是 PyCharm?`,
                        comments: [],
                    },
                    delivery: input.delivery,
                });
            } catch {
                // best effort
            }
        };

        /**
         * `configure_ide_project` 的执行体：校验后写入配置并立即接入。
         *
         * 这是模型把用户的选择写回插件的**唯一**通道，所以它自己也做全套校验：模型可能
         * 传错路径、传一个不是 IDE 的值，插件不能因为"是模型给的"就放行。
         *
         * @param {{ path?: unknown, ide?: unknown }} args
         */
        const configureIdeProject = async (args) => {
            const ide = typeof args?.ide === 'string' ? args.ide.toLowerCase() : '';
            if (!SUPPORTED_IDES.includes(ide)) {
                return {content: `不支持的 IDE \`${String(args?.ide)}\`。可选:${SUPPORTED_IDES.join(' / ')}。`};
            }
            const rawPath = typeof args?.path === 'string' ? args.path.trim() : '';
            let current = await readConfig();
            if (rawPath === '') {
                current = current
                    ? {root: {...current.root, app: ide}, children: current.children}
                    : {root: {path: projectPath, app: ide}, children: []};
                await writeConfig(current);
                await runOpenInIdea();
                return {content: `已把根项目配置为 ${IDE_LABELS[ide]} 并接入。`};
            }
            if (!current) {
                return {content: '当前项目还没有 IDE 配置。请先执行 /open-in-ide。'};
            }
            const absPath = resolve(projectPath, rawPath);
            if (!existsSync(absPath)) {
                return {content: `目录不存在:${absPath}。`};
            }
            const verdict = validateSubproject(current, absPath);
            if (!verdict.ok) {
                return {content: `无法登记子项目:${verdict.message}`};
            }
            current = withSubproject(current, absPath, ide);
            await writeConfig(current);
            await runOpenInIdea();
            return {content: `已登记子项目 \`${rawPath}\`(${IDE_LABELS[ide]})并接入。`};
        };

        /** `configure_ide_project` 的工具定义。 */
        const configureIdeTool = () => ({
            name: 'configure_ide_project',
            description:
                '把用户选定的 IDE 写入本项目的 IDE 配置(即"这个项目用哪个 IDE 打开")。' +
                '仅当用户明确回答了"用 IntelliJ IDEA 还是 PyCharm"之后调用,不要在用户没答复前猜。' +
                'path 省略表示配置 root 项目本身;ide 只取 idea / pycharm。',
            input: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: '子项目相对 root 的路径(例如 modelserver);省略表示 root 项目本身。',
                    },
                    ide: {
                        type: 'string',
                        enum: [...SUPPORTED_IDES],
                        description: '该项目的 IDE:idea = IntelliJ IDEA,pycharm = PyCharm。',
                    },
                },
                required: ['ide'],
            },
            execute: async (args) => configureIdeProject(args),
        });

        // `/open-in-ide` 接入 root 与其全部子项目；`/add-sub-module-in-ide <路径>` 登记
        // 一个子项目（IDE 由模型问用户后写回）；`/delete-in-ide` 删除整个配置。
        //
        // 三个名字都带 `-ide` 而不是 `-idea`：这里说的是"接入 IDE"，与具体产品无关 —— root 可能是
        // IDEA、子项目可能是 PyCharm，和工具前缀（`ide_*` / `<目录名>_*`）是同一套口径。
        if (typeof ctx.command?.transform === 'function') {
            commandRegistration = await ctx.command.transform((editor) => {
                editor.add({
                    name: 'open-in-ide',
                    description: '接入当前项目:root 及其全部已登记子项目,各自用配置好的 IDE 打开',
                    execute: async (input) => {
                        const parsed = parseIdeArgument(input?.prompt?.text);
                        if (!parsed.ok) {
                            await sendFeedback(input, {status: 'bad-argument', message: parsed.message});
                            return;
                        }
                        let current = await readConfig();
                        if (!current) {
                            // 第一次：需要知道 root 用哪个 IDE。无参时让模型问用户；带参则直通。
                            if (!parsed.app) {
                                await askIdeChoice(input, {isRoot: true, label: '.'});
                                return;
                            }
                            current = {root: {path: projectPath, app: parsed.app}, children: []};
                            await writeConfig(current);
                        } else if (parsed.app && parsed.app !== current.root.app) {
                            // 直通逃生口：显式带参时改绑 root 的 IDE（模型不配合时用户仍能自救）。
                            current = {root: {...current.root, app: parsed.app}, children: current.children};
                            await writeConfig(current);
                        }
                        /** @type {boolean} */
                        let unavailableNoticeSent = false;
                        const result = await runOpenInIdea({
                            onUnavailable: async (notice) => {
                                unavailableNoticeSent = await sendFeedback(input, notice);
                                return unavailableNoticeSent;
                            },
                        });
                        // The unavailable notice is the final result for this command. If
                        // it was already delivered, do not show the same warning twice.
                        const unavailableAlreadySent = unavailableNoticeSent || result.unavailableNoticeSent;
                        if (!unavailableAlreadySent || result.status !== 'mcp-unavailable') {
                            await sendFeedback(input, result);
                        }
                    },
                });
                editor.add({
                    name: 'add-sub-module-in-ide',
                    description: '登记一个子项目(参数:子项目相对 root 的路径);随后由 AI 询问用哪个 IDE',
                    execute: async (input) => {
                        const parsed = parseSubprojectArgument(input?.prompt?.text);
                        if (!parsed.ok) {
                            await sendFeedback(input, {status: 'bad-argument', message: parsed.message});
                            return;
                        }
                        const current = await readConfig();
                        if (!current) {
                            await sendFeedback(input, {status: 'not-configured'});
                            return;
                        }
                        const absPath = resolve(projectPath, parsed.path);
                        if (!existsSync(absPath)) {
                            await sendFeedback(input, {
                                status: 'invalid-subproject',
                                message: `目录不存在:${absPath}`,
                            });
                            return;
                        }
                        const verdict = validateSubproject(current, absPath);
                        if (!verdict.ok) {
                            await sendFeedback(input, {status: 'invalid-subproject', message: verdict.message});
                            return;
                        }
                        await askIdeChoice(input, {isRoot: false, label: absPath.slice(projectPath.length + 1)});
                    },
                });
                editor.add({
                    name: 'delete-in-ide',
                    description: '删除本项目的 IDE 配置:注销全部 IDE MCP 并清除 root 与子项目的登记',
                    execute: async (input) => {
                        await writeConfig(null);
                        // 注销全部 server。走串行化的 reconcile，所以在飞的重建（另一个
                        // `/open-in-ide`、请求期自愈）不会在配置已删之后再注册回来。
                        await reconcile({probeIde: false});
                        await sendFeedback(input, {status: 'deleted'});
                    },
                });
            });
        }

        // `configure_ide_project`：模型把用户选定的 IDE 写回配置的唯一通道。
        //
        // 常驻注册，不做"用时注册、写完撤销"：一个工具的 schema 只有几百 token，省不下
        // 什么，却要换来一整套状态机（什么时候注册、模型一直不调用怎么办、用户中途说别
        // 的怎么办）。它该不该被调用由 description 约束。
        if (typeof ctx.tool?.transform === 'function') {
            configToolRegistration = await ctx.tool.transform((editor) => {
                editor.add(configureIdeTool());
            });
        }

        // Hide the tools the model must not see, and point it at the rest. This hook
        // runs for every agent-loop step (including tool-driven continuations), so
        // it stays a cheap, I/O-free function of the request: it checks the cached
        // config and this request's own tool snapshot, and takes no action.
        //
        // `event.tools` is this request's tool snapshot, and OpenCode's own registry
        // adds IDE tools when the servers connect and drops them when they stop
        // (`stopServer` publishes `mcp.tools.changed`, which the registry turns into
        // a reload). So the snapshot is also the honest answer to "is the IDE
        // serving?".
        if (typeof ctx.session?.hook === 'function') {
            sessionRegistration = await ctx.session.hook('context', (event) => {
                const tools = event?.tools;
                const serving =
                    tools !== undefined && Object.keys(tools).some((name) => isIdeToolName(name));
                if (serving) {
                    wasServing = true;
                    removeIdeToolDefinitions(tools, HIDDEN_IDE_TOOL_SUFFIXES, prefixes());
                } else if (wasServing && tools !== undefined && config) {
                    // This session HAD the tools and this request does not. Latch a
                    // rebuild here, where "is the IDE serving THIS request?" is a fact: a
                    // failed reconnect can tear the registration down without anything else
                    // noticing. `wasServing` keeps this from firing for a project that
                    // never connected in this session — the `prompt` hook covers that case
                    // (a fresh instance has no registration at all) and setup deliberately
                    // does not connect on its own.
                    needsRebuild = true;
                    wasServing = false;
                    // Do not wait for the next user message. The latch is read by the
                    // `prompt` hook, which has ALREADY run for this request — so without
                    // this the session would stay tool-less for the rest of the turn and
                    // need one more message before anything happened.
                    void reviveIde();
                }
                if (config || serving) {
                    appendIdeRecoveryGuidance(event?.system, {marked: Boolean(config), serving});
                }
                if (!injectGuidance) return;
                // Guidance promises tools the model can call, so it only goes out when
                // they are actually in this request.
                if (!serving) return;
                // 逐项目注入：每条工具后面直接列各项目的命令名，模型不需要自己换算前缀。
                appendIdeGuidance(event?.system, currentProjects());
            });

            // 自愈入口(钩子型)。OpenCode 会 await `prompt`,所以在这里修好的连接会在
            // **本次请求**里就带上 IDE 工具,没有"先回一句正在重连、下一条才行"
            // 的空窗。
            //
            // 两种"需要重连"的形状都从这里进:
            //   * `needsRebuild` — 之前的请求已经证明工具没了;
            //   * `registrations.length === 0` — 本插件实例压根没有注册任何 IDE server,这
            //     正是 OpenCode 回收 Location 服务(LayerMap idleTimeToLive = 60 分钟)
            //     或进程重启后新实例的样子。setup 故意不连接,没有这一步会话就会永久
            //     没有工具,只能靠用户手敲 `/open-in-ide`。
            //
            // 只探测、不启动 IDE:走 `reconcile({ probeIde: true })`,而不是会 `open -a`
            // 的 `reviveIde()` —— 一条用户消息不该把 IDE 拉起来。
            promptRegistration = await ctx.session.hook('prompt', async (event) => {
                if (disposed || !config) return;
                const fresh = registrations.length === 0;
                if (!needsRebuild && !fresh) return;
                // Never react to the plugin's own notices, or recovery would feed on
                // itself. Match the notice TEXT, never `metadata.displayText`: OpenCode
                // also sets `displayText` on ordinary user messages (it is the message
                // text itself), so a displayText guard silently skips every real message
                // — verified live, and it made this rebuild never run.
                const text = event?.prompt?.text;
                if (typeof text === 'string' && text.startsWith(NOTICE_PREFIX)) return;
                try {
                    await reconcile({probeIde: true});
                } catch {
                    // best effort: the latch stays set and the next message retries
                }
                if (registrations.length > 0) needsRebuild = false;
            });

            // The IDE's tool-catalog policy, in two halves that must stay in sync:
            // an argument this plugin always overwrites must not also be advertised,
            // or the model sets it, reasons about it, and is wrong. The schema half
            // runs first, so a request never sees a knob that is already decided; see
            // `mcp/idea-tool-defaults.js` for the measurements and for why this is a
            // narrow exception to "never touch tool definitions".
            //
            // Both halves are deliberately unconditional on the project config: they are
            // properties of the tool call, not of whether this project is IDE-connected.
            if (typeof ctx.tool?.transform === 'function') {
                toolTransformRegistration = await ctx.tool.transform((editor) => {
                    hideForcedArguments(editor, prefixes());
                });
            }
            if (typeof ctx.tool?.hook === 'function') {
                toolBeforeRegistration = await ctx.tool.hook('execute.before', (event) => {
                    if (typeof event?.tool !== 'string') return;
                    applyIdeToolDefaults(event.tool, event.input, prefixes());
                    // 下限抬升与"固定值"是两件事:前者保留调用方更大的值,所以参数继续留在 schema 里。
                    raiseMinimumArguments(event.tool, event.input, prefixes());
                });
            }

            // The only self-initiated action: when an IDE tool call fails in a way
            // that means the IDE MCP is not usable, run the open flow again. The
            // failure is classified — a plain business error (a bad path, a missing
            // file) never triggers a reconnect, only "the MCP is not available" or
            // "the project is not open in the IDE" do.
            if (typeof ctx.tool?.hook === 'function') {
                toolRegistration = await ctx.tool.hook('execute.after', async (event) => {
                    if (event?.status === 'completed') {
                        // 输出侧:目录树顶到 maxDepth 边界时补一句看得见的截断提示
                        // (静默截断正是模型把"被切"读成"空目录"的原因,见 `mcp/idea-tool-output.js`)。
                        if (typeof event?.tool !== 'string' || !isIdeToolName(event.tool)) return;
                        const next = appendDirectoryTreeTruncationNotice(event.result, {
                            tool: event.tool,
                            input: event.input,
                            prefixes: prefixes(),
                        });
                        if (next !== event.result) event.result = next;
                        return;
                    }
                    if (event?.status !== 'error') return;
                    if (typeof event?.tool !== 'string' || !isIdeToolName(event.tool)) return;
                    if (!config) return;
                    const kind = classifyIdeFailure(event.error, serverNames());
                    if (kind === 'none') return;
                    if (kind === 'project') {
                        // The IDE is up and answering; only the PROJECT is missing. That is
                        // never a connection problem, so this must never fall through to
                        // the reconnect below — on a platform with no launcher there is
                        // nothing to call, and falling through would report "reconnected"
                        // and send the model round after round after a call that can only
                        // fail. Leave the IDE's own message, which names the real cause.
                        if (!launchEnabled) return;
                        // 只有这个工具所属的那个项目的 IDE 需要重开（多项目下别去动别的项目）。
                        const project = projectForTool(event.tool);
                        const app = project ? appNameFor(project.app) : undefined;
                        if (!project || !app) return;
                        await openInIde(project.path, {app});
                        rewriteToolError(
                            event,
                            `该项目已在 ${IDE_LABELS[project.app] ?? 'IDE'} 中重新打开,请重试刚才的操作。`,
                        );
                        return;
                    }
                    const result = await runOpenInIdea();
                    if (result.port === undefined) return;
                    rewriteToolError(event, 'IDE MCP 已重新连接,请重试刚才的操作。');
                });
            }
        }

        return async () => {
            disposed = true;
            if (sessionRegistration) {
                try {
                    await sessionRegistration.dispose();
                } catch {
                    // best effort
                }
            }
            if (toolRegistration) {
                try {
                    await toolRegistration.dispose();
                } catch {
                    // best effort
                }
            }
            if (toolBeforeRegistration) {
                try {
                    await toolBeforeRegistration.dispose();
                } catch {
                    // best effort
                }
            }
            if (toolTransformRegistration) {
                try {
                    await toolTransformRegistration.dispose();
                } catch {
                    // best effort
                }
            }
            if (configToolRegistration) {
                try {
                    await configToolRegistration.dispose();
                } catch {
                    // best effort
                }
            }
            if (promptRegistration) {
                try {
                    await promptRegistration.dispose();
                } catch {
                    // best effort
                }
            }
            if (commandRegistration) {
                try {
                    await commandRegistration.dispose();
                } catch {
                    // best effort
                }
            }
            if (skillRegistration) {
                try {
                    await skillRegistration.dispose();
                } catch {
                    // best effort
                }
            }
            await deactivateIde();
        };
    },
};
