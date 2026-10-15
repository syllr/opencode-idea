import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSkillFrontmatter, readSkill, readSkills, SKILL_FILE_NAME } from './loader.js';
import { HIDDEN_IDEA_TOOLS } from '../plugin.js';

const TEMPLATE = path.join(path.dirname(readSkill('idea-standalone').path), 'assets/AGENTS.template.md');

/** Read the skeleton the skill must consult before writing anything. */
const readTemplate = () => readFileSync(TEMPLATE, 'utf8');

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
    // Exactly one tool runs these apps. Start vs restart is not a distinction the
    // model should have to make — rerun covers both, so the rule says so once.
    expect(readTemplate()).toContain('**跑应用只用 `idea_rerun_run_configuration`**');
    expect(readTemplate()).toContain('不必分辨"这是启动还是重启"');
    expect(readTemplate()).toContain('**命令 / Job 类型**');
    // Nothing else is offered as a way to run or stop them here.
    expect(readTemplate()).not.toContain('idea_stop_run_configuration');
    expect(readTemplate()).not.toContain('idea_list_running_configurations');
    // And the prohibition must be stated, not just implied.
    expect(readTemplate()).toContain('不要用 `idea_execute_run_configuration` 跑这些应用');
  });

  it('pins the entry point, not the shape, of how an app runs', () => {
    // A run configuration may start a local process, a container, or deploy to a
    // remote host. The discipline is about the ONE entry point, so claiming the
    // app must run as a local process would be both wrong and restrictive.
    const template = readTemplate();
    expect(template).toContain('**standalone = 启动收口只有 IDEA run configuration**');
    expect(template).toContain('入口唯一');
    expect(template).toContain('形态不限');
    expect(template).toContain('容器');
    expect(template).toContain('部署到远端');
    for (const absolute of ['本机进程直跑', '不容器化', '不部署到远端']) {
      expect(template, absolute).not.toContain(absolute);
    }
  });

  it('gives the app table a pre-start flow column', () => {
    // Some configurations assume something was done first (deps installed, built,
    // a dependency service up). That something is usually not itself a run
    // configuration, so the only place to say it is prose in this column.
    const template = readTemplate();
    expect(template).toContain('| 应用 | run configuration | 目录 | 端口 | 启动前流程 | 说明 |');
    expect(template).toContain('**启动前流程**列');
    // Usually empty, and ordered steps when not.
    expect(template).toContain('多数应用留空');
    expect(template).toContain('按顺序写清第 1 步、第 2 步、第 3 步');
  });

  it('restarts without asking, so the loop stays unattended', () => {
    // The point of routing restarts through the tool is that nobody has to be
    // there. A consent step would put a human back in the loop.
    for (const source of [readSkill('idea-standalone').content, readTemplate()]) {
      expect(source).not.toContain('先取得用户明确授权');
      expect(source).not.toContain('取得明确授权');
      // The old blanket prohibition is gone, so nothing may still refer to it.
      expect(source).not.toContain('不得代为启停');
      expect(source).not.toContain('standalone 的禁令');
    }
    expect(readTemplate()).toContain('重启不必先问');
    expect(readTemplate()).toContain('无人化');
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

    // Every heading is one level, and the four parts are numbered in order. Both
    // halves matter: a lost section is invisible otherwise, and a level slip
    // silently changes how the block nests inside the host AGENTS.md.
    const headings = template.split('\n').filter((line) => /^#{1,6} /.test(line));
    expect(headings).toEqual([
      '# Standalone 模式纪律',
      '## 一、什么是 standalone 模式',
      '## 二、standalone 下启动哪些应用(必须经 IDEA run configuration)',
      '## 三、热重载矩阵:改代码后要不要提醒重启',
    ]);

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
