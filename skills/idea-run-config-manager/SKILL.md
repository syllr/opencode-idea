---
name: idea-run-config-manager
requires: create_shell_run_configuration
description: "管理本项目的 run configuration 并把它记成一份档案:新建配置(或没有工具时交给用户),以及配置被新建 / 删除 / 修改之后,把**项目根 `AGENTS.md`** 里由 `<!-- idea-run-config-manager:begin -->` 与 `<!-- idea-run-config-manager:end -->` 包裹的标记块同步更新 —— 每个 run configuration 一行,写清它干什么、怎么跑、什么时候跑;服务化的那些不在这里,它们归 `idea-standalone` 的块。当用户要建 / 删 / 改 run configuration,或要一份"这个项目有哪些配置、各自干什么"的说明时使用。"
metadata:
  opencode/autoinvoke: false
---

# idea-run-config-manager — 建配置 + 维护配置档案

**联动是硬要求**:配置被**新建 / 删除 / 修改**,文档就跟着**加行 / 删行 / 改行** —— 无论那次改动是谁做的(你用工具建的、用户自己建的、用户删掉的,都算)。改了配置却忘了同步这张表,等于这张表在骗下一个读者。

## 流程

1. **读**:项目根 `AGENTS.md` —— 有没有 `<!-- idea-run-config-manager:begin -->` … `<!-- idea-run-config-manager:end -->` 标记块(有则更新,没有就在文件末尾追加);同时读同文件里 `idea-standalone` 的标记块,它登记过的配置不进本表。
2. **枚举**:逐个项目用**它自己那个前缀**的 `<前缀>_get_run_configurations` 直接调用,不传参数 —— 本项目的工具前缀跟着接入时的名字走(root 是 `ide`,子项目是它的目录名)。
3. **建 / 删 / 改**:
   - **建**:先查重、把方案问过用户(判据与"先问用户"见引导文本),同意后用 `<前缀>_create_shell_run_configuration`(只支持 **Shell 类型**),建完复查它真的出现了。**其他类型你建不了**,交给用户。
   - **删 / 改**:没有工具:**交给用户** —— 说清哪个配置、改成什么,由他动手。
   - **配置一律不由你手写**:不要写 `.run/*.run.xml`,也不要手搓启动命令。
4. **同步文档**:按 [assets/AGENTS.template.md](assets/AGENTS.template.md) 逐段填,写在标记块内 —— **表格列、每一列写什么、枚举与过滤的要求,都在那份模板的生成提示里**,动手前先读它;生成提示是给生成过程的说明,**产物里整块删掉**,块外一字不动(尤其**不要触碰**其他 skill 的标记块)。
5. **核对**:表里每个名字项目里都还在,项目里每个配置表里都有。
