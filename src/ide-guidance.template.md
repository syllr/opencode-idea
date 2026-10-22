# IDE MCP:OpenCode 自带工具的补充

## 工具使用铁律（先读）

1. **读、搜、列、改都用 OpenCode 自带工具**：读文件用 `read`（读片段传 `offset` / `limit`），搜内容用 `grep`，
   列文件用 `glob`，改文件用 `edit` / `write`。
2. **IDE 工具补自带工具做不到的**：符号与定义用 `<前缀>_search_symbol` + `<前缀>_read_file`；改名用
   `<前缀>_rename_refactoring`；单文件检查用 `<前缀>_lint_files` / `<前缀>_get_file_problems`；跨模块构建用
   `<前缀>_build_project`。
3. **`shell` 用于必须起进程的命令**：`pnpm` / `git` / `docker` / `curl` / `psql`、迁移与生成。
4. **校验节奏**：改动过程中对改动的文件用 `lint_files` / `get_file_problems`；全仓 `pnpm typecheck` 在收尾跑一次。
5. **批量修改**：逐文件用 `edit`，或一次用 `<前缀>_apply_patch`。

本会话接入了 {{projectCount}} 个 JetBrains 项目。**每个功能在所有项目下都各有一份工具**,命令名是
`<项目前缀>_<工具名>`;下文写 `<前缀>` 就是指这一截。

## 本会话接入的项目与各自的 MCP 工具

{{routeTable}}

**子项目就是根目录下的目录**,只是被另一个 IDE 单独打开、配了另一套工具。所以这里说的"根项目",指的是
**根目录中扣掉这些子项目之后的部分**。

**规则:操作哪个目录下的文件/代码,就用那个目录对应的命令。** IDE 按项目解析 —— 用错前缀时,调用要么报错,
要么作用在另一个项目的代码上。

按需读文件:要了解某个子项目自己的约定,读它的 `<子项目目录>/AGENTS.md`(它不会自动进入本会话的上下文,
本会话是 root 打开的那一个)。

## 路由:先看路径在不在项目里

**IDE 工具只在项目内使用。** 请求的路径落在**某个已打开项目**的目录树内,IDE 才会去解析它;
项目外的路径(`/tmp`、别的仓库、用户主目录)不在 IDE 的解析范围内。

- **项目内** —— **OpenCode 自带的工具为主**,它们更快。**它们做不了、或者做得很差的,才用 IDE 工具**:
  符号检索、依赖实现、重构、格式化、校验、运行配置、跨文件补丁。
  **两边都不顺手时,你自己判断用 `shell` 里的命令** —— 那是第三选择,不是第一选择。
- **项目外** —— 用 OpenCode 自带的工具;IDE 工具只对项目内路径生效。

## 总则 (所有项目通用)

- **OpenCode 自带的工具直接调用** —— 工具列表里直接列出的那些(`read` / `grep` / `glob` / `edit` / `write` / `shell`),
  参数按各自 schema 传。它们就在当前工具表里,直接调用即可。
- **读文件用 `read` 工具** —— 要读某一段就传 `offset`(从第几行起)+ `limit`(读几行),输出自带行号。
- **搜文本用 `grep` 工具** —— 它按 `.gitignore` 排除,`node_modules` / `dist` 不进结果,范围用 `path` 收窄。
  要看命中行前后的大段上下文:先用它拿到**行号**,再用 `read` + `offset` / `limit` 读那一段。
- **工具输出不够用时,按这个顺序调整**:① 调参数重试 → ② 缩小路径范围重试 → ③ 换工具。
  换用 `shell` 的判断依据是"这个工具确实没有这个能力"。
  典型:`<前缀>_list_directory_tree` 的输出到 `maxDepth` 边界就停 —— 调大 `maxDepth` 再试一次。
- **改文件**:改一个符号用 `<前缀>_rename_refactoring`;改一段文字用 `edit` / `write` 工具;
  同一段文字铺到多个文件用 `<前缀>_apply_patch`;跑命令用 `shell` 工具。
  改代码始终落在具体的那几行上,其余内容保持原样。
- **改完代码自己先查一遍**:`lint_files` / `build_project`,怎么挑见「校验」。
- **文档类文件 (Markdown / 文档) 改完之后,用 `<前缀>_reformat_file` 过一遍** —— 表格对齐、换行宽度、缩进交给 IDE
  统一。它从磁盘重读,外部写完直接格式化是安全的。
- 某条功能下面没有你正要操作的那个项目的命令,说明那个项目没接上:提示用户执行 `/open-in-ide`。

## 命令执行 (所有项目通用)

- **跑命令用 `shell` 工具**;要项目环境的(IDE 里配好的 JDK / Node / Python 等)先看有没有现成的 run configuration ——
  有就跑它 (常驻用 `rerun`,跑完即退用 `execute`);没有、又只是一次性的,用 `shell` 工具并显式指定解释器。
  一次性的命令留在 `shell` 里,配置留给会反复用到的流程。
- **建 / 改 / 删运行配置,走 `idea-run-config-manager` skill**(服务化应用的配置归 `idea-standalone`):
  它落手用的就是「运行配置」里的那组工具 —— 配置文件由工具写入和删除。
{{#if canCreateRunConfiguration}}
{{else}}
  本会话没有新建工具,"建"这一步它只能讲清配置名、实际执行的命令、工作目录、为什么值得留, **请用户在 IDE 里创建**
{{/if}}

## 工具 (每条第一行是各项目的命令,接着是它的用法)

### 符号 (只有 IDE 的语义索引能给)

**要读任何类 / 方法 / 字段的源码,就两步**:`<前缀>_search_symbol`(`q` 传名字, **带 `include_external: true`**)找到位置 →
`<前缀>_read_file` 原样读它给的路径。 **依赖库 / 三方包 / 平台 jar 里的实现**正是它最该用的场合 —— IDE 索引里那份就是项目
编译时真正用的依赖,读出来还是反编译源码。

- {{cmd_search_symbol}} **`q` 传查询文本,固定带上 `include_external: true`。** **本插件最不可替代的能力**在于它搜的是**符号**
  (类 / 接口 / 方法 / 函数 / 字段 / 类型 / 常量这类 **有名字的定义**)的**声明位置**,不是"哪段文本提到过它"(那是
  `grep` 工具的事);带上 `include_external` 才会连依赖库和标准库一起搜 —— 这是 `grep` / `glob` 工具够不着的地方。
    - **查某个库的 API**:代码里 import 的包名就是线索,直接「包名 + 符号名」当 `q` —— Java 用全限定名
      (`com.nimbusds.jose.util.Base64`)、Go 用 `pkg.Symbol`(`gorm.DeletedAt`)、Python 给全模块路径
      (`torch.nn.Module`)、Node/TS 用 import 的那层包名(`vue.Teleport`)。**调研一个库有哪些 API**:拿包名当 `q`
      (`fastapi` → 入口文件就是导出清单),再读它的入口。
    - **Node/TS 例外**:带 `-` 或 `@scope/` 的包名这么拼是 0 条(`element-plus`);改用 import 的符号名,并用 `paths` 圈到
      那个 `node_modules`(`paths: ['frontend/user/**']` 就收敛到一处)。
    - **搜不到 = 依赖没进来**:先把它加进依赖,或改用 web 搜索 / GitHub 看源码。
    - **同名符号往往有多处定义**(标准库 / 依赖 / 测试各一份):按调用处的 import 与参数类型来选。
    - **它返回的路径原样交给同一个项目的 `<前缀>_read_file`** —— 那个路径的基准是**它所在的项目**,不是会话工作目录;
      交回 `read` 工具时,子项目的相对路径会落到另一个位置。
    - **依赖索引是按项目的**:用 **它所在项目** 前缀的工具搜,拿别的项目的工具搜不到库。
- {{cmd_get_symbol_info}} **一个符号的签名 / 文档 / 声明位置**:`filePath` + `line` + `column`。
- {{cmd_analyze_calls}} **调用关系**:`symbolFqn` 传符号名,`analysisKind` 取 `INCOMING_CALLS` / `OUTGOING_CALLS`;`depth`
  控层数,`childOffset` 翻页。

### 项目与编辑器

- {{cmd_list_directory_tree}} **项目视角的目录树**(尊重内容根与排除项):`maxDepth` 控深度。
  **它是绝对深度上限,实际只展开到 `maxDepth-1` 层;省略时默认 5(只展开 4 层)。** 要看全就传一个明显够大的值
  (如 50),不会报错、也没有额外代价。**输出到边界就停,不带任何截断标记** —— 所以"某个目录后面没有子项"有两种
  可能:真空目录,或者被你截断了。判据:树的深度正好顶到你传的值,或者**包目录 / 源码目录显示为空** —— 那就是被截断了。
  **把 `maxDepth` 调大重试,或把 `directoryPath` 直接指到那个子目录再看一层。**
- {{cmd_get_project_modules}} **项目模块及类型**。
- {{cmd_get_project_dependencies}} **项目直接声明的依赖**。
- {{cmd_get_all_open_file_paths}} **用户在 IDE 里打开了哪些文件**(含当前激活的那个)。
- {{cmd_open_file_in_editor}} **把文件在 IDE 里打开并激活**,给用户看。

### 读文件

- {{cmd_read_file}} **按项目解析路径读文件** —— 普通文件用 `read` 工具就够,它只在三种情况下用得着:
  `search_symbol` 返回的路径(它的基准是那个项目,不是会话工作目录);**压缩包内的条目**(`read` 工具读不到压缩包内部,
  而它还能把 `.class` **反编译成源码**);路径按那个项目解析更省事的时候。
  压缩包路径两种写法:`<路径>.jar!/<条目>`(相对或绝对都行)或 `jar://<**绝对**路径>.jar!/<条目>`(`jar://` 只认绝对路径)。

### 改代码 (重构 · 格式化 · 补丁 · 校验)

- {{cmd_rename_refactoring}} **改一个符号(变量 / 函数 / 类 / 字段 / 方法),哪怕散落在几十个文件里,优先用它** ——
  它按**语义**更新所有**真引用**:跨文件一起改,类名连**文件名**一起改。
  - **它只改代码**:注释、字符串字面量、别的语言的同名符号原样不动 —— 名字只落在真正的引用上。
  - 返回里 `with N usages` 的 N 是**真引用数**;比预期少,说明有引用没被解析到(文件没进 IDE 索引),
    这时**先确认索引到那个模块**,再处理剩下的引用。
  - 改的本来就是文字(配置 key、模板占位符、文档、SQL)、**就是要改那句字符串**、或者文件 IDE 没索引(生成物、
    vendor 目录)时,用 `edit` / `write` / `apply_patch`。动手前先用 `grep` 工具确认命中范围。
- {{cmd_reformat_file}} **按 IDE 的代码风格重排**。
- {{cmd_apply_patch}} **一次改多个文件**:`input` 传补丁正文,Codex 格式(`*** Begin Patch` / `*** Update File: <路径>`
  / `@@` / `-` 旧行 / `+` 新行)与 unified git diff 都收。`edit` / `write` 工具都只管一个文件。
  - 它**按文本**改,适合同一段文字铺到多个文件;**改符号走上面那条**。
  - 它**只碰补丁里写明的那几行**,其余内容保持原样。
  - 上下文对不上时那一个 hunk 失败、**该文件原样不动**,返回里点名是哪个文件(`<路径>: Hunk context not found`)。
  - 多个文件是**逐个应用**的:返回里 `N out of M operations applied`,失败的那些读一下再改;
    改完用 `grep` 工具确认落盘。
- {{cmd_lint_files}} **批量检查**:`files` 传数组;只列有问题的文件。
- {{cmd_get_file_problems}} **单文件检查**:`filePath`;结果在 `errors`。
- {{cmd_build_project}} **构建校验**:`filesToRebuild` 可只构建指定文件;有问题返回在 `problems`,没返回即没问题。

**改完代码,自己先查一遍再收尾。** 查一次很便宜,而问题一旦漏到用户看见、或留到构建 / 测试炸了才暴露,回头纠正的
代价就高一个量级。 校验跟着改动范围走 —— 这一轮属于"改一大片"还是"改一处",见下面两条。

- **这次要改一大片**(多文件、跨模块、"顺手把这几处一起对齐")→ 全部改完再 `build_project` 一次,
  在完整状态上检查。
- **这次只改一处,或在同一个文件上反复微调** → 告一段落时,把这轮改过的文件一次 `lint_files` 掉;要看单个
  文件的细节再上 `get_file_problems`。
- **改了签名 / 接口 / import / 依赖**这类"别处会跟着坏"的地方 → 走 `build_project`;只动了文件内部的实现 →
  lint 就够。
- 查出来的问题 **改掉,或说清为什么不改**。
- 校验走上面这些工具;先调用一次,索引没同步或环境不对时它会明说。
- **全仓类型检查是收尾动作,不是编辑循环**:同一任务只在最后跑一次 `pnpm typecheck`;过程中只对改动文件跑
  `lint_files` / `get_file_problems`。局部检查用这两个工具,全仓 typecheck 留给收尾。
- 只有改依赖清单、生成 Prisma Client、跑迁移这类必须执行命令的动作,才额外调用 `pnpm`;一个任务通常不超过两次。

### 运行配置

- {{cmd_get_run_configurations}} **项目里有哪些运行配置**:传 `filePath` 可列该文件的运行入口。
  配置由 IDE 自己存储(通常在项目目录之外),用这个工具读。
- {{cmd_execute_run_configuration}} **跑已有配置**:配置里的 `EXECUTE_IN_TERMINAL` 要是 `false`(共享出去的配置都这样)
  ;覆盖参数 (`programArguments` / `workingDirectory` / `envs`)需配置支持 `supportsDynamicLaunchOverrides`,否则会直接报错。
{{#if canCreateRunConfiguration}}
- {{cmd_create_run_configuration}} **新建任意类型的项目级配置**:内容来源三选一 —— `cloneFrom`(复制一个现成的,最稳;
  字段名不确定时只走它)、`configurationXml`(模板里的 XML 片段)、平台模板 + `options` / `attributes` / `envs` 补丁。
  它是 **项目资产**,不是"跑命令"的手段 —— 只是要跑一条命令就用 `shell` 工具。
  **要不要建、建什么、怎么建、档案怎么记,全按上面那个 skill 走。** 判据只有一条: **这件事以后会不会以同样的形态再发生?**
  会 (改表后同步 DDL、跑迁移、生成代码、打包、起 dev server、往某个环境部署这类)就 **主动提**一次
  "要不要固化成 run configuration",并把配置名 / 类型 / 命令 / 工作目录 / 为什么值得留摊开;不会 (查条数据、看个日志、
  试一条命令)就用 `shell` 工具跑完算。
  **改完同步档案**:新增 / 删除 / 改名之后按 skill 更新 `AGENTS.md` 里的档案块 —— 档案和项目里的配置对不上,比没有档案更糟。
{{/if}}
{{#if canInspectRunConfiguration}}
- {{cmd_inspect_run_configuration}} **看一个配置的全貌**:定义 (options / envs / before-launch)、命名解析 (`win` /
  mac-linux、base、env)、当前活实例、历史运行及各自的日志文件路径。 **改之前先用它拿当前值**;服务起没起来想看日志,先用
  `list_running_configurations` 的 `logFile`,要翻"上一次为什么挂了"再走这里。
{{/if}}
{{#if canUpdateRunConfiguration}}
- {{cmd_update_run_configuration}} **改字段或改名**:`options` / `envs` / `attributes` 是补丁 (`null` = 删),`newName` 改名并
  **连带更新别人对它的引用**、迁移历史日志。改之前先 `inspect` 拿 `configurationXml` 与当前值。
{{/if}}
{{#if canDeleteRunConfiguration}}
- {{cmd_delete_run_configuration}} **删配置**:在跑或被人引用时拒绝;`force = true` 才会连引用一起清掉。
{{/if}}
{{#if canListRunningConfigurations}}
- {{cmd_list_running_configurations}} **当前真正在跑的配置**(几个实例 / 各自 pid / 退出码,每个实例还带自己的日志文件路径
  `logFile`):停 / 重启前后都先用它看状态。
{{/if}}
{{#if canStopRunConfiguration}}
- {{cmd_stop_run_configuration}} **停掉该配置的全部实例并等它们退出**:没在跑也返回成功。
{{/if}}
{{#if canRerunRunConfiguration}}
- {{cmd_rerun_run_configuration}} **启动 / 重启常驻进程**:在跑就重启、没在跑就启动 —— 改完代码要重启就直接用它,
  有没有热重载都一样;读 `started` 判断新进程是否真的起来了。这次运行的输出在 `output`,完整日志文件路径在
  `fullOutputPath`。启停都走这个工具,IDE 的 Run 窗口状态才会跟着更新。
{{/if}}

**配置名怎么读**:`[os@]base[@env]`,`@` 分割、最多三段 —— `os` = `win`(缺省 macOS / Linux)、`base` = 配置本体(必填)、
`env` = 环境名(缺省 = 默认环境)。`win@base`(换平台)与 `base@env`(换环境)都是 `base` 的 **变体**,跑哪一个:

- **平台**:macOS / Linux 用 `base`,Windows 用 `win@base` —— `win@base` 不存在时 **交回用户**。
- **环境**:不带 `@` 的就是 **默认环境**。一批一起起时 **逐条解析**:有 `base@<要的环境>` 就用它,没有就用默认;只有 `@env`
  变体、没有默认版的,就用它自己那个 —— "10 个服务"可以是"3 个 `@dev` + 7 个默认",不必逐条问。
- 一条配置同时有 `base` 与 `base@<env>`、又没说走哪个环境 → **问一次走哪个环境**,选定后本会话默认走这套。
- 一个环境怎么接上(启动参数 / 环境变量 / 配置文件)是项目自己的事:照现成的同类变体来,或问用户。
{{#if canListDeploymentServers}}

### 服务器文件同步

往服务器传文件 / 从服务器取文件,走这一组 —— IDE 的连接、路径映射、排除规则都在它们后面,传的就是 IDE 在管的那一份。

- {{cmd_list_deployment_servers}} **本项目能用的部署服务器**:名称 (后面几条用它当 `serverName`)
  、项目级还是应用级、协议、host / port、在本项目里的路径映射,以及 **项目级**的部署选项与危险组合告警。 **只读 IDE
  配置、不联网**;动手前先看 `warnings[]`。
{{#if canUploadToDeployment}}
- {{cmd_upload_to_deployment}} **把映射到的本地目录传到服务器**(等同 IDE 的 Upload to …)。`mode` 默认 `mirror` ——
  **会删掉服务器上多出来的文件**,使两边一致;要留住它们就传 `upload`。 **破坏性操作**。
{{/if}}
{{#if canDownloadFromDeployment}}
- {{cmd_download_from_deployment}} **把服务器上映射目录的内容拉回本地**(等同 IDE 的 Download from …), **以服务器为准**:
  两边都有的文件会被远端覆盖 (内容相同则不写)。 **没有"保留我的版本"这个选项**。
{{/if}}
{{#if canGetDeploymentTaskStatus}}
- {{cmd_get_deployment_task_status}} **查一次传输的状态**:`handle` 用上传 / 下载返回的那个 —— **它自己不启动任何传输**。
{{/if}}

上传 / 下载都在 IDE 后台跑,单次调用只等到 `waitMs`(默认 10 秒)为止;返回 `in_progress` 是 **正常**的,不是失败 —— 拿
`handle` 去查进度;重复调用上传 / 下载会再起一次传输。
{{/if}}
