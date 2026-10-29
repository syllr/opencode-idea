// 两条"提示词命令"的正文：`/remote-shell` 与 `/remote-deployment`。
//
// 它们不执行任何东西，只往会话里注入一段规则，让模型走本插件的 remote_* 工具，
// 而不是自己拼 ssh / scp。和 `~/.config/opencode/commands/readonly.md` 是同一个思路，
// 区别只是注册在插件里（跟着包分发，不需要用户再放一个 md 文件）。

/**
 * `/remote-shell` 注入的提示词。
 *
 * @param {string} request 命令后面跟的原始文本（可能为空）
 */
export function remoteShellPrompt(request) {
    const ask = request.trim();
    return [
        '【远程执行】本次会话的远程操作一律走本插件的工具，不要用 shell 里的 ssh / scp / rsync。',
        '',
        '1. 服务器名不确定 → 先调 remote_list_servers（列出 IDE / 项目 / 全局三层，带来源）',
        '2. 跑命令 → remote_exec(server, command)，需要目录就传 workingDirectory',
        '   · 每条命令是独立 SSH 连接：cd / export 不跨命令保留',
        '3. 传文件 → remote_upload / remote_download（按 deployment 名）',
        '4. 名字传错时工具会列出全部候选，按列表重新调用，不要猜',
        '',
        ask
            ? `如果用户没有指定服务器或要执行的命令，先问清楚再调用，不要自己挑一台。\n\n用户本次的要求：${ask}`
            : '用户这次没有说要在哪台机器上做什么。先问清楚：服务器是哪台、要执行的命令是什么，再调用工具。',
    ].join('\n');
}

/**
 * `/remote-deployment` 注入的提示词。
 *
 * @param {string} request
 */
export function remoteDeploymentPrompt(request) {
    const ask = request.trim();
    return [
        '【远程部署同步】本次会话的传输一律用 remote_upload / remote_download，不要用 scp / rsync / ssh。',
        '',
        '1. deployment 名不确定 → 先调 remote_list_servers（每条 mapping 显示 本地 ↔ 远程）',
        '2. 上传 → remote_upload；下载 → remote_download',
        '3. mode 默认 overwrite（只覆盖 / 新增）；mirror 会删掉目标端多出来的文件，**不可逆**，只在明确要求镜像时用',
        '4. 传输同步返回 files / dirs / bytes，没有进度条、没有 handle 要轮询',
        '',
        ask
            ? `如果用户没有指定要同步的 deployment，先问清楚再调用，不要自己挑一条。\n\n用户本次的要求：${ask}`
            : '用户这次没有说要同步哪一条 deployment。先调 remote_list_servers 列出候选，问清楚是哪一条、上传还是下载，再动手。',
    ].join('\n');
}

/** 用户看到的简短提示（`metadata.displayText`）。 */
export const REMOTE_SHELL_DISPLAY = '【远程执行】已切到 remote_* 工具模式；没指定服务器或命令时会先问你。';
export const REMOTE_DEPLOYMENT_DISPLAY = '【远程部署同步】已切到 remote_upload / remote_download；没指定 deployment 时会先问你。';
