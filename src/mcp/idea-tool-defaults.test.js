import { describe, expect, it } from 'vitest';
import {
  BUILD_PROJECT_TOOL,
  FORCED_ARGUMENTS,
  applyIdeaToolDefaults,
  hideForcedArguments,
  removeSchemaProperty,
} from './idea-tool-defaults.js';

describe('applyIdeaToolDefaults', () => {
  it('forces rebuild when the caller passed nothing', () => {
    const input = {};
    expect(applyIdeaToolDefaults(BUILD_PROJECT_TOOL, input)).toBe(true);
    expect(input).toEqual({ rebuild: true });
  });

  it('overwrites an explicit incremental build request', () => {
    // The whole point: `rebuild: false` is the answer that can be silently
    // wrong, and the caller cannot tell that from the result.
    const input = { rebuild: false };
    expect(applyIdeaToolDefaults(BUILD_PROJECT_TOOL, input)).toBe(true);
    expect(input.rebuild).toBe(true);
  });

  it('leaves a matching request untouched and reports no change', () => {
    // Not just an optimisation: a caller logging "we forced rebuild" must be
    // able to tell the two cases apart.
    const input = { rebuild: true };
    expect(applyIdeaToolDefaults(BUILD_PROJECT_TOOL, input)).toBe(false);
    expect(input).toEqual({ rebuild: true });
  });

  it('preserves every other argument', () => {
    const input = { rebuild: false, filesToRebuild: ['src/A.java'], timeout: 120000 };
    applyIdeaToolDefaults(BUILD_PROJECT_TOOL, input);
    expect(input).toEqual({ rebuild: true, filesToRebuild: ['src/A.java'], timeout: 120000 });
  });

  it('ignores every other tool', () => {
    for (const tool of [
      'idea_lint_files',
      'idea_get_file_problems',
      'idea_read_file',
      'read',
      'shell',
      undefined,
      null,
      42,
    ]) {
      const input = {};
      expect(applyIdeaToolDefaults(tool, input)).toBe(false);
      expect(input).toEqual({});
    }
  });

  it('does not touch a name that merely looks similar', () => {
    for (const tool of ['build_project', 'idea_build_projects', 'idea_build_project_x']) {
      const input = { rebuild: false };
      expect(applyIdeaToolDefaults(tool, input)).toBe(false);
      expect(input.rebuild).toBe(false);
    }
  });

  it('is safe on a missing or malformed draft', () => {
    for (const input of [undefined, null, 'string', 7, true]) {
      expect(() => applyIdeaToolDefaults(BUILD_PROJECT_TOOL, input)).not.toThrow();
      expect(applyIdeaToolDefaults(BUILD_PROJECT_TOOL, input)).toBe(false);
    }
  });

  it('is idempotent', () => {
    const input = {};
    expect(applyIdeaToolDefaults(BUILD_PROJECT_TOOL, input)).toBe(true);
    expect(applyIdeaToolDefaults(BUILD_PROJECT_TOOL, input)).toBe(false);
    expect(input).toEqual({ rebuild: true });
  });
});

describe('removeSchemaProperty', () => {
  const schema = () => ({
    type: 'object',
    properties: {
      rebuild: { type: 'boolean' },
      filesToRebuild: { type: 'array' },
      timeout: { type: 'integer' },
    },
    required: ['rebuild', 'timeout'],
    additionalProperties: false,
  });

  it('removes the property and its required entry', () => {
    expect(removeSchemaProperty(schema(), 'rebuild')).toEqual({
      type: 'object',
      properties: {
        filesToRebuild: { type: 'array' },
        timeout: { type: 'integer' },
      },
      required: ['timeout'],
      additionalProperties: false,
    });
  });

  it('drops an emptied required array instead of leaving [] behind', () => {
    const only = { type: 'object', properties: { rebuild: {} }, required: ['rebuild'] };
    const next = removeSchemaProperty(only, 'rebuild');
    expect(next).toEqual({ type: 'object', properties: {} });
    expect('required' in next).toBe(false);
  });

  it('returns the same reference when there is nothing to remove', () => {
    // Callers skip the edit on identity, so a needless rebuild of the schema
    // must be observable.
    const input = schema();
    expect(removeSchemaProperty(input, 'absent')).toBe(input);
    expect(removeSchemaProperty(input, 'timeout')).not.toBe(input);
  });

  it('never mutates the schema it was given', () => {
    const input = schema();
    const before = JSON.stringify(input);
    removeSchemaProperty(input, 'rebuild');
    expect(JSON.stringify(input)).toBe(before);
  });

  it('is safe on a malformed schema', () => {
    for (const bad of [undefined, null, 'x', 42, {}, { properties: null }, { properties: 'x' }]) {
      expect(() => removeSchemaProperty(bad, 'rebuild')).not.toThrow();
      expect(removeSchemaProperty(bad, 'rebuild')).toBe(bad);
    }
  });
});

describe('hideForcedArguments', () => {
  /** Minimal stand-in for OpenCode's `ctx.tool.transform` editor. */
  function fakeEditor(tools) {
    return {
      tools,
      get: (id) => tools[id],
      update: (id, update) => {
        const draft = { ...tools[id] };
        update(draft);
        tools[id] = draft;
      },
    };
  }

  it('strips rebuild from idea_build_project', () => {
    const tools = {
      idea_build_project: {
        input: {
          type: 'object',
          properties: { rebuild: { type: 'boolean' }, timeout: { type: 'integer' } },
          required: ['rebuild'],
        },
      },
    };
    hideForcedArguments(fakeEditor(tools));
    expect(tools.idea_build_project.input).toEqual({
      type: 'object',
      properties: { timeout: { type: 'integer' } },
    });
  });

  it('leaves every other tool alone', () => {
    const untouched = { input: { type: 'object', properties: { rebuild: {} } } };
    const tools = { idea_lint_files: JSON.parse(JSON.stringify(untouched)) };
    hideForcedArguments(fakeEditor(tools));
    expect(tools.idea_lint_files).toEqual(untouched);
  });

  it('does nothing while the tool is absent', () => {
    // The IDE tools only appear once the MCP server is registered; OpenCode
    // replays the transform after every catalog refresh, so this must be a
    // silent no-op rather than a throw.
    const tools = {};
    expect(() => hideForcedArguments(fakeEditor(tools))).not.toThrow();
    expect(tools).toEqual({});
  });

  it('is idempotent', () => {
    const tools = {
      idea_build_project: { input: { type: 'object', properties: { rebuild: {} } } },
    };
    const editor = fakeEditor(tools);
    hideForcedArguments(editor);
    const afterFirst = JSON.stringify(tools);
    hideForcedArguments(editor);
    expect(JSON.stringify(tools)).toBe(afterFirst);
  });
});

describe('BUILD_PROJECT_TOOL', () => {
  it('names the IDE tool with the server namespace prefix', () => {
    // The IDE server is registered as `idea`, so the effective name the hooks
    // see carries that prefix; a bare `build_project` never matches.
    expect(BUILD_PROJECT_TOOL).toBe('idea_build_project');
  });

  it('is the tool the forced-argument table names', () => {
    // Two halves, one table: a rule that sets a value must hide it too.
    expect(FORCED_ARGUMENTS.map((rule) => rule.tool)).toContain(BUILD_PROJECT_TOOL);
  });

  it('forces boolean true for the one argument it owns', () => {
    expect(FORCED_ARGUMENTS).toEqual([
      { tool: 'idea_build_project', argument: 'rebuild', value: true },
    ]);
  });
});
