// Unit tests for the IDE launcher: re-entrant `open -a` invocation and the
// per-directory launch guard.

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createLaunchGuard, ideAppName, openInIde } from '../src/ide-launcher.js';

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

describe('ideAppName', () => {
  it('returns the IDEA app name on macOS only', () => {
    expect(ideAppName()).toBe('IntelliJ IDEA');
    // 只实现了 macOS 的 `open -a`。别的平台上 spawn `open` 会 ENOENT,所以解析不出 app,
    // 由用户手动打开 —— 这正是 `autoLaunchSupported()` 用来区分两者的。
    expect(ideAppName({ platform: 'win32' })).toBeUndefined();
    expect(ideAppName({ platform: 'linux' })).toBeUndefined();
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
