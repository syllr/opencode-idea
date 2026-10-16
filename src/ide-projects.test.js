import { describe, expect, it } from 'vitest';

import {
  ROOT_SERVER_NAME,
  IDE_PORTS,
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

describe('markKeyFor', () => {
  it('keys the mark by the root path', () => {
    expect(markKeyFor(ROOT)).toBe(`project/${ROOT}`);
  });
});

describe('IDE_PORTS', () => {
  it('pins one fixed port per IDE', () => {
    // 端口是产品常量:IDEA 的内置 MCP 在 64342,PyCharm 在 64462。它们不随版本或项目
    // 变化,所以插件不把它开放给用户配置(测试会把它们指到假端口,见 tests/plugin.test.js)。
    expect(IDE_PORTS).toEqual({ idea: 64342, pycharm: 64462 });
  });
});

describe('parseMark', () => {
  it('reads the legacy boolean as a v1 root-only config', () => {
    expect(parseMark(true, ROOT)).toEqual({ root: { path: ROOT, app: 'idea' }, children: [] });
  });

  it('returns undefined for anything that is not a config', () => {
    expect(parseMark(undefined, ROOT)).toBeUndefined();
    expect(parseMark(null, ROOT)).toBeUndefined();
    expect(parseMark(false, ROOT)).toBeUndefined();
    expect(parseMark('idea', ROOT)).toBeUndefined();
    expect(parseMark({}, ROOT)).toBeUndefined();
    expect(parseMark({ root: { path: ROOT } }, ROOT)).toBeUndefined();
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

  it('round-trips through serializeMark', () => {
    const config = sampleConfig();
    expect(parseMark(serializeMark(config), ROOT)).toEqual(config);
  });
});

describe('serverNameFor', () => {
  it('names the root `ide` regardless of which IDE opens it', () => {
    expect(serverNameFor(ROOT, ROOT)).toBe(ROOT_SERVER_NAME);
  });

  it('names a child after its directory', () => {
    expect(serverNameFor(`${ROOT}/modelserver`, ROOT)).toBe('modelserver');
    expect(serverNameFor(`${ROOT}/frontend/admin`, ROOT)).toBe('admin');
  });
});

describe('listProjects / toolPrefixes', () => {
  it('lists the root first, then children in registration order', () => {
    expect(listProjects(sampleConfig())).toEqual([
      { path: ROOT, app: 'idea', server: 'ide', isRoot: true },
      { path: `${ROOT}/modelserver`, app: 'pycharm', server: 'modelserver', isRoot: false },
      { path: `${ROOT}/frontend/admin`, app: 'idea', server: 'admin', isRoot: false },
    ]);
  });

  it('derives the tool prefixes', () => {
    expect(toolPrefixes(sampleConfig())).toEqual(['ide_', 'modelserver_', 'admin_']);
  });
});

describe('validateSubproject', () => {
  it('accepts a well-formed child directory', () => {
    expect(validateSubproject(sampleConfig(), `${ROOT}/sync`)).toEqual({ ok: true });
  });

  it('rejects a path outside the root', () => {
    const verdict = validateSubproject(sampleConfig(), '/w/elsewhere/modelserver');
    expect(verdict).toMatchObject({ ok: false, code: 'outside-root' });
  });

  it.each([
    ['uppercase', 'ModelServer'],
    ['a dot', 'modelserver.v2'],
    ['a space', 'model server'],
    ['non-ascii', '模型服务'],
    ['a leading dash', '-modelserver'],
    ['too long', 'a'.repeat(49)],
  ])('rejects a directory name with %s', (_label, name) => {
    const verdict = validateSubproject(sampleConfig(), `${ROOT}/${name}`);
    expect(verdict).toMatchObject({ ok: false, code: 'invalid-name' });
  });

  it('rejects the reserved root prefix', () => {
    const verdict = validateSubproject(sampleConfig(), `${ROOT}/ide`);
    expect(verdict).toMatchObject({ ok: false, code: 'reserved' });
  });

  it('rejects a directory that is already registered', () => {
    const verdict = validateSubproject(sampleConfig(), `${ROOT}/modelserver`);
    expect(verdict).toMatchObject({ ok: false, code: 'already-registered' });
  });

  it('rejects two children that would share one prefix', () => {
    const verdict = validateSubproject(sampleConfig(), `${ROOT}/refs/modelserver`);
    expect(verdict).toMatchObject({ ok: false, code: 'duplicate-prefix' });
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

describe('parseSubprojectArgument', () => {
  it('reads the single path argument', () => {
    expect(parseSubprojectArgument('modelserver')).toEqual({ ok: true, path: 'modelserver' });
    expect(parseSubprojectArgument('  frontend/admin  ')).toEqual({ ok: true, path: 'frontend/admin' });
  });

  it('refuses an empty or multi-word argument', () => {
    expect(parseSubprojectArgument('')).toMatchObject({ ok: false });
    expect(parseSubprojectArgument(undefined)).toMatchObject({ ok: false });
    expect(parseSubprojectArgument('modelserver pycharm')).toMatchObject({ ok: false });
  });
});

describe('parseIdeArgument', () => {
  it('treats an empty argument as "not given"', () => {
    expect(parseIdeArgument('')).toEqual({ ok: true, app: undefined });
    expect(parseIdeArgument(undefined)).toEqual({ ok: true, app: undefined });
  });

  it('accepts a supported IDE, case-insensitively', () => {
    expect(parseIdeArgument('idea')).toEqual({ ok: true, app: 'idea' });
    expect(parseIdeArgument('PyCharm')).toEqual({ ok: true, app: 'pycharm' });
  });

  it('rejects an unknown IDE', () => {
    expect(parseIdeArgument('vscode')).toMatchObject({ ok: false });
  });
});
