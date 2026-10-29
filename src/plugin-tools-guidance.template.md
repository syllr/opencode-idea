# 远程机器

## 远程命令

- **部署机 / 开发机 / 用户点名的机器上的命令走 `remote_exec`**,不要自己拼 `ssh` / `scp`。名字不确定就先
  `remote_list_servers`。
- **每条命令是独立连接**:`cd` / `export` 不跨命令保留,要目录就传 `workingDirectory`。
- **命令跑完才返回**

## 工具

- `remote_list_servers` 列出全部可用服务器(带 `[IDE]` / `[项目]` / `[全局]` 来源)与各自的 mapping。
- `remote_exec` 在服务器上跑一条命令:`server`、`command`、可选的 `workingDirectory`。
- `remote_upload` / `remote_download` 按 deployment 名同步目录。默认 `overwrite`;`mirror` 会删掉目标端多出来的
  文件,只在明确要求镜像时用。
- **名字传错会返回全部候选**,按列表里的名字重新调用即可。

用户执行 `/persist-remote-config` 后,IDE 的服务器与 mapping 会写进项目里的 hosts.json,IDE 关掉也能用。
