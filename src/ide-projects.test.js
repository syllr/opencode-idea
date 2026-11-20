import { describe, expect, it } from 'vitest';

import {
  IDE_PORTS,
  IDEA_PORT_SCAN_SPAN,
  MARK_VERSION,
  markKeyFor,
  parseCurrentMark,
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

describe('parseMark / parseCurrentMark', () => {
  it('round-trips through serializeMark', () => {
    expect(parseMark(serializeMark())).toEqual({version: MARK_VERSION});
    expect(parseCurrentMark(serializeMark())).toEqual({version: MARK_VERSION});
  });

  it('strict parsing fails on anything but the current format (so readConfig rewrites it)', () => {
    // 严格的判据只有「能不能按当前格式读出来」:读不出来 = 这个 value 有问题,
    // readConfig 会把它覆写成当前格式。
    for (const value of [
      true,
      false,
      'idea',
      {},
      {version: 3, path: '/w/project', app: 'idea'},
      {version: 2, root: {path: '/w/project', app: 'idea'}, children: []},
      {version: '4'},
    ]) {
      expect(parseCurrentMark(value)).toBeUndefined();
    }

    expect(parseCurrentMark(null)).toBeUndefined();
    expect(parseCurrentMark(undefined)).toBeUndefined();
  });

  it('treats any stored value as a mark, and only null/undefined as unconfigured', () => {
    // 标记的语义是「这个项目接入过 IDE」,格式只是载体:旧值虽然解析不出来,但仍然是
    // 一个已接入的标记,该被迁移,不该被当成未配置。
    for (const value of [true, 'idea', {}, {version: 3, path: '/w/project', app: 'idea'}]) {
      expect(parseMark(value)).toEqual({version: MARK_VERSION});
    }

    expect(parseMark(null)).toBeUndefined();
    expect(parseMark(undefined)).toBeUndefined();
  });
});
