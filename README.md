# opencode-jetbrains-mcp

OpenCode 插件:当**当前项目在 JetBrains IDE(IntelliJ IDEA / PyCharm / WebStorm 等)里打开**时,自动接入该 IDE 的 MCP 服务,并引导模型**优先使用 IDE 的工具**(编辑、构建、重构、调试、代码索引等);项目没打开时,保持 OpenCode 原生工具。

## 工作原理

1. 插件启动时,用当前项目路径去探测本地 JetBrains IDE MCP 服务。
2. 探测成功(即当前项目确实在 IDE 里开着)→
   - 把该 IDE MCP 注册给 OpenCode(header `IJ_MCP_SERVER_PROJECT_PATH` 锁定当前项目),
   - 并把原生 `edit` / `write` / `patch` / `shell` 的描述改成「优先用 IDE 工具,不可用再回退」。
3. 探测失败 → 什么都不做,OpenCode 继续用原生工具。
4. 每 15 秒复探一次,跟随 IDE 的开/关自动切换。

### 为什么探测是一次「工具调用」而不是「连接测试」

这一点很关键(实测结论):

| 探测层                          | 能否判断「某项目在 IDE 里开着」                   |
| ------------------------------- | ------------------------------------------------- |
| SSE 连接 `GET /sse`             | ❌ 开/没开/垃圾路径都返回 `200 + sessionId`       |
| `tools/list`                    | ❌ 都返回**同一套 60 个 IDE 全局工具**,不随项目变 |
| **实际调用工具**(带项目 header) | ✅ 开着→成功;没开→`isError`,并列出当前打开的项目  |

所以插件探测时会对 IDE MCP 发一次 `tools/call(get_project_modules)`,用返回的 `isError` 判定当前项目是否打开。详细验证过程见仓库提交历史 / `src/idea-mcp.js` 顶部注释。

## 前置条件

1. JetBrains IDE 已开启 MCP 服务(IDE 设置里的 MCP Server / AI Assistant MCP)。
2. IDE MCP 监听的**端口**。IDEA 会在项目配置里给出,常见形如:

```jsonc
{
  "type": "sse",
  "url": "http://127.0.0.1:64342/sse",
  "headers": { "IJ_MCP_SERVER_PROJECT_PATH": "<项目路径>" },
}
```

插件会按 `ports` 依次探测;默认 `[64342, 6420, 6421, 63342]`。

## 安装

在 `opencode.json` 中注册插件:

```json
{
  "plugin": ["opencode-jetbrains-mcp"]
}
```

## 配置

插件通过 OpenCode 的插件 `options` 接收参数:

```jsonc
{
  "plugin": [["opencode-jetbrains-mcp", { "ports": [64342], "pollMs": 15000 }]],
}
```

| 选项     | 类型       | 默认                         | 说明                    |
| -------- | ---------- | ---------------------------- | ----------------------- |
| `ports`  | `number[]` | `[64342, 6420, 6421, 63342]` | 依次探测的 IDE MCP 端口 |
| `pollMs` | `number`   | `15000`                      | 复探间隔(毫秒)          |

## 行为

- **项目在 IDE 里打开**:注册 IDE MCP + 原生编辑类工具描述变为「优先 IDE」。
- **项目没打开**:不注册、不改描述,纯原生。
- **IDE 中途关闭**:下一次复探自动撤销注册、还原描述。
- 插件**从不** deny 原生工具(不是「只能」,而是「优先」),IDE 不可用时自动回退。

## 限制

- 仅支持 **OpenCode V2** 插件 API(`ctx.tool` / `ctx.mcp` / `ctx.location`)。
- IDE MCP 的端口/协议以 JetBrains 实现为准;不同 IDE 版本可能需要调整 `ports`。
- 探测依赖 IDE MCP 的 `get_project_modules` 工具存在(当前 JetBrains MCP 均提供)。

## 测试

```bash
npm test
```

使用 [Vitest](https://vitest.dev/),包含纯函数测试与「假 IDE MCP 服务」的端到端探测测试(`tests/e2e.test.js`)。

## License

MIT
