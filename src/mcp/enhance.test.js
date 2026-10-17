import { describe, expect, it } from 'vitest';
import {
  CREATE_SHELL_RUN_CONFIGURATION_SUFFIX,
  DEPLOYMENT_SUFFIXES,
  DOWNLOAD_FROM_DEPLOYMENT_SUFFIX,
  GET_DEPLOYMENT_TASK_STATUS_SUFFIX,
  LIST_DEPLOYMENT_SERVERS_SUFFIX,
  LIST_RUNNING_CONFIGURATIONS_SUFFIX,
  RERUN_RUN_CONFIGURATION_SUFFIX,
  RUN_LIFECYCLE_SUFFIXES,
  STOP_RUN_CONFIGURATION_SUFFIX,
  UPLOAD_TO_DEPLOYMENT_SUFFIX,
  deploymentCapabilities,
  runLifecycleCapabilities,
  servesTool,
} from './enhance.js';

const NONE = {
  canCreateRunConfiguration: false,
  canListRunningConfigurations: false,
  canStopRunConfiguration: false,
  canRerunRunConfiguration: false,
};

const NO_DEPLOYMENT = {
  canListDeploymentServers: false,
  canUploadToDeployment: false,
  canDownloadFromDeployment: false,
  canGetDeploymentTaskStatus: false,
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

describe('DEPLOYMENT_SUFFIXES', () => {
  it('lists the suffixes the enhance plugin contributes', () => {
    expect(DEPLOYMENT_SUFFIXES).toEqual([
      'list_deployment_servers',
      'upload_to_deployment',
      'download_from_deployment',
      'get_deployment_task_status',
    ]);
  });

  it('carries no prefix: the per-project prefix is composed at use time', () => {
    for (const suffix of DEPLOYMENT_SUFFIXES) {
      expect(suffix.startsWith('idea_')).toBe(false);
      expect(suffix.startsWith('ide_')).toBe(false);
    }
  });

  it('composes the array from the named constants, not by hand', () => {
    expect(DEPLOYMENT_SUFFIXES).toEqual([
      LIST_DEPLOYMENT_SERVERS_SUFFIX,
      UPLOAD_TO_DEPLOYMENT_SUFFIX,
      DOWNLOAD_FROM_DEPLOYMENT_SUFFIX,
      GET_DEPLOYMENT_TASK_STATUS_SUFFIX,
    ]);
  });

  it('stays disjoint from the run-lifecycle group', () => {
    // 两组各自回答一个问题,而部署那组还多一个前提(webDeployment,仅 Ultimate 有)。
    // 混进一张表,"run-lifecycle 在不在"就会被一个部署工具答成"在"。
    for (const suffix of DEPLOYMENT_SUFFIXES) {
      expect(RUN_LIFECYCLE_SUFFIXES).not.toContain(suffix);
    }
    expect(new Set(DEPLOYMENT_SUFFIXES).size).toBe(DEPLOYMENT_SUFFIXES.length);
  });

  it("keeps the two groups a partition of the plugin's tools", () => {
    // 每个后缀只属于一组:归错组就等于用错前提去判断"这段能不能写"。
    const combined = [...RUN_LIFECYCLE_SUFFIXES, ...DEPLOYMENT_SUFFIXES];
    expect(new Set(combined).size).toBe(combined.length);
    // 一组是 4 个 run-lifecycle,一组是 4 个 deployment —— 这张表就是 v1 合约的全部名字。
    expect(DEPLOYMENT_SUFFIXES).toHaveLength(4);
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

  it('does not answer for the deployment group', () => {
    // 两组的前提不同,所以一组的存在性绝不能被另一组的工具答成"存在"。
    const deploymentOnly = {
      ide_list_deployment_servers: {},
      ide_upload_to_deployment: {},
      ide_download_from_deployment: {},
      ide_get_deployment_task_status: {},
    };
    expect(runLifecycleCapabilities(deploymentOnly, 'ide_')).toEqual(NONE);
  });
});

describe('servesTool', () => {
  it('composes the wire name from the prefix, verbatim', () => {
    const tools = { modelserver_upload_to_deployment: {} };
    expect(servesTool(tools, 'modelserver_', UPLOAD_TO_DEPLOYMENT_SUFFIX)).toBe(true);
    expect(servesTool(tools, 'ide_', UPLOAD_TO_DEPLOYMENT_SUFFIX)).toBe(false);
    // 前缀原样拼(含下划线):少一个下划线就不是同一个工具名。
    expect(servesTool(tools, 'modelserver', UPLOAD_TO_DEPLOYMENT_SUFFIX)).toBe(false);
  });

  it('is safe on a missing or malformed snapshot', () => {
    expect(servesTool(undefined, 'ide_', UPLOAD_TO_DEPLOYMENT_SUFFIX)).toBe(false);
    expect(servesTool(null, 'ide_', UPLOAD_TO_DEPLOYMENT_SUFFIX)).toBe(false);
    expect(servesTool('ide_upload_to_deployment', 'ide_', UPLOAD_TO_DEPLOYMENT_SUFFIX)).toBe(false);
  });
});

describe('deploymentCapabilities', () => {
  it('reports nothing for a stock IDE', () => {
    expect(deploymentCapabilities({ ide_read_file: {}, ide_build_project: {} }, 'ide_')).toEqual(
      NO_DEPLOYMENT,
    );
  });

  it('reports only the tools actually present, and does so per project prefix', () => {
    const tools = {
      ide_read_file: {},
      ide_upload_to_deployment: {},
      ide_get_deployment_task_status: {},
      modelserver_list_deployment_servers: {},
    };
    expect(deploymentCapabilities(tools, 'ide_')).toEqual({
      ...NO_DEPLOYMENT,
      canUploadToDeployment: true,
      canGetDeploymentTaskStatus: true,
    });
    expect(deploymentCapabilities(tools, 'modelserver_')).toEqual({
      ...NO_DEPLOYMENT,
      canListDeploymentServers: true,
    });
  });

  it('is safe on a missing or malformed snapshot', () => {
    // 假设工具存在是这个文件里唯一无法回头的错误:模型会照着引导去调它。
    expect(deploymentCapabilities(undefined, 'ide_')).toEqual(NO_DEPLOYMENT);
    expect(deploymentCapabilities(null, 'ide_')).toEqual(NO_DEPLOYMENT);
    expect(deploymentCapabilities('ide_read_file', 'ide_')).toEqual(NO_DEPLOYMENT);
  });

  it('does not answer for the run-lifecycle group', () => {
    const lifecycleOnly = {
      ide_create_shell_run_configuration: {},
      ide_list_running_configurations: {},
      ide_stop_run_configuration: {},
      ide_rerun_run_configuration: {},
    };
    expect(deploymentCapabilities(lifecycleOnly, 'ide_')).toEqual(NO_DEPLOYMENT);
  });
});
