import { describe, expect, it } from 'vitest';
import {
  FORCED_ARGUMENTS,
  applyIdeToolDefaults,
  forcedToolNames,
  hideForcedArguments,
  raiseMinimumArguments,
  removeSchemaProperty,
} from './idea-tool-defaults.js';

/** 本会话有两个项目：root（`ide_`）与一个子项目（`modelserver_`）。 */
const PREFIXES = ['ide_', 'modelserver_'];

describe('applyIdeToolDefaults', () => {
  it('forces rebuild to true, for every project prefix', () => {
    // 同一个 IDE 工具会以每个项目的前缀各出现一次；漏掉任何一个，那个项目就还在用
    // "可能出错"的增量构建回答。
    for (const tool of ['ide_build_project', 'modelserver_build_project']) {
      const empty = {};
      expect(applyIdeToolDefaults(tool, empty, PREFIXES)).toBe(true);
      expect(empty).toEqual({ rebuild: true });

      // 调用方显式要了增量构建 —— 那正是"可能悄悄错"的答案,调用方从结果里分辨不出来。
      const explicit = { rebuild: false };
      expect(applyIdeToolDefaults(tool, explicit, PREFIXES)).toBe(true);
      expect(explicit.rebuild).toBe(true);

      // 已经是对的 → 不动,而且**报告没变**:调用方要能分清这两种情况。
      const matching = { rebuild: true };
      expect(applyIdeToolDefaults(tool, matching, PREFIXES)).toBe(false);
      expect(matching).toEqual({ rebuild: true });
    }
  });

  it('preserves every other argument', () => {
    const input = { rebuild: false, filesToRebuild: ['src/A.java'], timeout: 120000 };
    applyIdeToolDefaults('ide_build_project', input, PREFIXES);
    expect(input).toEqual({ rebuild: true, filesToRebuild: ['src/A.java'], timeout: 120000 });
  });

  it('touches only the tool it owns', () => {
    for (const tool of [
      'ide_lint_files',
      'modelserver_read_file',
      'read',
      'shell',
      // 名字相近的也不能碰
      'build_project',
      'other_build_project',
      'ide_build_projects',
      'ide_build_project_x',
      undefined,
      null,
      42,
    ]) {
      const input = { rebuild: false };
      expect(applyIdeToolDefaults(tool, input, PREFIXES)).toBe(false);
      expect(input).toEqual({ rebuild: false });
    }
  });

  it('is safe on a missing or malformed draft, and on no connected project', () => {
    for (const input of [undefined, null, 'string', 7, true]) {
      expect(() => applyIdeToolDefaults('ide_build_project', input, PREFIXES)).not.toThrow();
      expect(applyIdeToolDefaults('ide_build_project', input, PREFIXES)).toBe(false);
    }
    const input = { rebuild: false };
    expect(applyIdeToolDefaults('ide_build_project', input, [])).toBe(false);
    expect(input.rebuild).toBe(false);
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

  it('removes the property and its required entry, without mutating the input', () => {
    const input = schema();
    const before = JSON.stringify(input);
    expect(removeSchemaProperty(input, 'rebuild')).toEqual({
      type: 'object',
      properties: { filesToRebuild: { type: 'array' }, timeout: { type: 'integer' } },
      required: ['timeout'],
      additionalProperties: false,
    });
    expect(JSON.stringify(input)).toBe(before);
  });

  it('drops an emptied required array instead of leaving [] behind', () => {
    const only = { type: 'object', properties: { rebuild: {} }, required: ['rebuild'] };
    const next = removeSchemaProperty(only, 'rebuild');
    expect(next).toEqual({ type: 'object', properties: {} });
    expect('required' in next).toBe(false);
  });

  it('returns the same reference when there is nothing to remove', () => {
    // 调用方靠引用相同来跳过这次编辑,所以"多余的 schema 重建"必须是看得见的。
    const input = schema();
    expect(removeSchemaProperty(input, 'absent')).toBe(input);
    expect(removeSchemaProperty(input, 'timeout')).not.toBe(input);
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

  it('is a silent no-op while the tool is absent, and is idempotent', () => {
    // IDE 工具只在 MCP server 注册之后才出现,而 OpenCode 每次刷新目录都会重放这个 transform,
    // 所以这里必须是静默的空操作,而不是抛异常。
    const empty = {};
    expect(() => hideForcedArguments(fakeEditor(empty), PREFIXES)).not.toThrow();
    expect(empty).toEqual({});

    const tools = { ide_build_project: withRebuild() };
    const editor = fakeEditor(tools);
    hideForcedArguments(editor, PREFIXES);
    const afterFirst = JSON.stringify(tools);
    hideForcedArguments(editor, PREFIXES);
    expect(JSON.stringify(tools)).toBe(afterFirst);
  });
});

describe('raiseMinimumArguments', () => {
  it('raises a missing or too-small maxDepth to the floor, for every prefix', () => {
    for (const tool of ['ide_list_directory_tree', 'modelserver_list_directory_tree']) {
      const missing = {};
      expect(raiseMinimumArguments(tool, missing, PREFIXES)).toBe(true);
      expect(missing).toEqual({ maxDepth: 50 });

      // 显式要了浅树也抬:实际渲染比 maxDepth 少一层,浅值正是这次踩坑的地方。
      const small = { maxDepth: 6 };
      expect(raiseMinimumArguments(tool, small, PREFIXES)).toBe(true);
      expect(small.maxDepth).toBe(50);

      // 字符串不是可信的深度,按"没给"处理。
      const stringy = { maxDepth: '6' };
      expect(raiseMinimumArguments(tool, stringy, PREFIXES)).toBe(true);
      expect(stringy.maxDepth).toBe(50);
    }
  });

  it('keeps a larger value and never lowers it', () => {
    const input = { maxDepth: 200 };
    expect(raiseMinimumArguments('ide_list_directory_tree', input, PREFIXES)).toBe(false);
    expect(input.maxDepth).toBe(200);
  });

  it('touches only the tool it owns, and is idempotent', () => {
    for (const tool of [
      'ide_build_project',
      'ide_read_file',
      'list_directory_tree',
      'other_list_directory_tree',
    ]) {
      const input = { maxDepth: 3 };
      expect(raiseMinimumArguments(tool, input, PREFIXES)).toBe(false);
      expect(input.maxDepth).toBe(3);
    }

    const input = {};
    expect(raiseMinimumArguments('ide_list_directory_tree', input, PREFIXES)).toBe(true);
    expect(raiseMinimumArguments('ide_list_directory_tree', input, PREFIXES)).toBe(false);
    expect(input).toEqual({ maxDepth: 50 });
  });

  it('is safe on a missing or malformed draft', () => {
    for (const input of [undefined, null, 'string', 7, true]) {
      expect(() => raiseMinimumArguments('ide_list_directory_tree', input, PREFIXES)).not.toThrow();
      expect(raiseMinimumArguments('ide_list_directory_tree', input, PREFIXES)).toBe(false);
    }
  });
});

describe('FORCED_ARGUMENTS', () => {
  it('names the tool by suffix, so it cannot be tied to one project prefix', () => {
    // 同一个 IDE 工具在每个项目下都有一份,所以表里只能按后缀写。
    expect(FORCED_ARGUMENTS).toEqual([{ suffix: 'build_project', argument: 'rebuild', value: true }]);
  });
});
