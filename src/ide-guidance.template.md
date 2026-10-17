# IDE MCP:只有非 IDE 不可的能力才走 IDE

本会话接入了 {{projectCount}} 个 JetBrains 项目。**每个功能在所有项目下都各有一份工具**,命令名就是
`<项目前缀>_<工具名>`;下面每条功能后面直接列出它在各项目里的命令名。

## 本会话接入的项目与各自的 MCP 工具

{{routeTable}}

**子项目就是根目录下的目录**,只是被另一个 IDE 单独打开、配了另一套工具。所以这里说的"根项目",指的是
**根目录中扣掉这些子项目之后的部分** —— 操作某个子项目里的文件,就用那个子项目的命令,不要因为它"在根目录下"
就用根项目的工具。

**规则:操作哪个目录下的文件/代码,就用那个目录对应的命令。** IDE 是按项目解析的 —— 跨项目调用要么直接报错,
要么被解析到另一个项目上、作用在错误的代码上。

按需读文件:要了解某个子项目自己的约定,读它的 `<子项目目录>/AGENTS.md`(它不会自动进入本会话的上下文,
本会话是 root 打开的那一个)。

## 总则(所有项目通用)

- 原生工具(当前工具列表里直接列出的那些)**直接调用**;不需要、也不应该用 Code Mode 的 `search` 去找。
- 下面这些 IDE 工具也是原生工具:直接调用(参数按各工具 schema 传),不要包进 `execute`;它们不在 Code Mode 的工具目录里,`search` 搜不到。
- **只有 IDE 才有的能力才用它们**:符号级检索、项目模型、检查与构建、重构与格式化、run configuration。
- **读写与搜索用原生工具**(`read` / `write` / `edit` / `grep` / `glob`):不要为读一个文件、写一个文件、搜一段文本去绕 IDE 工具。
- **唯一例外**:压缩包内的条目(路径带 `.jar!/`,原生 `read` 打不开)—— 见下面「读压缩包内的东西」。
- 某条功能下面没有你正要操作的那个项目的命令,就是那个项目没接上:提示用户执行 `/open-in-ide`,不要重试,也不要去别处找。

## 工具(每条第一行是各项目的命令,接着是它的用法)

### 符号(只有 IDE 的语义索引能给)

- {{cmd_search_symbol}}
  **按名字找符号的声明位置**(`q` 传查询文本,**固定带上 `include_external: true`**):本插件最不可替代的能力 —— 它搜的是**符号**(类 / 接口 / 方法 / 函数 / 字段 / 类型 / 常量这类**有名字的定义**)的**声明位置**,不是"哪段文本提到过它"(那是 `grep` 的事);带上 `include_external` 才会连**依赖库和标准库**一起搜,于是你能直接定位第三方库里的实现 —— 这是原生 `grep` / `glob` 够不着的地方(IDE 自己的 `search_text` / `search_file` 也只搜项目内)。
  - **典型用法 ①:代码里引用了某个库的 API(最常见)** —— 读代码时看到 `from fastapi import FastAPI`、`import org.apache.poi...FormulaParser`、`gorm.DeletedAt`、`from 'vue'` 这类引用时,**包名就在代码里**,直接**用「包名+符号名」当 `q` 搜**,一次定位到它的实现:
    - **Java**:全限定名 —— `com.nimbusds.jose.util.Base64`(实测 1 条命中 `~/.m2/.../poi-5.3.0-sources.jar!/...`)
    - **Go**:包名.符号 —— `gorm.DeletedAt`(实测 2 条,全在 `go/pkg/mod/gorm.io/gorm@...`)
    - **Python**:模块路径给得越全越准 —— `torch.nn.modules.module.Module`(目标全在最前);`torch.nn.Module` 也能把目标排进前 2
    - **Node/TS**:用 **import 的那层包名**(不是子模块路径)—— `vue.Teleport` 有效,`@vue/runtime-core.TeleportProps` 搜不到
  - **典型用法 ②:调研一个库有哪些 API** —— 包名从依赖清单里拿(pom.xml / package.json / go.mod / requirements.txt),**直接拿包名当 `q` 搜**,结果基本就落在这个库里,再读入口:
    - **Python**:`fastapi` → `fastapi/applications.py`、`fastapi/__init__.py`(**入口就是导出清单**:直接看到 `FastAPI`、`HTTPException` 这些公开名字)
    - **Java**:`poi` → `~/.m2/.../poi-5.3.0-sources.jar!/org/apache/poi/...`;读该库的入口类
    - **Go**:`gorm` → `go/pkg/mod/gorm.io/gorm@v1.31.0/...`
    - **Node/TS 例外**:包名当 `q` 搜不到(实测 `element-plus` → 0 条)。要用**代码里 import 的符号名**;包名是简单标识符时可以「包名.符号」(`vue.Teleport` 有效),但**带 `-` 或 `@scope/` 的这么拼是 0 条**(`element-plus.ElMessage`、`@vue/runtime-core.TeleportProps` 都搜不到)。而裸符号名会跨多个子项目(`ElMessage` 命中 user / admin / vcop 三处),这时用 `paths` 圈到那个 `node_modules` —— `paths: ['frontend/user/**']` 就收敛到一处。
  - **它只覆盖「项目已经引入」的依赖**:搜不到某个库,基本就是这个库还没进依赖 —— 别反复试:要么先把它加进依赖(pom / requirements / package.json),要么改用 web 搜索 / GitHub 看它的源码。
  - **同名符号往往有多处定义**(标准库一份、几个依赖各一份,还有测试和示例),所以**按代码上下文选**:看调用处 import 的是哪个包、传参是什么类型、返回路径属于哪个库 —— 别把第一行当答案。
  - **它返回的路径,原样交给同一个项目的 `<P>_read_file` 就是源码**:两者同属一个项目、相对路径的基准一致,所以不用拼绝对路径、不用管是什么语言 —— 压缩包里的条目它也照样读(`.class` 还会反编译)。
    例:`<P>_search_symbol({ q: "UvicornWorker", include_external: true })` 给出 `../../../Library/.../uvicorn/workers.py` → `<P>_read_file({ file_path: "那个字符串" })`。
  - **依赖索引是按项目的**:任何依赖都用**它所在项目**的那个 MCP 工具去搜 —— 根项目的依赖用根项目的命令,子项目的依赖用子项目的命令。拿一个项目的工具去搜另一个项目的依赖,只会在那个项目自己的文件里找,**拿不到库**。
  - **别把这条路径交给原生 `read`**:原生 read 的基准是本会话的工作目录(根项目),拿子项目的相对路径去读会落到错误的位置。
- {{cmd_get_symbol_info}}
  **一个符号的签名 / 文档 / 声明位置**:`filePath` + `line` + `column`。
- {{cmd_analyze_calls}}
  **调用关系**:`symbolFqn` 传符号名,`analysisKind` 取 `INCOMING_CALLS` / `OUTGOING_CALLS`;`depth` 控层数,`childOffset` 翻页。

### 项目与编辑器

- {{cmd_list_directory_tree}}
  **项目视角的目录树**(尊重内容根与排除项):`maxDepth` 控深度。
- {{cmd_get_project_modules}}
  **项目模块及类型**。
- {{cmd_get_project_dependencies}}
  **项目直接声明的依赖**。
- {{cmd_get_all_open_file_paths}}
  **用户在 IDE 里打开了哪些文件**(含当前激活的那个)。
- {{cmd_open_file_in_editor}}
  **把文件在 IDE 里打开并激活**,给用户看。

### 重构与格式化

- {{cmd_rename_refactoring}}
  **按符号改名**,项目内的引用一并更新。
- {{cmd_reformat_file}}
  **按 IDE 的代码风格重排**。

### 校验

- {{cmd_lint_files}}
  **批量检查**:`files` 传数组;只列有问题的文件。
- {{cmd_get_file_problems}}
  **单文件检查**:`filePath`;结果在 `errors`。
- {{cmd_build_project}}
  **构建校验**:`filesToRebuild` 可只构建指定文件;有问题返回在 `problems`,没返回即没问题。

### 读压缩包内的东西

- {{cmd_read_file}}
  **压缩包内的条目**(路径形如 `libs/foo.jar!/com/x/Bar.class` 或 `jar://` URL)只有它能读 —— 原生 `read` 打不开压缩包,而它还能把 `.class` **反编译成源码**;「符号」那条搜出来的路径也用它(原样传即可)。

### 运行配置

- {{cmd_get_run_configurations}}
  **项目里有哪些运行配置**:传 `filePath` 可列该文件的运行入口。**不要翻 `.run/` 目录** —— 存在 `.idea/` 里的那些看不到。
- {{cmd_execute_run_configuration}}
  **跑已有配置**:Shell Script 要 `EXECUTE_IN_TERMINAL: false`;覆盖参数(`programArguments` / `workingDirectory` / `envs`)需配置支持 `supportsDynamicLaunchOverrides`。
{{#if canCreateRunConfiguration}}
- {{cmd_create_shell_run_configuration}}
  **新建项目级 Shell 配置**(`configurationName` + `scriptPath` / `scriptText` / `cloneFrom` 三选一;写 `.run/<name>.run.xml`):只支持 Shell 类型,**其他类型请用户在 IDE 里建**。它是**项目资产**,不是"跑命令"的手段 —— 只是要跑一条命令就用原生 `shell`。判据只有一条:**这件事以后会不会以同样的形态再发生?**
  - **会 → 该建,而且你要主动提**。典型信号:用户让你做的是**重复性动作**,还会对别的环境 / 别的分支 / 下一次改表再做一遍 —— 例如改完表结构要**同步某个环境的 DDL**、跑数据库迁移或回滚、生成代码、打包、起 dev server、往某个环境部署、按固定步骤清洗数据。这时**别默默每次手搓命令**(下次还得从头猜一遍),也**别自己动手建**:**先问用户**"这个流程以后要反复跑,要不要固化成一个 Shell run configuration?",并把方案摊开:配置名、实际执行的命令(`scriptText`,或它指向的 `scriptPath`)、工作目录、为什么值得留。**同意才建**;用户说这次先这样,就照办,别再追着问。
  - **不会 → 用原生 `shell` 直接跑,别建**。这就是两者的分界线:原生 `shell` 是**就地执行、用完不留痕**(命令只存在于会话里);`create_shell_run_configuration` 是**把命令落盘成 `.run/<name>.run.xml`、往后反复用**(它产出的是项目文件,IDE 的 Run 窗口里也会多一项)。所以一次性的、探索性的、调试性的、参数每次都不一样的操作(查条数据、看个日志、试一条命令、临时换个路径跑一下)一律走 `shell` 跑完算 —— 这类东西建配置只是给项目留垃圾。确需项目环境的解释器时,在 `shell` 命令里显式指定、或在已有配置上单次覆盖参数,也别为这一次性的事新建配置。
  - **建之前先查,防泛滥**:先 `get_run_configurations` 看有没有已在做同一件事的配置 —— 有就**复用**(必要时让用户改它),别新建一个几乎一样的;同一件事**不要按参数 / 按文件 / 按环境拆成一堆配置**,变化的入参用 `programArguments` / `envs` 单次覆盖。一个项目通常就那么**几个**(构建、装依赖、起服务、迁移这类固定流程);配置数量明显长起来就是滥用信号 —— 动手前先问自己:这是项目固定流程,还是我只是想省一条 shell 命令?
{{/if}}
{{#if canListRunningConfigurations}}
- {{cmd_list_running_configurations}}
  **当前真正在跑的配置**(几个实例 / 各自 pid / 退出码):停 / 重启前后都先用它看状态。
{{/if}}
{{#if canStopRunConfiguration}}
- {{cmd_stop_run_configuration}}
  **停掉该配置的全部实例并等它们退出**:没在跑也返回成功。
{{/if}}
{{#if canRerunRunConfiguration}}
- {{cmd_rerun_run_configuration}}
  **改完代码重启无热重载的进程**:在跑就重启、没在跑就启动;读 `started` 判断新进程是否真的起来了。不要用 `pkill` / `kill` / `shell` 代替。
{{/if}}

## 命令执行(所有项目通用)

- 需要项目环境的命令(依赖 IDE 里配好的 JDK / Node / Python 版本等):用该项目前缀的 run configuration 工具,不要用原生 `shell`。
- **配置一律不由你写**:不要手写 `.run/*.run.xml`,也不要手搓启动命令。
{{#if canCreateRunConfiguration}}
- 要固化的固定流程(判据见上:会不会以同样形态重复发生):Shell 类型用上面那个「新建项目级 Shell 配置」建,其他类型讲清楚后请用户在 IDEA 里建。
{{else}}
- 要固化的固定流程:把配置名、实际执行的命令、工作目录、为什么值得留讲清楚,**请用户在 IDEA 里建** —— 当前没有能建它的工具,不要手写文件凑。
{{/if}}
- 不需要项目环境的命令:用原生 `shell`。
