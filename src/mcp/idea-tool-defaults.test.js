import { describe, expect, it } from 'vitest';
import {
  FORCED_ARGUMENTS,
  applyIdeToolDefaults,
  forcedToolNames,
  hideForcedArguments,
  removeSchemaProperty,
} from './idea-tool-defaults.js';

/** 本会话有两个项目：root（`ide_`）与一个子项目（`modelserver_`）。 */
const PREFIXES = ['ide_', 'modelserver_'];

describe('applyIdeToolDefaults', () => {
  it('forces rebuild when the caller passed nothing', () => {
    const input = {};
    expect(applyIdeToolDefaults('ide_build_project', input, PREFIXES)).toBe(true);
    expect(input).toEqual({ rebuild: true });
  });

  it('applies to every project prefix, not just the root one', () => {
    // 同一个 IDE 工具会以每个项目的前缀各出现一次；漏掉任何一个，那个项目就还在
    // 用"可能出错"的增量构建回答。
    const input = {};
    expect(applyIdeToolDefaults('modelserver_build_project', input, PREFIXES)).toBe(true);
    expect(input).toEqual({ rebuild: true });
  });

  it('overwrites an explicit incremental build request', () => {
    // The whole point: `rebuild: false` is the answer that can be silently
    // wrong, and the caller cannot tell that from the result.
    const input = { rebuild: false };
    expect(applyIdeToolDefaults('ide_build_project', input, PREFIXES)).toBe(true);
    expect(input.rebuild).toBe(true);
  });

  it('leaves a matching request untouched and reports no change', () => {
    // Not just an optimisation: a caller logging "we forced rebuild" must be
    // able to tell the two cases apart.
    const input = { rebuild: true };
    expect(applyIdeToolDefaults('ide_build_project', input, PREFIXES)).toBe(false);
    expect(input).toEqual({ rebuild: true });
  });

  it('preserves every other argument', () => {
    const input = { rebuild: false, filesToRebuild: ['src/A.java'], timeout: 120000 };
    applyIdeToolDefaults('ide_build_project', input, PREFIXES);
    expect(input).toEqual({ rebuild: true, filesToRebuild: ['src/A.java'], timeout: 120000 });
  });

  it('ignores every other tool', () => {
    for (const tool of [
      'ide_lint_files',
      'modelserver_read_file',
      'read',
      'shell',
      undefined,
      null,
      42,
    ]) {
      const input = {};
      expect(applyIdeToolDefaults(tool, input, PREFIXES)).toBe(false);
      expect(input).toEqual({});
    }
  });

  it('does not touch a name that merely looks similar', () => {
    for (const tool of [
      'build_project',
      'other_build_project',
      'ide_build_projects',
      'ide_build_project_x',
    ]) {
      const input = { rebuild: false };
      expect(applyIdeToolDefaults(tool, input, PREFIXES)).toBe(false);
      expect(input.rebuild).toBe(false);
    }
  });

  it('does nothing when no project is connected', () => {
    const input = { rebuild: false };
    expect(applyIdeToolDefaults('ide_build_project', input, [])).toBe(false);
    expect(input.rebuild).toBe(false);
  });

  it('is safe on a missing or malformed draft', () => {
    for (const input of [undefined, null, 'string', 7, true]) {
      expect(() => applyIdeToolDefaults('ide_build_project', input, PREFIXES)).not.toThrow();
      expect(applyIdeToolDefaults('ide_build_project', input, PREFIXES)).toBe(false);
    }
  });

  it('is idempotent', () => {
    const input = {};
    expect(applyIdeToolDefaults('ide_build_project', input, PREFIXES)).toBe(true);
    expect(applyIdeToolDefaults('ide_build_project', input, PREFIXES)).toBe(false);
    expect(input).toEqual({ rebuild: true });
  });
});

describe('forcedToolNames', () => {
  it('composes one real tool name per prefix', () => {
    expect(forcedToolNames(PREFIXES)).toEqual(['ide_build_project', 'modelserver_build_project']);
  });

  it('is empty when no project is connected', () => {
    expect(forcedToolNames([])).toEqual([]);
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

  const withRebuild = () => ({
    input: {
      type: 'object',
      properties: { rebuild: { type: 'boolean' }, timeout: { type: 'integer' } },
      required: ['rebuild'],
    },
  });
  const expected = {
    input: {
      type: 'object',
      properties: { timeout: { type: 'integer' } },
    },
  };

  it('strips rebuild from every prefix the IDE tool is registered under', () => {
    const tools = {
      ide_build_project: withRebuild(),
      modelserver_build_project: withRebuild(),
    };
    hideForcedArguments(fakeEditor(tools), PREFIXES);
    expect(tools.ide_build_project).toEqual(expected);
    expect(tools.modelserver_build_project).toEqual(expected);
  });

  it('leaves every other tool alone', () => {
    const untouched = { input: { type: 'object', properties: { rebuild: {} } } };
    const tools = { ide_lint_files: JSON.parse(JSON.stringify(untouched)) };
    hideForcedArguments(fakeEditor(tools), PREFIXES);
    expect(tools.ide_lint_files).toEqual(untouched);
  });

  it('does nothing while the tool is absent', () => {
    // The IDE tools only appear once the MCP servers are registered; OpenCode
    // replays the transform after every catalog refresh, so this must be a
    // silent no-op rather than a throw.
    const tools = {};
    expect(() => hideForcedArguments(fakeEditor(tools), PREFIXES)).not.toThrow();
    expect(tools).toEqual({});
  });

  it('is idempotent', () => {
    const tools = { ide_build_project: withRebuild() };
    const editor = fakeEditor(tools);
    hideForcedArguments(editor, PREFIXES);
    const afterFirst = JSON.stringify(tools);
    hideForcedArguments(editor, PREFIXES);
    expect(JSON.stringify(tools)).toBe(afterFirst);
  });
});

describe('FORCED_ARGUMENTS', () => {
  it('names the tool by suffix, so it cannot be tied to one project prefix', () => {
    expect(FORCED_ARGUMENTS.map((rule) => rule.suffix)).toEqual(['build_project']);
  });

  it('forces boolean true for the one argument it owns', () => {
    expect(FORCED_ARGUMENTS).toEqual([{ suffix: 'build_project', argument: 'rebuild', value: true }]);
  });
});
