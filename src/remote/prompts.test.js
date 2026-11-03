// 三条提示词命令的正文测试：有参数时带上参数，没参数时要求先问。

import {describe, expect, it} from 'vitest';

import {remoteDeploymentPrompt, remoteShellPrompt, remoteSyncPrompt} from './prompts.js';

describe('remoteShellPrompt', () => {
    it('带上用户的要求，并要求没指定时先问', () => {
        const text = remoteShellPrompt('mbp 看下磁盘');
        expect(text).toContain('remote_list_servers');
        expect(text).toContain('remote_exec');
        expect(text).toContain('不要用 shell 里的 ssh');
        expect(text).toContain('用户本次的要求：mbp 看下磁盘');
        expect(text).toContain('先问清楚');
    });

    it('没带参数时明确要求先问服务器与命令', () => {
        const text = remoteShellPrompt('');
        expect(text).toContain('先问清楚');
        expect(text).not.toContain('用户本次的要求：');
    });
});

describe('remoteDeploymentPrompt', () => {
    it('走 deploy_remote_process，并要求没指定配置时先问', () => {
        const text = remoteDeploymentPrompt('aidata-api 上线');
        expect(text).toContain('deploy_remote_process');
        expect(text).toContain('list_remote_processes');
        expect(text).toContain('用户本次的要求：aidata-api 上线');
        expect(text).toContain('先问清楚');
    });

    it('没带参数时提示先列出候选再问', () => {
        const text = remoteDeploymentPrompt('   ');
        expect(text).toContain('list_remote_processes');
        expect(text).not.toContain('用户本次的要求：');
    });
});

describe('remoteSyncPrompt', () => {
    it('只做文件同步，指向 remote_upload / remote_download', () => {
        const text = remoteSyncPrompt('mcp-test-project download');
        expect(text).toContain('remote_upload');
        expect(text).toContain('remote_download');
        expect(text).toContain('remote_list_servers');
        expect(text).toContain('用户本次的要求：mcp-test-project download');
        expect(text).toContain('先问清楚');
    });

    it('没带参数时提示先列出候选', () => {
        const text = remoteSyncPrompt('   ');
        expect(text).toContain('remote_list_servers');
        expect(text).not.toContain('用户本次的要求：');
    });
});
