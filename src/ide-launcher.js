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

/** Default macOS app name for IntelliJ IDEA. */
export const DEFAULT_IDE_APP = 'IntelliJ IDEA';

/** Aliases accepted by the `openInIde` option. */
export const IDE_APPS = {
  idea: 'IntelliJ IDEA',
  intellij: 'IntelliJ IDEA',
  'intellij-idea': 'IntelliJ IDEA',
};

/**
 * Resolve the `openInIde` option to a macOS app name, or `undefined` to disable.
 *
 * @param {boolean | string | undefined} value
 * @returns {string | undefined}
 */
export function resolveIdeApp(value) {
  if (value === false) return undefined;
  if (typeof value !== 'string') return DEFAULT_IDE_APP;
  return IDE_APPS[value.toLowerCase()] ?? value;
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
