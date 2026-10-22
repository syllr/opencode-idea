import { describe, expect, it } from 'vitest';
import { appendDirectoryTreeTruncationNotice } from './idea-tool-output.js';

/** 本会话有两个项目：root（`ide_`）与一个子项目（`modelserver_`）。 */
const PREFIXES = ['ide_', 'modelserver_'];

/**
 * 造一棵深度为 `depth` 的树。
 *
 * 格式照 IDE 的真实输出:每一层固定占 4 个字符,延续层用 `│` 占位。
 */
function tree(depth) {
  const lines = ['/p/'];
  for (let level = 1; level <= depth; level += 1) {
    const indent = `${'    '.repeat(level - 1)}│   `.slice(0, level * 4);
    lines.push(`${indent}├── level${level}/`);
  }
  return lines.join('\n');
}

/** MCP 返回的就是这个 JSON 文本;`content` 两种形状都允许。 */
function resultOf(text, { asString = false } = {}) {
  const payload = JSON.stringify({ traversedDirectory: 'p', tree: text, errors: [] });
  return asString ? { content: payload } : { content: [{ type: 'text', text: payload }] };
}

function call(tool, maxDepth) {
  return { tool, input: maxDepth === undefined ? {} : { maxDepth }, prefixes: PREFIXES };
}

describe('appendDirectoryTreeTruncationNotice', () => {
  it('appends a visible notice when the tree reaches the maxDepth boundary', () => {
    // maxDepth=6 实际只展开 5 层 —— 这次事故正是断在这一层,而且原输出里没有任何标记。
    const result = resultOf(tree(5));
    const next = appendDirectoryTreeTruncationNotice(result, call('ide_list_directory_tree', 6));

    expect(next).not.toBe(result);
    expect(next.content).toHaveLength(2);
    // 原有内容原样保留,提示是追加的。
    expect(next.content[0]).toBe(result.content[0]);
    expect(next.content[1].text).toContain('maxDepth=6');
    expect(next.content[1].text).toContain('第 5 层');
  });

  it('leaves a fully rendered tree untouched', () => {
    const result = resultOf(tree(3));
    expect(appendDirectoryTreeTruncationNotice(result, call('ide_list_directory_tree', 6))).toBe(result);
  });

  it('measures depth for the mixed indent the IDE actually emits', () => {
    // `    │       ├── ` 的前缀是 12 个字符 → 第 3 层。纯空格缩进也要算对。
    const result = resultOf(
      ['/p/', '    ├── a/', '    │   └── b/', '    │       ├── c/'].join('\n'),
    );
    // maxDepth=4 → 边界是第 3 层,触发。
    expect(appendDirectoryTreeTruncationNotice(result, call('ide_list_directory_tree', 4))).not.toBe(result);
    // maxDepth=5 → 边界是第 4 层,没到,不动。
    expect(appendDirectoryTreeTruncationNotice(result, call('ide_list_directory_tree', 5))).toBe(result);
  });

  it('handles a plain-string content', () => {
    const result = resultOf(tree(5), { asString: true });
    const next = appendDirectoryTreeTruncationNotice(result, call('ide_list_directory_tree', 6));
    expect(typeof next.content).toBe('string');
    expect(next.content).toContain('maxDepth=6');
  });

  it('touches only its own tool, only when there is text to read', () => {
    const result = resultOf(tree(5));
    for (const other of [
      call('ide_read_file', 6),
      call('list_directory_tree', 6),
      { tool: 'ide_list_directory_tree', input: { maxDepth: 6 }, prefixes: [] },
    ]) {
      expect(appendDirectoryTreeTruncationNotice(result, other)).toBe(result);
    }
    // content 形状不认识 → 不改,而且不能抛。
    const opaque = { output: 'something' };
    expect(appendDirectoryTreeTruncationNotice(opaque, call('ide_list_directory_tree', 6))).toBe(opaque);
  });

  it('falls back to the parameter floor when maxDepth is missing', () => {
    // 参数侧(RAISED_ARGUMENTS)保证真实调用至少是 50;这里拿不到输入时按同一个下限判断。
    const shallow = resultOf(tree(3));
    expect(appendDirectoryTreeTruncationNotice(shallow, call('ide_list_directory_tree'))).toBe(shallow);

    const deep = resultOf(tree(49));
    expect(appendDirectoryTreeTruncationNotice(deep, call('ide_list_directory_tree'))).not.toBe(deep);
  });

  it('is safe on a malformed result', () => {
    for (const bad of [undefined, null, 'text', 42]) {
      expect(() => appendDirectoryTreeTruncationNotice(bad, call('ide_list_directory_tree', 6))).not.toThrow();
      expect(appendDirectoryTreeTruncationNotice(bad, call('ide_list_directory_tree', 6))).toBe(bad);
    }
  });
});
