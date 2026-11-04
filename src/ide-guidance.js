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
// ## 一个会话,一个项目,一套前缀
//
// 一个 OpenCode 会话只对应一个 JetBrains 项目（workspace root），MCP server 固定叫
// `ide`。模板是静态 Markdown，工具名直接写 `ide_xxx`。
//
// 两个文件，各自就是一段完整的提示词：
//   * `tool-guidance.template.md` —— 原生工具与远端工具，**始终注入**；
//   * `ide-guidance.template.md`  —— IDE 工具，**只在本次请求真的带着 IDE 工具时**注入。
//
// 拆成两个文件而不是在一个文件里用标记切段：模板渲染出来就等于模型收到的内容，
// 不必再解释一套只有渲染器认识的标记语法。

import { readFileSync } from 'node:fs';

/** 两份文档都在本模块旁边，跟着它一起发布。 */
const TOOL_TEMPLATE = readFileSync(new URL('tool-guidance.template.md', import.meta.url), 'utf8');
const IDE_TEMPLATE = readFileSync(new URL('ide-guidance.template.md', import.meta.url), 'utf8');

/**
 * 渲染引导。
 *
 * IDE 连上时是「通用段 + IDE 段」；没连上就只有通用段 —— 不推荐此刻调不到的
 * `ide_*` 工具。
 *
 * @param {boolean} ideConnected
 * @returns {string}
 */
export function buildGuidanceText(ideConnected) {
  const text = ideConnected ? `${TOOL_TEMPLATE.trimEnd()}\n\n${IDE_TEMPLATE.trimStart()}` : TOOL_TEMPLATE;
  return text.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/**
 * 把引导推进本次请求的 `system`。幂等。
 *
 * @param {unknown} system
 * @param {boolean} ideConnected
 */
export function appendGuidance(system, ideConnected) {
  if (!Array.isArray(system)) return;
  const text = buildGuidanceText(ideConnected);
  if (system.some((part) => part?.text === text)) return;
  system.push({ type: 'text', text });
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
