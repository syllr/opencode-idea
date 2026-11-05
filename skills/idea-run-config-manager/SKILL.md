---
name: idea-run-config-manager
description: "管理本项目的 run configuration：新建 / 修改 / 删除 / 改名都直接读写项目 `.run/<名字>.run.xml`；写完用 `ide_inspect_run_configuration` 做静态检查，需要时再真跑一次。覆盖本地类型（shell / maven / gradle / npm / python / go / node）与远端 `RemoteProcess`（server + deployment）。凡是涉及 run configuration、Run/Debug 配置、`.run/*.run.xml`、部署到服务器 / MBP / 远端、发布、docker compose、容器化、Before launch、构建产物、一键把应用发上去、或给某条配置改 server / deployment / workingDirectory 时，都先用它。并把配置档案同步进项目根 `AGENTS.md` 的 `idea-run-config-manager` 标记块 —— 本机配置和远端配置都登记在这唯一一块里。要建 / 改 / 删 run configuration、要判断一条固定流程该不该固化成配置、要部署到远端、要一份「这个项目有哪些配置、哪条能自己跑」的说明，或要定「本机跑哪几个应用」「启停走哪个工具」「哪些应用改了必须重启」这类项目级纪律时使用。"
---

# idea-run-config-manager — 读写 `.run/` + 维护配置档案

一条配置就是项目根 `.run/<名字>.run.xml` 里的一个文件：新增、修改、改名、删除都是直接改文件。

IDE 侧只有读和跑：`ide_get_run_configurations` 列出现有配置，`ide_inspect_run_configuration` 看一条的全貌，
`ide_rerun_run_configuration` 跑（job 等进程退出并回 `exitCode`；server 只等启动被**触发**就返回），
`ide_deploy_remote_process` 按发布语义跑一条远端配置（同步 + 启动 + 打开 Run 标签页；同样只等启动被触发），
`ide_list_running_configurations` 看在跑的会话。连 `ide_get_run_configurations` 都调不到，说明项目还没接入 IDE，
让用户执行 `/open-in-ide`；在那之前不要手写文件假装做完。

**选哪条工具由配置类型决定**：发布型的远端配置用 `ide_deploy_remote_process`（Stop 只关日志、不 kill 远端），
其余一律 `ide_rerun_run_configuration`（Stop 会 kill）。项目侧只需要记这一条，不需要临场判断。

本地配置和远端配置的区别只有一处：**远端多一步「同步 deployment」**，所以它的触发权限更严
（见 `AGENTS.md` 的档案章节）。下面两条是完整路径。

## 本地配置：从零到能跑

1. **摸清现状**。读 `.run/*.run.xml` 与 `AGENTS.md` 里的 `idea-run-config-manager` 标记块，再用
   `ide_get_run_configurations` 列一遍 —— 它会带出 IDE 自己存储里、翻文件看不到的配置。
   查重按 `(base, env)` 比：远端配置两段都要相同，本机配置只看 `base`，同一个 base 做同一件事才算重复。
2. **写文件**。照 [支持矩阵](#支持矩阵)里对应类型的模板写 `.run/<名字>.run.xml`；名字按下面的命名文法
   （本机配置不写 `@env`）。模板里没有的字段不要写：`type` 写错 IDE 会静默忽略整个文件，字段名写错会静默用默认值，都不报错。
3. **静态检查**。`ide_inspect_run_configuration`：报 unknown 是文件没被 IDE 加载（`type` / 文件名不对，
   IDE 有 1–2 秒延迟）；`typeKnown: false` 是类型 id 写错；`warnings` 非空或 `options` 缺字段是字段名写错。
4. **真跑**。统一用 `ide_rerun_run_configuration`：job 会等到进程退出并回 `exitCode`；server 只等到
   启动被**触发**（`triggered: true` + `started: null`），进程起没起要按工具描述里的退避节奏再查。
5. **同步档案**。按 [assets/AGENTS.template.md](assets/AGENTS.template.md) 写进标记块，块外一字不动。

## 远端配置（`RemoteProcess`）：从零到能跑

`type="RemoteProcess"` 的一次 run = **把 deployment 同步上去（overwrite）+ 在远端启动进程**，两步绑在一起。
所以它只负责「启动远端的东西」；只想传文件、不起进程，用 `remote_upload` / `remote_download`。

1. **确认 server 与 deployment**。`server` 必须是 IDE SSH 配置里的名字，且出现在
   `.opencode/remote-shell/hosts.json`；`deployment` 是该 server 下 `deployments[].name` 的名字。
   缺任何一项，`canRun` 就是 false。
2. **产物型应用先建构建配置**。`{应用}-build@{env}`，类型 `NodeJSConfigurationType`，跑仓库里的 node 脚本，
   把产物铺到**该 deployment 的 `localPath`** —— 那才是同步的源目录。脚本要写成**与操作系统无关的一份代码**：
   不判断 `process.platform`、不为某个 OS 写分支，用 Node 标准 API 实现复制 / 删除 / 建目录；参数只走 argv
   （不同环境的输出目录写在 `application-parameters` 里）；env 与它所服务的 `{应用}@{env}` 相同。
   细节见 [node](assets/types/node.md#构建脚本before-launch-用)。
3. **再建部署配置**。`{应用}@{env}`，字段见 [remote-process](assets/types/remote-process.md)，
   并在它的 `<method v="2">` 里用 `RunConfigurationTask` 把上一步挂成 Before launch（写法见同一份文档的
   [Before launch](assets/types/remote-process.md#before-launch构建--铺产物) 一节）。
   构建顺序由 Before launch 保证，**不要**把构建塞进远端 `command`，也不要指望使用者先手工跑一遍。
4. **静态检查**。`ide_inspect_run_configuration`：`beforeRunTasks` 里有没有那条构建、`canRun` 是否为 true。
   同一次返回里，`beforeRunTasks[].recentRuns[].logFile` 就是那条构建**最近几次**的日志（构建是独立
   Run 会话，日志不在父配置的 `history[]` 里）；`exitCode` 直接告诉你上次构建成没成。
5. **真跑**。远端配置一次 run 就替换线上，**必须用户当场授权**（规则写在 `AGENTS.md` 的档案章节）；
   没授权就停在 inspect 通过。跑起来之后告诉用户“已在远端启动”，或者停掉，别留个进程没人知道。
6. **同步档案**。同上，构建配置与部署配置各登记一条。

## build 还是 server：`IDEA_MCP_ENHANCE_SERVER_RUN_CONFIG`

`ide_rerun_run_configuration` 对两种配置的行为不同：

| 配置 | 行为 | 怎么标 |
| --- | --- | --- |
| **build**（构建脚本、测试、迁移：跑完就退；工具返回的 `runKind` 是 `job`） | 等到进程退出，返回 `exitCode` 与完整输出 | **缺省就是 build / job**，不用标 |
| **server**（dev server、长驻进程：永不退出） | 只等启动被**触发**就返回（`triggered: true` + `started: null`），进程起没起自己退避查 | 在配置的 `<envs>` 里加 `IDEA_MCP_ENHANCE_SERVER_RUN_CONFIG=true` |

```xml
<envs>
  <env name="IDEA_MCP_ENHANCE_SERVER_RUN_CONFIG" value="true" />
</envs>
```

- 变量名只标注**例外的那一类**（server）：不写就是 job，和缺省语义同向，读的时候不用取反。
- `false` / `0` / `no` / `off` 会被当成 job —— 标记可以留着，临时想按 job 跑时不用删配置。
- 为什么写在 `<envs>` 里：它是配置类型**自己序列化**的字段，IDE 改配置、点 OK 都不会丢。
  自定义 `<option>` 不行 —— 平台每次保存都从空元素重拼，未知标签会**静默消失**。
- 代价：这个变量会真的注入进程环境；好处是它在 IDE 的 Environment variables 字段里**可见可编辑**。
- `RemoteProcess` 类型不用标：它恒为 server（Run 会话跟随远端日志，等退出就是等死）。
- 判错的代价不对称：job 误判成 server 只是少等一次；server 误判成 job 会白等满 300 秒才返回。

## 命名文法：`base@env`

| 段 | 位置 | 取值 |
| --- | --- | --- |
| `base` | 必填 | 配置本体，**不含 `@`**。默认就是**应用名**（`console-web`、`aidata`）；只有同一个应用需要多条配置时才加用途（见下） |
| `env` | 最后一段，**只有远端配置才写** | 部署到哪台服务器：`hosts.json` 里的 server 名 |

`env` 只表示**远端目标机器**：

- `aidata@mbp` / `aidata@handwrite` —— 同一套应用部署到两台服务器，各一条
- `console-web` —— **本机配置不写 env**，不管当前是 Mac 还是 Windows

**用途后缀只给「同一应用的额外配置」用**，最常见的就只有一条：挂进 Before launch 的构建配置必须叫
`{应用}-build@{env}`，否则和部署那条分不清。部署配置本身就用应用名，不必造 `-deploy`。

**本机配置不需要 `@env`**：脚本本身要求跨 OS 行为一致（见 [node](assets/types/node.md#构建脚本before-launch-用)），
同一份配置在哪台电脑上都能跑，加个后缀只会让同一个 base 分裂成好几条。

**旧的 `win@base` 写法已废弃**（IDE 侧解析器仍兼容，但新配置不要再产生）。

`@env` 也管整条部署链：Before launch 里挂的构建配置要带 `@env`，而且 build / deploy / 迁移脚本用**同一个 env**。
档案里只登记 `base`，各 env 收在同一条条目里。

## 支持矩阵（一个类型一份模板）

| 类型 | `type` id | 模板 |
| --- | --- | --- |
| **Remote Process** | `RemoteProcess` | [remote-process](assets/types/remote-process.md) |
| Shell Script | `ShConfigurationType` | [shell](assets/types/shell.md) |
| Maven | `MavenRunConfiguration` | [maven](assets/types/maven.md) |
| Gradle | `GradleRunConfiguration` | [gradle](assets/types/gradle.md) |
| npm / yarn / pnpm | `js.build_tools.npm` | [npm](assets/types/npm.md) |
| Python | `PythonConfigurationType` | [python](assets/types/python.md) |
| Go Build | `GoApplicationRunConfiguration` | [go-build](assets/types/go-build.md) |
| Node.js | `NodeJSConfigurationType` | [node](assets/types/node.md) |

**矩阵之外没有模板**（JUnit / TestNG / Kotlin / Docker Compose / Spring Boot / Tomcat …）。
不等于建不了：用 `ide_inspect_run_configuration` 看一条**同类型的现成配置**的 `configurationXml`，照它的字段抄；
连一条现成的都没有，就交给用户在 IDE 里建，你只负责把档案补上。

## 档案：`AGENTS.md` 里唯一的一块

产物是项目根 `AGENTS.md` 中 `<!-- idea-run-config-manager:begin -->` 与 `:end -->` 之间的一段，骨架见
[assets/AGENTS.template.md](assets/AGENTS.template.md)。**本机配置和远端配置都登记在这同一块里**，分「应用配置」与
「非应用配置」两类，不再有第二块、也不按性质拆到别处。

- **新增**：文件里还没有标记块 → 在 `AGENTS.md` **末尾追加**，既有内容原样保留；文件不存在则创建。
- **更新**：只替换 `begin` 与 `end` 之间的内容，**块外一字不动** —— 尤其不要碰其它 skill 的标记块（例如
  `project-scaffold`）。
- 改文件用原生 `edit` 替换那一段，**不要整文件重写**。
- 写完复读核对：块内逐段与模板一致，块外与改动前逐字一致，报告产物清单。

**归组**（细节在模板的生成提示里）：

- **应用配置**：按应用分章节、应用下按环境分小节（配置名的 `@env` 段）；本机配置写「默认」。
- **非应用配置**：构建、迁移、测试、一次性任务，平铺，不塞进任何应用。
- 配置名必须是 `ide_get_run_configurations` 里真实存在的那个。

**缺配置**：列表里没有某个应用 → **先问用户要不要建**（建配置是项目资产：把「名字、干什么、为什么值得留」摊开给
用户看，同意才建），建完重新查一次再登记。不要手搓启动命令，也不要自己编一条。

**临时配置不登记**：验证某条命令时临时建的、跑完就删的不进档案。

## 路径：本地 vs 服务端

两条规则，一句话：

- **本地路径**：配置里指向项目文件的，一律写 `$PROJECT_DIR$`（或它的子目录）。每个开发者机器上项目位置不同，
  写死绝对路径别人 clone 下来就是错的。
- **服务端路径**：远端只有一份，写绝对路径。IDE 宏在远端不会被展开 —— 写 `$USER_HOME$` 等于写了一个
  名字就叫 `$USER_HOME$` 的目录。

哪些字段属于哪边：

| 位置 | 属于 | 写法 |
| --- | --- | --- |
| shell 的 `SCRIPT_PATH` / `SCRIPT_WORKING_DIRECTORY` | 本地 | `$PROJECT_DIR$/…` |
| npm 的 `package-json`、node 的 `path-to-js-file` / `working-dir` | 本地 | `$PROJECT_DIR$/…` |
| maven `workingDirPath`、gradle `externalProjectPath`、python `SCRIPT_NAME` / `WORKING_DIRECTORY`、go `filePath` / `working_directory` | 本地 | `$PROJECT_DIR$/…` |
| Remote Process 的 `workingDirectory` / `logDir` / `command` | 服务端 | 绝对路径 |
| `hosts.json` 的 `deployments[].localPath` | 本地 | **相对项目根**（IDE 部署的规则，不写绝对路径） |
| `hosts.json` 的 `deployments[].deployPath` | 服务端 | 绝对路径 |

## 硬性契约

1. **落盘位置固定**：`.run/<名字>.run.xml`，项目级共享配置，跟仓库走。
2. **XML 骨架不能少**：`<component name="ProjectRunConfigurationManager">`、`<configuration …>` 和结尾的
   `<method v="2" />`（挂 Before launch 时换成带 `RunConfigurationTask` 的 `<method v="2">…</method>`）。
3. **改名要改两处**：XML 里的 `name` 和文件名。**删除要确认**：IDE 对删除不一定热更新，列表里可能还挂着，
   这时让用户在 IDE 里删掉那一条（或重启 IDE）。
