# Changelog

## 0.0.6

- **修复:工具报错不再注销 IDE MCP**。旧实现在 `tool.execute.after` 里把**任何** `idea_*` 报错都当成「端点已死」并注销整个注册 —— 业务错误 (例如路径不存在返回 `File not found`) 和一次传输抖动都会触发;注销后紧跟的 `ctx.mcp.reload()` 还会掐断同一批正在执行的其他调用。现在插件**不注册**该钩子:连接状态以 OpenCode 自己维护的工具快照为准 (`context` 钩子收到的 `event.tools` 里有没有 `idea_*`),只有 `/open-in-idea` 会 (重新) 连接。
- **隐藏 31 个用不到的 IDEA 工具** (`HIDDEN_IDEA_TOOLS`):VCS、Router 派发工具、Debugger (全部 `idea_xdebug_*`)、Dev Kit MCP、Inspection KTS MCP、Python Environment MCP、数据库建/改数据源、终端 `execute_terminal_command`。模型可见的 `idea_*` 从 64 降到 33。
- **引导词重写**:边界从「所有操作」收窄为「**代码与文件操作**」(未暴露的领域自然走原生,不再列例外);新增数据库段 (走 IDEA Database 工具 + 用户配数据源 + 不索取凭据);删除终端命令段 (该工具已隐藏)。
- **新增 `idea-run-config` skill**:教模型在 `.run/*.run.xml` 里建/改/删 run configuration,并用 `get_run_configurations` 校验、`execute_run_configuration` 实跑 (IDE MCP 没有增删改能力)。仅 JetBrains 项目注册,与 `/open-in-idea` 无关。
- **`/open-in-idea` 改为问注册表要连接状态**:活着只刷新,死了才换注册 (OpenCode 对未变更的 MCP 配置不会重连)。
- **默认 MCP 端口收敛**:`DEFAULT_PORTS` 从 `[64342, 6420, 6421, 63342]` 改为 `[64342]`。
- **修复发布脚本**:`assertCleanGit()` 原先排在版本递增之后,导致正式发布必然中途失败并留下已被改动的版本号;现在移到递增之前。

## 0.0.5

- **冷启动等待 MCP 端点**:`/open-in-idea` 在 `open -a` 之后按 `mcpStartTimeoutMs`(默认 60s)轮询,直到 IDEA 自带的 MCP server 开始监听。冷启动时一次命令即可连上,不再像之前那样探测一次失败就报「未检测到 MCP 服务」。
- **工具就绪判定**:连接后轮询 `ctx.tool.list()`,确认 `idea_read_file` / `idea_apply_patch` 已注册。未就绪时状态为 `tools-loading` 并提示稍后重试,不再在原生工具表尚未就绪时谎称「已连接」。
- **重复执行刷新工具列表**:再次执行 `/open-in-idea` 会重建 MCP server 并依次 `ctx.mcp.reload()` + `ctx.tool.reload()`,让已经捕获过工具快照的会话立即看到最新工具,而不是停留在旧快照。
- **IDE 掉线自动注销**:每次请求前复检端点,IDEA 关闭或某次 `idea_*` 工具调用失败时,立即移除 `idea_*` 工具并恢复原生工具,避免后续请求继续调用已失效的 IDE 工具;只有再次执行 `/open-in-idea` 才能重新注册。
- **清理**:移除调试日志;删除过时的 `scripts/publish.sh`(旧包名 + bypass token 流程,已由 `scripts/release.mjs` 取代);`package.json` 的 `files` 移除早已删除的 `src/idea-tool-descriptions.js`。

## 0.0.4

- **`/open-in-idea` 刷新工具列表**:在 `ctx.mcp.reload()` 之后显式调用 `ctx.tool.reload()`。之前只有 MCP 层重建目录,已经捕获过工具快照的会话仍然看不到新的 `idea_*` 原生工具;现在下一次模型请求即可用,无需重开会话。

## 0.0.3

- **直接暴露 IDEA MCP 工具**:注册 MCP 服务器时设置 `codemode: false`,让 `idea_*` 工具直接出现在原生工具表(而非 Code Mode 的 `tools.idea.*`)。模型可以直接调用并看到完整参数 schema,不再需要先探索、也不会猜错参数名。
- **引导补充**:明确要求「直接调用工具,不要用 `execute` 包裹」。

## 0.0.2

- **路由引导重写**:system prompt 明确写出项目绝对路径,并要求路径内的检索 / 读文件 / 目录浏览 / 改文件 / 新建文件 / 校验都使用 `idea_*` 工具,逐条点名禁止对应的原生工具(`grep` / `glob` / `read` / `edit` / `write` / `ls` / `find`)。
- **不再修改任何工具描述**:移除对 IDEA MCP 工具描述的前缀改写(`src/idea-tool-descriptions.js` 已删除),插件不再调用 `ctx.tool.transform`;IDEA 工具与原生工具的描述均保持原样。
- **引导文案精简**:删除解释性内容和宽泛的「例外」条款,只保留要求与项目内 / 外边界。
- **移除无用文件**:删除 `skills/`(setup skill)与 `UPGRADING.md`。
- **安装文档更新**:README 的安装与配置示例改为 V2 的 `plugins` 对象写法。

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
