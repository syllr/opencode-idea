---
name: idea-standalone
description: "为项目生成/维护 standalone(启动收口只有 IDEA run configuration)模式的纪律,写进**项目根 `AGENTS.md`** 里由 `<!-- idea-standalone:begin -->` 与 `<!-- idea-standalone:end -->` 包裹的标记块。当用户要做 standalone 规范、要固化「本机跑哪几个应用」「哪些应用热重载、哪些改了必须重启」「启停走哪个工具」这类项目级纪律时使用。产物固定三段:standalone 是什么、经 IDEA run configuration 启动哪些应用、逐应用的热重载与重启提示纪律。"
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

- **工具名前缀跟着项目走**:本项目的工具前缀由它接入时的名字决定 —— root 是 `ide`,子项目是它的目录名。下文的
  `<前缀>_` 就是它 (例如 `ide_get_run_configurations` 或 `modelserver_get_run_configurations`)。
- 读 `<项目根>/AGENTS.md`,确认是否已存在 `idea-standalone` 标记块 (更新)或需要在文件末尾追加 (新增)。
- **只登记 base**:run configuration 的名字是 `[os@]base[@env]`,`@` 分割、最多三段 (os 段 `win` = Windows、缺省 =
  macOS/Linux;base 段 = 配置本体;env 段 = 环境名、缺省 = 所有环境通用这一套)。
  `get_run_configurations` 给的名字里,带 `@` 段的都 **取 base 部分登记** —— 平台 / 环境由名字里的段决定,不逐个列
  (文法与选法见 [assets/AGENTS.template.md](assets/AGENTS.template.md) 的「run configuration 名字怎么读」与「选哪个变种」)。
- **该项目的 `<前缀>_get_run_configurations` 直接调用,不传任何参数** → 项目里已有的 run configuration 就是 **用户已经在
  IDEA 里配好的那些**,
  这一次调用会把它们的名字连同启动细节 (程序参数、工作目录、环境变量、是否支持启动时覆盖)一并给出。
  第二段的 `run configuration` 列、以及端口, **只能来自这里** —— 不需要再去逐个翻 `.run/*.run.xml`,那份列表已经是配置的结果。
- 项目类型 (`package.json` / `pom.xml` / `go.mod` / `pyproject.toml` / `Cargo.toml`)→ 决定第三段的热重载列。
- 端口:先看上面那份启动细节里有没有;项目自身配置里也读不到就 **问用户**,不要编。
- `run configuration` 列表里缺某个应用:**交给用户** —— 让他调 `idea-run-config-manager` skill 去建 (那个 skill 管这个项目
  run configuration 的增 / 删 / 改;工具列表里没有它时,请用户自己建一个),建完 **重新查一次**。不要手搓启动命令,也不要自己写
  `.run/*.run.xml`。
- 补齐缺口:哪些应用进 standalone、哪些配置名对不上、端口与热重载不确定 —— **逐条向用户确认**,不猜。
- 生成或更新前先读 [assets/AGENTS.template.md](assets/AGENTS.template.md),确认三段与各段生成提示。

## 生成与更新

1. 归属判断:属于三段骨架的内容写进 `idea-standalone` 标记块;不属于的 (项目自己的其它纪律)留在标记外,本 skill 不写。
2. 先读 [assets/AGENTS.template.md](assets/AGENTS.template.md),按其中的生成提示逐段填充。 **
   `<!-- 生成提示:begin -->…<!-- 生成提示:end -->` 是给生成过程的说明,产物里整块删掉** —— 产物是给 AI 当规则读的,里面不该留指令。
   同时:**未涉及的表格行与小节整块删掉**,不留空标题、不留 `{...}`。
3. **新增**(文件里还没有标记块):在 `AGENTS.md` **末尾追加**标记块,文件既有内容原样保留;文件不存在则创建它。
   只替换标记内内容、不动标记外 —— 尤其 **不要触碰**其他 skill 的标记块 (例如 `project-scaffold`)。
4. **更新**(已有标记块):只替换 `<!-- idea-standalone:begin -->` 与 `<!-- idea-standalone:end -->` 之间的内容,块外一字不动。
5. 用原生 `edit` 做定向替换;文件不存在时才用 `write` 创建。 **不要整文件重写**。
   「run configuration 名字怎么读」与「选哪个变种」两节是 **固定文本**,照抄,不要改写、不要删条目 —— 它们是读名字与选环境的规则,应用表靠它们才成立。
   **平台 / 环境变体不另起条目、也不另起表** —— 一张应用表,`run configuration` 列填 base;变体怎么切环境写进那一行的
   `desc`。
6. 复读并核对:标记块内逐段与模板一致,块外内容与改动前逐字一致,报告产物清单。
