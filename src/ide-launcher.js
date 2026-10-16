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
