import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSkillFrontmatter, readAutoinvoke, readSkill, readSkills, SKILL_FILE_NAME } from './loader.js';

const SKILL_IDS = ['idea-standalone', 'run-job-manager'];

describe('shipped skills', () => {
  it('loads every skill directory into a Skill.Info-shaped definition', () => {
    // 全部无条件注册 —— 没有「要不要 load 这个 skill」的判断(`requires:` 门禁早就删了)。
    // 所以形状必须**每次**都对:`Skill.Info` 的键是固定的
    // (`id` / `name` / `description` / `path` / `content`);多一个键或少一个键,
    // `ctx.skill.transform` 会抛 SchemaError,而**任何 transform 失败都会禁用整个插件**。
    const skillKeys = ['content', 'description', 'id', 'name', 'path'];
    for (const { skill } of readSkills()) {
      expect(Object.keys(skill).sort(), skill.id).toEqual(skillKeys);
      // `path` 必须是一个真实存在文件的绝对路径。
      expect(skill.path.startsWith('/'), skill.id).toBe(true);
      expect(skill.path.endsWith(SKILL_FILE_NAME), skill.id).toBe(true);
      expect(existsSync(skill.path), skill.id).toBe(true);
      // frontmatter 是元数据,绝不能漏进模型看到的正文里。
      expect(skill.content.startsWith('# '), skill.id).toBe(true);
    }
    expect(readSkills().map(({ skill }) => skill.id).sort()).toEqual([...SKILL_IDS].sort());
  });

  it('ships both skills model-invocable', () => {
    // 两个 skill 都让模型自己加载:manager 曾经是用户点名才可用的(autoinvoke: false),
    // 结果 guidance 里"建配置走这个 skill"变成了死路 —— 模型在可用列表里看不到它。
    for (const id of SKILL_IDS) {
      expect(readSkill(id).autoinvoke, id).toBeUndefined();
    }
  });

  it('flattens the nested autoinvoke block and rejects other values', () => {
    // 唯一还在的开关。刻意只支持一层嵌套:读取器是扁平的,所以缩进的那行必须自己落到
    // 带命名空间的键上,而裸的 `metadata:` 那行读出来是空的。这正是 OpenCode 文档里的形状。
    expect(
      parseSkillFrontmatter('---\nname: x\nmetadata:\n  opencode/autoinvoke: false\n---\nbody', 'x'),
    ).toEqual({ name: 'x', metadata: '', 'opencode/autoinvoke': 'false' });
    expect(readAutoinvoke({}, 'x')).toBeUndefined();
    expect(readAutoinvoke({ 'opencode/autoinvoke': 'true' }, 'x')).toBe(true);
    // 写错的值必须报错 —— 一个被静默忽略的开关,技能就仍然会被模型自动调用,
    // 而那正是这个开关要防的事。
    expect(() => readAutoinvoke({ 'opencode/autoinvoke': 'no' }, 'x')).toThrow(/true or false/);
  });

  it('reads quoted and bare values without a YAML engine', () => {
    expect(
      parseSkillFrontmatter('---\nname: acme\ndescription: "uses: colons, fine"\n---\nbody', 'x'),
    ).toEqual({ name: 'acme', description: 'uses: colons, fine' });
    expect(parseSkillFrontmatter("---\nname: 'acme'\n---\nbody", 'x')).toEqual({ name: 'acme' });
  });

  it('fails loudly when a SKILL.md has no usable metadata', () => {
    expect(() => parseSkillFrontmatter('# no frontmatter here', 'skills/x/SKILL.md')).toThrow(/frontmatter/);
    // `readSkill` 要求有 description:每个 shipped skill 都必须有,否则 OpenCode 根本不会
    // 把它提供给模型。
    expect(readSkills().every(({ skill }) => skill.description.length > 0)).toBe(true);
    expect(() => readSkill('idea-run-config')).toThrow();
  });
});
