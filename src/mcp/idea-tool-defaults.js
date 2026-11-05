// Arguments this plugin OWNS on the IDE's own MCP tools.
//
// Two files, two different subjects — kept apart on purpose:
//
//   * `idea.js`             the IDE's bundled MCP server: endpoint, transport, probe
//   * `idea-tool-defaults`  (this file) that server's TOOL CATALOG, and the
//                           arguments on it that this plugin controls
//
// The companion plugin's own tools are not managed here at all: they are a hard
// prerequisite, passed through untouched.
//
// ## Why an argument can be owned at all
//
// `ide_build_project` 是模型判断
// 刚写的代码能否编译的唯一手段,而它的结论依赖模型看不到的文件新鲜度:
// an INCREMENTAL build compares against the IDE's own view of the files and
// recompiles only what that view calls dirty. When the edit happened OUTSIDE the
// IDE, the view can still be clean and the build becomes a no-op that reports
// success — a false "it compiles", the worst possible answer for a model
// verifying its own edit.
//
// MEASURED (IntelliJ 2026.2.3, decompiled `AnalysisToolset` plus 6 live
// scenarios): `build_project` maps to
// `ProjectTaskManager.createAllModulesBuildTask(project, isIncrementalBuild = !rebuild)`,
// so `rebuild: true` is the switch that makes the answer independent of VFS
// freshness. All six scenarios (edit an existing file / add a new one, in any
// package, open in the editor or not) were detected with `rebuild: true`, and
// only intermittently without it.
//
// ## Two halves of the same decision
//
// An argument that is always overwritten must not also be advertised. Leaving it
// in the schema would let the model set it, reason about it, and be wrong, while
// the value it wrote is silently discarded. So [`FORCED_ARGUMENTS`] drives both
// halves from one table:
//
//   * [hideForcedArguments]     drops it from the published input schema
//   * [applyIdeaToolDefaults]   sets the value on every call
//
// ## On rewriting a tool's schema
//
// This is a departure from the earlier "never touch tool definitions" rule, and it
// is deliberately narrow: nothing here INVENTS or EXPLAINS. The IDE's own
// `build_project` description does not mention the argument at all — only its
// per-property description does — so removing the property leaves a schema that
// is still internally consistent and still entirely the IDE's. What a schema
// transform must never do is add advice; that belongs to the guidance text.

/**
 * Arguments this plugin sets on every call, and therefore must not advertise.
 *
 * 工具用**后缀**标识，不写完整名字：IDE 工具都以 `ide_` 开头，写死 `idea_...` 会
 * 永远命中不了 —— 那正是这个模块要避免的"schema 说一套、调用做另一套"。
 *
 * @type {ReadonlyArray<{ suffix: string, argument: string, value: unknown }>}
 */
export const FORCED_ARGUMENTS = [
  {
    suffix: 'build_project',
    argument: 'rebuild',
    value: true,
  },
  {
    // `search_symbol` 默认只搜项目符号，要搜 SDK / 依赖库得模型自己记得带这个开关。
    // 我们恒定打开并把参数从 schema 里拿掉：模型看不到这个旋钮，但拿到的永远是全的结果。
    suffix: 'search_symbol',
    argument: 'include_external',
    value: true,
  },
];

/**
 * 覆盖 IDE 自带工具的描述。
 *
 * 只改**事实**：这个工具做什么、返回什么、什么时候用不上。不写"你应该怎么用"——那是引导的事。
 *
 * 为什么需要：IDE 的描述是 JetBrains 写的，参数含义、默认值、返回结构都可能随版本变；
 * 我们只在**原文说错了**或**该说清的关键事实没提**时覆盖，并且只覆盖事实、不动参数。
 *
 * 覆盖是**整段替换**，不与原文拼接：半原文半我们的句子，读起来像两套口径，容易自相矛盾。
 * 被覆盖的工具说明我们为什么必须改它。
 *
 * @type {ReadonlyArray<{ suffix: string, description: string, why: string }>}
 */
export const DESCRIPTION_OVERRIDES = [
  {
    suffix: 'search_symbol',
    why: '原文说"默认只搜项目符号，不行再带 include_external" —— 我们恒定开着它，这句就变成假话。',
    description: `Searches for symbols (classes, methods, fields) by name fragment.

Returns the declaration position (1-based line/column). This searches symbol declarations, not
"which text mentions it" — use \`grep\` for text. For call graphs, locate the target here first,
then pass the fully qualified name to \`analyze_calls\`.

Searches the project, SDK and library symbols alike. \`paths\` narrows it with project-relative
globs.`,
  },
  {
    suffix: 'read_file',
    why: '原文没说它和原生 read 的分工，也没说包内条目的几种写法 —— 模型会拿它读普通文件。',
    description: `Reads a file in the project, or a source file that lives inside a dependency.

Use the native \`read\` for ordinary files — it is faster. Reach for this tool when the target is
not a plain source file:

- an entry inside a dependency jar: \`<path-to.jar>!/<entry>\` (relative or absolute), or
  \`jar://<absolute-path-to.jar>!/<entry>\`
- the JDK image: \`jrt://…\`
- a \`.class\` file, which is decompiled to source

Paths are resolved against the project, so a path returned by \`search_symbol\` can be passed
through as is.

Returns numbered lines (1-based). Reads up to 2000 lines from the start by default; pass \`offset\`
and \`limit\` for a slice, and \`limit\` is capped at 5000.`,
  },
  {
    suffix: 'build_project',
    why: '原文读起来像增量构建；我们把 rebuild 恒定为 true，每次都是全量。',
    description: `Triggers a build of the project — or of the given files — waits for completion, and returns
compilation errors and warnings.

Use it to check that edits compile. The build is always a full one: the incremental switch is not
exposed, so expect it to take a while on a large project.`,
  },
  {
    suffix: 'list_directory_tree',
    why: '原文没说为什么用它而不是 ls，也没说树会被深度截断。',
    description: `Lists a directory as a tree, the way the \`tree\` utility does.

Prefer it over \`ls\` / \`dir\` / \`find\` for exploring a project: it respects the project's content
roots and excluded paths, so build output and dependency folders do not show up as if they were
source.

Paths are relative to the project root. The tree is cut at \`maxDepth\`; when that happens the
result says so explicitly, so a truncated tree is never mistaken for an empty directory.`,
  },
  {
    suffix: 'apply_patch',
    why: '原文只说格式；没说它用于多文件同改、按文本不按语义、部分应用要回头补。',
    description: `Applies a patch that touches several files at once — the Codex apply_patch format or a unified
git diff. \`edit\` and \`write\` change one file each, and the native \`patch\` tool is not available on
every model, so this is the tool for "the same change in a dozen files".

It matches text, not meaning: to rename a symbol use the IDE's rename refactoring instead.

Only the lines the patch spells out are touched. When a hunk's context does not match, that file
is left unchanged and the result reports \`N out of M operations applied\` — check which files are
missing and re-apply them.`,
  },
  {
    suffix: 'rename_refactoring',
    why: '原文很长且重复；没提"只改代码"和 with N usages 的含义。',
    description: `Renames a symbol and updates every real reference to it across the project — classes, methods,
fields, variables. It matches meaning, not text, so it is the right tool whenever the thing being
renamed is a declared symbol.

It only touches code: comments, string literals and same-named symbols in other languages are
left alone. \`with N usages\` reports how many real references were updated; a smaller number than
you expect means some files are not in the IDE index yet.

To change something that is not a symbol — a config key, a placeholder, a string in a doc — edit
that text directly instead.`,
  },
  {
    suffix: 'lint_files',
    why: '原文罗列了部分结果机制，却没说"没被分析"不等于"没问题"。',
    description: `Runs IntelliJ's inspections over a set of files and returns the problems it finds — severity,
description and location.

Use it on the files you changed; \`get_file_problems\` is the single-file version with the same
detail.

Only files inside the project are analyzed, and only the file types IntelliJ supports.
\`min_severity\` is \`warning\` by default, or \`error\`.

The batch can be partial: an entry with \`timedOut: true\` or a \`notAnalyzedReason\` was not
analyzed, and a top-level \`more: true\` means files are missing from the result. Those files are
**unchecked**, not clean.`,
  },
  {
    suffix: 'get_file_problems',
    why: '原文同一件事说三遍；没提和 lint_files 的分工。',
    description: `Runs IntelliJ's inspections on one file and returns the problems it finds — severity, description
and location. Lines and columns are 1-based.

Use it for the single file you want the detail on; \`lint_files\` is the batch version. Files
outside the project cannot be analyzed.`,
  },
  {
    suffix: 'analyze_calls',
    why: '原文很长；核心（比 grep 准、要有全限定名）在中间被参数细节埋掉了。',
    description: `Builds the IDE call hierarchy for a symbol: who calls it (\`INCOMING_CALLS\`) or what it calls
(\`OUTGOING_CALLS\`). It reads IDE call data, so it is more precise than grepping for usages.

Pass \`symbolFqn\` as a fully qualified name (\`com.example.Service.run\`); if the name is ambiguous
the tool returns the exact signatures to choose from. If you only have a short fragment, find the
target with \`search_symbol\` first. Dependencies the IDE can resolve — source jars, decompiled
classes — work too.

The result is a tree: each node carries \`filePath\` and \`treePath\`, and passing a \`treePath\` back
renders that subtree. \`depth\`, \`maxChildren\` and \`maxNodes\` bound the output; \`childOffset\`
continues past a truncated \`… and n more\` line.`,
  },
  {
    suffix: 'get_symbol_info',
    why: '原文同一件事说三遍；没说它和 search_symbol 的分工。',
    description: `Returns the symbol at a position in a file: name, signature, type and documentation — the same
information the IDE's Quick Documentation shows. When the position is a reference, the
declaration is included when the IDE can resolve it.

Use it once you know where the symbol is; \`search_symbol\` is how you find that position when you
only know the name.`,
  },
  {
    suffix: 'reformat_file',
    why: '原文只说"代码格式化规则"，丢掉了文档也能格式化、以及从磁盘重读这两个事实。',
    description: `Reformats the given files with the IDE's code style. Paths are project-relative.

Use it after writing code so the formatting matches the project. It handles documents too — for
Markdown it fixes table alignment and line width — and it re-reads from disk, so files written
outside the IDE can be formatted directly.`,
  },
  {
    suffix: 'get_all_open_file_paths',
    why: '原文的 "explore current open editors" 太含糊，容易被当成"最近改过哪些文件"。',
    description: `Lists the files currently open in IDE editors — the active one and any others — as
project-relative paths.

It reflects the editors only: a file the user edited but has not opened is not in the list. Use
it to find out what the user is looking at right now.`,
  },
  {
    suffix: 'open_file_in_editor',
    why: '原文没说它不返回内容 —— 模型可能以为"打开"能顺便读到文件。',
    description: `Opens a file in the IDE editor and focuses that tab.

This is for showing the user a file — it returns no content. Use \`read\` to read one.`,
  },
  {
    suffix: 'get_run_configurations',
    why: '原文很长；且没说"看单个配置全貌"该用 inspect。',
    description: `Lists the project's run configurations — names plus launch details when the IDE knows them
(program arguments, working directory, environment).

With \`filePath\` instead, it finds the run points in that file — test methods, main methods, the
places the IDE shows a Run gutter icon — and returns their line numbers.

To see one configuration in full (options, before-launch steps, raw XML, history), use
\`inspect_run_configuration\`.`,
  },
];

/** 由前缀集合拼出这张表涉及的**全部**真实工具名。 */
export function forcedToolNames(prefixes) {
  return prefixes.flatMap((prefix) => FORCED_ARGUMENTS.map((owned) => `${prefix}${owned.suffix}`));
}

/**
 * Set every owned argument on one call.
 *
 * Mutates `input` in place and reports whether anything changed, so a caller can
 * keep "the model asked for this" apart from "we forced it". Unknown tools and
 * malformed drafts are left untouched — this function owns the tools it names and
 * nothing else.
 *
 * Called from `execute.before`, which hands out a mutable draft. The runtime
 * validates a tool call against the schema published for THAT request and only
 * then runs the hook, so setting a property the schema no longer advertises is
 * safe.
 *
 * @param {unknown} tool Effective tool name for this call (`event.tool`).
 * @param {unknown} input Mutable argument draft for this call (`event.input`).
 * @param {readonly string[]} prefixes 当前 IDE 工具前缀（`ide_`）。
 * @returns {boolean} Whether `input` was modified.
 */
export function applyIdeToolDefaults(tool, input, prefixes) {
  if (typeof tool !== 'string') return false;
  if (input === null || typeof input !== 'object') return false;

  let changed = false;
  for (const owned of FORCED_ARGUMENTS) {
    const matches = prefixes.some((prefix) => tool === `${prefix}${owned.suffix}`);
    if (!matches) continue;
    if (input[owned.argument] === owned.value) continue;
    input[owned.argument] = owned.value;
    changed = true;
  }
  return changed;
}

/**
 * Arguments this plugin only ever RAISES to a floor, never pins.
 *
 * 和 [`FORCED_ARGUMENTS`] 的区别是**单向**:调用方给了更大的值就照用,只把"太小或没给"抬到下限。
 * 所以参数必须继续留在 schema 里 —— 模型仍然需要它,`hideForcedArguments` 也不碰它。
 *
 * `list_directory_tree` 的 `maxDepth` 是**绝对深度上限**,但实际只展开到 `maxDepth-1` 层,省略时默认 5
 * (只展开 4 层)。实测(2026-10,真实 MCP 调用):`maxDepth=6` 时 Java 包树正好断在包目录那一层,而输出里
 * 没有任何截断标记 —— 一棵被切的树和一个空目录长得一模一样,模型据此判定"工具看不到这个目录",
 * 整条查询链退回 `shell` 里的 `find` / `grep` / `sed`,从此丢掉 `.gitignore` 规则。抬到 50 是实测
 * 无副作用的量级(同一目录 50 与 8 输出完全一致)。
 *
 * @type {ReadonlyArray<{ suffix: string, argument: string, minimum: number }>}
 */
export const RAISED_ARGUMENTS = [
  {
    suffix: 'list_directory_tree',
    argument: 'maxDepth',
    minimum: 50,
  },
];

/**
 * Raise a floor argument on one call. Never lowers, never pins.
 *
 * Mutates `input` in place and reports whether anything changed. A non-numeric
 * value counts as "not given": this function cannot vouch for what a string
 * `"6"` means, so it replaces it with the floor rather than trusting it.
 *
 * @param {unknown} tool Effective tool name for this call (`event.tool`).
 * @param {unknown} input Mutable argument draft for this call (`event.input`).
 * @param {readonly string[]} prefixes 当前 IDE 工具前缀（`ide_`）。
 * @returns {boolean} Whether `input` was modified.
 */
export function raiseMinimumArguments(tool, input, prefixes) {
  if (typeof tool !== 'string') return false;
  if (input === null || typeof input !== 'object') return false;

  let changed = false;
  for (const raised of RAISED_ARGUMENTS) {
    const matches = prefixes.some((prefix) => tool === `${prefix}${raised.suffix}`);
    if (!matches) continue;
    const current = input[raised.argument];
    if (typeof current === 'number' && Number.isFinite(current) && current >= raised.minimum) continue;
    input[raised.argument] = raised.minimum;
    changed = true;
  }
  return changed;
}

/**
 * 把 DESCRIPTION_OVERRIDES 里的描述盖到 IDE 自带工具上。
 *
 * 整段替换，不与原文拼接。工具没注册（IDE 没连上）时什么也不做。
 *
 * @param {{
 *   get: (id: string) => { description?: unknown } | undefined,
 *   update: (id: string, update: (tool: { description?: unknown }) => void) => void,
 * }} editor
 * @param {readonly string[]} prefixes
 */
export function applyDescriptionOverrides(editor, prefixes) {
  for (const override of DESCRIPTION_OVERRIDES) {
    for (const prefix of prefixes) {
      const name = `${prefix}${override.suffix}`;
      const tool = editor.get(name);
      if (!tool) continue;
      if (tool.description === override.description) continue;
      editor.update(name, (draft) => {
        draft.description = override.description;
      });
    }
  }
}

/**
 * Drop one property from a JSON schema, returning a new object.
 *
 * Returns the input unchanged (by reference) when there is nothing to remove, so
 * callers can skip an otherwise pointless edit. Everything else — including
 * `additionalProperties` — is copied through untouched: this function only takes
 * something away, and must never become a place where schema semantics change.
 *
 * @param {unknown} schema
 * @param {string} name
 * @returns {unknown} The new schema, or `schema` itself when unchanged.
 */
export function removeSchemaProperty(schema, name) {
  if (schema === null || typeof schema !== 'object') return schema;
  const properties = schema.properties;
  if (properties === null || typeof properties !== 'object') return schema;
  if (!(name in properties)) return schema;

  const nextProperties = { ...properties };
  delete nextProperties[name];

  const next = { ...schema, properties: nextProperties };
  if (Array.isArray(schema.required)) {
    const required = schema.required.filter((entry) => entry !== name);
    // Drop an emptied `required` rather than leaving `[]` behind: the two mean
    // the same thing on the wire, but a stale empty array reads like intent.
    if (required.length > 0) next.required = required;
    else delete next.required;
  }
  return next;
}

/**
 * Remove every owned argument from the tools this plugin controls.
 *
 * Takes the `ctx.tool.transform` editor (`list` / `get` / `update`). Written
 * against that surface rather than against OpenCode's types so it stays a pure
 * function of what it is given — which is also what makes it testable without a
 * runtime.
 *
 * 每个前缀各处理一遍：同一个 IDE 工具会在工具表里出现多份，漏掉任何一份都会
 * 让那一份的 schema 继续广告这个旋钮。
 *
 * Safe to run when the IDE is absent: `get` returns undefined for a tool that is
 * not registered, and OpenCode replays the transform after every MCP catalog
 * refresh, so the tools are adjusted once they appear.
 *
 * @param {{
 *   get: (id: string) => { input?: unknown } | undefined,
 *   update: (id: string, update: (tool: { input?: unknown }) => void) => void,
 * }} editor
 * @param {readonly string[]} prefixes
 */
export function hideForcedArguments(editor, prefixes) {
  for (const name of forcedToolNames(prefixes)) {
    const owned = FORCED_ARGUMENTS.find((entry) => name.endsWith(entry.suffix));
    if (!owned) continue;
    const tool = editor.get(name);
    if (!tool) continue;
    const next = removeSchemaProperty(tool.input, owned.argument);
    if (next === tool.input) continue;
    // Assign the whole schema: the editor documents that schemas are replaced,
    // not mutated in place.
    editor.update(name, (draft) => {
      draft.input = next;
    });
  }
}
