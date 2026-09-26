// opencode-idea — OpenCode plugin entry.
//
// For a JetBrains project this plugin:
//   1. injects the IDE integrated-terminal environment (JAVA_HOME / GOROOT /
//      Node / Maven / ...) into every OpenCode shell;
//   2. registers the IDE MCP server with OpenCode (scoped to the project via the
//      IJ_MCP_SERVER_PROJECT_PATH header), injects direct-call guidance for
//      IDEA MCP tools, and updates only IDEA MCP tool descriptions;
//   3. registers the `/open-in-idea` command, which opens the current project
//      in IntelliJ IDEA (reusing a running instance) and then loads the IDE
//      capabilities immediately;
//   4. registers the `idea-run-config` skill (JetBrains projects only),
//      which teaches the model how to manage `.run/*.run.xml` run
//      configurations — a capability the IDE MCP server does not expose.
//
// Non-JetBrains projects are left untouched. Everything is manual: setup does
// NOT probe or connect the IDE (only the IDE-terminal env is read when a probe
// is requested). `/open-in-idea` probes, opens the IDE, and loads the IDE MCP +
// guidance on demand.
//
// `Plugin.define` from `@opencode/plugin` is an identity function, so a plain
// `{ id, setup }` object is the whole plugin contract. Exporting it directly
// keeps this package dependency-free at runtime.

import {
  DEFAULT_PORTS,
  IDEA_SERVER_NAME,
  findIdePort,
  serverConfig,
} from './idea-mcp.js';
import { readIdeTerminalEnv } from './ide-env.js';
import { currentProjectPath, hasIdeaDirectory } from './project.js';
import { applyEnv, mergeEnv } from './env.js';
import {
  createLaunchGuard,
  openInIde,
  resolveIdeApp,
} from './ide-launcher.js';
import {
  appendIdeGuidance,
  appendIdeRecoveryGuidance,
} from './ide-guidance.js';
import { runConfigSkill } from './ide-run-config-skill.js';

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
 *   Hidden; the IDE-injected shell env already carries the SDK paths.
 * - Database data sources: connections are configured by the user in the IDE,
 *   so the AI only reads and queries them; create/edit stay hidden.
 */
export const HIDDEN_IDEA_TOOLS = [
  // VCS
  'idea_git_status',
  'idea_get_repositories',
  // Router
  'idea_execute_tool',
  // Terminal: the plugin reads the IDE env through its own direct MCP call
  // (`src/ide-env.js`), so the model never needs this tool. Measured value for
  // the agent is nil: ~60s hard cutoff with no way to read the terminal buffer,
  // and the native shell already keeps the output tail plus a full-output file.
  'idea_execute_terminal_command',
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
 * @typedef {{
 *   status: 'connected' | 'tools-loading' | 'mcp-unavailable' | 'launch-failed' | 'disabled',
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
    default:
      return '已处理 /open-in-idea。';
  }
}

/**
 * The text the MODEL sees for `/open-in-idea` feedback. It is explicitly a
 * notification, not a task: the model must only acknowledge it. The user sees
 * the clean notice instead, via `metadata.displayText`.
 */
export function idePromptText(result) {
  return [`【插件通知】${ideFeedback(result)}`, '这是发给用户的通知,你无需处理。请只回复"收到"。'].join('\n\n');
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
   *     injectEnv?: boolean,
   *     openInIde?: boolean | string,
   *     launchCooldownMs?: number,
   *     launchMaxAttempts?: number,
   *     mcpProbeTimeoutMs?: number,
   *     mcpStartTimeoutMs?: number,
   *     toolRefreshTimeoutMs?: number,
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
   *       description: string,
   *       location: string,
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
   *   },
   *   mcp: {
   *     transform: (cb: (editor: { set: (name: string, config: unknown) => void }) => void) => Promise<{ dispose: () => Promise<void> | void }>,
   *     reload?: () => Promise<void>,
   *   },
   *   shell: { hook: (name: string, cb: (input: { env: Record<string, string | undefined> }) => void) => Promise<{ dispose: () => Promise<void> | void }> },
   * }} ctx
   */
  async setup(ctx) {
    const projectPath = currentProjectPath(ctx.location);
    if (!projectPath) return;
    // Where IDEA tools can exist at all. Computed once: the recovery guidance is
    // injected per model request, so it must not cost a filesystem check each
    // time, and unrelated projects must not receive IDEA prompts they can never
    // use.
    const isIdeaProject = hasIdeaDirectory(projectPath);

    const options = ctx.options || {};
    const ports = asArray(options.ports, DEFAULT_PORTS);
    const injectEnv = options.injectEnv !== false;
    const injectGuidance = options.injectGuidance !== false;
    const ideApp = resolveIdeApp(options.openInIde);
    const mcpProbeTimeoutMs = asPositiveNumber(options.mcpProbeTimeoutMs, DEFAULT_MCP_PROBE_TIMEOUT_MS);
    const mcpStartTimeoutMs = asPositiveNumber(options.mcpStartTimeoutMs, DEFAULT_MCP_START_TIMEOUT_MS);
    const toolRefreshTimeoutMs = asPositiveNumber(options.toolRefreshTimeoutMs, DEFAULT_TOOL_REFRESH_TIMEOUT_MS);
    // "message" (default) injects a clearly-labelled notification that the
    // model only acknowledges ("收到"); the user sees the clean notice via
    // metadata.displayText. false is silent.
    const feedback = options.feedback === false ? false : 'message';
    const guard = createLaunchGuard({
      cooldownMs: asPositiveNumber(options.launchCooldownMs, DEFAULT_LAUNCH_COOLDOWN_MS),
      maxAttempts: asPositiveNumber(options.launchMaxAttempts, DEFAULT_LAUNCH_MAX_ATTEMPTS),
    });
    let currentEnv = { env: {}, prependPath: [] };

    /** @type {Array<{ dispose: () => Promise<void> | void }>} */
    let registrations = [];
    /** @type {{ dispose: () => Promise<void> | void } | undefined} */
    let shellRegistration;
    /** @type {{ dispose: () => Promise<void> | void } | undefined} */
    let sessionRegistration;
    /** @type {{ dispose: () => Promise<void> | void } | undefined} */
    let commandRegistration;
    /** @type {{ dispose: () => Promise<void> | void } | undefined} */
    let skillRegistration;
    let disposed = false;

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
      const mcpRegistration = await ctx.mcp.transform((editor) => {
        editor.set(IDEA_SERVER_NAME, serverConfig(port, projectPath));
      });
      registrations = [mcpRegistration];
      return refreshIdeTools();
    };

    /**
     * Is the IDE MCP server contributing tools right now? OpenCode's registry is
     * the source of truth: it adds the tools when a server connects and drops
     * them when the connection stops (`stopServer` publishes `mcp.tools.changed`
     * and the registry reloads). No probe of our own is involved, and only
     * `/open-in-idea` asks, so the read is user-initiated.
     */
    const ideaToolsRegistered = async () => {
      if (typeof ctx.tool?.list !== 'function') return false;
      try {
        return toolIds(await ctx.tool.list()).some((id) => id.startsWith('idea_'));
      } catch {
        return false;
      }
    };

    const reconcileOnce = async ({ probeIde = true } = {}) => {
      if (disposed) return false;

      // Manual: only `/open-in-idea` probes the IDE. Setup calls this with
      // `probeIde: false` so it never connects until the command asks.
      const port = probeIde ? await findIdePort(ports, { timeoutMs: mcpProbeTimeoutMs }) : undefined;
      const isJetBrains = isIdeaProject || port !== undefined;
      if (!isJetBrains) {
        currentEnv = { env: {}, prependPath: [] };
        await deactivateIde();
        return false;
      }

      // Environment: read from the IDE integrated terminal, the single source
      // of truth for the environment the IDE actually runs with (version-managed
      // Node, goenv Go, SDKMAN Java, Maven, ...). Only available once the IDE is
      // connected, which is why the manual `/open-in-idea` drives it.
      const terminal = port === undefined ? {} : await readIdeTerminalEnv(port, projectPath);
      currentEnv = mergeEnv([{ env: terminal }]);

      if (injectEnv && !shellRegistration) {
        shellRegistration = await ctx.shell.hook('create.before', (input) => applyEnv(input, currentEnv));
      }

      // A live server is only refreshed; a dead one must be replaced, because
      // `reconcile()` skips an unchanged config and would never reconnect it.
      // The registry says which case this is.
      if (port !== undefined && (await ideaToolsRegistered())) return refreshIdeTools();
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

    // Setup never probes or connects the IDE — everything is on `/open-in-idea`.
    await reconcile({ probeIde: false });

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

    // The run-configuration skill is static knowledge — where `.run/*.run.xml`
    // live, how to bootstrap a schema from a real example, and how to verify a
    // write. JetBrains projects only, and independent of `/open-in-idea`.
    //
    // Deliberately NOT wrapped in a catch: this is a core feature of the plugin,
    // so a rejected definition must fail loudly. Swallowing it would ship a
    // silently incomplete plugin — which is exactly how 0.0.6 lost
    // `/open-in-idea` without anyone noticing until the command was gone.
    if (isIdeaProject && typeof ctx.skill?.transform === 'function') {
      // Read the document before the transform: callbacks must stay synchronous.
      const runConfigSkillDefinition = runConfigSkill();
      skillRegistration = await ctx.skill.transform((editor) => {
        editor.add(runConfigSkillDefinition);
      });
    }

    // `/open-in-idea`: manual, re-entrant trigger that also loads the IDE
    // capabilities immediately.
    if (typeof ctx.command?.transform === 'function') {
      commandRegistration = await ctx.command.transform((editor) => {
        editor.add({
          name: 'open-in-idea',
          description: '用 IntelliJ IDEA 打开当前项目,并即时加载 IDE MCP 与项目 SDK 环境',
          execute: async (input) => {
            /** @type {boolean} */
            let unavailableNoticeSent = false;
            const result = await ensureIde({
              onUnavailable: async (notice) => {
                unavailableNoticeSent = await sendFeedback(input, notice);
                return unavailableNoticeSent;
              },
            });
            const { port } = result;
            let toolsReady = false;
            try {
              // Do not repeat the expensive probe when the preflight already
              // found no MCP endpoint. The command will retry after the user
              // enables MCP + Brave Mode.
              toolsReady = (await reconcile({ probeIde: port !== undefined })) === true;
            } catch {
              // capability load is best effort; feedback still matters
            }
            const finalResult = result.status === 'connected' && !toolsReady
              ? { ...result, status: 'tools-loading' }
              : result;
            // The unavailable notice is the final result for this command. If
            // it was already delivered, do not show the same warning twice.
            const unavailableAlreadySent = unavailableNoticeSent || result.unavailableNoticeSent;
            if (!unavailableAlreadySent || finalResult.status !== 'mcp-unavailable') {
              await sendFeedback(input, finalResult);
            }
          },
        });
      });
    }

    // Hide the tools the model must not see, and point it at the rest. This hook
    // runs for every agent-loop step (including tool-driven continuations), so
    // it is deliberately a pure function of the request: no I/O, no cached
    // connection state, and no action of its own.
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
        if (isIdeaProject || serving) appendIdeRecoveryGuidance(event?.system);
        if (!injectGuidance) return;
        // Guidance promises tools the model can call, so it only goes out when
        // they are actually in this request.
        if (!serving) return;
        appendIdeGuidance(event?.system, projectPath);
      });
    }

    return async () => {
      disposed = true;
      if (shellRegistration) {
        try {
          await shellRegistration.dispose();
        } catch {
          // best effort
        }
      }
      if (sessionRegistration) {
        try {
          await sessionRegistration.dispose();
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
