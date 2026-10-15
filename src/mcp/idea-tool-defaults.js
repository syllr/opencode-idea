// Arguments this plugin OWNS on the IDE's own MCP tools.
//
// Three files, three different subjects — kept apart on purpose:
//
//   * `idea.js`             the IDE's bundled MCP server: endpoint, transport, probe
//   * `idea-tool-defaults`  (this file) that server's TOOL CATALOG, and the
//                           arguments on it that this plugin controls
//   * `enhance.js`          a companion plugin's tools, which may not be installed
//
// ## Why an argument can be owned at all
//
// `idea_build_project` is the only way a model can learn whether the code it just
// wrote compiles, and its verdict depends on file freshness the model cannot see:
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
 * @type {ReadonlyArray<{ tool: string, argument: string, value: unknown }>}
 */
export const FORCED_ARGUMENTS = [
  {
    tool: 'idea_build_project',
    argument: 'rebuild',
    value: true,
  },
];

/** The IDE tool whose verdict must not depend on the IDE's view of file freshness. */
export const BUILD_PROJECT_TOOL = 'idea_build_project';

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
 * @returns {boolean} Whether `input` was modified.
 */
export function applyIdeaToolDefaults(tool, input) {
  if (typeof tool !== 'string') return false;
  if (input === null || typeof input !== 'object') return false;

  let changed = false;
  for (const owned of FORCED_ARGUMENTS) {
    if (owned.tool !== tool) continue;
    if (input[owned.argument] === owned.value) continue;
    input[owned.argument] = owned.value;
    changed = true;
  }
  return changed;
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
 * Safe to run when the IDE is absent: `get` returns undefined for a tool that is
 * not registered, and OpenCode replays the transform after every MCP catalog
 * refresh, so the tools are adjusted once they appear.
 *
 * @param {{
 *   get: (id: string) => { input?: unknown } | undefined,
 *   update: (id: string, update: (tool: { input?: unknown }) => void) => void,
 * }} editor
 */
export function hideForcedArguments(editor) {
  for (const owned of FORCED_ARGUMENTS) {
    const tool = editor.get(owned.tool);
    if (!tool) continue;
    const next = removeSchemaProperty(tool.input, owned.argument);
    if (next === tool.input) continue;
    // Assign the whole schema: the editor documents that schemas are replaced,
    // not mutated in place.
    editor.update(owned.tool, (draft) => {
      draft.input = next;
    });
  }
}
