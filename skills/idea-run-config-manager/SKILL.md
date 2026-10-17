---
name: idea-run-config-manager
requires: create_shell_run_configuration
description: "管理本项目的 run configuration 并把它记成一份档案:新建配置(或没有工具时交给用户),以及配置被新建 / 删除 / 修改之后,把**项目根 `AGENTS.md`** 里由 `<!-- idea-run-config-manager:begin -->` 与 `<!-- idea-run-config-manager:end -->` 包裹的标记块同步更新 —— 每个 run configuration 一行,写清它干什么、怎么跑、什么时候跑;服务化的那些不在这里,它们归 `idea-standalone` 的块。当用户要建 / 删 / 改 run configuration,或要一份"这个项目有哪些配置、各自干什么"的说明时使用。"
metadata:
  opencode/autoinvoke: false
---

# idea-run-config-manager — 建配置 + 维护配置档案

## 它做两件事

1. **建**:把一条会重复跑的流程固化成 run configuration。判据与"先问用户"见引导文本:**这件事以后会不会以同样的形态再发生** —— 会就该建,而且**先把方案问过用户**(配置名 / 实际命令 / 工作目录 / 为什么值得留),同意才动手。
2. **建档**:每个 run configuration 在 `<项目根>/AGENTS.md` 的标记块里占一行,写清它**干什么、怎么跑、什么时候跑**。这是它的主要产物:**下次要办同类事情先看这张表**,有现成的就直接用,不要重复建。

**联动是硬要求**:配置被**新建 / 删除 / 修改**,文档就跟着**加行 / 删行 / 改行** —— 无论那次改动是谁做的(你用工具建的、用户自己建的、用户删掉的,都算)。改了配置却忘了同步这张表,等于这张表在骗下一个读者。

**别的文档只指向这里**:引导文本与 `idea-standalone` skill 碰到"要建 / 删 / 改一个 run configuration",都不再让用户自己去摸 —— 而是让用户调本 skill。所以增 / 删 / 改 run configuration 的**流程入口只有这一个**,而它由用户触发(用户 `@idea-run-config-manager` 把自己叫进来),不由模型自己挑。

## 产物

- **位置固定:项目根 `AGENTS.md`**,标记块 `<!-- idea-run-config-manager:begin -->` … `<!-- idea-run-config-manager:end -->`;块内是本 skill 的地盘,**块外一字不动** —— 尤其**不要触碰**其他 skill 的标记块(`idea-standalone` / `project-scaffold`)。
- 骨架与写作规范以 [assets/AGENTS.template.md](assets/AGENTS.template.md) 为准:生成或更新前**先读它**,沿用其中的表格列与生成提示。
  **`<!-- 生成提示:begin -->…<!-- 生成提示:end -->` 是给生成过程的说明,产物里整块删掉** —— 产物是给 AI 当规则读的,里面不该留指令。
- **服务化的配置不进本表**:它们已经登记在 `idea-standalone` 的块里。本表收的是**其余**的 run configuration。
- 只对这个项目生效;**不写**全局配置目录 (`~/.config/opencode/`),也不另建规则文件。

## 建

1. 先 `<前缀>_get_run_configurations` 查一遍:已经在做同一件事的配置**直接复用**,不要再建一个。
2. 把方案问过用户,同意才建。
3. `<前缀>_create_shell_run_configuration` 建:只支持 **Shell 类型**,`configurationName` + `scriptPath` / `scriptText` / `cloneFrom` 三选一。**非 Shell 类型你建不了** —— 把配置名 / 实际命令 / 工作目录 / 理由讲清楚,让用户在 IDE 里建;别手写 XML 凑。
4. 建完用 `<前缀>_get_run_configurations` 复查它真的出现了,再回文档加行。
5. **配置一律不由你手写**:不要写 `.run/*.run.xml`(写错 `type` IDE 会**静默忽略整个文件、日志里也不报**),也不要手搓启动命令。

## 扫描与建档

1. **先过滤**:读 `<项目根>/AGENTS.md` 里 `idea-standalone` 的标记块,记下它的表里出现过的 run configuration 名字 —— **这些不进本表**(服务化 / 长驻的,端口与热重载已在那边写清)。本表只收剩下的;没有那个块就不过滤。
2. **枚举以工具为准**:各项目各有自己的工具前缀(root 是 `ide`,子项目是它的目录名),逐个项目用**它自己那个前缀**的 `<前缀>_get_run_configurations`(直接调用,不传参数)。它给出该 IDE 项目真正认的配置 —— 包括存在 `.idea/` 里的那些,单翻 `.run/` 目录看不到。
3. 要写清某个配置"干什么"时,读它所在项目的落地文件 `.run/<name>.run.xml` 看它真正跑的命令;拿不准就**问用户**,不猜。
4. 逐行填表,**`项目` 列写前缀**;表里有、项目里已经没有的**整行删掉**。
5. 一个配置该由哪套工具跑,由它的前缀决定 —— 别拿 root 的工具去跑子项目的配置。

## 删与改

- **删除、修改配置本身没有工具**:这一步**要人来做** —— 告诉用户改哪个配置、改成什么(或哪个要删),由他在 IDE 里动手;不要手写或改 `.run/*.run.xml`,也不要手搓一条命令去替代它。
- 但**无论改动是谁做的**,你都要回 `AGENTS.md` 把对应的行同步:删掉的删行、改过的改行、新增的加行。
- 同步完再逐个项目用 `<前缀>_get_run_configurations` 对一遍:表里每个名字项目里都还在,项目里每个配置表里都有。

## 运行期

- 一次性 Job(跑完即退)→ `<前缀>_execute_run_configuration`;长驻进程 → `<前缀>_rerun_run_configuration`(在跑就重启、没在跑就启动),**不要**用 `execute` —— 它会起出重复实例。
- 停 → `<前缀>_stop_run_configuration`(停掉全部实例,幂等);**不要** `kill` / `pkill`:外部杀掉的进程 IDE 不知道,Run 窗口仍显示运行中,下次启动就撞端口。停 / 重启前后先 `<前缀>_list_running_configurations` 看真实状态。
- 这一组工具不存在时(没装配套插件 `idea-mcp-enhance`)**交给用户**:请他自己建 / 删 / 改,AI 只负责文档。
