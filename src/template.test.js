import { describe, expect, it } from 'vitest';
import { renderTemplate } from './template.js';

describe('renderTemplate', () => {
  it('substitutes variables, and renders an unknown one as empty', () => {
    expect(renderTemplate('a {{x}} b', { x: 'X' })).toBe('a X b');
    expect(renderTemplate('{{a}}/{{b}}', { a: 1, b: 'two' })).toBe('1/two');
    expect(renderTemplate('{{p}} {{p}} {{n}}', { p: '/x', n: 3 })).toBe('/x /x 3');
    // 未知变量渲染成空,而不是把花括号留在那儿。
    expect(renderTemplate('a{{missing}}b', {})).toBe('ab');
  });

  it('keeps values verbatim — no HTML escaping', () => {
    // 这就是它不是真引擎的原因:输出是给模型看的 Markdown,`<jar>!/<entry>` 和反引号
    // 必须逐字节原样过。默认转义的引擎会把它变成 &lt;jar&gt;。
    const value = '`<jar>!/<entry>` & "quotes"';
    expect(renderTemplate('{{v}}', { v: value })).toBe(value);
  });

  it('renders an if/else block, taking exactly one branch', () => {
    const template = ['head', '{{#if on}}', 'yes', '{{else}}', 'no', '{{/if}}', 'tail'].join('\n');
    expect(renderTemplate(template, { on: true })).toBe('head\nyes\ntail');
    expect(renderTemplate(template, { on: false })).toBe('head\nno\ntail');
  });

  it('treats an empty string, 0 and undefined as false', () => {
    const template = ['{{#if v}}', 'yes', '{{/if}}'].join('\n');
    for (const v of ['', 0, undefined, false]) {
      expect(renderTemplate(template, { v })).toBe('');
    }
    expect(renderTemplate(template, { v: 'x' })).toBe('yes');
  });

  it('nests, and interpolates inside a block', () => {
    const nested = ['{{#if a}}', 'A', '{{#if b}}', 'B', '{{/if}}', '{{/if}}'].join('\n');
    expect(renderTemplate(nested, { a: true, b: true })).toBe('A\nB');
    expect(renderTemplate(nested, { a: true, b: false })).toBe('A');
    expect(renderTemplate(nested, { a: false, b: true })).toBe('');
    expect(renderTemplate(['{{#if on}}', 'hi {{name}}', '{{/if}}'].join('\n'), { on: true, name: 'bob' })).toBe(
      'hi bob',
    );
  });

  it('preserves the whitespace the document uses as structure', () => {
    // 一行空行分隔章节,它是字面写出来的。
    expect(renderTemplate(['one', '', 'two', '', 'three'].join('\n'), {})).toBe('one\n\ntwo\n\nthree');
    // 结尾那一个换行不算内容,尾随空格算。
    expect(renderTemplate('a\n', {})).toBe('a');
    expect(renderTemplate('a  \n', {})).toBe('a  ');
    // 假分支不能留下一个空行。
    expect(renderTemplate(['a', '{{#if on}}', 'b', '{{/if}}', 'c'].join('\n'), { on: false })).toBe('a\nc');
  });

  it('fails loudly on a directive that is not alone on its line', () => {
    // 半个指令被吃掉,会悄悄改掉模型看到的那段文字,所以不能猜。
    expect(() => renderTemplate('x {{#if on}}y{{/if}}', { on: true })).toThrow(/whole line/);
  });

  it('fails loudly on unbalanced directives', () => {
    expect(() => renderTemplate('{{/if}}', {})).toThrow(/without/);
    expect(() => renderTemplate('{{else}}', {})).toThrow(/outside/);
    expect(() => renderTemplate('{{#if a}}\nx', { a: true })).toThrow(/never closed/);
  });
});
