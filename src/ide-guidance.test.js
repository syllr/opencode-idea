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
  it('states the project path and that idea_* is scoped to it', () => {
    const text = buildIdeGuidance(PROJECT);
    expect(text).toContain(PROJECT);
    expect(text).toContain('只作用于');
  });

  it('covers every tool exposed to the model, one line each', () => {
    const text = buildIdeGuidance(PROJECT);
    for (const tool of [
      // 读写例外
      'idea_read_file',
      // 符号
      'idea_search_symbol',
      'idea_get_symbol_info',
      'idea_analyze_calls',
      // 项目与编辑器
      'idea_list_directory_tree',
      'idea_get_project_modules',
      'idea_get_project_dependencies',
      'idea_get_all_open_file_paths',
      'idea_open_file_in_editor',
      // 重构与格式化
      'idea_rename_refactoring',
      'idea_reformat_file',
      // 校验
      'idea_lint_files',
      'idea_get_file_problems',
      'idea_build_project',
      // 运行配置
      'idea_get_run_configurations',
      'idea_execute_run_configuration',
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

  it('routes only IDE-only capabilities through idea_*', () => {
    // The rule used to be "everything inside the project goes through the IDE".
    // It is now capability-based: reading, writing and searching are native, and
    // only what needs the IDE's own model/semantics goes through idea_*.
    const text = buildIdeGuidance(PROJECT);
    expect(text).toContain('只有 IDE 才有的能力才用 `idea_*`');
    expect(text).toContain('读写与搜索用原生工具');
    expect(text).toContain('不要为读一个文件、写一个文件、搜一段文本去绕 `idea_*`');
    expect(text).not.toContain('## 例外');
    expect(text).not.toContain('版本控制用原生');
    expect(text).not.toContain('idea_git_status');
  });

  it('keeps idea_read_file but scopes it to what is native is unable to do', () => {
    // It is the ONLY way to read inside a dependency jar (`<jar>!/<entry>`) or the
    // JDK image (`jrt://`). Kept for exactly that, and pointed back at `read` for
    // everything else — naming it without the restriction would undo the rule
    // right above it.
    for (const text of [
      buildIdeGuidance(PROJECT),
      buildIdeGuidance(PROJECT, { runLifecycleTools: RUN_LIFECYCLE_TOOLS }),
    ]) {
      expect(text).toContain('唯一例外:`idea_read_file`');
      expect(text).toContain('只在要读包内文件时用它');
      expect(text).toContain('<jar>!/<entry>');
      expect(text).toContain('jrt://');
      expect(text).toContain('普通文件一律用 `read`');
    }
  });

  it('says nothing about the IDE Database tools', () => {
    // Dropped on purpose: the section was a long list of tools plus a policy note,
    // and the tools carry their own descriptions. It must not creep back in.
    for (const text of [
      buildIdeGuidance(PROJECT),
      buildIdeGuidance(PROJECT, { runLifecycleTools: RUN_LIFECYCLE_TOOLS }),
    ]) {
      expect(text).not.toContain('数据库');
      expect(text).not.toContain('idea_list_database_connections');
      expect(text).not.toContain('idea_execute_sql_query');
      expect(text).not.toContain('idea_fetch_query_result');
    }
  });

  it('does not send text/file reads, writes and searches through the IDE', () => {
    // These have a perfectly good native tool, and routing them through the IDE
    // only added a hop. The guidance must not name them at all.
    for (const text of [
      buildIdeGuidance(PROJECT),
      buildIdeGuidance(PROJECT, { runLifecycleTools: RUN_LIFECYCLE_TOOLS }),
    ]) {
      for (const tool of [
        'idea_search_text',
        'idea_search_regex',
        'idea_search_file',
        'idea_apply_patch',
        'idea_create_new_file',
      ]) {
        expect(text).not.toContain(tool);
      }
      // ...and must not forbid their native counterparts either.
      for (const prohibition of [
        '不要用 `grep`',
        '不要用 `glob`',
        '不要用 `read`',
        '不要用 `edit`',
        '不要用 `write`',
      ]) {
        expect(text).not.toContain(prohibition);
      }
    }
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
    expect(codeMode).toBeLessThan(text.indexOf('只有 IDE 才有的能力才用'));
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

  it('lists the plugin tools as ordinary run-configuration tools', () => {
    // No provenance, no "only if installed", no separate heading: where a tool
    // came from is this plugin's plumbing, and a model that can call it has no
    // use for that. It either is in the list or it is not.
    const withTool = buildIdeGuidance(PROJECT, { runLifecycleTools: RUN_LIFECYCLE_TOOLS });
    const section = withTool.slice(withTool.indexOf('### 运行配置'), withTool.indexOf('### 命令执行'));

    expect(section).toContain('idea_get_run_configurations');
    for (const tool of RUN_LIFECYCLE_TOOLS) {
      expect(section).toContain(tool);
    }
    // Exactly one run-configuration heading, and nothing about an origin.
    expect(section.match(/### 运行配置/g)).toHaveLength(1);
    for (const meta of ['配套插件', 'idea-mcp-enhance', '装了才有']) {
      expect(withTool).not.toContain(meta);
    }
  });

  it('leaves no trace of the plugin tools when they are absent', () => {
    // The fallback is ours to do, silently: a stock IDE gets no heading, no
    // blank-line gap and no explanation of what is missing.
    const text = buildIdeGuidance(PROJECT);
    expect(text).not.toContain('配套插件');
    for (const tool of RUN_LIFECYCLE_TOOLS) {
      expect(text).not.toContain(tool);
    }
    expect(text).not.toContain('\n\n\n');
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
