// opencode-jetbrains-mcp — OpenCode plugin entry.
//
// For a JetBrains project this plugin:
//   1. injects the project SDK environment (JAVA_HOME / VIRTUAL_ENV / GOROOT /
//      ...) into every OpenCode shell, derived from `.idea` and, when the IDE
//      is reachable, from the IDE integrated terminal;
//   2. when the IDE MCP server has the project open, registers it with OpenCode
//      (scoped to the project via the IJ_MCP_SERVER_PROJECT_PATH header) and
//      rewrites the native edit/write/patch/shell descriptions to prefer the
//      IDE tools.
//
// Non-JetBrains projects are left untouched. A periodic probe keeps the state in
// sync as the IDE opens and closes.
//
// `Plugin.define` from `@opencode/plugin` is an identity function, so a plain
// `{ id, setup }` object is the whole plugin contract. Exporting it directly
// keeps this package dependency-free at runtime.

import {
  DEFAULT_PORTS,
  IDEA_SERVER_NAME,
  probeOpenProject,
  serverConfig,
} from './idea-mcp.js';
import { readIdeTerminalEnv } from './ide-env.js';
import { currentProjectPath, hasIdeaDirectory } from './project.js';
import { readProjectSdk } from './project-sdk.js';
import { applyEnv, mergeEnv } from './env.js';
import { applyPreference } from './tool-descriptions.js';

const DEFAULT_POLL_MS = 15000;

/** @param {unknown} value @param {unknown} fallback */
const asArray = (value, fallback) => (Array.isArray(value) && value.length > 0 ? value : fallback);

export default {
  id: 'opencode-jetbrains-mcp',

  /**
   * @param {{
   *   location?: unknown,
   *   options?: { ports?: number[], pollMs?: number, injectEnv?: boolean },
   *   tool: { transform: (cb: (editor: unknown) => void) => Promise<{ dispose: () => Promise<void> | void }> },
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
    const pollMs = typeof options.pollMs === 'number' && options.pollMs > 0 ? options.pollMs : DEFAULT_POLL_MS;
    const injectEnv = options.injectEnv !== false;

    /** @type {number | undefined} */
    let activePort;
    let currentEnv = { env: {}, prependPath: [] };
    /** @type {Array<{ dispose: () => Promise<void> | void }>} */
    let registrations = [];
    /** @type {{ dispose: () => Promise<void> | void } | undefined} */
    let shellRegistration;
    let disposed = false;

    const deactivateIde = async () => {
      activePort = undefined;
      const current = registrations;
      registrations = [];
      for (const registration of current) {
        try {
          await registration.dispose();
        } catch {
          // best effort
        }
      }
    };

    const activateIde = async (port) => {
      const toolRegistration = await ctx.tool.transform((editor) => applyPreference(editor));
      const mcpRegistration = await ctx.mcp.transform((editor) => {
        editor.set(IDEA_SERVER_NAME, serverConfig(port, projectPath));
      });
      registrations = [toolRegistration, mcpRegistration];
      activePort = port;
      if (typeof ctx.mcp.reload === 'function') await ctx.mcp.reload();
    };

    const reconcile = async () => {
      if (disposed) return;

      const port = await probeOpenProject(projectPath, ports);
      const isJetBrains = hasIdeaDirectory(projectPath) || port !== undefined;
      if (!isJetBrains) {
        currentEnv = { env: {}, prependPath: [] };
        await deactivateIde();
        return;
      }

      // Environment: project SDK from `.idea` (authoritative) plus the IDE
      // terminal environment (supplement, only when the IDE is reachable).
      const sdk = readProjectSdk(projectPath);
      const terminal = port === undefined ? {} : await readIdeTerminalEnv(port, projectPath);
      currentEnv = mergeEnv([{ env: terminal }, sdk]);

      if (injectEnv && !shellRegistration) {
        shellRegistration = await ctx.shell.hook('create.before', (input) => applyEnv(input, currentEnv));
      }

      if (port === activePort) return;
      await deactivateIde();
      if (port !== undefined) await activateIde(port);
    };

    await reconcile();
    const timer = setInterval(() => {
      reconcile().catch(() => {});
    }, pollMs);

    return async () => {
      disposed = true;
      clearInterval(timer);
      if (shellRegistration) {
        try {
          await shellRegistration.dispose();
        } catch {
          // best effort
        }
      }
      await deactivateIde();
    };
  },
};
