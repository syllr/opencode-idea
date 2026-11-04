# 工具使用规则

- **读、搜、列、改源码先用 OpenCode 原生工具**：`read` / `grep` / `glob` / `edit` / `write`。
- **远端机器**：`remote_list_servers` 选服务器；命令用 `remote_exec`；文件同步用 `remote_upload` / `remote_download`
  （**不要用 run configuration 或部署来代替同步**）。
