# 工具使用规则

## 总原则

1. **读、搜、列、改源码先用 OpenCode 原生工具**：`read` / `grep` / `glob` / `edit` / `write`。
   `shell` 只用于运行命令、测试、构建；不要用 `sed` / `python` 改源码。

<!-- ide-only:start -->
## IDE 工具

本会话接入一个 JetBrains 项目；IDE 工具统一使用 `ide_` 前缀。

- **原生工具做不到的，才用 IDE 工具**：
  - 符号 / 定义 / 依赖源码：`ide_search_symbol`（带 `include_external: true`）+ `ide_read_file`
  - 调用关系：`ide_analyze_calls`
  - 改名：`ide_rename_refactoring`
  - 单文件检查：`ide_lint_files` / `ide_get_file_problems`
  - 跨模块构建：`ide_build_project`
  - 多文件同段修改：`ide_apply_patch`
  - 代码格式化：`ide_reformat_file`
- **IDE 工具只作用于当前项目**，项目外路径不要用。

### 校验

- 改一处：收尾跑一次 `ide_lint_files`
- 改一大片 / 动接口 / 动依赖：全部改完跑一次 `ide_build_project`
- 全仓检查只在最后跑一次

### 运行配置与远端进程

- 普通 Run 会话：`ide_list_running_configurations` 看状态，
  `ide_rerun_run_configuration` 启动 / 重启，`ide_stop_run_configuration` 停止。
- Remote Process：`ide_list_remote_processes` 查远端真实状态；`ide_deploy_remote_process` 部署。
  - Run = 调试：Stop 会停远端进程 / 删容器
  - Deploy = 发布：Stop 只关日志，不 kill 远端
  - 用户说“部署 / 发布 / 上线”用 Deploy；说“跑一下 / 启动 / 调试 / 重启”用 Rerun
- 日志：`fullOutputPath` 是本机聚合日志；应用自己的日志在 Application log directory，
  用 `remote_exec` 查看。

<!-- ide-only:end -->
## 远端工具（插件自带）

这些工具不依赖 IDE 连接：

- `remote_list_servers` 列出可用服务器（IDE / 项目 / 全局三个来源）与各自的 deployment。
- `remote_exec` 在服务器上跑一条命令：每条命令是独立 SSH 连接，`cd` / `export` 不跨命令保留；
  要目录就传 `workingDirectory`；命令跑完才返回。
- `remote_upload` / `remote_download` 按 deployment 名同步目录：默认 `overwrite`，
  `mirror` 会删掉目标端多出来的文件（不可逆）。
- 服务器或 deployment 名字传错时，工具会返回全部候选；按列表重新调用，不要猜。
