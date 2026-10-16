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
// The companion plugin (https://github.com/syllr/idea-mcp-enhance) fills the gaps
// the bundled server leaves in run configuration handling: the bundled server can
// only START an existing configuration — it cannot create one, stop one, restart
// one, or say what is currently running.
//
// Consequence of the split, and the reason it matters: a stock IDE serves a
// SHORTER catalog than an enhanced one. Nothing here may be assumed — every use
// has to be gated on the tools really being in the request (`servingRunLifecycleTools`).

/**
 * The enhance plugin's tool names, as **suffixes**.
 *
 * OpenCode namespaces an MCP server's tools with the server name, and each
 * project is registered under its own prefix (root = `ide`, a subproject = its
 * directory name). So the wire name is `<prefix><suffix>` — for example
 * `ide_rerun_run_configuration` or `modelserver_rerun_run_configuration`.
 *
 * 存后缀而不是完整名字：同一个工具在每个项目前缀下各有一份，写死任何一个前缀都会
 * 让别的项目查不到它。
 *
 * Keep in sync with `RunLifecycleSchemas.kt` in the enhance repository — the
 * suffixes are its contract, and there is no runtime way to discover "which
 * plugin provided this tool": MCP carries no such marker.
 */
export const CREATE_SHELL_RUN_CONFIGURATION_SUFFIX = 'create_shell_run_configuration';
export const LIST_RUNNING_CONFIGURATIONS_SUFFIX = 'list_running_configurations';
export const STOP_RUN_CONFIGURATION_SUFFIX = 'stop_run_configuration';
export const RERUN_RUN_CONFIGURATION_SUFFIX = 'rerun_run_configuration';

/** All of them, in the order the guidance lists them: create, see, stop, restart. */
export const RUN_LIFECYCLE_SUFFIXES = [
  CREATE_SHELL_RUN_CONFIGURATION_SUFFIX,
  LIST_RUNNING_CONFIGURATIONS_SUFFIX,
  STOP_RUN_CONFIGURATION_SUFFIX,
  RERUN_RUN_CONFIGURATION_SUFFIX,
];

/**
 * Which of the enhance plugin's tools **this project's prefix** carries in this
 * request.
 *
 * 返回布尔组合而不是名字列表：提示词要的是"这段能不能写",而且每个项目各算各的
 * —— 一个项目装了 enhance、另一个没装是可能的。
 *
 * 客户端版本差异同理：enhance 版本独立发布，旧版可能少几个工具，所以逐个判断,
 * 提示词绝不能点名一个模型调不到的工具。
 *
 * @param {Record<string, unknown> | undefined} tools This request's tool record
 *   (`event.tools` from the `context` hook).
 * @param {string} prefix 该项目的工具前缀（含下划线）。
 */
export function runLifecycleCapabilities(tools, prefix) {
  const has = (suffix) =>
    Boolean(tools) && typeof tools === 'object' && `${prefix}${suffix}` in tools;
  return {
    canCreateRunConfiguration: has(CREATE_SHELL_RUN_CONFIGURATION_SUFFIX),
    canListRunningConfigurations: has(LIST_RUNNING_CONFIGURATIONS_SUFFIX),
    canStopRunConfiguration: has(STOP_RUN_CONFIGURATION_SUFFIX),
    canRerunRunConfiguration: has(RERUN_RUN_CONFIGURATION_SUFFIX),
  };
}
