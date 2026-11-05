<!-- idea-run-config-manager:begin -->

# run configuration 档案

<!-- 生成提示:begin -->

本块由 `idea-run-config-manager` skill 生成与维护，是**唯一**一块：本机配置和远端配置都写在这里。
标记之外是项目自己在 `AGENTS.md` 里维护的内容，一律不动；只写这个项目 —— 不写全局配置目录，不另建规则文件。

`{...}` 是待替换的元变量，产物里不留。未涉及的条目与小节整块删掉，不留空标题。
`<!-- 生成提示:begin/end -->` 之间是给生成过程的说明，**产物里整块删掉** —— 产物是给 AI 当规则读的，里面不该留指令。

**枚举以工具为准**：`ide_get_run_configurations` 直接调用、不传参数 —— 它给出 IDE 真正认的配置，包括存在 IDE
自己存储里、翻文件看不到的那些。**项目里真正存在、该登记的都要有**；块里有、项目里已经没有的整条删掉。

**临时配置不登记**：为了验证某条命令临时建的、跑完就删的配置不进档案；只登记「以后还会再用」的。

<!-- 生成提示:end -->

**谁能起它，只有三种** —— 读这个块的人照它决定动不动手：

- **用户手动触发**：用户自己在 IDE 里跑，AI **完全不碰**。这类只登记在末尾「用户手动触发」一节，**只有名字**。
- **用户授权触发**：用户开口之后 AI 才跑（也可以在这个会话里一次性授权）；**AI 不自己挑时机**。
- **AI 自己触发**：AI 判断到场景就自己跑；这类条目的 `when` **必须把场景写具体**，不写“需要时”“合适时”。

## 运行纪律

<!-- 生成提示:begin -->

只保留本项目**实际成立**的条目。项目里若还有手搓命令、容器编排等不经过 run configuration 的入口，如实改写
（例如「除 X 外，其余应用的启动入口是 run configuration」），不要照抄成一句绝对的话。

<!-- 生成提示:end -->

本项目的启动入口是 IDEA run configuration：**本机进程和远端进程都一样**，不用 `pnpm dev` / `go run` / `docker run`
这类裸命令起。

- **入口唯一**：每个应用的启动入口就是 IDE 的 run configuration（Run / Debug），不是手搓命令行。
- **形态不限**：配置可以起本机进程、容器（Compose / K8s）、或同步到远端再启动 —— 怎么起是配置的事。哪些应用不在本机跑、
  或本机起不来（需要 GPU、直连远端数据库、只能部署后验证），写在对应应用条目里。
- **只启动其中一部分是常态**：不要求所有应用都起来，用户可能只开一两个。
- **跑应用只用 `ide_rerun_run_configuration`**：在跑就重启、没在跑就启动 —— 不必分辨是启动还是重启。它认得 server 语义：
  只等启动被**触发**就返回，进程起没起按 2s / 4s / 8s / 16s 退避查（`running: true` 只代表 Run 会话存在，不代表服务可用）。
- **不要绕过 IDEA**：更不要 `kill` / `pkill` 业务进程 —— 外部杀掉的进程 IDE 并不知道（Run 窗口仍显示运行中，下次启动撞端口）。
- **重启不必先问**：改完代码要重启哪个应用，直接 rerun —— 这条链是无人化的，先征求同意只会把重启卡住。
- **远程配置一律「用户授权触发」**：`RemoteProcess` 一次 run 就替换线上；新建完要验证也先问用户，没授权就停在 `inspect` 通过。
- **工具列表里没有 `ide_rerun_run_configuration`**（没装配套插件）：交回用户，请他在 IDEA 里手动跑，AI 不动手。

## 应用配置

<!-- 生成提示:begin -->

**按应用分章节，应用下按环境分小节**，不要按配置平铺。应用名用用户认得的（console / platform / gateway）。
不承载某个应用启动的固定流程（构建、迁移、测试）放后面的「非应用配置」，不要硬塞进某个应用。

- **环境**就是配置名的 `@env` 段：一台服务器算一个环境（`mbp` / `handwrite`）；本机配置没有 `@env`，统一写 `默认`。
  换平台（Windows / Mac）也算换环境，照实写，不为好看另编名字。
- **应用级事实**（所有环境共用，不要在小节里重复；没有就整条删掉）：`是什么` / `依赖` / `产物`。
  `产物` 只在「同步到远端再启动」时写：在哪个目录跑什么构建命令、产物落在哪 —— run configuration 只负责同步 + 启动，
  **不替你编译**。
- **配置名必须是 `ide_get_run_configurations` 里真实存在的那个**，不为好看改名字。缺配置就**先问用户要不要建**，
  同意后按本 skill 的流程建，建完重新查一次再登记。
- **变体不另写一条**：`@env` 不同本来就已经分小节了。
- **`run` 只按配置类型选**：发布型的远端配置（`RemoteProcess`，整条部署链的最后一环）写
  `ide_deploy_remote_process`；其余（本机调试、构建、迁移）一律 `ide_rerun_run_configuration`。
  不需要按场景临场判断。- **`端口` / `热重载` 只对 server 有意义**，`kind: build` 的条目整行删掉。
- **`说明` 与 `before run` 是本块的主要价值**：下次办同类事情先在这里搜关键词，找得到就直接用，别再建一个重复的。

示例（生成产物时删掉）：

```markdown
### console

- **是什么**：前端控制台（React + Vite dev server）
- **依赖**：先起 `platform`

#### 默认 —— `console-dev`

- 类型：本地
- kind：server
- when：AI 自己触发 —— 改完前端代码要本地看效果时
- before run：无
- run：`ide_rerun_run_configuration`
- 端口：5173，被占用时 Vite 自动顺延
- 热重载：有（Vite HMR）；改前端源码自动更新，无需重启
- after run：日志出现 `ready in` 即就绪
- 说明：起它之前 `platform` 已经在跑，否则接口全 502
```

<!-- 生成提示:end -->

### {应用}

- **是什么**：{这是什么服务 / 什么技术栈}
- **依赖**：{先起谁 / 无}
- **产物**：{仅部署型环境才写：构建命令 → 产物路径；本地跑源码就整条删掉}

#### {env} —— `{配置名}`

- 类型：{本地 / 远端（`RemoteProcess`）—— 一次 run = 同步 deployment + 远端启动}
- kind：{build / server}（`build` = 跑完就退，工具返回的 `runKind` 是 `job`；`server` = 常驻。远端的 `RemoteProcess` 恒为 `server`）
- when：{用户授权触发 / AI 自己触发} —— {什么场景}
- before run：{第 1 步 / 第 2 步 / 无}
- run：{ide_rerun_run_configuration / ide_deploy_remote_process}
- 端口：{固定 / 默认 / 被占用即启动失败}（只有 server 写）
- 热重载：{有（什么机制）/ 无}；AI 改代码后：{自动生效 / 必须重启}（只有 server 写）
- after run：{产物落在哪 / 日志落在哪、什么算就绪 / 无}
- 说明：{它是什么 + 有什么坑 + 依赖谁}

## 非应用配置

<!-- 生成提示:begin -->

构建、迁移、测试、一次性任务 —— **不承载某个应用的启动**。平铺，`####` 直接写配置名；超过五条再按用途分
`###` 小节，不要一上来就分组，也不要把它们塞回某个应用底下。

`端口` / `热重载` 一般不适用，整行删掉；`kind` 仍然要写 —— 少数常驻的（本地 mock 服务、本地中间件）是 `server`。

示例（生成产物时删掉）：

```markdown
#### `aidata-build@mbp`

- 类型：本地
- kind：build
- when：由 `aidata@mbp` 的 Before launch 触发，不单独跑
- before run：无
- run：`ide_rerun_run_configuration`（仅排查构建时单独跑）
- after run：产物落到 `docs/deployment/mbp/app`，接着被 deploy 同步上去
- 说明：Node.js 配置，脚本只收 argv 参数、不读环境变量，一份代码在所有 OS 上跑
```

<!-- 生成提示:end -->

#### `{配置名}`

- 类型：{本地 / 远端（`RemoteProcess`）}
- kind：{build / server}
- when：{用户授权触发 / AI 自己触发 / 由 `{父配置}` 的 Before launch 触发，不单独跑}
- before run：{… / 无}
- run：{ide_rerun_run_configuration / ide_deploy_remote_process}
- after run：{产物落在哪 / 无}
- 说明：{它是什么 + 有什么坑}

## 用户手动触发（线下，AI 不跑）

用户自己在 IDE 里跑的那种配置 —— AI 不碰，这里只登记名字。

<!-- 生成提示:begin -->

只写 **名字 + 类型**（类型用来区分本地 / 远端），**不要**写 run / when / before run / after run / 说明：
没人会照它跑，写了只是噪音。判断不了某一项是“授权”还是“手动”就 **问用户**。
<!-- 生成提示:end -->

- {配置名}（{本地 / 远端}，项目 ide）

<!-- idea-run-config-manager:end -->
