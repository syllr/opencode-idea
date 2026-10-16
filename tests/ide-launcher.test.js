// Unit tests for the IDE launcher: re-entrant `open -a` invocation and the
// per-directory launch guard.

import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appNameFor, createLaunchGuard, detectInstalledIdes, openInIde } from '../src/ide-launcher.js';

/** A spawn stub that records calls and closes with `code`. */
function fakeSpawn(code = 0) {
  const calls = [];
  const impl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('close', code));
    return child;
  };
  return { impl, calls };
}

describe('appNameFor', () => {
  it('maps each supported IDE to its macOS app name', () => {
    expect(appNameFor('idea')).toBe('IntelliJ IDEA');
    expect(appNameFor('pycharm')).toBe('PyCharm');
  });

  it('has no app for an IDE it does not support', () => {
    expect(appNameFor('vscode')).toBeUndefined();
    expect(appNameFor('')).toBeUndefined();
  });

  it('resolves no app on platforms without a launcher', () => {
    // Only macOS `open -a` is implemented. Elsewhere a spawn of `open` fails
    // with ENOENT, so no app is resolved and the user is asked to open the IDE
    // by hand — which is why `autoLaunchSupported()` tells the two apart.
    expect(appNameFor('idea', { platform: 'win32' })).toBeUndefined();
    expect(appNameFor('pycharm', { platform: 'linux' })).toBeUndefined();
  });
});

describe('detectInstalledIdes', () => {
  /** 造一个假的应用目录，里面放给定的 bundle。 */
  function fakeApps(bundles) {
    const dir = mkdtempSync(path.join(tmpdir(), 'apps-'));
    for (const bundle of bundles) mkdirSync(path.join(dir, `${bundle}.app`));
    return dir;
  }

  it('finds installed IDEs by application bundle, not by process', () => {
    // 进程探测只能看到"正在运行"的 IDE,装了没开就漏 —— 这里按安装目录找,与是否运行无关。
    const dir = fakeApps(['IntelliJ IDEA', 'PyCharm']);
    expect(detectInstalledIdes({ dirs: [dir] }).sort()).toEqual(['idea', 'pycharm']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts the CE variants', () => {
    const dir = fakeApps(['PyCharm CE', 'IntelliJ IDEA CE']);
    expect(detectInstalledIdes({ dirs: [dir] }).sort()).toEqual(['idea', 'pycharm']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports only what is installed', () => {
    const dir = fakeApps(['IntelliJ IDEA']);
    expect(detectInstalledIdes({ dirs: [dir] })).toEqual(['idea']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('ignores unrelated bundles and missing directories', () => {
    const dir = fakeApps(['Safari', 'Visual Studio Code']);
    expect(detectInstalledIdes({ dirs: [dir, '/no/such/dir'] })).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('recognises the Toolbox and versioned directory names too', () => {
    // Windows / Linux 的安装目录形如 `PyCharm 2026.2`、Toolbox 的 `PyCharm`,没有 .app 后缀。
    const dir = fakeApps(['PyCharm 2026.2', 'IntelliJ IDEA 2026.2']);
    expect(detectInstalledIdes({ dirs: [dir] }).sort()).toEqual(['idea', 'pycharm']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns nothing when no known directory can be read', () => {
    // 空数组是"没探测出来",不是"没装" —— 调用方必须照常问用户。
    expect(detectInstalledIdes({ dirs: ['/no/such/dir'] })).toEqual([]);
  });
});

describe('openInIde', () => {
  it('opens via `open -a <app> <dir>` so a running instance is reused', async () => {
    const { impl, calls } = fakeSpawn(0);
    await expect(openInIde('/proj', { app: 'IntelliJ IDEA', spawnImpl: impl })).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('open');
    expect(calls[0].args).toEqual(['-a', 'IntelliJ IDEA', '/proj']);
  });

  it('resolves false when `open` exits non-zero', async () => {
    const { impl } = fakeSpawn(1);
    await expect(openInIde('/proj', { spawnImpl: impl })).resolves.toBe(false);
  });

  it('resolves false when spawning throws', async () => {
    const impl = () => {
      throw new Error('ENOENT');
    };
    await expect(openInIde('/proj', { spawnImpl: impl })).resolves.toBe(false);
  });
});

describe('createLaunchGuard', () => {
  it('blocks a second spawn during cooldown, then allows it', () => {
    let clock = 0;
    const guard = createLaunchGuard({ cooldownMs: 1000, maxAttempts: 3, now: () => clock });
    expect(guard.canSpawn()).toBe(true);
    guard.markSpawn();
    expect(guard.state()).toEqual({ lastSpawnAt: 0, attempts: 1 });
    expect(guard.coolingDown()).toBe(true);
    expect(guard.canSpawn()).toBe(false);
    clock = 1000;
    expect(guard.coolingDown()).toBe(false);
    expect(guard.canSpawn()).toBe(true);
  });

  it('reports exhaustion after maxAttempts', () => {
    let clock = 0;
    const guard = createLaunchGuard({ cooldownMs: 10, maxAttempts: 2, now: () => clock });
    guard.markSpawn();
    clock += 100;
    guard.markSpawn();
    expect(guard.exhausted()).toBe(true);
    expect(guard.canSpawn()).toBe(false);
  });

  it('resets after the IDE is confirmed serving', () => {
    let clock = 0;
    const guard = createLaunchGuard({ cooldownMs: 1000, maxAttempts: 3, now: () => clock });
    guard.markSpawn();
    guard.reset();
    expect(guard.state()).toEqual({ lastSpawnAt: 0, attempts: 0 });
    expect(guard.canSpawn()).toBe(true);
  });
});
