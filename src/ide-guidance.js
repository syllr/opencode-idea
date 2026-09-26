// IDEA MCP routing guidance injected into the model's system prompt.
//
// Two rules for this file:
//   1. Per tool: what it does, its parameters, and the positive flow for using
//      it. No caveats or edge cases, and nothing about languages or frameworks —
//      the project's own setup decides that.
//   2. The boundary is the project path. Inside it -> idea_* tools.
//      Outside it -> whatever else is available.
//
// The IDE MCP server is registered with `codemode: false`, so every idea_*
// tool is exposed directly on the provider tool list with its full schema. This
// text only says which tool to use for which operation, plus the parameters and
// result shapes that are not obvious from the schema alone.

/** Build the guidance text for one project path. */
export function buildIdeGuidance(projectPath) {
  return [
    `# 项目内操作必须使用 IDEA MCP 工具`,
    ``,
    `项目路径: \`${projectPath}\``,
    ``,
    `## 总则`,
    `- 路径在 \`${projectPath}\` 内的代码与文件操作,必须使用 \`idea_*\` 工具。`,
    `- 路径在 \`${projectPath}\` 外:用其他可用工具。`,
    `- 直接调用工具,不要用 \`execute\` 包裹;参数按各工具 schema 传。`,
    `- \`idea_*\` 工具缺失、连接失败或超时:提示用户执行 \`/open-in-idea\`,不要重试。`,
    ``,
    `## 工具补充(每条只写补充说明;工具定义以自身 schema 为准)`,
    ``,
    `### 检索`,
    `- \`idea_search_text\`:不要用 \`grep\`。`,
    `- \`idea_search_regex\`:不要用 \`grep -E\`;结果带行列坐标。`,
    `- \`idea_search_file\`:不要用 \`glob\`。`,
    `- \`idea_search_symbol\`:按名字找符号的声明位置;要看签名 / 文档接着用 \`idea_get_symbol_info\`。`,
    ``,
    `### 阅读`,
    `- \`idea_read_file\`:不要用 \`read\`;支持 \`<jar>!/<entry>\` 与 \`jrt://\` 形式的包内读取。`,
    `- \`idea_list_directory_tree\`:不要用 \`ls\` / \`find\`;\`maxDepth\` 控深度。`,
    `- \`idea_get_symbol_info\`:一个符号的签名 / 文档 / 声明位置,\`filePath\` + \`line\` + \`column\`。`,
    `- \`idea_get_all_open_file_paths\`:用户在 IDE 里打开了哪些文件(含当前激活的那个)。`,
    `- \`idea_open_file_in_editor\`:把文件在 IDE 里打开并激活,给用户看。`,
    ``,
    `### 写入`,
    `- \`idea_apply_patch\`:不要用 \`edit\` / \`patch\`;只接受项目内路径。`,
    `- \`idea_create_new_file\`:不要用 \`write\`;\`overwrite\` 控制同名覆盖。`,
    `- \`idea_rename_refactoring\`:按符号改名,项目内的引用一并更新。`,
    `- \`idea_reformat_file\`:按 IDE 的代码风格重排。`,
    ``,
    `### 校验`,
    `- \`idea_lint_files\`:批量检查,\`files\` 传数组;只列有问题的文件。`,
    `- \`idea_get_file_problems\`:单文件检查,\`filePath\`;结果在 \`errors\`。`,
    `- \`idea_build_project\`:构建校验,\`filesToRebuild\` 可只构建指定文件;有问题返回在 \`problems\`,没返回即没问题。`,
    ``,
    `### 分析`,
    `- \`idea_analyze_calls\`:调用关系,\`symbolFqn\` 传符号名,\`analysisKind\` 取 \`INCOMING_CALLS\` / \`OUTGOING_CALLS\`;\`depth\` 控层数,\`childOffset\` 翻页。`,
    `- \`idea_get_project_modules\`:项目模块及类型。`,
    `- \`idea_get_project_dependencies\`:项目直接声明的依赖。`,
    ``,
    `### 运行配置`,
    `- \`idea_get_run_configurations\`:读项目级 \`.run/*.run.xml\`(增删改直接改文件);传 \`filePath\` 可列该文件的运行入口。`,
    `- \`idea_execute_run_configuration\`:跑已有配置;Shell Script 要 \`EXECUTE_IN_TERMINAL: false\`;覆盖参数(\`programArguments\` / \`workingDirectory\` / \`envs\`)需配置支持 \`supportsDynamicLaunchOverrides\`。`,
    ``,
    `### 数据库 (数据源由用户在 IDE 里配置:不要自己建/改,不要向用户索取数据库凭据)`,
    `- \`idea_list_database_connections\`:先看有没有现成数据源;每条给 \`id\` / \`dbms\` / \`jdbcUrl\` / \`readOnly\` / \`isDDL\`。`,
    `- \`idea_test_database_connection\`(\`id\`):\`hasProblems\` 为 \`NO\` 才算通,另带 DBMS / 驱动版本与 ping。`,
    `- \`idea_list_database_schemas\`(\`connectionId\`):MySQL 下 \`databaseName\` 为空、库名在 \`schemaName\`;带 \`isIntrospected\`。`,
    `- \`idea_list_schema_object_kinds\`(\`connectionId\`):先看有哪些类型可查(\`table\` / \`view\` / \`routine\` / \`scheduled-event\`)。`,
    `- \`idea_list_schema_objects\`(\`connectionId\` + \`databaseName\` + \`schemaName\` + \`kind\`):列该 schema 下的对象。`,
    `- \`idea_introspect_schema\`(\`connectionId\` + \`databaseName\` + \`schemaName\`):拉元数据,返回该 schema 的 \`isIntrospected\`。`,
    `- \`idea_get_database_object_description\`(\`kind\` + \`objectName\`):层级文本,含列类型 / 列注释 / 索引 / 主键。`,
    `- \`idea_execute_sql_query\`:跑 SQL;结果在 \`text\`(CSV)与 \`resultSetId\`,一次 10 行,后续用 \`fetch_query_result\` 翻页。`,
    `- \`idea_fetch_query_result\`(\`resultSetId\` + \`offset\`):按页继续取结果,10 行一页。`,
    `- \`idea_preview_table_data\`(\`tableName\` + \`maxRowCount\`):直接回 CSV。`,
    `- \`idea_list_recent_sql_queries\`(\`connectionId\`):最近(含正在跑)的查询,带 \`sessionId\` / \`state\` / \`status\`。`,
    `- \`idea_cancel_sql_query\`(\`sessionId\`):取消正在跑的查询,成功后该条 \`status\` 变 \`CANCELLED\`。`,
    `- 没有数据源时:若目标库在 IDEA Database Tools 支持范围内(PostgreSQL / MySQL / MariaDB / Oracle / SQL Server / SQLite / DB2 / H2 / Derby / Sybase / Vertica / Greenplum / ClickHouse / CockroachDB / Snowflake / BigQuery / Redshift / MongoDB / Redis / Cassandra / Couchbase / Hive / DynamoDB / Exasol 等,或任何提供 JDBC 驱动的库),先建议用户在 IDEA 里配好数据源,再回来用工具操作。`,
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
