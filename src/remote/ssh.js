// SSH 执行：一次调用 = 一条连接 + 一条命令。
//
// 刻意**不做持久 shell**：没有交互式会话就没有提示符解析、没有输出边界猜测、没有
// 会话生命周期管理。代价是 `cd` / `export` 不跨命令保留 —— 需要目录就传
// `workingDirectory`（内部拼 `cd '<dir>' && <command>`），需要环境就写进命令本身。

import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

import {StringDecoder} from 'node:string_decoder';

import {Client} from 'ssh2';

/** 连接建立的上限。命令执行本身**不设超时**：卡住时由用户取消这次调用。 */
const CONNECT_TIMEOUT_MS = 15000;

/** @param {string} path */
export function expandTilde(path) {
    if (path === '~') return homedir();
    if (path.startsWith('~/')) return join(homedir(), path.slice(2));
    return path;
}

/** POSIX 单引号引用；内部单引号用 `'\''` 转义。 */
export function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * 把 `cd` 包装进命令。`~` 必须当远程的 `$HOME` 处理 —— `cd '~'` 不会展开。
 *
 * @param {string} command
 * @param {string | undefined} workingDirectory
 */
export function withWorkingDirectory(command, workingDirectory) {
    const dir = workingDirectory?.trim();
    if (!dir) return command;
    const cd = dir === '~'
        ? 'cd "$HOME"'
        : dir.startsWith('~/')
            ? `cd "$HOME"/${shellQuote(dir.slice(2))}`
            : `cd ${shellQuote(dir)}`;
    return `${cd} && ${command}`;
}

/**
 * 开一条 SSH 连接。
 *
 * @param {import('./hosts.js').RemoteServer} server
 * @returns {Promise<import('ssh2').Client>}
 */
export function connect(server) {
    return new Promise((resolve, reject) => {
        const conn = new Client();
        let settled = false;
        /** @param {Error} [error] @param {unknown} [value] */
        const done = (error, value) => {
            if (settled) return;
            settled = true;
            if (error) reject(error);
            else resolve(value);
        };

        let privateKey;
        if (server.privateKeyPath) {
            try {
                privateKey = readFileSync(expandTilde(server.privateKeyPath));
            } catch (error) {
                reject(new Error(
                    `无法读取私钥 "${server.privateKeyPath}": ` +
                    (error instanceof Error ? error.message : String(error)),
                ));
                return;
            }
        }

        conn.on('ready', () => done(undefined, conn));
        conn.on('error', (error) => done(error));
        // close/end 只在连接意外结束时有意义；正常收尾时 settled 已经是 true。
        conn.on('close', () => done(new Error('SSH 连接意外关闭')));
        conn.on('end', () => done(new Error('SSH 连接意外断开')));

        // 第三种认证方式：OpenSSH config / ssh-agent。IDE 里选了它时不会有 password 也不会有
        // privateKeyPath —— 凭据在 `~/.ssh/config` 与 agent 里，ssh2 要用 agent socket。
        const useAgent = server.authType === 'OPEN_SSH'
            || (!server.password && !server.privateKeyPath);
        const agent = useAgent ? process.env.SSH_AUTH_SOCK : undefined;

        try {
            conn.connect({
                host: server.host,
                port: server.port,
                username: server.username,
                password: server.password,
                privateKey,
                passphrase: server.passphrase,
                agent,
                // 传输层压缩：产物多是文本（前端资源、打出来的 main.js），压缩后能小一个数量级；
                // 已是压缩包的内容（jar、wasm）压不动，但也只是多花一点 CPU。
                compress: true,
                readyTimeout: CONNECT_TIMEOUT_MS,
                keepaliveInterval: 5000,
                keepaliveCountMax: 3,
            });
        } catch (error) {
            done(error instanceof Error ? error : new Error(String(error)));
        }
    });
}

/**
 * 命令退出后等 `close` 收尾输出的宽限期（毫秒）。
 *
 * `exit` 表示远端命令本身退出了，`close` 表示 channel 关闭（输出管道全部释放）。
 * 正常命令两者只差 1ms 左右；但后台子进程经常还攥着 channel 的 stdout 管道 ——
 * 比如 `a && b && nohup c > log 2>&1 &`，`&` 作用于整条链，后台子 shell 自己占着管道，
 * sshd 要等后台任务全部跑完才发 `close`（实测能拖到几分钟）。所以只等 `exit` + 这点宽限，
 * 超时就按 `exit` 的退出码收尾：正常命令走不到计时器，异常命令最多多等这么久。
 */
export const EXIT_GRACE_MS = 1000;

/**
 * @param {import('ssh2').Client} conn
 * @param {string} command 已经包好 `cd` 的命令
 */
export function encodeExecCommand(command) {
    const encoded = Buffer.from(command, 'utf8').toString('base64');
    return [
        "if command -v base64 >/dev/null 2>&1; then",
        `  printf '%s' '${encoded}' | base64 -d | sh`,
        "elif command -v openssl >/dev/null 2>&1; then",
        `  printf '%s' '${encoded}' | openssl base64 -d | sh`,
        "else",
        "  echo 'opencode-idea: remote host has no base64 decoder (need base64 or openssl)' >&2",
        '  exit 127',
        'fi',
    ].join('\n');
}

/**
 * 把一条命令的输出转成“终端里看到的样子”。
 *
 * 三件事，缺一不可：
 * 1. **UTF-8 解码** —— chunk 是 Buffer，按字节切，多字节字符常被切在边界上；
 *    `chunk.toString('utf8')` 会把它变成 U+FFFD，所以必须用 StringDecoder 续着解。
 * 2. **剥离 ANSI** —— 颜色 / 光标控制对模型是纯噪音。不完整的序列（chunk 切在中间）
 *    挂起到下一块再拼，避免把 `\x1b[3` 当成正文吐出去。
 * 3. **`\r` 行内覆盖** —— 进度条靠回车刷同一行；终端只显示最后状态，
 *    直接拼接会留下 `10%\r50%\r…` 这样一串回车。
 *
 * 输出是**流式**的：`write()` 只返回已经定稿的行（`\n` 之后），
 * 当前还没换行的那一行由 `flushLine()` 取走 —— 超时读队列时正好把进度条的最后状态带上。
 */
export class TerminalText {
    constructor() {
        this.decoder = new StringDecoder('utf8');
        /** 被 chunk 切断、还没收完的 ANSI 序列。 */
        this.pending = '';
        /** 还没遇到 `\n` 的当前行（`\r` 会把它清空重写）。 */
        this.line = '';
    }

    /**
     * @param {Buffer | string} chunk
     * @returns {string} 可以立刻追加到输出的文本（不含未完成的当前行）
     */
    write(chunk) {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        let text = this.pending + this.decoder.write(bytes);
        this.pending = '';

        // 末尾如果是半个 CSI/OSC 序列，留到下一块；否则 `\x1b[3` 会被当成正文。
        const tail = /\x1b(?:\[[0-9;?]*|[\]P][^\x07\x1b]*)?$/.exec(text);
        if (tail) {
            this.pending = tail[0];
            text = text.slice(0, -tail[0].length);
        }

        text = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
        text = text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');

        let out = '';
        for (const ch of text) {
            if (ch === '\r') {
                this.line = '';
                continue;
            }
            if (ch === '\n') {
                out += `${this.line}\n`;
                this.line = '';
                continue;
            }
            this.line += ch;
        }
        return out;
    }

    /** 取走“还没换行的那一行”（进度条的最后状态）。 */
    flushLine() {
        if (!this.line) return '';
        const line = this.line;
        this.line = '';
        return line;
    }

    /** 收尾：把解码器里不够一个完整字符的残余吐出来。 */
    end() {
        const rest = this.decoder.end();
        return rest + this.flushLine();
    }
}


/**
 * 一次**可续等**的远程执行。
 *
 * 它不把结果一次交出去，而是把输出攒在队列里，由调用方分次取走（`take()`）。
 * 命令照旧原样执行 —— 不包 `nohup`、不改 `cd` 语义。
 *
 * @param {import('ssh2').Client} conn 已经建好的连接，run 结束时由这里关闭
 * @param {string} command 已经包好 `cd` 的命令
 */
export function createRemoteRun(conn, command) {
    const text = new TerminalText();
    let queue = '';
    // 队列上限：`take()` 只在"取走时"截断，两次取之间跑一个 `cat 大文件` 能把
    // 整个 OpenCode 进程的内存吃满。超限后保留头尾并记下丢弃量，出结果时说明。
    const MAX_QUEUE_CHARS = 1024 * 1024;
    let droppedChars = 0;
    const append = (chunk) => {
        if (!chunk) return;
        queue += chunk;
        if (queue.length <= MAX_QUEUE_CHARS) return;
        const keep = Math.floor(MAX_QUEUE_CHARS / 2);
        const head = queue.slice(0, keep);
        const tail = queue.slice(-keep);
        droppedChars += queue.length - keep * 2;
        queue = head + tail;
    };
    let exitCode = null;
    let ended = false;
    /** @type {Array<() => void>} */
    let waiters = [];
    /** @type {NodeJS.Timeout | undefined} */
    let grace;

    const settle = () => {
        if (ended) return;
        ended = true;
        if (grace) clearTimeout(grace);
        append(text.end());
        conn.end();
        const pending = waiters;
        waiters = [];
        for (const resolve of pending) resolve(true);
    };

    conn.exec(encodeExecCommand(command), (error, stream) => {
        if (error) {
            append(`[${error.message}]`);
            exitCode = null;
            settle();
            return;
        }
        stream.on('data', (chunk) => {
            append(text.write(chunk));
        });
        stream.stderr.on('data', (chunk) => {
            append(text.write(chunk));
        });
        stream.on('exit', (code) => {
            exitCode = typeof code === 'number' ? code : null;
            grace = setTimeout(settle, EXIT_GRACE_MS);
        });
        stream.on('close', () => settle());
        stream.on('error', (streamError) => {
            append(`[${streamError.message}]`);
            settle();
        });
    });

    return {
        /** 命令是否已经结束（含收尾宽限）。 */
        get done() {
            return ended;
        },
        get exitCode() {
            return exitCode;
        },
        /**
         * 取走队列里的全部输出（取完清空）。当前未换行的那一行也一起带走。
         *
         * @returns {string}
         */
        take() {
            append(text.flushLine());
            const note = droppedChars > 0 ? `…[输出过长，已省略 ${droppedChars} 个字符]…\n` : '';
            const out = note + queue;
            queue = '';
            droppedChars = 0;
            return out;
        },
        /**
         * 最多等 `ms` 毫秒，命令结束就提前返回。
         *
         * @param {number} ms
         * @returns {Promise<boolean>} true = 已结束
         */
        wait(ms) {
            if (ended) return Promise.resolve(true);
            return new Promise((resolve) => {
                let timer;
                const wake = () => {
                    if (timer) clearTimeout(timer);
                    resolve(true);
                };
                waiters.push(wake);
                if (ms > 0) {
                    timer = setTimeout(() => {
                        waiters = waiters.filter((entry) => entry !== wake);
                        resolve(false);
                    }, ms);
                } else {
                    waiters = waiters.filter((entry) => entry !== wake);
                    resolve(false);
                }
            });
        },
        /** 放弃这次 run（不杀远端进程，只关连接）。 */
        dispose() {
            if (ended) return;
            ended = true;
            const pending = waiters;
            waiters = [];
            for (const resolve of pending) resolve(true);
            conn.end();
        },
    };
}

/**
 * 把 SSH 错误翻译成调用方看得懂的一句话。
 *
 * @param {unknown} error
 * @param {import('./hosts.js').RemoteServer} server
 */
export function describeSshError(error, server) {
    const message = error instanceof Error ? error.message : String(error);
    const level = /** @type {{ level?: string }} */ (error)?.level;
    // 先按认证方式分流：OPEN_SSH 的失败文本同样含 "authentication"，不能落到密码分支。
    if (server.authType === 'OPEN_SSH'
        && (level === 'client-authentication' || /authentication|agent|no auth/i.test(message))) {
        return `这台的认证方式是 OpenSSH（ssh-agent / ~/.ssh/config），但本机没有可用的 agent 或私钥：` +
            `确认 SSH_AUTH_SOCK 已设置、或 ~/.ssh/config 里配了 IdentityFile。`;
    }
    if (level === 'client-authentication' || /authentication/i.test(message)) {
        return `认证失败（${server.username}@${server.host}:${server.port}）：密码/私钥可能已失效，` +
            `请在 IDE 的 Deployment 设置里更新后重试。`;
    }
    if (/ECONNREFUSED/i.test(message)) {
        return `连接被拒绝（${server.host}:${server.port}）：主机可能未启动 SSH 服务，或端口不对。`;
    }
    if (/ETIMEDOUT|timed out/i.test(message)) {
        return `连接超时（${server.host}:${server.port}）：网络不可达，或需要跳板机。`;
    }
    return `SSH 执行失败（${server.name}）：${message}`;
}
