# 工具使用规则

- **读、搜、列、改源码先用 OpenCode 原生工具**：`read` / `grep` / `glob` / `edit` / `write`。
- **远端机器**：`remote_list_servers` 选服务器；命令用 `remote_exec`；文件同步用 `remote_upload` / `remote_download`。

<!-- ide-only:start -->
- **IDE 工具补原生工具做不到的**：`ide_search_symbol`（带 `include_external: true`）、`ide_analyze_calls`、
  `ide_rename_refactoring`、`ide_lint_files` / `ide_get_file_problems`、`ide_build_project`、
  `ide_apply_patch`、`ide_reformat_file`。IDE 工具只作用于当前项目。
- **校验**：改一处收尾跑一次 `ide_lint_files`；改一大片 / 动接口 / 动依赖，全部改完跑一次
  `ide_build_project`；全仓检查只在最后跑一次。
- **Run / Deploy**：Run 是调试，Stop 会停远端进程 / 删容器；Deploy 是发布，Stop 只关日志。
  查远端状态用 `ide_list_remote_processes`；用户说“部署 / 发布 / 上线”用 `ide_deploy_remote_process`；
  说“跑一下 / 启动 / 调试 / 重启”用 `ide_rerun_run_configuration`。
- 启动 / 停止远端进程或部署用上面的 IDE 工具，不要自己拼 `nohup` / `docker run`。
<!-- ide-only:end -->
