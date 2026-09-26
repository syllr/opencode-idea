import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSkillFrontmatter, readSkill, readSkills, SKILL_FILE_NAME } from './loader.js';

describe('shipped skills', () => {
  it('loads every skill directory into a Skill.Info-shaped definition', () => {
    const skills = readSkills();
    expect(skills.map((skill) => skill.id)).toContain('idea-run-config');

    const skill = readSkill('idea-run-config');
    // `Skill.Info` requires exactly these keys (see @opencode/schema/skill):
    // `id` / `name` / `description?` / `autoinvoke?` / `path` / `content`.
    expect(Object.keys(skill).sort()).toEqual(['content', 'description', 'id', 'name', 'path']);
    expect(skill.name).toBe('idea-run-config');
    expect(skill.description).toContain('run configuration');

    // `path` must be an absolute path to a file that really ships.
    expect(skill.path.startsWith('/')).toBe(true);
    expect(skill.path.endsWith(SKILL_FILE_NAME)).toBe(true);
    expect(existsSync(skill.path)).toBe(true);

    // The frontmatter is metadata: it must never leak into the model prompt.
    expect(skill.content.startsWith('# ')).toBe(true);
    expect(skill.content.startsWith('---')).toBe(false);
  });

  it('keeps the run-config skill teaching the .run/ workflow', () => {
    const content = readSkill('idea-run-config').content;
    expect(content).toContain('只有 `.run/`');
    expect(content).toContain('ProjectRunConfigurationManager');
    expect(content).toContain('.idea/workspace.xml');
    expect(content).toContain('idea_search_file');
    expect(content).toContain('Store as project file');
    expect(content).toContain('idea_get_run_configurations');
    expect(content).toContain('idea_execute_run_configuration');
    expect(content).toContain('/open-in-idea');
    expect(content).toContain('EXECUTE_IN_TERMINAL');
    expect(content).toContain('不是契约');
    expect(content).toContain('ShConfigurationType');
    expect(content).toContain('CompoundRunConfiguration');
    expect(content).toContain('只做项目级配置');
  });

  it('fails loudly when a SKILL.md has no usable metadata', () => {
    expect(() => parseSkillFrontmatter('# no frontmatter here', 'skills/x/SKILL.md')).toThrow(/frontmatter/);
    // `readSkill` is what requires a description; every shipped skill must have
    // one, otherwise OpenCode never offers it to the model.
    expect(readSkills().every((skill) => skill.description.length > 0)).toBe(true);
  });

  it('reads quoted and bare values without a YAML engine', () => {
    expect(
      parseSkillFrontmatter('---\nname: acme\ndescription: "uses: colons, fine"\n---\nbody', 'x'),
    ).toEqual({ name: 'acme', description: 'uses: colons, fine' });
    expect(parseSkillFrontmatter("---\nname: 'acme'\n---\nbody", 'x')).toEqual({ name: 'acme' });
  });
});
