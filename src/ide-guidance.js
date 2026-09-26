// IDEA MCP routing guidance injected into the model's system prompt.
//
// Two rules for this file:
//   1. State requirements and exact parameters only. No rationale.
//   2. The boundary is the project path. Inside it -> idea_* tools.
//      Outside it -> whatever else is available.
//
// The IDE MCP server is registered with `codemode: false`, so every idea_*
// tool is exposed directly on the provider tool list with its full schema.
// Parameter names therefore come from the tool definitions; this text only
// states which tool to use for which operation.

/** Build the guidance text for one project path. */
export function buildIdeGuidance(projectPath) {
  return [
    `# 项目内操作必须使用 IDEA MCP 工具`,
    ``,
    `项目路径: \`${projectPath}\``,
    ``,
    `## 强制要求`,
    `- 路径在 \`${projectPath}\` 内的代码与文件操作,必须使用 \`idea_*\` 工具。`,
    `- 直接调用工具,不要用 \`execute\` 包裹。`,
    `- 检索内容用 \`idea_search_text\` / \`idea_search_regex\`,不要用 \`grep\`。`,
    `- 查找文件名用 \`idea_search_file\`,不要用 \`glob\`。`,
    `- 读文件用 \`idea_read_file\`,不要用 \`read\`。`,
    `- 浏览目录用 \`idea_list_directory_tree\`,不要用 \`ls\` / \`find\`。`,
    `- 修改已有文件用 \`idea_apply_patch\`,不要用 \`edit\` / \`patch\`。`,
    `- 新建文件用 \`idea_create_new_file\`,不要用 \`write\`。`,
    `- 改完代码用 \`idea_lint_files\` 或 \`idea_get_file_problems\` 校验。`,
    `- 工具参数按该工具的 schema 传。`,
    ``,
    `## 数据库`,
    `- 数据库操作走 IDEA 的 Database 工具(\`idea_list_database_connections\` / \`idea_introspect_schema\` / \`idea_execute_sql_query\` / \`idea_preview_table_data\` 等),不要用原生 CLI 客户端。`,
    `- 先 \`idea_list_database_connections\` 看有没有现成数据源。`,
    `- 没有数据源时:若目标数据库在 IDEA Database Tools 支持范围内(PostgreSQL / MySQL / MariaDB / Oracle / SQL Server / SQLite / DB2 / H2 / Derby / Sybase / Vertica / Greenplum / ClickHouse / CockroachDB / Snowflake / BigQuery / Redshift / MongoDB / Redis / Cassandra / Couchbase / Hive / DynamoDB / Exasol 等,或任何提供 JDBC 驱动的库),先建议用户在 IDEA 里配好数据源,再回来用工具操作。`,
    `- 不要自己建或改数据源,不要向用户索取数据库凭据。`,
    ``,
    `## 范围`,
    `- \`${projectPath}\` 内的代码与文件操作:只用 \`idea_*\` 工具。`,
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
