// opencode-idea — OpenCode plugin entry.
//
// 一个 OpenCode 会话只对应**一个** JetBrains 项目：当前 workspace root。
// 工具前缀固定 `ide_`，IDE 打开的项目目录必须和 workspace root 完全相同。
//
// 数据模型在 `ide-projects.js`；这里只做编排：探测、注册、提示词、命令、工具。
//
// For a root project the user opted in, this plugin:
//   1. registers one IDE MCP server (`ide`) scoped to the project through the
//      `IJ_MCP_SERVER_PROJECT_PATH` header; injects direct-call guidance; and
//      hides the IDE tools that must not reach the model;
//   2. registers `/open-in-ide` (接入当前项目) and `/delete-in-ide` (删掉配置);
//   3. registers the shipped skills (`skills/<id>/SKILL.md`) — marked projects
//      only, and each one also gated on the IDE tools it drives.
//
// A root that was never configured is left untouched. Everything is manual:
// setup does NOT probe or connect any IDE. The commands probe, open the IDE, and
// load the MCP server + guidance on demand.
//
// `/open-in-ide` opens the configured project in its IDE, waits until its MCP
// endpoint is ready, registers it as `ide`, and keeps the config in
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

import {statSync} from 'node:fs';
import {resolve} from 'node:path';

import {callTool, serverConfig} from './mcp/idea.js';
import {
    applyDescriptionOverrides,
    applyIdeToolDefaults,
    hideForcedArguments,
    raiseMinimumArguments,
} from './mcp/idea-tool-defaults.js';
import {appendDirectoryTreeTruncationNotice} from './mcp/idea-tool-output.js';
import {currentProjectPath} from './project.js';
import {
    autoLaunchSupported,
    createLaunchGuard,
    ideAppName,
    openInIde,
} from './ide-launcher.js';
import {
    appendGuidance,
    appendIdeRecoveryGuidance,
} from './ide-guidance.js';
import {
    IDE_PORTS,
    MARK_VERSION,
    ROOT_SERVER_NAME,
    markKeyFor,
    parseMark,
    serializeMark,
} from './ide-projects.js';
import {readSkills} from './skill/loader.js';
import {
    createRemoteToolset,
    remoteDownloadTool,
    remoteExecTool,
    remoteListServersTool,
    remoteUploadTool,
} from './remote/tools.js';
import {syncRemoteConfig} from './remote/persist.js';
import {projectHostsPath} from './remote/hosts.js';
import {
    MANAGE_REMOTE_CONFIG_DISPLAY,
    REMOTE_DEPLOYMENT_DISPLAY,
    REMOTE_SHELL_DISPLAY,
    REMOTE_SYNC_DISPLAY,
    manageRemoteConfigPrompt,
    remoteDeploymentPrompt,
    remoteShellPrompt,
    remoteSyncPrompt,
} from './remote/prompts.js';

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
// `get_project_env` is a small read that the connect flow AWAITS. Three seconds
// is enough for a healthy IDE and short enough that a wedged one cannot stall
// `/open-in-ide` or a shell creation.
const PROJECT_ENV_TIMEOUT_MS = 3000;
// `get_ssh_servers` / `sync_deployments`：前者是一次读，后者会写 IDE 的 Deployment 配置
// 并触发 UI 刷新，给 10s 的余量；仍然是一个有界上限，不会挂住命令。
const IDE_CONFIG_TIMEOUT_MS = 10000;
// The project environment is also re-read while the session runs (SDK / Maven
// settings can change under a live IDE). One read per minute per session is
// plenty: a shell that starts within the window reuses the cached value.
const PROJECT_ENV_TTL_MS = 60000;
// PATH is the one variable the caller owns: IDE directories are PREPENDED so the
// configured SDK wins over whatever the host shell already had.
const PATH_DELIMITER = process.platform === 'win32' ? ';' : ':';

/**
 * Parse a `get_project_env` result into `{ PATH, variables }`.
 *
 * `structuredContent` is preferred (registered with the tool's output schema);
 * the text body is the fallback because an error result carries no structured
 * content and some IDE builds only fill the text part.
 *
 * @param {{ isError?: boolean, content?: unknown, structuredContent?: unknown } | undefined} result
 * @returns {{ PATH: string, variables: Record<string, string>, projectPath?: string } | undefined}
 */
export function projectEnvFromResult(result) {
    if (!result || result.isError === true) return undefined;
    const payload = (result.structuredContent && typeof result.structuredContent === 'object')
        ? result.structuredContent
        : textJson(result);
    const env = normalizeProjectEnv(payload);
    if (!env) return undefined;
    if (typeof payload?.projectPath === 'string' && payload.projectPath !== '') {
        env.projectPath = payload.projectPath;
    }
    return env;
}

/** 从 `get_project_env` 结果里取 IDE 项目路径；与 PATH/variables 是否完整无关。 */
function projectPathFromResult(result) {
    if (!result || result.isError === true) return undefined;
    const payload = (result.structuredContent && typeof result.structuredContent === 'object')
        ? result.structuredContent
        : textJson(result);
    return typeof payload?.projectPath === 'string' && payload.projectPath !== ''
        ? payload.projectPath
        : undefined;
}

/**
 * 两个项目路径是否**完全同一个目录**（不是父子关系）。
 *
 * IDE 会把"落在某个已打开项目目录树内"的路径解析到那个项目，所以只靠一次成功的
 * 工具调用无法判断 IDE 打开的是不是同一个目录；必须比较 `get_project_env` 返回的
 * `projectPath`。macOS / Windows 的文件系统大小写不敏感，比较时统一小写。
 *
 * @param {string} left
 * @param {string} right
 */
export function sameProjectPath(left, right) {
    const normalize = (value) => value.replace(/\\/g, '/').replace(/\/+$/, '');
    const a = normalize(left);
    const b = normalize(right);
    return process.platform === 'win32' || process.platform === 'darwin'
        ? a.toLowerCase() === b.toLowerCase()
        : a === b;
}

/** @param {unknown} value */
function normalizeProjectEnv(value) {
    if (!value || typeof value !== 'object') return undefined;
    const record = /** @type {Record<string, unknown>} */ (value);
    const hasPath = typeof record.PATH === 'string';
    const hasVariables = Boolean(record.variables) && typeof record.variables === 'object';
    // 其它工具也会返回 JSON（`{"modules":[]}` 之类）。没有这两个键就不是 env，
    // 否则任何一次成功的工具调用都会被误当成"环境已就绪"。
    if (!hasPath && !hasVariables) return undefined;
    const PATH = hasPath ? /** @type {string} */ (record.PATH) : '';
    /** @type {Record<string, string>} */
    const variables = {};
    const raw = record.variables;
    if (raw && typeof raw === 'object') {
        for (const [key, entry] of Object.entries(/** @type {Record<string, unknown>} */ (raw))) {
            if (typeof entry === 'string') variables[key] = entry;
        }
    }
    return {PATH, variables};
}

/** @param {{ content?: unknown } | undefined} result */
function textJson(result) {
    const parts = Array.isArray(result?.content) ? result.content : [];
    const text = parts
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n');
    if (!text) return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

/**
 * Parse a `get_ssh_servers` result into the plugin's own server shape.
 *
 * 只认有 name + host 的条目；其余字段缺了就用默认值 —— 凭据缺失的服务器仍然列出来
 * （`remote_list_servers` 要能看到它），执行时才报"没有凭据"。
 *
 * IDE 只提供 SSH 配置与凭据：deployment / exclude 全部来自 hosts.json，
 * 所以这里固定给一个空数组，由 `mergeServers` 保留项目层的 mapping。
 *
 * @param {{ isError?: boolean, content?: unknown, structuredContent?: unknown } | undefined} result
 */
export function ideServersFromResult(result) {
    if (!result || result.isError === true) return [];
    const payload = (result.structuredContent && typeof result.structuredContent === 'object')
        ? result.structuredContent
        : textJson(result);
    const servers = /** @type {{ servers?: unknown }} */ (payload)?.servers;
    if (!Array.isArray(servers)) return [];

    return servers.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return [];
        const record = /** @type {Record<string, unknown>} */ (entry);
        const name = typeof record.name === 'string' ? record.name.trim() : '';
        const host = typeof record.host === 'string' ? record.host : '';
        if (!name || !host) return [];
        return [{
            name,
            host,
            port: typeof record.port === 'number' && record.port > 0 ? record.port : 22,
            username: typeof record.username === 'string' ? record.username : '',
            password: typeof record.password === 'string' && record.password !== '' ? record.password : undefined,
            passphrase: typeof record.passphrase === 'string' && record.passphrase !== '' ? record.passphrase : undefined,
            privateKeyPath: typeof record.privateKeyPath === 'string' && record.privateKeyPath !== ''
                ? record.privateKeyPath
                : undefined,
            deployments: [],
            source: 'ide',
        }];
    });
}

/**
 * IDE MCP tools that must never reach the model, listed by **suffix**.
 *
 * 存后缀而不是完整工具名:IDE 工具都以 `ide_` 开头,写死 `idea_...` 会永远命中不了。
 * 展开由 `removeIdeToolDefinitions` 按当前前缀完成。
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
 *   have. The project environment is delivered by `get_project_env` through the
 *   plugin's own `shell` hook, so the native shell IS the project shell. Remote
 *   commands are handled by this plugin's `remote_exec` (over SSH) instead of the
 *   IDE's own remote terminal, so those tools are hidden as well.
 * - Environment / credential channels: `get_project_env` and
 *   `get_ssh_servers` are data channels for this plugin, not tasks. The
 *   model never needs them, and exposing them only invites calls that duplicate
 *   what the plugin already does.
 */
export const HIDDEN_IDE_TOOL_SUFFIXES = [
    // VCS
    'git_status',
    'get_repositories',
    // Router
    'execute_tool',
    // IDE terminal: no advantage over the native shell (see the note above).
    'execute_terminal_command',
    // Remote terminal / transfer: replaced by this plugin's remote_exec / remote_upload /
    // remote_download. These suffixes now name tools the companion plugin no longer ships —
    // they stay here so an installation that has not upgraded yet cannot leak them to the model.
    'execute_in_remote_host',
    'terminal_read',
    'terminal_interrupt',
    'list_terminals',
    'list_server_deployments',
    'upload_to_deployment',
    'download_from_deployment',
    'get_deployment_task_status',
    // Environment channel: consumed by this plugin's shell hook (see the note above).
    'get_project_env',
    // Credential channel: consumed by this plugin's remote_exec (see the note above).
    'get_ssh_servers',
    // Deployment writer: consumed by /sync-remote-config and the fingerprint reconcile.
    'sync_deployments',
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
 * 入参是**后缀**列表,这里按当前前缀展开成完整工具名。
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
 * @param {readonly string[]} serverNames 当前注册的 server 名（现在只有 `ide`）。
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
    // serverNames 是当前注册的 server 名（现在只有 `ide`）：错误里点名的是哪个 server，
    // 取决于失败的工具，所以逐个匹配。
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
 *     | 'env-unready'
 *     | 'mcp-unavailable'
 *     | 'launch-failed'
 *     | 'disabled'
 *     | 'manual-launch'
 *     | 'deleted'
 *     | 'not-configured'
 *   // `manual-launch` = this platform has no launcher at all (the user must
 *   // open the IDE by hand); `disabled` = the user turned launching off. Both
 *   // mean "no app to open", so only `autoLaunchSupported()` tells them apart.
 *   port?: number,
 *   opened?: boolean,
 *   unavailableNoticeSent?: boolean,
 *   project?: { app?: string },
 *   message?: string
 * }} IdeCommandResult
 */

/**
 * @param {unknown} value
 * @param {number} fallback
 */
const asPositiveNumber = (value, fallback) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

/** 面向用户的状态文案（两个接入命令共用）。 */
/** @param {IdeCommandResult} result */
export function ideFeedback(result) {
    const nameOf = () => 'IntelliJ IDEA';
    switch (result?.status) {
        case 'connected':
            return 'IDE MCP 已连接并接入。';
        case 'tools-loading':
            return 'IDE MCP 已连接,但原生 IDE 工具列表尚未完成注册。请稍后再次执行 /open-in-ide。';
        case 'env-unready': {
            const where = nameOf(result?.project);
            return `IDE MCP 已连接(${where}),但项目环境变量没取到(get_project_env 失败),连接未完成。请重试 /open-in-ide;若一直失败,检查 IDE 的日志。`;
        }
        case 'mcp-unavailable': {
            const where = nameOf(result?.project);
            const ide = 'IntelliJ IDEA';
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
        case 'synced':
        case 'sync-partial':
            return result?.message ?? '已对齐远程配置。';
        case 'sync-failed':
            return result?.message ?? '对齐远程配置失败。';
        case 'not-configured':
            return '当前项目还没有 IDE 配置。请先执行 /open-in-ide。';
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
     *   shell: { hook: (name: string, cb: (event: {
     *     command: string,
     *     cwd: string,
     *     env: Record<string, string | undefined>,
     *   }) => Promise<void> | void) => Promise<{ dispose: () => Promise<void> | void }> },
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
        // 自动拉起 IDE 的总开关。只支持 IntelliJ IDEA，这个选项只决定"允不允许拉起"。
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
        /** `shell.hook("create.before")` 的注册：把项目环境注入每条新 shell。 */
        let shellRegistration;
        /** `remote_exec` / `remote_list_servers` 的注册。 */
        let remoteToolsRegistration;
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

        // root 项目的环境变量（`get_project_env` 的结果）。连接成功后才会有值；
        // 每次 shell 创建时读它，出 TTL 就同一次同步重拉（3s 上限，失败不注入）。
        /** @type {{ PATH: string, variables: Record<string, string> } | undefined} */
        let projectEnv;
        let projectEnvAt = 0;
        /** @type {Promise<boolean> | undefined} */
        let envLoadInFlight;

        // 本会话的 IDE 配置：只记录"用户已经接入过"。
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
                config = parseMark(await storage.get(markKey)) ?? null;
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
         * 配置在本进程里不可见，行为会自相矛盾。`/open-in-ide` 与 `/delete-in-ide` 是唯一的
         * 写入者。
         *
         * @param {import('./ide-projects.js').IdeConfig | null} next
         */
        const writeConfig = async (next) => {
            try {
                if (next) await storage?.set?.(markKey, serializeMark());
                else await storage?.remove?.(markKey);
            } catch {
                // best effort
            }
            config = next;
        };

        /** 当前接入的项目；未配置时为 `undefined`。只有一个项目，路径就是工作区根。 */
        const currentProject = () =>
            config ? {path: projectPath, server: ROOT_SERVER_NAME} : undefined;

        /** 当前工具前缀（含下划线）；未配置时为空。 */
        const prefixes = () => (config ? [`${ROOT_SERVER_NAME}_`] : []);

        /** 当前注册的 server 名（= 前缀去掉下划线）。 */
        const serverNames = () => (config ? [ROOT_SERVER_NAME] : []);

        /** 这个工具名是否属于 IDE server（插件自己的工具不算）。 */
        const isIdeToolName = (name) => prefixes().some((prefix) => name.startsWith(prefix));

        /**
         * 这个 IDE 工具是否属于当前项目。
         *
         * @param {string} name
         */
        const projectForTool = (name) => {
            const project = currentProject();
            return project && name.startsWith(`${project.server}_`) ? project : undefined;
        };

        // 先解析一次，请求钩子之后就能同步读到。
        await readConfig();

        /** 注销当前注册的全部 IDE server。 */
        const deactivateIde = async () => {
            // 连接不复存在，环境变量缓存也一起作废：下一条 shell 不会再拿到旧项目的 PATH。
            projectEnv = undefined;
            projectEnvAt = 0;
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
        const portFor = () => IDE_PORTS.idea;

        /**
         * 拉 **root 项目** 的环境变量（`get_project_env`）。
         *
         * 只取 root：PATH 的语义是"这个会话的基础环境"，按子目录分流会把同一份
         * shell 状态切成几套互不相干的 PATH。
         *
         * 这是**连接的硬条件**：`reconcileOnce` 只有它成功才算 ready，失败时
         * `/open-in-ide` 报 `env-unready`，不会静默降级成"工具有了但环境是空的"。
         *
         * @returns {Promise<boolean>}
         */
        const loadProjectEnv = async () => {
            if (envLoadInFlight) return envLoadInFlight;
            const run = (async () => {
                const project = currentProject();
                const port = project ? portFor(project) : undefined;
                if (!project || port === undefined) return false;
                const result = await callTool(port, project.path, 'get_project_env', {}, {
                    timeoutMs: PROJECT_ENV_TIMEOUT_MS,
                }).catch(() => undefined);
                const env = projectEnvFromResult(result);
                if (!env) return false;
                projectEnv = env;
                projectEnvAt = Date.now();
                return true;
            })();
            envLoadInFlight = run;
            try {
                return await run;
            } finally {
                if (envLoadInFlight === run) envLoadInFlight = undefined;
            }
        };

        /**
         * 调一次 IDE 的隐藏工具（`get_ssh_servers` / `sync_deployments`）。
         *
         * 与模型可见的 IDE 工具分开：这两个是数据通道，参数固定、结果由插件消费。
         * 工具自己的错误文本（例如 `[deployment_config_incomplete]` 点名了哪台缺配置）
         * 原样往上抛，调用方直接转给用户，不要覆盖成一句"不可用"。
         *
         * @param {string} name
         * @param {Record<string, unknown>} args
         */
        const callIdeTool = async (name, args, options = {}) => {
            const project = currentProject();
            const port = project ? portFor(project) : undefined;
            if (!project || port === undefined) {
                throw new Error('还没有接入 IDE 项目：先执行 /open-in-ide。');
            }
            const result = await callTool(port, project.path, name, args, {
                timeoutMs: options.timeoutMs ?? IDE_CONFIG_TIMEOUT_MS,
            }).catch(() => undefined);
            if (!result) throw new Error('IDE MCP 未连接：先执行 /open-in-ide。');
            if (result.isError === true) {
                const text = (result.content ?? [])
                    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
                    .map((part) => part.text)
                    .join('\n');
                throw new Error(text || `${name} 返回错误。`);
            }
            return result;
        };

        /**
         * 远程执行的数据源：IDE 的 SSH 配置 + 凭据。
         *
         * 每次 `remote_exec` 命中缓存就不打 IDE；未命中或连接失败才强制刷新（见
         * `createRemoteToolset`）。IDE 没开时抛错，toolset 会吞掉并退到项目级 /
         * 全局的 hosts.json。
         */
        const fetchIdeServers = async () => {
            const result = await callIdeTool('get_ssh_servers', {});
            return ideServersFromResult(result);
        };

        /**
         * 把一条 server 的 deployment 推到 IDE。
         *
         * @param {{ server: string, deployments: Array<{ name: string, localPath: string, deployPath: string, exclude: string[] }> }} target
         */
        const pushDeployments = async (target) => {
            const result = await callIdeTool('sync_deployments', {
                server: target.server,
                deployments: target.deployments,
            });
            const payload = (result.structuredContent && typeof result.structuredContent === 'object')
                ? result.structuredContent
                : textJson(result);
            return {
                server: target.server,
                created: Array.isArray(payload?.created) ? payload.created.length : 0,
                updated: Array.isArray(payload?.updated) ? payload.updated.length : 0,
                unchanged: Array.isArray(payload?.unchanged) ? payload.unchanged.length : 0,
            };
        };

        const remoteToolset = createRemoteToolset({projectPath, fetchIdeServers});

        /**
         * hosts.json 的指纹：mtime + size。
         *
         * 不做文件监听：OpenCode 没有文件系统事件，而且编辑器保存 / rename 会让 watch 失效。
         * 每次工具执行后 stat 一次就够了 —— AI 改完，下一个工具调用就对账。
         */
        const hostsFingerprint = () => {
            try {
                const info = statSync(projectHostsPath(projectPath));
                return `${info.mtimeMs}:${info.size}`;
            } catch {
                return '';
            }
        };

        let lastHostsFingerprint = hostsFingerprint();
        /** @type {Promise<void> | undefined} */
        let hostsReconcile;

        /**
         * 指纹变了就把 hosts.json 静默对齐到 IDE。
         *
         * 触发点是 `tool.execute.after` 与 `session.hook('prompt')`：前者覆盖 AI 的编辑，
         * 后者覆盖用户手改。失败不打扰用户，只重置指纹，下次交互再试。
         */
        const reconcileHostsIfChanged = () => {
            if (hostsReconcile) return hostsReconcile;
            const current = hostsFingerprint();
            if (current === '' || current === lastHostsFingerprint) return undefined;
            lastHostsFingerprint = current;
            hostsReconcile = (async () => {
                try {
                    const servers = await fetchIdeServers();
                    const result = syncRemoteConfig({projectPath, servers});
                    for (const target of result.syncTargets) {
                        await pushDeployments(target).catch(() => {});
                    }
                    await remoteToolset.load({force: true}).catch(() => {});
                } catch {
                    // IDE 没开 / 配置暂时不完整：不打扰用户，下次交互再试。
                    lastHostsFingerprint = '';
                } finally {
                    hostsReconcile = undefined;
                }
            })();
            return hostsReconcile;
        };

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
         * server 名就是工具前缀（现在固定 `ide`），所以 `editor.set`
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

        /**
         * 重连一次，返回这次连接走到了哪一步：
         * - `ready`：工具目录 + root 环境变量都到位；
         * - `tools`：server 注册了，但工具目录没落地；
         * - `env`：工具可用，但 `get_project_env` 没取到；
         * - `none`：没有可连的项目 / 未配置 / 本次不探测。
         *
         * 分阶段返回是必要的：`tools-loading` 与 `env-unready` 是两种完全不同的失败，
         * 调用方的提示与重试节奏也不同，用 boolean 会把它们混成一个。
         *
         * @returns {Promise<'ready' | 'tools' | 'env' | 'none'>}
         */
        const reconcileOnce = async ({probeIde = true} = {}) => {
            if (disposed) return 'none';

            // 未配置：没有任何项目要接入。
            if (!config) {
                await deactivateIde();
                return 'none';
            }
            // Manual: only the commands probe the IDE. Setup calls this with
            // `probeIde: false` so it never connects until a command asks.
            if (!probeIde) {
                await deactivateIde();
                return 'none';
            }

            const bindings = [];
            const project = currentProject();
            if (project) {
                const port = await portForProject(project);
                if (port !== undefined) bindings.push({project, port});
            }

            // Always tear the servers down and register them again. OpenCode's reconcile
            // SKIPS a re-`set` whose config is unchanged, so re-registering without a
            // teardown would leave a dropped server in place forever. The commands and
            // the request hooks are rare; rebuilding costs one restart, which is the
            // right trade for never leaving a dead registration behind.
            await deactivateIde();
            if (bindings.length === 0) return 'none';
            const toolsReady = await activateIde(bindings);
            if (!toolsReady) return 'tools';
            // 环境变量是连接完成的最后一步：拉不到就等于这次连接没做完，
            // 调用方（`/open-in-ide`、自愈）会据此重试，而不是当作 ready。
            return (await loadProjectEnv()) ? 'ready' : 'env';
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
         * `path` 是不是 IDE **真正打开的那个项目目录**？
         *
         * 不能只看一次工具调用是否成功：IDE 会把"落在某个已打开项目目录树内"的路径
         * 解析到那个项目，所以父目录打开时，当前项目也能被解析成功。严格同目录必须比较
         * `get_project_env` 返回的 `projectPath`。
         *
         * 连接失败 / 拿不到 `projectPath` 一律按"未确认打开"处理，让调用方去拉起 IDE。
         *
         * @param {number} port
         * @param {string} path
         */
        const isProjectOpen = async (port, path) => {
            const result = await callTool(port, path, 'get_project_env', {}, {
                timeoutMs: mcpProbeTimeoutMs,
            }).catch(() => undefined);
            if (!result || result.isError === true) return false;
            const projectPath = projectPathFromResult(result);
            if (!projectPath) return false;
            return sameProjectPath(projectPath, path);
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
         * 本项目的启动状态：in-flight、拉起冷却、是否已发过通知。
         *
         * 按项目路径分开：不同项目的插件实例互不影响；同一个项目的重复调用仍然共享
         * 一次拉起（re-entrant）。
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
         * @param {{ path: string, server: string, app: string }} project
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
                const app = launchEnabled ? ideAppName() : undefined;
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
         * 现在只有一个项目，拉起它配置的 IDE 即可。
         *
         * @param {{ onUnavailable?: (result: IdeCommandResult) => Promise<boolean> }} [options]
         * @returns {Promise<IdeCommandResult>}
         */
        const runOpenInIdea = async ({onUnavailable} = {}) => {
            const project = currentProject();
            if (!project) return {status: 'not-configured'};
            const result = await ensureProject(project, {onUnavailable});
            if (result.status !== 'connected') {
                // 没连上：注销残留注册，把 ensureProject 的具体失败原因交回去。
                await reconcile({probeIde: false}).catch(() => {
                });
                return result;
            }
            let stage = 'none';
            try {
                // 重新探测一次并注册：ensureProject 只保证 IDE 就绪，注册要按"现在真的
                // 打开着这个项目"重来一遍，这样 `/open-in-ide` 每次都是同一套结果。
                stage = await reconcile({probeIde: true});
            } catch {
                // capability load is best effort; feedback still matters
            }
            if (stage === 'ready') return {status: 'connected', port: result.port, project};
            // IDE 已连上、但 env 没拉到：连接按"没做完"处理，命令会要求重试，
            // 而不是报一个看起来成功的 connected。
            if (stage === 'env') return {status: 'env-unready', port: result.port, project};
            return {...result, status: 'tools-loading', project};
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
                    if (result.status === 'connected') {
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

        // `/open-in-ide` 接入当前项目；`/delete-in-ide` 删除配置。
        //
        // 名字带 `-ide` 而不是 `-idea`：这里说的是"接入 IDE"，与具体产品无关。
        if (typeof ctx.command?.transform === 'function') {
            commandRegistration = await ctx.command.transform((editor) => {
                editor.add({
                    name: 'open-in-ide',
                    description: '接入当前项目:在 IntelliJ IDEA 里打开它,并把 IDE MCP 工具注册进来',
                    execute: async (input) => {
                        // 第一次接入:写标记,之后靠它判断"这个项目该不该自动重连"。
                        if (!(await readConfig())) {
                            await writeConfig({version: MARK_VERSION});
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
                    name: 'delete-in-ide',
                    description: '删除本项目的 IDE 配置:注销 IDE MCP 并清除登记',
                    execute: async (input) => {
                        await writeConfig(null);
                        // 注销全部 server。走串行化的 reconcile，所以在飞的重建（另一个
                        // `/open-in-ide`、请求期自愈）不会在配置已删之后再注册回来。
                        await reconcile({probeIde: false});
                        await sendFeedback(input, {status: 'deleted'});
                    },
                });
                // 双向对齐：IDE 的 SSH 配置写回 hosts.json，hosts.json 的 deployment 推到 IDE。
                // IDE 没开时整条命令直接失败 —— 两个方向都需要 IDE。
                editor.add({
                    name: 'sync-remote-config',
                    description: '双向对齐 IDE 与 hosts.json：SSH 配置写回，deployment 推到 IDE 的 Deployment 面板',
                    execute: async (input) => {
                        let servers;
                        try {
                            servers = await fetchIdeServers();
                        } catch (error) {
                            await sendFeedback(input, {
                                status: 'sync-failed',
                                message:
                                    '读取 IDE 的 SSH 配置失败：' +
                                    (error instanceof Error ? error.message : String(error)),
                            });
                            return;
                        }

                        let result;
                        try {
                            result = syncRemoteConfig({projectPath, servers});
                        } catch (error) {
                            await sendFeedback(input, {
                                status: 'sync-failed',
                                message: `写入 hosts.json 失败：${error instanceof Error ? error.message : String(error)}`,
                            });
                            return;
                        }

                        const pushed = [];
                        const failures = [];
                        for (const target of result.syncTargets) {
                            try {
                                pushed.push(await pushDeployments(target));
                            } catch (error) {
                                failures.push(
                                    `${target.server}: ${error instanceof Error ? error.message : String(error)}`,
                                );
                            }
                        }

                        // 缓存里还是旧的列表，紧接着的 remote_exec 会读不到刚写进去的条目。
                        await remoteToolset.load({force: true}).catch(() => {});

                        const lines = [
                            `已对齐 ${result.path}`,
                            `server：新增 ${result.added} 台 / 更新 ${result.updated} 台 / 保留 ${result.kept} 台，` +
                            `共 ${result.total} 台`,
                        ];
                        if (pushed.length > 0) {
                            const deployments = pushed.reduce(
                                (sum, entry) => sum + entry.created + entry.updated + entry.unchanged, 0,
                            );
                            lines.push(`deployment：已推 ${deployments} 条到 IDE`);
                        } else if (result.deploymentCount === 0) {
                            lines.push('deployment：hosts.json 里还没有配置');
                        }
                        if (failures.length > 0) {
                            lines.push(`未推送 ${failures.length} 台：`, ...failures.map((line) => `  - ${line}`));
                        }
                        await sendFeedback(input, {
                            status: failures.length > 0 ? 'sync-partial' : 'synced',
                            message: lines.join('\n'),
                        });
                    },
                });

                // 两条提示词命令：不执行任何东西，只把"用 remote_* 工具、别自己拼 ssh"这条规则注入会话。
                // 参数原样附在末尾；没带参数时提示词会要求模型先问清楚。
                editor.add({
                    name: 'remote-shell',
                    description: '远程执行模式：引导 AI 用 remote_exec 而不是 ssh',
                    execute: async (input) => {
                        if (typeof ctx.session?.prompt !== 'function') return;
                        const request = input?.prompt?.text ?? '';
                        try {
                            await ctx.session.prompt({
                                ...input.prompt,
                                sessionID: input.sessionID,
                                text: remoteShellPrompt(request),
                                // 用用户自己写的那句话做气泡，不要用固定文案 —— 否则 `/remote-shell xxx` 的
                                // 参数在界面上就消失了，看起来像被吞掉。
                                metadata: {
                                    displayText: request.trim()
                                        ? `【远程执行】${request.trim()}`
                                        : REMOTE_SHELL_DISPLAY,
                                    comments: [],
                                },
                                delivery: input.delivery,
                            });
                        } catch {
                            // 提示词投递失败不该把命令本身变成错误
                        }
                    },
                });
                editor.add({
                    name: 'remote-deployment',
                    description: '远程部署模式：引导 AI 用 deploy_remote_process 同步并启动，而不是手动拼 ssh / scp',
                    execute: async (input) => {
                        if (typeof ctx.session?.prompt !== 'function') return;
                        const request = input?.prompt?.text ?? '';
                        try {
                            await ctx.session.prompt({
                                ...input.prompt,
                                sessionID: input.sessionID,
                                text: remoteDeploymentPrompt(request),
                                metadata: {
                                    displayText: request.trim()
                                        ? `【远程部署同步】${request.trim()}`
                                        : REMOTE_DEPLOYMENT_DISPLAY,
                                    comments: [],
                                },
                                delivery: input.delivery,
                            });
                        } catch {
                            // 同上
                        }
                    },
                });
                // 纯文件同步：和部署分开，避免把 remote_upload 当成部署。
                editor.add({
                    name: 'remote-sync',
                    description: '远程文件同步模式：引导 AI 用 remote_upload / remote_download，不启动进程',
                    execute: async (input) => {
                        if (typeof ctx.session?.prompt !== 'function') return;
                        const request = input?.prompt?.text ?? '';
                        try {
                            await ctx.session.prompt({
                                ...input.prompt,
                                sessionID: input.sessionID,
                                text: remoteSyncPrompt(request),
                                metadata: {
                                    displayText: request.trim()
                                        ? `【远程文件同步】${request.trim()}`
                                        : REMOTE_SYNC_DISPLAY,
                                    comments: [],
                                },
                                delivery: input.delivery,
                            });
                        } catch {
                            // 同上
                        }
                    },
                });
                // 纯提示词命令：AI 只改 hosts.json，改完由指纹对账自动推到 IDE。
                editor.add({
                    name: 'manage-remote-config',
                    description: '远程配置模式：引导 AI 修改 hosts.json（server / deployment / exclude）',
                    execute: async (input) => {
                        if (typeof ctx.session?.prompt !== 'function') return;
                        const request = input?.prompt?.text ?? '';
                        try {
                            await ctx.session.prompt({
                                ...input.prompt,
                                sessionID: input.sessionID,
                                text: manageRemoteConfigPrompt(request),
                                metadata: {
                                    displayText: request.trim()
                                        ? `【远程配置】${request.trim()}`
                                        : MANAGE_REMOTE_CONFIG_DISPLAY,
                                    comments: [],
                                },
                                delivery: input.delivery,
                            });
                        } catch {
                            // 同上
                        }
                    },
                });
            });
        }

        // 远程执行：两个普通工具（不是 IDE 工具，所以不带 `ide_` 前缀）。
        // 注册是常驻的：IDE 没开时它们仍然可用，只是服务器列表退到 hosts.json。
        if (typeof ctx.tool?.transform === 'function') {
            remoteToolsRegistration = await ctx.tool.transform((editor) => {
                editor.add(remoteExecTool(remoteToolset));
                editor.add(remoteListServersTool(remoteToolset));
                editor.add(remoteUploadTool(remoteToolset));
                editor.add(remoteDownloadTool(remoteToolset));
            });
        }

        // 项目环境注入：**所有** shell（模型的 bash 工具与用户终端）在创建前都会经过这里。
        //
        // 只有 PATH 是"拼"的：IDE 配置的目录前置，调用方原有的 PATH 接在后面 —— 这样
        // IDE 里选的 JDK / Node / Go / Maven / Python 真的优先生效，同时不丢掉 OpenCode
        // 进程自己的 PATH。其余变量（GOROOT / MAVEN_HOME / VIRTUAL_ENV ...）直接覆盖。
        //
        // 缓存命中不阻塞；过期时在同一次 hook 里同步重拉（3s 上限），拉不到就不注入 ——
        // 一条命令不该因为 IDE 短暂不可用而失败。
        if (typeof ctx.shell?.hook === 'function') {
            shellRegistration = await ctx.shell.hook('create.before', async (event) => {
                const env = event?.env;
                if (!env || typeof env !== 'object') return;
                let current = projectEnv;
                if (!current || Date.now() - projectEnvAt > PROJECT_ENV_TTL_MS) {
                    current = (await loadProjectEnv().catch(() => false)) ? projectEnv : undefined;
                }
                if (!current) return;
                if (current.PATH) {
                    env.PATH = env.PATH
                        ? `${current.PATH}${PATH_DELIMITER}${env.PATH}`
                        : current.PATH;
                }
                for (const [key, value] of Object.entries(current.variables)) {
                    env[key] = value;
                }
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
                // 一个文件、两段内容：IDE 段只在 IDE 工具真的在本次请求里时出现；
                // 远端工具段与连接状态无关，始终出现。
                appendGuidance(event?.system, serving);
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
                if (disposed) return;
                // hosts.json 可能被用户手改过：一次 stat，变了就静默对齐（不注入任何消息）。
                reconcileHostsIfChanged();
                if (!config) return;
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
                    // 只有"连接完整"（工具 + env 都到位）才清 latch；env 没拉到必须继续重试，
                    // 否则会话会永久停在"工具有、环境是空的"这个中间态。
                    if ((await reconcile({probeIde: true})) === 'ready') needsRebuild = false;
                } catch {
                    // best effort: the latch stays set and the next message retries
                }
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
                    // IDE 自带工具的描述整段替换：只在原文说错、或关键事实没说时改。
                    applyDescriptionOverrides(editor, prefixes());
                });
            }
            if (typeof ctx.tool?.hook === 'function') {
                toolBeforeRegistration = await ctx.tool.hook('execute.before', async (event) => {
                    if (typeof event?.tool !== 'string') return;
                    applyIdeToolDefaults(event.tool, event.input, prefixes());
                    // 下限抬升与"固定值"是两件事:前者保留调用方更大的值,所以参数继续留在 schema 里。
                    raiseMinimumArguments(event.tool, event.input, prefixes());
                    // `create.before` 只改进程创建前的 env；shell 启动脚本（~/.zshenv 里的 brew shellenv、
                    // `export PATH="...:$PATH"`）会在那之后把 PATH 再排一遍，把注入的 SDK 挤到后面。
                    // 这里在命令文本最前面再前置一次，优先级才是真的。
                    if (event.tool !== 'shell' && event.tool !== 'bash') return;
                    const input = event.input;
                    if (!input || typeof input.command !== 'string' || input.command === '') return;
                    if (!projectEnv || Date.now() - projectEnvAt > PROJECT_ENV_TTL_MS) {
                        await loadProjectEnv().catch(() => false);
                    }
                    const path = projectEnv?.PATH;
                    if (!path) return;
                    const quoted = path
                        .split(':')
                        .filter(Boolean)
                        .map((entry) => `'${entry.replaceAll("'", `'\\''`)}'`)
                        .join(':');
                    input.command = `export PATH=${quoted}:"$PATH"\n${input.command}`;
                });
            }

            // The only self-initiated action: when an IDE tool call fails in a way
            // that means the IDE MCP is not usable, run the open flow again. The
            // failure is classified — a plain business error (a bad path, a missing
            // file) never triggers a reconnect, only "the MCP is not available" or
            // "the project is not open in the IDE" do.
            if (typeof ctx.tool?.hook === 'function') {
                toolRegistration = await ctx.tool.hook('execute.after', async (event) => {
                    // hosts.json 可能被这次工具调用改过：一次 stat，变了就静默对齐。
                    reconcileHostsIfChanged();
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
                        // 只有当前项目的 IDE 需要重开。
                        const project = projectForTool(event.tool);
                        const app = project ? ideAppName() : undefined;
                        if (!project || !app) return;
                        await openInIde(project.path, {app});
                        rewriteToolError(
                            event,
                            '该项目已在 IntelliJ IDEA 中重新打开,请重试刚才的操作。',
                        );
                        return;
                    }
                    const result = await runOpenInIdea();
                    // 这里只关心"工具调用能不能重试"：IDE 连上了（port 有值）就够了。
                    // 环境变量没拉到属于后续 shell 的问题，由 `/open-in-ide` 与自愈去修，
                    // 不该让这次工具调用失去重试的提示。
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
            if (shellRegistration) {
                try {
                    await shellRegistration.dispose();
                } catch {
                    // best effort
                }
            }
            if (remoteToolsRegistration) {
                try {
                    await remoteToolsRegistration.dispose();
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
