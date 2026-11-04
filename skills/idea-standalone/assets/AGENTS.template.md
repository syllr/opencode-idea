<!-- idea-standalone:begin -->

# Standalone 模式纪律

<!-- 生成提示:begin -->

本块由 `idea-standalone` skill 生成与维护。标记内只写 standalone 模式的纪律;标记之外是项目自己在 `AGENTS.md` 里维护的内容,本
skill 一律不动。
`{...}` 是待替换的元变量,不留进产物。未涉及的条目与小节整块删掉,不留空标题。 **`<!-- 生成提示:… -->`
是给生成过程的说明,产物里整块删掉** —— 产物是给 AI 当规则读的,里面不该留指令。
<!-- 生成提示:end -->

## 一、什么是 standalone 模式

**standalone = 启动收口只有 IDEA run configuration** —— 每个应用的启动入口是 IDEA 的 run configuration (Run / Debug)
,不是手搓命令行;至于配置内部怎么起 (**本机进程 / 容器 / 部署到远端**)
,由它自己决定,本段不预设。给"本项目怎么起、起在哪"下定义,至少覆盖:

- **入口唯一 (唯一绝对的约束)**:每个应用的启动入口就是 IDEA 的 run configuration, **不是手搓命令行**。
- **形态不限**:配置可以起本机进程,也可以是容器 (Compose / K8s)、或部署到远端 —— 怎么起是配置的事,
  **不要假设它一定在本机直跑**。相应地,哪些应用 **不在本机跑、或本机起不来**要单独写明 (需要 GPU
  的服务、本机直连的远端数据库、只能部署后验证的服务),别当成"本机直跑"来验证。
- **只启动其中一部分是常态** —— 不要求所有应用都起来,用户可能只开一两个。
- **跑应用只用 `ide_rerun_run_configuration`**:在跑就重启、没在跑就启动 —— 不必分辨"这是启动还是重启",直接 rerun 就完事。
  常驻进程化 / 服务化的 run configuration 一律走这一条。
- **不要用 `ide_execute_run_configuration` 跑这些应用**:它是给 **命令 / Job 类型**的配置跑的,standalone 的配置是
  **常驻型**(起来就不退),
  用它只会起出重复实例。
- **也不要绕过 IDEA**:不用 `go run` / `pnpm dev` / `uvicorn` / `python -m ...` 这类裸命令起进程,更不要 `kill` / `pkill`
  业务进程 ——
  外部杀掉的进程 IDE 并不知道 (Run 窗口仍显示运行中,下次启动就撞端口)。
- **重启不必先问**:改完代码要重启哪个应用,直接 `ide_rerun_run_configuration` —— 这条链是无人化的,先征求同意只会把重启卡住。
- 工具列表里没有 `ide_rerun_run_configuration` 时 (没装配套插件):交回用户,请他在 IDEA 里手动跑,AI 不动手。
- **与部署链纪律互不构成许可**:本段管的是 **standalone 跑应用的方式**
  ,不适用于部署流程;反过来,部署链里的步骤也不构成"可以绕开本段、用裸命令在本机起应用"的许可 —— 两阶段纪律互相独立。

**配置、端口、热重载有变化时,本块要跟着改** —— 做法见 `idea-standalone` skill。

## 二、应用与环境

<!-- 生成提示:begin -->

**按应用分章节，应用下按环境分小节。** 不要按 run configuration 平铺 —— 同一个应用在几个环境里跑，就有几个小节。

- **应用名**用用户认得的（console / platform / gateway）。
- **环境**就是配置名的 `@env` 段（`base@env` 的 env）：一台服务器、一台本地电脑都算一个环境（`py` / `cmaitest` / `mbp`）。
  没有 `@env` 段的配置记作「默认」，照实写，不为好看另编环境名。

**每个应用先写应用级事实**（所有环境共用，不要在小节里重复；没有就整条删掉）：

- `是什么` —— 它是什么、什么技术栈、干什么。
- `依赖` —— 起它之前必须先起谁（另一个应用 / 中间件 / VPN）。
- `产物` —— **可选，只有部署型环境才写**。本地 run / debug 直接跑源码，不需要构建产物；只有「同步到远端再启动」的
  环境才写清：在哪个目录跑什么构建命令、产物落在哪。run configuration 只负责同步 + 启动，**不替你编译**。

**每个环境小节写四到六项**，标题是 `#### <env> —— \`<配置名>\``：

- `run` —— 怎么跑（常驻一律 `ide_rerun_run_configuration`）。
- `before run` —— **这个环境特有**、起之前要先做的事（先构建、先同步）；没有写 `无`。与应用级 `依赖` 不重复。
- `端口` —— 固定 / 默认 / 被占用即启动失败；读不到就问用户。
- `热重载` —— 有没有、什么机制、AI 改完代码要不要重启。
- `after run` —— 日志落在哪、什么算就绪、起来之后还要做什么；多数写 `无`。
- `差异` —— 可选：这个环境和默认环境的区别（换脚本、换 `.env`、少开某个中间件）。

**配置名必须是 `ide_get_run_configurations` 里真实存在的那个**，照实写，不为好看改配置名。缺配置就**先问用户要不要建**，
再用 `idea-run-config-manager` skill 建。

**变体不再另写一条** —— 环境就是小节的维度，`@env` 的不同本来就已经分开写了。

下面是示例（生成产物时删掉）：

```markdown
### console

- **是什么**：前端控制台（React + Vite dev server）
- **依赖**：先起 `platform`

#### 默认 —— `console-dev`

- run：`ide_rerun_run_configuration`
- before run：无
- 端口：5173，被占用时 Vite 自动顺延
- 热重载：有（Vite HMR）；改前端源码自动更新，无需重启
- after run：日志出现 `ready in` 即就绪

#### py —— `win@console-dev@py`

- run：`ide_rerun_run_configuration`
- before run：无
- 端口：5173
- 热重载：有（Vite HMR）
- after run：日志出现 `ready in` 即就绪
- 差异：Windows 个人变体，跑 `dev:py`，读 `apps/console/.env.py`

### platform

- **是什么**：平台服务端（Node + Fastify），经 Tailscale 连部署机上的中间件
- **依赖**：Tailscale 已连部署机

#### 默认 —— `platform-dev`

- run：`ide_rerun_run_configuration`
- before run：确认 `apps/platform/.env` 存在
- 端口：8080，被占用即启动失败
- 热重载：有（`node --watch`）；改 apps/platform 与 domains 源码自动重启；改 `.env` 或依赖需 rerun
- after run：日志出现 `Server listening at http://127.0.0.1:8080` 即就绪
```

<!-- 生成提示:end -->

`base@env`：base 是应用本体，env 是跑在哪台机器；换平台（Windows / Mac）也算换环境的一种。

### {应用}

- **是什么**：{这是什么服务 / 什么技术栈}
- **依赖**：{先起谁 / 无}
- **产物**：{仅部署型环境才写：构建命令 → 产物路径；本地跑源码就整条删掉}

#### {env} —— `{配置名}`

- run：{ide_rerun_run_configuration}
- before run：{这个环境特有的事 / 无}
- 端口：{固定 / 默认 / 被占用即启动失败}
- 热重载：{有（什么机制） / 无}；AI 改代码后：{自动生效 / 必须重启}
- after run：{日志落在哪 / ready 判据 / 无}

<!-- idea-standalone:end -->
