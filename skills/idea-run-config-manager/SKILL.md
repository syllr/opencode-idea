---
name: idea-run-config-manager
description: "管理本项目的 run configuration:增 / 删 / 改 / 改名走这几个工具(`create_run_configuration` / `update_run_configuration` / `delete_run_configuration` / `inspect_run_configuration`,不写文件;字段照 `assets/types/` 的实测模板),并把配置档案同步进项目根 `AGENTS.md` 的 `idea-run-config-manager` 标记块(一条配置一个条目:干什么、怎么跑、什么时候跑;服务化的归 `idea-standalone`)。要建 / 删 / 改 run configuration、要判断一条固定流程该不该固化成配置,或要一份「这个项目有哪些配置」的说明时使用。"
---

# idea-run-config-manager — 增删改 run configuration + 维护配置档案

**联动是硬要求**:配置被 **新建 / 删除 / 修改**,文档就跟着 **加条目 / 删条目 / 改条目** —— 无论那次改动是谁做的
(你做的、用户自己做的、用户删掉的,都算)。改了配置却忘了同步这个档案块,等于它在骗下一个读者。

**工具不在时**:先看工具表里有没有 `<前缀>_get_run_configurations` / `<前缀>_create_run_configuration`。没有,就是项目还没接入
IDE (或那个 IDE 没装 `idea-mcp-enhance`)—— 让用户执行 `/open-in-ide`,接入之前 **不要手写配置文件假装做完**(IDE
不认,复查也过不了)。

## 流程

1. **读**:项目根 `AGENTS.md` 里 `<!-- idea-run-config-manager:begin -->` … `<!-- idea-run-config-manager:end -->` 标记块
   (有则更新,没有就在文件末尾追加),以及同文件里 `idea-standalone` 的块;过滤规则在模板的生成提示里。
2. **枚举**:逐个项目用 **它自己那个前缀**的 `<前缀>_get_run_configurations` 直接调用,不传参数 —— 本项目的工具前缀跟着接入时的名字走
   (root 是 `ide`,子项目是它的目录名)。
3. **建 / 删 / 改**(**直接动手**):
    1. **先查重**:已经在做同一件事的配置直接复用,不要新建一个几乎一样的。 **查重按 (base, 平台, 职责) 三个维度比** —— 同一个
       base 在同一个平台上做同一件事才算重复;`base` 与 `base@<env>` 是同一 base 的两套环境,`base` 与 `win@base` 是同一
       base 的两个平台,都 **不算重复**,要各建各的。
    2. **走工具,不要自己写文件**:
        - **新建**:`<前缀>_create_run_configuration` —— 任意类型,内容来源三选一:`cloneFrom`(复制一个现成的,
          最稳)/ `configurationXml`(模板里的 XML 片段)/ 平台模板 + `options` / `attributes` / `envs` 补丁。
        - **修改 / 改名**:`<前缀>_update_run_configuration`。改字段用 `options` / `envs` 补丁;
          改名用 `newName`,它会 **连带更新别人对它的引用**并把历史日志的键一起迁移。
        - **删除**:`<前缀>_delete_run_configuration` —— 在跑或被人引用时会拒绝,`force = true` 才会连引用一起清掉。
        - **看一眼**:`<前缀>_inspect_run_configuration` —— 定义、命名解析、活实例、历史日志路径全在里面;
          构建 patch 之前先用它拿到当前值 (尤其 `configurationXml`)。
        - **模板是字段参考**:`assets/types/*.md` 用来查类型 id、看这个类型有哪些字段、`configurationXml` 该长什么样。
        - **建带平台 / 环境变体的配置** → 名字文法见 IDE 引导的「运行配置」(`win@base` / `base@env`);环境具体怎么接上问
          用户,或照项目里现成的同类配置来。
        - **没有模板**(矩阵之外)→ **走 `cloneFrom`**:复制一个同类型的现成配置再 patch 它的字段。
          字段名不确定时,这是 **唯一可靠**的路子 (照猜字段名 = 静默用默认值)。连一个同类型的现成配置都没有,
          才 **交给用户**:讲清要配什么 (配置名、干什么、什么时候跑),请他在 IDE 里配好,你只负责把档案补上。
    3. **写完必须复查**:工具的返回值就是结论 —— `canRun` 能不能跑、`unknownOptions` 有没有字段名被平台丢弃 (非空 =
       字段名拼错了)、`storagePath` 文件落在哪。再用 `<前缀>_get_run_configurations` 二次确认它已被 IDE 认到 —— **看不到就是没被
       IDE 认**。
    4. **不要手搓启动命令**代替配置,也 **不要写模板里没有的字段**(多余字段被忽略、名字写错静默用默认值,都不会报错)。
4. **同步文档**:按 [assets/AGENTS.template.md](assets/AGENTS.template.md) 的生成提示逐段填,写在标记块内 —— 条目怎么写、
   五项分别写什么、枚举与过滤的要求,都在那份模板的生成提示里,动手前先读它。 **块外一字不动**(尤其不要触碰其他 skill 的标记块)。
5. **核对**:块里每个名字项目里都还在,项目里每个配置块里都有。

## 支持矩阵 (一个类型一份模板)

| 类型              | `type` id                       | 模板                                 | 验证程度                                   |
| ----------------- | ------------------------------- | ------------------------------------ | ------------------------------------------ |
| Shell Script      | `ShConfigurationType`           | [shell](assets/types/shell.md)       | ✅ 实物(本机 6 例,含 Windows)               |
| Maven             | `MavenRunConfiguration`         | [maven](assets/types/maven.md)       | ✅ 实物                                     |
| Gradle            | `GradleRunConfiguration`        | [gradle](assets/types/gradle.md)     | ✅ 实物                                     |
| npm / yarn / pnpm | `js.build_tools.npm`            | [npm](assets/types/npm.md)           | ✅ 实物                                     |
| Python            | `PythonConfigurationType`       | [python](assets/types/python.md)     | ✅ 实物                                     |
| Go Build          | `GoApplicationRunConfiguration` | [go-build](assets/types/go-build.md) | ✅ 实物                                     |
| Node.js           | `NodeJSConfigurationType`       | [node](assets/types/node.md)         | ⚠️ `type` 与三个属性已验证,其余字段未验证 |
| Application       | `Application`                   | —                                    | ⏳ `type` 已验证,**字段层无实物**           |
| JAR               | `JarApplication`                | —                                    | ⏳ 同上                                     |

**矩阵之外一律没有模板** —— JUnit / TestNG / Kotlin / Docker / Spring Boot / Tomcat / Flyway / Liquibase / HTTP Request
等等。 **没有模板不等于建不了**:`cloneFrom` 复制一个同类型的现成配置再 patch 就能建,`assets/types/*.md` 只是 **字段参考**
(查类型 id、看这个类型有哪些字段),不是建配置的前置条件。模板由我们后续按需补上。

## 硬性契约 (所有类型都一样)

1. **落地位置不用管**:配置落在哪由工具决定 (项目级配置随项目共享);子项目的配置用 **子项目前缀**的工具建与查。
2. **`type` 与字段照类型模板抄**(`assets/types/*.md`,每份都带完整的 `configurationXml`) —— 没有模板就 `cloneFrom` 复制
   同类型的现成配置,别照猜:`type` 写错 = 整个文件被静默忽略、日志里也不报。工具的 `typeKnown` / `typeDisplayName` 会告诉你
   这台 IDE 认不认这个类型 (缺插件时是 `Unknown`)。
3. **路径宏**:`$PROJECT_DIR$` = 该项目根。 **项目内的路径一律用它**(`$PROJECT_DIR$/子目录/...`),不要写本机绝对路径 ——
   写死了别人 clone 下来就指到不存在的目录。

名字怎么读、变体怎么选 —— 见 IDE 引导的「运行配置」(每次请求都在);每条登记什么,见
[assets/AGENTS.template.md](assets/AGENTS.template.md) 的生成提示。两处都不在本文件重复。
