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
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

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

/** Preferred launcher binary name per app, used when `Contents/MacOS` has several. */
const IDE_EXECUTABLES = {
  'IntelliJ IDEA': 'idea',
  PyCharm: 'pycharm',
  'PyCharm Community': 'pycharm',
  WebStorm: 'webstorm',
  GoLand: 'goland',
  CLion: 'clion',
  PhpStorm: 'phpstorm',
  RubyMine: 'rubymine',
  Rider: 'rider',
  DataGrip: 'datagrip',
  'Android Studio': 'studio',
};

/**
 * Absolute path to the IDE launcher binary (`<App>.app/Contents/MacOS/<bin>`).
 * The stdio bridge is started by running this binary with `stdioMcpServer`.
 *
 * Returns undefined when the app bundle cannot be found — the caller then falls
 * back to the remote transport.
 *
 * @param {string | undefined} app macOS app name, e.g. "IntelliJ IDEA"
 * @param {{ dirs?: string[] }} [options] search roots (defaults to the two
 *   standard Applications folders); tests pass their own.
 * @returns {string | undefined}
 */
export function resolveIdeExecutable(app, options = {}) {
  if (typeof app !== 'string' || app.length === 0) return undefined;
  const home = process.env.HOME;
  const dirs = options.dirs ?? [home ? path.join(home, 'Applications') : undefined, '/Applications'].filter(
    (value) => typeof value === 'string',
  );
  const preferred = IDE_EXECUTABLES[app];
  for (const dir of dirs) {
    const macos = path.join(dir, `${app}.app`, 'Contents', 'MacOS');
    let entries;
    try {
      entries = readdirSync(macos);
    } catch {
      continue;
    }
    const executable = (name) => {
      try {
        const stats = statSync(path.join(macos, name));
        return stats.isFile() && (stats.mode & 0o111) !== 0;
      } catch {
        return false;
      }
    };
    const chosen = (preferred && entries.includes(preferred) && preferred) || entries.find(executable);
    if (chosen) return path.join(macos, chosen);
  }
  return undefined;
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
