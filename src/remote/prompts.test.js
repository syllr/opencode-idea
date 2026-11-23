// 三条提示词命令的正文测试：用户的要求原样带进去；IDE 工具名必须是模型真的能调到的那个。

import {describe, expect, it} from 'vitest';

import {
    REMOTE_DEPLOY_DISPLAY,
    remoteDeployPrompt,
    remoteFilesPrompt,
    remoteShellPrompt,
} from './prompts.js';

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

describe('/remote-deploy 的 IDE 工具名', () => {
    // IDE 侧 MCP server 注册成 `ide`，OpenCode 用 server 名做前缀 —— 裸名调不到。
    // 这条是行为契约：提示词里点名的每一个 IDE 工具，都必须带 `ide_` 前缀。
    const IDE_TOOLS = [
        'deploy_remote_process',
        'list_remote_processes',
        'get_run_configurations',
        'inspect_run_configuration',
    ];

    it('只出现带 ide_ 前缀的工具名', () => {
        const text = [
            remoteDeployPrompt('aidata-api 上线'),
            remoteDeployPrompt(''),
            REMOTE_DEPLOY_DISPLAY,
        ].join('\n');

        for (const name of IDE_TOOLS) {
            expect(text).not.toMatch(new RegExp(`(?<!ide_)${name}`));
        }
    });
});
