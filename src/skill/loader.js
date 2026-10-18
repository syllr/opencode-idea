// The skills this plugin ships, loaded from `skills/<id>/SKILL.md`.
//
// This directory holds the *code* (singular `src/skill/`); the documents live in
// the package-root `skills/` (plural), so reviewing the feature means two clearly
// named places: the loader here, the content there.
//
// The layout mirrors the convention OpenCode itself reads: one directory per
// skill, the document named `SKILL.md`, `name`/`description` in YAML
// frontmatter, and the directory as the base for any relative asset the skill
// ships next to it. Adding a skill is therefore a directory, not a code change.
//
// Three contract details are enforced deliberately:
//   * `description` is required. OpenCode drops a skill without one from the
//     model-facing list, so a missing description would silently disable the
//     skill instead of failing.
//   * the returned definition must satisfy `Skill.Info` exactly (`id` / `name` /
//     `description` / `path` / `content`). A rejected definition fails the skill
//     transform, and a transform failure disables the whole plugin.
//   * `content` is the document body only. The frontmatter is metadata and must
//     not leak into the model prompt.
//
// The frontmatter reader below handles only the flat `key: value` form this
// package writes. It is not a YAML engine and must not grow into one.
//
// The skills used to carry a `requires:` key (the tools each one is written
// around), and the plugin registered a skill only when those tools were being
// served. That gate is gone, together with the key: skills are registered once,
// when the plugin loads (see `plugin.js`), and a missing tool is handled inside
// the skill text. Registering only after the tools appeared made the skill
// invisible until the client reloaded the page. A key left behind would look
// like it still decided something — it does not: OpenCode never reads it, and
// nothing in this package does either.
//
// The other key is OpenCode's own, written in the portable frontmatter spelling
// OpenCode documents: a nested `metadata:` block holding
// `opencode/autoinvoke: false`. It is translated to the definition's
// `autoinvoke` — the name the registration API uses — which is what makes a
// skill user-invoked only: OpenCode keeps it registered and loadable on request,
// but leaves it out of the model's available list.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Package-root `skills/`: one sub-directory per skill, next to `src/`. */
const SKILLS_DIR = new URL('../../skills/', import.meta.url);

/** Document name inside each skill directory. */
export const SKILL_FILE_NAME = 'SKILL.md';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n)?/;

/**
 * @param {string} value
 * @returns {string}
 */
function unquote(value) {
  const quote = value[0];
  if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Read the flat `key: value` frontmatter block a `SKILL.md` must start with.
 *
 * @param {string} text
 * @param {string} source Used in error messages.
 * @returns {Record<string, string>}
 */
export function parseSkillFrontmatter(text, source) {
  const match = FRONTMATTER.exec(text);
  if (!match) throw new Error(`${source}: ${SKILL_FILE_NAME} must start with a YAML frontmatter block`);
  /** @type {Record<string, string>} */
  const fields = {};
  for (const raw of match[1].split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const entry = /^([A-Za-z0-9_/-]+):[ \t]*(.*)$/.exec(line);
    if (!entry) throw new Error(`${source}: unsupported frontmatter line: ${line}`);
    fields[entry[1]] = unquote(entry[2].trim());
  }
  return fields;
}

/**
 * Read `opencode/autoinvoke` out of the frontmatter, or `undefined` when absent.
 *
 * The spelling is OpenCode's portable one — a nested `metadata:` block holding
 * `opencode/autoinvoke: false`. That shape is exactly what the flat reader above
 * already produces: the indented line trims to `opencode/autoinvoke: false` and
 * lands under that namespaced key, while the bare `metadata:` line comes out
 * empty and is ignored. One nesting level is therefore supported on purpose, not
 * by accident.
 *
 * The value must be `true` or `false`. Anything else throws: a typo that
 * silently left the skill model-invocable is the failure this whole mechanism
 * exists to prevent, so it must not pass quietly.
 *
 * @param {Record<string, string>} fields
 * @param {string} source Used in error messages.
 * @returns {boolean | undefined}
 */
export function readAutoinvoke(fields, source) {
  const raw = fields['opencode/autoinvoke'];
  if (raw === undefined) return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${source}: "opencode/autoinvoke" must be true or false, got "${raw}"`);
}

/**
 * Load one skill directory into a `Skill.Info`-shaped definition.
 *
 * @param {string} id Directory name, used as the skill id.
 * @returns {{ id: string, name: string, description: string, autoinvoke?: boolean, path: string, content: string }}
 */
export function readSkill(id) {
  return readSkillPackage(id).skill;
}

/**
 * One skill package.
 *
 * `skill` must satisfy `Skill.Info` exactly — nothing of this package's own
 * metadata rides along into the definition OpenCode validates.
 *
 * `autoinvoke` is OpenCode's, so it goes the other way: it ships in the
 * frontmatter as `opencode/autoinvoke` and is translated onto the definition,
 * where it picks user-invoked-only over model-invocable. It is only set when the
 * frontmatter asks for it, so a skill that says nothing keeps the plain shape.
 *
 * @param {string} id Directory name, used as the skill id.
 * @returns {{ skill: { id: string, name: string, description: string, autoinvoke?: boolean, path: string, content: string } }}
 */
export function readSkillPackage(id) {
  const file = new URL(`${id}/${SKILL_FILE_NAME}`, SKILLS_DIR);
  const source = `skills/${id}/${SKILL_FILE_NAME}`;
  const text = readFileSync(file, 'utf8');
  const fields = parseSkillFrontmatter(text, source);
  const description = fields.description;
  if (!description) {
    throw new Error(`${source}: frontmatter needs a "description", otherwise the skill is never offered`);
  }
  const autoinvoke = readAutoinvoke(fields, source);
  return {
    skill: {
      id,
      name: fields.name || id,
      description,
      ...(autoinvoke === undefined ? {} : { autoinvoke }),
      path: fileURLToPath(file),
      content: text.replace(FRONTMATTER, '').replace(/^\s+/, '').trimEnd(),
    },
  };
}

/**
 * Every shipped skill, sorted by id.
 *
 * @returns {Array<{ skill: { id: string, name: string, description: string, autoinvoke?: boolean, path: string, content: string } }>}
 */
export function readSkills() {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((id) => readSkillPackage(id));
}
