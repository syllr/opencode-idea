// SFTP 目录同步：`overwrite`（只覆盖/新增）与 `mirror`（再删掉对方多余的文件）。
//
// 语义与 rsync 的尾斜杠一致：把 `localPath` 目录的**内容**同步到 `deployPath`，
// 不会额外生成一层 `localPath` 的目录名。
//
// 符号链接跳过并计数 —— 跟随链接会把目标目录之外的整棵树拖进来，那是另一个决定。
//
// 传输分两段：先「扫描 + 比对」得到待传清单，再按文件大小分档并发传。
// 为什么并发：SFTP 每个文件都要 open / write / close 加上一次 utimes，全是往返，
// 串行跑 2000 个 4KB 文件要近两分钟；并发 32 只要 3 秒多。分档是因为
// fastPut 每个在途文件会按 `min(2MB, 文件大小)` 开缓冲，大文件同时开太多只会抢带宽。

import {readdir, stat as fsStat, utimes} from 'node:fs/promises';
import {join} from 'node:path';
import {posix} from 'node:path';

import {isExcluded} from './hosts.js';

/**
 * 一次同步的公共选项。
 *
 * @typedef {{
 *   signal?: AbortSignal,
 *   root?: boolean,
 *   prefix?: string,
 *   exclude?: string[],
 * }} SyncOptions
 */

/**
 * @typedef {{
 *   files: number,
 *   dirs: number,
 *   bytes: number,
 *   skipped: number,
 *   unchanged: number,
 *   deleted: number,
 * }} SyncStats
 */

/**
 * 并发档位：按文件大小选，取第一个 `size < maxSize` 的档。
 *
 * 数字来自实测（千兆内网 / Tailscale 直连，RTT 5–8ms）：
 * - 2000 个 4KB：串行 112s，并发 16 是 5.9s，并发 32 是 3.5s，峰值内存只多 9MB；
 * - 含 20MB 大文件的目录：并发 16 / 32 / 按大小分档分别是 7.4s / 5.5s / 5.4s，
 *   但 32 档多花约 70MB 内存，所以大文件压到 4。
 */
const CONCURRENCY_TIERS = [
    {maxSize: 64 * 1024, concurrency: 32},
    {maxSize: 1024 * 1024, concurrency: 16},
    {maxSize: Number.POSITIVE_INFINITY, concurrency: 4},
];

/** 单个文件的额外重试次数：网络抖动时不必整个目录重来。 */
const FILE_RETRIES = 2;

/** ssh2 的回调式 API → Promise。 */
function call(fn, ...args) {
    return new Promise((resolve, reject) => {
        fn(...args, (error, value) => (error ? reject(error) : resolve(value)));
    });
}

/** 远程 attrs 的 mtime 是秒；本地 stat 是毫秒，比较时统一成毫秒。 */
function remoteMtimeMs(attrs) {
    return typeof attrs?.mtime === 'number' ? attrs.mtime * 1000 : undefined;
}

/**
 * 目标端那份是否与本地一致：size 相同且 mtime 落在同一秒内。
 *
 * 上传后会把远端 mtime 写成源文件的秒值（见 preserveRemoteMtime），所以第二次同步能命中这里；
 * 服务器不支持 setstat 时远端 mtime 永远是写入时刻，这时只会退化成全量传输，不会误跳过。
 */
function sameFile(localSize, localMtimeMs, remoteAttrs) {
    const remoteMs = remoteMtimeMs(remoteAttrs);
    if (typeof remoteAttrs?.size !== 'number' || remoteMs === undefined) return false;
    if (remoteAttrs.size !== localSize) return false;
    return Math.abs(remoteMs - localMtimeMs) < 1000;
}

/**
 * 把远端文件的 mtime 写回源文件的秒值，供下次同步做差量判断。
 * 服务器拒绝 setstat 时忽略：代价只是下次重传。
 */
async function preserveRemoteMtime(sftp, remotePath, info) {
    if (typeof sftp.utimes !== 'function') return;
    try {
        await call(
            sftp.utimes.bind(sftp),
            remotePath,
            Math.floor(info.atimeMs / 1000),
            Math.floor(info.mtimeMs / 1000),
        );
    } catch {
        // 忽略：不影响传输结果
    }
}

/** 读一层远程目录，得到 name → attrs；目录不存在返回 undefined。 */
async function readRemoteEntries(sftp, dir) {
    const entries = await call(sftp.readdir.bind(sftp), dir).catch((error) => {
        if (error?.code === 2 || /No such file/i.test(String(error?.message))) return undefined;
        throw error;
    });
    if (!entries) return undefined;
    const result = new Map();
    for (const entry of entries) {
        if (entry.filename === '.' || entry.filename === '..') continue;
        result.set(entry.filename, entry.attrs);
    }
    return result;
}

/**
 * 打开一个 SFTP session。
 *
 * @param {import('ssh2').Client} conn
 */
export function openSftp(conn) {
    return new Promise((resolve, reject) => {
        conn.sftp((error, sftp) => (error ? reject(error) : resolve(sftp)));
    });
}

/**
 * 逐级 `mkdir`，已存在不算错。
 *
 * @param {import('ssh2').SFTPWrapper} sftp
 * @param {string} dir
 */
export async function ensureRemoteDir(sftp, dir) {
    if (!dir || dir === '/' || dir === '.') return;
    const normalized = posix.normalize(dir).replace(/\/+$/, '');
    const parts = normalized.split('/').filter(Boolean);
    let current = normalized.startsWith('/') ? '' : '.';
    for (const part of parts) {
        current = current === '' ? `/${part}` : `${current}/${part}`;
        try {
            const info = await call(sftp.stat.bind(sftp), current);
            if (!info.isDirectory()) throw new Error(`远程路径 "${current}" 已存在但不是目录`);
        } catch (error) {
            if (error?.code === 2 || /No such file/i.test(String(error?.message))) {
                await call(sftp.mkdir.bind(sftp), current);
            } else {
                throw error;
            }
        }
    }
}

/**
 * 一个固定并发度的任务队列：任务之间互不依赖，任何一个失败就停止取新任务。
 *
 * @template T
 * @param {T[]} tasks
 * @param {number} concurrency
 * @param {(task: T) => Promise<void>} worker
 */
async function runQueue(tasks, concurrency, worker) {
    let index = 0;
    let failure;
    const runners = Array.from({length: Math.min(concurrency, tasks.length)}, async () => {
        while (!failure && index < tasks.length) {
            const task = tasks[index];
            index += 1;
            try {
                await worker(task);
            } catch (error) {
                failure = failure ?? error;
            }
        }
    });
    await Promise.all(runners);
    if (failure) throw failure;
}

/**
 * 按文件大小分档并发执行传输任务。
 *
 * 档位之间并行，档位内部按各自的并发度跑 —— 小文件多跑几个也几乎不占内存
 * （fastPut 只按文件大小开缓冲），大文件压到 4 个以免互相抢带宽。
 *
 * @template {{size: number}} T
 * @param {T[]} tasks
 * @param {(task: T) => Promise<void>} worker
 */
async function runBySize(tasks, worker) {
    const buckets = CONCURRENCY_TIERS.map((tier) => ({...tier, tasks: []}));
    for (const task of tasks) {
        const bucket = buckets.find((entry) => task.size < entry.maxSize) ?? buckets[buckets.length - 1];
        bucket.tasks.push(task);
    }
    await Promise.all(
        buckets
            .filter((bucket) => bucket.tasks.length > 0)
            .map((bucket) => runQueue(bucket.tasks, bucket.concurrency, worker)),
    );
}

/** 失败重试；用尽次数后把最后一次的错误抛出去。 */
async function withRetry(action) {
    let lastError;
    for (let attempt = 0; attempt <= FILE_RETRIES; attempt += 1) {
        try {
            return await action();
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError;
}

/**
 * 扫描本地目录，比对远端，得到要上传的文件清单；顺带建好远端目录。
 *
 * @param {import('ssh2').SFTPWrapper} sftp
 * @param {string} localDir
 * @param {string} remoteDir
 * @param {SyncStats} stats
 * @param {SyncOptions} [options]
 * @returns {Promise<Array<{localPath: string, remotePath: string, info: import('node:fs').Stats}>>}
 */
async function planUpload(sftp, localDir, remoteDir, stats, options = {}) {
    /** @type {Array<{localPath: string, remotePath: string, info: import('node:fs').Stats}>} */
    const pending = [];

    const walk = async (local, remote, prefix, root) => {
        if (options.signal?.aborted) throw new Error('传输已取消');
        if (root) await ensureRemoteDir(sftp, remote);
        // 先读远程目录：存在就顺带拿到名字 → attrs（差量判断用），不存在就建出来。
        // 一个目录只花一次往返，比逐级 stat 便宜得多。
        let remoteEntries = await readRemoteEntries(sftp, remote);
        if (!remoteEntries) {
            await call(sftp.mkdir.bind(sftp), remote);
            remoteEntries = new Map();
        }
        const entries = await readdir(local, {withFileTypes: true});
        for (const entry of entries) {
            if (options.signal?.aborted) throw new Error('传输已取消');
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (isExcluded(relative, options.exclude ?? [])) {
                stats.skipped += 1;
                continue;
            }
            const localPath = join(local, entry.name);
            const remotePath = posix.join(remote, entry.name);
            if (entry.isDirectory()) {
                stats.dirs += 1;
                await walk(localPath, remotePath, relative, false);
            } else if (entry.isFile()) {
                const info = await fsStat(localPath);
                if (sameFile(info.size, info.mtimeMs, remoteEntries.get(entry.name))) {
                    stats.unchanged += 1;
                    continue;
                }
                pending.push({localPath, remotePath, info});
            } else {
                stats.skipped += 1;
            }
        }
    };

    await walk(localDir, remoteDir, '', true);
    return pending;
}

/**
 * 递归读取远程目录的条目（相对路径 + 是否目录），用于 mirror 的差异删除。
 *
 * 排除项在这里也要跳过：被排除的路径不参与差异比较，否则 `mirror` 会把它们当成
 * "本地没有"而删掉远端。
 *
 * @param {import('ssh2').SFTPWrapper} sftp
 * @param {string} remoteDir
 * @param {string} [prefix]
 * @param {string[]} [exclude]
 * @returns {Promise<{ path: string, dir: boolean }[]>}
 */
async function listRemoteTree(sftp, remoteDir, prefix = '', exclude = []) {
    const entries = await call(sftp.readdir.bind(sftp), remoteDir).catch((error) => {
        if (error?.code === 2 || /No such file/i.test(String(error?.message))) return [];
        throw error;
    });
    const result = [];
    for (const entry of entries) {
        const name = entry.filename;
        if (name === '.' || name === '..') continue;
        const relative = prefix ? `${prefix}/${name}` : name;
        if (isExcluded(relative, exclude)) continue;
        const isDir = entry.attrs.isDirectory();
        result.push({path: relative, dir: isDir});
        if (isDir) {
            result.push(...await listRemoteTree(sftp, posix.join(remoteDir, name), relative, exclude));
        }
    }
    return result;
}

/**
 * 递归列出本地目录的相对条目，用于 mirror。
 *
 * @param {string} localDir
 * @param {string} [prefix]
 * @param {string[]} [exclude]
 * @returns {Promise<{ path: string, dir: boolean }[]>}
 */
async function listLocalTree(localDir, prefix = '', exclude = []) {
    const entries = await readdir(localDir, {withFileTypes: true}).catch(() => []);
    const result = [];
    for (const entry of entries) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (isExcluded(relative, exclude)) continue;
        if (entry.isDirectory()) {
            result.push({path: relative, dir: true});
            result.push(...await listLocalTree(join(localDir, entry.name), relative, exclude));
        } else if (entry.isFile()) {
            result.push({path: relative, dir: false});
        }
    }
    return result;
}

/**
 * 上传：本地目录 → 远程目录。
 *
 * @param {import('ssh2').SFTPWrapper} sftp
 * @param {string} localDir
 * @param {string} remoteDir
 * @param {'overwrite' | 'mirror'} mode
 * @param {SyncOptions} [options]
 * @returns {Promise<SyncStats>}
 */
export async function uploadDirectory(sftp, localDir, remoteDir, mode, options = {}) {
    const stats = {files: 0, dirs: 0, bytes: 0, skipped: 0, unchanged: 0, deleted: 0};
    const exclude = options.exclude ?? [];
    const pending = await planUpload(sftp, localDir, remoteDir, stats, {...options, root: true});

    await runBySize(
        pending.map((task) => ({...task, size: task.info.size})),
        async (task) => {
            await withRetry(async () => {
                await call(sftp.fastPut.bind(sftp), task.localPath, task.remotePath);
                await preserveRemoteMtime(sftp, task.remotePath, task.info);
            });
            stats.files += 1;
            stats.bytes += task.info.size;
        },
    );

    if (mode === 'mirror') {
        const localSet = new Set((await listLocalTree(localDir, '', exclude)).map((entry) => entry.path));
        const remoteEntries = await listRemoteTree(sftp, remoteDir, '', exclude);
        // 先删文件再删目录，避免 rmdir 非空。
        for (const entry of remoteEntries.filter((item) => !item.dir)) {
            if (localSet.has(entry.path)) continue;
            await call(sftp.unlink.bind(sftp), posix.join(remoteDir, entry.path));
            stats.deleted += 1;
        }
        for (const entry of remoteEntries.filter((item) => item.dir).reverse()) {
            if (localSet.has(entry.path)) continue;
            await call(sftp.rmdir.bind(sftp), posix.join(remoteDir, entry.path)).catch(() => {});
            stats.deleted += 1;
        }
    }
    return stats;
}

/**
 * 扫描远程目录，比对本地，得到要下载的文件清单。
 *
 * @param {import('ssh2').SFTPWrapper} sftp
 * @param {string} remoteDir
 * @param {string} localDir
 * @param {SyncStats} stats
 * @param {SyncOptions} [options]
 * @returns {Promise<Array<{remotePath: string, localPath: string, size: number, remoteMs?: number}>>}
 */
async function planDownload(sftp, remoteDir, localDir, stats, options = {}) {
    const {mkdir} = await import('node:fs/promises');
    /** @type {Array<{remotePath: string, localPath: string, size: number, remoteMs?: number}>} */
    const pending = [];

    const walk = async (remote, local, prefix) => {
        await mkdir(local, {recursive: true});
        const entries = await call(sftp.readdir.bind(sftp), remote).catch((error) => {
            if (error?.code === 2 || /No such file/i.test(String(error?.message))) return [];
            throw error;
        });
        for (const entry of entries) {
            if (options.signal?.aborted) throw new Error('传输已取消');
            const name = entry.filename;
            if (name === '.' || name === '..') continue;
            const relative = prefix ? `${prefix}/${name}` : name;
            if (isExcluded(relative, options.exclude ?? [])) {
                stats.skipped += 1;
                continue;
            }
            const remotePath = posix.join(remote, name);
            const localPath = join(local, name);
            if (entry.attrs.isDirectory()) {
                stats.dirs += 1;
                await walk(remotePath, localPath, relative);
            } else if (entry.attrs.isFile()) {
                const localInfo = await fsStat(localPath).catch(() => undefined);
                if (localInfo?.isFile() && sameFile(localInfo.size, localInfo.mtimeMs, entry.attrs)) {
                    stats.unchanged += 1;
                    continue;
                }
                pending.push({
                    remotePath,
                    localPath,
                    size: entry.attrs.size ?? 0,
                    remoteMs: remoteMtimeMs(entry.attrs),
                });
            } else {
                stats.skipped += 1;
            }
        }
    };

    await walk(remoteDir, localDir, '');
    return pending;
}

/**
 * 下载：远程目录 → 本地目录。
 *
 * @param {import('ssh2').SFTPWrapper} sftp
 * @param {string} remoteDir
 * @param {string} localDir
 * @param {'overwrite' | 'mirror'} mode
 * @param {SyncOptions} [options]
 * @returns {Promise<SyncStats>}
 */
export async function downloadDirectory(sftp, remoteDir, localDir, mode, options = {}) {
    const stats = {files: 0, dirs: 0, bytes: 0, skipped: 0, unchanged: 0, deleted: 0};
    const exclude = options.exclude ?? [];
    const pending = await planDownload(sftp, remoteDir, localDir, stats, options);

    await runBySize(pending, async (task) => {
        await withRetry(() => call(sftp.fastGet.bind(sftp), task.remotePath, task.localPath));
        if (task.remoteMs !== undefined) {
            await utimes(task.localPath, task.remoteMs / 1000, task.remoteMs / 1000).catch(() => {});
        }
        stats.files += 1;
        stats.bytes += task.size;
    });

    if (mode === 'mirror') {
        const remoteEntries = await listRemoteTree(sftp, remoteDir, '', exclude);
        const remoteSet = new Set(remoteEntries.map((entry) => entry.path));
        const {rm, rmdir} = await import('node:fs/promises');
        for (const entry of (await listLocalTree(localDir, '', exclude)).filter((item) => !item.dir)) {
            if (remoteSet.has(entry.path)) continue;
            await rm(join(localDir, entry.path), {force: true});
            stats.deleted += 1;
        }
        // 本地空目录也收掉；非空时 rmdir 会失败，忽略即可。
        for (const entry of (await listLocalTree(localDir, '', exclude)).filter((item) => item.dir).reverse()) {
            if (remoteSet.has(entry.path)) continue;
            await rmdir(join(localDir, entry.path)).catch(() => {});
            stats.deleted += 1;
        }
    }
    return stats;
}
