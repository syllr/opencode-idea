---
name: jetbrains-mcp-setup
description: 配置并验证 opencode-idea 插件:开启 JetBrains IDE 的 MCP 服务、找到端口、写入 opencode.json、验证 OpenCode 能连上并优先使用 IDE 工具。当用户要「接入 IDEA/JetBrains 的 MCP」「让 OpenCode 用 IDE 工具编辑/构建」或排查插件不生效时使用。
---

# JetBrains MCP 接入配置

## 步骤

1. **确认 IDE 侧已开启 MCP 服务**
   - 在 JetBrains IDE 中打开 Settings → Tools → MCP Server(或 AI Assistant 的 MCP 设置),启用。
   - 让用户在 IDE 里打开要操作的项目。

2. **拿到 MCP 端口**
   - IDE 通常显示形如 `http://127.0.0.1:<port>/sse` 的地址;记录 `<port>`。
   - 若用户不确定,可用 `ports` 默认列表让插件自动探测。

3. **在项目 `opencode.json` 注册插件**

   ```jsonc
   {
     "plugin": [
       ["opencode-idea", { "ports": [<port>] }]
     ]
   }
   ```

4. **验证**
   - 重启 OpenCode(或触发插件重载)。
   - 让用户确认:当前项目在 IDE 中打开时,OpenCode 是否优先用 IDE 工具;关闭项目后是否回退原生。

## 排查

- 插件不生效:确认 OpenCode 是 **V2**(需要 `ctx.tool` / `ctx.mcp`)。
- 一直探测失败:确认 IDE MCP 在跑、端口正确、当前项目确实在 IDE 中打开。
- 判断依据:IDE MCP 的 `tools/call get_project_modules` 在项目打开时成功、未打开时返回 `isError`。
