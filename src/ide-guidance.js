// IDE MCP routing guidance injected into the model's system prompt.
//
// The TEXT lives in `ide-guidance.template.md`, not here. It is a prompt document
// a human has to review as a document — plain Markdown, with only the per-project
// command lists (`{{cmd_xxx}}`) generated — and building it by concatenating
// arrays made the result impossible to read without running the code. The
// template renders byte-for-byte to what the model receives; see `src/template.js`
// for why the renderer is 60 lines here rather than an engine dependency.
//
// Two rules for the document itself:
//   1. Per tool: what it does, its parameters, and the positive flow for using
//      it. No caveats or edge cases, and nothing about languages or frameworks —
//      the project's own setup decides that.
//   2. What the NATIVE tools cannot do, or do badly, is what gets routed here;
//      reading, writing and searching stay on the native tools.
//
//   Rule 2 used to read "only IDE-only capability" — but "IDE-only" is not a
//   property of the tool, it is a property of the MODEL: OpenCode's own
//   multi-file `patch` exists, it is just only exposed to GPT models, so on
//   any other model `apply_patch` is the only multi-file writer there is. The
//   question to ask is therefore not "does the native tool exist" but "can the
//   native tool do this well here".
//
//   The document is organised by THAT question, and the first section answers
//   it by scope: inside a project the native tools lead and the IDE tools fill
//   the gaps; outside a project the IDE tools do not apply at all (the IDE
//   only resolves paths inside an opened project and errors on anything else).
//
// 校验 (lint / build) is one place that also carries a *when*, because the tools
// are not there to be offered — they are there to be used unprompted, and the
// model simply skips them (observed: it went and compiled by hand in `shell`
// instead, then reported success). The rule is a decision, not a mandate: batch
// edits → one `build_project` at the end, single-file fiddling → `lint_files`
// once when the round is over, never one check per keystroke and never zero
// checks. Spelling out both failure modes is the point — "always check" is as
// wrong as "never check", and only the model knows which round it is in.
//
// 符号 carries the same kind of *when*, for the same reason. In the observed
// session (a JetBrains plugin job on the IntelliJ Platform API) the model ran 398
// shells and mentioned `javap` 175 times in its own reasoning while mentioning
// `search_symbol` three times, two of which were after the user insisted. So the
// text now names the *situation* first ("you want to know how this class or
// method is implemented"), then bans the route it actually takes (`javap`,
// `unzip` on a hand-assembled jar path) with the reason that wins that argument:
// the IDE index holds the copy the project compiles against, and it hands back
// decompiled source instead of a bytecode listing.
//
// ## 一个会话,多个项目,多套前缀
//
// 每个接入的项目都用**自己的** MCP server 注册（root = `ide`，子项目 = 目录名），
// 所以同一个 IDE 工具会以 `ide_search_symbol` / `modelserver_search_symbol` 这样多份
// 出现。但**功能是同一套,只有前缀不同** —— 所以模板只写一遍功能说明,每条功能后面用
// `{{cmd_xxx}}` 列出它在各项目下的命令名（由 `commandVariables` 扫模板自动生成）。
//
// 这样模型同时拿到"这条功能是什么"和"这个项目里它叫什么",不需要自己拼前缀 —— 少一层
// 推理,就少一类"拿错项目工具"的失败;而且文本不会随项目数成倍增长。
//
// The guidance describes the companion plugin's tools (`idea-mcp-enhance`)
// unconditionally: that plugin is a hard prerequisite, not an optional extra, so
// there is nothing to detect here. A tool named in the guidance is expected to be
// in the request; if it is not, the installation is wrong, and hiding the text
// would only make that harder to notice.
//
// The template is therefore plain Markdown with no `{{#if …}}` blocks at all —
// only the per-project command lists (`{{cmd_xxx}}`) are generated.

import { readFileSync } from 'node:fs';

import { IDE_LABELS } from './ide-projects.js';
import { renderTemplate } from './template.js';

/** The prompt document, next to this module so it ships with it. */
const TEMPLATE_PATH = new URL('ide-guidance.template.md', import.meta.url);

/**
 * 远程执行的指引。`remote_*` 是**插件自己**的工具（不带 `<前缀>_`、IDE 关掉也在），
 * 所以这份文本与 IDE 连接状态无关，单独渲染、单独注入。
 */
const REMOTE_TEMPLATE_PATH = new URL('plugin-tools-guidance.template.md', import.meta.url);

/** Read once: the file is fixed for the life of the process, and this runs per request. */
const TEMPLATE = readFileSync(TEMPLATE_PATH, 'utf8');

/** 同上，只为远程工具那份。 */
const REMOTE_TEMPLATE = readFileSync(REMOTE_TEMPLATE_PATH, 'utf8');

/**
 * 「本会话有哪些项目、各自用哪个 MCP 工具前缀」的清单。
 *
 * 放在公共段最前面,是因为模型**先要知道"该用哪个前缀"**,再去看具体工具。没有这张清单,它得从
 * 每一节的标题里自己重建映射 —— 那是多一次推理,而推理错了的代价是"拿 root 的工具去操作
 * 子项目",恰恰是这套多前缀设计要防的事。
 *
 * 明确写出"根项目 / 子项目"这个层级词:前缀本身(root `ide` vs 子项目目录名)不足以让模型一眼
 * 看出谁是谁,而它的判断依据是"这个文件在哪个目录下"。
 *
 * @param {ReadonlyArray<{ label: string, path: string, app: string, server: string, isRoot: boolean }>} projects
 */
function routeTableFor(projects) {
  const hasChildren = projects.some((project) => !project.isRoot);
  return projects
    .map((project) => {
      const kind = project.isRoot ? '根项目' : '子项目';
      const ide = IDE_LABELS[project.app] ?? project.app;
      // 根项目的那一行必须写明"不含下列子项目" —— 子项目就在它的目录树里,不写清楚,
      // "modelserver 的文件算根项目还是子项目"就成了模型要自己猜的问题。
      const scope = project.isRoot && hasChildren ? ',**不含下列子项目**' : '';
      return `- **${kind}** \`${project.label}\`(${ide} 打开)→ MCP 工具前缀 \`${project.server}_*\`,项目路径 \`${project.path}\`${scope}`;
    })
    .join('\n');
}

/**
 * 每条功能在各项目下的命令名，预渲染成一行。
 *
 * 变量名**直接扫模板得到**:模板里写 `{{cmd_search_symbol}}`，这里就填
 * `` `根项目 ide_search_symbol` ｜ `modelserver modelserver_search_symbol` ``。
 * 所以模板增删一条工具不需要动这里的代码，也不会出现"模板里写了、代码忘了给值"的空行。
 *
 * 每个项目都列:配套插件是硬前提,每个接入的 IDE 都装了它,所以不需要再按工具快照逐项目
 * 过滤"这个项目有没有这个工具"。
 *
 * @param {ReadonlyArray<{ label: string, server: string, isRoot: boolean }>} projects
 */
function commandVariables(projects) {
  /** @type {Record<string, string>} */
  const variables = {};
  for (const match of TEMPLATE.matchAll(/\{\{\s*(cmd_[A-Za-z0-9_]+)\s*\}\}/g)) {
    const name = match[1];
    const suffix = name.slice('cmd_'.length);
    // 每条都写清"哪个项目 → 哪个命令"：根项目直接用它的角色名,子项目用目录名。
    // 不写 `.`/目录名这种需要回看清单才能解读的代号 —— 模型读每条功能时不必回头查表。
    variables[name] = projects
      .map((project) => `${project.isRoot ? '根项目' : project.label} \`${project.server}_${suffix}\``)
      .join(' ｜ ');
  }
  return variables;
}

/**
 * 把本会话接入的全部项目渲染成**一份**引导文本。
 *
 * 只渲染一次,不按项目重复:功能说明与项目无关,只有命令名带项目前缀 —— 所以每条功能后面直接
 * 列出各项目的命令名(`cmd_*` 变量),而不是把整份工具清单按前缀抄 N 遍。
 *
 * @param {ReadonlyArray<{ path: string, server: string, app: string, label: string, isRoot: boolean }>} projects
 * @returns {string}
 */
export function buildIdeGuidanceText(projects) {
  return renderTemplate(TEMPLATE, {
    projectCount: projects.length,
    routeTable: routeTableFor(projects),
    ...commandVariables(projects),
  });
}

export const MCP_RECOVERY_GUIDANCE = [
  '### IDE MCP failure recovery',
  'If an IDE MCP tool (the `<prefix>_*` ones) is missing, MCP is disconnected, the connection is refused, or a tool times out: stop retrying immediately; do not run extra probes or wait in tool calls. Tell the user that IDE MCP is unavailable and ask them to run /open-in-ide to reconnect.',
].join('\n');

/**
 * Recovery instruction for a marked project, where the plugin reconnects the
 * IDE MCP on its own. The model must not fall back to "ask the user" when a
 * single connection error is all it saw — the reconnect is already happening.
 */
export const MCP_RECOVERY_GUIDANCE_MARKED = [
  '### IDE MCP failure recovery',
  'This project is IDE-connected and the plugin reconnects the IDE MCP automatically. When an IDE MCP call fails with a connection error (for example `MCP server "ide" is not available`), do not run extra probes or wait in tool calls: the reconnect is already under way, so retry the operation once. Only if it still fails, tell the user that IDE MCP is unavailable and to run /open-in-ide.',
].join('\n');

/**
 * Recovery instruction for a marked project whose IDE tools are NOT in this
 * request's tool list. The connection dropped and the plugin is already
 * reconnecting, but the reconnect only lands on a LATER request — so within this
 * one a call can only fail with `No tool named "..." is currently available`.
 * Saying "retry" here (as the MARKED variant does) is what makes the model fire
 * exactly that doomed call.
 */
export const MCP_RECOVERY_GUIDANCE_RECONNECTING = [
  '### IDE MCP failure recovery',
  'No IDE MCP tool (the `<prefix>_*` ones) is in this request: the IDE connection dropped and the plugin is reconnecting in the background. Do NOT call any of them now — it will fail with `No tool named "..." is currently available` — and do not go looking for them through Code Mode either: they are only ever listed as native tools, so a search finds nothing. Do not fall back to shell/read/write for in-project work. Continue with what you can, or tell the user the IDE is reconnecting; if the tools are still missing on a later message, ask the user to run /open-in-ide.',
].join('\n');

/**
 * Push the guidance onto a session `system` array. Called for every primary
 * model request, so it stays idempotent per request.
 *
 * The text depends only on which projects are connected, and the idempotence check
 * compares the built text rather than assuming one variant.
 *
 * @param {unknown} system
 * @param {ReadonlyArray<{ path: string, server: string, app: string, label: string, isRoot: boolean }>} projects
 */
export function appendIdeGuidance(system, projects) {
  if (!Array.isArray(system)) return;
  if (!Array.isArray(projects) || projects.length === 0) return;
  const text = buildIdeGuidanceText(projects);
  if (system.some((part) => part?.text === text)) return;
  system.push({ type: 'text', text });
}

/**
 * 远程执行的指引，**与 IDE 连接状态无关**。
 *
 * `remote_*` 是插件常驻注册的工具：IDE 关掉时它们仍然能跑（服务器列表退到 hosts.json）。
 * 所以这段不能跟着 `appendIdeGuidance` 一起在 `serving === false` 时被跳过 —— 否则模型手上有
 * `remote_exec`，却没有任何说明告诉它该用、怎么传参。
 *
 * @returns {string}
 */
export function buildRemoteGuidanceText() {
  return renderTemplate(REMOTE_TEMPLATE, {});
}

/**
 * @param {unknown} system
 */
export function appendRemoteGuidance(system) {
  if (!Array.isArray(system)) return;
  const text = buildRemoteGuidanceText();
  if (system.some((part) => part?.text === text)) return;
  system.push({ type: 'text', text });
}

/**
 * @param {unknown} system
 * @param {{ marked?: boolean, serving?: boolean }} [options] `marked` picks the
 *   auto-reconnect variant; `serving: false` additionally picks the variant for
 *   a request that has no IDE tools at all, where a call can only fail.
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
