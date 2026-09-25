# Changelog

## 0.3.1

**新增**

- **`/open-in-idea` 代码命令**:用 IntelliJ IDEA 打开当前项目(复用已运行实例),并即时加载 IDE MCP 与 IDE 环境。命令**可重入**:重复触发共享同一次启动,不会重复 spawn。
- **IDE 启动器** (`src/ide-launcher.js`):`open -a "IntelliJ IDEA" <dir>` 复用已运行实例(Toolbox CLI 的 `open -na` 会新开实例,故不使用);命令只负责请求打开/激活项目,MCP 可用性由调用方短探测后 fast-fail。
- **启动保护 (launch guard)**:每目录记录 `lastSpawnAt` / `attempts`,冷启动/索引/等 Trust 弹窗期间不会重复拉起;冷却 `launchCooldownMs`(默认 120s)、上限 `launchMaxAttempts`(默认 5)。
- **强软引导(系统提示注入)** (`src/ide-guidance.js`):IDE 可用时,通过 `ctx.session.hook("context", …)` 往每次请求的 system 追加「项目内操作默认走 IDE MCP」引导 + 能力映射表(含工具名与关键参数名);配合原有的工具描述前缀。`injectGuidance: false` 可关闭。
- **结果通知**(`feedback: "message"`,默认):命令结束后发一条标注清楚的通知 —— 用户看到干净气泡(`metadata.displayText`),模型只看到"这是通知,请只回复『收到』";`false` 静默。
- **根级 `index.js` 转发入口**:使仓库可作为 V2 本地目录插件直接加载(`plugins: [{ package: "<repo>" }]`)。
- 新增配置项:`injectGuidance` / `openInIde` / `launchCooldownMs` / `launchMaxAttempts` / `mcpProbeTimeoutMs` / `feedback`。

**变更**

- **纯手动**:启动**不探测、不连接 IDE MCP**;IDE MCP 注册 + 环境重读 + 引导注入全部由 `/open-in-idea` 触发。
- **环境变量只来自 IDE 终端**:移除 `.idea` 静态解析(`src/project-sdk.js`)。IDE 集成终端才是权威来源(版本化 Node / goenv Go / SDKMAN Java 等 .idea 读不到);`src/ide-env.js` 保留。
- **`reconcile` 串行化**:重叠调用通过 promise 链串行,避免并发重复注册 MCP/工具偏好。

**修复**

- **IDE MCP 无法连接**:注册给 OpenCode 的 URL 从 `/sse` 改为 `/stream`。OpenCode V2 的远程 MCP 客户端只支持 Streamable HTTP,旧版 SSE 端点(POST 返回 405)会报 `Error POSTing to endpoint`,IDE 工具根本加载不出来;IDE 2026.2+ 的 `/stream` 才可用。**插件探测也改用 `/stream`**(一次 `initialize`),删除了整个 SSE 客户端(旧 `callTool` / `parseSseBlock` / `serverRequestResponse` / `readSse`)。
- **探测语义简化**:从「当前项目是否在 IDE 打开」简化为「MCP 服务是否在监听」。用户通过 `/open-in-idea` 指定项目,无需再校验;MCP 不在则提示用户开启 MCP 服务。
- **MCP 未开启时 fast-fail**:`/open-in-idea` 先用 `open -a` 打开/激活 IDEA,随后只做一次短探测;未检测到 MCP 就立即返回并提示用户在 IDEA 中开启 MCP 服务和 Brave Mode,不再轮询或等待超时,用户开启后通过命令重试。

**移除**

- `pollMs` 周期复探 / `openMode: "auto"` 自动拉起 / `src/worktree.js` —— 均无收益只增复杂度,已删除。纯手动,入口统一为 `/open-in-idea`。
- `src/project-sdk.js`(`.idea` 解析)及其测试。

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
