---
name: idea-run-config-manager
requires: create_shell_run_configuration
description: "管理本项目的 run configuration:直接增 / 删 / 改(新建走工具,改和删直接编辑 `.run/<配置名>.run.xml` —— 都照**逐类型模板** `assets/types/` 写,没有模板的类型交给用户在 IDE 里配),并把配置档案同步进**项目根 `AGENTS.md`** 里由 `<!-- idea-run-config-manager:begin -->` 与 `<!-- idea-run-config-manager:end -->` 包裹的标记块 —— 每个 run configuration 一行,写清它干什么、怎么跑、什么时候跑;服务化的那些不在这里,它们归 `idea-standalone` 的块。当用户要建 / 删 / 改 run configuration,或要一份"这个项目有哪些配置、各自干什么"的说明时使用。"
metadata:
  opencode/autoinvoke: false
---

# idea-run-config-manager — 增删改 run configuration + 维护配置档案

**联动是硬要求**:配置被**新建 / 删除 / 修改**,文档就跟着**加行 / 删行 / 改行** —— 无论那次改动是谁做的(你做的、用户自己做的、用户删掉的,都算)。改了配置却忘了同步这张表,等于这张表在骗下一个读者。

## 流程

1. **读**:项目根 `AGENTS.md` —— 有没有 `<!-- idea-run-config-manager:begin -->` … `<!-- idea-run-config-manager:end -->` 标记块(有则更新,没有就在文件末尾追加);同时读同文件里 `idea-standalone` 的标记块,它登记过的配置不进本表。
2. **枚举**:逐个项目用**它自己那个前缀**的 `<前缀>_get_run_configurations` 直接调用,不传参数 —— 本项目的工具前缀跟着接入时的名字走(root 是 `ide`,子项目是它的目录名)。
3. **建 / 删 / 改**(**直接动手**):
   1. **先查重**:已经在做同一件事的配置直接复用,不要新建一个几乎一样的。
   2. **按类型找模板** —— 读 [assets/types/README.md](assets/types/README.md) 的支持矩阵:
      - **有模板** → 照 `assets/types/<类型>.md` 写文件。**Shell Script 类型**用 `<前缀>_create_shell_run_configuration` 新建;**其余类型**直接写 `.run/<配置名>.run.xml`;**改和删**就是编辑 / 删掉那个文件。
      - **没有模板**(矩阵里的 ⏳ / 之外的类型)→ **交给用户**:讲清要配什么(配置名、干什么、什么时候跑),请他在 IDE 里配好,你只负责把档案补上。
   3. **写完必须复查**:`<前缀>_get_run_configurations` 里要能看到它。**看不到就是文件没被 IDE 认** —— `type` 写错会被静默忽略且不报错,回去查 `type` / 文件位置 / 信封。
   4. **不要手搓启动命令**代替配置,也**不要写模板里没有的字段**(多余字段被忽略、名字写错静默用默认值,都不会报错)。
4. **同步文档**:按 [assets/AGENTS.template.md](assets/AGENTS.template.md) 逐段填,写在标记块内 —— **表格列、每一列写什么、枚举与过滤的要求,都在那份模板的生成提示里**,动手前先读它;生成提示是给生成过程的说明,**产物里整块删掉**,块外一字不动(尤其**不要触碰**其他 skill 的标记块)。
5. **核对**:表里每个名字项目里都还在,项目里每个配置表里都有。
