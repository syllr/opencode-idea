import { afterEach, describe, expect, it, vi } from 'vitest';
import { logEvent } from './log.js';

const restore = [];
afterEach(() => {
  for (const undo of restore.splice(0)) undo();
  vi.restoreAllMocks();
});

/** 临时解除测试静音（见 `logEvent` 里的 VITEST 判断）。 */
function unmute() {
  const saved = process.env.VITEST;
  delete process.env.VITEST;
  restore.push(() => {
    process.env.VITEST = saved;
  });
}

describe('logEvent', () => {
  it('prints one prefixed line with the event and its fields', () => {
    unmute();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logEvent('ide.probe.failed', { state: 'busy', failures: 2, project: '/p' });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0][0];
    expect(line).toContain('ide.probe.failed');
    expect(line).toContain('state=busy');
    expect(line).toContain('failures=2');
    // 空值不占位，日志才读得动。
    expect(line).not.toContain('undefined');
  });

  it('never throws, even when the console is broken', () => {
    unmute();
    vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('console is gone');
    });
    expect(() => logEvent('ide.probe.failed', { state: 'down' })).not.toThrow();
  });

  it('is silent under vitest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logEvent('ide.probe.failed', { state: 'down' });
    expect(warn).not.toHaveBeenCalled();
  });
});
