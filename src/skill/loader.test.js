import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSkillFrontmatter, readSkill, readSkills, SKILL_FILE_NAME } from './loader.js';

describe('shipped skills', () => {
  it('loads every skill directory into a Skill.Info-shaped definition', () => {
    const skills = readSkills();
    expect(skills.map((skill) => skill.id)).toEqual(['idea-standalone']);

    const skill = readSkill('idea-standalone');
    // `Skill.Info` requires exactly these keys (see @opencode/schema/skill):
    // `id` / `name` / `description?` / `autoinvoke?` / `path` / `content`.
    expect(Object.keys(skill).sort()).toEqual(['content', 'description', 'id', 'name', 'path']);
    expect(skill.name).toBe('idea-standalone');

    // `path` must be an absolute path to a file that really ships.
    expect(skill.path.startsWith('/')).toBe(true);
    expect(skill.path.endsWith(SKILL_FILE_NAME)).toBe(true);
    expect(existsSync(skill.path)).toBe(true);

    // The frontmatter is metadata: it must never leak into the model prompt.
    expect(skill.content.startsWith('# ')).toBe(true);
    expect(skill.content.startsWith('---')).toBe(false);
  });

  it('ships no skill about authoring run configurations', () => {
    // `idea-run-config` was removed deliberately: the IDE plugin owns Shell
    // creation, editing and deleting were always tool-less, and teaching the
    // model to hand-write `.run/*.run.xml` was the fragile half (a wrong `type`
    // makes the IDE ignore the whole file, silently). Anything that needs a
    // configuration the agent cannot create now goes to the user.
    expect(readSkills().map((skill) => skill.id)).not.toContain('idea-run-config');
    expect(() => readSkill('idea-run-config')).toThrow();
  });

  it('sends a missing run configuration to the user instead of authoring XML', () => {
    const content = readSkill('idea-standalone').content;
    expect(content).not.toContain('idea-run-config');
    expect(content).toContain('缺配置就交给用户');
    expect(content).toContain('不要自己写 `.run/*.run.xml`');
  });

  it('keeps the standalone skill teaching the four-part rule', () => {
    const content = readSkill('idea-standalone').content;
    // The rule the skill authors is only useful if it pins all four parts.
    expect(content).toContain('.opencode/rules/idea-standalone.md');
    expect(content).toContain('idea_get_run_configurations');
    expect(content).toContain('idea_execute_run_configuration');
    expect(content).toContain('热重载');
    expect(content).toContain('第四段');
    expect(content).toContain('alwaysApply');
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
