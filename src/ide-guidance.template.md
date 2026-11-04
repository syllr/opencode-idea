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
- **Run / Deploy**：Run 是调试，Stop 会停远端进程 / 删容器；Deploy 是发布，Stop 只关日志。
  查远端真实状态用 `ide_list_remote_processes`；用户说“部署 / 发布 / 上线”用 `ide_deploy_remote_process`；
  说“跑一下 / 启动 / 调试 / 重启”用 `ide_rerun_run_configuration`。
- **增删改 run configuration** 走 `idea-run-config-manager` skill：直接读写项目 `.run/*.run.xml`，
  写完 `inspect` 检查、再真跑。
- 启动 / 停止远端进程或部署用上面的 IDE 工具，不要自己拼 `nohup` / `docker run`。
