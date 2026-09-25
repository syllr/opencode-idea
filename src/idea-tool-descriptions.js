// Adds concise, direct-call guidance to IDEA MCP tool descriptions.
//
// This transform only targets tools whose effective IDs belong to the IDEA MCP
// namespace. Native OpenCode tools are intentionally left untouched.

const IDEA_TOOL_PREFIX = /^(idea_|idea\.)/;
const IDEA_EDITING_TOOLS = new Set(['idea_apply_patch', 'idea_create_new_file']);

export const IDEA_DIRECT_NOTE =
  '【IDEA MCP】项目内操作请直接调用本工具;参数严格按当前工具 schema,不要猜测参数名。';

export const IDEA_EDIT_NOTE =
  '【IDEA MCP 编辑】项目内文件编辑请直接调用本工具;已有文件使用 idea_apply_patch,新文件使用 idea_create_new_file;不要用 shell 写项目文件。';

const isIdeaTool = (id) => typeof id === 'string' && IDEA_TOOL_PREFIX.test(id);

const noteFor = (id) => IDEA_EDITING_TOOLS.has(id) ? IDEA_EDIT_NOTE : IDEA_DIRECT_NOTE;

/**
 * Prepend direct-call guidance to IDEA MCP tool descriptions only.
 * The transform is idempotent and ignores missing descriptions.
 *
 * @param {{
 *   list: () => ReadonlyArray<{ id?: string }>,
 *   update: (id: string, update: (tool: { description?: string }) => void) => void,
 * }} editor
 */
export function applyIdeaToolGuidance(editor) {
  for (const tool of editor.list()) {
    const id = tool?.id;
    if (!isIdeaTool(id)) continue;
    editor.update(id, (draft) => {
      if (typeof draft.description !== 'string') return;
      const note = noteFor(id);
      if (draft.description.startsWith(note)) return;
      draft.description = note + draft.description;
    });
  }
}
