import { describe, expect, it } from 'vitest';
import {
  MCP_RECOVERY_GUIDANCE,
  MCP_RECOVERY_GUIDANCE_MARKED,
  MCP_RECOVERY_GUIDANCE_RECONNECTING,
  appendIdeGuidance,
  appendIdeRecoveryGuidance,
  buildIdeGuidanceText,
} from './ide-guidance.js';
import { HIDDEN_IDE_TOOL_SUFFIXES } from './plugin.js';
import { DEPLOYMENT_SUFFIXES, RUN_LIFECYCLE_SUFFIXES } from './mcp/enhance.js';

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
 * IDE 提供了、且插件没有藏起来的工具 —— 引导必须**逐个点名**。
 *
 * 这是引导最重要的一条结构契约:模型看得见却没人告诉它用途的工具,它不会用;
 * 引导点名了却调不到的工具,那是一次注定失败的调用。藏起来的那些反过来。
 */
const VISIBLE = [
  'analyze_calls',
  'apply_patch',
  'build_project',
  'create_run_configuration',
  'delete_run_configuration',
  'download_from_deployment',
  'execute_run_configuration',
  'get_all_open_file_paths',
  'get_deployment_task_status',
  'get_file_problems',
  'get_project_dependencies',
  'get_project_modules',
  'get_run_configurations',
  'get_symbol_info',
  'inspect_run_configuration',
  'lint_files',
  'list_deployment_servers',
  'list_directory_tree',
  'list_running_configurations',
  'open_file_in_editor',
  'read_file',
  'reformat_file',
  'rename_refactoring',
  'rerun_run_configuration',
  'search_symbol',
  'stop_run_configuration',
  'update_run_configuration',
  'upload_to_deployment',
];

/** 一次会话里 IDE 实际提供的全部工具(可见的 + 被藏起来的)。 */
const served = (suffixes) => Object.fromEntries(suffixes.map((s) => [`ide_${s}`, {}]));

/** 两个项目的会话,IDE 只提供内置工具（没装配套插件）。 */
const stock = () => buildIdeGuidanceText([ROOT, CHILD], { tools: {} });

describe('引导的生成', () => {
  it('gives every project its own tool prefix', () => {
    const text = stock();
    expect(text).toContain('`ide_search_symbol`');
    expect(text).toContain('`modelserver_search_symbol`');
  });

  it('names every tool the IDE serves and none of the hidden ones', () => {
    // 一次把"可见 = 点名"钉住:模型看得见却没人告诉它用途的工具,它不会用;
    // 点名了却调不到的工具,那是一次注定失败的调用。
    const all = [...VISIBLE, ...HIDDEN_IDE_TOOL_SUFFIXES];
    const text = buildIdeGuidanceText([ROOT], { tools: served(all) });
    for (const suffix of VISIBLE) {
      expect(text).toContain(`ide_${suffix}`);
    }
    for (const suffix of HIDDEN_IDE_TOOL_SUFFIXES) {
      expect(text).not.toContain(`ide_${suffix}`);
    }
  });

  it('adds the companion plugin sections only when the tools are in the snapshot', () => {
    const stockText = stock();
    expect(stockText).not.toContain('### 服务器文件同步');
    expect(stockText).not.toContain('ide_inspect_run_configuration');

    const full = buildIdeGuidanceText([ROOT], {
      tools: served([...RUN_LIFECYCLE_SUFFIXES, ...DEPLOYMENT_SUFFIXES]),
    });
    expect(full).toContain('### 服务器文件同步');
    expect(full).toContain('ide_inspect_run_configuration');
    expect(full).toContain('ide_upload_to_deployment');
  });
});

describe('注入与恢复提示', () => {
  it('appends the guidance once and is idempotent per request', () => {
    const system = [];
    appendIdeGuidance(system, [ROOT], { tools: {} });
    appendIdeGuidance(system, [ROOT], { tools: {} });
    expect(system).toHaveLength(1);
    expect(system[0].type).toBe('text');
    // 没有项目 / 没有 system 数组时什么都不做
    const other = [];
    appendIdeGuidance(other, [], { tools: {} });
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
