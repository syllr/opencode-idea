// IDEA MCP routing guidance injected into the model's system prompt.
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
// The IDE MCP server is registered with `codemode: false`, so every idea_* tool is
// exposed directly on the provider tool list with its full schema; the document
// says which tool to use for which operation, plus the parameters and result
// shapes that are not obvious from the schema alone.
//
// The `{{#if can…}}` blocks gate the companion plugin's tools (`mcp/enhance.js`),
// which only exist when the user installed it. Nothing in the document says so:
// which plugin a tool came from is this plugin's plumbing, not the model's
// business — it either sees the tool or it does not.

import { readFileSync } from 'node:fs';

import {
  CREATE_SHELL_RUN_CONFIGURATION_TOOL,
  LIST_RUNNING_CONFIGURATIONS_TOOL,
  RERUN_RUN_CONFIGURATION_TOOL,
  STOP_RUN_CONFIGURATION_TOOL,
} from './mcp/enhance.js';
import { renderTemplate } from './template.js';

/** The prompt document, next to this module so it ships with it. */
const TEMPLATE_PATH = new URL('ide-guidance.template.md', import.meta.url);

/** Read once: the file is fixed for the life of the process, and this runs per request. */
const TEMPLATE = readFileSync(TEMPLATE_PATH, 'utf8');

/**
 * Build the guidance text for one project path.
 *
 * @param {string} projectPath
 * @param {{ runLifecycleTools?: readonly string[] }} [options] Which of the
 *   companion plugin's tools this request carries (`servingRunLifecycleTools`);
 *   omit for a stock IDE.
 * @returns {string}
 */
export function buildIdeGuidance(projectPath, options = {}) {
  const present = options.runLifecycleTools ?? [];
  return renderTemplate(TEMPLATE, {
    projectPath,
    canCreateRunConfiguration: present.includes(CREATE_SHELL_RUN_CONFIGURATION_TOOL),
    canListRunningConfigurations: present.includes(LIST_RUNNING_CONFIGURATIONS_TOOL),
    canStopRunConfiguration: present.includes(STOP_RUN_CONFIGURATION_TOOL),
    canRerunRunConfiguration: present.includes(RERUN_RUN_CONFIGURATION_TOOL),
  });
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
