import { describe, expect, it } from 'vitest';
import { renderTemplate } from './template.js';

describe('renderTemplate', () => {
  it('substitutes variables', () => {
    expect(renderTemplate('a {{x}} b', { x: 'X' })).toBe('a X b');
    expect(renderTemplate('{{a}}/{{b}}', { a: 1, b: 'two' })).toBe('1/two');
  });

  it('supports repeated variables and numbers', () => {
    expect(renderTemplate('{{p}} {{p}} {{n}}', { p: '/x', n: 3 })).toBe('/x /x 3');
  });

  it('renders an unknown variable as empty rather than leaving the braces', () => {
    expect(renderTemplate('a{{missing}}b', {})).toBe('ab');
  });

  it('keeps values verbatim — no HTML escaping', () => {
    // The whole reason this is not a real engine: the output is Markdown for a
    // model, and `<jar>!/<entry>` / backticks must survive byte-for-byte. An
    // engine that escapes by default would turn this into &lt;jar&gt;.
    const value = '`<jar>!/<entry>` & "quotes"';
    expect(renderTemplate('{{v}}', { v: value })).toBe(value);
  });

  it('renders an {{#if}} block only when truthy, with no leftover line', () => {
    const template = ['a', '{{#if on}}', 'b', '{{/if}}', 'c'].join('\n');
    expect(renderTemplate(template, { on: true })).toBe('a\nb\nc');
    // A false block leaves no blank line where its directive lines were.
    expect(renderTemplate(template, { on: false })).toBe('a\nc');
  });

  it('treats an empty string, 0 and undefined as false', () => {
    const template = ['{{#if v}}', 'yes', '{{/if}}'].join('\n');
    expect(renderTemplate(template, { v: '' })).toBe('');
    expect(renderTemplate(template, { v: 0 })).toBe('');
    expect(renderTemplate(template, { v: undefined })).toBe('');
    expect(renderTemplate(template, { v: 'x' })).toBe('yes');
  });

  it('picks exactly one branch of if/else', () => {
    const template = ['head', '{{#if on}}', 'yes', '{{else}}', 'no', '{{/if}}', 'tail'].join('\n');
    expect(renderTemplate(template, { on: true })).toBe('head\nyes\ntail');
    expect(renderTemplate(template, { on: false })).toBe('head\nno\ntail');
  });

  it('nests', () => {
    const template = ['{{#if a}}', 'A', '{{#if b}}', 'B', '{{/if}}', '{{/if}}'].join('\n');
    expect(renderTemplate(template, { a: true, b: true })).toBe('A\nB');
    expect(renderTemplate(template, { a: true, b: false })).toBe('A');
    expect(renderTemplate(template, { a: false, b: true })).toBe('');
  });

  it('interpolates inside a block', () => {
    const template = ['{{#if on}}', 'hi {{name}}', '{{/if}}'].join('\n');
    expect(renderTemplate(template, { on: true, name: 'bob' })).toBe('hi bob');
  });

  it('preserves the blank lines the document uses as structure', () => {
    // One blank line separates sections, and it is written literally.
    const template = ['one', '', 'two', '', 'three'].join('\n');
    expect(renderTemplate(template, {})).toBe('one\n\ntwo\n\nthree');
  });

  it('drops a single trailing newline from the file, not trailing spaces', () => {
    expect(renderTemplate('a\n', {})).toBe('a');
    expect(renderTemplate('a  \n', {})).toBe('a  ');
  });

  it('fails loudly on a directive that is not alone on its line', () => {
    // A half-consumed directive would silently change which text a model sees,
    // so it must not be guessed at.
    expect(() => renderTemplate('x {{#if on}}y{{/if}}', { on: true })).toThrow(/whole line/);
  });

  it('fails loudly on unbalanced directives', () => {
    expect(() => renderTemplate('{{/if}}', {})).toThrow(/without/);
    expect(() => renderTemplate('{{else}}', {})).toThrow(/outside/);
    expect(() => renderTemplate('{{#if a}}\nx', { a: true })).toThrow(/never closed/);
  });

  it('is deterministic for the same input', () => {
    const template = ['{{#if a}}', 'x {{v}}', '{{else}}', 'y', '{{/if}}'].join('\n');
    const data = { a: true, v: '1' };
    expect(renderTemplate(template, data)).toBe(renderTemplate(template, data));
  });
});
