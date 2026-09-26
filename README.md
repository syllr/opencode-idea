# opencode-idea

OpenCode 插件,面向 JetBrains 项目 (IntelliJ IDEA / PyCharm / WebStorm 等),做三件事:

1. **接入 IDE MCP** —— 用 `/open-in-idea` 把当前项目在 IntelliJ IDEA 中打开,并把这个 IDE 的 MCP 服务 (60 个工具:
   检索、读、改、构建、重构、调试、数据库……)注册进 OpenCode。
2. **优先使用 IDE 工具** —— IDE 可用时,向模型注入"项目内操作优先使用 IDEA MCP"的系统提示引导 + 能力映射;IDE 不可用时回退原生工具
   (正常回退,无需声明)。
3. **注入 IDE 环境变量** —— 从 IDE 集成终端读取它实际运行的环境 (版本化管理的 Node、goenv 的 Go、SDKMAN 的 Java、Maven……)
   注入每个 OpenCode shell。

非 JetBrains 项目完全不受影响。 **全手动**:插件启动不探测、不连接 IDE,只有跑 `/open-in-idea` 才接入;接入之后也没有
任何自主动作(环境变量只在 `/open-in-idea` 时刷新)。

## 工作原理

```text
setup(启动):
  a. 读 IDE 集成终端环境 → 通过 shell create.before 钩子注入每个 shell(null: 未连 IDE 时为空)
  b. 注册 /open-in-idea 命令 + session context 钩子(注入引导)
  不探测、不注册 MCP

/open-in-idea(手动触发):
  1. 探测本地 JetBrains IDE MCP 服务(/stream)
  2. 已就绪 → 直接连接
  3. 未就绪 → open -a "IntelliJ IDEA" <项目目录>(复用已运行实例),然后立即提示:
     在 IDEA 中开启 MCP 服务 + Brave Mode
  4. 本次命令 fast-fail 返回;用户手动开启后再次执行 `/open-in-idea`
  5. MCP 就绪时:
       a. 注册 IDE MCP(url /stream,header IJ_MCP_SERVER_PROJECT_PATH 锁定当前项目)
       b. 读 IDE 终端环境 → 更新注入每个 shell 的环境变量
       c. 启用系统提示引导(直接调用 `idea_*` 工具)+ IDEA MCP 工具描述前缀
  6. 发一条结果通知(用户看到干净气泡,模型只回"收到")
```

## 在 IDE 中打开项目 (`/open-in-idea`)

在会话里输入 `/open-in-idea`:

1. 先探测 `/stream`;已就绪 → 直接加载能力;
2. 未就绪 → 用 `open -a "IntelliJ IDEA" <项目目录>` 拉起或激活 IDEA —— **复用已运行的实例**(不会重复开新实例);
3. 如果 MCP 仍未就绪,命令会 **立即 fast-fail**,提示在 IDEA 的 `Settings → MCP Server` 开启 MCP 服务并启用 **Brave
   Mode**;
4. 用户手动完成设置后,再次执行 `/open-in-idea`;探测成功后才注册 IDE MCP、重读 IDE 环境并启用系统引导与 live tool catalog。

> **通知不触发 AI 干活**:默认 `feedback: "message"` 把结果作为一条 **标注清楚的通知**发到会话里 —— 用户看到干净的通知气泡
> (经 `metadata.displayText`),模型只看到"这是通知,请只回复『收到』"的指令,因此不会执行任何操作、不会调用工具。
> `feedback: false` 则完全静默。

**可重入 / 启动保护**:IDEA 冷启动、索引或等待「Trust and Open Project」弹窗期间探测会失败。命令只发一次 MCP/Brave Mode 提示并
fast-fail,不会在后台轮询;重复触发共享同一次打开请求,按目录维护 `lastSpawnAt` / `attempts`,避免重复 spawn。开启 MCP +
Brave Mode 后再次执行 `/open-in-idea` 即可接上。

**热更新会断开**:插件源码变更会触发 V2 热重载,注册随旧实例一起释放,`activePort` 归零。这是手动模式的预期行为 ——
**改完插件后重跑一次 `/open-in-idea`** 即可恢复。

## IDE 工具优先 (直接调用引导)

IDE MCP 可用时,插件通过 **系统提示注入**提高模型主动使用 IDEA MCP 的概率;不修改任何工具 (原生或 IDEA)
的定义、描述或可用性:

1. **系统提示注入**:通过 `ctx.session.hook("context", …)` 往每次请求的 system 里追加一段「项目内操作优先使用 IDEA
   MCP」的直接调用引导 + 能力映射表 (`src/ide-guidance.js`),含工具名 (`idea_<name>`)与关键参数名:
   - 检索 → `idea_search_text` / `idea_search_regex` / `idea_search_file`(参数 `q`,可带 `paths` 收窄)
   - 读文件 → `idea_read_file`(`file_path` / `offset` / `limit`);目录 → `idea_list_directory_tree`
   - 改文件 → `idea_apply_patch`(`input`);新建 → `idea_create_new_file`(`pathInProject`)
   - 校验 → `idea_lint_files` / `idea_get_file_problems` / `idea_build_project`
   - 重构/格式化 → `idea_rename_refactoring` / `idea_reformat_file`
   - 数据库 → `idea_list_database_connections` / `idea_execute_sql_query` / `idea_preview_table_data` 等;没有数据源时先建议用户在
     IDEA 里配置
   - 边界:只约束 **代码与文件操作**;未暴露的领域 (版本控制、shell/终端等) 工具表里没有 `idea_*` 选项,模型自然走原生

   不会把整份工具目录重复塞进 system prompt,也不要求模型包一层 JavaScript 编排代码。IDEA MCP 工具自身的
   description/schema 仍是参数使用的权威来源;工具返回业务错误时先修正参数,不要误判成工具不可用。MCP 不可用时立即
   提示用户执行 `/open-in-idea`,不重复探测或等待。

引导只在 **IDE MCP 可用**时生效;MCP 不可用时仅保留 fast-fail 恢复提示。`injectGuidance: false` 可关闭系统提示注入。

## Run Configuration 管理 (skill)

IDE MCP 只能 **查**(`get_run_configurations`)和 **执行**(`execute_run_configuration`)run configuration, **没有增删改**
。插件在 **JetBrains 项目**(存在 `.idea`)里注册一个 `idea-run-config` skill 来补上这块:

- 只操作 **项目级** `.run/<name>.run.xml`(可提交 git、团队共享), **不碰** `.idea/workspace.xml`;
- 不内置任何按类型的模板 —— 先找项目里的 **真实样本**(`**/*.run.xml`,或让用户在 IDEA 里勾 "Store as project file"
  建一个)当参照,再写;
- 写完必须用 `idea_get_run_configurations` **校验它能被列出**、并用 `idea_execute_run_configuration` **实跑确认**;
- 改配置用 `idea_apply_patch` **定向改 option**,不整文件重写。

skill 由 `ctx.skill.transform` 在插件 `setup` 时注册, **与 `/open-in-idea` 无关**;非 JetBrains 项目不受影响。定义在
`src/ide-run-config-skill.js`。

## 环境变量注入

**唯一来源:IDE 集成终端**(`execute_terminal_command printenv`)。它反映 IDE 实际运行的环境 —— 版本化管理的 Node (如 fnm
v14)、goenv 的 Go、SDKMAN 的 Java 等 —— 这些 .idea 配置里往往读不到。

抽取的变量 (`src/ide-env.js` 的 `SDK_ENV_KEYS`):`JAVA_HOME` / `JRE_HOME` / `JDK_HOME` / `VIRTUAL_ENV` / `PYTHONPATH` /
`PYTHONHOME` / `GOROOT` / `GOPATH` / `GOBIN` / `NODE_PATH` / `NVM_BIN` / `NVM_DIR` / `MAVEN_HOME` / `M2_HOME` /
`GRADLE_HOME` / `SDKMAN_DIR` / `CONDA_PREFIX`。

- 注入通过 V2 的 `shell` `create.before` 钩子:只补这些变量 + 前置 PATH,不覆盖你原有的 PATH。
- 需要 IDE MCP 可达 + **Brave Mode**;拿不到时环境为空 (不影响其他功能)。

> 与 [opencode-env-loader](https://github.com/syllr/opencode-env-loader) 的关系:两者独立。env-loader 负责
> `.opencode/env-loader/*` 的 **人工** KEY=VALUE 覆盖;本插件负责从 **IDE 实际环境**推导。可以同时使用。

## 前置条件

- JetBrains IDE 已开启 MCP 服务 (IDE 设置里的 MCP Server / AI Assistant MCP),版本需 **2026.2+**(提供 Streamable HTTP 端点
  `/stream`);若关闭,`/open-in-idea` 会立即提示如何重新开启。
- 要读 IDE 终端环境,需要在 IDE 里开启 **Brave Mode**(否则 `execute_terminal_command` 会等确认);MCP 未就绪时通知会同时提醒开启它。
- 插件注册给 OpenCode 的 MCP 配置形如:

```jsonc
{
  "type": "remote",
  "url": "http://127.0.0.1:64342/stream",
  "headers": { "IJ_MCP_SERVER_PROJECT_PATH": "<项目路径>" },
}
```

> **为什么是 `/stream` 而不是 `/sse`**:OpenCode V2 的远程 MCP 客户端 **只支持 Streamable HTTP**,没有旧版 SSE 传输。IDE 的
> `/sse` 是旧版 SSE (POST 会返回 405),V2 连不上 (报 `Error POSTing to endpoint`)。IDE 2026.2 起额外提供 `/stream` 这个
> Streamable HTTP 端点。 **插件的探测也走 `/stream`**(一次 `initialize`),协议统一。

插件按 `ports` 顺序选择第一个可用端口,但会并发探测以避免多个端口的超时叠加;默认 `[64342]`。

## 安装

推荐用 CLI 安装,它会写入全局配置 `~/.config/opencode/opencode.json`:

```bash
opencode plugin add opencode-idea
```

等价的配置写法 (V2 使用 `plugins` 数组):

```jsonc
{
  "plugins": ["opencode-idea"],
}
```

安装后确认:

```bash
opencode plugin list
```

> 仅支持 **OpenCode V2**。若你日常跑的是 1.x 的 `opencode-ai`,它用的是旧插件 API,本插件不会生效;真机验证请用 V2 运行时。

### 本地开发 / 真机验证

插件未发布时,可以直接指向本地仓库目录。V2 解析 **目录**插件时找的是 `<dir>/index.*`(或 `<dir>/server.*`),不会读
`package.json#main`,所以仓库根目录提供了 `index.js` 转发到 `src/index.js`。

全局配置 `~/.config/opencode/opencode.json`(V2 桌面端/CLI 共用):

```jsonc
{
  "plugins": [{ "package": "/Users/yutao/Projects/opencode-idea" }],
}
```

配置保存后 V2 会监听并自动重载 (日志里能看到它开始 watch `index.js` / `src/*.js`),无需重启。改插件源码也会触发重载 (此时需重跑
`/open-in-idea`)。

另一种零配置方式:在 `~/.config/opencode/plugins/` 放一个转发文件 (自动发现,但不能传 options):

```js
// ~/.config/opencode/plugins/opencode-idea.js
export { default } from "/Users/yutao/Projects/opencode-idea/src/index.js";
```

## 配置

用 CLI 安装只会写入包名。要传 options,把 `plugins` 数组里的字符串改成对象:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-idea",
      "options": {
        "ports": [64342], // IDE MCP 端口;默认 [64342]
        "injectEnv": true,
        "injectGuidance": true, // IDE 可用时向系统提示注入「优先使用 IDEA MCP」引导
        "openInIde": "idea", // false 关闭;或任意 macOS 应用名(如 "IntelliJ IDEA")
        "launchCooldownMs": 120000, // 启动保护冷却
        "launchMaxAttempts": 5,
        "mcpProbeTimeoutMs": 1000, // 单个 MCP 端口的短探测超时
        "feedback": "message", // "message"(默认,会话通知,AI 只回"收到")| false(静默)
      },
    },
  ],
}
```

不传 options 时全部使用下表默认值。

| 选项                | 类型                 | 默认        | 说明                                                             |
| ------------------- | -------------------- | ----------- | ---------------------------------------------------------------- |
| `ports`             | `number[]`           | `[64342]`   | 依次探测的 IDE MCP 端口                                          |
| `injectEnv`         | `boolean`            | `true`      | 是否注入 IDE 终端环境变量                                        |
| `injectGuidance`    | `boolean`            | `true`      | IDE 可用时是否向系统提示注入「优先使用 IDEA MCP」引导            |
| `openInIde`         | `boolean \| string`  | `"idea"`    | 拉起哪个 IDE;`false` 关闭,`"idea"` 映射到 IntelliJ IDEA          |
| `launchCooldownMs`  | `number`             | `120000`    | 启动保护冷却:冷却期内不重复 spawn                                |
| `launchMaxAttempts` | `number`             | `5`         | 单次会话内最多 spawn 次数,超出后停止重试                         |
| `mcpProbeTimeoutMs` | `number`             | `1000`      | 单个 MCP 端口的短探测超时                                        |
| `feedback`          | `"message" \| false` | `"message"` | 结果反馈:`message` 会话通知(用户可见,AI 只回"收到");`false` 静默 |

## 行为

- **JetBrains 项目**:启动即注入 IDE 终端环境 (若此前已连过 IDE);`/open-in-idea` 接入 IDE MCP + 启用引导。
- **非 JetBrains 项目**:不改环境、不注册、不注入任何 IDEA 提示 (每请求零开销)。
- **手动接入 + 零自主动作**:启动 **不探测、不连接 IDE MCP**;注册、**环境重读**、引导注入全部由 `/open-in-idea` 触发。
  `context` 钩子按「每次模型调用」触发 (含工具续跑),是**请求的纯函数**:它只看本次请求自带的工具快照 ——
  有 `idea_*` 就剥离隐藏工具并注入引导,没有就只给恢复提示。**不做任何 I/O,没有缓存状态,没有定时器,没有事件订阅**。
  一次失败的调用不会触发探测或注销,断开的连接也不会被自动重连 —— **恢复的唯一方式是用户再次执行 `/open-in-idea`**。
- **`/open-in-idea`**:手动打开当前项目并即时加载能力 (已在 IDE 打开时则只重新加载);MCP 未开启时只发一次提示并
  fast-fail,用户手动开启 MCP + Brave Mode 后重试。
- **不响应工具报错**:插件**不注册** `tool.execute.after` 钩子。一次 `idea_*` 调用失败 (业务错误如 `File not found`、
  或偶发传输抖动) 不会触发任何探测、注销或重连 —— 连接状态只由 `/open-in-idea` 决定。

## 限制

- 仅支持 **OpenCode V2** 插件 API (`ctx.tool` / `ctx.mcp` / `ctx.shell` / `ctx.command` / `ctx.session` /
  `ctx.location`)。
- IDE MCP 注册需要 IDE **2026.2+** 的 Streamable HTTP 端点 `/stream`;更早版本只有 `/sse`,OpenCode V2 无法连接。
- skill 定义的字段名**以 schema 为准**,不要照官方文档:`Skill.Info` 需要 `path` (AbsolutePath),文档里写的 `location`
  不存在 —— 用错会让 `ctx.skill.transform` 抛 `SchemaError`,而**任何 transform 失败都会禁用整个插件**(0.0.6 就是这样丢了
  `/open-in-idea`)。同理,`Skill.Info` 的完整字段是 `id` / `name` / `description?` / `autoinvoke?` / `path` / `content`。
- 环境变量依赖 `execute_terminal_command` + Brave Mode;拿不到时环境为空。
- 一批用不到的 IDEA MCP 工具被硬编码隐藏 (`src/plugin.js` 的 `HIDDEN_IDEA_TOOLS`,共 31 个):VCS (`idea_git_status` /
  `idea_get_repositories`,版本控制走原生 `git`)、Router 派发工具 (`idea_execute_tool`,未启用 router-only 时冗余)、Debugger
  (全部 `idea_xdebug_*`)、Dev Kit MCP、Inspection KTS MCP、Python Environment MCP、以及数据库的建/改数据源 (数据源由用户在
  IDEA 里配置,AI 只读和查询)。`idea_execute_terminal_command` 也不暴露给模型 (实测:约 60 秒硬截止且拿不到后续输出;
  "看结尾"被原生覆盖)—— 它只由插件内部读取 IDE 环境,而那是插件直接调 MCP,不经过模型工具表。
- 探测只确认「MCP 服务是否在监听」,不校验「当前项目是否已在 IDE 打开」;MCP 关闭时会用一次短探测并立即给出设置提示。
- OpenCode 的 MCP 自动重连**只覆盖 legacy Streamable HTTP 的 session 过期**(`SessionExpiredError`:有 session id + 404 /
  "Server not initialized" → `recover()` + 重试该次调用);modern 端点 (IDE 2026.2,protocol 2025-06-18,不带 session id)
  的连接被关只会置 `failed` 并移除工具,**不会自动重连**。插件刻意不补这个缺口:恢复一律走手动 `/open-in-idea`。
- 打开 IDE 仅实现 macOS (`open -a`);首次打开若弹 Trust 对话框,需确认后重试。
- IDE MCP 没有「打开项目」工具,因此打开动作走 OS/CLI,而非 MCP。
- 插件热重载会断开 IDE 连接,需重跑 `/open-in-idea`。
- 插件不修改任何工具的定义、描述或可用性;IDE MCP 工具以 `idea_*` 直接暴露给模型 (`codemode: false`),不用 `execute` 包裹。

### `execute_terminal_command` 与原生 shell:互补,不是替代

> **结论:已加入 `HIDDEN_IDEA_TOOLS`,不暴露给模型** —— 下面的对比数据用于说明这个决定,也供手工调用时参考。
> 理由:① AI 拿不到长任务结果 (约 60 秒硬截止 + 没有工具能读终端缓冲);② "看结尾"被原生覆盖 (原生超限时保尾部,
> 并把完整输出存成文件);③ 唯一实质价值是"让用户看到 / 接手",而模型不需要它 —— 插件自己的 `printenv` 是
> **直接调 MCP**(`src/ide-env.js`),不经过模型工具表。

两者能力相近但取舍不同 (macOS + IDEA 2026.2.3 实测):

| 维度             | 原生 `shell`                                                             | IDE `execute_terminal_command`                                                           |
| ---------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| 每次调用增量开销 | ~9ms(OS spawn)                                                           | ~90ms(多一次 MCP 往返)                                                                   |
| 会话常驻         | ❌ 每次新 shell                                                          | ❌ 每次新 shell(`reuseExistingTerminalWindow` 也不保留变量 / `cd`)                       |
| `timeout`        | ✅ 生效:到点即中止并杀掉进程(长任务须自行调大)                           | **约 60 秒硬截止**,`timeout` 参数无法改变:到点返回已有输出 + `is_timed_out`,**不杀进程** |
| 输出截断         | `tool_output` 上限(默认 8000 行 / 256KB);想看结尾得在命令里自己接 `tail` | `maxLinesCount` + `truncateMode`,可**只留结尾**                                          |
| 用户可见性       | 只在 agent 侧                                                            | 在 IDE 里,用户可看 / 可接手                                                              |

**各自优势**

- **原生**:更快、超时可控 (到点杀进程)、输出上限更宽 —— **默认走这条**。
- **IDE**:
  ① **长任务**(安装 / 构建 / 迁移):`reuseExistingTerminalWindow: true` 让它在 IDE 终端里跑,用户 **能看进度、能随时取消**。
  但工具 **约 60 秒**就返回已产生的输出 (`is_timed_out: true`),之后命令仍在后台跑、AI 拿不到后续 —— 所以它适合
  "**交给用户盯**",不适合"AI 等最终结果"(那要用原生,或让命令把结果写文件再读)。
  ② **精确控制返回哪一段 + 行数**:`truncateMode` 取 `START`(保头)/`MIDDLE`(头+尾)/`END`(保尾)+ `maxLinesCount`。
  其中 **`MIDDLE` 是真正独有的** —— 原生超限时 **固定保尾部**,并把 **完整输出存成文件**返回路径,所以 `END` 与原生默认重复,
  而原生那份全量文件反而是 IDE 侧拿不到的 (IDE 丢弃的部分只留在终端)。

判据 (手工调用时的参考):**要"人看" 或 要"头 + 尾一起看" (`MIDDLE`) → IDE;其余 → 原生。**

**`truncateMode` 速查 (语义反直觉,以实测为准)**

| 传值           | 保留哪部分                 |
| -------------- | -------------------------- |
| 不传 / `START` | 开头                       |
| `MIDDLE`       | 头 + 尾                    |
| **`END`**      | **结尾**(截断标记在最上面) |
| `NONE`         | 全部,不截断                |

默认 `maxLinesCount` ≈ 1000 行,要更多就显式传。注意 `END` 是"**保留结尾**",不是"截掉结尾"。

## 测试

```bash
npm test
```

使用 [Vitest](https://vitest.dev/),含纯函数测试、IDE 环境解析、环境合并、启动保护状态机、IDE 启动器、引导文本,以及「假 IDE MCP
服务」的端到端探测与插件集成测试。

## License

MIT
