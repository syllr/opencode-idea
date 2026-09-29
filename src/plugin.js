// opencode-idea — OpenCode plugin entry.
//
// For a project the user opted into IDEA this plugin:
//   1. registers the IDE MCP server with OpenCode — by default as the IDE's
//      stdio bridge (`idea stdioMcpServer`), scoped to the project through
//      `IJ_MCP_SERVER_PROJECT_PATH` — injects direct-call guidance for IDEA MCP
//      tools, and updates only IDEA MCP tool descriptions;
//   2. registers the `/open-in-idea` command, which opens the current project
//      in IntelliJ IDEA (reusing a running instance), loads the IDE
//      capabilities immediately, and marks the project as an IDEA project;
//      `/close-in-idea` clears that mark;
//   3. registers the `idea-run-config` skill (marked projects only), which
//      teaches the model how to manage `.run/*.run.xml` run configurations — a
//      capability the IDE MCP server does not expose.
//
// A project that was never marked is left untouched. Everything is manual:
// setup does NOT probe or connect the IDE. `/open-in-idea` probes, opens the
// IDE, and loads the IDE MCP + guidance on demand.
//
// `/open-in-idea` opens the project in the IDE, waits until its MCP endpoint is
// ready, registers `idea` (stdio, project-scoped) and marks the project in
// `ctx.storage`; `/close-in-idea` unregisters the server and clears the mark.
// A live endpoint alone does NOT mean our project is open there (the running IDE
// may have a different project open), so the open flow asks the IDE directly —
// one project-scoped MCP call — and runs `open -a` only when the project is not
// open yet.
// The mark gates the IDEA skills and the failure-driven recovery. After a manual
// open, an `idea_*` call that fails because the IDE MCP is not usable (the server
// dropped, or the project is not open in the IDE) re-runs the open flow; a plain
// business error is classified apart and left alone. Because a stdio bridge whose
// IDE connection drops never reports it (it hangs), a background heartbeat probes
// the IDE endpoint and, once it is clearly gone, deactivates the server — killing
// the zombie bridge and removing the tools so a call cannot hang — and the next
// user message rebuilds it.
//
// `Plugin.define` from `@opencode/plugin` is an identity function, so a plain
// `{ id, setup }` object is the whole plugin contract. Exporting it directly
// keeps this package dependency-free at runtime.

import {
  DEFAULT_PORTS,
  IDEA_SERVER_NAME,
  callTool,
  findIdePort,
  serverConfig,
  stdioServerConfig,
} from './mcp/idea.js';
import { currentProjectPath } from './project.js';
import {
  createLaunchGuard,
  DEFAULT_IDE_APP,
  openInIde,
  resolveIdeApp,
  resolveIdeExecutable,
} from './ide-launcher.js';
import {
  appendIdeGuidance,
  appendIdeRecoveryGuidance,
} from './ide-guidance.js';
import { readSkills } from './skill/loader.js';

const DEFAULT_LAUNCH_COOLDOWN_MS = 120000;
const DEFAULT_LAUNCH_MAX_ATTEMPTS = 5;
// MCP availability is a fast preflight. If it is not ready, fail fast and let
// the user enable MCP + Brave Mode in IDEA before retrying the command.
const DEFAULT_MCP_PROBE_TIMEOUT_MS = 1000;
// A cold IDE can take tens of seconds before its bundled MCP server listens.
// After `open -a`, poll for the endpoint instead of reporting failure once.
const DEFAULT_MCP_START_TIMEOUT_MS = 60000;
const MCP_START_POLL_MS = 1000;
const DEFAULT_TOOL_REFRESH_TIMEOUT_MS = 5000;
const TOOL_REFRESH_POLL_MS = 25;
// Hard cap on ONE IDE MCP tool call. OpenCode's own default is 12 hours, and the
// IDE's stdio bridge NEVER answers a call once its upstream IDE connection has
// dropped (it logs on stderr but sends no JSON-RPC response) — so a call made
// after the IDE died would otherwise sit unresolved for 12h. 10 minutes is far
// beyond any normal IDE tool and turns that permanent hang into a normal error.
const DEFAULT_EXECUTION_TIMEOUT_MS = 600000;
// Background IDE liveness probe. The stdio bridge NEVER reports a dropped IDE
// connection (it just hangs), so the plugin watches the IDE endpoint itself.
// After HEARTBEAT_FAILURES consecutive misses it deactivates the `idea` server
// — which kills the zombie bridge child AND removes the `idea_*` tools, so the
// model can never call into a dead pipe — and latches a rebuild for the next
// user message (the bridge never heals on its own).
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;
const DEFAULT_HEARTBEAT_FAILURES = 2;
const IDEA_READY_TOOL_IDS = new Set(['idea_read_file', 'idea_apply_patch']);

/**
 * IDEA MCP tools that must never reach the model.
 *
 * Grouped by the IDE's Exposed Tools page so the list stays auditable. Anything
 * listed here is stripped from every model request, even while the IDE is up.
 *
 * - VCS: `idea_git_status` returns porcelain codes only and
 *   `idea_get_repositories` is covered by the native git tool, which also
 *   handles diff/log/blame.
 * - Router: `idea_execute_tool` is the IDE's router-mode dispatcher. Router-only
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
 *   Hidden; project commands run through the IDE terminal instead, which is
 *   already launched with the IDE's real environment.
 * - Database data sources: connections are configured by the user in the IDE,
 *   so the AI only reads and queries them; create/edit stay hidden.
 *
 * NOT hidden: `idea_execute_terminal_command`. Project commands must run with
 * the SDKs the user configured in the IDE (JDK, Node, Python, ...), so the model
 * uses the IDE's integrated terminal for them. `executeInShell: true` runs the
 * command in the user's real shell (`zsh`/`bash`), which inherits the IDE
 * environment — including version managers such as fnm / SDKMAN whose selection
 * lives in shell init and cannot be reconstructed from a handful of variables.
 * Requires Brave Mode in the IDE; without it the IDE asks for confirmation.
 */
export const HIDDEN_IDEA_TOOLS = [
  // VCS
  'idea_git_status',
  'idea_get_repositories',
  // Router
  'idea_execute_tool',
  // Debugger
  'idea_xdebug_control_session',
  'idea_xdebug_evaluate_expression',
  'idea_xdebug_get_debugger_status',
  'idea_xdebug_get_frame_values',
  'idea_xdebug_get_stack',
  'idea_xdebug_get_threads',
  'idea_xdebug_get_value_by_path',
  'idea_xdebug_list_breakpoints',
  'idea_xdebug_remove_breakpoint',
  'idea_xdebug_run_to_line',
  'idea_xdebug_set_breakpoint',
  'idea_xdebug_set_variable',
  'idea_xdebug_start_debugger_session',
  // Dev Kit MCP
  'idea_collect_split_mode_compatibility_issues',
  'idea_create_ij_module',
  'idea_find_lock_requirements_usages',
  'idea_find_threading_requirements_usages',
  'idea_recognize_ij_module_kind',
  'idea_recognize_split_mode_api_kind',
  // Inspection KTS MCP
  'idea_generate_inspection_kts_api',
  'idea_generate_inspection_kts_examples',
  'idea_generate_psi_tree',
  'idea_run_inspection_kts',
  // Python Environment MCP
  'idea_configure_python_interpreter',
  'idea_get_python_environment',
  // Database data sources: the user configures them in the IDE, the AI only
  // reads and queries them.
  'idea_create_database_connection',
  'idea_edit_database_connection',
];

/**
 * Remove the given IDEA MCP definitions from one request's tool record.
 *
 * @param {Record<string, unknown> | undefined} tools
 * @param {readonly string[]} names
 */
function removeIdeaToolDefinitions(tools, names) {
  if (!tools || typeof tools !== 'object') return 0;
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith('idea_') || !(name in tools)) continue;
    delete tools[name];
    removed += 1;
  }
  return removed;
}

/** @param {ReadonlyArray<{ id?: string }> | undefined} tools */
function toolIds(tools) {
  return (tools ?? []).map((tool) => tool.id).filter((id) => typeof id === 'string').sort();
}

/**
 * Classify an `idea_*` tool failure for the reconnect decision.
 *
 * It must never mistake a plain business error (a bad path, a missing file) for
 * a broken connection, so only two shapes trigger action:
 *
 * - `project`: the IDE is up but the requested project is not open in it, e.g.
 *   "`projectPath`=... doesn't correspond to any open project." Re-opening the
 *   project fixes it.
 * - `mcp`: the IDE MCP server itself is gone (dropped / transport closed).
 *
 * Everything else is `none`.
 *
 * @param {{ message?: unknown } | undefined} error
 * @returns {'project' | 'mcp' | 'none'}
 */
function classifyIdeaFailure(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  // "Project not open in the IDE" comes in two shapes, both meaning the same
  // thing and both fixed by opening the project again:
  //   - the called tool carried no `projectPath`, so the server could not pick
  //     one: "Unable to determine the target project for the current MCP tool
  //     call." (this is what the plugin's stdio registration produces, since it
  //     sets the project through env, not through the call)
  //   - an explicit `projectPath` was passed but is not open: "`projectPath`=...
  //     doesn't correspond to any open project."
  if (
    message.includes('Unable to determine the target project') ||
    message.includes('correspond to any open project')
  ) {
    return 'project';
  }
  // Only transport-level markers, which OpenCode / the IDE bridge emit
  // themselves. The message of an MCP *tool error* is the tool's own content
  // (`tool/mcp.ts` turns `result.isError` into `ToolFailure({ message: <text> })`),
  // so a generic string such as "Connection refused" from a SQL or run-config
  // tool would otherwise be misread as a dropped connection and rebuild a
  // healthy bridge.
  if (
    message.includes(`MCP server "${IDEA_SERVER_NAME}" is not available`) ||
    message.includes('MCP server is not connected') ||
    message.includes('Error POSTing to endpoint') ||
    message.includes('SseClientTransport is closed')
  ) {
    return 'mcp';
  }
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
      const next = { message };
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
 *   status: 'connected' | 'tools-loading' | 'mcp-unavailable' | 'launch-failed' | 'disabled' | 'closed',
 *   port?: number,
 *   opened?: boolean,
 *   unavailableNoticeSent?: boolean
 * }} IdeCommandResult
 */

/**
 * @param {unknown} value
 * @param {unknown} fallback
 */
const asArray = (value, fallback) => (Array.isArray(value) && value.length > 0 ? value : fallback);

/**
 * @param {unknown} value
 * @param {number} fallback
 */
const asPositiveNumber = (value, fallback) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

/** User-facing status text for a `/open-in-idea` result. */
/** @param {IdeCommandResult} result */
export function ideFeedback(result) {
  switch (result?.status) {
    case 'connected':
      return 'IDE MCP 已连接;IDEA 原生工具已注册并可用于后续请求。';
    case 'tools-loading':
      return 'IDE MCP 已连接,但原生 IDEA 工具列表尚未完成注册。请稍后再次执行 /open-in-idea。';
    case 'mcp-unavailable':
      return result?.opened
        ? '已请求打开/激活 IntelliJ IDEA 并等待 MCP 服务启动,但未检测到 MCP 服务。请在 IDEA 中开启 MCP 服务(Settings → MCP Server,需 2026.2+)并启用 Brave Mode,然后再次执行 /open-in-idea。'
        : '未检测到 IntelliJ IDEA 的 MCP 服务。请确认 IDEA 已打开,在 Settings → MCP Server 开启 MCP 服务并启用 Brave Mode,然后再次执行 /open-in-idea。';
    case 'launch-failed':
      return '无法拉起 IntelliJ IDEA(未找到应用或启动失败)。请确认已安装 IDEA,或手动打开后重试 /open-in-idea。';
    case 'disabled':
      return '插件已通过 openInIde: false 关闭 IDE 启动。请手动打开 IntelliJ IDEA,在 Settings → MCP Server 开启 MCP 服务并启用 Brave Mode,然后重试 /open-in-idea。';
    case 'closed':
      return '已关闭当前项目的 IDEA 接入:已注销 IDE MCP 并清除项目标记。如需重新接入,请再次执行 /open-in-idea。';
    default:
      return '已处理 /open-in-idea。';
  }
}

/**
 * The text the MODEL sees for `/open-in-idea` feedback. It is explicitly a
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
  return { displayText: ideFeedback(result), comments: [] };
}

export default {
  id: 'opencode-idea',

  /**
   * @param {{
   *   location?: unknown,
   *   options?: {
   *     ports?: number[],
   *     openInIde?: boolean | string,
   *     launchCooldownMs?: number,
   *     launchMaxAttempts?: number,
   *     mcpProbeTimeoutMs?: number,
   *     mcpStartTimeoutMs?: number,
   *     toolRefreshTimeoutMs?: number,
   *     executionTimeoutMs?: number,
   *     heartbeatIntervalMs?: number,
   *     heartbeatFailures?: number,
   *     transport?: 'stdio' | 'http',
   *     ideExecutable?: string,
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
   *     hook?: (name: string, cb: (event: {
   *       tool?: string,
   *       sessionID?: string,
   *       status?: string,
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
    const ports = asArray(options.ports, DEFAULT_PORTS);
    const injectGuidance = options.injectGuidance !== false;
    const ideApp = resolveIdeApp(options.openInIde);
    // Transport for the IDE MCP server. `stdio` (default) registers the IDE's
    // stdio bridge as a local server: the client side is a child-process pipe,
    // which — unlike the remote Streamable-HTTP stream — does not get closed
    // while idle and never reconnected. `http` keeps the older remote config.
    const transport = options.transport === 'http' ? 'http' : 'stdio';
    const ideExecutable = typeof options.ideExecutable === 'string'
      ? options.ideExecutable
      // Resolve independently of `openInIde`: that option only controls whether
      // the plugin may LAUNCH the IDE, not which transport the MCP server uses.
      // Falling back to the default app when launching is disabled keeps stdio
      // the default there too (otherwise `openInIde: false` silently registered
      // the remote HTTP transport).
      : resolveIdeExecutable(ideApp ?? DEFAULT_IDE_APP);
    const useStdio = transport === 'stdio' && typeof ideExecutable === 'string';
    const mcpProbeTimeoutMs = asPositiveNumber(options.mcpProbeTimeoutMs, DEFAULT_MCP_PROBE_TIMEOUT_MS);
    const mcpStartTimeoutMs = asPositiveNumber(options.mcpStartTimeoutMs, DEFAULT_MCP_START_TIMEOUT_MS);
    const toolRefreshTimeoutMs = asPositiveNumber(options.toolRefreshTimeoutMs, DEFAULT_TOOL_REFRESH_TIMEOUT_MS);
    // Cap on a single IDE tool call, so a bridge that hangs (IDE died) fails in
    // finite time instead of OpenCode's 12h default. See DEFAULT_EXECUTION_TIMEOUT_MS.
    const executionTimeoutMs = asPositiveNumber(options.executionTimeoutMs, DEFAULT_EXECUTION_TIMEOUT_MS);
    const heartbeatIntervalMs = asPositiveNumber(options.heartbeatIntervalMs, DEFAULT_HEARTBEAT_INTERVAL_MS);
    const heartbeatFailures = asPositiveNumber(options.heartbeatFailures, DEFAULT_HEARTBEAT_FAILURES);
    // "message" (default) injects a clearly-labelled notification that the
    // model only acknowledges ("收到"); the user sees the clean notice via
    // metadata.displayText. false is silent.
    const feedback = options.feedback === false ? false : 'message';
    const guard = createLaunchGuard({
      cooldownMs: asPositiveNumber(options.launchCooldownMs, DEFAULT_LAUNCH_COOLDOWN_MS),
      maxAttempts: asPositiveNumber(options.launchMaxAttempts, DEFAULT_LAUNCH_MAX_ATTEMPTS),
    });

    /** @type {Array<{ dispose: () => Promise<void> | void }>} */
    let registrations = [];
    /** @type {{ dispose: () => Promise<void> | void } | undefined} */
    let sessionRegistration;
    /** @type {{ dispose: () => Promise<void> | void } | undefined} */
    let toolRegistration;
    /** @type {{ dispose: () => Promise<void> | void } | undefined} */
    let promptRegistration;
    /** @type {{ dispose: () => Promise<void> | void } | undefined} */
    let commandRegistration;
    /** @type {{ dispose: () => Promise<void> | void } | undefined} */
    let skillRegistration;
    let skillsRegistered = false;
    let disposed = false;

    // Background heartbeat state (see DEFAULT_HEARTBEAT_INTERVAL_MS).
    /** @type {ReturnType<typeof setInterval> | undefined} */
    let heartbeatTimer;
    let heartbeatMisses = 0;
    // Latches when the IDE was seen down and the server was deactivated. It is
    // cleared ONLY by a successful rebuild — never by the endpoint coming back —
    // because the bridge does not heal on its own.
    let needsRebuild = false;

    // Project-level mark: has the user opted this project into IDEA via
    // `/open-in-idea`? One plugin instance serves one project (OpenCode
    // activates plugins per Location), so a single boolean is the whole cache.
    // The durable copy lives in `ctx.storage` under `project/<projectPath>`.
    // The commands are the only writers: they persist first, then invalidate
    // this cache so the next read comes back from storage.
    const storage = ctx.storage;
    const markKey = `project/${projectPath}`;
    /** @type {boolean | undefined} undefined = a storage read is due */
    let markCache;

    /** Read the durable mark into the cache; at most one storage read per invalidation. */
    const readMark = async () => {
      if (markCache !== undefined) return markCache;
      if (!storage || typeof storage.get !== 'function') {
        markCache = false;
        return markCache;
      }
      try {
        markCache = (await storage.get(markKey)) === true;
      } catch {
        // storage is best effort; fall back to unmarked
        markCache = false;
      }
      return markCache;
    };

    /**
     * Persist the mark, then invalidate the cache so the next reader re-reads
     * storage. Best effort: an in-memory invalidation still applies if the write
     * fails.
     * @param {boolean} marked
     */
    const setMark = async (marked) => {
      try {
        if (marked) await storage?.set?.(markKey, true);
        else await storage?.remove?.(markKey);
      } catch {
        // best effort
      }
      // Keep the in-memory cache in sync with the write (write-through), so any
      // later synchronous reader sees the new value immediately.
      markCache = marked;
      // The skill lifecycle follows the mark: marking the project registers the
      // IDEA skills, clearing the mark removes them again. Same semantics as the
      // reconnect behavior, so the two can never disagree.
      if (marked) await ensureSkills();
      else await removeSkills();
    };

    // Resolve the mark once, so the request hooks can read it synchronously.
    await readMark();

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

    const waitForIdeaTools = async () => {
      if (typeof ctx.tool?.list !== 'function') return false;
      const deadline = Date.now() + toolRefreshTimeoutMs;
      while (Date.now() < deadline) {
        try {
          const ids = toolIds(await ctx.tool.list());
          if ([...IDEA_READY_TOOL_IDS].every((id) => ids.includes(id))) return true;
        } catch {
          // The MCP catalog may still be settling; retry within the bounded wait.
        }
        await new Promise((resolve) => setTimeout(resolve, TOOL_REFRESH_POLL_MS));
      }
      return false;
    };

    const refreshIdeTools = async () => {
      if (typeof ctx.mcp.reload === 'function') await ctx.mcp.reload();
      // Reconcile the MCP servers above, then replay the tool registry so the
      // refreshed catalog lands in the next model request's tool snapshot.
      // Without this, a session that already captured a snapshot keeps the old
      // tool list until the session is reopened.
      if (typeof ctx.tool?.reload === 'function') await ctx.tool.reload();
      return waitForIdeaTools();
    };

    const activateIde = async (port) => {
      const config = useStdio
        ? stdioServerConfig(ideExecutable, port, projectPath, { executionTimeoutMs })
        : serverConfig(port, projectPath, { executionTimeoutMs });
      const mcpRegistration = await ctx.mcp.transform((editor) => {
        editor.set(IDEA_SERVER_NAME, config);
      });
      registrations = [mcpRegistration];
      return refreshIdeTools();
    };

    const reconcileOnce = async ({ probeIde = true } = {}) => {
      if (disposed) return false;

      // Manual: only `/open-in-idea` probes the IDE. Setup calls this with
      // `probeIde: false` so it never connects until the command asks.
      const port = probeIde ? await findIdePort(ports, { timeoutMs: mcpProbeTimeoutMs }) : undefined;
      const isJetBrains = markCache === true || port !== undefined;
      if (!isJetBrains) {
        await deactivateIde();
        return false;
      }

      // Always tear the server down and register it again. A stdio bridge whose
      // IDE connection dropped becomes a permanent zombie: the child process is
      // still alive, so OpenCode keeps reporting it as connected, never restarts
      // it, and SKIPS a re-`set` whose config is unchanged (`reconcile()` compares
      // the config). Disposing the registration removes the server from the
      // reconciled config, which is what actually kills the child process — so a
      // full rebuild is the only reliable way back to a working bridge.
      // `/open-in-idea` is manual and rare; rebuilding an already-healthy bridge
      // costs one restart, which is the right trade for never leaving a zombie.
      await deactivateIde();
      if (port === undefined) return false;
      return activateIde(port);
    };

    // Serialize reconciles so overlapping callers can never register/activate
    // the IDE concurrently (which would leak registrations).
    let reconcileChain = Promise.resolve();
    const enqueue = (task) => {
      const next = reconcileChain.then(task);
      reconcileChain = next.then(
        () => {},
        () => {},
      );
      return next;
    };
    const reconcile = (options) => enqueue(() => reconcileOnce(options));

    /**
     * `open -a` only requests activation/opening. A cold IDE needs time before
     * its bundled MCP server listens, so poll until the endpoint appears. This
     * is the step that makes a single `/open-in-idea` enough on a cold start.
     *
     * @returns {Promise<number | undefined>}
     */
    const waitForIdeServer = async () => {
      const deadline = Date.now() + mcpStartTimeoutMs;
      while (Date.now() < deadline) {
        const port = await findIdePort(ports, { timeoutMs: mcpProbeTimeoutMs }).catch(() => undefined);
        if (port !== undefined) return port;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(MCP_START_POLL_MS, remaining)));
      }
      return undefined;
    };

    /**
     * Is `projectPath` actually OPEN in the IDE that serves `port`?
     *
     * A live endpoint only means the IDE is RUNNING — it may have a different
     * project open (or sit on the Welcome screen), while everything we do is
     * scoped to THIS project. So ask the IDE directly with one project-scoped
     * call: the server resolves the project from `IJ_MCP_SERVER_PROJECT_PATH`
     * BEFORE running the tool, and for a project that is not open it fails with
     * "Unable to determine the target project ..." — the same shape
     * `classifyIdeaFailure` maps to `project`. Any other outcome (a real result,
     * or an unrelated tool error) means the project WAS resolved, i.e. open.
     *
     * A transport failure (`undefined`) counts as "not confirmed open", so the
     * caller still asks the IDE to open the project: `open -a` is idempotent,
     * and the only cost is a redundant focus.
     *
     * @param {number} port
     */
    const isProjectOpen = async (port) => {
      const result = await callTool(port, projectPath, 'get_project_modules', {}).catch(() => undefined);
      if (!result) return false;
      if (result.isError !== true) return true;
      const text = (result.content ?? [])
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n');
      return classifyIdeaFailure({ message: text }) !== 'project';
    };

    // Re-entrant: repeat invocations share one open request so the IDE is not
    // spawned twice while the application is starting.
    /** @type {Promise<IdeCommandResult> | undefined} */
    let launchInFlight;
    let launchNoticeSent = false;
    /**
     * @param {{ onUnavailable?: (result: IdeCommandResult) => Promise<boolean> }} [options]
     * @returns {Promise<IdeCommandResult>}
     */
    const ensureIde = ({ onUnavailable } = {}) => {
      if (launchInFlight) return launchInFlight;
      launchNoticeSent = false;
      const reportUnavailable = async (opened) => {
        if (launchNoticeSent || typeof onUnavailable !== 'function') return;
        // Fast-fail: notify as soon as the endpoint is known to be missing so
        // the user can enable MCP + Brave Mode and retry the command.
        const delivered = await onUnavailable({ status: 'mcp-unavailable', opened });
        if (delivered) launchNoticeSent = true;
      };
      const run = (async () => {
        const serving = await findIdePort(ports, { timeoutMs: mcpProbeTimeoutMs }).catch(() => undefined);
        if (serving !== undefined) {
          guard.reset();
          launchNoticeSent = false;
          // The endpoint being up proves only that the IDE is RUNNING — it may
          // have a DIFFERENT project open. Ask the IDE whether THIS project is
          // open, and only request an open when it is not: for an already-open
          // project the IDE runs a short reopen-then-dispose cycle on a
          // redundant open event, so skipping it is a real saving.
          if (ideApp && !(await isProjectOpen(serving))) {
            await openInIde(projectPath, { app: ideApp });
          }
          return { status: 'connected', port: serving, unavailableNoticeSent: false };
        }
        if (!ideApp) return { status: 'disabled' };
        if (guard.exhausted()) {
          await reportUnavailable(false);
          return { status: 'mcp-unavailable', opened: false, unavailableNoticeSent: launchNoticeSent };
        }
        if (guard.coolingDown()) {
          // There is no reason to wait here: MCP is disabled/not ready, and
          // the user must enable it in IDEA before retrying the command.
          await reportUnavailable(false);
          return { status: 'mcp-unavailable', opened: false, unavailableNoticeSent: launchNoticeSent };
        }
        guard.markSpawn();
        const launched = await openInIde(projectPath, { app: ideApp });
        if (!launched) return { status: 'launch-failed' };
        // `open -a` only requests activation/opening. A cold IDE needs time to
        // start its bundled MCP server, so wait for the endpoint instead of
        // reporting failure immediately.
        const started = await waitForIdeServer();
        if (started !== undefined) {
          guard.reset();
          launchNoticeSent = false;
          return { status: 'connected', port: started, unavailableNoticeSent: false };
        }
        await reportUnavailable(true);
        return { status: 'mcp-unavailable', opened: true, unavailableNoticeSent: launchNoticeSent };
      })();
      launchInFlight = run;
      void run
        .catch(() => {})
        .then(() => {
          if (launchInFlight === run) launchInFlight = undefined;
        });
      return run;
    };

    /**
     * The whole `/open-in-idea` flow, shared by the command and the auto-recovery
     * path: ensure an IDE MCP endpoint, then register it and load capabilities.
     *
     * @param {{ onUnavailable?: (result: IdeCommandResult) => Promise<boolean> }} [options]
     * @returns {Promise<IdeCommandResult>}
     */
    const runOpenInIdea = async ({ onUnavailable } = {}) => {
      const result = await ensureIde({ onUnavailable });
      const { port } = result;
      let toolsReady = false;
      try {
        // Do not repeat the expensive probe when the preflight already found no
        // MCP endpoint. The command will retry after the user enables MCP +
        // Brave Mode.
        toolsReady = (await reconcile({ probeIde: port !== undefined })) === true;
      } catch {
        // capability load is best effort; feedback still matters
      }
      return result.status === 'connected' && !toolsReady
        ? { ...result, status: 'tools-loading' }
        : result;
    };

    // Setup never probes or connects the IDE — everything is on `/open-in-idea`.
    await reconcile({ probeIde: false });

    /**
     * One heartbeat tick. Only marked projects are watched, and it only acts
     * when an `idea` server is actually registered: the point is to protect an
     * ESTABLISHED connection. A project that never connected has no zombie to
     * kill, and must not have IDEA launched on its behalf. The deactivation
     * runs under the reconcile chain, so a tick cannot race `/open-in-idea`.
     */
    let heartbeatBusy = false;
    const heartbeatTick = async () => {
      if (disposed || heartbeatBusy) return;
      if (markCache !== true || registrations.length === 0) {
        heartbeatMisses = 0;
        return;
      }
      heartbeatBusy = true;
      try {
        const port = await findIdePort(ports, { timeoutMs: mcpProbeTimeoutMs }).catch(() => undefined);
        if (port !== undefined) {
          heartbeatMisses = 0;
          return;
        }
        heartbeatMisses += 1;
        if (heartbeatMisses < heartbeatFailures) return;
        // The IDE is gone. Deactivating kills the zombie bridge child and
        // removes the `idea_*` tools, so the model cannot call into a dead
        // pipe. Latch a rebuild for the next user message.
        const kicked = await enqueue(async () => {
          if (disposed || registrations.length === 0) return false;
          await deactivateIde();
          return true;
        });
        if (kicked) needsRebuild = true;
      } finally {
        heartbeatBusy = false;
      }
    };
    heartbeatTimer = setInterval(() => {
      heartbeatTick().catch(() => {});
    }, heartbeatIntervalMs);
    // Never keep the host process alive just to probe (also keeps tests from hanging).
    if (typeof heartbeatTimer?.unref === 'function') heartbeatTimer.unref();

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

    // The shipped skills are static knowledge (`skills/<id>/SKILL.md`), e.g. the
    // run-configuration workflow: where `.run/*.run.xml` live, how to bootstrap a
    // schema from a real example, and how to verify a write. Registered only for
    // a project that has been marked as an IDEA project, so unrelated projects
    // never see an IDEA-specific skill.
    //
    // Deliberately NOT wrapped in a catch: these are core features of the plugin,
    // so a rejected definition must fail loudly. Swallowing it would ship a
    // silently incomplete plugin — which is exactly how 0.0.6 lost
    // `/open-in-idea` without anyone noticing until the command was gone.
    const ensureSkills = async () => {
      if (skillsRegistered || typeof ctx.skill?.transform !== 'function') return;
      skillsRegistered = true;
      // Read the documents before the transform: callbacks must stay synchronous.
      const skills = readSkills();
      skillRegistration = await ctx.skill.transform((editor) => {
        for (const skill of skills) editor.add(skill);
      });
    };
    /** Remove the IDEA skills again when the project is unmarked. */
    const removeSkills = async () => {
      if (!skillsRegistered || !skillRegistration) return;
      skillsRegistered = false;
      const registration = skillRegistration;
      skillRegistration = undefined;
      try {
        await registration.dispose();
      } catch {
        // best effort
      }
    };
    // A project marked in an earlier run gets its skills at setup; a project
    // marked for the first time gets them when `/open-in-idea` runs (both paths
    // go through `setMark` / this setup hook).
    if (markCache === true) await ensureSkills();

    // `/open-in-idea`: manual, re-entrant trigger that also loads the IDE
    // capabilities immediately, and marks the project so later messages keep the
    // IDE alive. `/close-in-idea` removes that mark. Both persist through
    // `ctx.storage` and invalidate the in-memory cache.
    if (typeof ctx.command?.transform === 'function') {
      commandRegistration = await ctx.command.transform((editor) => {
        editor.add({
          name: 'open-in-idea',
          description: '用 IntelliJ IDEA 打开当前项目,并即时加载 IDE MCP 与项目 SDK 环境',
          execute: async (input) => {
            // Mark the project before running: the mark means "this is an IDEA
            // project", so it is persisted as soon as the user asks, whether or
            // not the IDE happens to be reachable right now. `setMark` also
            // registers the IDEA skills.
            await setMark(true);
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
          name: 'close-in-idea',
          description: '取消当前项目的 IDEA 接入:注销 IDE MCP 并清除项目标记',
          execute: async (input) => {
            await setMark(false);
            // Unregister the IDE MCP server and clear the injected env. Reuses
            // the serialized reconcile, so a concurrent rebuild (an in-flight
            // `/open-in-idea`, or a heartbeat tick) cannot re-register the
            // server after the mark is gone.
            await reconcile({ probeIde: false });
            await sendFeedback(input, { status: 'closed' });
          },
        });
      });
    }

    // Hide the tools the model must not see, and point it at the rest. This hook
    // runs for every agent-loop step (including tool-driven continuations), so
    // it stays a cheap, I/O-free function of the request: it checks the cached
    // project mark and this request's own tool snapshot, and takes no action.
    //
    // `event.tools` is this request's tool snapshot, and OpenCode's own registry
    // adds IDEA tools when the server connects and drops them when it stops
    // (`stopServer` publishes `mcp.tools.changed`, which the registry turns into
    // a reload). So the snapshot is also the honest answer to "is the IDE
    // serving?".
    if (typeof ctx.session?.hook === 'function') {
      sessionRegistration = await ctx.session.hook('context', (event) => {
        const tools = event?.tools;
        const serving = tools !== undefined && Object.keys(tools).some((name) => name.startsWith('idea_'));
        if (serving) removeIdeaToolDefinitions(tools, HIDDEN_IDEA_TOOLS);
        if (markCache === true || serving) appendIdeRecoveryGuidance(event?.system, { marked: markCache === true });
        if (!injectGuidance) return;
        // Guidance promises tools the model can call, so it only goes out when
        // they are actually in this request.
        if (!serving) return;
        appendIdeGuidance(event?.system, projectPath);
      });

      // Rebuild after a heartbeat-detected drop. It reads only the in-memory
      // `needsRebuild` latch, so it is a cheap no-op on every other message.
      // OpenCode awaits `prompt` before the request is built, so when the IDE is
      // back, the message that triggers this already carries working tools.
      promptRegistration = await ctx.session.hook('prompt', async (event) => {
        if (disposed || !needsRebuild || markCache !== true) return;
        // Never react to the plugin's own notices, or recovery would feed on
        // itself. Match the notice TEXT, never `metadata.displayText`: OpenCode
        // also sets `displayText` on ordinary user messages (it is the message
        // text itself), so a displayText guard silently skips every real message
        // — verified live, and it made this rebuild never run.
        const text = event?.prompt?.text;
        if (typeof text === 'string' && text.startsWith(NOTICE_PREFIX)) return;
        const result = await runOpenInIdea();
        if (result.port !== undefined) {
          needsRebuild = false;
          heartbeatMisses = 0;
        }
      });

      // The only self-initiated action: when an `idea_*` call fails in a way
      // that means the IDE MCP is not usable, run the open flow again. The
      // failure is classified — a plain business error (a bad path, a missing
      // file) never triggers a reconnect, only "the MCP is not available" or
      // "the project is not open in the IDE" do.
      if (typeof ctx.tool?.hook === 'function') {
        toolRegistration = await ctx.tool.hook('execute.after', async (event) => {
          if (event?.status !== 'error') return;
          if (typeof event?.tool !== 'string' || !event.tool.startsWith('idea_')) return;
          if (!(await readMark())) return;
          const kind = classifyIdeaFailure(event.error);
          if (kind === 'none') return;
          if (kind === 'project' && ideApp) {
            // The IDE is up; the project simply is not open in it. Ask the IDE
            // to open the project again, and tell the model to retry.
            await openInIde(projectPath, { app: ideApp });
            rewriteToolError(event, '该项目已在 IDEA 中重新打开,请重试刚才的操作。');
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
      if (heartbeatTimer) clearInterval(heartbeatTimer);
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
