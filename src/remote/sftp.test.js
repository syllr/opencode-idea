// SFTP 层的路径逻辑测试（真实的传输只能手工验证）。

import {describe, expect, it} from 'vitest';

import {ensureRemoteDir} from './sftp.js';

/** 一个只实现 stat / mkdir 的假 SFTP，用来观察逐级建目录的顺序。 */
function fakeSftp({existing = []} = {}) {
    const dirs = new Set(existing);
    const created = [];
    return {
        created,
        stat(path, callback) {
            if (dirs.has(path)) callback(null, {isDirectory: () => true});
            else {
                const error = new Error('No such file');
                error.code = 2;
                callback(error);
            }
        },
        mkdir(path, callback) {
            created.push(path);
            dirs.add(path);
            callback(null);
        },
    };
}

describe('ensureRemoteDir', () => {
    it('逐级建目录', async () => {
        const sftp = fakeSftp();
        await ensureRemoteDir(sftp, '/srv/app/static');
        expect(sftp.created).toEqual(['/srv', '/srv/app', '/srv/app/static']);
    });

    it('已存在的层级不重复建', async () => {
        const sftp = fakeSftp({existing: ['/srv', '/srv/app']});
        await ensureRemoteDir(sftp, '/srv/app/static');
        expect(sftp.created).toEqual(['/srv/app/static']);
    });

    it('根目录什么都不做', async () => {
        const sftp = fakeSftp();
        await ensureRemoteDir(sftp, '/');
        expect(sftp.created).toEqual([]);
    });
});
