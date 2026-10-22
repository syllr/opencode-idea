import { describe, expect, it } from 'vitest';

import {
  IDE_PORTS,
  ROOT_SERVER_NAME,
  listProjects,
  markKeyFor,
  parseIdeArgument,
  parseMark,
  parseSubprojectArgument,
  serializeMark,
  serverNameFor,
  toolPrefixes,
  validateSubproject,
  withSubproject,
} from './ide-projects.js';

const ROOT = '/w/origin-seed-vc';

/** 一个已登记 root + 两个子项目的配置。 */
function sampleConfig() {
  return {
    root: { path: ROOT, app: 'idea' },
    children: [
      { path: `${ROOT}/modelserver`, app: 'pycharm' },
      { path: `${ROOT}/frontend/admin`, app: 'idea' },
    ],
  };
}

describe('常量', () => {
  it('keys the mark by the root path, and pins one fixed port per IDE', () => {
    expect(markKeyFor(ROOT)).toBe(`project/${ROOT}`);
    // 端口是产品常量:IDEA 的内置 MCP 在 64342,PyCharm 在 64462。它们不随版本或项目变化,
    // 所以插件不把它开放给用户配置(测试会把它们指到假端口,见 tests/plugin.test.js)。
    expect(IDE_PORTS).toEqual({ idea: 64342, pycharm: 64462 });
  });
});

describe('parseMark', () => {
  it('round-trips through serializeMark', () => {
    const config = sampleConfig();
    expect(parseMark(serializeMark(config), ROOT)).toEqual(config);
  });

  it('reads the legacy boolean as a v1 root-only config', () => {
    expect(parseMark(true, ROOT)).toEqual({ root: { path: ROOT, app: 'idea' }, children: [] });
  });

  it('returns undefined for anything that is not a config', () => {
    for (const value of [undefined, null, false, 'idea', {}, { root: { path: ROOT } }]) {
      expect(parseMark(value, ROOT)).toBeUndefined();
    }
  });

  it('drops malformed children instead of failing the whole config', () => {
    const parsed = parseMark(
      {
        version: 2,
        root: { path: ROOT, app: 'pycharm' },
        children: [{ path: `${ROOT}/ok`, app: 'idea' }, { path: 42 }, null],
      },
      ROOT,
    );
    expect(parsed).toEqual({
      root: { path: ROOT, app: 'pycharm' },
      children: [{ path: `${ROOT}/ok`, app: 'idea' }],
    });
  });
});

describe('项目与前缀', () => {
  it('names the root `ide` and each child after its directory', () => {
    expect(serverNameFor(ROOT, ROOT)).toBe(ROOT_SERVER_NAME);
    expect(serverNameFor(`${ROOT}/modelserver`, ROOT)).toBe('modelserver');
    expect(serverNameFor(`${ROOT}/frontend/admin`, ROOT)).toBe('admin');
  });

  it('lists the root first, then children in registration order, with their prefixes', () => {
    expect(listProjects(sampleConfig())).toEqual([
      { path: ROOT, app: 'idea', server: 'ide', isRoot: true },
      { path: `${ROOT}/modelserver`, app: 'pycharm', server: 'modelserver', isRoot: false },
      { path: `${ROOT}/frontend/admin`, app: 'idea', server: 'admin', isRoot: false },
    ]);
    expect(toolPrefixes(sampleConfig())).toEqual(['ide_', 'modelserver_', 'admin_']);
  });
});

describe('validateSubproject', () => {
  it('accepts a well-formed child directory', () => {
    expect(validateSubproject(sampleConfig(), `${ROOT}/sync`)).toEqual({ ok: true });
  });

  it('rejects every bad path, each with its own reason', () => {
    // 一条一条列出来,是为了让"为什么拒"看得见 —— 这些码是给用户看的。
    const cases = [
      ['a path outside the root', '/w/elsewhere/modelserver', 'outside-root'],
      ['the reserved root prefix', `${ROOT}/ide`, 'reserved'],
      ['a directory that is already registered', `${ROOT}/modelserver`, 'already-registered'],
      ['two children that would share one prefix', `${ROOT}/refs/modelserver`, 'duplicate-prefix'],
    ];
    for (const [label, path, code] of cases) {
      expect(validateSubproject(sampleConfig(), path), label).toMatchObject({ ok: false, code });
    }
  });

  it('rejects every directory name that would not survive the prefix rule', () => {
    // 目录名就是工具前缀,所以不给猜的余地:不合规的一律拒绝,由用户改。
    const names = [
      'ModelServer',
      'modelserver.v2',
      'model server',
      '模型服务',
      '-modelserver',
      'a'.repeat(49),
    ];
    for (const name of names) {
      expect(validateSubproject(sampleConfig(), `${ROOT}/${name}`), name).toMatchObject({
        ok: false,
        code: 'invalid-name',
      });
    }
  });
});

describe('withSubproject', () => {
  it('appends without mutating the input', () => {
    const before = sampleConfig();
    const after = withSubproject(before, `${ROOT}/sync`, 'pycharm');
    expect(before.children).toHaveLength(2);
    expect(after.children).toHaveLength(3);
    expect(after.children[2]).toEqual({ path: `${ROOT}/sync`, app: 'pycharm' });
    expect(after.root).not.toBe(before.root);
  });
});

describe('命令参数', () => {
  it('reads the single path argument', () => {
    expect(parseSubprojectArgument('modelserver')).toEqual({ ok: true, path: 'modelserver' });
    expect(parseSubprojectArgument('  frontend/admin  ')).toEqual({ ok: true, path: 'frontend/admin' });
  });

  it('refuses an empty or multi-word argument', () => {
    for (const value of ['', undefined, 'modelserver pycharm']) {
      expect(parseSubprojectArgument(value)).toMatchObject({ ok: false });
    }
  });

  it('treats an empty IDE argument as "not given", and accepts a supported one', () => {
    expect(parseIdeArgument('')).toEqual({ ok: true, app: undefined });
    expect(parseIdeArgument(undefined)).toEqual({ ok: true, app: undefined });
    expect(parseIdeArgument('idea')).toEqual({ ok: true, app: 'idea' });
    expect(parseIdeArgument('PyCharm')).toEqual({ ok: true, app: 'pycharm' });
    expect(parseIdeArgument('vscode')).toMatchObject({ ok: false });
  });
});
