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

/** 造一个假的应用目录，里面放给定的 bundle。 */
function fakeApps(bundles) {
  const dir = mkdtempSync(path.join(tmpdir(), 'apps-'));
  for (const bundle of bundles) mkdirSync(path.join(dir, `${bundle}.app`));
  return dir;
}

describe('appNameFor', () => {
  it('maps each supported IDE to its macOS app name, and nothing else', () => {
    expect(appNameFor('idea')).toBe('IntelliJ IDEA');
    expect(appNameFor('pycharm')).toBe('PyCharm');
    expect(appNameFor('vscode')).toBeUndefined();
    expect(appNameFor('')).toBeUndefined();
    // 只实现了 macOS 的 `open -a`。别的平台上 spawn `open` 会 ENOENT,所以解析不出 app,
    // 由用户手动打开 —— 这正是 `autoLaunchSupported()` 用来区分两者的。
    expect(appNameFor('idea', { platform: 'win32' })).toBeUndefined();
    expect(appNameFor('pycharm', { platform: 'linux' })).toBeUndefined();
  });
});

describe('detectInstalledIdes', () => {
  it('finds installed IDEs by application bundle, not by process', () => {
    // 进程探测只能看到"正在运行"的 IDE,装了没开就漏 —— 这里按安装目录找,与是否运行无关。
    const dir = fakeApps(['IntelliJ IDEA', 'PyCharm']);
    expect(detectInstalledIdes({ dirs: [dir] }).sort()).toEqual(['idea', 'pycharm']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('recognises the CE, versioned and Toolbox directory names too', () => {
    // Windows / Linux 的安装目录形如 `PyCharm 2026.2`、Toolbox 的 `PyCharm`,没有 .app 后缀。
    const dir = fakeApps(['PyCharm CE', 'IntelliJ IDEA CE', 'PyCharm 2026.2', 'IntelliJ IDEA 2026.2']);
    expect(detectInstalledIdes({ dirs: [dir] }).sort()).toEqual(['idea', 'pycharm']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports only what is installed, and ignores unrelated bundles', () => {
    const dir = fakeApps(['IntelliJ IDEA', 'Safari', 'Visual Studio Code']);
    expect(detectInstalledIdes({ dirs: [dir] })).toEqual(['idea']);
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

  it('resolves false when `open` fails', async () => {
    const { impl } = fakeSpawn(1);
    await expect(openInIde('/proj', { spawnImpl: impl })).resolves.toBe(false);
    const throwing = () => {
      throw new Error('ENOENT');
    };
    await expect(openInIde('/proj', { spawnImpl: throwing })).resolves.toBe(false);
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

  it('reports exhaustion after maxAttempts, and resets once the IDE is serving', () => {
    let clock = 0;
    const guard = createLaunchGuard({ cooldownMs: 10, maxAttempts: 2, now: () => clock });
    guard.markSpawn();
    clock += 100;
    guard.markSpawn();
    expect(guard.exhausted()).toBe(true);
    expect(guard.canSpawn()).toBe(false);

    guard.reset();
    expect(guard.state()).toEqual({ lastSpawnAt: 0, attempts: 0 });
    expect(guard.canSpawn()).toBe(true);
  });
});
