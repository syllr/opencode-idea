// IDE 项目集合：一个 OpenCode 会话（root 项目）可以接入多个 JetBrains 项目 ——
// root 本身，加上 root 下任意层级的子目录；每个项目可以被**不同的** IDE 打开
// （root 用 IDEA、modelserver 用 PyCharm 是常态）。
//
// 这个模块只做纯数据：持久化标记的解析/序列化、工具前缀（= MCP server 名）的派生、
// 以及新增子项目前的校验。所有 I/O、探测、注册都留在 plugin.js，所以这里全部是
// 可以直接测的纯函数。
//
// ## 命名规则
//
// 工具前缀就是 MCP server 名，由项目的**层级**决定，与 IDE 产品无关：
//
//   * root  → `ide`        root 用 IDEA 还是 PyCharm，它都叫 `ide_*`
//   * 子项目 → 目录名       `modelserver` → `modelserver_*`
//
// 为什么不叫 `idea_*`：那会把"root 项目"和"IntelliJ IDEA 这个产品"绑死，而
// 「root 用 PyCharm 打开、子项目用 IDEA 打开」是完全合理的组合。
//
// ## 为什么前缀必须严格控制字符集
//
// 前缀会变成工具名的一部分（`modelserver_search_symbol`），模型要照着调。目录名
// 里但凡有空格、点、大写或非 ASCII，工具名就会变得难写、难赌 —— 跨平台还可能
// 产生"同名不同目录"。所以不规范的目录名**一律拒绝**（见 validateSubproject），
// 由用户改目录名，插件绝不自动改名或消歧。

import { basename, sep } from 'node:path';

/** root 项目的 MCP server 名。与 IDE 产品解耦，见文件头。 */
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
 * 内置服务是 63343)。既然"哪个 IDE 在哪个端口"是产品常量,插件就不需要"扫描候选端口
 * 找归属":探哪个端口由项目的 IDE 唯一决定,不经过任何用户配置。
 *
 * 导出成**可变对象**而不是冻结字面量:测试要把它们指到假端口上(见
 * `tests/plugin.test.js` 的 `fakeCtx`),运行时没有任何人写它。
 */
export const IDE_PORTS = {
  idea: 64342,
  pycharm: 64462,
};

/**
 * 子项目目录名（= 工具前缀）必须匹配的形状。
 *
 * 小写字母或数字开头，其后只允许小写字母、数字、`-`、`_`。上限 48 是硬约束之一
 * 的保守取值：工具名要在模型提示里反复出现，越短越好。
 */
export const SUBPROJECT_PREFIX = /^[a-z0-9][a-z0-9_-]{0,47}$/;

/** 持久化标记里存的版本号，用于将来识别旧结构。 */
export const MARK_VERSION = 2;

/**
 * @typedef {{ path: string, app: string }} IdeProject
 * @typedef {{ root: IdeProject, children: IdeProject[] }} IdeConfig
 */

/** 这个 root 的持久化标记 key。 */
export function markKeyFor(rootPath) {
  return `project/${rootPath}`;
}

/** @param {unknown} entry @returns {boolean} */
function isProjectEntry(entry) {
  return (
    entry !== null &&
    typeof entry === 'object' &&
    typeof (/** @type {IdeProject} */ (entry).path) === 'string' &&
    typeof (/** @type {IdeProject} */ (entry).app) === 'string'
  );
}

/**
 * 解析持久化的标记值。
 *
 * 兼容 v1：旧版本存的是布尔 `true`（只表示"root 已接入"，没有 IDE 与子项目信息），
 * 这里把它读成"root 用 idea 的 v1 配置"。任何无法识别的形状都当作**未配置**
 * （`undefined`），因为一个读不懂的配置比没有配置更危险。
 *
 * @param {unknown} raw 从 `ctx.storage` 读到的原始值
 * @param {string} rootPath
 * @returns {IdeConfig | undefined}
 */
export function parseMark(raw, rootPath) {
  if (raw === true) return { root: { path: rootPath, app: 'idea' }, children: [] };
  if (raw === null || typeof raw !== 'object') return undefined;
  const record = /** @type {{ root?: unknown, children?: unknown }} */ (raw);
  if (!isProjectEntry(record.root)) return undefined;
  const root = /** @type {IdeProject} */ (record.root);
  const children = Array.isArray(record.children)
    ? record.children.filter(isProjectEntry).map((entry) => {
        const child = /** @type {IdeProject} */ (entry);
        return { path: child.path, app: child.app };
      })
    : [];
  return { root: { path: root.path, app: root.app }, children };
}

/** @param {IdeConfig} config @returns {Record<string, unknown>} */
export function serializeMark(config) {
  return {
    version: MARK_VERSION,
    root: { path: config.root.path, app: config.root.app },
    children: config.children.map((child) => ({ path: child.path, app: child.app })),
  };
}

/**
 * 一个项目对应的 MCP server 名（= 工具前缀）。
 *
 * @param {string} path
 * @param {string} rootPath
 */
export function serverNameFor(path, rootPath) {
  return path === rootPath ? ROOT_SERVER_NAME : basename(path);
}

/**
 * 展开成"项目 + 前缀"的平铺列表，顺序固定：root 在最前，子项目按登记顺序。
 *
 * @param {IdeConfig} config
 * @returns {Array<{ path: string, app: string, server: string, isRoot: boolean }>}
 */
export function listProjects(config) {
  const root = {
    path: config.root.path,
    app: config.root.app,
    server: ROOT_SERVER_NAME,
    isRoot: true,
  };
  const children = config.children.map((child) => ({
    path: child.path,
    app: child.app,
    server: serverNameFor(child.path, config.root.path),
    isRoot: false,
  }));
  return [root, ...children];
}

/** 当前配置里所有项目的工具前缀（带下划线），例如 `["ide_", "modelserver_"]`。 */
export function toolPrefixes(config) {
  return listProjects(config).map((project) => `${project.server}_`);
}

/**
 * 校验：把 `absPath` 登记为 root 的子项目是否合法。
 *
 * 全部规则都是**拒绝**，不做任何自动修正 —— 与插件其它地方一致：静默改一个名字，
 * 等于把用户的目录和模型看到的工具名对不上，而且没人会发现。
 *
 * @param {IdeConfig} config
 * @param {string} absPath 待登记的绝对路径
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
export function validateSubproject(config, absPath) {
  const rootPath = config.root.path;
  const prefix = rootPath.endsWith(sep) ? rootPath : `${rootPath}${sep}`;
  if (!absPath.startsWith(prefix)) {
    return {
      ok: false,
      code: 'outside-root',
      message: `必须位于 root 项目（${rootPath}）之下`,
    };
  }
  const name = basename(absPath);
  if (!SUBPROJECT_PREFIX.test(name)) {
    return {
      ok: false,
      code: 'invalid-name',
      message: `目录名 \`${name}\` 不能作为工具前缀:要求 ^[a-z0-9][a-z0-9_-]{0,47}$,即以小写字母或数字开头,只含小写字母、数字、- 和 _`,
    };
  }
  if (name === ROOT_SERVER_NAME) {
    return {
      ok: false,
      code: 'reserved',
      message: `\`${ROOT_SERVER_NAME}\` 是 root 项目保留的工具前缀,请在别处使用这个目录名`,
    };
  }
  const existing = config.children.find((child) => child.path === absPath);
  if (existing) {
    return { ok: false, code: 'already-registered', message: `\`${name}\` 已经登记过了` };
  }
  const clash = config.children.find((child) => basename(child.path) === name);
  if (clash) {
    return {
      ok: false,
      code: 'duplicate-prefix',
      message: `工具前缀 \`${name}\` 已被 ${clash.path} 占用;两个子项目不能同名,请重命名其中一个目录`,
    };
  }
  return { ok: true };
}

/**
 * 加入一个子项目，返回新配置（不改入参）。
 *
 * @param {IdeConfig} config
 * @param {string} absPath
 * @param {string} app
 * @returns {IdeConfig}
 */
export function withSubproject(config, absPath, app) {
  return {
    root: { ...config.root },
    children: [...config.children.map((child) => ({ ...child })), { path: absPath, app }],
  };
}

/**
 * 从参数文本里切出子项目路径。
 *
 * 斜杠命令的参数是**整串**（`input.prompt.text`），不分词，所以这里自己切：
 * 取第一个空白分隔的片段。多给的部分是错的，宁可报错也不要猜。
 *
 * @param {unknown} text
 * @returns {{ ok: true, path: string } | { ok: false, message: string }}
 */
export function parseSubprojectArgument(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (raw === '') return { ok: false, message: '缺少子项目路径参数' };
  const parts = raw.split(/\s+/);
  if (parts.length > 1) {
    return {
      ok: false,
      message: `只接受一个参数(子项目路径),收到 ${parts.length} 个:\`${raw}\``,
    };
  }
  return { ok: true, path: parts[0] };
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
