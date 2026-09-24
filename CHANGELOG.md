# Changelog

## 0.2.0

- **新增项目 SDK 环境变量注入**:启动时读 `.idea/*.iml` + `misc.xml` 得到项目 SDK(JDK / Python / Go / Node),映射成 `JAVA_HOME` / `VIRTUAL_ENV` / `GOROOT` 等,并通过 V2 `shell` 的 `create.before` 钩子注入每个 shell。
- **新增 IDE 终端环境读取**:IDE 可达时用 `execute_terminal_command printenv` 读取 IDE 实际环境里的 SDK 变量补全。
- 环境合并优先级:`.idea` 项目 SDK > IDE 终端环境。
- 新增 `injectEnv` 配置项(默认 `true`)。
- 修复:IDE MCP 服务会反向请求 `roots/list`,客户端现在会正确应答(否则工具调用会挂起)。
- 新增模块:`src/project-sdk.js`、`src/ide-env.js`、`src/env.js`。

## 0.1.0

- 初始版本。
- 探测本地 JetBrains IDE MCP 服务,判断当前项目是否在 IDE 中打开(通过 `tools/call get_project_modules` + `IJ_MCP_SERVER_PROJECT_PATH` header)。
- 项目打开时注册 IDE MCP server,并把原生 `edit` / `write` / `patch` / `shell` 的描述改为优先使用 IDE 工具。
- 周期性复探,跟随 IDE 开/关自动启用与回退。
