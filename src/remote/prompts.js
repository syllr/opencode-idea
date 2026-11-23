// 三条"提示词命令"的正文：`/remote-shell`、`/remote-deploy` 与 `/remote-files`。
//
// 它们不执行任何东西，只往会话里注入一段规则，让模型走本插件的 remote_* 工具，
// 而不是自己拼 ssh / scp。和 `~/.config/opencode/commands/readonly.md` 是同一个思路，
// 区别只是注册在插件里（跟着包分发，不需要用户再放一个 md 文件）。
// hosts.json / deployment 的完整流程归 `remote-deployment` skill，这里只留模式切换。

/**
 * IDE 工具在 OpenCode 里的注册名前缀。
 *
 * 插件把 IDE 侧 MCP server 固定注册成 `ide`，OpenCode 用 server 名做工具前缀 ——
 * 所以模型能调到的名字是 `ide_get_run_configurations`，不是 `get_run_configurations`。
 * 本插件自己的 `remote_*` 工具是普通工具，不带这个前缀。写提示词时一律走这里，
 * 不要手写裸名：两种名字混用会让模型去调一个根本不存在的工具。
 */
export const IDE_TOOL_PREFIX = 'ide_';

/** @param {string} name */
export const ideTool = (name) => `${IDE_TOOL_PREFIX}${name}`;

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
        '   · 返回里带了 runID（且没有 exitCode）说明命令还在远端跑：**不要 sleep、不要等**，',
        '     直接再调 remote_exec 并传 runID；服务端按 2s → 4s → 8s 退避等待，命令一结束立刻返回。',
        '   · 返回里出现 exitCode = 命令**已经结束**，结果给全了：**不要再用这个 runID 调用**。',
        '     不要重跑同一条命令，进程不会因为这次超时被杀',
        '   · **不要用固定 sleep 当等待**：同步接口直接执行，不要 & 到后台；等状态就把条件判断和',
        '     sleep 0.5 写进同一条命令，命中终态就 break；超时只作为失败上界，不猜秒数',
        '   · 常驻命令（docker run 不带 -d、compose up、tail -f、前台 server）不要直接跑：',
        '     看已在跑的服务用 docker exec，要后台就 nohup … > 日志 2>&1 & 再单独读日志',
        '   · & 只加在最后一条命令上：`a && b && nohup c &` 会把整条链扔进后台，后面的命令和它抢时序',
        '3. 名字传错时工具会列出全部候选，按列表重新调用，不要猜',
        '',
        ask
            ? `如果用户没有指定服务器或要执行的命令，先问清楚再调用，不要自己挑一台。\n\n用户本次的要求：${ask}`
            : '用户这次没有说要在哪台机器上做什么。先问清楚：服务器是哪台、要执行的命令是什么，再调用工具。',
    ].join('\n');
}

/**
 * `/remote-deploy` 注入的提示词：部署 = 同步 + 启动，走 IDE 的 `ide_deploy_remote_process`。
 *
 * @param {string} request
 */
export function remoteDeployPrompt(request) {
    const ask = request.trim();
    const list = ideTool('list_remote_processes');
    const configs = ideTool('get_run_configurations');
    const inspect = ideTool('inspect_run_configuration');
    const deploy = ideTool('deploy_remote_process');
    return [
        `【远程部署】本次部署走 IDE 的 ${deploy}，不要自己拼 ssh / scp / rsync。`,
        '',
        `1. 配置名不确定 → 先调 ${list}（项目里所有 Remote Process 配置 + 远端状态）；`,
        `   也可以看 ${configs} 的定义列表。不要猜配置名。`,
        '   · 列表为空时**不要停、也不要得出“部署规则用不上”的结论**：',
        '     项目里只是还没有配置。先加载 `remote-deployment` skill 确认 server 与 deployment',
        '     （server 必须同时存在于 IDE 的 SSH 配置和 `.opencode/remote-shell/hosts.json`；deployment 名取自',
        '     hosts.json 里该 server 的 deployments[].name，localPath 必须是**相对项目根**的路径）；',
        '     再按 `idea-run-config-manager` 的 remote-process 模板建 `.run/<app>@<env>.run.xml`，',
        `     写完用 ${inspect} 静态检查（typeKnown / canRun / warnings），通过后再进第 3 步。`,
        '2. 触发前自检：配置存在、类型是 RemoteProcess、deployment 在 hosts.json 里、localPath 合规。',
        '   不满足就先修：deployment / server 走 `remote-deployment` skill，`.run` 配置走 `idea-run-config-manager`；',
        '   别等触发之后才从错误里找。',
        `3. 部署 → ${deploy}(configurationName)`,
        '   · 它同步 deployment、启动进程 / 容器，并打开一个 Run 标签页给用户看日志',
        '   · deploy-only：点 Stop 只关闭日志跟随，不 kill 远端；已在运行会直接替换',
        '4. 返回 fullOutputPath（本机聚合日志：进度 + 远端 stdout/stderr）',
        '   · 应用自己的业务日志在配置的 Application log directory 里，用 remote_exec 查看',
        '5. 如果用户只要文件同步、不启动进程，用 /remote-files，不要用部署',
        '',
        ask
            ? `用户没有指定配置名时先问清楚，不要自己挑一条。\n\n用户本次的要求：${ask}`
            : `用户这次没有说要部署哪个配置。先调 ${list} 列出候选；列表为空就按第 1 条建配置，` +
                '问清楚应用名与环境，不要自己编一个名字。',
    ].join('\n');
}

/**
 * `/remote-files` 注入的提示词：只做文件上传 / 下载，不启动、不重启远端进程。
 *
 * @param {string} request
 */
export function remoteFilesPrompt(request) {
    const ask = request.trim();
    return [
        '【远程文件同步】本次只做文件上传 / 下载，不启动、不重启远端进程。',
        '',
        '1. deployment 名不确定 → 先调 remote_list_servers（每条 mapping 显示 本地 ↔ 远程）',
        '2. 上传 → remote_upload；下载 → remote_download',
        '3. mode 默认 overwrite（只覆盖 / 新增）；mirror 会删掉目标端多出来的文件，**不可逆**，只在明确要求镜像时用',
        '4. 传输同步返回 files / dirs / bytes，没有进度条、没有 handle 要轮询',
        '5. 要部署（同步 + 启动）用 /remote-deploy，不要用这个命令',
        '6. 同步只走这两个工具；Remote Process 的 run 会启动进程，同步只是它的前置动作',
        '',
        ask
            ? `如果用户没有指定要同步的 deployment，先问清楚再调用，不要自己挑一条。\n\n用户本次的要求：${ask}`
            : '用户这次没有说要同步哪一条 deployment。先调 remote_list_servers 列出候选，问清楚是哪一条、上传还是下载，再动手。',
    ].join('\n');
}

/** 用户看到的简短提示（`metadata.displayText`）。 */
export const REMOTE_SHELL_DISPLAY = '【远程执行】已切到 remote_exec；没指定服务器或命令时会先问你。';
export const REMOTE_DEPLOY_DISPLAY =
    `【远程部署】已切到 ${ideTool('deploy_remote_process')}；没指定 Remote Process 配置时会先问你。`;
export const REMOTE_FILES_DISPLAY = '【远程文件同步】已切到 remote_upload / remote_download；没指定 deployment 时会先问你。';
