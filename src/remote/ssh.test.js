// SSH 层的纯函数测试：命令包装、引用、错误翻译。真连接只能手工验证。

import {EventEmitter} from 'node:events';

import {afterEach, describe, expect, it, vi} from 'vitest';

import {EXIT_GRACE_MS, describeSshError, execOn, expandTilde, shellQuote, withWorkingDirectory} from './ssh.js';

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

describe('execOn 的收尾', () => {
    /** 只吐一条 stream 的假连接：真连接手工验证，这里只测事件与收尾逻辑。 */
    function fakeConn(stream) {
        return {exec: (_command, callback) => callback(undefined, stream)};
    }

    function fakeStream() {
        const stream = new EventEmitter();
        stream.stderr = new EventEmitter();
        return stream;
    }

    afterEach(() => {
        vi.useRealTimers();
    });

    it('命令退出后 close 迟迟不来时，宽限期一到就用 exit 的退出码收尾', async () => {
        vi.useFakeTimers();
        const stream = fakeStream();
        const promise = execOn(fakeConn(stream), 'nohup docker build &');

        stream.emit('data', Buffer.from('started\n'));
        stream.emit('exit', 3);

        // close 被后台子进程拖住，这时候只挂了一个宽限计时器。
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(EXIT_GRACE_MS);
        await expect(promise).resolves.toEqual({exitCode: 3, stdout: 'started\n', stderr: ''});
    });

    it('close 紧跟着 exit 到，就不等宽限期，退出码取 close 的', async () => {
        vi.useFakeTimers();
        const stream = fakeStream();
        const promise = execOn(fakeConn(stream), 'ls');

        stream.emit('exit', 0);
        stream.emit('close', 7);

        expect(vi.getTimerCount()).toBe(0);
        await expect(promise).resolves.toEqual({exitCode: 7, stdout: '', stderr: ''});
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
