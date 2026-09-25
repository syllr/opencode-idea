import { describe, expect, it } from 'vitest';
import { IDE_GUIDANCE, appendIdeGuidance } from './ide-guidance.js';

describe('IDE_GUIDANCE', () => {
  it('states the firm default and lists key tools', () => {
    expect(IDE_GUIDANCE).toContain('默认走 IDE MCP');
    for (const tool of [
      'idea_search_text',
      'idea_read_file',
      'idea_apply_patch',
      'idea_create_new_file',
      'idea_lint_files',
      'idea_git_status',
    ]) {
      expect(IDE_GUIDANCE).toContain(tool);
    }
  });

  it('documents Code Mode dotted names and key parameter names', () => {
    expect(IDE_GUIDANCE).toContain('idea.search_text');
    // Parameter names that fail loudly if omitted, so they must be stated.
    expect(IDE_GUIDANCE).toContain('`q`');
    expect(IDE_GUIDANCE).toContain('file_path');
    expect(IDE_GUIDANCE).toContain('pathInProject');
  });
});

describe('appendIdeGuidance', () => {
  it('pushes one text part onto the system array', () => {
    const system = [];
    appendIdeGuidance(system);
    expect(system).toEqual([{ type: 'text', text: IDE_GUIDANCE }]);
  });

  it('is idempotent per request', () => {
    const system = [];
    appendIdeGuidance(system);
    appendIdeGuidance(system);
    expect(system).toHaveLength(1);
  });

  it('is a no-op on a non-array', () => {
    expect(() => appendIdeGuidance(undefined)).not.toThrow();
  });
});
