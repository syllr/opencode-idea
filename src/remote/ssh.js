// SSH 执行：一次调用 = 一条连接 + 一条命令。
//
// 刻意**不做持久 shell**：没有交互式会话就没有提示符解析、没有输出边界猜测、没有
// 会话生命周期管理。代价是 `cd` / `export` 不跨命令保留 —— 需要目录就传
// `workingDirectory`（内部拼 `cd '<dir>' && <command>`），需要环境就写进命令本身。

import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

import {Client} from 'ssh2';

/** 连接建立的上限。命令本身**不设超时**：卡住时由用户取消这次调用。 */
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
 * 在远程执行一条命令。
 *
 * 命令先 base64 编码再交给 `sh`：这样引号、换行、`$` 都不会被本地 shell 或传输层改写，
 * 远程拿到的就是调用方写的那条命令。
 *
 * @param {import('./hosts.js').RemoteServer} server
 * @param {string} command
 * @param {{ workingDirectory?: string }} [options]
 * @returns {Promise<{ exitCode: number | null, stdout: string, stderr: string }>}
 */
export async function runRemoteCommand(server, command, options = {}) {
    const conn = await connect(server);
    try {
        return await execOn(conn, withWorkingDirectory(command, options.workingDirectory));
    } finally {
        conn.end();
    }
}

/**
 * @param {import('ssh2').Client} conn
 * @param {string} command 已经包好 `cd` 的命令
 */
function execOn(conn, command) {
    const encoded = Buffer.from(command, 'utf8').toString('base64');
    const execCommand = `printf '%s' '${encoded}' | (base64 -d 2>/dev/null || openssl base64 -d 2>/dev/null) | sh`;

    return new Promise((resolve, reject) => {
        let settled = false;
        let stdout = '';
        let stderr = '';

        /** @param {Error} [error] @param {{ exitCode: number | null }} [value] */
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            if (error) reject(error);
            else resolve({exitCode: value?.exitCode ?? null, stdout, stderr});
        };

        conn.exec(execCommand, (error, stream) => {
            if (error) {
                finish(error);
                return;
            }

            stream.on('data', (chunk) => {
                stdout += chunk.toString('utf8');
            });
            stream.stderr.on('data', (chunk) => {
                stderr += chunk.toString('utf8');
            });
            // 没有内部超时：命令会一直跑到自己结束或连接断掉。卡住的调用由用户取消。
            stream.on('close', (code) => {
                finish(undefined, {exitCode: typeof code === 'number' ? code : null});
            });
            stream.on('error', (streamError) => {
                finish(streamError);
            });
        });
    });
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
    if (server.authType === 'OPEN_SSH' && /agent|no auth/i.test(message)) {
        return `这台的认证方式是 OpenSSH（ssh-agent / ~/.ssh/config），但本机没有可用的 agent 或私钥：` +
            `确认 SSH_AUTH_SOCK 已设置、或 ~/.ssh/config 里配了 IdentityFile。`;
    }
    return `SSH 执行失败（${server.name}）：${message}`;
}
