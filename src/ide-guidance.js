// Strong "prefer IDE tools" guidance injected into the model's SYSTEM prompt
// while the IDE MCP server is available.
//
// Modeled on a project AGENTS.md that reliably makes agents prefer IDE tools:
// a firm default ("default to IDE MCP"), a capability mapping, usage tips, and
// explicit fall-back exceptions. Injected via
// `ctx.session.hook("context", (event) => event.system.push(...))`, which runs
// for every primary model request (see src/plugin.js).
//
// NAMING: OpenCode registers MCP tools by namespace + name.
//   * normal tool list (the model calls it directly): `idea_<tool>`
//     e.g. idea_search_text — namespace "idea" + "_" + "search_text".
//   * Code Mode catalog (this session: tools.idea.search_text): dotted path.
// The guidance names both forms so either mode resolves.
//
// KEY PARAMETERS (verified against the live server; wrong names fail loudly):
//   * search_* tools take `q` (NOT `query`), plus optional `paths` (project-
//     relative globs, `!` to exclude). `q` is required.
//   * read_file takes `file_path`, `offset`, `limit`.
//   * apply_patch takes `input` (the patch text); create_new_file takes
//     `pathInProject` (required) + optional `text`, `overwrite`.

/** The guidance text appended to the system prompt. */
export const IDE_GUIDANCE = [
  '## 项目内操作默认走 IDE MCP(JetBrains)',
  '当前项目已在 JetBrains IDE 中打开,IDE 的 MCP 工具可用(普通工具表里叫 `idea_<name>`,如 `idea_search_text`;Code Mode 里叫 `idea.<name>`,如 `idea.search_text`)。项目内的**检索 / 读文件 / 改文件 / 校验 / 目录浏览,一律优先用这些工具**——它们基于 IDE 索引与语义,比原生工具更准;只有它们做不了、不可用或报错时才回退原生工具(正常回退,无需声明)。',
  '',
  '能力映射(常用,非穷举;参数名按实际 schema,写错会报 `Missing key`):',
  '- 文本 / 正则 / 文件名检索:`idea_search_text` / `idea_search_regex` / `idea_search_file` —— 参数 `q`(**不是 `query`**),可带 `paths`(项目相对 glob,`!` 排除)收窄;基于 IDE 索引、不扫 `node_modules`',
  '- 符号 / 语义:`idea_search_symbol` / `idea_get_symbol_info` / `idea_analyze_calls`(只用 `depth=1`)',
  '- 读文件:`idea_read_file`(参数 `file_path` / `offset` / `limit`;窗口是 `[offset, 末行]`,读中段必须显式传 `offset`)',
  '- 目录浏览:`idea_list_directory_tree`(代替 `ls`/`find`,`maxDepth` ≥ 2)',
  '- 改文件:`idea_apply_patch`(参数 `input`,传 patch 文本);新建文件:`idea_create_new_file`(参数 `pathInProject`,可选 `text` / `overwrite`)',
  '- 校验:`idea_lint_files` / `idea_get_file_problems`(单次 1~2 个文件)/ `idea_build_project`(`filesToRebuild` 传单文件做增量)',
  '- 重构 / 格式化:`idea_rename_refactoring` / `idea_reformat_file`',
  '- 结构 / 依赖:`idea_get_project_modules` / `idea_get_project_dependencies`',
  '- 版本状态:`idea_git_status`(`git status` 走这条)',
  '- 编辑器上下文:`idea_get_all_open_file_paths`;把文件推给用户看:`idea_open_file_in_editor`',
  '',
  '例外(直接用原生工具,属正常分支):`node_modules/`、`target/` 等 IDE 不索引的目录;`git diff` / `log` / `blame` 等 git 独有语义;`lsof` / `nc` / `ping` 等 MCP 无等价能力;IDE MCP 报错 / 超时;项目根之外的文件。',
].join('\n');

/**
 * Push the guidance onto a session `system` array. Called for every primary
 * model request, so it must stay idempotent per request (the array is fresh
 * each request; guard the array itself, not a module-level flag).
 */
export function appendIdeGuidance(system) {
  if (!Array.isArray(system)) return;
  if (system.some((part) => part?.text === IDE_GUIDANCE)) return;
  system.push({ type: 'text', text: IDE_GUIDANCE });
}
