# opencode-jetbrains-mcp

OpenCode 插件,面向 JetBrains 项目(IntelliJ IDEA / PyCharm / WebStorm 等),做两件事:

1. **注入项目 SDK 环境变量** —— 启动时检查 IDE 的项目配置(JDK / Python / Node / Go 的 SDK),把对应的环境变量(`JAVA_HOME` / `VIRTUAL_ENV` / `GOROOT` / ...)注入到 OpenCode 的 shell 环境里。
2. **优先使用 IDE 工具** —— 当前项目在 IDE 里打开时,接入该 IDE 的 MCP 服务,并引导模型优先用 IDE 的工具(编辑、构建、重构、调试、代码索引等);项目没打开时回退 OpenCode 原生工具。

非 JetBrains 项目完全不受影响。

## 工作原理

```text
每次 reconcile:
  1. 探测本地 JetBrains IDE MCP,判断当前项目是否已在 IDE 中打开
  2. 是 JetBrains 项目 →
       环境变量:
         a. 读 .idea/*.iml + misc.xml  → 项目 SDK(VIRTUAL_ENV / JAVA_HOME / GOROOT ...)
         b. IDE 可达时,execute_terminal_command printenv → IDE 终端环境(补全 SDK 变量)
         c. 合并(.idea 优先),通过 shell create.before 钩子注入每个 shell
       工具:
         d. 注册 IDE MCP(header IJ_MCP_SERVER_PROJECT_PATH 锁定当前项目)
         e. 把原生 edit / write / patch / shell 的描述改为「优先 IDE 工具,不可用再回退」
  3. 非 JetBrains 项目 → 什么都不做
每 15 秒复探一次,跟随 IDE 开/关自动切换。
```

## 环境变量注入

启动 / 复探时收集这些来源并合并(越靠后优先级越高):

| 来源                             | 拿到什么                                                                         | 说明                      |
| -------------------------------- | -------------------------------------------------------------------------------- | ------------------------- |
| `.idea/*.iml` + `.idea/misc.xml` | **项目 SDK**(`jdkName`/`jdkType`)→ 映射成 `JAVA_HOME` / `VIRTUAL_ENV` / `GOROOT` | 静态配置,无需 IDE 运行    |
| IDE 集成终端 `printenv`          | IDE 实际环境里的 SDK 变量(`JAVA_HOME`/`GOROOT`/`MAVEN_HOME`/`SDKMAN_DIR` 等)     | 需要 IDE MCP + Brave Mode |

映射规则:

| `jdkType` 含            | 环境变量      | PATH 前置   |
| ----------------------- | ------------- | ----------- |
| `Python` / `VirtualEnv` | `VIRTUAL_ENV` | `<sdk>/bin` |
| `Java` / `JDK`          | `JAVA_HOME`   | `<sdk>/bin` |
| `Go`                    | `GOROOT`      | `<sdk>/bin` |
| `Node`                  | —             | `<sdk>/bin` |

- `jdkName` 支持 `$PROJECT_DIR$` 和 `~` 展开;符号名(如 Java `17`)会尝试在 `~/.sdkman`、`~/.jdks`、`/Library/Java/JavaVirtualMachines` 解析。
- 注入通过 V2 的 `shell` `create.before` 钩子:只补 SDK 变量 + 前置 PATH,不覆盖你原有的 PATH。

> 与 [opencode-env-loader](https://github.com/syllr/opencode-env-loader) 的关系:两者独立。env-loader 负责 `.opencode/env-loader/*` 的**人工** KEY=VALUE 覆盖;本插件负责从 **IDE 配置自动推导** SDK 环境。可以同时使用。

## 前置条件

- JetBrains IDE 已开启 MCP 服务(IDE 设置里的 MCP Server / AI Assistant MCP)。
- 要读 IDE 终端环境,需要在 IDE 里开启 **Brave Mode**(否则 `execute_terminal_command` 会等确认)。
- IDE MCP 监听的**端口**,常见形如:

```jsonc
{
  "type": "sse",
  "url": "http://127.0.0.1:64342/sse",
  "headers": { "IJ_MCP_SERVER_PROJECT_PATH": "<项目路径>" },
}
```

插件按 `ports` 依次探测;默认 `[64342, 6420, 6421, 63342]`。

## 安装

```json
{
  "plugin": ["opencode-jetbrains-mcp"]
}
```

## 配置

```jsonc
{
  "plugin": [["opencode-jetbrains-mcp", { "ports": [64342], "pollMs": 15000, "injectEnv": true }]],
}
```

| 选项        | 类型       | 默认                         | 说明                      |
| ----------- | ---------- | ---------------------------- | ------------------------- |
| `ports`     | `number[]` | `[64342, 6420, 6421, 63342]` | 依次探测的 IDE MCP 端口   |
| `pollMs`    | `number`   | `15000`                      | 复探间隔(毫秒)            |
| `injectEnv` | `boolean`  | `true`                       | 是否注入项目 SDK 环境变量 |

## 行为

- **JetBrains 项目**:注入 `.idea` 项目 SDK 环境;IDE 可达时再补终端环境 + 接入 IDE MCP + 优先 IDE 工具。
- **非 JetBrains 项目**:不改环境、不注册、不改描述。
- **IDE 中途关闭**:下次复探自动撤销 MCP 注册、还原工具描述(SDK 环境来自 `.idea`,继续有效)。

## 限制

- 仅支持 **OpenCode V2** 插件 API(`ctx.tool` / `ctx.mcp` / `ctx.shell` / `ctx.location`)。
- IDE 终端环境依赖 `execute_terminal_command` + Brave Mode;拿不到时只用 `.idea` 静态配置。
- 符号型 SDK 名(如 Java `17`)若无法在常见位置解析,则跳过该 SDK。
- 探测依赖 IDE MCP 的 `get_project_modules` 工具存在。

## 测试

```bash
npm test
```

使用 [Vitest](https://vitest.dev/),含纯函数测试、`.idea` 解析、环境合并,以及「假 IDE MCP 服务」的端到端探测测试。

## License

MIT
