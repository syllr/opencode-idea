import { describe, expect, it } from 'vitest';

import {
  IDE_PORTS,
  IDEA_PORT_SCAN_SPAN,
  MARK_VERSION,
  markKeyFor,
  parseMark,
  serializeMark,
} from './ide-projects.js';

describe('常量', () => {
  it('keys the mark by the project path, and pins the IDE MCP port scan window', () => {
    expect(markKeyFor('/w/project')).toBe('project//w/project');
    // 扫描窗口是数据契约:起点 64342,跨度 20,即插件最多探到 64361。
    // IDEA 的端口会漂(被占时静默上浮),所以这个窗口必须跟着 IDEA 的漂移量级走。
    expect(IDE_PORTS).toEqual({idea: 64342});
    expect(IDEA_PORT_SCAN_SPAN).toBe(20);
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
