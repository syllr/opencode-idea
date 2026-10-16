{{#if first}}
# IDE MCP:只有非 IDE 不可的能力才走 IDE

本会话接入了 {{projectCount}} 个 JetBrains 项目。每个项目**由各自配置的 IDE 打开**,工具前缀也各不相同
(root 固定是 `ide`,子项目是它自己的目录名)。

## 目录 → 工具前缀(先看这张表)

{{routeTable}}

**规则:操作哪个目录下的文件/代码,就用哪个前缀的工具。** 不要拿一个项目的工具去操作另一个项目 ——
IDE 是按项目解析的,跨项目调用要么直接报错,要么被解析到另一个项目上、作用在错误的代码上。

按需读文件:要了解某个子项目自己的约定,读它的 `<子项目目录>/AGENTS.md`(它不会自动进入本会话的上下文,
本会话是 root 打开的那一个)。

## 总则(所有项目通用)

- 原生工具(当前工具列表里直接列出的那些)**直接调用**;不需要、也不应该用 Code Mode 的 `search` 去找。
- `<前缀>_*` 形式的工具就是原生工具:直接调用(参数按各工具 schema 传),不要包进 `execute`;它们不在 Code Mode 的工具目录里,`search` 搜不到。
- **只有 IDE 才有的能力才用它们**:符号级检索、项目模型、检查与构建、重构与格式化、run configuration。
- **读写与搜索用原生工具**(`read` / `write` / `edit` / `grep` / `glob`):不要为读一个文件、写一个文件、搜一段文本去绕 IDE 工具。
- 工具列表里看不到某个前缀,就是那个项目没接上:提示用户执行 `/open-in-idea`,不要重试,也不要去别处找。

## 命令执行(所有项目通用)

- 需要项目环境的命令(依赖 IDE 里配好的 JDK / Node / Python 版本等):用该项目前缀的 run configuration 工具,不要用原生 `shell`。
- run configuration 是**重资产**:一个项目通常只建几个(固定要跑的构建 / 装依赖 / dev server 之类),**不是随手一条命令就建一个**。
- 要新建:先确认它**反复要用、且属于项目固定流程**;确认后**先告诉用户要建什么、为什么,取得同意再动手**,别自己决定。
- **配置一律不由你写**:不要手写 `.run/*.run.xml`,也不要手搓启动命令。
- 不需要项目环境的命令:用原生 `shell`。
{{/if}}

## 项目 `{{projectLabel}}`{{rootTag}} — {{ideLabel}} 打开 — 工具前缀 `{{toolPrefix}}_`

项目路径: `{{projectPath}}`。本节所有工具**只作用于这个项目**。

### 符号(只有 IDE 的语义索引能给)

- `{{toolPrefix}}_search_symbol`:按名字找符号的声明位置;要看签名 / 文档接着用 `{{toolPrefix}}_get_symbol_info`。
- `{{toolPrefix}}_get_symbol_info`:一个符号的签名 / 文档 / 声明位置,`filePath` + `line` + `column`。
- `{{toolPrefix}}_analyze_calls`:调用关系,`symbolFqn` 传符号名,`analysisKind` 取 `INCOMING_CALLS` / `OUTGOING_CALLS`;`depth` 控层数,`childOffset` 翻页。

### 项目与编辑器

- `{{toolPrefix}}_list_directory_tree`:项目视角的目录树(尊重内容根与排除项),`maxDepth` 控深度。
- `{{toolPrefix}}_get_project_modules`:项目模块及类型。
- `{{toolPrefix}}_get_project_dependencies`:项目直接声明的依赖。
- `{{toolPrefix}}_get_all_open_file_paths`:用户在 IDE 里打开了哪些文件(含当前激活的那个)。
- `{{toolPrefix}}_open_file_in_editor`:把文件在 IDE 里打开并激活,给用户看。

### 重构与格式化

- `{{toolPrefix}}_rename_refactoring`:按符号改名,项目内的引用一并更新。
- `{{toolPrefix}}_reformat_file`:按 IDE 的代码风格重排。

### 校验

- `{{toolPrefix}}_lint_files`:批量检查,`files` 传数组;只列有问题的文件。
- `{{toolPrefix}}_get_file_problems`:单文件检查,`filePath`;结果在 `errors`。
- `{{toolPrefix}}_build_project`:构建校验,`filesToRebuild` 可只构建指定文件;有问题返回在 `problems`,没返回即没问题。

### 包内文件

- `{{toolPrefix}}_read_file`:**只在要读包内文件时用它**(`<jar>!/<entry>` 形式的依赖 jar 内文件、`jrt://` 形式的 JDK 镜像),那是原生 `read` 做不到的;普通文件一律用 `read`。

### 运行配置

- `{{toolPrefix}}_get_run_configurations`:项目里有哪些运行配置;传 `filePath` 可列该文件的运行入口,不要翻 `.run/` 目录(存在 `.idea/` 里的那些看不到)。
- `{{toolPrefix}}_execute_run_configuration`:跑已有配置;Shell Script 要 `EXECUTE_IN_TERMINAL: false`;覆盖参数(`programArguments` / `workingDirectory` / `envs`)需配置支持 `supportsDynamicLaunchOverrides`。
{{#if canCreateRunConfiguration}}
- `{{toolPrefix}}_create_shell_run_configuration`(`configurationName` + `scriptPath` / `scriptText` / `cloneFrom` 三选一):新建项目级 Shell 配置(写 `.run/<name>.run.xml`);**重操作** —— 只给固定要跑、反复要用的流程建,**且建之前必须先取得用户同意**;只支持 Shell 类型。**其他类型请用户在 IDE 里建。**
{{else}}
- 缺配置就请用户在 IDE 里建。
{{/if}}
{{#if canListRunningConfigurations}}
- `{{toolPrefix}}_list_running_configurations`:当前真正在跑的配置(几个实例 / 各自 pid / 退出码);停 / 重启前后都先用它看状态。
{{/if}}
{{#if canStopRunConfiguration}}
- `{{toolPrefix}}_stop_run_configuration`(`configurationName`):停掉该配置的全部实例并等它们退出;没在跑也返回成功。
{{/if}}
{{#if canRerunRunConfiguration}}
- `{{toolPrefix}}_rerun_run_configuration`(`configurationName`):改完代码重启无热重载的进程;在跑就重启、没在跑就启动,读 `started` 判断新进程是否真的起来了。不要用 `pkill` / `kill` / `shell` 代替。
{{/if}}
