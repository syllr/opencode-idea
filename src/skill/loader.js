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
 * Load one skill directory into a `Skill.Info`-shaped definition.
 *
 * @param {string} id Directory name, used as the skill id.
 * @returns {{ id: string, name: string, description: string, path: string, content: string }}
 */
export function readSkill(id) {
  const file = new URL(`${id}/${SKILL_FILE_NAME}`, SKILLS_DIR);
  const source = `skills/${id}/${SKILL_FILE_NAME}`;
  const text = readFileSync(file, 'utf8');
  const fields = parseSkillFrontmatter(text, source);
  const description = fields.description;
  if (!description) {
    throw new Error(`${source}: frontmatter needs a "description", otherwise the skill is never offered`);
  }
  return {
    id,
    name: fields.name || id,
    description,
    path: fileURLToPath(file),
    content: text.replace(FRONTMATTER, '').replace(/^\s+/, '').trimEnd(),
  };
}

/**
 * Every shipped skill, sorted by id.
 *
 * @returns {Array<{ id: string, name: string, description: string, path: string, content: string }>}
 */
export function readSkills() {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((id) => readSkill(id));
}
