// Unit tests for the IDE launcher: re-entrant `open -a` invocation and the
// per-directory launch guard.

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IDE_APP,
  createLaunchGuard,
  openInIde,
  resolveIdeApp,
} from '../src/ide-launcher.js';

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

describe('resolveIdeApp', () => {
  it('defaults to IntelliJ IDEA', () => {
    expect(resolveIdeApp(undefined)).toBe(DEFAULT_IDE_APP);
    expect(resolveIdeApp(true)).toBe(DEFAULT_IDE_APP);
  });

  it('maps the "idea" alias and passes custom app names through', () => {
    expect(resolveIdeApp('idea')).toBe('IntelliJ IDEA');
    expect(resolveIdeApp('IntelliJ IDEA CE')).toBe('IntelliJ IDEA CE');
  });

  it('disables launching with false', () => {
    expect(resolveIdeApp(false)).toBeUndefined();
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
