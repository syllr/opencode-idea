import { describe, expect, it } from 'vitest';
import {
  CREATE_SHELL_RUN_CONFIGURATION_SUFFIX,
  LIST_RUNNING_CONFIGURATIONS_SUFFIX,
  RERUN_RUN_CONFIGURATION_SUFFIX,
  RUN_LIFECYCLE_SUFFIXES,
  STOP_RUN_CONFIGURATION_SUFFIX,
  runLifecycleCapabilities,
} from './enhance.js';

const NONE = {
  canCreateRunConfiguration: false,
  canListRunningConfigurations: false,
  canStopRunConfiguration: false,
  canRerunRunConfiguration: false,
};

describe('RUN_LIFECYCLE_SUFFIXES', () => {
  it('lists the suffixes the enhance plugin contributes', () => {
    expect(RUN_LIFECYCLE_SUFFIXES).toEqual([
      'create_shell_run_configuration',
      'list_running_configurations',
      'stop_run_configuration',
      'rerun_run_configuration',
    ]);
  });

  it('carries no prefix: the per-project prefix is composed at use time', () => {
    // 工具名是 `<项目前缀><后缀>`（root 是 `ide_`，子项目是目录名），所以这张表里
    // 存的是后缀。存完整名字就只能匹配一个项目。
    for (const suffix of RUN_LIFECYCLE_SUFFIXES) {
      expect(suffix.startsWith('idea_')).toBe(false);
      expect(suffix.startsWith('ide_')).toBe(false);
    }
  });

  it('composes the array from the named constants, not by hand', () => {
    expect(RUN_LIFECYCLE_SUFFIXES).toEqual([
      CREATE_SHELL_RUN_CONFIGURATION_SUFFIX,
      LIST_RUNNING_CONFIGURATIONS_SUFFIX,
      STOP_RUN_CONFIGURATION_SUFFIX,
      RERUN_RUN_CONFIGURATION_SUFFIX,
    ]);
  });

  it('keeps the enhance tools out of the native tool surface', () => {
    // `idea.js` describes the MCP server the IDE bundles, which knows nothing
    // about these tools. Asserting the split keeps a future edit from leaking
    // the plugin's names back into the native module.
    expect(RUN_LIFECYCLE_SUFFIXES).not.toContain('get_run_configurations');
    expect(RUN_LIFECYCLE_SUFFIXES).not.toContain('execute_run_configuration');
  });
});

describe('runLifecycleCapabilities', () => {
  it('reports nothing for a stock IDE', () => {
    // The IDE's bundled MCP server does not ship these; only the companion
    // plugin does. All-false is what keeps the guidance from naming them.
    expect(runLifecycleCapabilities({ ide_read_file: {}, ide_build_project: {} }, 'ide_')).toEqual(NONE);
  });

  it('reports only the tools actually present, and does so per project prefix', () => {
    const tools = {
      ide_read_file: {},
      ide_stop_run_configuration: {},
      ide_rerun_run_configuration: {},
      modelserver_create_shell_run_configuration: {},
    };
    expect(runLifecycleCapabilities(tools, 'ide_')).toEqual({
      ...NONE,
      canStopRunConfiguration: true,
      canRerunRunConfiguration: true,
    });
    expect(runLifecycleCapabilities(tools, 'modelserver_')).toEqual({
      ...NONE,
      canCreateRunConfiguration: true,
    });
  });

  it('is safe on a missing or malformed snapshot', () => {
    expect(runLifecycleCapabilities(undefined, 'ide_')).toEqual(NONE);
    expect(runLifecycleCapabilities(null, 'ide_')).toEqual(NONE);
    expect(runLifecycleCapabilities('ide_read_file', 'ide_')).toEqual(NONE);
  });
});
