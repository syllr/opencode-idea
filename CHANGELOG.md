# Changelog

## 0.1.0

- 初始版本。
- 探测本地 JetBrains IDE MCP 服务,判断当前项目是否在 IDE 中打开(通过 `tools/call get_project_modules` + `IJ_MCP_SERVER_PROJECT_PATH` header)。
- 项目打开时注册 IDE MCP server,并把原生 `edit` / `write` / `patch` / `shell` 的描述改为优先使用 IDE 工具。
- 周期性复探,跟随 IDE 开/关自动启用与回退。
