import { describe, expect, it } from 'vitest';
import {
  MCP_RECOVERY_GUIDANCE,
  MCP_RECOVERY_GUIDANCE_MARKED,
  MCP_RECOVERY_GUIDANCE_RECONNECTING,
  appendGuidance,
  appendIdeRecoveryGuidance,
  buildGuidanceText,
} from './ide-guidance.js';

describe('引导的生成', () => {
  it('不会把内部标记漏进提示词', () => {
    expect(buildGuidanceText(true)).not.toContain('<!--');
    expect(buildGuidanceText(false)).not.toContain('<!--');
  });

  it('IDE 断开时不出现 IDE 工具', () => {
    // 契约是"别推荐此刻调不到的工具"，不是提示词里必须出现哪几个工具名。
    expect(buildGuidanceText(false)).not.toContain('ide_');
    expect(buildGuidanceText(true)).toContain('ide_');
  });
});

describe('注入与恢复提示', () => {
  it('appends the guidance once and is idempotent per request', () => {
    const system = [];
    appendGuidance(system, true);
    appendGuidance(system, true);
    expect(system).toHaveLength(1);
    expect(system[0].type).toBe('text');

    // IDE 断开时注入的是另一份内容，所以会再 push 一条。
    appendGuidance(system, false);
    expect(system).toHaveLength(2);

    // 没有 system 数组时什么都不做
    appendGuidance(undefined, true);
    appendIdeRecoveryGuidance(undefined, { marked: false, serving: true });
  });

  it('picks the recovery variant that matches the situation', () => {
    const system = [];
    appendIdeRecoveryGuidance(system, { marked: false, serving: true });
    expect(system[0].text).toBe(MCP_RECOVERY_GUIDANCE);

    appendIdeRecoveryGuidance(system, { marked: true, serving: true });
    expect(system[1].text).toBe(MCP_RECOVERY_GUIDANCE_MARKED);

    appendIdeRecoveryGuidance(system, { marked: true, serving: false });
    expect(system[2].text).toBe(MCP_RECOVERY_GUIDANCE_RECONNECTING);
  });
});
