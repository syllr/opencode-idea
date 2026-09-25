import { describe, expect, it } from 'vitest';
import {
  IDEA_DIRECT_NOTE,
  IDEA_EDIT_NOTE,
  applyIdeaToolGuidance,
} from './idea-tool-descriptions.js';

function fakeEditor(tools) {
  const map = new Map(Object.entries(tools));
  return {
    map,
    list: () => [...map.values()],
    update(id, update) {
      const tool = map.get(id);
      if (tool) update(tool);
    },
  };
}

describe('applyIdeaToolGuidance', () => {
  it('updates IDEA MCP descriptions without touching native tools', () => {
    const editor = fakeEditor({
      edit: { id: 'edit', description: 'native-edit' },
      write: { id: 'write', description: 'native-write' },
      shell: { id: 'shell', description: 'native-shell' },
      idea_search_text: { id: 'idea_search_text', description: 'search' },
      idea_apply_patch: { id: 'idea_apply_patch', description: 'patch' },
      idea_create_new_file: { id: 'idea_create_new_file', description: 'create' },
    });

    applyIdeaToolGuidance(editor);

    expect(editor.map.get('idea_search_text').description).toBe(IDEA_DIRECT_NOTE + 'search');
    expect(editor.map.get('idea_apply_patch').description).toBe(IDEA_EDIT_NOTE + 'patch');
    expect(editor.map.get('idea_create_new_file').description).toBe(IDEA_EDIT_NOTE + 'create');
    expect(editor.map.get('edit').description).toBe('native-edit');
    expect(editor.map.get('write').description).toBe('native-write');
    expect(editor.map.get('shell').description).toBe('native-shell');
  });

  it('is idempotent and ignores missing descriptions', () => {
    const editor = fakeEditor({
      idea_read_file: { id: 'idea_read_file', description: 'read' },
      idea_lint_files: { id: 'idea_lint_files' },
    });

    applyIdeaToolGuidance(editor);
    applyIdeaToolGuidance(editor);

    expect(editor.map.get('idea_read_file').description).toBe(IDEA_DIRECT_NOTE + 'read');
    expect(editor.map.get('idea_lint_files').description).toBeUndefined();
  });
});
