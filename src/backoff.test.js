import {describe, expect, it} from 'vitest';

import {LAUNCH_MAX_ATTEMPTS, RETRY_BACKOFF_MS, retryDelayMs} from './backoff.js';

describe('统一退避', () => {
    it('1s → 2s → 4s，之后固定 4s', () => {
        expect(RETRY_BACKOFF_MS).toEqual([1000, 2000, 4000]);
        expect([0, 1, 2, 3, 10].map(retryDelayMs)).toEqual([1000, 2000, 4000, 4000, 4000]);
    });

    it('实际拉起最多 3 次', () => {
        expect(LAUNCH_MAX_ATTEMPTS).toBe(3);
    });
});
