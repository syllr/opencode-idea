// Launching the JetBrains IDE for a project.
//
// RE-ENTRANCY: the Toolbox CLI scripts in /usr/local/bin (`idea`, `webstorm`,
// ...) run `open -na "<app>" --args <dir>` — `-n` forces a NEW IDE instance, so
// repeated calls spawn duplicates. We instead run `open -a "<app>" <dir>`,
// which hands the directory to an already-running instance (macOS "open
// documents" event) and only launches the app when none is running. Verified on
// macOS: `open -a "IntelliJ IDEA"` while IDEA is up leaves the process count
// unchanged.
//
// The caller performs the MCP availability check and fast-fails when it is
// unavailable; this module only requests opening/activating the project.

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 兜底 macOS 应用名：调用方没给 app 时用它。 */
export const DEFAULT_IDE_APP = 'IntelliJ IDEA';

/**
 * 每个 IDE 选项值对应的 macOS 应用名。
 *
 * 只包含受支持的 IDE（见 `ide-projects.js` 的 `SUPPORTED_IDES`）—— 应用名由项目
 * 配置决定，不再由用户在 `openInIde` 里自由指定，所以这里是一张封闭的表。
 */
export const IDE_APPS = {
  idea: 'IntelliJ IDEA',
  pycharm: 'PyCharm',
};

/**
 * 该 IDE 的 macOS 应用名，`undefined` 表示"不能自动拉起"。
 *
 * `undefined` 有两种原因，调用方用 `autoLaunchSupported()` 区分：这个平台没有
 * 启动器，或这个 IDE 不在支持列表里。两者给用户的建议不同，不能混为一谈。
 *
 * @param {string} app
 * @param {{ platform?: string }} [options]
 * @returns {string | undefined}
 */
export function appNameFor(app, { platform = process.platform } = {}) {
  if (platform !== 'darwin') return undefined;
  return IDE_APPS[app];
}

/**
 * 各平台上看"装了哪些 IDE"的目录。
 *
 * macOS 那两个位置是**实测**的（这台机器上就是这么装的）；Windows / Linux 列的是各自最
 * 常见的安装位置（Toolbox 默认 + 系统级目录），**未在真机上验证过** —— 探错的后果只是少一
 * 行提示、让模型照常问用户，不会挡住任何选择，所以先按常见值给出来。
 */
function ideInstallDirs(platform = process.platform) {
  const home = homedir();
  if (platform === 'darwin') return ['/Applications', join(home, 'Applications')];
  if (platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    return [
      join(local, 'Programs', 'JetBrains'),
      join(local, 'JetBrains', 'Toolbox', 'apps'),
      'C:\\Program Files\\JetBrains',
    ];
  }
  return [join(home, '.local', 'share', 'JetBrains', 'Toolbox', 'apps'), '/opt', '/usr/local'];
}

/**
 * 本机装了哪些受支持的 IDE（`IDE_APPS` 的键）。
 *
 * 按**安装目录**判断，不看进程 —— 用 `ps aux` 之类探进程只能发现"正在运行"的 IDE，装了
 * 但没打开就会漏（实测踩过：PyCharm 明明装着，进程探测报"未发现"）。一次目录读取就够，
 * 比模型自己去跑命令快几个数量级。
 *
 * 返回空数组表示"**没探测出来**"，不能当成"没装"：调用方要么照常问用户，要么在提示里说明
 * 是"没找到"。
 *
 * @param {{ platform?: string, dirs?: string[] }} [options] 仅供测试注入。
 * @returns {string[]}
 */
export function detectInstalledIdes(options = {}) {
  const platform = options.platform ?? process.platform;
  const dirs = options.dirs ?? ideInstallDirs(platform);
  /** @type {Set<string>} */
  const found = new Set();
  for (const dir of dirs) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      // 目录不存在（例如没有 ~/Applications）就是没装，继续看下一个。
      continue;
    }
    for (const entry of entries) {
      const bundle = entry.endsWith('.app') ? entry.slice(0, -'.app'.length) : entry;
      for (const [app, label] of Object.entries(IDE_APPS)) {
        // `IntelliJ IDEA.app` 精确匹配；`PyCharm CE.app`、`PyCharm 2026.2`、Toolbox 的
        // `PyCharm` 目录都是产品名开头，按前缀匹配。
        if (bundle === label || bundle.startsWith(label)) found.add(app);
      }
    }
  }
  return [...found];
}

/**
 * 这个平台有没有自动拉起 IDE 的能力？
 *
 * 只有 macOS 实现了启动（`open -a`）。Windows 上没有 `open` 命令，spawn 会以
 * ENOENT 失败——表现为一个静默 resolve 成 `false` 的 promise。与其假装能启动，
 * 不如让调用方直接告诉用户手动打开 IDE。
 *
 * 写成函数而不是常量：答案在命令真正执行时读取，测试才能用替换它的方式模拟
 * 其它平台；常量会在 import 时定死，之后再也不重读。
 */
export function autoLaunchSupported() {
  return process.platform === 'darwin';
}

/**
 * Open `directory` in the IDE, reusing a running instance when possible.
 * Never throws; resolves `true` when `open` reported success.
 *
 * @param {string} directory
 * @param {{ app?: string, spawnImpl?: typeof spawn }} [options]
 * @returns {Promise<boolean>}
 */
export function openInIde(directory, options = {}) {
  const app = options.app || DEFAULT_IDE_APP;
  const spawnImpl = options.spawnImpl || spawn;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl('open', ['-a', app, directory], { stdio: 'ignore' });
    } catch {
      resolve(false);
      return;
    }
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
  });
}

/**
 * Per-directory launch guard. Prevents a cold IDE (indexing / waiting for the
 * Trust dialog) from being spawned repeatedly by overlapping reconciles or
 * command invocations.
 *
 * @param {{ cooldownMs?: number, maxAttempts?: number, now?: () => number }} [options]
 */
export function createLaunchGuard(options = {}) {
  const cooldownMs = options.cooldownMs ?? 120000;
  const maxAttempts = options.maxAttempts ?? 5;
  const now = options.now ?? Date.now;
  let lastSpawnAt = 0;
  let attempts = 0;
  const coolingDown = () => attempts > 0 && now() - lastSpawnAt < cooldownMs;
  return {
    /** True once the attempt budget is spent; callers should stop retrying. */
    exhausted: () => attempts >= maxAttempts,
    /** True while a recent spawn is still expected to come up. */
    coolingDown,
    /** True when it is safe to spawn a new instance now. */
    canSpawn: () => attempts < maxAttempts && !coolingDown(),
    /** Record a spawn attempt. */
    markSpawn() {
      lastSpawnAt = now();
      attempts += 1;
    },
    /** Clear the guard after the IDE is confirmed serving. */
    reset() {
      lastSpawnAt = 0;
      attempts = 0;
    },
    /** Current state, for diagnostics/tests. */
    state: () => ({ lastSpawnAt, attempts }),
  };
}
