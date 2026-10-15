// MCP surface added by the companion IDEA plugin `idea-mcp-enhance`.
//
// Kept apart from `idea.js` on purpose. `idea.js` describes ONE thing: the MCP
// server IntelliJ itself bundles, which every supported IDE has. Everything in
// this file describes a SECOND, optional source of tools — a plugin the user may
// or may not have installed. Two different origins, two files:
//
//   * native  -> `idea.js`      (always present; the IDE owns the catalog)
//   * plugin  -> this file      (present only if the user installed the plugin)
//
// The companion plugin (https://github.com/syllr/idea-mcp-enhance) fills the
// gaps the bundled server leaves in run configuration handling: the bundled
// server can only START a configuration, never stop it, restart it, or report
// what is currently running.
//
// Consequence of the split, and the reason it matters: a stock IDE serves a
// SHORTER catalog than an enhanced one. Nothing here may be assumed — every use
// has to be gated on the tools really being in the request (`servingRunLifecycleTools`).

/**
 * The enhance plugin's tool names as OpenCode reports them.
 *
 * OpenCode namespaces an MCP server's tools with the server name, and this
 * plugin registers the IDE server as `idea`, so the wire names are the enhance
 * plugin's own tool names (`list_running_configurations`, ...) carrying an
 * `idea_` prefix.
 *
 * Keep in sync with `RunLifecycleSchemas.kt` in the enhance repository — the
 * names are its contract, and there is no runtime way to discover "which plugin
 * provided this tool": MCP carries no such marker.
 */
export const LIST_RUNNING_CONFIGURATIONS_TOOL = 'idea_list_running_configurations';
export const STOP_RUN_CONFIGURATION_TOOL = 'idea_stop_run_configuration';
export const RERUN_RUN_CONFIGURATION_TOOL = 'idea_rerun_run_configuration';

/** All of them, in the order the guidance lists them. */
export const RUN_LIFECYCLE_TOOLS = [
  LIST_RUNNING_CONFIGURATIONS_TOOL,
  STOP_RUN_CONFIGURATION_TOOL,
  RERUN_RUN_CONFIGURATION_TOOL,
];

/**
 * Which of the enhance plugin's tools this request actually carries.
 *
 * A subset rather than a boolean, because the enhance plugin is versioned
 * independently: an older release can ship fewer of these tools, and guidance
 * must never name one the model cannot call.
 *
 * @param {Record<string, unknown> | undefined} tools This request's tool record
 *   (`event.tools` from the `context` hook).
 * @returns {string[]} The present ones, in {@link RUN_LIFECYCLE_TOOLS} order.
 */
export function servingRunLifecycleTools(tools) {
  if (!tools || typeof tools !== 'object') return [];
  return RUN_LIFECYCLE_TOOLS.filter((name) => name in tools);
}
