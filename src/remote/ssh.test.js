// SSH 层的纯函数测试：命令包装、引用、错误翻译。真连接只能手工验证。

import {EventEmitter} from 'node:events';

import {afterEach, describe, expect, it, vi} from 'vitest';

import {
    TerminalText,
    createRemoteRun,
    describeSshError,
    expandTilde,
    shellQuote,
    withWorkingDirectory,
} from './ssh.js';

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


describe('TerminalText', () => {
    it('多字节字符被切在 chunk 边界时不会变成乱码', () => {
        const text = new TerminalText();
        const bytes = Buffer.from('构建完成 ✅ 中文 🚀 done\n', 'utf8');
        let out = '';
        for (let i = 0; i < bytes.length; i += 3) out += text.write(bytes.subarray(i, i + 3));
        out += text.end();
        expect(out).toBe('构建完成 ✅ 中文 🚀 done\n');
    });

    it('剥离 ANSI 颜色，跨 chunk 的半截序列不会漏进正文', () => {
        const text = new TerminalText();
        let out = text.write(Buffer.from('\x1b[32mOK\x1b[0m', 'utf8'));
        // 序列被切成两半：前半截必须先挂起，不能当正文吐出去
        out += text.write(Buffer.from('\x1b[3', 'utf8'));
        out += text.write(Buffer.from('1mOK\x1b[0m done\n', 'utf8'));
        out += text.end();
        expect(out).toBe('OKOK done\n');
    });

    it('\\r 覆盖当前行，只保留最后状态', () => {
        const text = new TerminalText();
        expect(text.write(Buffer.from('10%\r50%\r99%', 'utf8'))).toBe('');
        expect(text.flushLine()).toBe('99%');
        expect(text.write(Buffer.from('\n', 'utf8'))).toBe('\n');
    });
});

describe('createRemoteRun', () => {
    function runConn(stream) {
        return {
            exec: (_command, callback) => callback(undefined, stream),
            end: () => {},
        };
    }

    function runStream() {
        const stream = new EventEmitter();
        stream.stderr = new EventEmitter();
        return stream;
    }

    it('take 取走队列并清空，take 会把未换行的那一行一起带走', () => {
        const stream = runStream();
        const run = createRemoteRun(runConn(stream), 'x');
        stream.emit('data', Buffer.from('a\n10%\r99%', 'utf8'));
        expect(run.take()).toBe('a\n99%');
        expect(run.take()).toBe('');
    });

    it('wait 在命令结束时提前返回，超时返回 false 且输出留在队列里', async () => {
        vi.useFakeTimers();
        const stream = runStream();
        const run = createRemoteRun(runConn(stream), 'x');
        stream.emit('data', Buffer.from('working\n', 'utf8'));

        const pending = run.wait(8000);
        await vi.advanceTimersByTimeAsync(8000);
        await expect(pending).resolves.toBe(false);
        expect(run.take()).toBe('working\n');

        const next = run.wait(8000);
        stream.emit('data', Buffer.from('done\n', 'utf8'));
        stream.emit('close');
        await expect(next).resolves.toBe(true);
        expect(run.done).toBe(true);
        expect(run.take()).toBe('done\n');
        vi.useRealTimers();
    });
});
