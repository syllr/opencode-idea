import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  RUN_CONFIG_SKILL_DESCRIPTION,
  RUN_CONFIG_SKILL_ID,
  readRunConfigSkillContent,
  runConfigSkill,
} from './ide-run-config-skill.js';

const content = readRunConfigSkillContent();

describe('runConfigSkill', () => {
  it('identifies itself and points at the shipped skill document', () => {
    const skill = runConfigSkill();
    expect(skill.id).toBe(RUN_CONFIG_SKILL_ID);
    expect(skill.id).toBe('idea-run-config');
    expect(skill.name).toBe('idea-run-config');
    // `Skill.Info` requires `path` (an AbsolutePath). `location` is not a field:
    // it fails schema validation, and a transform failure disables the whole
    // plugin — command included.
    expect(skill.path).toMatch(/ide-run-config-skill\.md$/);
    expect(skill.path.startsWith('/')).toBe(true);
    // The shipped document must be readable from the installed package: a missing
    // `.md` (e.g. dropped from package.json `files`) throws at setup, and a setup
    // failure disables the plugin.
    expect(existsSync(skill.path)).toBe(true);
    expect(skill).not.toHaveProperty('location');
    expect(Object.keys(skill).sort()).toEqual(['content', 'description', 'id', 'name', 'path']);
    expect(skill.description).toBe(RUN_CONFIG_SKILL_DESCRIPTION);
    expect(skill.content).toBe(content);
    expect(skill.content.length).toBeGreaterThan(0);
    expect(skill.content).toContain('管理 JetBrains IDEA 的 run configuration');
  });

  it('teaches the project-level location and refuses workspace.xml', () => {
    expect(content).toContain('.run/');
    expect(content).toContain('ProjectRunConfigurationManager');
    expect(content).toContain('.idea/workspace.xml');
  });

  it('mandates a real example and a post-write verification', () => {
    expect(content).toContain('idea_search_file');
    expect(content).toContain('Store as project file');
    expect(content).toContain('idea_get_run_configurations');
    expect(content).toContain('idea_execute_run_configuration');
    expect(content).toContain('/open-in-idea');
  });

  it('keeps the type table explicitly non-authoritative', () => {
    expect(content).toContain('不是契约');
    expect(content).toContain('ShConfigurationType');
    expect(content).toContain('CompoundRunConfiguration');
  });

  it('writes to one location (.run) and refuses the IDE-owned .idea store', () => {
    expect(content).toContain('只有 `.run/`');
    expect(content).toContain('.idea/workspace.xml');
    expect(content).toContain('主人');
    expect(content).not.toContain('分诊');
  });
});
