# Changelog

## 0.0.1

首个版本（包名 `opencode-idea`，从 `opencode-jetbrains-mcp` 重命名而来）。

**接入 IDE MCP**

- **`/open-in-idea` 命令**:用 IntelliJ IDEA 打开当前项目(复用已运行实例),并即时加载 IDE MCP。命令可重入,重复触发共享同一次启动,不会重复 spawn。
- **IDE 启动器** (`src/ide-launcher.js`):`open -a "IntelliJ IDEA" <dir>` 复用已运行实例(Toolbox CLI 的 `open -na` 会新开实例,故不使用)。
- **启动保护 (launch guard)**:每目录记录 `lastSpawnAt` / `attempts`;冷却 `launchCooldownMs`(默认 120s)、上限 `launchMaxAttempts`(默认 5)。
- **MCP 未开启时 fast-fail**:`/open-in-idea` 先短探测,未检测到 MCP 就立即返回并提示在 IDEA 中开启 MCP 服务和 Brave Mode,不轮询、不等待超时;用户开启后重试命令即可。
- **Streamable HTTP 端点**:注册给 OpenCode 的 URL 使用 `/stream`(IntelliJ 2026.2+)。OpenCode V2 的远程 MCP 客户端只支持 Streamable HTTP,旧版 `/sse`(POST 返回 405)不可用;插件探测同样走 `/stream`。
- **结果通知**(`feedback: "message"`,默认):命令结束后发一条标注清楚的通知,用户看到干净气泡(`metadata.displayText`),模型只看到"这是通知,请只回复『收到』";`false` 静默。

**IDE 工具优先**

- **系统提示直接调用引导** (`src/ide-guidance.js`):IDE 可用时,通过 `ctx.session.hook("context", …)` 往每次请求的 system 追加「项目内操作优先使用 IDEA MCP」引导 + 能力映射表,要求模型直接调用 `idea_*` 工具。`injectGuidance: false` 可关闭。
- **IDEA 工具描述增强** (`src/idea-tool-descriptions.js`):通过 `ctx.tool.transform` 只更新 `idea_*` / `idea.*` 工具的 description,强调直接调用、按当前 schema 传参。原生 `edit` / `write` / `patch` / `shell` 的定义、描述和可用性保持不变。
- **失败恢复指引**:IDEA MCP 工具缺失、连接被拒或超时时,提示用户执行 `/open-in-idea`,不反复探测或长时间等待。

**IDE 环境注入**

- **环境变量只来自 IDE 集成终端**:用 `execute_terminal_command printenv` 读取 IDE 实际运行环境(版本化 Node、goenv Go、SDKMAN Java、Maven 等),通过 V2 `shell` 的 `create.before` 钩子注入每个 shell;只补 SDK 变量并前置 PATH,不覆盖原有 PATH。需要 IDE MCP 可达 + Brave Mode。
- **抽取值** (`src/ide-env.js` 的 `SDK_ENV_KEYS`):`JAVA_HOME` / `JRE_HOME` / `JDK_HOME` / `VIRTUAL_ENV` / `PYTHONPATH` / `PYTHONHOME` / `GOROOT` / `GOPATH` / `GOBIN` / `NODE_PATH` / `NVM_BIN` / `NVM_DIR` / `MAVEN_HOME` / `M2_HOME` / `GRADLE_HOME` / `SDKMAN_DIR` / `CONDA_PREFIX`。

**其他**

- **纯手动**:启动不探测、不连接 IDE MCP;IDE MCP 注册、环境重读、引导注入全部由 `/open-in-idea` 触发。
- **根级 `index.js` 转发入口**:使仓库可作为 V2 本地目录插件直接加载(`plugins: [{ "package": "<repo>" }]`)。
- **发布脚本** (`scripts/release.mjs`):`npm run release` 自动递增 patch、同步版本文件、跑测试并发布。
- **配置项**:`ports` / `injectEnv` / `injectGuidance` / `openInIde` / `launchCooldownMs` / `launchMaxAttempts` / `mcpProbeTimeoutMs` / `feedback`。
- 仅支持 **OpenCode V2**;非 JetBrains 项目完全不受影响。
