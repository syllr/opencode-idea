import { describe, expect, it } from 'vitest';
import {
  MCP_RECOVERY_GUIDANCE,
  MCP_RECOVERY_GUIDANCE_MARKED,
  MCP_RECOVERY_GUIDANCE_RECONNECTING,
  appendIdeGuidance,
  appendIdeRecoveryGuidance,
  buildIdeGuidance,
  buildIdeGuidanceText,
} from './ide-guidance.js';

const ROOT = {
  path: '/Users/me/project',
  server: 'ide',
  app: 'idea',
  label: '.',
  isRoot: true,
};
const CHILD = {
  path: '/Users/me/project/modelserver',
  server: 'modelserver',
  app: 'pycharm',
  label: 'modelserver',
  isRoot: false,
};

/** 与 guidance 对应的工具后缀清单（不含前缀）。 */
const TOOL_SUFFIXES = [
  // 包内文件
  'read_file',
  // 符号
  'search_symbol',
  'get_symbol_info',
  'analyze_calls',
  // 项目与编辑器
  'list_directory_tree',
  'get_project_modules',
  'get_project_dependencies',
  'get_all_open_file_paths',
  'open_file_in_editor',
  // 重构与格式化
  'rename_refactoring',
  'reformat_file',
  // 校验
  'lint_files',
  'get_file_problems',
  'build_project',
  // 运行配置
  'get_run_configurations',
  'execute_run_configuration',
];

describe('buildIdeGuidance（单个项目）', () => {
  it('names the project, its IDE, and its tool prefix', () => {
    const text = buildIdeGuidance(ROOT, { first: true, projectCount: 1 });
    expect(text).toContain(ROOT.path);
    expect(text).toContain('IntelliJ IDEA');
    expect(text).toContain('`ide_`');
    expect(text).toContain('只作用于');
  });

  it('covers every routed tool, spelled with THIS project prefix', () => {
    const text = buildIdeGuidance(CHILD, { first: true, projectCount: 1 });
    for (const suffix of TOOL_SUFFIXES) {
      expect(text).toContain(`modelserver_${suffix}`);
    }
    // 而且绝不出现别的前缀 —— 否则模型会拿 root 的工具去操作子项目。
    expect(text).not.toContain('`ide_search_symbol`');
  });

  it('states the parameters and the positive flow for each tool', () => {
    const text = buildIdeGuidance(ROOT, { first: true, projectCount: 1 });
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
    const text = buildIdeGuidance(ROOT, { first: true, projectCount: 1 });
    expect(text).not.toContain('rebuild');
  });

  it('writes no caveats or edge cases', () => {
    const text = buildIdeGuidance(ROOT, { first: true, projectCount: 1 });
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
    const text = buildIdeGuidance(ROOT, { first: true, projectCount: 1 });
    expect(text).toContain('需要项目环境的命令');
    expect(text).toContain('`ide_execute_run_configuration`');
    expect(text).toContain('不需要项目环境的命令:用原生 `shell`');
  });

  it('never names the hidden IDE terminal tool', () => {
    // `execute_terminal_command` does not inherit the project's environment, so it
    // is hidden (`HIDDEN_IDE_TOOL_SUFFIXES`) and no longer routed to. Guidance
    // must not send the model at a tool that is not in its tool list.
    for (const text of [
      buildIdeGuidance(ROOT, { first: true, projectCount: 1 }),
      buildIdeGuidance(ROOT, {
        first: true,
        projectCount: 1,
        capabilities: { canRerunRunConfiguration: true },
      }),
    ]) {
      expect(text).not.toContain('execute_terminal_command');
      expect(text).not.toContain('executeInShell');
      expect(text).not.toContain('reuseExistingTerminalWindow');
      expect(text).not.toContain('白名单');
    }
  });

  it('routes only IDE-only capabilities through the prefixed tools', () => {
    // The rule used to be "everything inside the project goes through the IDE".
    // It is now capability-based: reading, writing and searching are native, and
    // only what needs the IDE's own model/semantics goes through them.
    const text = buildIdeGuidance(ROOT, { first: true, projectCount: 1 });
    expect(text).toContain('只有 IDE 才有的能力才用它们');
    expect(text).toContain('读写与搜索用原生工具');
    expect(text).toContain('不要为读一个文件、写一个文件、搜一段文本去绕 IDE 工具');
    expect(text).not.toContain('## 例外');
    expect(text).not.toContain('版本控制用原生');
  });

  it('keeps the read_file tool but scopes it to what native cannot do', () => {
    // It is the ONLY way to read inside a dependency jar (`<jar>!/<entry>`) or the
    // JDK image (`jrt://`). Kept for exactly that, and pointed back at `read` for
    // everything else.
    const text = buildIdeGuidance(ROOT, { first: true, projectCount: 1 });
    expect(text).toContain('`ide_read_file`');
    expect(text).toContain('只在要读包内文件时用它');
    expect(text).toContain('jrt://');
    expect(text).toContain('普通文件一律用 `read`');
  });

  it('says nothing about run-lifecycle tools for a stock IDE', () => {
    const text = buildIdeGuidance(ROOT, { first: true, projectCount: 1, capabilities: {} });
    for (const suffix of [
      'create_shell_run_configuration',
      'list_running_configurations',
      'stop_run_configuration',
      'rerun_run_configuration',
    ]) {
      expect(text).not.toContain(suffix);
    }
  });

  it('names only the run-lifecycle capabilities it is given', () => {
    const text = buildIdeGuidance(ROOT, {
      first: true,
      projectCount: 1,
      capabilities: { canRerunRunConfiguration: true, canListRunningConfigurations: true },
    });
    expect(text).toContain('`ide_rerun_run_configuration`');
    expect(text).toContain('`ide_list_running_configurations`');
    expect(text).not.toContain('create_shell_run_configuration');
    expect(text).not.toContain('stop_run_configuration');
  });

  it('states the Code Mode rule before the routing rules', () => {
    const text = buildIdeGuidance(ROOT, { first: true, projectCount: 1 });
    const native = text.indexOf('原生工具(当前工具列表里直接列出的那些)');
    const routing = text.indexOf('只有 IDE 才有的能力才用它们');
    expect(native).toBeGreaterThanOrEqual(0);
    expect(routing).toBeGreaterThan(native);
  });
});

describe('buildIdeGuidanceText（整个会话）', () => {
  it('renders one section per project, each with its own prefix', () => {
    const text = buildIdeGuidanceText([ROOT, CHILD], { tools: {} });
    expect(text.match(/^## 项目 /gm)).toHaveLength(2);
    expect(text).toContain('`ide_search_symbol`');
    expect(text).toContain('`modelserver_search_symbol`');
    expect(text).toContain('IntelliJ IDEA');
    expect(text).toContain('PyCharm');
  });

  it('renders the shared sections exactly once', () => {
    const text = buildIdeGuidanceText([ROOT, CHILD], { tools: {} });
    expect(text.match(/# IDE MCP:只有非 IDE 不可的能力才走 IDE/g)).toHaveLength(1);
    expect(text.match(/## 总则/g)).toHaveLength(1);
    expect(text.match(/## 命令执行/g)).toHaveLength(1);
  });

  it('puts a directory → prefix table in the shared section', () => {
    // 模型要先知道"该用哪个前缀"再挑工具;没有这张表它得从各节标题里自己重建映射,
    // 而推错的代价正是"拿 root 的工具去操作子项目"。
    const text = buildIdeGuidanceText([ROOT, CHILD], { tools: {} });
    expect(text).toContain('## 目录 → 工具前缀(先看这张表)');
    expect(text).toContain('- `.`（IntelliJ IDEA）→ `ide_*`');
    expect(text).toContain('- `modelserver`（PyCharm）→ `modelserver_*`');
    // 只在公共段出现一次。
    expect(text.match(/→ `modelserver_\*`/g)).toHaveLength(1);
  });

  it('tells the model to read a subproject AGENTS.md on demand', () => {
    // 子项目的 AGENTS.md 不会自动进上下文(OpenCode 只按 cwd 向上收集,而 cwd 是 root),
    // 所以要明确让模型按需读。
    const text = buildIdeGuidanceText([ROOT, CHILD], { tools: {} });
    expect(text).toContain('AGENTS.md');
    expect(text).toContain('按需读文件');
  });

  it('judges run-lifecycle tools per project prefix', () => {
    const text = buildIdeGuidanceText([ROOT, CHILD], {
      tools: { 'modelserver_rerun_run_configuration': {} },
    });
    // 子项目那一节有 rerun,root 那一节没有。
    const [rootSection, childSection] = text.split(/^## 项目 /m).slice(1);
    expect(rootSection).not.toContain('rerun_run_configuration');
    expect(childSection).toContain('`modelserver_rerun_run_configuration`');
  });
});

describe('appendIdeGuidance', () => {
  it('appends once and is idempotent per request', () => {
    const system = [];
    appendIdeGuidance(system, [ROOT], { tools: {} });
    expect(system).toHaveLength(1);
    appendIdeGuidance(system, [ROOT], { tools: {} });
    expect(system).toHaveLength(1);
    expect(system[0].text).toContain('`ide_search_symbol`');
  });

  it('does nothing without projects or a system array', () => {
    const system = [];
    appendIdeGuidance(system, [], { tools: {} });
    expect(system).toHaveLength(0);
    expect(() => appendIdeGuidance(undefined, [ROOT], { tools: {} })).not.toThrow();
  });
});

describe('appendIdeRecoveryGuidance', () => {
  it('picks the auto-reconnect variant for a configured project', () => {
    const system = [];
    appendIdeRecoveryGuidance(system, { marked: true, serving: true });
    expect(system).toEqual([{ type: 'text', text: MCP_RECOVERY_GUIDANCE_MARKED }]);
    expect(MCP_RECOVERY_GUIDANCE_MARKED).toContain('reconnects the IDE MCP automatically');
    expect(MCP_RECOVERY_GUIDANCE_MARKED).toContain('retry the operation once');
  });

  it('picks the reconnecting variant when the tools are not in this request', () => {
    const system = [];
    appendIdeRecoveryGuidance(system, { marked: true, serving: false });
    expect(system).toEqual([{ type: 'text', text: MCP_RECOVERY_GUIDANCE_RECONNECTING }]);
    expect(MCP_RECOVERY_GUIDANCE_RECONNECTING).toContain('Do NOT call any of them now');
  });

  it('picks the plain variant for an unconfigured project', () => {
    const system = [];
    appendIdeRecoveryGuidance(system, { marked: false, serving: false });
    expect(system).toEqual([{ type: 'text', text: MCP_RECOVERY_GUIDANCE }]);
    expect(MCP_RECOVERY_GUIDANCE).toContain('/open-in-idea');
  });

  it('never names a bare `idea_` prefix', () => {
    for (const text of [
      MCP_RECOVERY_GUIDANCE,
      MCP_RECOVERY_GUIDANCE_MARKED,
      MCP_RECOVERY_GUIDANCE_RECONNECTING,
    ]) {
      expect(text).not.toContain('idea_');
    }
  });
});
