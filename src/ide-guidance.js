// Direct IDEA MCP usage guidance injected into the model's system prompt.
// The plugin does not modify native OpenCode tools.

/** The guidance text appended to the system prompt. */
export const IDE_GUIDANCE = [
  '## 项目内操作优先使用 IDEA MCP 工具',
  '当前项目已在 JetBrains IDE 中打开。普通工具调用名称是 `idea_<name>`,例如 `idea_search_text`、`idea_read_file`、`idea_apply_patch`;项目内检索、读文件、改文件、校验和目录浏览优先直接调用这些 IDEA MCP 工具。',
  '直接调用工具本身,不要为了调用 IDEA MCP 工具再包一层额外的 JavaScript 编排代码。',
  '',
  '常用工具与关键参数:',
  '- 文本 / 正则 / 文件名检索:`idea_search_text` / `idea_search_regex` / `idea_search_file` —— 参数 `q`(不是 `query`),可带 `paths` 收窄。',
  '- 符号 / 语义:`idea_search_symbol` / `idea_get_symbol_info` / `idea_analyze_calls`(只用 `depth=1`)。',
  '- 读文件:`idea_read_file`(`file_path` / `offset` / `limit`)。',
  '- 目录浏览:`idea_list_directory_tree`(代替 `ls` / `find`,`maxDepth` ≥ 2)。',
  '- 修改已有文件:`idea_apply_patch`(参数 `input`,传 patch 文本)。',
  '- 新建文件:`idea_create_new_file`(参数 `pathInProject`,可选 `text` / `overwrite`)。',
  '- 校验:`idea_lint_files` / `idea_get_file_problems` / `idea_build_project`。',
  '- 重构 / 格式化:`idea_rename_refactoring` / `idea_reformat_file`。',
  '- 结构 / 依赖:`idea_get_project_modules` / `idea_get_project_dependencies`。',
  '- 版本状态:`idea_git_status`;终端命令:`idea_execute_terminal_command`。',
  '',
  '调用纪律:',
  '- 直接调用当前工具 schema 中声明的参数,不要猜参数名;工具自身的 description 是参数使用的权威来源。',
  '- 工具返回 `File already exists` 等业务错误时,先修正调用参数,不要判断成工具不存在。',
  '- 如果 IDEA MCP 未连接、工具缺失、连接被拒绝或超时,立即提示用户执行 `/open-in-idea`,不要反复探测或长时间等待。',
  '',
  '例外(直接使用原生工具):`node_modules/`、`target/` 等 IDE 不索引的目录;`git diff` / `log` / `blame` 等 git 独有语义;`lsof` / `nc` / `ping` 等 MCP 无等价能力;IDE MCP 未连接 / 未注册;项目根之外的文件。',
].join('\n');

export const MCP_RECOVERY_GUIDANCE = [
  '### IDEA MCP failure recovery',
  'If an idea.* / idea_* tool is missing, MCP is disconnected, the connection is refused, or a tool times out: stop retrying immediately; do not run extra probes or wait in tool calls. Tell the user that IDEA MCP is unavailable and ask them to run /open-in-idea to reconnect.',
].join('\n');

/**
 * Push the guidance onto a session `system` array. Called for every primary
 * model request, so it stays idempotent per request.
 *
 * @param {unknown} system
 */
export function appendIdeGuidance(system) {
  if (!Array.isArray(system)) return;
  if (system.some((part) => part?.text === IDE_GUIDANCE)) return;
  system.push({ type: 'text', text: IDE_GUIDANCE });
}

/** @param {unknown} system */
export function appendIdeRecoveryGuidance(system) {
  if (!Array.isArray(system)) return;
  if (system.some((part) => part?.text === MCP_RECOVERY_GUIDANCE)) return;
  system.push({ type: 'text', text: MCP_RECOVERY_GUIDANCE });
}
