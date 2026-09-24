import { describe, expect, it } from 'vitest';
import { IDEA_PREFER_NOTE, PREFERRED_NATIVE_TOOLS, applyPreference } from './tool-descriptions.js';

function fakeEditor(tools) {
  const map = new Map(Object.entries(tools));
  return {
    map,
    update(id, update) {
      const tool = map.get(id);
      if (tool) update(tool);
    },
  };
}

describe('applyPreference', () => {
  it('prepends the note to every preferred native tool', () => {
    const editor = fakeEditor({
      edit: { description: 'edit-desc' },
      write: { description: 'write-desc' },
      patch: { description: 'patch-desc' },
      shell: { description: 'shell-desc' },
      read: { description: 'read-desc' },
    });

    applyPreference(editor);

    for (const id of PREFERRED_NATIVE_TOOLS) {
      expect(editor.map.get(id).description).toBe(IDEA_PREFER_NOTE + `${id}-desc`);
    }
    expect(editor.map.get('read').description).toBe('read-desc');
  });

  it('is idempotent', () => {
    const editor = fakeEditor({ edit: { description: 'edit-desc' } });
    applyPreference(editor);
    applyPreference(editor);
    expect(editor.map.get('edit').description).toBe(IDEA_PREFER_NOTE + 'edit-desc');
  });

  it('ignores missing tools and tools without a description', () => {
    const editor = fakeEditor({ edit: {} });
    expect(() => applyPreference(editor)).not.toThrow();
    expect(editor.map.get('edit').description).toBeUndefined();
  });
});
