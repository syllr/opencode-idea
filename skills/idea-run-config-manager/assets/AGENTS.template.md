<!-- idea-run-config-manager:begin -->

# run configuration 档案

<!-- 生成提示:begin -->

本块由 `idea-run-config-manager` skill 生成与维护:它是**项目里每个 run configuration 的说明书**。标记之外是项目自己在 `AGENTS.md` 里维护的内容,本 skill 一律不动。
`{...}` 是待替换的元变量,不留进产物。未涉及的表格行整块删掉,不留空标题。
**`<!-- 生成提示:… -->` 是给生成过程的说明,产物里整块删掉** —— 产物是给 AI 当规则读的,里面不该留指令。
<!-- 生成提示:end -->

这张表由 `idea-run-config-manager` 维护:配置被**新建 / 删除 / 修改**时,对应的行要跟着**加 / 删 / 改**。
配置内容本身不由 AI 手写 —— 要建 / 要删 / 要改的是 `.run/<name>.run.xml`,那是用户在 IDEA 里做的事。
长驻应用的**端口 / 热重载**细节归 `idea-standalone` 的表,这里不重复 —— 本表回答的是"它是干什么的、怎么跑"。

## run configuration 一览

<!-- 生成提示:begin -->

一行一个 run configuration,**项目里真正存在的都要有**(含用户在 IDEA 里自己建的)。
`run configuration` 列必须是 `<前缀>_get_run_configurations` 里**真实存在的名字**,不凭印象写;表里有、项目里没有的**整行删掉**。
**干什么**一句话说清它的作用(同步某个环境的 DDL / 生成代码 / 起前端 dev server …)—— 这是这张表的**主要价值**:下次要办同类事情先在这里找,有就直接用,不要再建一个重复的。
**怎么跑**写走哪条工具:跑完即退的用 `<前缀>_execute_run_configuration`;长驻进程用 `<前缀>_rerun_run_configuration`(在跑就重启、没在跑就启动)。
**何时跑**写触发场景;前置条件与坑(必须先备份 / 只对某个环境生效 / 幂等与否)写进**说明**,没有就留空,不要写"无"。
<!-- 生成提示:end -->

| run configuration | 干什么 | 怎么跑 | 何时跑 | 说明 |
| ----------------- | ------ | ------ | ------ | ---- |

<!-- idea-run-config-manager:end -->
