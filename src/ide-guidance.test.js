import { describe, expect, it } from 'vitest';
import {
  MCP_RECOVERY_GUIDANCE,
  MCP_RECOVERY_GUIDANCE_MARKED,
  MCP_RECOVERY_GUIDANCE_RECONNECTING,
  appendIdeGuidance,
  appendIdeRecoveryGuidance,
  appendRemoteGuidance,
  buildIdeGuidanceText,
  buildRemoteGuidanceText,
} from './ide-guidance.js';
import { HIDDEN_IDE_TOOL_SUFFIXES } from './plugin.js';

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

/**
 * 引导必须**逐个点名**的工具 —— 内置 MCP Server 的 + 配套插件 `idea-mcp-enhance` 的。
 *
 * 这是引导最重要的一条结构契约:模型看得见却没人告诉它用途的工具,它不会用;
 * 引导点名了却调不到的工具,那是一次注定失败的调用。配套插件是硬前提,所以它那部分
 * 不按工具快照做条件渲染。藏起来的那些反过来。
 */
const VISIBLE = [
  'analyze_calls',
  'apply_patch',
  'build_project',
  'create_run_configuration',
  'delete_run_configuration',
  'execute_run_configuration',
  'get_all_open_file_paths',
  'get_file_problems',
  'get_project_dependencies',
  'get_project_modules',
  'get_run_configurations',
  'get_symbol_info',
  'inspect_run_configuration',
  'lint_files',
  'list_directory_tree',
  'list_running_configurations',
  'open_file_in_editor',
  'read_file',
  'reformat_file',
  'rename_refactoring',
  'rerun_run_configuration',
  'search_symbol',
  'update_run_configuration',
];

/** 两个项目的会话。 */
const guidance = () => buildIdeGuidanceText([ROOT, CHILD]);

describe('引导的生成', () => {
  it('gives every project its own tool prefix', () => {
    const text = guidance();
    expect(text).toContain('`ide_search_symbol`');
    expect(text).toContain('`modelserver_search_symbol`');
  });

  it('names every tool the IDE serves and none of the hidden ones', () => {
    // 一次把"可见 = 点名"钉住:模型看得见却没人告诉它用途的工具,它不会用;
    // 点名了却调不到的工具,那是一次注定失败的调用。
    const text = guidance();
    for (const suffix of VISIBLE) {
      expect(text).toContain(`ide_${suffix}`);
    }
    for (const suffix of HIDDEN_IDE_TOOL_SUFFIXES) {
      expect(text).not.toContain(`ide_${suffix}`);
    }
  });

  it('always describes the companion plugin tools', () => {
    // 配套插件是硬前提 —— 不检测它装没装,也不按工具快照决定写不写。
    const text = guidance();
    expect(text).toContain('ide_inspect_run_configuration');
  });
});

describe('远程指引', () => {
  it('独立于 IDE 连接渲染，点名四个 remote_* 工具', () => {
    // 远程工具是插件常驻注册的：IDE 断开时 Appendix 仍然要发，否则模型手上有工具却没有用法。
    const text = buildRemoteGuidanceText();
    for (const name of ['remote_list_servers', 'remote_exec', 'remote_upload', 'remote_download']) {
      expect(text).toContain(name);
    }
  });

  it('注入是幂等的', () => {
    const system = [];
    appendRemoteGuidance(system);
    appendRemoteGuidance(system);
    expect(system).toHaveLength(1);
  });
});

describe('注入与恢复提示', () => {
  it('appends the guidance once and is idempotent per request', () => {
    const system = [];
    appendIdeGuidance(system, [ROOT]);
    appendIdeGuidance(system, [ROOT]);
    expect(system).toHaveLength(1);
    expect(system[0].type).toBe('text');
    // 没有项目 / 没有 system 数组时什么都不做
    const other = [];
    appendIdeGuidance(other, []);
    appendIdeRecoveryGuidance(undefined, { marked: false, serving: true });
    expect(other).toHaveLength(0);
  });

  it('picks the recovery variant that matches the situation', () => {
    const system = [];
    appendIdeRecoveryGuidance(system, { marked: false, serving: true });
    expect(system[0].text).toBe(MCP_RECOVERY_GUIDANCE);

    appendIdeRecoveryGuidance(system, { marked: true, serving: true });
    expect(system[1].text).toBe(MCP_RECOVERY_GUIDANCE_MARKED);

    appendIdeRecoveryGuidance(system, { marked: true, serving: false });
    expect(system[2].text).toBe(MCP_RECOVERY_GUIDANCE_RECONNECTING);
  });
});
