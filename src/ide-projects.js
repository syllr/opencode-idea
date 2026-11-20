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

/** 持久化标记里存的版本号。旧格式在读取时会被静默迁移成本格式（见 `parseMark`）。 */
export const MARK_VERSION = 4;

/**
 * @typedef {{ version: number }} IdeConfig
 */

/** 这个项目的持久化标记 key。 */
export function markKeyFor(rootPath) {
  return `project/${rootPath}`;
}

/**
 * **严格**解析：只认当前格式 `{ version: 4 }`。
 *
 * 返回 `undefined` 表示「按当前版本解析不出来」。读取侧据此判断存的值是否健康：
 * **值存在**但这里解析不出来（旧版的布尔 `true`、带 root/children/app 的旧对象、
 * 或任何坏数据）就说明这个 value 有问题，应覆写成当前格式（见 `plugin.js` 的
 * `readConfig`）。
 *
 * 判据只有这一处：将来标记格式再变，也只需要改这里，不会出现「宽松认了但没迁移」
 * 这种两套逻辑对不上的情况。
 *
 * @param {unknown} raw
 */
export function parseCurrentMark(raw) {
  if (raw === null || typeof raw !== 'object') return undefined;
  const record = /** @type {{ version?: unknown }} */ (raw);
  if (record.version !== MARK_VERSION) return undefined;
  return {version: MARK_VERSION};
}

/**
 * 宽松结论：**有值即认**。`null` / `undefined` 才是「未配置」。
 *
 * 标记表达的只是「这个项目接入过 IDE」这一个事实，格式只是载体。所以哪怕值按
 * 当前格式解析不出来（旧格式/坏数据），它也仍然是一个「已接入」的标记 —— 只值
 * 得被迁移（`plugin.js` 的 `readConfig` 负责覆写），不值得被当成未配置。
 *
 * @param {unknown} raw 从 `ctx.storage` 读到的原始值
 * @returns {IdeConfig | undefined}
 */
export function parseMark(raw) {
  if (raw === null || raw === undefined) return undefined;
  return {version: MARK_VERSION};
}

/** @returns {Record<string, unknown>} */
export function serializeMark() {
  return {version: MARK_VERSION};
}
