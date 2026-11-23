#!/usr/bin/env node
// remote-deployment skill 的维护脚本：audit / upsert / remove。
//
// 只改项目里的 `.opencode/remote-shell/hosts.json`：
//   * 不连远端、不读凭据、不调用 IDE
//   * 不删除 IDE Deployment 面板里的条目（那边只报告，由用户在 IDE 里手工删）
//   * 写入用「临时文件 + rename」，不会留下半个文件
//
// 纯函数（auditHosts / upsertDeployment / removeDeployment）供测试直接调用；
// CLI 只在被当成脚本执行时运行（见文件末尾的 import.meta.url 判断）。

import {existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync} from 'node:fs';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {pathToFileURL} from 'node:url';

const CONFIG_SEGMENTS = ['.opencode', 'remote-shell', 'hosts.json'];

/** hosts.json 的绝对路径。 */
export function hostsConfigPath(projectPath) {
    return join(projectPath, ...CONFIG_SEGMENTS);
}

/**
 * 读 hosts.json 的完整文档与 hosts 对象。
 *
 * 供写操作使用：文件缺失、JSON 非法、结构不对都直接抛错 —— 这些情况下不能猜着改。
 *
 * @param {string} projectPath
 */
function readHostsConfig(projectPath) {
    const file = hostsConfigPath(projectPath);
    if (!existsSync(file)) {
        throw new Error(
            `项目里没有 ${relative(projectPath, file)}。先建 server 条目（host / username / 凭据），` +
            `或让用户在 IDE 里加 SSH 配置后跑 /remote-config-sync。`,
        );
    }
    let document;
    try {
        document = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
        throw new Error(`${relative(projectPath, file)} 不是合法 JSON：${error.message}`);
    }
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
        throw new Error(`${relative(projectPath, file)} 顶层必须是对象。`);
    }
    const hosts = document.hosts;
    if (!hosts || typeof hosts !== 'object' || Array.isArray(hosts)) {
        throw new Error(`${relative(projectPath, file)} 缺少 hosts 对象。`);
    }
    return {file, document, hosts};
}

/** 原子写回；保留 hosts 之外的顶层字段。 */
function writeHostsConfig(file, document, hosts) {
    mkdirSync(dirname(file), {recursive: true});
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({...document, hosts}, null, 2)}\n`, 'utf8');
    renameSync(temporary, file);
}

/**
 * `--exclude a,b` / 数组 → 规范化的排除项。
 *
 * @param {string | string[]} raw
 * @returns {string[]}
 */
export function parseExclude(raw) {
    const items = Array.isArray(raw) ? raw : String(raw).split(',');
    return items
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim().replace(/^\.\//, '').replace(/\/+$/, ''))
        .filter((item) => item !== '');
}

/** 排除项里出现 `*` / `?` 就抛错（与插件 / IDE 的契约一致）。 */
function assertExclude(exclude) {
    for (const pattern of exclude) {
        if (/[*?]/.test(pattern)) {
            throw new Error(
                `exclude 不支持通配符："${pattern}"。写具体路径，例如 "logs/app.log" 或整个目录 "logs"。`,
            );
        }
    }
}

/**
 * 项目级 localPath 的硬规则：相对、且不能逃出项目根。
 *
 * @param {string} projectPath
 * @param {string} localPath
 * @returns {string} 解析后的绝对路径
 */
function resolveProjectLocalPath(projectPath, localPath) {
    const value = localPath.trim();
    if (!value) throw new Error('localPath 不能为空。');
    // hosts.json 跟着仓库走：只用 POSIX 分隔符，Windows 也一样。不要在这里做
    // \ → / 的兼容，否则同一份配置在不同 OS 上会出现两种写法。
    if (value.includes('\\')) {
        throw new Error(`localPath 必须使用 "/"，不能用 "\\"：${localPath}`);
    }
    if (value === '~' || value.startsWith('~/')) {
        throw new Error(`localPath 不能用 ~ 表示家目录：${localPath}`);
    }
    if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
        throw new Error(`localPath 必须是相对项目根目录的路径，不能是绝对路径：${localPath}`);
    }
    if (value.split('/').includes('..')) {
        throw new Error(`localPath 不能包含 ".."，必须落在项目根目录内：${localPath}`);
    }
    const absolute = resolve(projectPath, value);
    const rel = relative(projectPath, absolute);
    if (rel === '..' || rel.startsWith(`..${sep}`)) {
        throw new Error(`localPath 不能逃出项目根目录：${localPath}`);
    }
    return absolute;
}

/** 远端 deployPath：POSIX 绝对路径，不接受 Windows 形式。 */
function resolveDeployPath(deployPath) {
    const value = deployPath.trim();
    if (!value.startsWith('/') || value.includes('\\') || value === '/' || value.split('/').includes('..')) {
        throw new Error(`deployPath 必须是远端绝对路径（/srv/app）：${deployPath}`);
    }
    return value;
}

/**
 * 审计 hosts.json。只读，永远返回报告（不抛错），JSON 坏掉也算一条 error。
 *
 * @param {string} projectPath
 * @returns {{
 *   file: string,
 *   servers: number,
 *   deployments: number,
 *   findings: Array<{ level: 'error' | 'warn', server: string | null, deployment: string | null, message: string }>,
 * }}
 */
export function auditHosts(projectPath) {
    const file = hostsConfigPath(projectPath);
    /** @type {Array<{ level: 'error' | 'warn', server: string | null, deployment: string | null, message: string }>} */
    const findings = [];
    const add = (level, server, deployment, message) => findings.push({level, server, deployment, message});

    if (!existsSync(file)) {
        add('error', null, null, `没有 ${relative(projectPath, file)}；先用项目模板建一份，或跑 /remote-config-sync。`);
        return {file, servers: 0, deployments: 0, findings};
    }

    let document;
    try {
        document = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
        add('error', null, null, `不是合法 JSON：${error.message}`);
        return {file, servers: 0, deployments: 0, findings};
    }
    const hosts = document?.hosts;
    if (!hosts || typeof hosts !== 'object' || Array.isArray(hosts)) {
        add('error', null, null, '缺少 hosts 对象。');
        return {file, servers: 0, deployments: 0, findings};
    }

    /** @type {Map<string, string>} deployment 名 → 首次出现的 server */
    const names = new Map();
    let deploymentCount = 0;

    for (const [serverName, entry] of Object.entries(hosts)) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            add('error', serverName, null, '条目不是对象。');
            continue;
        }
        if (typeof entry.host !== 'string' || entry.host.trim() === '') {
            add('warn', serverName, null, '没有 host：只能靠 IDE 或全局 hosts.json 补连接信息。');
        }
        if (typeof entry.username !== 'string' || entry.username.trim() === '') {
            add('warn', serverName, null, '没有 username：remote_exec / remote_upload 会连不上。');
        }
        if (entry.exclude !== undefined) {
            if (!Array.isArray(entry.exclude)) {
                add('error', serverName, null, 'server 级 exclude 必须是字符串数组。');
            } else {
                try {
                    assertExclude(parseExclude(entry.exclude));
                } catch (error) {
                    add('error', serverName, null, `server 级 ${error.message}`);
                }
            }
        }
        if (entry.deployments === undefined) continue;
        if (!Array.isArray(entry.deployments)) {
            add('error', serverName, null, 'deployments 不是数组。');
            continue;
        }

        for (const [index, raw] of entry.deployments.entries()) {
            const deployment = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
            if (!deployment) {
                add('error', serverName, `#${index}`, '不是对象。');
                continue;
            }
            const name = typeof deployment.name === 'string' ? deployment.name.trim() : '';
            const localPath = typeof deployment.localPath === 'string' ? deployment.localPath.trim() : '';
            const deployPath = typeof deployment.deployPath === 'string' ? deployment.deployPath.trim() : '';

            if (!name) {
                add('error', serverName, `#${index}`, '缺 name。');
            } else {
                if (localPath && deployPath) deploymentCount += 1;
                const previous = names.get(name);
                if (previous !== undefined) {
                    add('error', serverName, name, `deployment 名重复：${name}（${previous} / ${serverName}）。`);
                } else {
                    names.set(name, serverName);
                }
            }

            if (!localPath) {
                add('error', serverName, name || `#${index}`, '缺 localPath。');
            } else {
                try {
                    const absolute = resolveProjectLocalPath(projectPath, localPath);
                    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
                        add('warn', serverName, name || `#${index}`, `localPath 目录不存在：${localPath}`);
                    }
                } catch (error) {
                    add('error', serverName, name || `#${index}`, error.message);
                }
            }

            if (!deployPath) {
                add('error', serverName, name || `#${index}`, '缺 deployPath。');
            } else {
                try {
                    resolveDeployPath(deployPath);
                } catch (error) {
                    add('error', serverName, name || `#${index}`, error.message);
                }
            }

            if (deployment.exclude !== undefined) {
                if (!Array.isArray(deployment.exclude)) {
                    add('error', serverName, name || `#${index}`, 'exclude 必须是字符串数组。');
                } else {
                    try {
                        assertExclude(parseExclude(deployment.exclude));
                    } catch (error) {
                        add('error', serverName, name || `#${index}`, error.message);
                    }
                }
            }
        }
    }

    return {file, servers: Object.keys(hosts).length, deployments: deploymentCount, findings};
}

/**
 * 新增或更新一条 deployment。
 *
 * 只动这一条：同 server 的其它 deployment、其它 server、server 自己的连接字段都原样保留。
 *
 * @param {string} projectPath
 * @param {{ server: string, name: string, localPath: string, deployPath: string, exclude?: string[] }} input
 */
export function upsertDeployment(projectPath, input) {
    const server = typeof input.server === 'string' ? input.server.trim() : '';
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const localPath = typeof input.localPath === 'string' ? input.localPath.trim() : '';
    const deployPath = typeof input.deployPath === 'string' ? input.deployPath.trim() : '';

    if (!server) throw new Error('缺少 --server。');
    if (!name) throw new Error('缺少 --name。');
    if (!localPath) throw new Error('缺少 --local-path。');
    if (!deployPath) throw new Error('缺少 --deploy-path。');

    const {file, document, hosts} = readHostsConfig(projectPath);
    const entry = hosts[server];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        const available = Object.keys(hosts);
        throw new Error(
            `hosts.json 里没有 server "${server}"。现有：${available.length > 0 ? available.join('、') : '（无）'}。` +
            `先补 server 条目（host / username / 凭据），或让用户在 IDE 里加 SSH 配置后跑 /remote-config-sync。`,
        );
    }
    if (entry.deployments !== undefined && !Array.isArray(entry.deployments)) {
        throw new Error(`server "${server}" 的 deployments 不是数组，先修好再写。`);
    }

    const localAbsolute = resolveProjectLocalPath(projectPath, localPath);
    const normalizedDeployPath = resolveDeployPath(deployPath);
    const exclude = input.exclude === undefined ? undefined : parseExclude(input.exclude);
    if (exclude) assertExclude(exclude);

    const deployments = entry.deployments ?? [];
    const index = deployments.findIndex((item) => item && typeof item === 'object' && item.name === name);
    const next = {name, localPath, deployPath: normalizedDeployPath};
    if (exclude !== undefined) next.exclude = exclude;
    let action;
    if (index >= 0) {
        deployments[index] = {...deployments[index], ...next};
        action = 'updated';
    } else {
        deployments.push(next);
        action = 'created';
    }
    entry.deployments = deployments;

    // 全局唯一：别的 server 上已有同名 deployment 时不要写进去。
    for (const [otherServer, otherEntry] of Object.entries(hosts)) {
        if (otherServer === server) continue;
        const list = Array.isArray(otherEntry?.deployments) ? otherEntry.deployments : [];
        if (list.some((item) => item && item.name === name)) {
            throw new Error(`deployment 名 "${name}" 已在 server "${otherServer}" 上使用，名字必须全局唯一。`);
        }
    }

    writeHostsConfig(file, document, hosts);

    const warnings = [];
    if (!existsSync(localAbsolute) || !statSync(localAbsolute).isDirectory()) {
        warnings.push(`localPath 目录当前不存在：${localPath}（构建产物生成后再同步即可）`);
    }
    return {action, file, server, deployment: next, warnings};
}

/**
 * 删除一条 deployment。`yes` 必须为 true，避免手滑。
 *
 * @param {string} projectPath
 * @param {{ name: string, server?: string, yes?: boolean }} input
 */
export function removeDeployment(projectPath, input) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const server = typeof input.server === 'string' ? input.server.trim() : '';
    if (!name) throw new Error('缺少 --name。');
    if (input.yes !== true) {
        throw new Error(`删除 "${name}" 必须显式加 --yes；先确认没有 RemoteProcess 配置还在引用它。`);
    }

    const {file, document, hosts} = readHostsConfig(projectPath);
    const targets = server ? [[server, hosts[server]]] : Object.entries(hosts);
    if (server && (!hosts[server] || typeof hosts[server] !== 'object')) {
        throw new Error(`hosts.json 里没有 server "${server}"。`);
    }

    /** @type {{ server: string, deployments: unknown[], index: number } | null} */
    let found = null;
    for (const [serverName, entry] of targets) {
        const deployments = Array.isArray(entry?.deployments) ? entry.deployments : [];
        const index = deployments.findIndex((item) => item && typeof item === 'object' && item.name === name);
        if (index < 0) continue;
        if (found) {
            throw new Error(`deployment "${name}" 在多台 server 上都有，必须用 --server 指定要删哪一条。`);
        }
        found = {server: serverName, deployments, index};
    }
    if (!found) throw new Error(`没有名为 "${name}" 的 deployment。`);

    found.deployments.splice(found.index, 1);
    writeHostsConfig(file, document, hosts);
    return {file, server: found.server, removed: name};
}

/**
 * 解析 `--key value` / `--flag`。
 *
 * @param {string[]} argv
 */
export function parseArgs(argv) {
    /** @type {{ _: string[], [key: string]: unknown }} */
    const out = {_: []};
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (typeof arg !== 'string') continue;
        if (!arg.startsWith('--')) {
            out._.push(arg);
            continue;
        }
        const key = arg.slice(2);
        if (key === 'yes' || key === 'json' || key === 'help') {
            out[key] = true;
            continue;
        }
        const value = argv[index + 1];
        if (value === undefined || (typeof value === 'string' && value.startsWith('--'))) {
            throw new Error(`--${key} 缺少值。`);
        }
        out[key] = value;
        index += 1;
    }
    return out;
}

const USAGE = `用法：
  node hosts.mjs audit  --project <项目根> [--json]
  node hosts.mjs upsert --project <项目根> --server <名> --name <deployment> \\
       --local-path <相对路径> --deploy-path <远端绝对路径> [--exclude a,b]
  node hosts.mjs remove --project <项目根> --name <deployment> [--server <名>] --yes`;

function printAudit(report) {
    console.log(`hosts.json: ${report.file}`);
    console.log(`server ${report.servers} 台，deployment ${report.deployments} 条`);
    if (report.findings.length === 0) {
        console.log('没有发现问题。');
        return;
    }
    for (const finding of report.findings) {
        const where = [finding.server, finding.deployment].filter(Boolean).join(' / ');
        console.log(`- [${finding.level}] ${where ? `${where}：` : ''}${finding.message}`);
    }
}

/**
 * CLI 入口。
 *
 * @param {string[]} argv
 * @param {string} cwd
 * @returns {number} 退出码
 */
export function main(argv, cwd = process.cwd()) {
    let args;
    try {
        args = parseArgs(argv);
    } catch (error) {
        console.error(error.message);
        return 2;
    }
    const command = args._[0];
    if (args.help || !command) {
        console.log(USAGE);
        return args.help ? 0 : 2;
    }
    const projectPath = resolve(cwd, typeof args.project === 'string' ? args.project : '.');

    try {
        if (command === 'audit') {
            const report = auditHosts(projectPath);
            if (args.json) console.log(JSON.stringify(report, null, 2));
            else printAudit(report);
            return report.findings.some((finding) => finding.level === 'error') ? 1 : 0;
        }
        if (command === 'upsert') {
            const result = upsertDeployment(projectPath, {
                server: typeof args.server === 'string' ? args.server : '',
                name: typeof args.name === 'string' ? args.name : '',
                localPath: typeof args['local-path'] === 'string' ? args['local-path'] : '',
                deployPath: typeof args['deploy-path'] === 'string' ? args['deploy-path'] : '',
                exclude: args.exclude === undefined ? undefined : String(args.exclude),
            });
            console.log(
                `${result.action === 'created' ? '已新增' : '已更新'} deployment "${result.deployment.name}"` +
                `（server ${result.server}）→ ${result.file}`,
            );
            for (const warning of result.warnings) console.log(`⚠ ${warning}`);
            console.log('下一次工具调用会自动对账；要立刻确认就让用户跑 /remote-config-sync。');
            return 0;
        }
        if (command === 'remove') {
            const result = removeDeployment(projectPath, {
                name: typeof args.name === 'string' ? args.name : '',
                server: typeof args.server === 'string' ? args.server : undefined,
                yes: args.yes === true,
            });
            console.log(`已删除 deployment "${result.removed}"（server ${result.server}）→ ${result.file}`);
            return 0;
        }
        console.error(`未知命令：${command}\n\n${USAGE}`);
        return 2;
    } catch (error) {
        console.error(error.message);
        return 2;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    process.exitCode = main(process.argv.slice(2));
}
