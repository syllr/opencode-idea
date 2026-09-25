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
//      capabilities immediately.
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

const DEFAULT_LAUNCH_COOLDOWN_MS = 120000;
const DEFAULT_LAUNCH_MAX_ATTEMPTS = 5;
// MCP availability is a fast preflight. If it is not ready, fail fast and let
// the user enable MCP + Brave Mode in IDEA before retrying the command.
const DEFAULT_MCP_PROBE_TIMEOUT_MS = 1000;

/**
 * @typedef {{
 *   status: 'connected' | 'mcp-unavailable' | 'launch-failed' | 'disabled',
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
      return 'IDE MCP 已连接;IDE MCP 与项目环境已即时加载。';
    case 'mcp-unavailable':
      return result?.opened
        ? '已请求打开/激活 IntelliJ IDEA,但未检测到 MCP 服务。请在 IDEA 中开启 MCP 服务(Settings → MCP Server,需 2026.2+)并启用 Brave Mode,然后再次执行 /open-in-idea。'
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
   *     feedback?: false | 'message',
   *   },
   *   command?: {
   *     transform: (cb: (editor: { add: (definition: {
   *       name: string,
   *       description?: string,
   *       execute: (input: { sessionID: string, prompt: { text: string }, delivery: unknown }) => Promise<void>,
   *     }) => void }) => void) => Promise<{ dispose: () => Promise<void> | void }>,
   *   },
   *   session?: {
   *     prompt: (input: { sessionID: string, text: string, delivery: unknown }) => Promise<unknown>,
   *     hook: (name: string, cb: (event: { system?: unknown[] }) => void) => Promise<{ dispose: () => Promise<void> | void }>,
   *   },
   *   tool?: {
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

    const options = ctx.options || {};
    const ports = asArray(options.ports, DEFAULT_PORTS);
    const injectEnv = options.injectEnv !== false;
    const injectGuidance = options.injectGuidance !== false;
    const ideApp = resolveIdeApp(options.openInIde);
    const mcpProbeTimeoutMs = asPositiveNumber(options.mcpProbeTimeoutMs, DEFAULT_MCP_PROBE_TIMEOUT_MS);
    // "message" (default) injects a clearly-labelled notification that the
    // model only acknowledges ("收到"); the user sees the clean notice via
    // metadata.displayText. false is silent.
    const feedback = options.feedback === false ? false : 'message';
    const guard = createLaunchGuard({
      cooldownMs: asPositiveNumber(options.launchCooldownMs, DEFAULT_LAUNCH_COOLDOWN_MS),
      maxAttempts: asPositiveNumber(options.launchMaxAttempts, DEFAULT_LAUNCH_MAX_ATTEMPTS),
    });

    /** @type {number | undefined} */
    let activePort;
    let currentEnv = { env: {}, prependPath: [] };

    /** @type {Array<{ dispose: () => Promise<void> | void }>} */
    let registrations = [];
    /** @type {{ dispose: () => Promise<void> | void } | undefined} */
    let shellRegistration;
    /** @type {{ dispose: () => Promise<void> | void } | undefined} */
    let sessionRegistration;
    /** @type {{ dispose: () => Promise<void> | void } | undefined} */
    let commandRegistration;
    let disposed = false;

    const deactivateIde = async () => {
      activePort = undefined;
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

    const activateIde = async (port) => {
      const mcpRegistration = await ctx.mcp.transform((editor) => {
        editor.set(IDEA_SERVER_NAME, serverConfig(port, projectPath));
      });
      registrations = [mcpRegistration];
      activePort = port;
      if (typeof ctx.mcp.reload === 'function') await ctx.mcp.reload();
      // Reconcile the MCP servers above, then replay the tool registry so the
      // refreshed catalog lands in the next model request's tool snapshot.
      // Without this, a session that already captured a snapshot keeps the old
      // tool list until the session is reopened.
      if (typeof ctx.tool?.reload === 'function') await ctx.tool.reload();
    };

    const reconcileOnce = async ({ probeIde = true } = {}) => {
      if (disposed) return;

      // Manual: only `/open-in-idea` probes the IDE. Setup calls this with
      // `probeIde: false` so it never connects until the command asks.
      const port = probeIde ? await findIdePort(ports, { timeoutMs: mcpProbeTimeoutMs }) : undefined;
      const isJetBrains = hasIdeaDirectory(projectPath) || port !== undefined;
      if (!isJetBrains) {
        currentEnv = { env: {}, prependPath: [] };
        await deactivateIde();
        return;
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

      if (port === activePort) return;
      await deactivateIde();
      if (port !== undefined) await activateIde(port);
    };

    // Serialize reconciles so overlapping callers can never register/activate
    // the IDE concurrently (which would leak registrations).
    let reconcileChain = Promise.resolve();
    const reconcile = (options) => {
      const next = reconcileChain.then(() => reconcileOnce(options));
      reconcileChain = next.then(
        () => {},
        () => {},
      );
      return next;
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
        // `open -a` only requests activation/opening. Fast-fail if the MCP
        // endpoint is not already available; the user can enable it in IDEA
        // and run `/open-in-idea` again instead of waiting on a timer.
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
            const { port, status, unavailableNoticeSent: resultNoticeSent } = result;
            try {
              // Do not repeat the expensive probe when the preflight already
              // found no MCP endpoint. The command will retry after the user
              // enables MCP + Brave Mode.
              await reconcile({ probeIde: port !== undefined });
            } catch {
              // capability load is best effort; feedback still matters
            }
            // The unavailable notice is the final result for this command. If
            // it was already delivered, do not show the same warning twice.
            const unavailableAlreadySent = unavailableNoticeSent || resultNoticeSent;
            if (!unavailableAlreadySent || status !== 'mcp-unavailable') {
              await sendFeedback(input, result);
            }
          },
        });
      });
    }

    // Direct-call guidance: while the IDEA MCP is available, append concise
    // routing rules to every primary request. Native tools are left untouched.
    if (injectGuidance && typeof ctx.session?.hook === 'function') {
      sessionRegistration = await ctx.session.hook('context', (event) => {
        appendIdeRecoveryGuidance(event?.system);
        if (activePort === undefined) return;
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
      await deactivateIde();
    };
  },
};
