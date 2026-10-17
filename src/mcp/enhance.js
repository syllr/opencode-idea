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
// The companion plugin (https://github.com/syllr/idea-mcp-enhance) fills gaps the
// bundled server leaves in two places:
//
//   * run configuration — the bundled server can only START an existing
//     configuration; it cannot create one, stop one, restart one, or say what is
//     currently running;
//   * deployment — the bundled server has nothing at all for the IDE's
//     Deployment settings or for moving files to/from a server.
//
// The two are kept as separate groups everywhere (here, in the capability
// functions, and in the guidance), because they are NOT the same precondition:
// deployment additionally needs `com.jetbrains.plugins.webDeployment`, which
// exists only in Ultimate. One boolean covering both would let a deployment tool
// answer "are the run-lifecycle tools here?".
//
// Consequence of the split, and the reason it matters: a stock IDE serves a
// SHORTER catalog than an enhanced one. Nothing here may be assumed — every use
// has to be gated on the tools really being in the request.

/**
 * The enhance plugin's **run-lifecycle** tool names, as **suffixes**.
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
 * The enhance plugin's **deployment** tool names, as suffixes — same contract and
 * same reason for suffixes as {@link RUN_LIFECYCLE_SUFFIXES}.
 *
 * Keep in sync with `DeploymentSchemas.kt` in the enhance repository.
 *
 * The four are gated together on one plugin (`com.jetbrains.plugins.webDeployment`,
 * Ultimate only) rather than on version drift, so they usually appear or vanish as
 * a set — the guidance still names them one by one, because "usually" is not
 * "always" and a named tool the model cannot call is only a failed call.
 */
export const LIST_DEPLOYMENT_SERVERS_SUFFIX = 'list_deployment_servers';
export const UPLOAD_TO_DEPLOYMENT_SUFFIX = 'upload_to_deployment';
export const DOWNLOAD_FROM_DEPLOYMENT_SUFFIX = 'download_from_deployment';
export const GET_DEPLOYMENT_TASK_STATUS_SUFFIX = 'get_deployment_task_status';

/** All of them: look at the servers, upload, download, then poll a transfer. */
export const DEPLOYMENT_SUFFIXES = [
  LIST_DEPLOYMENT_SERVERS_SUFFIX,
  UPLOAD_TO_DEPLOYMENT_SUFFIX,
  DOWNLOAD_FROM_DEPLOYMENT_SUFFIX,
  GET_DEPLOYMENT_TASK_STATUS_SUFFIX,
];

/**
 * Does this request carry the tool called `suffix` under `prefix`?
 *
 * A malformed or missing snapshot answers "no": assuming a tool exists is the one
 * mistake that cannot be walked back once the model has read the guidance.
 *
 * Exported because the guidance asks this twice. The capability flags (below) ask
 * "does this request have the tool somewhere" (any project will do); the command
 * list next to each tool asks "under WHICH prefix", and that answer must be exact —
 * 提示词里点名一个模型调不到的命令,是这个模块唯一要防的失败。
 *
 * @param {Record<string, unknown> | undefined} tools
 * @param {string} prefix 该项目的工具前缀（含下划线）。
 * @param {string} suffix
 */
export const servesTool = (tools, prefix, suffix) =>
  Boolean(tools) && typeof tools === 'object' && `${prefix}${suffix}` in tools;

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
  return {
    canCreateRunConfiguration: servesTool(tools, prefix, CREATE_SHELL_RUN_CONFIGURATION_SUFFIX),
    canListRunningConfigurations: servesTool(tools, prefix, LIST_RUNNING_CONFIGURATIONS_SUFFIX),
    canStopRunConfiguration: servesTool(tools, prefix, STOP_RUN_CONFIGURATION_SUFFIX),
    canRerunRunConfiguration: servesTool(tools, prefix, RERUN_RUN_CONFIGURATION_SUFFIX),
  };
}

/**
 * Same question for the deployment group, and the same answer shape — see
 * {@link runLifecycleCapabilities}.
 *
 * The names repeat the tool's subject rather than the group (`canUploadToDeployment`,
 * not `canUpload`): the guidance is one document about two groups, and a flag whose
 * owner is unclear is how the wrong section gets the wrong text.
 *
 * @param {Record<string, unknown> | undefined} tools
 * @param {string} prefix 该项目的工具前缀（含下划线）。
 */
export function deploymentCapabilities(tools, prefix) {
  return {
    canListDeploymentServers: servesTool(tools, prefix, LIST_DEPLOYMENT_SERVERS_SUFFIX),
    canUploadToDeployment: servesTool(tools, prefix, UPLOAD_TO_DEPLOYMENT_SUFFIX),
    canDownloadFromDeployment: servesTool(tools, prefix, DOWNLOAD_FROM_DEPLOYMENT_SUFFIX),
    canGetDeploymentTaskStatus: servesTool(tools, prefix, GET_DEPLOYMENT_TASK_STATUS_SUFFIX),
  };
}
