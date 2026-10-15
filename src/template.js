// The smallest template renderer that makes a prompt document reviewable.
//
// WHY NOT A REAL ENGINE (handlebars / ejs / nunjucks / velocity):
//
//   * HTML escaping is the default in all of them, and it is WRONG here. This
//     renders Markdown for a model: `\`code\``, `<jar>!/<entry>` and `j2k<` must
//     come out byte-for-byte. Configuring that off is possible, but the default
//     is the trap, and the failure is silent mangling of the text a model reads.
//   * It would be the package's first runtime dependency. This plugin ships to
//     npm and is otherwise dependency-free at runtime.
//   * Each engine brings its own whitespace rules, and whitespace IS structure
//     here: one blank line separates sections, and a conditional that renders
//     empty must not leave a gap behind.
//
// What is actually needed is tiny: a variable, and if/else. So that is all this
// does, and the template file stays readable as the document it produces.
//
// DIRECTIVES MUST OCCUPY A WHOLE LINE. A directive line emits nothing at all, so
// "that line is there" and "that line is not there" is the only difference a
// flag makes — no stray blank line, no half-eaten indentation. A directive that
// is not alone on its line is a mistake, and this throws rather than guessing.

const DIRECTIVE = /^\{\{\s*(#if\s+([A-Za-z0-9_]+)|else|\/if)\s*\}\}$/;
// Any control tag anywhere, used to catch a directive that is not alone on its
// line: that line would otherwise be emitted verbatim, silently changing which
// text a model reads.
const CONTROL_TAG = /\{\{\s*(#[^}]*|\/[^}]*|else\s*)\}\}/;
const VARIABLE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/**
 * Render a template against a data record.
 *
 * Supported: `{{name}}`, `{{#if name}}…{{/if}}`, `{{#if name}}…{{else}}…{{/if}}`.
 * Nesting works. Unknown variables render as empty; unknown directives throw,
 * because a typo in a directive silently changes which text a model sees.
 *
 * @param {string} template
 * @param {Record<string, unknown>} data
 * @returns {string}
 */
export function renderTemplate(template, data) {
  const out = [];
  /** @type {Array<{ active: boolean, taken: boolean }>} */
  const stack = [];
  const emitting = () => stack.every((frame) => frame.active);

  // A trailing newline in the file is not part of the document.
  const lines = template.replace(/\n$/, '').split('\n');

  for (const [index, line] of lines.entries()) {
    const match = DIRECTIVE.exec(line.trim());

    if (!match) {
      if (CONTROL_TAG.test(line)) {
        throw new Error(`template line ${index + 1}: a directive must occupy the whole line`);
      }
      if (emitting()) out.push(substitute(line, data));
      continue;
    }

    const directive = match[1];
    if (directive.startsWith('#if')) {
      stack.push({ active: Boolean(data[match[2]]), taken: Boolean(data[match[2]]) });
      continue;
    }
    if (directive === 'else') {
      if (stack.length === 0) throw new Error(`template line ${index + 1}: {{else}} outside {{#if}}`);
      const frame = stack[stack.length - 1];
      // An `{{else}}` after a taken branch stays off: `if/else` is exclusive even
      // when both sides are truthy.
      frame.active = !frame.taken;
      frame.taken = true;
      continue;
    }
    // `{{/if}}`
    if (stack.length === 0) throw new Error(`template line ${index + 1}: {{/if}} without {{#if}}`);
    stack.pop();
  }

  if (stack.length > 0) throw new Error('template: {{#if}} was never closed');

  return out.join('\n');
}

/**
 * Replace `{{name}}` with its value. Values are inserted verbatim — see the file
 * header for why nothing is escaped.
 */
function substitute(line, data) {
  return line.replace(VARIABLE, (_whole, name) => {
    const value = data[name];
    return value === undefined || value === null ? '' : String(value);
  });
}
