---
name: idea-run-config-manager
requires: create_shell_run_configuration
description: "管理本项目的 run configuration:直接增 / 删 / 改(新建走工具,改和删直接编辑 `.run/<配置名>.run.xml` —— 都照 `assets/types/` 里**逐类型实测模板**写,没有模板的类型交给用户在 IDE 里配),并把配置档案同步进**项目根 `AGENTS.md`** 里由 `<!-- idea-run-config-manager:begin -->` 与 `<!-- idea-run-config-manager:end -->` 包裹的标记块 —— 每个 run configuration 一行,写清它干什么、怎么跑、什么时候跑;服务化的那些不在这里,它们归 `idea-standalone` 的块。当用户要建 / 删 / 改 run configuration,或要一份"这个项目有哪些配置、各自干什么"的说明时使用。"
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
   2. **按类型找模板** —— 查下面的支持矩阵:
      - **有模板** → 照 [assets/types/](assets/types/) 里那份 `.md` 写文件。**Shell Script 类型**用 `<前缀>_create_shell_run_configuration` 新建;**其余类型**直接写 `.run/<配置名>.run.xml`;**改和删**就是编辑 / 删掉那个文件。
      - **没有模板**(⏳ 或矩阵之外)→ **交给用户**:讲清要配什么(配置名、干什么、什么时候跑),请他在 IDE 里配好,你只负责把档案补上。
   3. **写完必须复查**:`<前缀>_get_run_configurations` 里要能看到它。**看不到就是文件没被 IDE 认** —— `type` 写错会被静默忽略且不报错,回去查 `type` / 文件位置 / 信封。
   4. **不要手搓启动命令**代替配置,也**不要写模板里没有的字段**(多余字段被忽略、名字写错静默用默认值,都不会报错)。
4. **同步文档**:按 [assets/AGENTS.template.md](assets/AGENTS.template.md) 逐段填,写在标记块内 —— **表格列、每一列写什么、枚举与过滤的要求,都在那份模板的生成提示里**,动手前先读它;生成提示是给生成过程的说明,**产物里整块删掉**,块外一字不动(尤其**不要触碰**其他 skill 的标记块)。
5. **核对**:表里每个名字项目里都还在,项目里每个配置表里都有。

## 支持矩阵(一个类型一份模板)

| 类型              | `type` id                       | 模板                                 | 验证程度                                  |
| ----------------- | ------------------------------- | ------------------------------------ | ----------------------------------------- |
| Shell Script      | `ShConfigurationType`           | [shell](assets/types/shell.md)       | ✅ 实物(本机 6 例,含 Windows)             |
| Maven             | `MavenRunConfiguration`         | [maven](assets/types/maven.md)       | ✅ 实物                                   |
| Gradle            | `GradleRunConfiguration`        | [gradle](assets/types/gradle.md)     | ✅ 实物                                   |
| npm / yarn / pnpm | `js.build_tools.npm`            | [npm](assets/types/npm.md)           | ✅ 实物                                   |
| Python            | `PythonConfigurationType`       | [python](assets/types/python.md)     | ✅ 实物                                   |
| Go Build          | `GoApplicationRunConfiguration` | [go-build](assets/types/go-build.md) | ✅ 实物                                   |
| Node.js           | `NodeJSConfigurationType`       | [node](assets/types/node.md)         | ⚠️ `type` 与三个属性已验证,其余字段未验证 |
| Application       | `Application`                   | —                                    | ⏳ `type` 已验证,**字段层无实物**         |
| JAR               | `JarApplication`                | —                                    | ⏳ 同上                                   |

**矩阵之外一律没有模板** —— JUnit / TestNG / Kotlin / Docker / Spring Boot / Tomcat / Flyway / Liquibase / HTTP Request 等等。**没有模板的类型交给用户在 IDE 里自己新建、自己维护**,模板由我们后续按需补上。

## 硬性契约(所有类型都一样)

1. **落地位置**:项目根的 `.run/<配置名>.run.xml`(配置名带空格就原样用,例如 `Hello World.run.xml`)。子项目的配置写在**子项目自己的** `.run/` 下,并用**子项目前缀**的工具复查。
2. **信封固定**:

   ```xml
   <component name="ProjectRunConfigurationManager">
     <configuration default="false" name="<配置名>" type="<类型ID>">
       …该类型自己的字段…
       <method v="2" />
     </configuration>
   </component>
   ```

   `factoryName="<类型名>"` **可写可不写** —— 实物里两种都有,IDE 认的是 `type`。

3. **`type` 写错 = 整个文件被静默忽略,日志里也不报任何东西。** 每种类型都得有一份实测模板,就是为了不靠猜。
4. **写完必须复查**(见流程第 3 步):`get_run_configurations` 里看不到,就是文件没被认。
5. **路径宏**:`$PROJECT_DIR$` = 该项目根。同一台机器上的多个项目靠它区分,别写绝对路径。
6. **不要加本类型没有的字段**:多余的字段被忽略,名字写错则静默用默认值 —— 两种都不会报错,但会得到一个"看起来配好了其实没生效"的配置。
