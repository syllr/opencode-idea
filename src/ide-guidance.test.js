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

  it('covers every tool exposed to the model, one line each', () => {
    const text = buildIdeGuidance(PROJECT);
    for (const tool of [
      // 检索
      'idea_search_text',
      'idea_search_regex',
      'idea_search_file',
      'idea_search_symbol',
      // 阅读
      'idea_read_file',
      'idea_list_directory_tree',
      'idea_get_symbol_info',
      'idea_get_all_open_file_paths',
      'idea_open_file_in_editor',
      // 写入
      'idea_apply_patch',
      'idea_create_new_file',
      'idea_rename_refactoring',
      'idea_reformat_file',
      // 校验
      'idea_lint_files',
      'idea_get_file_problems',
      'idea_build_project',
      // 分析
      'idea_analyze_calls',
      'idea_get_project_modules',
      'idea_get_project_dependencies',
      // 运行配置
      'idea_get_run_configurations',
      'idea_execute_run_configuration',
      // 数据库
      'idea_list_database_connections',
      'idea_test_database_connection',
      'idea_list_database_schemas',
      'idea_list_schema_object_kinds',
      'idea_list_schema_objects',
      'idea_introspect_schema',
      'idea_get_database_object_description',
      'idea_execute_sql_query',
      'idea_fetch_query_result',
      'idea_preview_table_data',
      'idea_list_recent_sql_queries',
      'idea_cancel_sql_query',
    ]) {
      expect(text).toContain(tool);
    }
  });

  it('states the parameters and the positive flow for each tool', () => {
    const text = buildIdeGuidance(PROJECT);
    expect(text).toContain('`analysisKind` 取 `INCOMING_CALLS` / `OUTGOING_CALLS`');
    expect(text).toContain('`childOffset` 翻页');
    expect(text).toContain('EXECUTE_IN_TERMINAL: false');
    expect(text).toContain('supportsDynamicLaunchOverrides');
    expect(text).toContain('`databaseName` 为空、库名在 `schemaName`');
    expect(text).toContain('一次 10 行');
    expect(text).toContain('`status` 变 `CANCELLED`');
    expect(text).toContain('没返回即没问题');
  });

  it('writes no caveats or edge cases', () => {
    const text = buildIdeGuidance(PROJECT);
    for (const caveat of [
      '不要传',
      '静默',
      'timedOut',
      'No more rows',
      'Query executed successfully',
      '外部客户端的看不到',
      '一堆同名符号',
      '只能读项目',
    ]) {
      expect(text).not.toContain(caveat);
    }
  });

  it('says nothing about languages or frameworks', () => {
    const text = buildIdeGuidance(PROJECT);
    expect(text).not.toMatch(/\bJS\b/);
    expect(text).not.toMatch(/Python|Java|Kotlin|npm/);
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
    expect(text).toContain('### 数据库');
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
