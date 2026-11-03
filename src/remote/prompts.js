// 两条"提示词命令"的正文：`/remote-shell` 与 `/remote-deployment`。
//
// 它们不执行任何东西，只往会话里注入一段规则，让模型走本插件的 remote_* 工具，
// 而不是自己拼 ssh / scp。和 `~/.config/opencode/commands/readonly.md` 是同一个思路，
// 区别只是注册在插件里（跟着包分发，不需要用户再放一个 md 文件）。

/**
 * `/remote-shell` 注入的提示词：只负责远程命令，不碰文件同步 / 部署。
 *
 * @param {string} request 命令后面跟的原始文本（可能为空）
 */
export function remoteShellPrompt(request) {
    const ask = request.trim();
    return [
        '【远程执行】本次会话的远程命令一律走本插件的工具，不要用 shell 里的 ssh / scp / rsync。',
        '',
        '1. 服务器名不确定 → 先调 remote_list_servers（列出 IDE / 项目 / 全局三层，带来源）',
        '2. 跑命令 → remote_exec(server, command)，需要目录就传 workingDirectory',
        '   · 每条命令是独立 SSH 连接：cd / export 不跨命令保留',
        '3. 名字传错时工具会列出全部候选，按列表重新调用，不要猜',
        '',
        ask
            ? `如果用户没有指定服务器或要执行的命令，先问清楚再调用，不要自己挑一台。\n\n用户本次的要求：${ask}`
            : '用户这次没有说要在哪台机器上做什么。先问清楚：服务器是哪台、要执行的命令是什么，再调用工具。',
    ].join('\n');
}

/**
 * `/remote-deployment` 注入的提示词：部署 = 同步 + 启动，走 IDE 的 `deploy_remote_process`。
 *
 * @param {string} request
 */
export function remoteDeploymentPrompt(request) {
    const ask = request.trim();
    return [
        '【远程部署】本次部署走 IDE 的 deploy_remote_process，不要自己拼 ssh / scp / rsync。',
        '',
        '1. 配置名不确定 → 先调带项目前缀的 list_remote_processes（项目里所有 Remote Process 配置 + 远端状态）；',
        '   也可以看 get_run_configurations 的定义列表。不要猜配置名。',
        '2. 部署 → 带项目前缀的 deploy_remote_process(configurationName)',
        '   · 它同步 deployment、启动进程 / 容器，并打开一个 Run 标签页给用户看日志',
        '   · deploy-only：点 Stop 只关闭日志跟随，不 kill 远端；已在运行会直接替换',
        '3. 返回 fullOutputPath（本机聚合日志：进度 + 远端 stdout/stderr）',
        '   · 应用自己的业务日志在配置的 Application log directory 里，用 remote_exec 查看',
        '4. 如果用户只要文件同步、不启动进程，用 /remote-sync，不要用部署',
        '',
        ask
            ? `用户没有指定配置名时先问清楚，不要自己挑一条。\n\n用户本次的要求：${ask}`
            : '用户这次没有说要部署哪个配置。先调 list_remote_processes 列出候选，问清楚是哪个 Remote Process 配置，再动手。',
    ].join('\n');
}

/**
 * `/remote-sync` 注入的提示词：只做文件上传 / 下载，不启动、不重启远端进程。
 *
 * @param {string} request
 */
export function remoteSyncPrompt(request) {
    const ask = request.trim();
    return [
        '【远程文件同步】本次只做文件上传 / 下载，不启动、不重启远端进程。',
        '',
        '1. deployment 名不确定 → 先调 remote_list_servers（每条 mapping 显示 本地 ↔ 远程）',
        '2. 上传 → remote_upload；下载 → remote_download',
        '3. mode 默认 overwrite（只覆盖 / 新增）；mirror 会删掉目标端多出来的文件，**不可逆**，只在明确要求镜像时用',
        '4. 传输同步返回 files / dirs / bytes，没有进度条、没有 handle 要轮询',
        '5. 要部署（同步 + 启动）用 /remote-deployment，不要用这个命令',
        '',
        ask
            ? `如果用户没有指定要同步的 deployment，先问清楚再调用，不要自己挑一条。\n\n用户本次的要求：${ask}`
            : '用户这次没有说要同步哪一条 deployment。先调 remote_list_servers 列出候选，问清楚是哪一条、上传还是下载，再动手。',
    ].join('\n');
}

/** 用户看到的简短提示（`metadata.displayText`）。 */
export const REMOTE_SHELL_DISPLAY = '【远程执行】已切到 remote_exec；没指定服务器或命令时会先问你。';
export const REMOTE_DEPLOYMENT_DISPLAY = '【远程部署】已切到 deploy_remote_process；没指定 Remote Process 配置时会先问你。';
export const REMOTE_SYNC_DISPLAY = '【远程文件同步】已切到 remote_upload / remote_download；没指定 deployment 时会先问你。';

/**
 * `/manage-remote-config` 注入的提示词。
 *
 * 纯提示词命令：AI 只改项目里的 `hosts.json`，改完由插件的指纹对账自动推到 IDE，
 * 不需要它再调用任何工具。
 *
 * @param {string} request
 */
export function manageRemoteConfigPrompt(request) {
    const ask = request.trim();
    return [
        '【远程配置】本次只改项目里的 `.opencode/remote-shell/hosts.json`，不要动 IDE 的设置、不要手写别的配置文件。',
        '',
        '改之前先读一遍文件，按现有结构改，不要重排整个文件。',
        '',
        '结构：',
        '```json',
        '{',
        '  "hosts": {',
        '    "<SSH 配置名>": {',
        '      "host": "...", "port": 22, "username": "...", "authType": "PASSWORD", "password": "...",',
        '      "exclude": ["node_modules", "logs"],',
        '      "deployments": [',
        '        { "name": "<deployment 名>", "localPath": "references/middleware", "deployPath": "/远端目录", "exclude": ["target"] }',
        '      ]',
        '    }',
        '  }',
        '}',
        '```',
        '',
        '规则：',
        '1. `hosts` 的 key 是 SSH 配置名（和 IDE 的 SSH Configurations 一致）',
        '2. server 级 `exclude` 对该机器下所有 deployment 生效；deployment 级 `exclude` 叠加在它之上',
        '3. `exclude` 只支持路径前缀或具体文件（`node_modules`、`target`、`logs/app.log`），**不支持 `*` / `?`**',
        '4. 项目里的 `localPath` **必须相对项目根目录**（如 `references/middleware`），不能写 `/Users/...` 这种绝对路径',
        '5. 改完不需要调用工具，插件会自动把 deployment 对齐到 IDE',
        '',
        ask
            ? `用户本次的要求：${ask}`
            : '用户这次没有说要改什么。先问清楚：是要加服务器、加 deployment，还是改 exclude。',
    ].join('\n');
}

/** 用户看到的简短提示（`metadata.displayText`）。 */
export const MANAGE_REMOTE_CONFIG_DISPLAY = '【远程配置】直接改 hosts.json；改完自动对齐到 IDE。';
