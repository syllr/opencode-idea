---
name: idea-standalone
description: "为项目固化 standalone(启动收口只有 IDEA run configuration)模式的纪律:写进项目根 `AGENTS.md` 的 `idea-standalone` 标记块,产物两段 —— standalone 是什么、经 run configuration 启动哪些应用(每个应用一条:端口、热重载、改完代码要不要重启)。要定「本机跑哪几个应用」「启停走哪个工具」「哪些应用改了必须重启」这类项目级纪律时使用。"
---

# idea-standalone — standalone 模式纪律

## 定位与管辖文档

本 skill 为项目固化它 **standalone 模式**(启动收口只有 IDEA run configuration)下怎么跑、AI 能做什么不能做什么。

- **产物位置固定:项目根 `AGENTS.md`**,作为其中一块,用 `<!-- idea-standalone:begin -->` 与 `<!-- idea-standalone:end -->`
  包裹。
  项目根 `AGENTS.md` 是 AI 在本项目工作时必读的文件,所以写在这里天然"总是生效",不需要额外的规则文件与开关。
- **标记之内由本 skill 生成与维护;标记之外的项目内容一律不动。**
- **目标产物的骨架、各段内容约定与写作规范以 [assets/AGENTS.template.md](assets/AGENTS.template.md) 为准**,本 skill 不另行维护
  章节骨架或逐段规则;生成或更新前必须先读该文件,并严格沿用其中的标题层级、标记与生成提示。
- 只对这个项目生效; **不写**全局配置目录 (`~/.config/opencode/`),也不另建规则文件。

## 读取

**现状**

- 读 `<项目根>/AGENTS.md`:有没有 `idea-standalone` 标记块 (有则更新,没有就在文件末尾追加)。
- 枚举:该项目的 `<前缀>_get_run_configurations` 直接调用,不传任何参数 —— 它给出 IDE 真正认的配置,连同启动细节 (程序参数、
  工作目录、环境变量、能否启动时覆盖)。 **条目里的 base 名与端口只能来自这里**,不用再去项目目录逐个翻配置文件。
- 只登记 base:名字是 `[os@]base[@env]` (`@` 分割、最多三段),带 `@` 段的一律 **取 base 部分登记**;平台 / 环境由名字里的
  段决定,不逐个列 —— 文法与选法见模板的「怎么读配置名」与「怎么选变体」。 **一条配置一个条目**:服务化 / 常驻的都算,
  同一个应用有多条就写多条。

**缺口** (逐条向用户确认,不猜)

- 端口:启动细节里没有、项目自身配置里也读不到 → **问用户**。
- 热重载:看运行方式 (项目类型 `package.json` / `pom.xml` / `go.mod` / `pyproject.toml` / `Cargo.toml` 决定有没有 HMR),
  不确定就问用户。
- 缺配置:`run configuration` 列表里没有某个应用 → **先问用户要不要建**,再用 `<前缀>_create_run_configuration` 建 (建配置是
  **项目资产**:把"配置名、干什么、为什么值得留"摊开给用户看,同意才建);工具列表里没有它时,请用户自己在 IDE 里建。建完
  **重新查一次**,再登记。不要手搓启动命令,也不要自己写配置文件。
- 归属:哪些配置进 standalone、`应用` 那一项填什么 (同一个应用可以有多条配置)、哪些配置名对不上 → 问用户。

**写之前**先读 [assets/AGENTS.template.md](assets/AGENTS.template.md)。

## 生成与更新

1. 归属判断:属于这两段的内容写进 `idea-standalone` 标记块;不属于的 (项目自己的其它纪律)留在标记外,本 skill 不写。
2. 先读 [assets/AGENTS.template.md](assets/AGENTS.template.md),按其中的生成提示逐段填充。 **
   `<!-- 生成提示:begin -->…<!-- 生成提示:end -->` 是给生成过程的说明,产物里整块删掉** —— 产物是给 AI 当规则读的,里面不该留指令。
   同时:**未涉及的条目与小节整块删掉**,不留空标题、不留 `{...}`。
3. **新增**(文件里还没有标记块):在 `AGENTS.md` **末尾追加**标记块,文件既有内容原样保留;文件不存在则创建它。
   只替换标记内内容、不动标记外 —— 尤其 **不要触碰**其他 skill 的标记块 (例如 `project-scaffold`)。
4. **更新**(已有标记块):只替换 `<!-- idea-standalone:begin -->` 与 `<!-- idea-standalone:end -->` 之间的内容,块外一字不动。
5. 改文件用 **IDE 的编辑命令** `<前缀>_apply_patch`(新建用 `<前缀>_create_new_file`),不要用原生 `write` / `edit`。
   **不要整文件重写**。
6. 复读并核对:标记块内逐段与模板一致,块外内容与改动前逐字一致,报告产物清单。
