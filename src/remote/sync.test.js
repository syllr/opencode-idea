// 目录同步的沙箱测试：真实的 uploadDirectory / downloadDirectory，配一个内存 SFTP。
//
// 这里盯的是 **mapping 语义**：本地目录内容落到远程目录、嵌套层级、overwrite 不删多余、
// mirror 删多余。传输出错（认证、断线）不在这里测。

import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, posix} from 'node:path';

import {afterAll, describe, expect, it} from 'vitest';

import {downloadDirectory, uploadDirectory} from './sftp.js';

const workDir = mkdtempSync(join(tmpdir(), 'remote-sync-'));
afterAll(() => rmSync(workDir, {recursive: true, force: true}));

/**
 * 内存 SFTP：一张 path → { dir: true } | { dir: false, data: string, mtime: number } 的表。
 *
 * 只实现这几次同步会用到的方法，行为对齐 ssh2：stat 对不存在的路径回 code 2，
 * fastPut 写入后把 mtime 记成写入时刻（不保留源时间），差量靠随后的 utimes 修正。
 */
function memorySftp(initial = {}) {
    const nodes = new Map([['/', {dir: true}]]);
    for (const [path, data] of Object.entries(initial)) {
        const parts = path.split('/').filter(Boolean);
        let current = '';
        for (const part of parts.slice(0, -1)) {
            current += `/${part}`;
            if (!nodes.has(current)) nodes.set(current, {dir: true});
        }
        nodes.set(path, {dir: false, data, mtime: 0});
    }

    const missing = () => {
        const error = new Error('No such file');
        error.code = 2;
        return error;
    };

    const attrsOf = (node) => ({
        isDirectory: () => node.dir,
        isFile: () => !node.dir,
        size: node.dir ? 0 : Buffer.byteLength(node.data),
        mtime: node.mtime,
    });

    return {
        nodes,
        stat(path, callback) {
            const node = nodes.get(posix.normalize(path));
            if (!node) return callback(missing());
            callback(null, attrsOf(node));
        },
        mkdir(path, callback) {
            nodes.set(posix.normalize(path), {dir: true});
            callback(null);
        },
        readdir(path, callback) {
            const dir = posix.normalize(path);
            if (!nodes.get(dir)?.dir) return callback(missing());
            const prefix = dir === '/' ? '/' : `${dir}/`;
            const entries = [];
            for (const [nodePath, node] of nodes) {
                if (!nodePath.startsWith(prefix)) continue;
                const rest = nodePath.slice(prefix.length);
                if (!rest || rest.includes('/')) continue;
                entries.push({filename: rest, attrs: attrsOf(node)});
            }
            callback(null, entries);
        },
        fastPut(localPath, remotePath, callback) {
            nodes.set(posix.normalize(remotePath), {
                dir: false,
                data: readFileSync(localPath, 'utf8'),
                mtime: Math.floor(Date.now() / 1000),
            });
            callback(null);
        },
        fastGet(remotePath, localPath, callback) {
            const node = nodes.get(posix.normalize(remotePath));
            if (!node) return callback(missing());
            writeFileSync(localPath, node.data);
            callback(null);
        },
        utimes(remotePath, atime, mtime, callback) {
            const node = nodes.get(posix.normalize(remotePath));
            if (!node) return callback(missing());
            node.mtime = mtime;
            callback(null);
        },
        unlink(path, callback) {
            nodes.delete(posix.normalize(path));
            callback(null);
        },
        rmdir(path, callback) {
            nodes.delete(posix.normalize(path));
            callback(null);
        },
    };
}

/** 建一棵本地目录，返回根路径。`files` 的 key 是相对路径。 */
function localTree(files) {
    const root = mkdtempSync(join(workDir, 'tree-'));
    for (const [relative, content] of Object.entries(files)) {
        const full = join(root, relative);
        mkdirSync(join(full, '..'), {recursive: true});
        writeFileSync(full, content);
    }
    return root;
}

/** 把内存 SFTP 的某棵子树拍平成 `相对路径: 内容`，方便整体断言。 */
function snapshot(sftp, root) {
    const result = {};
    const prefix = root === '/' ? '/' : `${root}/`;
    for (const [path, node] of sftp.nodes) {
        if (!path.startsWith(prefix) || path === root) continue;
        result[path.slice(prefix.length)] = node.dir ? '(dir)' : node.data;
    }
    return result;
}

describe('uploadDirectory', () => {
    it('把本地目录的内容落到远程目录（不多生成一层目录名）', async () => {
        const local = localTree({
            'a.txt': 'A',
            'sub/b.txt': 'B',
            'empty/.keep': '',
        });
        const sftp = memorySftp();

        await uploadDirectory(sftp, local, '/srv/app', 'overwrite');

        expect(snapshot(sftp, '/srv/app')).toEqual({
            'a.txt': 'A',
            'sub': '(dir)',
            'sub/b.txt': 'B',
            'empty': '(dir)',
            'empty/.keep': '',
        });
    });

    it('overwrite 只覆盖同名文件，远程多余的文件留着', async () => {
        const local = localTree({'a.txt': 'new'});
        const sftp = memorySftp({
            '/srv/app/a.txt': 'old',
            '/srv/app/stale.txt': 'keep me',
        });

        const stats = await uploadDirectory(sftp, local, '/srv/app', 'overwrite');

        expect(snapshot(sftp, '/srv/app')).toEqual({'a.txt': 'new', 'stale.txt': 'keep me'});
        expect(stats.files).toBe(1);
        expect(stats.deleted).toBe(0);
    });

    it('mirror 删掉远程多出来的文件与目录', async () => {
        const local = localTree({'a.txt': 'new'});
        const sftp = memorySftp({
            '/srv/app/a.txt': 'old',
            '/srv/app/stale.txt': 'gone',
            '/srv/app/old/sub.txt': 'gone too',
        });

        const stats = await uploadDirectory(sftp, local, '/srv/app', 'mirror');

        expect(snapshot(sftp, '/srv/app')).toEqual({'a.txt': 'new'});
        // stale.txt + old/sub.txt + old 目录
        expect(stats.deleted).toBe(3);
    });

    it('统计 files / dirs / bytes', async () => {
        const local = localTree({'a.txt': 'AAAA', 'sub/b.txt': 'BB'});
        const sftp = memorySftp();

        const stats = await uploadDirectory(sftp, local, '/srv/app', 'overwrite');

        expect(stats.files).toBe(2);
        expect(stats.dirs).toBe(1);
        expect(stats.bytes).toBe(6);
        expect(stats.skipped).toBe(0);
        expect(stats.unchanged).toBe(0);
    });

    it('第二次只传变化的文件，没变的计入 unchanged', async () => {
        const local = localTree({'a.txt': 'A', 'b.txt': 'B'});
        const sftp = memorySftp();

        const first = await uploadDirectory(sftp, local, '/srv/app', 'overwrite');
        expect(first.files).toBe(2);
        expect(first.unchanged).toBe(0);

        const second = await uploadDirectory(sftp, local, '/srv/app', 'overwrite');
        expect(second.files).toBe(0);
        expect(second.unchanged).toBe(2);
        expect(second.bytes).toBe(0);

        writeFileSync(join(local, 'b.txt'), 'B2');
        const third = await uploadDirectory(sftp, local, '/srv/app', 'overwrite');
        expect(third.files).toBe(1);
        expect(third.unchanged).toBe(1);
        expect(snapshot(sftp, '/srv/app')['b.txt']).toBe('B2');
    });
});

describe('downloadDirectory', () => {
    it('把远程目录的内容拉到本地目录', async () => {
        const local = join(workDir, 'downloaded');
        const sftp = memorySftp({
            '/srv/app/a.txt': 'A',
            '/srv/app/sub/b.txt': 'B',
        });

        await downloadDirectory(sftp, '/srv/app', local, 'overwrite');

        expect(readFileSync(join(local, 'a.txt'), 'utf8')).toBe('A');
        expect(readFileSync(join(local, 'sub/b.txt'), 'utf8')).toBe('B');
    });

    it('第二次下载跳过没变的文件', async () => {
        const local = join(workDir, 'download-skip');
        const sftp = memorySftp({'/srv/app/a.txt': 'A'});

        const first = await downloadDirectory(sftp, '/srv/app', local, 'overwrite');
        expect(first.files).toBe(1);

        const second = await downloadDirectory(sftp, '/srv/app', local, 'overwrite');
        expect(second.files).toBe(0);
        expect(second.unchanged).toBe(1);
    });

    it('overwrite 保留本地多余文件，mirror 删掉它们', async () => {
        const local = localTree({'a.txt': 'old', 'stale.txt': 'keep me'});
        const sftp = memorySftp({'/srv/app/a.txt': 'new'});

        await downloadDirectory(sftp, '/srv/app', local, 'overwrite');
        expect(readFileSync(join(local, 'stale.txt'), 'utf8')).toBe('keep me');

        await downloadDirectory(sftp, '/srv/app', local, 'mirror');
        expect(readFileSync(join(local, 'a.txt'), 'utf8')).toBe('new');
        expect(() => readFileSync(join(local, 'stale.txt'), 'utf8')).toThrow();
    });
});
