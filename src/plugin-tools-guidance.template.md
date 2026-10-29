# 远程机器

远程工具是**插件自己的工具**,不带 `<前缀>_`,IDE 没开也能用 —— 那时服务器与凭据只来自两级 hosts.json。

## 远程命令

- **部署机 / 开发机 / 用户点名的机器上的命令走 `remote_exec`** —— 不要用 `ssh` / `scp` 兜底:宿主机、凭据、
  跳板机都在 IDE 的 Deployment 配置里,自己拼 ssh 反而连不上。名字不确定就先 `remote_list_servers`。
- **每条命令一条独立 SSH 连接**:`cd` / `export` 不跨命令保留 —— 要目录就传 `workingDirectory`,要环境就写进
  命令本身。不要指望上一条命令的 `cd` 还在。
- **同步返回**:命令跑完才返回输出与 `exitCode`,没有增量读,也没有内部超时 —— 卡住的调用由用户取消。
  预计跑很久的命令,自己在远程用 `nohup` / `tmux`,不要指望工具替你保活。

## 工具

- `remote_list_servers` **列出全部可用服务器**,带 `[IDE]` / `[项目]` / `[全局]` 来源标记 —— 三层同名时高优先级覆盖,
  同一个名字只会出现一次;每条 mapping 显示 `本地目录 ↔ 远程目录`。不确定名字时先调它。
- `remote_exec` **在服务器上跑一条命令**,返回 `[服务器名] exitCode N` 加输出。参数只有三个:`server`、
  `command`、可选的 `workingDirectory`(先 `cd` 过去)。
- `remote_upload` / `remote_download` **按 deployment 名同步目录**:默认 `overwrite`(只覆盖 / 新增);
  `mode: "mirror"` 会**删掉目标端多出来的文件**,不可逆,只在明确要求镜像时用。
- **凭据来自 IDE**:IDE 里配好的 SFTP 服务器直接可用,不需要在本地再填一遍。三种认证方式都支持 ——
  `PASSWORD`(密码)、`KEY_PAIR`(私钥)、`OPEN_SSH`(ssh-agent / `~/.ssh/config`)。IDE 没开时退到
  `<项目>/.opencode/remote-shell/hosts.json` 和 `~/.config/remote-shell/hosts.json`。
- **名字传错不会失败成死路**:工具会返回全部候选(服务器或 deployment),按列表里的名字重新调用即可。

**约定**

1. 认证 / 连接失败时会自动刷新一次凭据再重试;仍失败才把错误交回来 —— 看错误里的原因(认证失败 / 拒绝 / 超时)。
2. 传输也是同步的:返回 `files / dirs / bytes`,mirror 时还带 `deleted`;符号链接跳过并计入 `skipped`。
3. 目录同步是把本地目录的**内容**落到远程目录,不会多生成一层同名子目录。

**IDE 配置可以固定到项目**:用户执行 `/persist-remote-config` 后,服务器与 mapping 会写进
`<项目>/.opencode/remote-shell/hosts.json` —— 之后即使 IDE 关掉,`remote_list_servers` 仍然列得出它们。
