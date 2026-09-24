// opencode-jetbrains-mcp — OpenCode plugin entry.
//
// When the current project is open in a JetBrains IDE whose MCP server is
// running, this plugin:
//   1. registers that IDE MCP server with OpenCode (scoped to the current
//      project via the IJ_MCP_SERVER_PROJECT_PATH header), and
//   2. rewrites the native edit/write/patch/shell tool descriptions to prefer
//      the IDE tools.
//
// When the project is not open, it does nothing and OpenCode keeps using the
// native tools. A periodic probe keeps the state in sync as the IDE opens and
// closes projects.
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
import { currentProjectPath } from './project.js';
import { applyPreference } from './tool-descriptions.js';

const DEFAULT_POLL_MS = 15000;

/** @param {unknown} value @param {unknown} fallback */
const asArray = (value, fallback) => (Array.isArray(value) && value.length > 0 ? value : fallback);

export default {
  id: 'opencode-jetbrains-mcp',

  /**
   * @param {{
   *   location?: unknown,
   *   options?: { ports?: number[], pollMs?: number },
   *   tool: { transform: (cb: (editor: unknown) => void) => Promise<{ dispose: () => Promise<void> | void }> },
   *   mcp: {
   *     transform: (cb: (editor: { set: (name: string, config: unknown) => void }) => void) => Promise<{ dispose: () => Promise<void> | void }>,
   *     reload?: () => Promise<void>,
   *   },
   * }} ctx
   */
  async setup(ctx) {
    const projectPath = currentProjectPath(ctx.location);
    if (!projectPath) return;

    const options = ctx.options || {};
    const ports = asArray(options.ports, DEFAULT_PORTS);
    const pollMs = typeof options.pollMs === 'number' && options.pollMs > 0 ? options.pollMs : DEFAULT_POLL_MS;

    /** @type {number | undefined} */
    let activePort;
    /** @type {Array<{ dispose: () => Promise<void> | void }>} */
    let registrations = [];
    let disposed = false;

    const deactivate = async () => {
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

    const activate = async (port) => {
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
      if (port === activePort) return;
      await deactivate();
      if (port !== undefined) await activate(port);
    };

    await reconcile();
    const timer = setInterval(() => {
      reconcile().catch(() => {});
    }, pollMs);

    return async () => {
      disposed = true;
      clearInterval(timer);
      await deactivate();
    };
  },
};
