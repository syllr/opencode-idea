import { describe, expect, it } from 'vitest';
import {
  LIST_RUNNING_CONFIGURATIONS_TOOL,
  RERUN_RUN_CONFIGURATION_TOOL,
  RUN_LIFECYCLE_TOOLS,
  STOP_RUN_CONFIGURATION_TOOL,
  servingRunLifecycleTools,
} from './enhance.js';

describe('RUN_LIFECYCLE_TOOLS', () => {
  it('lists the tools the enhance plugin contributes', () => {
    expect(RUN_LIFECYCLE_TOOLS).toEqual([
      'idea_list_running_configurations',
      'idea_stop_run_configuration',
      'idea_rerun_run_configuration',
    ]);
  });

  it('uses the names OpenCode reports, i.e. the server prefix included', () => {
    // OpenCode namespaces an MCP server's tools with the server name, and the
    // IDE server is registered as `idea`. The guidance and the model see these
    // exact strings, so the prefix has to be part of them.
    for (const tool of RUN_LIFECYCLE_TOOLS) {
      expect(tool.startsWith('idea_')).toBe(true);
    }
  });

  it('composes the array from the named constants, not by hand', () => {
    expect(RUN_LIFECYCLE_TOOLS).toEqual([
      LIST_RUNNING_CONFIGURATIONS_TOOL,
      STOP_RUN_CONFIGURATION_TOOL,
      RERUN_RUN_CONFIGURATION_TOOL,
    ]);
  });

  it('keeps the enhance tools out of the native tool surface', () => {
    // `idea.js` describes the MCP server IntelliJ bundles, which knows nothing
    // about these tools. Asserting the split keeps a future edit from leaking
    // the plugin's names back into the native module.
    expect(RUN_LIFECYCLE_TOOLS).not.toContain('idea_get_run_configurations');
    expect(RUN_LIFECYCLE_TOOLS).not.toContain('idea_execute_run_configuration');
  });
});

describe('servingRunLifecycleTools', () => {
  it('returns nothing for a stock IDE', () => {
    // The IDE's bundled MCP server does not ship these; only the companion
    // plugin does. An empty result is what keeps the guidance from naming them.
    expect(servingRunLifecycleTools({ idea_read_file: {}, idea_build_project: {} })).toEqual([]);
  });

  it('returns only the tools actually present', () => {
    expect(
      servingRunLifecycleTools({
        idea_read_file: {},
        idea_stop_run_configuration: {},
        idea_rerun_run_configuration: {},
      }),
    ).toEqual(['idea_stop_run_configuration', 'idea_rerun_run_configuration']);
  });

  it('is safe on a missing or malformed snapshot', () => {
    expect(servingRunLifecycleTools(undefined)).toEqual([]);
    expect(servingRunLifecycleTools(null)).toEqual([]);
    expect(servingRunLifecycleTools('idea_read_file')).toEqual([]);
  });
});
