// The `idea-run-config` skill registered by the plugin.
//
// Run configurations are plain XML files under `.run/`. The IDE MCP server can
// list and execute them (`get_run_configurations` / `execute_run_configuration`)
// but has no create/update/delete. Hard-coding a template per configuration type
// would be an open-ended maintenance hole (Application, JUnit, Gradle, npm,
// Shell Script, Spring Boot, Docker, Compound, ...), so the plugin ships a skill
// instead: it teaches the model where the files live, how to bootstrap a schema
// from a real example, and how to verify a write.
//
// The text lives in `ide-run-config-skill.md` next to this module, so it is a
// real skill document and the XML snippets it contains are not mistaken for
// markup inside a string literal.
//
// The skill is registered at setup and does NOT depend on `/open-in-idea`.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Skill id used by the registry. */
export const RUN_CONFIG_SKILL_ID = 'idea-run-config';

/** Description shown to the model when picking a skill. */
export const RUN_CONFIG_SKILL_DESCRIPTION = [
  '管理 JetBrains IDE 的 run configuration:在项目级 `.run/*.run.xml` 里创建、修改、删除运行配置。',
  '当用户要新建运行配置、修改或删除已有配置、把脚本或执行流程包成可运行的配置,',
  '或让 AI 执行用户手配的配置时使用。只操作项目级 `.run/` 文件,不碰 `.idea/workspace.xml`。',
].join('');

const SKILL_FILE = new URL('./ide-run-config-skill.md', import.meta.url);

/**
 * Read the skill document shipped next to this module.
 *
 * @returns {string}
 */
export function readRunConfigSkillContent() {
  return readFileSync(SKILL_FILE, 'utf8').trimEnd();
}

/**
 * Build the skill definition registered through `ctx.skill.transform`.
 *
 * `location` points at the shipped `.md` — the real skill document — so any
 * path-shaped validation is satisfied without inventing a virtual filename.
 *
 * @returns {{ id: string, name: string, description: string, location: string, content: string }}
 */
export function runConfigSkill() {
  return {
    id: RUN_CONFIG_SKILL_ID,
    name: 'idea-run-config',
    description: RUN_CONFIG_SKILL_DESCRIPTION,
    location: fileURLToPath(SKILL_FILE),
    content: readRunConfigSkillContent(),
  };
}
