// IDE 项目配置：一个 OpenCode 会话只对应**一个** JetBrains 项目，就是当前 workspace root，
// 而且只用 **IntelliJ IDEA**。
//
// 不再有「root + 子项目」：没有 children、没有按目录名生成的工具前缀，也没有父目录 /
// 子目录匹配的特殊逻辑。IDE 负责的项目必须和 workspace root 是同一个目录。
//
// 这个模块只做纯数据：持久化标记的解析 / 序列化。所有 I/O、探测、注册都留在 plugin.js，
// 所以这里全部是可以直接测的纯函数。

/** 唯一的 MCP server 名（= 工具前缀 `ide_`）。 */
export const ROOT_SERVER_NAME = 'ide';

/**
 * IntelliJ IDEA 内置 MCP server 的**起始端口**。
 *
 * **不是固定值**：IDEA 2026.3 起用户可以在 Settings → AI → MCP Server 自行改端口；即使
 * 没改，IDEA 启动时发现起始端口被占也会**静默向上漂移**（`findFirstFreePort`：从期望端口
 * 逐个 +1 找空闲的）。所以插件按下面的跨度从起点向上扫描，命中即用，扫不到就报错。
 *
 * 导出成**可变对象**而不是冻结字面量：测试要把它指到假端口上（见 `tests/plugin.test.js`
 * 的 `fakeCtx`），运行时没有任何人写它。
 */
export const IDE_PORTS = {
  idea: 64342,
};

/**
 * 扫描跨度：从 `IDE_PORTS.idea` 起最多探这么多个端口（含起点），即默认扫 64342~64361。
 *
 * 这个跨度覆盖 IDEA 自己 `findFirstFreePort` 的常见漂移量级（64342 被占后漂到 64343、
 * 64344 这种），又不会在“一个都没有”的机器上白撞几十个端口。
 */
export const IDEA_PORT_SCAN_SPAN = 20;

/** 持久化标记里存的版本号。旧版本格式一律不认，由用户重新 /open-in-ide。 */
export const MARK_VERSION = 4;

/**
 * @typedef {{ version: number }} IdeConfig
 */

/** 这个项目的持久化标记 key。 */
export function markKeyFor(rootPath) {
  return `project/${rootPath}`;
}

/**
 * 解析持久化的标记值。
 *
 * **只认当前格式** `{ version: 4 }`。旧格式（带 root / children / app 的那些）一律当
 * **未配置**，不写迁移代码——用户重新执行 `/open-in-ide` 即可。
 *
 * @param {unknown} raw 从 `ctx.storage` 读到的原始值
 * @returns {IdeConfig | undefined}
 */
export function parseMark(raw) {
  if (raw === null || typeof raw !== 'object') return undefined;
  const record = /** @type {{ version?: unknown }} */ (raw);
  if (record.version !== MARK_VERSION) return undefined;
  return {version: MARK_VERSION};
}

/** @returns {Record<string, unknown>} */
export function serializeMark() {
  return {version: MARK_VERSION};
}
