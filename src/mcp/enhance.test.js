import { describe, expect, it } from 'vitest';
import {
  DEPLOYMENT_SUFFIXES,
  RUN_LIFECYCLE_SUFFIXES,
  UPLOAD_TO_DEPLOYMENT_SUFFIX,
  deploymentCapabilities,
  runLifecycleCapabilities,
  servesTool,
} from './enhance.js';

const NONE_LIFECYCLE = {
  canCreateRunConfiguration: false,
  canInspectRunConfiguration: false,
  canUpdateRunConfiguration: false,
  canDeleteRunConfiguration: false,
  canListRunningConfigurations: false,
  canStopRunConfiguration: false,
  canRerunRunConfiguration: false,
};

const NONE_DEPLOYMENT = {
  canListDeploymentServers: false,
  canUploadToDeployment: false,
  canDownloadFromDeployment: false,
  canGetDeploymentTaskStatus: false,
};

describe('后缀表', () => {
  it('holds bare suffixes, partitioned into the two groups', () => {
    // 工具名是 `<项目前缀><后缀>`(root 是 `ide_`,子项目是目录名),所以表里存的是后缀 ——
    // 存完整名字就只能匹配一个项目。
    for (const suffix of [...RUN_LIFECYCLE_SUFFIXES, ...DEPLOYMENT_SUFFIXES]) {
      expect(suffix.startsWith('ide_')).toBe(false);
      expect(suffix.startsWith('idea_')).toBe(false);
    }
    // 每个后缀只属于一组:归错组就等于用错前提去判断"这段能不能写"。
    const combined = [...RUN_LIFECYCLE_SUFFIXES, ...DEPLOYMENT_SUFFIXES];
    expect(new Set(combined).size).toBe(combined.length);
    expect(RUN_LIFECYCLE_SUFFIXES).toHaveLength(7);
    expect(DEPLOYMENT_SUFFIXES).toHaveLength(4);
  });

  it('keeps the enhance tools out of the native tool surface', () => {
    // `idea.js` 描述的是 IDE 自带的那个 MCP server,它不认识这些工具。
    expect(RUN_LIFECYCLE_SUFFIXES).not.toContain('get_run_configurations');
    expect(RUN_LIFECYCLE_SUFFIXES).not.toContain('execute_run_configuration');
  });
});

describe('能力探测', () => {
  // 两组完全对称:都是「这次请求的工具快照里真的有它吗」,且都按项目前缀分别回答。
  const GROUPS = [
    {
      name: 'run-lifecycle',
      capabilities: runLifecycleCapabilities,
      none: NONE_LIFECYCLE,
      own: 'create_run_configuration',
      other: 'list_deployment_servers',
      present: { canCreateRunConfiguration: true },
      otherPresent: { canListDeploymentServers: true },
    },
    {
      name: 'deployment',
      capabilities: deploymentCapabilities,
      none: NONE_DEPLOYMENT,
      own: 'upload_to_deployment',
      other: 'create_run_configuration',
      present: { canUploadToDeployment: true },
      otherPresent: { canCreateRunConfiguration: true },
    },
  ];

  for (const group of GROUPS) {
    it(`${group.name}: reports nothing for a stock IDE`, () => {
      // IDE 自带的 MCP server 不提供这些 —— 全 false 才让引导不去点名它们。
      expect(group.capabilities({ ide_read_file: {}, ide_build_project: {} }, 'ide_')).toEqual(
        group.none,
      );
    });

    it(`${group.name}: reports only the tools actually present, per project prefix`, () => {
      const tools = {
        ide_read_file: {},
        [`ide_${group.own}`]: {},
        [`modelserver_${group.own}`]: {},
      };
      expect(group.capabilities(tools, 'ide_')).toEqual({ ...group.none, ...group.present });
      expect(group.capabilities(tools, 'modelserver_')).toEqual({ ...group.none, ...group.present });
      // 另一个前缀没有,就是没有
      expect(group.capabilities({ [`ide_${group.own}`]: {} }, 'modelserver_')).toEqual(group.none);
    });

    it(`${group.name}: never answers for the other group`, () => {
      // 两组的前提不同,一组的存在性绝不能被另一组的工具答成"存在"。
      expect(group.capabilities({ [`ide_${group.other}`]: {} }, 'ide_')).toEqual(group.none);
    });

    it(`${group.name}: is safe on a missing or malformed snapshot`, () => {
      // 假设工具存在是这个文件里唯一无法回头的错误:模型会照着引导去调它。
      expect(group.capabilities(undefined, 'ide_')).toEqual(group.none);
      expect(group.capabilities(null, 'ide_')).toEqual(group.none);
      expect(group.capabilities('ide_read_file', 'ide_')).toEqual(group.none);
    });
  }
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
