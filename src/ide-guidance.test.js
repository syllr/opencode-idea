import { describe, expect, it } from 'vitest';
import {
  MCP_RECOVERY_GUIDANCE,
  appendIdeGuidance,
  appendIdeRecoveryGuidance,
  buildIdeGuidance,
} from './ide-guidance.js';

const PROJECT = '/Users/me/project';

describe('buildIdeGuidance', () => {
  it('states the project path and the in-project requirement', () => {
    const text = buildIdeGuidance(PROJECT);
    expect(text).toContain(PROJECT);
    expect(text).toContain('必须使用');
  });

  it('names the idea tool for each common operation', () => {
    const text = buildIdeGuidance(PROJECT);
    for (const tool of [
      'idea_search_text',
      'idea_search_regex',
      'idea_search_file',
      'idea_read_file',
      'idea_list_directory_tree',
      'idea_apply_patch',
      'idea_create_new_file',
      'idea_lint_files',
    ]) {
      expect(text).toContain(tool);
    }
  });

  it('scopes the in-project rule to code and file operations', () => {
    const text = buildIdeGuidance(PROJECT);
    expect(text).toContain('代码与文件操作');
    expect(text).not.toContain('## 例外');
    expect(text).not.toContain('版本控制用原生');
    expect(text).not.toContain('idea_git_status');
    expect(text).not.toContain('idea_execute_terminal_command');
  });

  it('routes database work through the IDE Database tools', () => {
    const text = buildIdeGuidance(PROJECT);
    expect(text).toContain('## 数据库');
    expect(text).toContain('idea_list_database_connections');
    expect(text).toContain('先建议用户在 IDEA 里配好数据源');
    expect(text).toContain('不要向用户索取数据库凭据');
  });

  it('forbids the native counterpart of each operation', () => {
    const text = buildIdeGuidance(PROJECT);
    expect(text).toContain('不要用 `grep`');
    expect(text).toContain('不要用 `glob`');
    expect(text).toContain('不要用 `read`');
    expect(text).toContain('不要用 `edit`');
    expect(text).toContain('不要用 `write`');
  });

  it('keeps the boundary at the project path', () => {
    const text = buildIdeGuidance(PROJECT);
    expect(text).toContain('路径在');
    expect(text).toContain('外:用其他可用工具');
  });

  it('does not explain or mention Code Mode', () => {
    const text = buildIdeGuidance(PROJECT);
    expect(text).not.toContain('Code Mode');
    expect(text).not.toContain('模板字符串');
  });

  it('requires direct tool calls instead of execute wrapping', () => {
    const text = buildIdeGuidance(PROJECT);
    expect(text).toContain('不要用 `execute` 包裹');
  });
});

describe('appendIdeGuidance', () => {
  it('pushes one text part for the project', () => {
    const system = [];
    appendIdeGuidance(system, PROJECT);
    expect(system).toEqual([{ type: 'text', text: buildIdeGuidance(PROJECT) }]);
  });

  it('is idempotent and safe on bad input', () => {
    const system = [];
    appendIdeGuidance(system, PROJECT);
    appendIdeGuidance(system, PROJECT);
    expect(system).toHaveLength(1);
    expect(() => appendIdeGuidance(undefined, PROJECT)).not.toThrow();
    expect(() => appendIdeGuidance([], undefined)).not.toThrow();
  });
});

describe('appendIdeRecoveryGuidance', () => {
  it('adds the fast-fail recovery instruction once', () => {
    const system = [];
    appendIdeRecoveryGuidance(system);
    appendIdeRecoveryGuidance(system);
    expect(system).toEqual([{ type: 'text', text: MCP_RECOVERY_GUIDANCE }]);
  });
});
