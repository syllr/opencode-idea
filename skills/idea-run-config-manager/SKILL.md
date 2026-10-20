---
name: idea-run-config-manager
description: "管理本项目的 run configuration:**增 / 删 / 改 / 改名全部走工具**(`create_run_configuration` / `update_run_configuration` / `delete_run_configuration` / `inspect_run_configuration`,不要手写 `.run/` 下的文件;类型字段照 `assets/types/` 里的实测模板作参考),并把配置档案同步进**项目根 `AGENTS.md`** 里由 `<!-- idea-run-config-manager:begin -->` 与 `<!-- idea-run-config-manager:end -->` 包裹的标记块 —— 每个 run configuration 一个条目,写清它干什么、怎么跑、什么时候跑;服务化的那些不在这里,它们归 `idea-standalone` 的块。当用户要建 / 删 / 改 run configuration,或要一份「这个项目有哪些配置、各自干什么」的说明时使用。"
metadata:
  opencode/autoinvoke: false
---

# idea-run-config-manager — 增删改 run configuration + 维护配置档案

**联动是硬要求**:配置被 **新建 / 删除 / 修改**,文档就跟着 **加条目 / 删条目 / 改条目** —— 无论那次改动是谁做的
(你做的、用户自己做的、用户删掉的,都算)。改了配置却忘了同步这个档案块,等于它在骗下一个读者。

**工具不在时**:先看工具表里有没有 `<前缀>_get_run_configurations` / `<前缀>_create_run_configuration`。没有,就是项目还没接入
IDE (或那个 IDE 没装 `idea-mcp-enhance`)—— 让用户执行 `/open-in-ide`,接入之前 **不要手写 `.run/*.run.xml` 假装做完**(IDE
不认,复查也过不了)。

## 流程

1. **读**:项目根 `AGENTS.md` —— 有没有 `<!-- idea-run-config-manager:begin -->` … `<!-- idea-run-config-manager:end -->`
   标记块 (有则更新,没有就在文件末尾追加);同时读同文件里 `idea-standalone` 的标记块,它登记过的配置不进本块。
2. **枚举**:逐个项目用 **它自己那个前缀**的 `<前缀>_get_run_configurations` 直接调用,不传参数 —— 本项目的工具前缀跟着接入时的名字走
   (root 是 `ide`,子项目是它的目录名)。
3. **建 / 删 / 改**(**直接动手**):
    1. **先查重**:已经在做同一件事的配置直接复用,不要新建一个几乎一样的。 **查重按 (base, 平台, 职责) 三个维度比** —— 同一个
       base 在同一个平台上做同一件事才算重复;`base` 与 `base@<env>` 是同一 base 的两套环境,`base` 与 `win@base` 是同一
       base 的两个平台,都 **不算重复**,要各建各的。
    2. **走工具,不要手写 `.run/` 下的文件**:
        - **新建**:`<前缀>_create_run_configuration` —— 任意类型,内容来源三选一:`cloneFrom`(复制一个现成的,
          最稳)/ `configurationXml`(模板里的 XML 片段)/ 平台模板 + `options` / `attributes` / `envs` 补丁。
          Shell 场景也可以用它的快捷入口 `<前缀>_create_run_configuration`。
        - **修改 / 改名**:`<前缀>_update_run_configuration`。改字段用 `options` / `envs` 补丁;
          改名用 `newName`,它会**连带更新别人对它的引用**并把历史日志的键一起迁移。
        - **删除**:`<前缀>_delete_run_configuration` —— 在跑或被人引用时会拒绝,`force = true` 才会连引用一起清掉。
        - **看一眼**:`<前缀>_inspect_run_configuration` —— 定义、命名解析、活实例、历史日志路径全在里面;
          构建 patch 之前先用它拿到当前值(尤其 `configurationXml`)。
        - **模板的用途变了**:`assets/types/*.md` 不再是"照着写文件"的说明书,而是**字段参考**:查类型 id、
          看这个类型有哪些字段、`configurationXml` 该长什么样。
        - **建带平台 / 环境变体的配置** → 名字按第 7 条的文法拼 (`win@base` / `base@env`),并且 **把环境真正接上**(第 8
          条):环境变量路线要把环境名同时写进 `envs` 与 `SCRIPT_TEXT` 前缀,启动参数路线要在 `SCRIPT_TEXT` 里带对应参数。
          **名字对了但环境没接上 = 没配好。**
        - **没有模板**(⏳ 或矩阵之外)→ **交给用户**:讲清要配什么 (配置名、干什么、什么时候跑),请他在 IDE 里配好,你只负责把档案补上。
    3. **写完必须复查**:`<前缀>_get_run_configurations` 里要能看到它。 **看不到就是文件没被 IDE 认** —— `type`
       写错会被静默忽略且不报错;工具返回的 `unknownOptions` 就是字段名拼错的证据。
    4. **不要手搓启动命令**代替配置,也 **不要写模板里没有的字段**(多余字段被忽略、名字写错静默用默认值,都不会报错)。
4. **同步文档**:按 [assets/AGENTS.template.md](assets/AGENTS.template.md) 逐段填,写在标记块内 ——
   **条目怎么写、五项分别写什么、枚举与过滤的要求,都在那份模板的生成提示里**,动手前先读它;生成提示是给生成过程的说明,
   **产物里整块删掉**,块外一字不动 (尤其 **不要触碰**其他 skill 的标记块)。
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
等等。 **没有模板的类型交给用户在 IDE 里自己新建、自己维护**,模板由我们后续按需补上。

## 硬性契约 (所有类型都一样)

1. **落地位置**:项目根的 `.run/<配置名>.run.xml`(配置名带空格就原样用,例如 `Hello World.run.xml`)。子项目的配置写在
   **子项目自己的** `.run/` 下,并用 **子项目前缀**的工具复查。
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
5. **路径宏**:`$PROJECT_DIR$` = 该项目根。 **项目内的路径一律用它**(`$PROJECT_DIR$/子目录/...`),不要写本机绝对路径 ——
   写死了别人 clone 下来就指到不存在的目录。
6. **跨机器共享 (`.run/*.run.xml` 是进 git 给全组共用的)**:按"绑在哪一层"分三档,建 / 改配置前对着过一遍:
    - **项目级**(可直接共享):配置名、命令、仓库内的路径、工作目录、`EXECUTE_*`、前置任务 → 直接进 git。
    - **OS 级**(每个 OS 一份;同 OS 内路径是常量,人人一样,可共享):脚本后缀、命令语法差异、平台专属工具 → mac/Linux 一份,
      Windows 一份 (见第 7 条的命名文法)。
    - **机器 / 人级**(不可共享):本机绝对路径、本机 SDK 实例 (venv / JDK 路径)、`envs` 里的本机值 (端口 / 主机名 / 凭据)
      、IDE path variable (`.idea/` 不进 git) → **不要写进 run config**,挪到 `.env`、仓库里的配置文件,或 IDE 的项目级设置。
7. **命名文法:`[os@]base[@env]`,`@` 分割、最多三段**:

    - **os 段**(最前):`win` = Windows; **缺省 = macOS / Linux**。
    - **base 段**(中间):配置本体,必填。
    - **env 段**(最后):环境名; **缺省 = 所有环境通用这一套**。

    - `win@base`(换平台)与 `base@env`(换环境)都是 **同一个 base 的变体** —— 同一件事,平台不同 / 环境不同。 **档案只登记
      base**,变体不另起条目;把"有哪些变体、各自怎么切环境"写进 base 的 `desc`。
    - **用 `@` 不用 `-` 切分**:名字里本来就有多个连字符 (`console-web`),用 `@` 才切得清前后缀;`@` 在文件名里合法 (落地就是
      `.run/win@console-web.run.xml`,IDE 认得、跑得起来,已实测)。
8. **多环境 = 选环境,不是复制配置**:环境变体有两条实现路线, **选哪条由该语言 / 框架的业务决定**:
    - **环境变量**:运行配置的 `envs` 里给环境名 (`APP_ENV=yutao`),应用启动时按它选自己那份配置。
      **不读配置文件的业务就走这条**。
    - **启动参数**:`SCRIPT_TEXT` 里带 `--env-file=env/yutao.env` / `--config=...` 之类,应用按参数选配置。
    - 走 **环境变量**那条时, **环境名要同时写进 `SCRIPT_TEXT` 前缀**(`APP_ENV=yutao pnpm ...`):IDE 面板点 Run 认 `envs`
      ,但 MCP 执行通道只认 `SCRIPT_TEXT`(实测)。
    - **环境名是项目级的、可共享**(进 git);地址 / 凭据在 env 文件里, **不进 run config**。
    - **读代码确认这一套到底怎么切环境**,别猜;档案的 `desc` 里写清。
9. **选环境要问一次,别反复打扰**:
    - `base` 与 `base@<env>` 同时存在 = 同一件事的两套环境 → **启动前问一次用户走哪套**
      (问的是"走哪个环境",不是"要不要启动")。
    - 用户选定后, **本会话内默认走这一套**,用户不说改就不改;只有当你判断环境要变 (用户提到换机器 / 换环境、要部署到别处)
      才再确认一次。
    - 确认过就别再问 —— 改代码 → 自己重启 → 同一套变体。 **AI 干活的链路上不打扰用户**,这正是这套命名要达到的效果。
10. **不要加本类型没有的字段**:多余的字段被忽略,名字写错则静默用默认值 ——
    两种都不会报错,但会得到一个"看起来配好了其实没生效"的配置。
