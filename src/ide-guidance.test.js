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
  it('IDE 连上时包含 IDE 段和远端段，且没有未渲染的标记', () => {
    const text = buildGuidanceText(true);
    expect(text).toContain('ide_search_symbol');
    expect(text).toContain('ide_lint_files');
    expect(text).toContain('ide_deploy_remote_process');
    expect(text).toContain('remote_exec');
    expect(text).toContain('不要用 `sed` / `python` 改源码');
    expect(text).not.toContain('<!--');
  });

  it('IDE 断开时只保留远端段', () => {
    const text = buildGuidanceText(false);
    expect(text).toContain('remote_exec');
    expect(text).toContain('remote_upload');
    expect(text).not.toContain('ide_search_symbol');
    expect(text).not.toContain('ide_deploy_remote_process');
    expect(text).not.toContain('<!--');
  });
});

describe('注入与恢复提示', () => {
  it('appends the guidance once and is idempotent per request', () => {
    const system = [];
    appendGuidance(system, true);
    appendGuidance(system, true);
    expect(system).toHaveLength(1);
    expect(system[0].type).toBe('text');

    // IDE 断开时仍然注入（远端工具常驻），内容不同，所以会再 push 一条。
    appendGuidance(system, false);
    expect(system).toHaveLength(2);
    expect(system[1].text).toContain('remote_exec');
    expect(system[1].text).not.toContain('ide_search_symbol');

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
