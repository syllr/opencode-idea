# IDE MCP:只有非 IDE 不可的能力才走 IDE

本会话接入了 {{projectCount}} 个 JetBrains 项目。 **每个功能在所有项目下都各有一份工具**,命令名就是
`<项目前缀>_<工具名>`;下面每条功能后面直接列出它在各项目里的命令名。下文写 `<前缀>` 时,指的就是这一截。

## 本会话接入的项目与各自的 MCP 工具

{{routeTable}}

**子项目就是根目录下的目录**,只是被另一个 IDE 单独打开、配了另一套工具。所以这里说的"根项目",指的是
**根目录中扣掉这些子项目之后的部分** —— 操作某个子项目里的文件,就用那个子项目的命令,不要因为它"在根目录下"
就用根项目的工具。

**规则:操作哪个目录下的文件/代码,就用那个目录对应的命令。** IDE 是按项目解析的 —— 跨项目调用要么直接报错,
要么被解析到另一个项目上、作用在错误的代码上。

按需读文件:要了解某个子项目自己的约定,读它的 `<子项目目录>/AGENTS.md`(它不会自动进入本会话的上下文,
本会话是 root 打开的那一个)。

## 总则 (所有项目通用)

- 原生工具 (工具列表里直接列出的那些,下面这些 IDE 工具也算)**直接调用** —— 参数按各自 schema 传,不要包进 `execute`,
  也不要用 Code Mode 的 `search` 去找 (它们不在那份目录里,搜不到)。
- **只有 IDE 才有的能力才用它们**:符号级检索、项目模型、检查与构建、重构与格式化、run configuration。
- **读与搜索用原生工具**(`read` / `grep` / `glob`):不要为读一个文件、搜一段文本去绕 IDE 工具。
- **改项目代码用 IDE 的编辑命令**(`<前缀>_apply_patch`,新建文件用 `<前缀>_create_new_file`),不要用原生 `write` / `edit` ——
  那两个在进程外写,IDE 手里可能还是旧内容,紧接着的 IDE 侧工具会基于旧代码干活。项目目录之外的文件才用原生那两个。
- **改完代码自己先查一遍**:用 `lint_files` / `build_project`,怎么挑见下面「校验」。
- 某条功能下面没有你正要操作的那个项目的命令,就是那个项目没接上:提示用户执行 `/open-in-ide`,不要重试,也不要去别处找。

## 工具 (每条第一行是各项目的命令,接着是它的用法)

### 符号 (只有 IDE 的语义索引能给)

**要读任何类 / 方法 / 字段的源码,就两步**:`<前缀>_search_symbol`(`q` 传名字, **带 `include_external: true`**)找到位置 →
`<前缀>_read_file` 原样读它给的路径。 **依赖库 / 三方包 / 平台 jar 里的实现**正是它最该用的场合 —— IDE 索引里那份就是项目
编译时真正用的依赖 (`javap` / 解包 jar / 按 jar 路径 `grep` 拼出来的往往是另一份,版本对不上),读出来还是反编译源码。

- {{cmd_search_symbol}} **`q` 传查询文本,固定带上 `include_external: true`。** 本插件最不可替代的能力 —— 它搜的是
  **符号**(类 / 接口 / 方法 / 函数 / 字段 / 类型 / 常量这类 **有名字的定义**)的 **声明位置**,不是"哪段文本提到过它"(那是
  `grep` 的事);带上 `include_external` 才会连 **依赖库和标准库**一起搜,于是你能直接定位第三方库里的实现 —— 这是原生
  `grep` / `glob` 够不着的地方 (IDE 自己的 `search_text` / `search_file` 也只搜项目内)。
    - **典型用法 ①:代码里引用了某个库的 API (最常见)** —— 读代码时看到 `from fastapi import FastAPI`、
      `import org.apache.poi...FormulaParser`、`gorm.DeletedAt`、`from 'vue'` 这类引用时, **包名就在代码里**,直接
      **用「包名+符号名」当 `q` 搜**,一次定位到它的实现:
        - **Java**:全限定名 —— `com.nimbusds.jose.util.Base64`(实测 1 条命中 `~/.m2/.../poi-5.3.0-sources.jar!/...`)
        - **Go**:包名.符号 —— `gorm.DeletedAt`(实测 2 条,全在 `go/pkg/mod/gorm.io/gorm@...`)
        - **Python**:模块路径给得越全越准 —— `torch.nn.modules.module.Module`(目标全在最前);`torch.nn.Module` 也能把目标排进前
          2
        - **Node/TS**:用 **import 的那层包名**(不是子模块路径)—— `vue.Teleport` 有效,`@vue/runtime-core.TeleportProps`
          搜不到
    - **典型用法 ②:调研一个库有哪些 API** —— 包名从依赖清单里拿 (pom.xml / package.json / go.mod / requirements.txt),
      **直接拿包名当 `q` 搜**,结果基本就落在这个库里,再读入口:
        - **Python**:`fastapi` → `fastapi/applications.py`、`fastapi/__init__.py`(**入口就是导出清单**:直接看到
          `FastAPI`、`HTTPException` 这些公开名字)
        - **Java**:`poi` → `~/.m2/.../poi-5.3.0-sources.jar!/org/apache/poi/...`;读该库的入口类
        - **Go**:`gorm` → `go/pkg/mod/gorm.io/gorm@v1.31.0/...`
        - **Node/TS 例外**:包名当 `q` 搜不到 (实测 `element-plus` → 0 条)。要用 **代码里 import 的符号名**
          ;包名是简单标识符时可以「包名.符号」 (`vue.Teleport` 有效),但 **带 `-` 或 `@scope/` 的这么拼是 0 条**
          (`element-plus.ElMessage`、`@vue/runtime-core.TeleportProps` 都搜不到)。而裸符号名会跨多个子项目 (`ElMessage` 命中
          user / admin / vcop 三处),这时用 `paths` 圈到那个 `node_modules` —— `paths: ['frontend/user/**']` 就收敛到一处。
    - **它只覆盖「项目已经引入」的依赖**:搜不到某个库,基本就是这个库还没进依赖 —— 别反复试:要么先把它加进依赖 (pom /
      requirements / package.json),要么改用 web 搜索 / GitHub 看它的源码。
    - **同名符号往往有多处定义**(标准库一份、几个依赖各一份,还有测试和示例),所以 **按代码上下文选**:看调用处 import
      的是哪个包、传参是什么类型、返回路径属于哪个库 —— 别把第一行当答案。
    - **它返回的路径,原样交给同一个项目的 `<前缀>_read_file` 就是源码**:
      两者同属一个项目、相对路径的基准一致,所以不用拼绝对路径、不用管是什么语言 —— 压缩包里的条目它也照样读 (`.class`
      还会反编译)。
      例:`<前缀>_search_symbol({ q: "UvicornWorker", include_external: true })` 给出
      `../../../Library/.../uvicorn/workers.py` → `<前缀>_read_file({ file_path: "那个字符串" })`。
    - **依赖索引是按项目的**:任何依赖都用 **它所在项目**的那个 MCP 工具去搜 ——
      根项目的依赖用根项目的命令,子项目的依赖用子项目的命令。拿一个项目的工具去搜另一个项目的依赖,只会在那个项目自己的文件里找,
      **拿不到库**。
    - **别把这条路径交给原生 `read`**:原生 read 的基准是本会话的工作目录 (根项目),拿子项目的相对路径去读会落到错误的位置。
- {{cmd_get_symbol_info}} **一个符号的签名 / 文档 / 声明位置**:`filePath` + `line` + `column`。
- {{cmd_analyze_calls}} **调用关系**:`symbolFqn` 传符号名,`analysisKind` 取 `INCOMING_CALLS` / `OUTGOING_CALLS`;`depth`
  控层数,`childOffset` 翻页。

### 项目与编辑器

- {{cmd_list_directory_tree}} **项目视角的目录树**(尊重内容根与排除项):`maxDepth` 控深度。
- {{cmd_get_project_modules}} **项目模块及类型**。
- {{cmd_get_project_dependencies}} **项目直接声明的依赖**。
- {{cmd_get_all_open_file_paths}} **用户在 IDE 里打开了哪些文件**(含当前激活的那个)。
- {{cmd_open_file_in_editor}} **把文件在 IDE 里打开并激活**,给用户看。

### 改代码

- {{cmd_apply_patch}} **走 IDE 改文件**:`input` 传补丁 (两种格式都行 —— Codex 的 `*** Begin Patch` /
  `*** Update File: <路径>` / `@@` / `*** End Patch`,或 unified git diff)。一个补丁里可混着 **Add / Update / Delete**
  多个操作,`Update` 还能带 `*** Move to: <新路径>` 改名; **按上下文匹配**,`@@` 不用写行号。返回
  `N out of M operations applied`,对不上的 hunk 会报 `Hunk context not found`。路径必须在项目内。
- {{cmd_create_new_file}} **新建文件**:`pathInProject` + `text`;父目录自动建,`overwrite` 默认关 (文件已存在会报错)。

### 重构与格式化

- {{cmd_rename_refactoring}} **按符号改名**,项目内的引用一并更新。
- {{cmd_reformat_file}} **按 IDE 的代码风格重排**。

### 校验

- {{cmd_lint_files}} **批量检查**:`files` 传数组;只列有问题的文件。
- {{cmd_get_file_problems}} **单文件检查**:`filePath`;结果在 `errors`。
- {{cmd_build_project}} **构建校验**:`filesToRebuild` 可只构建指定文件;有问题返回在 `problems`,没返回即没问题。

**改完代码,自己先查一遍再收尾。** 这不是流程要求,是你自己的判断 —— 查一次很便宜,而问题一旦漏到用户
看见、或留到构建 / 测试炸了才暴露,回头纠正的代价就高一个量级了。 **别把校验整段省掉。**

- **这次要改一大片**(多文件、跨模块、"顺手把这几处一起对齐")→ 全部改完再 `build_project` 一次。中途不查:
  半成品状态下的检查结果只会误导你。
- **这次只改一处,或在同一个文件上反复微调** → 告一段落时,把这轮改过的文件一次 `lint_files` 掉;要看单个
  文件的细节再上 `get_file_problems`。
- **改了签名 / 接口 / import / 依赖**这类"别处会跟着坏"的地方 → 走 `build_project`;只动了文件内部的实现 →
  lint 就够。
- 查出来的问题 **改掉,或说清为什么不改**,别把没处理的问题原样交给用户。
- 校验走上面这些工具, **不要改用 `shell` 里临时自己编一遍代替**。
- 也别先猜"索引还没同步 / 那个环境是另一个进程"就绕开 —— 先调一次,它真看不到会明说。

### 读压缩包内的东西

- {{cmd_read_file}} **压缩包内的条目**只有它能读 —— 原生 `read` 打不开压缩包,而它还能把 `.class` **反编译成源码**
  。两种路径写法:
  `<路径>.jar!/<条目>`(相对或绝对都行)或 `jar://<**绝对**路径>.jar!/<条目>`(`jar://` 只认绝对路径);「符号」那条搜出来的路径原样传即可。

### 运行配置

- {{cmd_get_run_configurations}} **项目里有哪些运行配置**:传 `filePath` 可列该文件的运行入口。
  **别去项目目录里翻配置** ——
  存在 IDE 自己存储里 (不在项目目录)的那些,翻文件是看不到的。
- {{cmd_execute_run_configuration}} **跑已有配置**:配置里的 `EXECUTE_IN_TERMINAL` 要是 `false`(共享出去的配置都这样)
  ;覆盖参数 (`programArguments` / `workingDirectory` / `envs`)需配置支持 `supportsDynamicLaunchOverrides`,否则会直接报错。
  {{#if canCreateRunConfiguration}}
- {{cmd_create_run_configuration}} **新建任意类型的项目级配置**:内容来源三选一 —— `cloneFrom`(复制一个现成的,最稳;
  字段名不确定时只走它)、`configurationXml`(模板里的 XML 片段)、平台模板 + `options` / `attributes` / `envs` 补丁。
  它是 **项目资产**,不是"跑命令"的手段 —— 只是要跑一条命令就用原生 `shell`。
  **要不要建、建什么、怎么建、档案怎么记,全按 `idea-run-config-manager` skill 走**。判据只有一条: **这件事以后会不会以
  同样的形态再发生?** 会 (改表后同步 DDL、跑迁移、生成代码、打包、起 dev server、往某个环境部署这类)就 **主动提**一次
  "要不要固化成 run configuration",并把配置名 / 类型 / 命令 / 工作目录 / 为什么值得留摊开;不会 (查条数据、看个日志、
  试一条命令)就用原生 `shell` 跑完算,别给项目留垃圾。
    - **改 / 改名 / 删**走同一组工具 (`update_run_configuration` / `delete_run_configuration`), **不要自己写文件、
      也不要自己删文件**。
    - **建之前先查重**:先在 `get_run_configurations` 里找做同一件事的配置,有就复用,别新建一个几乎一样的。
    - **改完别忘了同步档案**:新增 / 删除 / 改名之后,用 `idea-run-config-manager` skill 更新 `AGENTS.md` 里的档案块 ——
      档案和项目里的配置对不上,比没有档案更糟。
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
  `fullOutputPath`。不要用 `pkill` / `kill` / `shell` 代替。
  {{/if}}
  {{#if canListDeploymentServers}}

### 服务器文件同步

往服务器传文件 / 从服务器取文件,走这一组 —— **别用 `ssh` / `rsync` / `scp` 自己拼一份**:IDE 的连接、路径映射、排除规则都在它们后面,自己拼的不是
IDE 在管的那一份。

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
`handle` 去查进度, **别用重复调上传 / 下载代替**(那样拿不到进度)。
{{/if}}

## 命令执行 (所有项目通用)

- **`<前缀>` 是 IDE 项目的名字**:根项目是 `ide`,子项目是它的目录名 (如 `modelserver`) —— 一套工具属于一个项目,
  操作哪个项目就用哪个前缀的工具。
- **需要项目环境才跑得起来的命令**(依赖 IDE 里配好的 JDK / Node / Python 版本等):先看有没有现成的 run configuration ——
  有就跑它 (常驻用 `rerun`,跑完即退用 `execute`);没有、又只是一次性的命令,用原生 `shell` 并显式指定解释器,
  **不要为它新建配置**。
- 其余命令:用原生 `shell`。
{{#if canCreateRunConfiguration}}
- **建 / 改 / 删运行配置,走 `idea-run-config-manager` skill**(服务化应用的配置归 `idea-standalone`):要不要建、建什么、
  怎么建、建完档案怎么记,全由它管;它落手用的就是上面「运行配置」里的那组工具。 **不要自己写文件、也不要自己删文件**。
{{else}}
- **建 / 改 / 删运行配置,走 `idea-run-config-manager` skill**(服务化应用的配置归 `idea-standalone`):要不要建 / 建什么 /
  档案怎么记由它管;本会话没有新建工具,"建"这一步它只能讲清配置名、实际执行的命令、工作目录、为什么值得留,
  **请用户在 IDE 里自己建** —— 不要手写文件凑。
{{/if}}
