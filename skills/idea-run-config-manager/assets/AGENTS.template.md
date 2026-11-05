<!-- idea-run-config-manager:begin -->

# run configuration 档案

<!-- 生成提示:begin -->

标记之外是项目自己在 `AGENTS.md` 里维护的内容，本 skill 一律不动；也只写这个项目 —— 不写全局配置目录，不另建规则文件。

<!-- 生成提示:end -->

本项目里 **除服务化应用之外** 的 run configuration：每个配置 **是什么、怎么跑、什么时候跑**；服务化（长驻应用）的配置
登记在 `idea-standalone` 块里，不在这里。 **配置增删改之后，本块要跟着加 / 删 / 改条目** —— 做法见
`idea-run-config-manager` skill；块里和项目对不上，比没有块更糟。

**谁能起它，只有三种** —— 读这个块的人照它决定动不动手：

- **用户手动触发**：用户自己在 IDE 里跑，AI **完全不碰**。这类只登记在末尾「用户手动触发」一节，**只有名字**。
- **用户授权触发**：用户开口之后 AI 才跑（也可以在这个会话里一次性授权）；**AI 不自己挑时机**。
- **AI 自己触发**：AI 判断到场景就自己跑；这类条目的 `when` **必须把场景写具体**。

**先分清本地和远端**：

- **远端配置** = `type="RemoteProcess"`。一次 run = 同步 deployment（overwrite）+ 在远端启动进程，误触发的代价是线上被替换。
- **本地配置** = 其余全部（shell / maven / gradle / npm / node / python / go …），只动这台机器。

**远程配置一律只能是「用户授权触发」** —— AI 不得自己挑时机，包括“顺手验证一下”“跑一次看看”；
例外只有一条：用户在那次会话里明确说了“这次可以自己跑”。新建完要验证，先问用户；没授权就停在 `inspect` 通过。

**本地配置**可以是「AI 自己触发」，但**有副作用的**（发版、推迁移、动线上数据）同样按「用户授权触发」处理。

## run configuration 一览

<!-- 生成提示:begin -->

**先过滤**：服务化 / 常驻应用的配置 **一律不进本块**（它们归 `idea-standalone`，端口与热重载写在那边）。有
`idea-standalone` 的标记块时，再把它登记过的名字一并排除；没有那个块也照样按性质过滤。

**按应用分章节，应用下按环境分小节** —— 不要按配置平铺。不属于任何单个应用的固定流程（全仓 lint、仓库级生成）放
`### 通用`，它下面同样按 `本机` / 远端环境分小节。

- **应用名**用用户认得的（console / platform / gateway）。
- **环境**就是配置名里的 `@env` 段，**只对远端配置有意义**：值是 `hosts.json` 里的 server 名（`mbp` / `handwrite`）。
- **本机配置没有环境段**，统一归到 `本机` —— 例如 `本机 —— \`console-web\``；不分环境的固定流程也写 `本机`，
  例如 `本机 —— \`db-migrate\``。

**枚举以工具为准**：`ide_get_run_configurations` 直接调用、不传参数，它给出 IDE 真正认的配置（含存在 IDE 自己存储里、
不在项目目录的那些 —— 翻文件看不到）。**项目里真正存在的、过滤后剩下的都要有。** 条目里的配置名必须是真实存在的
名字，不凭印象写；块里有、项目里已经没有的 **整个条目删掉**。

**每个小节写这几项**，标题是 `#### <env> —— \`<配置名>\``（本机配置的 env 写 `本机`）：

- `类型` —— `本地` 或 `远端（RemoteProcess）`。远端的一律补一句「一次 run = 同步 deployment + 远端启动」，
  让人一眼知道这条会不会动线上。
- `when` —— 只写两种，先把是哪一种写明（见上）。**必须把场景写具体**，不写“需要时”“合适时”。
- `before run` —— 跑之前要先做的事（先装依赖 / 先构建 / 先同步 / 先起某个服务），**一条一步、按顺序排**；
  多数没有 —— 写 `无`（这一项始终在）。部署型配置这里必须写上 **Before launch 跑的那条配置名**，例如
  `由 Before launch 跑 \`platform-build@mbp\`（产物落到 docs/deployment/mbp/app）` —— 只写“先构建”等于没说。
- `run` —— 走哪条工具：跑完即退的用 `ide_execute_run_configuration`；长驻进程用 `ide_rerun_run_configuration`。
  **不要**用 `execute` 跑长驻进程 —— 它会给常驻进程起出重复实例，`waitForExit` 也会一直挂着。
- `after run` —— 跑完之后的结果：产物落在哪、接下来要不要做什么；**没有就写 `无`**。
- `说明` —— 它是什么、干什么；坑（要先备份 / 只对某个环境生效）；依赖关系。

**本地配置不需要写产物** —— 本地 run / debug 直接跑源码；只有部署型（Remote Process）才在 `before run` 里写明
构建来源。**构建本身是一条独立配置**（`{应用}-build@{env}`），它也要按本地配置登记一条，`when` 写
“由 `{应用}@{env}` 的 Before launch 触发，不单独跑”。

**部署链上的配置名一律带 `@env`**：`platform-build@mbp` 服务 `platform@mbp`，两者 env 相同；档案里看到
一条不带 env 的 `build` 且被 Remote Process 挂着，先改名字再登记。

**环境就是区分维度的方式，不要再写“变体”** —— `@env` 不同本来就已经分成小节了。
**目录、端口这类配置里本来就有的字段不抄进来** —— 会跟配置变旧而对不上。
**`说明` 与 `before run` 是本块的主要价值**：下次办同类事情先在这里搜关键词，找得到就直接用，**别再建一个重复的**。

**与 `idea-standalone` 块同名同序**：配置级的那几项（`before run` / `run` / `after run`）两边写成一样的名字与顺序；
本块多 `when`，那边多 `是什么` / `产物` / `依赖` / `端口` / `热重载`。两个块住在同一份 `AGENTS.md` 里，
名字对上了才看得出哪些是服务、哪些是固定流程。

示例（生成产物时删掉）：

```markdown
### platform

#### 本机 —— `db-migrate`

- 类型：本地
- when：用户授权触发 —— 改了 `packages/db` 的 schema 后要重新生成客户端并推迁移
- before run：无
- run：`ide_execute_run_configuration`
- after run：数据库结构更新，生成的客户端代码落在 `packages/db`
- 说明：先 `pnpm -C packages/db generate` 再 `migrate:deploy`；动远端数据，不由 AI 自行触发

#### mbp —— `platform@mbp`

- 类型：远端（`RemoteProcess`）—— 一次 run = 同步 deployment + 远端启动
- when：用户授权触发 —— 要把 platform 发到 mbp 时
- before run：由 Before launch 跑 `platform-build@mbp`（产物落到 `docs/deployment/mbp/app`）
- run：`ide_deploy_remote_process`
- after run：远端进程起来；Stop 只关日志，不 kill 远端
- 说明：只做同步 + 启动；构建在 Before launch 里，不写进 command

#### mbp —— `platform-build@mbp`

- 类型：本地
- when：由 `platform@mbp` 的 Before launch 触发，不单独跑
- before run：无
- run：`ide_execute_run_configuration`（仅排查构建时单独跑）
- after run：产物落到 `docs/deployment/mbp/app`，接着被 deploy 同步上去
- 说明：Node.js 配置，脚本只收 argv 参数、不读环境变量，一份代码在所有 OS 上跑
```

<!-- 生成提示:end -->

### {应用}

#### {env} —— `{配置名}`

- 类型：{本地 / 远端（`RemoteProcess`）—— 一次 run = 同步 deployment + 远端启动}
- when：{用户授权触发 / AI 自己触发} —— {什么场景}
- before run：{第 1 步 / 第 2 步 / 无}
- run：{ide_execute_run_configuration / ide_rerun_run_configuration / ide_deploy_remote_process}
- after run：{产物落在哪 / 接下来要做什么 / 无}
- 说明：{它是什么 + 有什么坑 + 依赖谁}

## 用户手动触发（线下，AI 不跑）

用户自己在 IDE 里跑的那种配置 —— AI 不碰，这里只登记名字。

<!-- 生成提示:begin -->

只写 **名字 + 类型**（类型用来区分本地 / 远端），**不要**写 run / when / before run / after run / 说明：
没人会照它跑，写了只是噪音。判断不了某一项是“授权”还是“手动”就 **问用户**。
<!-- 生成提示:end -->

- {配置名}（{本地 / 远端}，项目 ide）

<!-- idea-run-config-manager:end -->
