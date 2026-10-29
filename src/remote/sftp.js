// SFTP 目录同步：`overwrite`（只覆盖/新增）与 `mirror`（再删掉对方多余的文件）。
//
// 语义与 rsync 的尾斜杠一致：把 `localPath` 目录的**内容**同步到 `deployPath`，
// 不会额外生成一层 `localPath` 的目录名。
//
// 符号链接跳过并计数 —— 跟随链接会把目标目录之外的整棵树拖进来，那是另一个决定。

import {readdir, stat as fsStat} from 'node:fs/promises';
import {join} from 'node:path';
import {posix} from 'node:path';

/**
 * @typedef {{
 *   files: number,
 *   dirs: number,
 *   bytes: number,
 *   skipped: number,
 *   deleted: number,
 * }} SyncStats
 */

/** ssh2 的回调式 API → Promise。 */
function call(fn, ...args) {
    return new Promise((resolve, reject) => {
        fn(...args, (error, value) => (error ? reject(error) : resolve(value)));
    });
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
 * 递归上传一个本地目录。
 *
 * @param {import('ssh2').SFTPWrapper} sftp
 * @param {string} localDir
 * @param {string} remoteDir
 * @param {SyncStats} stats
 * @param {{ signal?: AbortSignal }} [options]
 */
async function uploadTree(sftp, localDir, remoteDir, stats, options = {}) {
    await ensureRemoteDir(sftp, remoteDir);
    const entries = await readdir(localDir, {withFileTypes: true});
    for (const entry of entries) {
        if (options.signal?.aborted) throw new Error('传输已取消');
        const localPath = join(localDir, entry.name);
        const remotePath = posix.join(remoteDir, entry.name);
        if (entry.isDirectory()) {
            stats.dirs += 1;
            await uploadTree(sftp, localPath, remotePath, stats, options);
        } else if (entry.isFile()) {
            const info = await fsStat(localPath);
            await call(sftp.fastPut.bind(sftp), localPath, remotePath);
            stats.files += 1;
            stats.bytes += info.size;
        } else {
            stats.skipped += 1;
        }
    }
}

/**
 * 递归读取远程目录的条目（相对路径 + 是否目录），用于 mirror 的差异删除。
 *
 * @param {import('ssh2').SFTPWrapper} sftp
 * @param {string} remoteDir
 * @param {string} [prefix]
 * @returns {Promise<{ path: string, dir: boolean }[]>}
 */
async function listRemoteTree(sftp, remoteDir, prefix = '') {
    const entries = await call(sftp.readdir.bind(sftp), remoteDir).catch((error) => {
        if (error?.code === 2 || /No such file/i.test(String(error?.message))) return [];
        throw error;
    });
    const result = [];
    for (const entry of entries) {
        const name = entry.filename;
        if (name === '.' || name === '..') continue;
        const relative = prefix ? `${prefix}/${name}` : name;
        const isDir = entry.attrs.isDirectory();
        result.push({path: relative, dir: isDir});
        if (isDir) {
            result.push(...await listRemoteTree(sftp, posix.join(remoteDir, name), relative));
        }
    }
    return result;
}

/**
 * 递归列出本地目录的相对条目，用于 mirror。
 *
 * @param {string} localDir
 * @param {string} [prefix]
 * @returns {Promise<{ path: string, dir: boolean }[]>}
 */
async function listLocalTree(localDir, prefix = '') {
    const entries = await readdir(localDir, {withFileTypes: true}).catch(() => []);
    const result = [];
    for (const entry of entries) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            result.push({path: relative, dir: true});
            result.push(...await listLocalTree(join(localDir, entry.name), relative));
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
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<SyncStats>}
 */
export async function uploadDirectory(sftp, localDir, remoteDir, mode, options = {}) {
    const stats = {files: 0, dirs: 0, bytes: 0, skipped: 0, deleted: 0};
    await uploadTree(sftp, localDir, remoteDir, stats, options);

    if (mode === 'mirror') {
        const localSet = new Set((await listLocalTree(localDir)).map((entry) => entry.path));
        const remoteEntries = await listRemoteTree(sftp, remoteDir);
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
 * 递归下载一个远程目录。
 *
 * @param {import('ssh2').SFTPWrapper} sftp
 * @param {string} remoteDir
 * @param {string} localDir
 * @param {SyncStats} stats
 * @param {{ signal?: AbortSignal }} [options]
 */
async function downloadTree(sftp, remoteDir, localDir, stats, options = {}) {
    const {mkdir} = await import('node:fs/promises');
    await mkdir(localDir, {recursive: true});
    const entries = await call(sftp.readdir.bind(sftp), remoteDir).catch((error) => {
        if (error?.code === 2 || /No such file/i.test(String(error?.message))) return [];
        throw error;
    });
    for (const entry of entries) {
        if (options.signal?.aborted) throw new Error('传输已取消');
        const name = entry.filename;
        if (name === '.' || name === '..') continue;
        const remotePath = posix.join(remoteDir, name);
        const localPath = join(localDir, name);
        if (entry.attrs.isDirectory()) {
            stats.dirs += 1;
            await downloadTree(sftp, remotePath, localPath, stats, options);
        } else if (entry.attrs.isFile()) {
            await call(sftp.fastGet.bind(sftp), remotePath, localPath);
            stats.files += 1;
            stats.bytes += entry.attrs.size ?? 0;
        } else {
            stats.skipped += 1;
        }
    }
}

/**
 * 下载：远程目录 → 本地目录。
 *
 * @param {import('ssh2').SFTPWrapper} sftp
 * @param {string} remoteDir
 * @param {string} localDir
 * @param {'overwrite' | 'mirror'} mode
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<SyncStats>}
 */
export async function downloadDirectory(sftp, remoteDir, localDir, mode, options = {}) {
    const stats = {files: 0, dirs: 0, bytes: 0, skipped: 0, deleted: 0};
    await downloadTree(sftp, remoteDir, localDir, stats, options);

    if (mode === 'mirror') {
        const remoteEntries = await listRemoteTree(sftp, remoteDir);
        const remoteSet = new Set(remoteEntries.map((entry) => entry.path));
        const {rm, rmdir} = await import('node:fs/promises');
        for (const entry of (await listLocalTree(localDir)).filter((item) => !item.dir)) {
            if (remoteSet.has(entry.path)) continue;
            await rm(join(localDir, entry.path), {force: true});
            stats.deleted += 1;
        }
        // 本地空目录也收掉；非空时 rmdir 会失败，忽略即可。
        for (const entry of (await listLocalTree(localDir)).filter((item) => item.dir).reverse()) {
            if (remoteSet.has(entry.path)) continue;
            await rmdir(join(localDir, entry.path)).catch(() => {});
        }
    }
    return stats;
}
