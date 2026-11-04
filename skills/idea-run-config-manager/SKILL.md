---
name: idea-run-config-manager
description: "管理本项目的 run configuration：新建 / 修改 / 删除 / 改名都直接读写项目 `.run/<名字>.run.xml`，不经过任何 IDE 写工具；写完用 `ide_inspect_run_configuration` 做静态检查，再用 `ide_rerun_run_configuration` 真跑一次。覆盖本地类型（shell / maven / gradle / npm / python / go / node）与远端 `RemoteProcess`（server + deployment）。并把配置档案同步进项目根 `AGENTS.md` 的 `idea-run-config-manager` 标记块。要建 / 改 / 删 run configuration、要判断一条固定流程该不该固化成配置、要部署到远端、或要一份「这个项目有哪些配置、哪条能自己跑」的说明时使用。"
---

# idea-run-config-manager — 读写 `.run/` + 维护配置档案

**联动是硬要求**：配置被**新建 / 删除 / 修改**，文档就跟着**加条目 / 删条目 / 改条目** —— 无论那次改动是谁做的
（你做的、用户自己做的、用户删掉的，都算）。改了配置却忘了同步档案块，等于它在骗下一个读者。

## 红线：远端配置不许自己挑时机

`type="RemoteProcess"` 的配置，一次 run = **同步 deployment（overwrite）+ 在远端启动进程**。误触发的代价是
线上被替换，所以：

- **AI 不得自行触发远程配置** —— 包括“顺手验证一下”“跑一次看看”。
- 唯一的例外：用户**在那次会话里明确说了**“这次可以自己跑”。
- 新建完要验证的话，先问用户；用户不在，就只做到 `inspect` 通过为止，把 `run` 留给他。

本地配置（shell / maven / gradle / …）没有这条限制，但**有副作用**的（发版、推迁移、动线上数据）同样要授权。

## 工具：只有读和跑，没有写

| 工具 | 用途 |
| --- | --- |
| `ide_get_run_configurations` | 列出 IDE 认到的配置（查重、看有哪些） |
| `ide_inspect_run_configuration` | 看一条配置的全貌：`typeKnown` / `canRun` / `warnings` / `options` / `configurationXml` / 历史实例 |
| `ide_rerun_run_configuration` | 跑（在跑就重启）。**长驻进程只走这条** |
| `ide_execute_run_configuration` | 跑完等退出。**只用于一次性任务**，常驻进程会一直挂着 |
| `ide_list_running_configurations` | 现在有哪些 Run 会话在跑 |

**没有 create / update / delete 工具** —— 改动就是改文件。工具不在时（`get_run_configurations` 都调不到），
说明项目还没接入 IDE，让用户执行 `/open-in-ide`；接入之前**不要手写文件假装做完**（没人帮你验证）。

## 同步文件不是 Remote Process 的用途

`RemoteProcess` 的 run = 同步 deployment + **启动进程**；同步只是启动的前置动作。

只想传文件 → `remote_upload` / `remote_download`，它们不起任何进程。

判据：**这条配置会启动一个进程吗？** 不会，它就不是 Remote Process。

## 流程

1. **读现状**
   - 项目根的 `.run/*.run.xml`（配置本体）
   - `.opencode/remote-shell/hosts.json`（远程配置的 `server` / `deployment` 只能从这里来）
   - `AGENTS.md` 里的 `<!-- idea-run-config-manager:begin -->` 块（有则改，没有就追加）
2. **查重**：`ide_get_run_configurations` 列一遍。**按 `(base, env)` 两个维度比** —— 同一个 base 在同一个 env
   上做同一件事才算重复。`aidata-api@mbp` 与 `aidata-api@handwrite` 是同一个 base 的两个环境，**不算重复**。
3. **写 / 改 / 删文件**
   - **新建**：照 [支持矩阵](#支持矩阵)里的模板写 `.run/<名字>.run.xml`
   - **修改**：直接改那个 XML 的对应 `<option>`
   - **改名**：改 XML 里的 `name` **并且**重命名文件（IDE 两处都读）
   - **删除**：删文件。**删完用 `ide_get_run_configurations` 确认** —— IDE 对新增 / 修改会热加载（1–2 秒），
     但对**删除**不一定：它可能还挂着内存副本，列表里仍有那条。这时让用户在 IDE 里删掉那一条配置
     （或重启 IDE），不要以为文件删了就完事。
   - 模板里没有的字段**不要写**：类型写错 = 整个文件被静默忽略，字段名写错 = 静默用默认值，都不报错
4. **静态检查**：`ide_inspect_run_configuration`
   - 报 unknown（并列出可用名字）→ 文件没被 IDE 加载：`type` 写错、文件名或目录不对（IDE 有 1–2 秒延迟，等等再查）
   - `typeKnown: false` → 类型 id 写错，IDE 不认这个类型
   - `canRun: false` → 看 `canRunBlockedReason`：server 不在 hosts.json / deployment 不存在 / command 为空
   - `warnings` 非空或 `options` 缺字段 → 字段名写错，被静默丢弃
5. **真跑**（远程先拿授权）：`ide_rerun_run_configuration`（长驻）或 `ide_execute_run_configuration`（一次性）。
   看结果和日志确认真的起来了。**远程跑完要么告诉用户“已在远端启动”，要么停掉，别留个进程没人知道。**
6. **同步档案**：按 [assets/AGENTS.template.md](assets/AGENTS.template.md) 逐段填，写在标记块内，
   **块外一字不动**（尤其不要碰 `idea-standalone` 的块）。
7. **核对**：块里每个名字项目里都还在，项目里每个配置块里都有。

## 命名文法：`base@env`

| 段 | 位置 | 取值 |
| --- | --- | --- |
| `base` | 必填 | 配置本体，**不含 `@`** |
| `env` | 最后一段，可选 | 跑在哪：一台服务器、一台本地电脑，都是一个 env |

`env` 的语义是宽的 —— **不同的 OS 就是不同的环境**：

- `console-web@ytmac` / `console-web@ytwin` —— 同一套应用在 Mac / Windows 上各一条
- `aidata-api@mbp` / `aidata-api@handwrite` —— 同一套应用在两台服务器上各一条
- `console-web` —— 不写 env = 所有环境通用

**旧的 `win@base` 写法已废弃**，统一写 `base@ytwin`（IDE 侧解析器仍兼容旧写法，但新配置不要再产生）。
档案里**只登记 base**，各 env 收在同一条条目里。

## 支持矩阵（一个类型一份模板）

| 类型 | `type` id | 模板 | 验证程度 |
| --- | --- | --- | --- |
| **Remote Process** | `RemoteProcess` | [remote-process](assets/types/remote-process.md) | ✅ 字段来自当前插件源码 |
| Shell Script | `ShConfigurationType` | [shell](assets/types/shell.md) | ✅ 实物（本机 6 例，含 Windows） |
| Maven | `MavenRunConfiguration` | [maven](assets/types/maven.md) | ✅ 实物 |
| Gradle | `GradleRunConfiguration` | [gradle](assets/types/gradle.md) | ✅ 实物 |
| npm / yarn / pnpm | `js.build_tools.npm` | [npm](assets/types/npm.md) | ✅ 实物 |
| Python | `PythonConfigurationType` | [python](assets/types/python.md) | ✅ 实物 |
| Go Build | `GoApplicationRunConfiguration` | [go-build](assets/types/go-build.md) | ✅ 实物 |
| Node.js | `NodeJSConfigurationType` | [node](assets/types/node.md) | ⚠️ `type` 与三个属性已验证，其余未验证 |
| Application / JAR | `Application` / `JarApplication` | — | ❌ 当时就没有实物，已移除 |

**矩阵之外一律没有模板**（JUnit / TestNG / Kotlin / Docker Compose / Spring Boot / Tomcat …）。
没有模板不等于建不了：用 `ide_inspect_run_configuration` 看一条**同类型的现成配置**的 `configurationXml`，
照它的字段抄。连一条现成的都没有，就**交给用户**在 IDE 里建，你只负责把档案补上。

## 硬性契约

1. **落盘位置固定**：`.run/<名字>.run.xml`，项目级共享配置，跟仓库走。
2. **`type` 与字段照模板抄** —— `type` 写错 IDE 会静默忽略整个文件，日志里也不报。
   存疑时用 `inspect` 的 `typeKnown` / `typeDisplayName` 确认这台 IDE 认不认。
3. **项目内的路径**用 `$PROJECT_DIR$`（= 项目根），不要写本机绝对路径。
   **唯一的例外是 Remote Process**：它的 `workingDirectory` / `logDir` / `command` 是**远端路径**，
   不要用任何 IDE 宏（见 [remote-process](assets/types/remote-process.md#路径不要用-ide-宏)）。
4. **XML 骨架不能少**：`<component name="ProjectRunConfigurationManager">`、`<configuration …>`、
   结尾的 `<method v="2" />`。
5. **不要手搓启动命令代替配置**，也不要写模板里没有的字段。

名字怎么读、档案条目怎么写 —— 见下文与 [assets/AGENTS.template.md](assets/AGENTS.template.md) 的生成提示。
两处都不在本文件重复。
