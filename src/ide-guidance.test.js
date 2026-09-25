import { describe, expect, it } from 'vitest';
import {
  IDE_GUIDANCE,
  MCP_RECOVERY_GUIDANCE,
  appendIdeGuidance,
  appendIdeRecoveryGuidance,
} from './ide-guidance.js';

describe('IDE_GUIDANCE', () => {
  it('states the direct-call default and key IDEA tools', () => {
    expect(IDE_GUIDANCE).toContain('直接调用');
    expect(IDE_GUIDANCE).toContain('idea_search_text');
    expect(IDE_GUIDANCE).toContain('idea_apply_patch');
    expect(IDE_GUIDANCE).toContain('idea_create_new_file');
    expect(IDE_GUIDANCE).toContain('pathInProject');
    expect(IDE_GUIDANCE).toContain('q');
  });

  it('contains the fast-fail recovery rule', () => {
    expect(IDE_GUIDANCE).toContain('/open-in-idea');
    expect(MCP_RECOVERY_GUIDANCE).toContain('stop retrying immediately');
  });
});

describe('appendIdeGuidance', () => {
  it('pushes one text part onto the system array', () => {
    const system = [];
    appendIdeGuidance(system);
    expect(system).toEqual([{ type: 'text', text: IDE_GUIDANCE }]);
  });

  it('is idempotent and safe for non-arrays', () => {
    const system = [];
    appendIdeGuidance(system);
    appendIdeGuidance(system);
    expect(system).toHaveLength(1);
    expect(() => appendIdeGuidance(undefined)).not.toThrow();
  });
});

describe('appendIdeRecoveryGuidance', () => {
  it('adds the fast-fail recovery instruction once', () => {
    const system = [];
    appendIdeRecoveryGuidance(system);
    appendIdeRecoveryGuidance(system);
    expect(system).toEqual([{ type: 'text', text: MCP_RECOVERY_GUIDANCE }]);
  });
});
