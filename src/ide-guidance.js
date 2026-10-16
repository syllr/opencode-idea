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
// ## 一个会话,多个项目,多套前缀
//
// 每个接入的项目都用**自己的** MCP server 注册（root = `ide`，子项目 = 目录名），
// 所以同一个 IDE 工具会以 `ide_search_symbol` / `modelserver_search_symbol` 这样
// 多份出现。模板因此写成"单项目"的样子、里面全部用 `{{toolPrefix}}_...`，由这里
// 逐个项目渲染：第一个项目额外带出与项目无关的「总则 / 命令执行」公共段
// (`{{#if first}}`)，其余只出自己那一节。
//
// 这样模型读到的是"在 modelserver 里就用 modelserver_*"，而不是一条需要自己换算
// 前缀的规则 —— 少一层推理,就少一类"拿错项目工具"的失败。
//
// The `{{#if can…}}` blocks gate the companion plugin's tools (`mcp/enhance.js`),
// which only exist when the user installed it. Nothing in the document says so:
// which plugin a tool came from is this plugin's plumbing, not the model's
// business — it either sees the tool or it does not.

import { readFileSync } from 'node:fs';

import { IDE_LABELS } from './ide-projects.js';
import { runLifecycleCapabilities } from './mcp/enhance.js';
import { renderTemplate } from './template.js';

/** The prompt document, next to this module so it ships with it. */
const TEMPLATE_PATH = new URL('ide-guidance.template.md', import.meta.url);

/** Read once: the file is fixed for the life of the process, and this runs per request. */
const TEMPLATE = readFileSync(TEMPLATE_PATH, 'utf8');

/**
 * 「目录 → 工具前缀」速查表。
 *
 * 放进公共段,是因为模型**先要知道"该用哪个前缀"**,再去看具体工具。没有这张表,它得从
 * 每一节的标题里自己重建映射 —— 那是多一次推理,而推理错了的代价是"拿 root 的工具去操作
 * 子项目",恰恰是这套多前缀设计要防的事。
 *
 * @param {ReadonlyArray<{ label: string, app: string, server: string }>} projects
 */
function routeTableFor(projects) {
  return projects
    .map((project) => `- \`${project.label}\`（${IDE_LABELS[project.app] ?? project.app}）→ \`${project.server}_*\``)
    .join('\n');
}

/**
 * 一个项目的引导段。
 *
 * @param {{ path: string, server: string, app: string, label: string, isRoot: boolean }} project
 * @param {{
 *   first?: boolean,
 *   projectCount?: number,
 *   routeTable?: string,
 *   capabilities?: Record<string, unknown>,
 * }} [options] `first` 决定是否带出公共段；只有整份引导的第一个项目才为 true。
 *   `capabilities` 是该项目的 run-lifecycle 工具可用性（`runLifecycleCapabilities`）。
 * @returns {string}
 */
export function buildIdeGuidance(project, options = {}) {
  const capabilities = options.capabilities ?? {};
  return renderTemplate(TEMPLATE, {
    first: options.first === true,
    projectCount: options.projectCount ?? 1,
    routeTable: options.routeTable ?? '',
    projectLabel: project.label,
    projectPath: project.path,
    rootTag: project.isRoot === true ? '(root)' : '',
    ideLabel: IDE_LABELS[project.app] ?? project.app,
    toolPrefix: project.server,
    canCreateRunConfiguration: capabilities.canCreateRunConfiguration === true,
    canListRunningConfigurations: capabilities.canListRunningConfigurations === true,
    canStopRunConfiguration: capabilities.canStopRunConfiguration === true,
    canRerunRunConfiguration: capabilities.canRerunRunConfiguration === true,
  });
}

/**
 * 把本会话接入的全部项目渲染成一份引导文本。
 *
 * @param {ReadonlyArray<{ path: string, server: string, app: string, label: string, isRoot: boolean }>} projects
 * @param {{ tools?: Record<string, unknown> }} [options] `tools` 是本次请求的工具快照
 *   （`event.tools`），用来判断每个项目的 run-lifecycle 工具在不在。
 * @returns {string}
 */
export function buildIdeGuidanceText(projects, options = {}) {
  const routeTable = routeTableFor(projects);
  return projects
    .map((project, index) =>
      buildIdeGuidance(project, {
        first: index === 0,
        projectCount: projects.length,
        routeTable,
        capabilities: runLifecycleCapabilities(options.tools, `${project.server}_`),
      }),
    )
    .join('\n\n')
    .trim();
}

export const MCP_RECOVERY_GUIDANCE = [
  '### IDE MCP failure recovery',
  'If an IDE MCP tool (the `<prefix>_*` ones) is missing, MCP is disconnected, the connection is refused, or a tool times out: stop retrying immediately; do not run extra probes or wait in tool calls. Tell the user that IDE MCP is unavailable and ask them to run /open-in-idea to reconnect.',
].join('\n');

/**
 * Recovery instruction for a marked project, where the plugin reconnects the
 * IDE MCP on its own. The model must not fall back to "ask the user" when a
 * single connection error is all it saw — the reconnect is already happening.
 */
export const MCP_RECOVERY_GUIDANCE_MARKED = [
  '### IDE MCP failure recovery',
  'This project is IDE-connected and the plugin reconnects the IDE MCP automatically. When an IDE MCP call fails with a connection error (for example `MCP server "ide" is not available`), do not run extra probes or wait in tool calls: the reconnect is already under way, so retry the operation once. Only if it still fails, tell the user that IDE MCP is unavailable and to run /open-in-idea.',
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
  'No IDE MCP tool (the `<prefix>_*` ones) is in this request: the IDE connection dropped and the plugin is reconnecting in the background. Do NOT call any of them now — it will fail with `No tool named "..." is currently available` — and do not go looking for them through Code Mode either: they are only ever listed as native tools, so a search finds nothing. Do not fall back to shell/read/write for in-project work. Continue with what you can, or tell the user the IDE is reconnecting; if the tools are still missing on a later message, ask the user to run /open-in-idea.',
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
