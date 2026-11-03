// IDE 项目配置：一个 OpenCode 会话只对应**一个** JetBrains 项目，就是当前 workspace root。
//
// 不再有「root + 子项目」：没有 children、没有按目录名生成的工具前缀，也没有
// 父目录 / 子目录匹配的特殊逻辑。IDE 负责的项目必须和 workspace root 是同一个目录。
//
// 这个模块只做纯数据：持久化标记的解析/序列化、命令参数解析。所有 I/O、探测、注册
// 都留在 plugin.js，所以这里全部是可以直接测的纯函数。

/** 唯一的 MCP server 名（= 工具前缀 `ide_`）。 */
export const ROOT_SERVER_NAME = 'ide';

/** `ctx.options.ides` 允许的取值；未知值会被忽略。 */
export const SUPPORTED_IDES = ['idea', 'pycharm'];

/** 每个 IDE 选项值对应的显示名（提示词里写给模型看）。 */
export const IDE_LABELS = {
  idea: 'IntelliJ IDEA',
  pycharm: 'PyCharm',
};

/**
 * 每个 IDE 的 MCP 端口。
 *
 * **固定值,不开放配置**:JetBrains 给内置 MCP server 分配的就是这个端口,跨版本、
 * 跨项目都不变(IDEA 的 MCP 在 64342,它的内置服务是 63342;PyCharm 的 MCP 在 64462,
 * 内置服务是 63343)。
 *
 * 导出成**可变对象**而不是冻结字面量:测试要把它们指到假端口上(见
 * `tests/plugin.test.js` 的 `fakeCtx`),运行时没有任何人写它。
 */
export const IDE_PORTS = {
  idea: 64342,
  pycharm: 64462,
};

/** 持久化标记里存的版本号。旧版本格式一律不认，由用户重新 /open-in-ide。 */
export const MARK_VERSION = 3;

/** @typedef {{ path: string, app: string }} IdeConfig */

/** 这个项目的持久化标记 key。 */
export function markKeyFor(rootPath) {
  return `project/${rootPath}`;
}

/**
 * 解析持久化的标记值。
 *
 * **只认当前格式** `{ version: 3, path, app }`。旧的 `{ root, children }` 或布尔 `true`
 * 一律当**未配置**，不写迁移代码 —— 用户重新执行 `/open-in-ide` 即可。
 *
 * @param {unknown} raw 从 `ctx.storage` 读到的原始值
 * @param {string} rootPath
 * @returns {IdeConfig | undefined}
 */
export function parseMark(raw, rootPath) {
  if (raw === null || typeof raw !== 'object') return undefined;
  const record = /** @type {{ version?: unknown, path?: unknown, app?: unknown }} */ (raw);
  if (record.version !== MARK_VERSION) return undefined;
  if (typeof record.path !== 'string' || record.path !== rootPath) return undefined;
  if (typeof record.app !== 'string' || !SUPPORTED_IDES.includes(record.app)) return undefined;
  return { path: record.path, app: record.app };
}

/** @param {IdeConfig} config @returns {Record<string, unknown>} */
export function serializeMark(config) {
  return {
    version: MARK_VERSION,
    path: config.path,
    app: config.app,
  };
}

/**
 * 从参数文本里切出 IDE 名。
 *
 * `/open-in-ide pycharm` 是"AI 不配合时的直通逃生口"：正常流程由 AI 向用户提问后
 * 调工具写回，带参只是保险。空串表示"没给"，由调用方决定是提问还是用默认值。
 *
 * @param {unknown} text
 * @returns {{ ok: true, app: string | undefined } | { ok: false, message: string }}
 */
export function parseIdeArgument(text) {
  const raw = typeof text === 'string' ? text.trim().toLowerCase() : '';
  if (raw === '') return { ok: true, app: undefined };
  if (!SUPPORTED_IDES.includes(raw)) {
    return { ok: false, message: `不支持的 IDE \`${raw}\`,可选:${SUPPORTED_IDES.join(' / ')}` };
  }
  return { ok: true, app: raw };
}
