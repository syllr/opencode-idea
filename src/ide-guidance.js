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
//
// The run-lifecycle block is the one section that is not unconditional: those
// tools come from the companion IDEA plugin `idea-mcp-enhance`, not from the
// IDE's bundled MCP server, so they are named only when the request actually
// carries them (see `mcp/enhance.js`).

import {
  CREATE_SHELL_RUN_CONFIGURATION_TOOL,
  LIST_RUNNING_CONFIGURATIONS_TOOL,
  RERUN_RUN_CONFIGURATION_TOOL,
  STOP_RUN_CONFIGURATION_TOOL,
} from './mcp/enhance.js';

/**
 * Lines for the enhance plugin's run-configuration tools, one per present tool.
 *
 * `present` is what this request actually carries
 * (`servingRunLifecycleTools`), so a stock IDE produces none of these lines.
 *
 * The restart line carries the routing rule that keeps restarts off `pkill` /
 * the terminal: an externally killed process leaves the IDE thinking it is
 * still running, and the next Run then lands on a taken port. That is the
 * whole reason the enhance plugin exists.
 *
 * @param {readonly string[]} present
 * @returns {string[]}
 */
function runLifecycleLines(present) {
  const lines = [];
  if (present.includes(CREATE_SHELL_RUN_CONFIGURATION_TOOL)) {
    lines.push(
      `- \`${CREATE_SHELL_RUN_CONFIGURATION_TOOL}\`(\`configurationName\` + \`scriptPath\` / \`scriptText\` / ` +
        `\`cloneFrom\` 三选一):新建项目级 Shell 配置(写 \`.run/<name>.run.xml\`);` +
        `**重操作** —— 只给固定要跑、反复要用的流程建,**且建之前必须先取得用户同意**;只支持 Shell 类型。`,
    );
  }
  if (present.includes(LIST_RUNNING_CONFIGURATIONS_TOOL)) {
    lines.push(
      `- \`${LIST_RUNNING_CONFIGURATIONS_TOOL}\`:当前真正在跑的配置(几个实例 / 各自 pid / 退出码);` +
        `停 / 重启前后都先用它看状态。`,
    );
  }
  if (present.includes(STOP_RUN_CONFIGURATION_TOOL)) {
    lines.push(
      `- \`${STOP_RUN_CONFIGURATION_TOOL}\`(\`configurationName\`):停掉该配置的全部实例并等它们退出;没在跑也返回成功。`,
    );
  }
  if (present.includes(RERUN_RUN_CONFIGURATION_TOOL)) {
    lines.push(
      `- \`${RERUN_RUN_CONFIGURATION_TOOL}\`(\`configurationName\`):改完代码重启无热重载的进程;在跑就重启、没在跑就启动,` +
        `读 \`started\` 判断新进程是否真的起来了。不要用 \`pkill\` / \`kill\` / \`shell\` 代替。`,
    );
  }
  return lines;
}

/**
 * Lines for the command-execution section.
 *
 * The "where does a configuration come from" half is conditional: with the
 * enhance plugin there is a tool for it, without one the agent must not author
 * `.run/*.run.xml` itself — it asks the user. Saying "use a tool" when the tool
 * is absent would send the model at something it cannot call.
 *
 * @param {readonly string[]} present
 * @returns {string[]}
 */
function commandExecutionLines(present) {
  const canCreate = present.includes(CREATE_SHELL_RUN_CONFIGURATION_TOOL);
  return [
    `- 需要项目环境的命令(依赖 IDE 里配好的 JDK / Node / Python 版本等):用 \`idea_execute_run_configuration\`,不要用原生 \`shell\`。`,
    `- run configuration 是**重资产**:一个项目通常只建几个(固定要跑的构建 / 装依赖 / dev server 之类),**不是随手一条命令就建一个**。`,
    `- 要新建:先确认它**反复要用、且属于项目固定流程**;确认后**先告诉用户要建什么、为什么,取得同意再动手**,别自己决定。`,
    canCreate
      ? `- 新建方式:用 \`${CREATE_SHELL_RUN_CONFIGURATION_TOOL}\`(只支持 Shell 类型)。`
      : `- 新建方式:请用户自己在 IDEA 里建 —— **不要自己写 \`.run/*.run.xml\`**,也不要手搓启动命令。`,
    `- 不需要项目环境的命令:用原生 \`shell\`。`,
  ];
}

/**
 * Build the guidance text for one project path.
 *
 * @param {string} projectPath
 * @param {{ runLifecycleTools?: readonly string[] }} [options] Run-lifecycle
 *   tools present in this request; omit for a stock IDE.
 */
export function buildIdeGuidance(projectPath, options = {}) {
  const present = options.runLifecycleTools ?? [];
  const runLifecycle = runLifecycleLines(present);
  return [
    `# 项目内操作必须使用 IDEA MCP 工具`,
    ``,
    `项目路径: \`${projectPath}\``,
    ``,
    `## 总则`,
    `- 原生工具(当前工具列表里直接列出的那些)**直接调用**;不需要、也不应该用 Code Mode 的 \`search\` 去找。`,
    `- \`idea_*\` 就是原生工具:直接调用(参数按各工具 schema 传),不要包进 \`execute\`;它不在 Code Mode 的工具目录里,\`search\` 搜不到。`,
    `- 路径在 \`${projectPath}\` 内的代码与文件操作,必须使用 \`idea_*\` 工具。`,
    `- 路径在 \`${projectPath}\` 外:用其他可用工具。`,
    `- 工具列表里看不到 \`idea_*\` 就是没接上:提示用户执行 \`/open-in-idea\`,不要重试,也不要去别处找。`,
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
    ...runLifecycle,
    ``,
    `### 命令执行`,
    ...commandExecutionLines(present),
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
 * Recovery instruction for a marked project, where the plugin reconnects the
 * IDE MCP on its own. The model must not fall back to "ask the user" when a
 * single connection error is all it saw — the reconnect is already happening.
 */
export const MCP_RECOVERY_GUIDANCE_MARKED = [
  '### IDEA MCP failure recovery',
  'This project is IDEA-connected and the plugin reconnects the IDE MCP automatically. When an idea_* call fails with a connection error (for example `MCP server "idea" is not available`), do not run extra probes or wait in tool calls: the reconnect is already under way, so retry the operation once. Only if it still fails, tell the user that IDEA MCP is unavailable and to run /open-in-idea.',
].join('\n');

/**
 * Recovery instruction for a marked project whose idea_* tools are NOT in this
 * request's tool list. The connection dropped and the plugin is already
 * reconnecting, but the reconnect only lands on a LATER request — so within this
 * one a call can only fail with `No tool named "..." is currently available`.
 * Saying "retry" here (as the MARKED variant does) is what makes the model fire
 * exactly that doomed call.
 */
export const MCP_RECOVERY_GUIDANCE_RECONNECTING = [
  '### IDEA MCP failure recovery',
  'No idea_* tool is in this request: the IDE connection dropped and the plugin is reconnecting in the background. Do NOT call any idea_* tool now — it will fail with `No tool named "..." is currently available` — and do not go looking for them through Code Mode either: idea_* tools are only ever listed as native tools, so a search finds nothing. Do not fall back to shell/read/write for in-project work. Continue with what you can, or tell the user the IDE is reconnecting; if idea_* tools are still missing on a later message, ask the user to run /open-in-idea.',
].join('\n');

/**
 * Push the guidance onto a session `system` array. Called for every primary
 * model request, so it stays idempotent per request.
 *
 * The text depends on which run-lifecycle tools this request carries, so the
 * idempotence check compares the built text rather than assuming one variant.
 *
 * @param {unknown} system
 * @param {string} projectPath
 * @param {{ runLifecycleTools?: readonly string[] }} [options] Run-lifecycle
 *   tools present in this request's tool snapshot.
 */
export function appendIdeGuidance(system, projectPath, options = {}) {
  if (!Array.isArray(system)) return;
  if (!projectPath) return;
  const text = buildIdeGuidance(projectPath, options);
  if (system.some((part) => part?.text === text)) return;
  system.push({ type: 'text', text });
}

/**
 * @param {unknown} system
 * @param {{ marked?: boolean, serving?: boolean }} [options] `marked` picks the
 *   auto-reconnect variant; `serving: false` additionally picks the variant for
 *   a request that has no idea_* tools at all, where a call can only fail.
 */
export function appendIdeRecoveryGuidance(system, { marked = false, serving = true } = {}) {
  if (!Array.isArray(system)) return;
  const text = marked
    ? serving
      ? MCP_RECOVERY_GUIDANCE_MARKED
      : MCP_RECOVERY_GUIDANCE_RECONNECTING
    : MCP_RECOVERY_GUIDANCE;
  if (system.some((part) => part?.text === text)) return;
  system.push({ type: 'text', text });
}
