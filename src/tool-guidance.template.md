# 工具使用规则

- **读、搜、列、改源码先用 OpenCode 原生工具**：`read` / `grep` / `glob` / `edit` / `write`。
- **远端机器**：`remote_list_servers` 选服务器；命令用 `remote_exec`；文件同步用 `remote_upload` / `remote_download`
  （**不要用 run configuration 或部署来代替同步**）。
- **远程部署映射**（配 deployment、审计遗留、从零部署）→ 加载 `remote-deployment` skill；
  只同步文件仍用 `remote_upload` / `remote_download`。
- **等待异步结果**：有返回值就 await；有状态就轮询终态（命中即返回）；有事件就监听事件。
  不要用固定 `sleep N` 猜时间，超时只作为失败上界。
