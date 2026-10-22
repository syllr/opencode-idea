// IDE 工具的**输出**增强。
//
// 和 `idea-tool-defaults.js` 分开:那个管"调用前要传什么",这个管"回来以后怎么读"。
//
// `list_directory_tree` 的输出在到达 maxDepth 边界时会**静默停止** —— 没有 `…`、没有"已达深度上限",
// 一棵被截断的树和一个空目录在文本里长得一模一样。实测(2026-10):模型把 `maxDepth=6` 截断后的空包目录
// 读成"工具看不到",随后整条查询链退回 `shell` 里的 `find` / `grep` / `sed`。
//
// 参数侧(`RAISED_ARGUMENTS`)已经把下限抬到 50,这里再加一道**看得见**的提示:只要树的深度顶到了上限,
// 就在结果后面追加一句,让"被截断"和"真的空"不再同形。提示是追加的,不改原有内容。

/** `    ├── name` / `    │   └── name`:每一层固定占 4 个字符(空格或竖线)。 */
const TREE_ENTRY = /^([\s│]*)(?:├──|└──)\s/;

const LIST_DIRECTORY_TREE_SUFFIX = 'list_directory_tree';

/** 与 `RAISED_ARGUMENTS` 的下限一致:拿不到输入时按这个判断。 */
const DEFAULT_MAX_DEPTH = 50;

/**
 * @param {unknown} input
 * @returns {number}
 */
function readMaxDepth(input) {
  const raw = input !== null && typeof input === 'object' ? input.maxDepth : undefined;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_DEPTH;
}

/**
 * 从 MCP 的 text 里取出树本身;不是那个 JSON 就整段当树。
 *
 * @param {string} text
 * @returns {string}
 */
function treeText(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.tree === 'string') {
      return parsed.tree;
    }
  } catch {
    // 不是 JSON:按纯文本树处理
  }
  return text;
}

/**
 * 最深的条目在第几层(根目录下的直接子项是第 1 层)。
 *
 * @param {string} text
 * @returns {number}
 */
function deepestLevel(text) {
  let deepest = 0;
  for (const line of text.split('\n')) {
    const match = TREE_ENTRY.exec(line);
    if (!match) continue;
    const level = Math.floor(match[1].length / 4);
    if (level > deepest) deepest = level;
  }
  return deepest;
}

/**
 * 把一段提示接到结果的文本后面,不改原有内容。
 *
 * `Tool.Result.content` 允许 `string` 或 `Content[]`,两种都要覆盖。
 *
 * @param {{ content?: unknown }} result
 * @param {string} text
 * @returns {unknown} 新结果;格式不认识时返回 `undefined`。
 */
function appendText(result, text) {
  const content = result.content;
  if (typeof content === 'string') {
    return { ...result, content: `${content}\n\n${text}` };
  }
  if (Array.isArray(content)) {
    return { ...result, content: [...content, { type: 'text', text }] };
  }
  return undefined;
}

/**
 * 如果这棵目录树顶到了 `maxDepth` 的边界,追加一句截断提示。
 *
 * @param {unknown} result `Tool.Result`(只读,不改原对象)
 * @param {{ tool: string, input: unknown, prefixes: readonly string[] }} call
 * @returns {unknown} 新的 result;不该动时返回**原引用**,调用方据此跳过改写。
 */
export function appendDirectoryTreeTruncationNotice(result, { tool, input, prefixes }) {
  if (typeof tool !== 'string') return result;
  if (!prefixes.some((prefix) => tool === `${prefix}${LIST_DIRECTORY_TREE_SUFFIX}`)) return result;
  if (result === null || typeof result !== 'object') return result;

  const maxDepth = readMaxDepth(input);
  const content = result.content;
  const texts =
    typeof content === 'string'
      ? [content]
      : Array.isArray(content)
        ? content
            .filter((item) => item?.type === 'text' && typeof item.text === 'string')
            .map((item) => item.text)
        : [];
  if (texts.length === 0) return result;

  const deepest = Math.max(...texts.map((text) => deepestLevel(treeText(text))));
  if (deepest < maxDepth - 1) return result;

  const next = appendText(
    result,
    `注意:这棵树已经到达 maxDepth=${maxDepth} 的边界(最深渲染到第 ${deepest} 层),` +
      `更深的条目可能没有显示。要看完整内容就把 maxDepth 调大(例如 ${maxDepth * 2})重试,` +
      '或者把 directoryPath 直接指到目标子目录再看一层。',
  );
  return next ?? result;
}
