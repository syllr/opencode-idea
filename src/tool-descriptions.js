// Rewrites native OpenCode tool descriptions so the model prefers the
// JetBrains IDE MCP tools when they are available.
//
// This is the "soft preference" layer: it never blocks the native tools, it
// only nudges the model at the moment it picks a tool (the descriptions are
// what the model reads when choosing). When the plugin deactivates, the
// transform registration is disposed and the registry rebuilds with the
// original descriptions.

export const IDEA_PREFER_NOTE =
  '优先:当 JetBrains IDE(IntelliJ IDEA / PyCharm / WebStorm 等)的 MCP 工具可用时,' +
  '请改用 IDE 的对应工具来完成本操作——它对项目结构、索引、引用和构建的理解更强。' +
  '仅当 IDE MCP 不可用时,才使用本工具。\n\n';

/** Native tools that should defer to the IDE when it is available. */
export const PREFERRED_NATIVE_TOOLS = ['edit', 'write', 'patch', 'shell'];

/**
 * Apply the preference note to every registered native tool.
 * Safe on missing ids (ignored) and idempotent.
 *
 * @param {{
 *   update: (id: string, update: (tool: { description?: string }) => void) => void
 * }} editor
 */
export function applyPreference(editor) {
  for (const id of PREFERRED_NATIVE_TOOLS) {
    editor.update(id, (tool) => {
      if (typeof tool.description !== 'string') return;
      if (tool.description.startsWith(IDEA_PREFER_NOTE)) return;
      tool.description = IDEA_PREFER_NOTE + tool.description;
    });
  }
}
