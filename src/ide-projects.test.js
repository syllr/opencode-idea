import { describe, expect, it } from 'vitest';

import { IDE_PORTS, MARK_VERSION, markKeyFor, parseMark, serializeMark } from './ide-projects.js';

describe('常量', () => {
  it('keys the mark by the project path, and pins the IDE MCP port', () => {
    expect(markKeyFor('/w/project')).toBe('project//w/project');
    // 端口是产品常量:IDEA 的内置 MCP 在 64342。它不随版本或项目变化,所以插件不把它
    // 开放给用户配置(测试会把它们指到假端口,见 tests/plugin.test.js)。
    expect(IDE_PORTS).toEqual({idea: 64342});
  });
});

describe('parseMark', () => {
  it('round-trips through serializeMark', () => {
    expect(parseMark(serializeMark())).toEqual({version: MARK_VERSION});
  });

  it('only accepts the current format', () => {
    expect(parseMark({version: MARK_VERSION})).toEqual({version: MARK_VERSION});

    // 旧格式一律当未配置：用户重新 /open-in-ide 即可。
    for (const value of [
      true,
      null,
      undefined,
      false,
      'idea',
      {},
      {version: 3, path: '/w/project', app: 'idea'},
      {version: 2, root: {path: '/w/project', app: 'idea'}, children: []},
    ]) {
      expect(parseMark(value)).toBeUndefined();
    }
  });
});
