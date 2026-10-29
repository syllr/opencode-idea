// SSH 层的纯函数测试：命令包装、引用、错误翻译。真连接只能手工验证。

import {describe, expect, it} from 'vitest';

import {describeSshError, expandTilde, shellQuote, withWorkingDirectory} from './ssh.js';

describe('shellQuote', () => {
    it('包住单引号并在内部转义', () => {
        expect(shellQuote('/data/app')).toBe("'/data/app'");
        expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    });
});

describe('withWorkingDirectory', () => {
    it('没传目录时原样返回', () => {
        expect(withWorkingDirectory('ls', undefined)).toBe('ls');
        expect(withWorkingDirectory('ls', '   ')).toBe('ls');
    });

    it('绝对路径直接 cd', () => {
        expect(withWorkingDirectory('ls', '/data/app')).toBe("cd '/data/app' && ls");
    });

    it('~ 展开成远程 $HOME，而不是字面量 ~', () => {
        expect(withWorkingDirectory('ls', '~')).toBe('cd "$HOME" && ls');
        expect(withWorkingDirectory('ls', '~/app')).toBe('cd "$HOME"/\'app\' && ls');
    });
});

describe('expandTilde', () => {
    it('只展开开头的 ~', () => {
        expect(expandTilde('/a/~/b')).toBe('/a/~/b');
    });
});

describe('describeSshError', () => {
    const target = {name: 'mbp', host: '10.0.0.1', port: 22, username: 'root', source: 'ide'};

    it('认证失败给出可执行的下一步', () => {
        expect(describeSshError(new Error('All configured authentication methods failed'), target))
            .toContain('认证失败');
    });

    it('连接拒绝 / 超时各有自己的文案', () => {
        expect(describeSshError(new Error('connect ECONNREFUSED'), target)).toContain('连接被拒绝');
        expect(describeSshError(new Error('Timed out while waiting for handshake'), target)).toContain('连接超时');
    });
});
