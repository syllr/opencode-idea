import { describe, expect, it } from 'vitest';
import {
  MCP_RECOVERY_GUIDANCE,
  MCP_RECOVERY_GUIDANCE_MARKED,
  MCP_RECOVERY_GUIDANCE_RECONNECTING,
  appendIdeGuidance,
  appendIdeRecoveryGuidance,
  buildIdeGuidance,
} from './ide-guidance.js';
import {
  LIST_RUNNING_CONFIGURATIONS_TOOL,
  RUN_LIFECYCLE_TOOLS,
} from './mcp/enhance.js';

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

  it('keeps the owned build argument out of the guidance too', () => {
    // `rebuild` is removed from the tool's published schema and set by the
    // plugin (src/mcp/idea-tool-defaults.js). Naming it in the guidance would
    // put back exactly the knob the schema no longer offers.
    const text = buildIdeGuidance(PROJECT);
    expect(text).not.toContain('rebuild');
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

  it('routes environment-dependent commands through a run configuration', () => {
    const text = buildIdeGuidance(PROJECT);
    expect(text).toContain('### 命令执行');
    expect(text).toContain('`idea_execute_run_configuration`');
    expect(text).toContain('需要项目环境的命令');
    expect(text).toContain('不需要项目环境的命令:用原生 `shell`');
  });

  it('never names the IDE terminal tool', () => {
    // `idea_execute_terminal_command` does not inherit the project's environment,
    // so it is hidden (`HIDDEN_IDEA_TOOLS`) and no longer routed to. Guidance
    // must not send the model at a tool that is not in its tool list.
    for (const text of [
      buildIdeGuidance(PROJECT),
      buildIdeGuidance(PROJECT, { runLifecycleTools: RUN_LIFECYCLE_TOOLS }),
    ]) {
      expect(text).not.toContain('idea_execute_terminal_command');
      expect(text).not.toContain('executeInShell');
      expect(text).not.toContain('reuseExistingTerminalWindow');
      expect(text).not.toContain('白名单');
    }
  });

  it('scopes the in-project rule to code and file operations', () => {
    const text = buildIdeGuidance(PROJECT);
    expect(text).toContain('代码与文件操作');
    expect(text).not.toContain('## 例外');
    expect(text).not.toContain('版本控制用原生');
    expect(text).not.toContain('idea_git_status');
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

  it('states the general rule: a listed native tool needs no search', () => {
    // The rule is deliberately not phrased as an idea_* special case. The
    // failure it prevents — going into Code Mode to hunt for a tool that is
    // already sitting in the tool list — is a reading of Code Mode's own
    // "use search to find a tool", so the correction has to be a general one.
    const text = buildIdeGuidance(PROJECT);
    expect(text).toContain('原生工具');
    expect(text).toContain('不需要、也不应该用 Code Mode 的 `search` 去找');
  });

  it('applies that rule to the idea_* tools explicitly', () => {
    const text = buildIdeGuidance(PROJECT);
    expect(text).toContain('`idea_*` 就是原生工具');
    expect(text).toContain('不在 Code Mode 的工具目录里');
    expect(text).not.toContain('模板字符串');
  });

  it('states the Code Mode rule before the routing rules', () => {
    // It is a precondition for every line below it: if the model cannot get at
    // the tools, nothing else in this text matters.
    const text = buildIdeGuidance(PROJECT);
    const codeMode = text.indexOf('Code Mode');
    expect(codeMode).toBeGreaterThan(-1);
    expect(codeMode).toBeLessThan(text.indexOf('内的代码与文件操作'));
  });

  it('requires direct tool calls instead of execute wrapping', () => {
    const text = buildIdeGuidance(PROJECT);
    expect(text).toContain('不要包进 `execute`');
  });

  it('says nothing about run-lifecycle tools for a stock IDE', () => {
    // Those tools come from the companion IDEA plugin `idea-mcp-enhance`, not
    // from the IDE's bundled MCP server. Naming them unconditionally would make
    // the model call tools that do not exist.
    const text = buildIdeGuidance(PROJECT);
    for (const tool of RUN_LIFECYCLE_TOOLS) {
      expect(text).not.toContain(tool);
    }
    expect(text).not.toContain('pkill');
  });

  it('names only the run-lifecycle tools this request actually carries', () => {
    const all = buildIdeGuidance(PROJECT, { runLifecycleTools: RUN_LIFECYCLE_TOOLS });
    for (const tool of RUN_LIFECYCLE_TOOLS) {
      expect(all).toContain(tool);
    }
    expect(all).toContain('不要用 `pkill`');

    // An older release of the enhance plugin ships fewer of them: guidance must
    // name the present ones and stay silent about the rest.
    const partial = buildIdeGuidance(PROJECT, {
      runLifecycleTools: [LIST_RUNNING_CONFIGURATIONS_TOOL],
    });
    expect(partial).toContain(LIST_RUNNING_CONFIGURATIONS_TOOL);
    expect(partial).not.toContain('idea_stop_run_configuration');
    expect(partial).not.toContain('idea_rerun_run_configuration');
    expect(partial).not.toContain('pkill');
  });

  it('names the create tool only when the request carries it', () => {
    const text = buildIdeGuidance(PROJECT, { runLifecycleTools: RUN_LIFECYCLE_TOOLS });
    expect(text).toContain('`idea_create_shell_run_configuration`');
    expect(text).toContain('三选一');
    expect(text).toContain('只支持 Shell 类型');

    const without = buildIdeGuidance(PROJECT, {
      runLifecycleTools: RUN_LIFECYCLE_TOOLS.filter(
        (tool) => tool !== 'idea_create_shell_run_configuration',
      ),
    });
    expect(without).not.toContain('idea_create_shell_run_configuration');
  });

  it('points the create-a-configuration hint at whichever route exists', () => {
    // With the enhance plugin there is a tool for it; without one, hand-authored
    // XML via the skill is the only route. Naming a tool that is not in the
    // request would send the model at something it cannot call.
    const withTool = buildIdeGuidance(PROJECT, { runLifecycleTools: RUN_LIFECYCLE_TOOLS });
    expect(withTool).toContain('新建方式:用 `idea_create_shell_run_configuration`(只支持 Shell 类型)');

    const withoutTool = buildIdeGuidance(PROJECT);
    expect(withoutTool).toContain('新建方式:请用户自己在 IDEA 里建');
    expect(withoutTool).not.toContain('idea-run-config');
    expect(withoutTool).not.toContain('idea_create_shell_run_configuration');
  });

  it('frames creating a run configuration as heavy and consent-gated', () => {
    // Measured misframing: "no configuration? create one" reads like a routine
    // step, but a run configuration is a committed artefact a project has only a
    // handful of. Both the command-execution section and the per-tool line must
    // say so, and the consent requirement must not be dropped from either.
    for (const text of [
      buildIdeGuidance(PROJECT),
      buildIdeGuidance(PROJECT, { runLifecycleTools: RUN_LIFECYCLE_TOOLS }),
    ]) {
      expect(text).toContain('重资产');
      expect(text).toContain('不是随手一条命令就建一个');
      expect(text).toContain('取得同意再动手');
    }

    const withTool = buildIdeGuidance(PROJECT, { runLifecycleTools: RUN_LIFECYCLE_TOOLS });
    expect(withTool).toContain('**且建之前必须先取得用户同意**');
    // The old framing must not creep back.
    expect(withTool).not.toContain('没有就');
  });

  it('keeps the run-lifecycle tools inside the run configuration section', () => {
    const text = buildIdeGuidance(PROJECT, { runLifecycleTools: RUN_LIFECYCLE_TOOLS });
    const section = text.slice(text.indexOf('### 运行配置'), text.indexOf('### 命令执行'));
    for (const tool of RUN_LIFECYCLE_TOOLS) {
      expect(section).toContain(tool);
    }
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

  it('selects the variant matching the run-lifecycle tools present', () => {
    const system = [];
    appendIdeGuidance(system, PROJECT, { runLifecycleTools: RUN_LIFECYCLE_TOOLS });
    appendIdeGuidance(system, PROJECT, { runLifecycleTools: RUN_LIFECYCLE_TOOLS });
    expect(system).toHaveLength(1);
    expect(system[0].text).toBe(
      buildIdeGuidance(PROJECT, { runLifecycleTools: RUN_LIFECYCLE_TOOLS }),
    );
    expect(system[0].text).toContain('idea_rerun_run_configuration');
  });
});

describe('appendIdeRecoveryGuidance', () => {
  it('adds the fast-fail recovery instruction once', () => {
    const system = [];
    appendIdeRecoveryGuidance(system);
    appendIdeRecoveryGuidance(system);
    expect(system).toEqual([{ type: 'text', text: MCP_RECOVERY_GUIDANCE }]);
  });

  it('uses the auto-reconnect variant for a marked project', () => {
    const system = [];
    appendIdeRecoveryGuidance(system, { marked: true });
    appendIdeRecoveryGuidance(system, { marked: true });
    expect(system).toEqual([{ type: 'text', text: MCP_RECOVERY_GUIDANCE_MARKED }]);
    expect(MCP_RECOVERY_GUIDANCE_MARKED).toContain('reconnects the IDE MCP automatically');
    expect(MCP_RECOVERY_GUIDANCE_MARKED).toContain('retry the operation once');
  });

  it('forbids idea_* calls when the tools are absent from the request', () => {
    const system = [];
    appendIdeRecoveryGuidance(system, { marked: true, serving: false });
    appendIdeRecoveryGuidance(system, { marked: true, serving: false });
    expect(system).toEqual([{ type: 'text', text: MCP_RECOVERY_GUIDANCE_RECONNECTING }]);
    expect(MCP_RECOVERY_GUIDANCE_RECONNECTING).toContain('Do NOT call any idea_* tool');
  });
});
