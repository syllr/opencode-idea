import { describe, expect, it } from 'vitest';

import {
  IDE_PORTS,
  MARK_VERSION,
  markKeyFor,
  parseIdeArgument,
  parseMark,
  serializeMark,
} from './ide-projects.js';

const ROOT = '/w/origin-seed-vc';
const CONFIG = { path: ROOT, app: 'idea' };

describe('常量', () => {
  it('keys the mark by the project path, and pins one fixed port per IDE', () => {
    expect(markKeyFor(ROOT)).toBe(`project/${ROOT}`);
    // 端口是产品常量:IDEA 的内置 MCP 在 64342,PyCharm 在 64462。它们不随版本或项目变化,
    // 所以插件不把它开放给用户配置(测试会把它们指到假端口,见 tests/plugin.test.js)。
    expect(IDE_PORTS).toEqual({ idea: 64342, pycharm: 64462 });
  });
});

describe('parseMark', () => {
  it('round-trips through serializeMark', () => {
    expect(parseMark(serializeMark(CONFIG), ROOT)).toEqual(CONFIG);
  });

  it('only accepts the current format', () => {
    expect(parseMark({ version: MARK_VERSION, path: ROOT, app: 'pycharm' }, ROOT))
      .toEqual({ path: ROOT, app: 'pycharm' });

    // 旧格式 / 半截数据一律当未配置：用户重新 /open-in-ide 即可。
    for (const value of [
      true,
      null,
      undefined,
      false,
      'idea',
      {},
      { root: { path: ROOT, app: 'idea' }, children: [] },
      { version: 2, root: { path: ROOT, app: 'idea' }, children: [] },
      { version: MARK_VERSION, path: '/other', app: 'idea' },
      { version: MARK_VERSION, path: ROOT, app: 'vscode' },
    ]) {
      expect(parseMark(value, ROOT)).toBeUndefined();
    }
  });
});

describe('命令参数', () => {
  it('treats an empty IDE argument as "not given", and accepts a supported one', () => {
    expect(parseIdeArgument('')).toEqual({ ok: true, app: undefined });
    expect(parseIdeArgument(undefined)).toEqual({ ok: true, app: undefined });
    expect(parseIdeArgument('idea')).toEqual({ ok: true, app: 'idea' });
    expect(parseIdeArgument('PyCharm')).toEqual({ ok: true, app: 'pycharm' });
    expect(parseIdeArgument('vscode')).toMatchObject({ ok: false });
  });
});
