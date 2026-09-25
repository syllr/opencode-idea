// IDEA MCP routing guidance injected into the model's system prompt.
//
// Two rules for this file:
//   1. State requirements only. No explanations, no asides, no examples of
//      what NOT to do — every extra sentence weakens the instruction.
//   2. The boundary is the project path. Inside it -> idea_* tools.
//      Outside it -> whatever else is available.

/** Build the guidance text for one project path. */
export function buildIdeGuidance(projectPath) {
  return [
    `# 项目内操作必须使用 IDEA MCP 工具`,
    ``,
    `项目路径: \`${projectPath}\``,
    ``,
    `## 强制要求`,
    `- 路径在 \`${projectPath}\` 内的所有操作,必须使用 \`idea_*\` 工具。`,
    `- 检索内容用 \`idea_search_text\` / \`idea_search_regex\`,不要用 \`grep\`。`,
    `- 查找文件名用 \`idea_search_file\`,不要用 \`glob\`。`,
    `- 读文件用 \`idea_read_file\`(\`file_path\`),不要用 \`read\`。`,
    `- 浏览目录用 \`idea_list_directory_tree\`(\`directoryPath\`),不要用 \`ls\` / \`find\`。`,
    `- 修改已有文件用 \`idea_apply_patch\`(\`input\`),不要用 \`edit\` / \`patch\`。`,
    `- 新建文件用 \`idea_create_new_file\`(\`pathInProject\`),不要用 \`write\`。`,
    `- 改完代码用 \`idea_lint_files\`(\`files\`) 或 \`idea_get_file_problems\` 校验。`,
    `- 看 git 状态用 \`idea_git_status\`。`,
    `- 编辑类工具的参数必须按该工具的 schema 传。`,
    ``,
    `## 范围`,
    `- \`${projectPath}\` 内:只用 \`idea_*\` 工具。`,
    `- \`${projectPath}\` 外:用其他可用工具。`,
    `- \`idea_*\` 工具缺失、连接失败或超时:提示用户执行 \`/open-in-idea\`,不要重试。`,
  ].join('\n');
}

export const MCP_RECOVERY_GUIDANCE = [
  '### IDEA MCP failure recovery',
  'If an idea.* / idea_* tool is missing, MCP is disconnected, the connection is refused, or a tool times out: stop retrying immediately; do not run extra probes or wait in tool calls. Tell the user that IDEA MCP is unavailable and ask them to run /open-in-idea to reconnect.',
].join('\n');

/**
 * Push the guidance onto a session `system` array. Called for every primary
 * model request, so it stays idempotent per request.
 *
 * @param {unknown} system
 * @param {string} projectPath
 */
export function appendIdeGuidance(system, projectPath) {
  if (!Array.isArray(system)) return;
  if (!projectPath) return;
  const text = buildIdeGuidance(projectPath);
  if (system.some((part) => part?.text === text)) return;
  system.push({ type: 'text', text });
}

/** @param {unknown} system */
export function appendIdeRecoveryGuidance(system) {
  if (!Array.isArray(system)) return;
  if (system.some((part) => part?.text === MCP_RECOVERY_GUIDANCE)) return;
  system.push({ type: 'text', text: MCP_RECOVERY_GUIDANCE });
}
