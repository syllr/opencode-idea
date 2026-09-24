import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyEnv, mergeEnv } from './env.js';

describe('mergeEnv', () => {
  it('lets later sources win and dedupes prependPath', () => {
    const merged = mergeEnv([
      { env: { JAVA_HOME: '/a', FOO: '1' }, prependPath: ['/x'] },
      { env: { JAVA_HOME: '/b' }, prependPath: ['/x', '/y'] },
    ]);
    expect(merged.env).toEqual({ JAVA_HOME: '/b', FOO: '1' });
    expect(merged.prependPath).toEqual(['/x', '/y']);
  });
});

describe('applyEnv', () => {
  it('sets vars and prepends PATH', () => {
    const input = { env: { PATH: ['/usr/bin', '/bin'].join(path.delimiter) } };
    applyEnv(input, { env: { JAVA_HOME: '/jdk' }, prependPath: ['/jdk/bin'] });
    expect(input.env.JAVA_HOME).toBe('/jdk');
    expect(input.env.PATH.split(path.delimiter)[0]).toBe('/jdk/bin');
    expect(input.env.PATH).toContain('/usr/bin');
  });

  it('does not duplicate entries already on PATH', () => {
    const input = { env: { PATH: ['/jdk/bin', '/usr/bin'].join(path.delimiter) } };
    applyEnv(input, { env: {}, prependPath: ['/jdk/bin'] });
    expect(input.env.PATH.split(path.delimiter).filter((p) => p === '/jdk/bin')).toHaveLength(1);
  });

  it('leaves PATH unchanged when there is nothing to prepend', () => {
    const input = { env: { PATH: '/usr/bin' } };
    applyEnv(input, { env: {}, prependPath: [] });
    expect(input.env.PATH).toBe('/usr/bin');
  });
});
