import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSkillFrontmatter, readSkill, readSkills, SKILL_FILE_NAME } from './loader.js';
import { HIDDEN_IDEA_TOOLS } from '../plugin.js';

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

  it('keeps the standalone skill teaching the four-part rule', () => {
    const content = readSkill('idea-standalone').content;
    expect(content).toContain('idea_get_run_configurations');
    expect(content).toContain('standalone');
    expect(content).toContain('热重载');
    // The skeleton lives in the template, so the skill's job is to point at it.
    expect(content).toContain('assets/AGENTS.template.md');
  });

  it('starts and stops apps through rerun/stop, never execute_run_configuration', () => {
    // `execute_run_configuration` runs the "Run" path: on a long-running config it
    // spawns a SECOND process instead of restarting the first. It belongs to
    // command/job configurations. Apps in standalone mode are the long-running
    // kind, so they go through rerun/stop.
    for (const source of [
      readSkill('idea-standalone').content,
      readFileSync(path.join(path.dirname(readSkill('idea-standalone').path), 'assets/AGENTS.template.md'), 'utf8'),
    ]) {
      expect(source).toContain('idea_rerun_run_configuration');
      expect(source).toContain('idea_stop_run_configuration');
      expect(source).toContain('idea_list_running_configurations');
      expect(source).toContain('**命令 / Job 类型**');
    }
    // And the prohibition must be stated, not just implied.
    expect(readSkill('idea-standalone').content).toContain('`idea_execute_run_configuration` 不用于');
  });

  it('restarts without asking, so the loop stays unattended', () => {
    // The point of routing restarts through the tool is that nobody has to be
    // there. A consent step would put a human back in the loop.
    for (const source of [
      readSkill('idea-standalone').content,
      readFileSync(path.join(path.dirname(readSkill('idea-standalone').path), 'assets/AGENTS.template.md'), 'utf8'),
    ]) {
      expect(source).toContain('重启不必先问');
      expect(source).toContain('无人化');
      expect(source).not.toContain('先取得用户明确授权');
      expect(source).not.toContain('取得明确授权');
      // The old blanket prohibition is gone, so nothing may still refer to it.
      expect(source).not.toContain('不得代为启停');
      expect(source).not.toContain('standalone 的禁令');
    }
  });

  it('writes into the project AGENTS.md as a marked block, not a rule file', () => {
    // Root AGENTS.md is what the AI reads for this project anyway, so the rule
    // needs no separate file and no always-apply switch. The markers are what
    // makes a later update detectable and keeps the skill off everything else
    // in that shared file.
    const content = readSkill('idea-standalone').content;
    expect(content).toContain('项目根 `AGENTS.md`');
    expect(content).toContain('<!-- idea-standalone:begin -->');
    expect(content).toContain('<!-- idea-standalone:end -->');
    expect(content).not.toContain('.opencode/rules/idea-standalone.md');
    expect(content).not.toContain('alwaysApply');
  });

  it('sends a missing run configuration to the user instead of authoring XML', () => {
    const content = readSkill('idea-standalone').content;
    expect(content).not.toContain('idea-run-config');
    expect(content).toContain('**交给用户**');
    expect(content).toContain('不要自己写 `.run/*.run.xml`');
  });

  it('ships the skeleton as a template the skill must read first', () => {
    const skill = readSkill('idea-standalone');
    // The loader documents the skill directory as the base for its own assets,
    // so resolve the template exactly the way a reader of the skill would.
    const template = readFileSync(path.join(path.dirname(skill.path), 'assets/AGENTS.template.md'), 'utf8');

    // Same wrapper the produced block uses, so a diff of the two is meaningful.
    expect(template.startsWith('<!-- idea-standalone:begin -->')).toBe(true);
    expect(template.trimEnd().endsWith('<!-- idea-standalone:end -->')).toBe(true);
    // Four parts, and the two headings the skill's name promises.
    for (const heading of ['### 一、', '### 二、', '### 三、', '### 四、']) {
      expect(template).toContain(heading);
    }
    // Per-section guidance lives in the template, not in the skill.
    expect(template).toContain('<!-- 生成提示:begin -->');
    // The produced file is read by AIs as rules, so the instructions for the
    // generating step must not survive into it.
    expect(template).toContain('产物里整块删掉');
    expect(readSkill('idea-standalone').content).toContain('产物里整块删掉');
    expect(template).toContain('idea_get_run_configurations');
    // The template carries metavariables; it also carries the rule that none of
    // them may survive into the produced block.
    expect(template).toContain('{...}');
    expect(template).toContain('不留进产物');
  });

  it('reads the configurations from the tool, not by walking .run/', () => {
    // `idea_get_run_configurations` called with no arguments answers exactly the
    // question this skill asks: the configurations the USER has already set up,
    // launch details included. Reading the `.run/*.run.xml` files one by one
    // would re-derive what that call already returns.
    const content = readSkill('idea-standalone').content;
    expect(content).toContain('直接调用,不传任何参数');
    expect(content).toContain('用户已经在 IDEA 里配好的那些');
    expect(content).toContain('不需要再去逐个翻 `.run/*.run.xml`');
  });

  it('references no tool that the plugin hides from the model', () => {
    // Hidden tools are stripped from every request, so a skill that names one is
    // telling the model to call something it cannot see.
    const content = readSkill('idea-standalone').content;
    for (const tool of HIDDEN_IDEA_TOOLS) {
      expect(content, `${tool} 已被隐藏`).not.toContain(tool);
    }
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
