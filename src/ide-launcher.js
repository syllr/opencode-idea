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

/** 唯一的 IDE：IntelliJ IDEA。macOS 应用名。 */
export const DEFAULT_IDE_APP = 'IntelliJ IDEA';

/**
 * 自动拉起时的 macOS 应用名，`undefined` 表示"这个平台不能自动拉起"。
 *
 * @param {{ platform?: string }} [options]
 * @returns {string | undefined}
 */
export function ideAppName({ platform = process.platform } = {}) {
  if (platform !== 'darwin') return undefined;
  return DEFAULT_IDE_APP;
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
 * @param {{ spawnImpl?: typeof spawn }} [options]
 * @returns {Promise<boolean>}
 */
export function openInIde(directory, options = {}) {
  const app = DEFAULT_IDE_APP;
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
