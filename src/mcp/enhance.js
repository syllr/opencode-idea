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
// bundled server leaves in three places:
//
//   * run configuration — the bundled server can only START an existing
//     configuration; it cannot create one, stop one, restart one, or say what is
//     currently running;
//   * deployment — the bundled server has nothing at all for the IDE's
//     Deployment settings or for moving files to/from a server;
//   * terminal — the bundled server's `execute_terminal_command` does NOT inherit
//     the project's configured SDKs, so this plugin replaces it with a real IDE
//     terminal that does, plus an SSH terminal on a Deployment server.
//
// The groups are kept separate everywhere (here, in the capability functions,
// and in the guidance), because they do NOT share a precondition: deployment
// additionally needs `com.jetbrains.plugins.webDeployment` (Ultimate only), and
// the remote terminal needs `org.jetbrains.plugins.remote-run` on top of that.
// One boolean covering several groups would let a deployment tool answer "are
// the run-lifecycle tools here?".
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
export const CREATE_RUN_CONFIGURATION_SUFFIX = 'create_run_configuration';
export const INSPECT_RUN_CONFIGURATION_SUFFIX = 'inspect_run_configuration';
export const UPDATE_RUN_CONFIGURATION_SUFFIX = 'update_run_configuration';
export const DELETE_RUN_CONFIGURATION_SUFFIX = 'delete_run_configuration';
export const LIST_RUNNING_CONFIGURATIONS_SUFFIX = 'list_running_configurations';
export const STOP_RUN_CONFIGURATION_SUFFIX = 'stop_run_configuration';
export const RERUN_RUN_CONFIGURATION_SUFFIX = 'rerun_run_configuration';

/** All of them, in the order the guidance lists them: create, see, stop, restart. */
export const RUN_LIFECYCLE_SUFFIXES = [
  CREATE_RUN_CONFIGURATION_SUFFIX,
  INSPECT_RUN_CONFIGURATION_SUFFIX,
  UPDATE_RUN_CONFIGURATION_SUFFIX,
  DELETE_RUN_CONFIGURATION_SUFFIX,
  LIST_RUNNING_CONFIGURATIONS_SUFFIX,
  STOP_RUN_CONFIGURATION_SUFFIX,
  RERUN_RUN_CONFIGURATION_SUFFIX,
];

/**
 * The enhance plugin's **deployment** tool names, as suffixes — same contract and
 * same reason for suffixes as {@link RUN_LIFECYCLE_SUFFIXES}.
 *
 * 与 `DeploymentSchemas.kt` 保持同步：列表工具是 server 视角，返回 `servers[]`，
 * 每台 server 带 `deployments[]`。上传 / 下载用 `deployments[].name` 派生出的全局唯一
 * `deploymentName`；只有远程终端用 `servers[].name`（`serverName`）。
 *
 * The four are gated together on one plugin (`com.jetbrains.plugins.webDeployment`,
 * Ultimate only) rather than on version drift, so they usually appear or vanish as
 * a set — the guidance still names them one by one, because "usually" is not
 * "always" and a named tool the model cannot call is only a failed call.
 */
export const LIST_SERVER_DEPLOYMENTS_SUFFIX = 'list_server_deployments';
export const UPLOAD_TO_DEPLOYMENT_SUFFIX = 'upload_to_deployment';
export const DOWNLOAD_FROM_DEPLOYMENT_SUFFIX = 'download_from_deployment';
export const GET_DEPLOYMENT_TASK_STATUS_SUFFIX = 'get_deployment_task_status';


/** All of them: look at the servers, upload, download, then poll a transfer. */
export const DEPLOYMENT_SUFFIXES = [
  LIST_SERVER_DEPLOYMENTS_SUFFIX,
  UPLOAD_TO_DEPLOYMENT_SUFFIX,
  DOWNLOAD_FROM_DEPLOYMENT_SUFFIX,
  GET_DEPLOYMENT_TASK_STATUS_SUFFIX,
];

/**
 * The enhance plugin's **terminal** tool names, as suffixes — same contract and
 * same reason for suffixes as {@link RUN_LIFECYCLE_SUFFIXES}.
 *
 * Keep in sync with `TerminalSchemas.kt` in the enhance repository.
 *
 * 这一组内部还要再分两层前提：`project_sdk_terminal` / `terminal_io` /
 * `list_terminals` 由同一个 provider 注册（`TerminalToolsProvider`，只要 Terminal 插件在，
 * Community / Ultimate 都自带）；`execute_in_remote_host` 在另一个 provider 里，要求
 * `org.jetbrains.plugins.remote-run`（仅 Ultimate，且挂在与 deployment 同一层
 * `webDeployment` 之下）。所以能力探测逐个工具回答，不合并成"终端这一组在不在"。
 */
export const PROJECT_SDK_TERMINAL_SUFFIX = 'project_sdk_terminal';
export const TERMINAL_IO_SUFFIX = 'terminal_io';
export const LIST_TERMINALS_SUFFIX = 'list_terminals';
export const EXECUTE_IN_REMOTE_HOST_SUFFIX = 'execute_in_remote_host';

/** All of them: run in the project SDK, list tabs, continue a tab, run remotely. */
export const TERMINAL_SUFFIXES = [
  PROJECT_SDK_TERMINAL_SUFFIX,
  TERMINAL_IO_SUFFIX,
  LIST_TERMINALS_SUFFIX,
  EXECUTE_IN_REMOTE_HOST_SUFFIX,
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
    canCreateRunConfiguration: servesTool(tools, prefix, CREATE_RUN_CONFIGURATION_SUFFIX),
    canInspectRunConfiguration: servesTool(tools, prefix, INSPECT_RUN_CONFIGURATION_SUFFIX),
    canUpdateRunConfiguration: servesTool(tools, prefix, UPDATE_RUN_CONFIGURATION_SUFFIX),
    canDeleteRunConfiguration: servesTool(tools, prefix, DELETE_RUN_CONFIGURATION_SUFFIX),
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
 * not `canUpload`): the guidance is one document about several groups, and a flag whose
 * owner is unclear is how the wrong section gets the wrong text.
 *
 * @param {Record<string, unknown> | undefined} tools
 * @param {string} prefix 该项目的工具前缀（含下划线）。
 */
export function deploymentCapabilities(tools, prefix) {
  return {
    canListServerDeployments: servesTool(tools, prefix, LIST_SERVER_DEPLOYMENTS_SUFFIX),
    canUploadToDeployment: servesTool(tools, prefix, UPLOAD_TO_DEPLOYMENT_SUFFIX),
    canDownloadFromDeployment: servesTool(tools, prefix, DOWNLOAD_FROM_DEPLOYMENT_SUFFIX),
    canGetDeploymentTaskStatus: servesTool(tools, prefix, GET_DEPLOYMENT_TASK_STATUS_SUFFIX),
  };
}

/**
 * Same question for the terminal group — see {@link runLifecycleCapabilities}.
 *
 * 逐个判断而不是"终端这组在不在"：远程那个的前提比本地三个多一层，Community 上
 * 只有本地三个，Ultimate 上四个都在。合并成一个标志会让提示词在 Community 上点名
 * `execute_in_remote_host`，而那是一次注定失败的调用。
 *
 * @param {Record<string, unknown> | undefined} tools
 * @param {string} prefix 该项目的工具前缀（含下划线）。
 */
export function terminalCapabilities(tools, prefix) {
  return {
    canProjectSdkTerminal: servesTool(tools, prefix, PROJECT_SDK_TERMINAL_SUFFIX),
    canTerminalIo: servesTool(tools, prefix, TERMINAL_IO_SUFFIX),
    canListTerminals: servesTool(tools, prefix, LIST_TERMINALS_SUFFIX),
    canExecuteInRemoteHost: servesTool(tools, prefix, EXECUTE_IN_REMOTE_HOST_SUFFIX),
  };
}
