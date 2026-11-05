## IDE 工具

- **IDE 工具补原生工具做不到的**：`ide_search_symbol`、`ide_analyze_calls`、
  `ide_rename_refactoring`、`ide_lint_files` / `ide_get_file_problems`、`ide_build_project`、
  `ide_apply_patch`、`ide_reformat_file`。IDE 工具只作用于当前项目。
- **校验**：改一处收尾跑一次 `ide_lint_files`；改一大片 / 动接口 / 动依赖，全部改完跑一次
  `ide_build_project`；全仓检查只在最后跑一次。
- **Run configuration**：IDE 里的一个可运行单元，`ide_get_run_configurations` 列出名字，`ide_inspect_run_configuration`
  看全貌。名字文法 `base@env`（`console-web@ytwin`、`aidata-api@mbp`）：base 是本体，env 是跑在哪台机器。
- **Remote Process**（`type="RemoteProcess"`）：跑在远端，字段是 server + deployment + command；一次 run =
  差量同步 deployment + 远端启动。**远程配置不得自行触发，必须用户授权**。
- **只同步文件 → `remote_upload` / `remote_download`。** Remote Process 的 run 会启动进程，同步只是它的前置动作。
- **跑哪条工具由配置类型决定**：发布型的远端配置（`RemoteProcess`，部署链的最后一环）用
  `ide_deploy_remote_process` —— Stop 只关日志、不 kill 远端；其余一律 `ide_rerun_run_configuration` ——
  Stop 会 kill。不需要按用户话术临场判断。
- **两者对 server / RemoteProcess 都只代表「已触发」**：`triggered: true` + `started: null` 是正常结果，
  不是失败。同步 / 上传 / 拉起都在后台跑，按 2s / 4s / 8s / 16s 退避查
  `ide_list_running_configurations` / `ide_list_remote_processes`，启动日志读 `fullOutputPath`。
- **增删改 run configuration** 走 `idea-run-config-manager` skill：直接读写项目 `.run/*.run.xml`，
  写完 `inspect` 检查、再真跑。
- **Before launch 是独立 Run 会话**：构建 / 另一个配置先跑，通常几秒就结束，之后
  `ide_list_running_configurations` 里只剩父配置。**列表里看不到构建 ≠ 没执行** ——
  构建的日志与退出码直接在这些工具的返回里：`ide_rerun_run_configuration` /
  `ide_deploy_remote_process` 的 `beforeRunTasks[]` / `steps[]`（含 `output` 尾部预览与 `exitCode`），
  或列表条目上的 `beforeRunTasks[].lastRun`。想看多次构建的历史，用 `ide_inspect_run_configuration`
  的 `beforeRunTasks[].recentRuns[]`（最多 3 条，最近一次是 `[0]`）。不用去临时目录按时间猜。
- 启动 / 停止远端进程或部署用上面的 IDE 工具，不要自己拼 `nohup` / `docker run`。
