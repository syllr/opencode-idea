---
name: idea-standalone
description: "为项目生成/维护 standalone(经 IDEA 启动、本机进程直跑)模式的纪律 rule,写在项目根 `.opencode/rules/idea-standalone.md`。当用户要做 standalone 规范、要固化「本机跑哪几个应用」「哪些应用热重载、哪些改了必须重启」「AI 能不能启停本机进程」这类项目级纪律时使用。产出必须写清四段:standalone 是什么、standalone 下经 IDEA run configuration 启动哪些应用、逐应用的热重载与重启提示纪律、以及用户补充的其它条款。"
---

# Standalone 模式纪律 rule 生成器

## 产出物

一份 **项目级 rule**:`<项目根>/.opencode/rules/idea-standalone.md`,把这个项目在 **本机 standalone 模式**下怎么跑、AI
能做什么不能做什么固化下来。

- 位置固定:`.opencode/rules/`(项目级规则目录),文件名 `idea-standalone.md`。
- frontmatter 照抄项目里既有 rule 的格式 (`description` + `alwaysApply: true`)。
- 只对这个项目生效; **不写**全局规则目录 (`~/.config/opencode/rules/`)。

## 四段结构 (缺一不可)

### 第一段:什么是 standalone 模式

**standalone = 通过 IDEA 启动** —— 应用在本机进程直跑,不容器化、不部署到远端。给"本项目在本机的运行形态"下定义,至少覆盖:

- **通过 IDEA 启动**:每个应用的启动入口就是 IDEA 的 run configuration(Run / Debug),不是手搓命令行。
- **应用在本机进程直跑**:不容器化、不部署到远端。本机 **不跑**什么也要写明 (例如需要 GPU 的服务、或本机直连的远端数据库)。
- **只启动其中一部分是常态** —— standalone 不要求所有应用都起来,用户可能只开一两个。
- **启停一律由用户在 IDEA 手动完成**:AI 不得代为启停本机进程 —— 包括 `go run` / `pnpm dev` / `uvicorn` /
  `python -m ...` 这类起进程、`kill` / `pkill` 业务进程,以及经 `idea_execute_run_configuration` 启停。AI 若判断需要重启,
  **先向用户说明并取得明确授权**,绝不自行执行。
- **与部署链纪律互不构成许可**:standalone 的禁令不适用于部署流程,部署链的步骤也不构成"可以动本机进程"的许可 —— 两阶段纪律互相独立。

### 第二段:standalone 下启动哪些应用 (必须经 IDEA run configuration)

表格,一行一个应用:

| 应用 | run configuration | 目录 | 端口 | 说明 |
|------|-------------------|------|------|------|

要点:

- `run configuration` 列 **必须是 `idea_get_run_configurations` 里真实存在的名字**(不凭印象写);缺配置时先用
  `idea-run-config` skill 建项目级 `.run/*.run.xml`,不要手搓启动命令。
- **启动路径只能是 IDEA run configuration**:不写 `pnpm dev &`、`nohup ... &` 这类后台命令,也不建议用户这么干。
- 端口写清"固定 / 默认 / 被占用即启动失败"; **哪个应用必须先起来**也要写 (例如前端 dev server 的 proxy 指向本机后端)。
- 端口读不到 (配置里没有、也没写在项目配置里)就 **问用户**,不要编。

### 第三段:热重载矩阵 + 改代码后要不要提醒重启

逐应用写清 **是 / 不是**热重载,以及对应的提醒纪律:

| 应用                                                  | 热重载 | AI 改代码后                                           |
|-------------------------------------------------------|--------|-------------------------------------------------------|
| 带 HMR 的 dev server(如 Vite)                         | 是     | 不提醒重启                                            |
| 编译型 / 无热重载进程(如 `go run .`、`python -m ...`) | 否     | **必须**在回复里显式点名「需要重启 <应用>」并说明原因 |
| 只能跑在远端、本机起不来的服务                        | 不适用 | 本机无法验证,按部署链部署后再验证                     |

铁律:

- 非热重载的应用改动后, **不得**在没有提示的情况下宣称"改动完成 / 可以去验证了";重启动作由用户手动做。
- 热重载列必须有依据 (运行方式 → 有没有 HMR),不确定就问用户,不猜。
- `go run .` 这类 **没有热重载**的写法要写进 rule,别让 AI 以为改了代码就自动生效。

### 第四段起:项目补充条款

用户针对这个项目给的其它纪律, **按顺序续写在后面**(第四段、第五段……),例如:

- 文件写入位置 (禁止写哪些目录、跑测/调试产物必须落在哪儿)
- 测试纪律 (用例归属、什么时候才允许新增 UT、端到端测试在哪台机器上跑)
- 访问归属 (数据库 / 第三方接口只经哪个工具,不旁路直连)
- dev 模式特有限制 (会真实计费的操作、凭据存储方式等)

处理方式:用户给的条款 **逐条保留原意**、编号连续, **不合并不改写语义**。

## 流程

1. **收集事实 (不猜)**:
    - `idea_get_run_configurations` → 真实存在的配置名 (第二段"run configuration"列只能来自这里)。
    - `idea_search_file` 传 `q="*.run.xml"` + `paths: [".run"]` → 每个配置实际干什么 (命令 / 脚本 / npm script)。
    - `package.json` / `pom.xml` / `go.mod` / `pyproject.toml` / `Cargo.toml` → 项目类型 → 决定第三段的热重载列。
    - 端口:从 run configuration 的 option 或项目自身配置里读。
2. **补齐缺口**:哪些应用进 standalone、哪些配置名对不上、端口与热重载不确定 —— 逐条向用户确认,不编。
3. **写文件**:首次用 `idea_create_new_file` 写 `.opencode/rules/idea-standalone.md`;后续更新用 `idea_apply_patch`
   **定向改**,不整文件重写。
4. **校验**:第二段表格里每个配置名都能在 `idea_get_run_configurations` 里查到 —— **查不到就是错的**,不许用
   "应该生效了"结案。

## 铁律 (汇总)

1. 四段结构不能缺:standalone 定义 → 应用与 run configuration → 热重载与重启提醒 → 用户补充条款。
2. 第二段的启动方式 **只能是 IDEA run configuration**;不写手搓启动命令。
3. AI 不启停本机进程 (含 `idea_execute_run_configuration`);判断需要重启时先取得用户明确授权。
4. 配置名、端口、热重载三项都必须有依据;不确定就问用户。
5. 用户补充条款保留原意、编号连续,不合并不改写。
6. rule 只写项目级 `.opencode/rules/idea-standalone.md`,不写全局规则目录。
