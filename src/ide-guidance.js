// IDE MCP routing guidance injected into the model's system prompt.
//
// The TEXT lives in `ide-guidance.template.md`, not here. It is a prompt document
// a human has to review as a document — with the conditionals visible as
// `{{#if …}}` around the lines they control — and building it by concatenating
// arrays made the result impossible to read without running the code. The
// template renders byte-for-byte to what the model receives; see `src/template.js`
// for why the renderer is 60 lines here rather than an engine dependency.
//
// Two rules for the document itself:
//   1. Per tool: what it does, its parameters, and the positive flow for using
//      it. No caveats or edge cases, and nothing about languages or frameworks —
//      the project's own setup decides that.
//   2. Only IDE-only capability is routed here; reading, writing and searching
//      stay on the native tools.
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
// The `{{#if can…}}` blocks gate the companion plugin's tools (`mcp/enhance.js`),
// which only exist when the user installed it. Nothing in the document says so:
// which plugin a tool came from is this plugin's plumbing, not the model's
// business — it either sees the tool or it does not. The deployment section is
// gated on ONE of those flags (`canListDeploymentServers`) rather than on a flag of
// its own: the four tools are registered together, so one of them answers for the
// section — heading included, which is why the gate wraps the `###` line too.

import { readFileSync } from 'node:fs';

import { IDE_LABELS } from './ide-projects.js';
import {
  DEPLOYMENT_SUFFIXES,
  RUN_LIFECYCLE_SUFFIXES,
  deploymentCapabilities,
  runLifecycleCapabilities,
  servesTool,
} from './mcp/enhance.js';
import { renderTemplate } from './template.js';

/** The prompt document, next to this module so it ships with it. */
const TEMPLATE_PATH = new URL('ide-guidance.template.md', import.meta.url);

/** Read once: the file is fixed for the life of the process, and this runs per request. */
const TEMPLATE = readFileSync(TEMPLATE_PATH, 'utf8');

/**
 * 配套插件那两组工具的后缀全集 —— 判据只有一条:**这张表里的工具按项目分别存在**。
 *
 * 表外(内置 MCP Server 自带的那批)是每个项目都有的,列命令名时不需要看快照;表内的必须
 * 逐项目核对(见 {@link commandVariables})。两组都收进来而不是只收部署那组:它们的
 * 存在性本来就按项目、按 IDE 不同 —— 启停工具取决于装没装配套插件,部署工具还多一道
 * "是不是 Ultimate"。把 run-lifecycle 留在表外,等于默认"一个项目装了、别的项目也装了",
 * 而那只是个默认,不是事实。
 */
const ENHANCE_SUFFIXES = new Set([...RUN_LIFECYCLE_SUFFIXES, ...DEPLOYMENT_SUFFIXES]);

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
 * **配套插件那条线要逐项目过滤**（见 {@link ENHANCE_SUFFIXES}）：内置工具每个项目都有,列全即可;
 * 而 `idea-mcp-enhance` 的工具是**按项目分别存在**的(装了插件的那个 IDE 有,另一个可能没有;
 * 部署那组还要求 Ultimate)。它常常同进同出,但"通常"不是"总是" —— 一旦不一致,列全就会在
 * 缺工具的那个项目下点名一个模型调不到的命令,而那正是这整个模块要防的失败。
 * 过滤不会产生空行:每条 bullet 的 `{{#if}}` 用的是**并集**判断(任一项目有即渲染),
 * 并集为真 ⇒ 至少一个项目通过过滤。
 *
 * @param {ReadonlyArray<{ label: string, server: string, isRoot: boolean }>} projects
 * @param {Record<string, unknown> | undefined} tools 本次请求的工具快照
 */
function commandVariables(projects, tools) {
  /** @type {Record<string, string>} */
  const variables = {};
  for (const match of TEMPLATE.matchAll(/\{\{\s*(cmd_[A-Za-z0-9_]+)\s*\}\}/g)) {
    const name = match[1];
    const suffix = name.slice('cmd_'.length);
    variables[name] = projects
      .filter((project) => !ENHANCE_SUFFIXES.has(suffix) || servesTool(tools, `${project.server}_`, suffix))
      // 每条都写清"哪个项目 → 哪个命令"：根项目直接用它的角色名,子项目用目录名。
      // 不写 `.`/目录名这种需要回看清单才能解读的代号 —— 模型读每条功能时不必回头查表。
      .map((project) => `${project.isRoot ? '根项目' : project.label} \`${project.server}_${suffix}\``)
      .join(' ｜ ');
  }
  return variables;
}

/**
 * 本会话里这些 run-lifecycle 能力可不可用。
 *
 * 提示词只有一份，所以这里要回答的是"这套能力在本次会话里存不存在" —— 任一项目提供即算存在。
 * 同一个人的几个 IDE 装不装配套插件通常是一致的；万一不一致，模板里那句"没装就交给用户"兜住。
 *
 * @param {ReadonlyArray<{ server: string }>} projects
 * @param {Record<string, unknown> | undefined} tools
 */
function mergeRunLifecycle(projects, tools) {
  const all = projects.map((project) => runLifecycleCapabilities(tools, `${project.server}_`));
  return {
    canCreateRunConfiguration: all.some((c) => c.canCreateRunConfiguration),
    canListRunningConfigurations: all.some((c) => c.canListRunningConfigurations),
    canStopRunConfiguration: all.some((c) => c.canStopRunConfiguration),
    canRerunRunConfiguration: all.some((c) => c.canRerunRunConfiguration),
  };
}

/**
 * 部署工具同理(见 `mergeRunLifecycle`):逐项目判断,任一项目提供即算存在。
 *
 * **整节的锚点就是 `canListDeploymentServers`**(模板里 `{{#if canListDeploymentServers}}` 直接包住标题):
 * 配套插件只要装了,IDE 的 MCP 工具表里就多出这一组(它们由同一道前提注册,同进同出),
 * 所以拿其中一个当判据就够了 —— 不需要再造一个"四个里任一个"的聚合标志。
 *
 * 不锚在那些"必须有工具才算"的地方也不成问题:一个都没有时 `canListDeploymentServers` 为 false,
 * 标题与正文一起消失;而这一节和前一组不同 —— run-lifecycle 那节是内置工具
 * (`get_run_configurations` / `execute_run_configuration`)撑起来的**自己的**标题,缺配套插件时标题仍在。
 * 顺带一提,这一组还额外要求 `com.jetbrains.plugins.webDeployment`(**仅 Ultimate 有**),所以
 * "整节不出现"是常态而非边角。
 *
 * @param {ReadonlyArray<{ server: string }>} projects
 * @param {Record<string, unknown> | undefined} tools
 */
function mergeDeployment(projects, tools) {
  const all = projects.map((project) => deploymentCapabilities(tools, `${project.server}_`));
  return {
    canListDeploymentServers: all.some((c) => c.canListDeploymentServers),
    canUploadToDeployment: all.some((c) => c.canUploadToDeployment),
    canDownloadFromDeployment: all.some((c) => c.canDownloadFromDeployment),
    canGetDeploymentTaskStatus: all.some((c) => c.canGetDeploymentTaskStatus),
  };
}

/**
 * 把本会话接入的全部项目渲染成**一份**引导文本。
 *
 * 只渲染一次,不按项目重复:功能说明与项目无关,只有命令名带项目前缀 —— 所以每条功能后面直接
 * 列出各项目的命令名(`cmd_*` 变量),而不是把整份工具清单按前缀抄 N 遍。
 *
 * @param {ReadonlyArray<{ path: string, server: string, app: string, label: string, isRoot: boolean }>} projects
 * @param {{ tools?: Record<string, unknown> }} [options] `tools` 是本次请求的工具快照
 *   （`event.tools`），用来判断配套插件（run-lifecycle / deployment）的工具在不在。
 * @returns {string}
 */
export function buildIdeGuidanceText(projects, options = {}) {
  return renderTemplate(TEMPLATE, {
    projectCount: projects.length,
    routeTable: routeTableFor(projects),
    ...mergeRunLifecycle(projects, options.tools),
    ...mergeDeployment(projects, options.tools),
    ...commandVariables(projects, options.tools),
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
 * The text depends on which projects are connected and which run-lifecycle tools
 * this request carries, so the idempotence check compares the built text rather
 * than assuming one variant.
 *
 * @param {unknown} system
 * @param {ReadonlyArray<{ path: string, server: string, app: string, label: string, isRoot: boolean }>} projects
 * @param {{ tools?: Record<string, unknown> }} [options]
 */
export function appendIdeGuidance(system, projects, options = {}) {
  if (!Array.isArray(system)) return;
  if (!Array.isArray(projects) || projects.length === 0) return;
  const text = buildIdeGuidanceText(projects, options);
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
