// 三条提示词命令的正文测试：只盯"用户的要求有没有被原样带进去"这一条契约。

import {describe, expect, it} from 'vitest';

import {remoteDeployPrompt, remoteShellPrompt, remoteFilesPrompt} from './prompts.js';

describe('提示词命令', () => {
    it('原样带上用户的要求', () => {
        expect(remoteShellPrompt('mbp 看下磁盘')).toContain('用户本次的要求：mbp 看下磁盘');
        expect(remoteDeployPrompt('aidata-api 上线')).toContain('用户本次的要求：aidata-api 上线');
        expect(remoteFilesPrompt('mcp-test-project download')).toContain('用户本次的要求：mcp-test-project download');
    });

    it('没带参数时不注入用户要求', () => {
        expect(remoteShellPrompt('')).not.toContain('用户本次的要求：');
        expect(remoteDeployPrompt('   ')).not.toContain('用户本次的要求：');
        expect(remoteFilesPrompt('')).not.toContain('用户本次的要求：');
    });
});
