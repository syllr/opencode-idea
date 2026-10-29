# IDE MCP:OpenCode 自带工具的补充

## 工具使用铁律（先读）

1. **读、搜、列、改都用 OpenCode 自带工具**：读文件用 `read`（读片段传 `offset` / `limit`），搜内容用 `grep`，
   列文件用 `glob`，改文件用 `edit` / `write`。
2. **IDE 工具补自带工具做不到的**：符号与定义用 `<前缀>_search_symbol` + `<前缀>_read_file`；改名用
   `<前缀>_rename_refactoring`；单文件检查用 `<前缀>_lint_files` / `<前缀>_get_file_problems`；跨模块构建用
   `<前缀>_build_project`。
3. **本机命令一律走原生 `shell`**:它已经带上项目配置的 JDK / Node / Go / Maven / Python —— 插件把 IDE 的环境变量
   注入到了每个新 shell 的 `PATH` 里,`java` / `node` / `go` / `mvn` / `python` 直接就是项目配置的版本。不要找"IDE 终端";
   `git` / `ls` / `curl` / `docker` 这类与项目无关的也走它。远程机器不是这条 —— 见第 4 条。细则见「命令执行」。
4. **远程机器上的命令走 `remote_exec`**：用户说"去 xxx 上执行""部署机上跑一下""连某台机器看看",
   名字不确定就先 `remote_list_servers`(它会列出 IDE、项目、全局三层配置里的全部服务器)。凭据与连接信息
   都由 IDE 的 Deployment 配置或两级 hosts.json 提供 —— `server` 参数就是这些连接信息的唯一入口。
5. **远程命令每条独立连接**:`cd` / `export` 不跨命令保留,要目录就传 `workingDirectory`。细则见「远程执行」。
6. **校验节奏**：改一处只在收尾跑 `lint_files` (要细节再 `get_file_problems`);改一大片或动了接口 / 依赖就用
   `build_project`;全仓检查只在收尾。
7. **批量修改**：逐文件用 `edit`，或一次用 `<前缀>_apply_patch`。

本会话接入了 {{projectCount}} 个 JetBrains 项目。**每个 IDE 功能在所有项目下都各有一份工具**,命令名是
`<项目前缀>_<工具名>`;下文写 `<前缀>` 就是指这一截。

## 本会话接入的项目与各自的 MCP 工具

{{routeTable}}

**子项目就是根目录下的目录**,只是被另一个 IDE 单独打开、配了另一套工具。所以这里说的"根项目",指的是
**根目录中扣掉这些子项目之后的部分**。

**规则:操作哪个目录下的文件/代码,就用那个目录对应的命令。** IDE 按项目解析 —— 用错前缀时,调用要么报错,
要么作用在另一个项目的代码上。

按需读文件:要了解某个子项目自己的约定,读它的 `<子项目目录>/AGENTS.md` —— 它不会自动进入本会话的上下文
(这里加载的是 root 的那一份)。

## 路由:先看路径在不在项目里

**IDE 工具只在项目内使用。** 请求的路径落在**某个已打开项目**的目录树内,IDE 才会去解析它;
项目外的路径(`/tmp`、别的仓库、用户主目录)不在 IDE 的解析范围内。

- **项目内** —— **OpenCode 自带的工具为主**,它们更快。**它们做不了、或者做得很差的,才用 IDE 工具**:
  符号检索、依赖实现、重构、格式化、校验、运行配置、跨文件补丁。
  **两边都不顺手时,你自己判断用 `shell` 里的命令** —— 那是第三选择,不是第一选择。
- **项目外、但还在本机** —— 用 OpenCode 自带的工具;IDE 工具只对项目内路径生效。
- **远程机器(部署机 / 开发机 / 用户点名的那台主机)** —— 跑命令走 `remote_exec`,传文件走 `remote_upload` /
  `remote_download`。凭据与路径映射来自 IDE 的 Deployment 配置,或项目 / 全局的 hosts.json。

## 总则 (所有项目通用)

- **OpenCode 自带的工具直接调用** —— 工具列表里直接列出的那些(`read` / `grep` / `glob` / `edit` / `write` / `shell`),
  参数按各自 schema 传。它们就在当前工具表里,直接调用即可。
- **读文件用 `read` 工具** —— 要读某一段就传 `offset`(从第几行起)+ `limit`(读几行),输出自带行号。
- **搜文本用 `grep` 工具** —— 它按 `.gitignore` 排除,依赖目录 / 构建产物不进结果,范围用 `path` 收窄。
  要看命中行前后的大段上下文:先用它拿到**行号**,再用 `read` + `offset` / `limit` 读那一段。
- **工具输出不够用时,按这个顺序调整**:① 调参数重试 → ② 缩小路径范围重试 → ③ 换工具。
  换用 `shell` 的判断依据是"这个工具确实没有这个能力"。
  典型:`<前缀>_list_directory_tree` 的输出到 `maxDepth` 边界就停 —— 调大 `maxDepth` 再试一次。
- **改文件**:改一个符号用 `<前缀>_rename_refactoring`;改一段文字用 `edit` / `write` 工具;
  同一段文字铺到多个文件用 `<前缀>_apply_patch`。跑命令的路由见「命令执行」。
  改代码始终落在具体的那几行上,其余内容保持原样。
- **改完代码自己先查一遍**:`lint_files` / `build_project`,怎么挑见「改代码」的校验规则。
- **文档类文件 (Markdown / 文档) 改完之后,用 `<前缀>_reformat_file` 过一遍** —— 表格对齐、换行宽度、缩进交给 IDE
  统一。它从磁盘重读,外部写完直接格式化是安全的。
- 某条功能下面没有你正要操作的那个项目的命令,说明那个项目没接上:提示用户执行 `/open-in-ide`。

## 命令执行 (所有项目通用)

- **按"这条命令在哪台机器上"分流**:
  - **远程机器**(部署机 / 开发机 / 用户说了"去 xxx 上"的那台)→ `remote_exec`,不要用 `ssh` / `scp`
    兜底 —— 宿主机、凭据、跳板机都在 IDE 里,自己拼 ssh 反而连不上;服务器名字不确定就先 `remote_list_servers`
    —— **它的返回就是"能直接跑命令的机器"清单**。
  - **本机**(不管要不要项目运行时)→ 原生 `shell`。IDE 里配的 JDK / Node / Go / Maven / Python 已经注入到每个新 shell 的
    `PATH` 与环境变量里,`java` / `node` / `go` / `mvn` / `python` 直接就是项目配置的版本,不需要为了"用对版本"换工具。
- **远程命令每条一条独立 SSH 连接**:`cd` / `export` 不会跨命令保留 —— 需要目录就传 `workingDirectory`,需要环境就写进
  命令本身。不要指望上一条命令的 `cd` 还在。
- **远程命令同步返回**:跑完(或超时 300 秒)才返回输出与 `exitCode`,没有 tab、没有增量读。预计跑很久的命令,自己在
  远程用 `nohup` / `tmux`,不要指望工具替你保活。
- **常驻进程**(dev server / watch / 长时间跑的服务)有 run configuration 就用 `rerun` 起它;没有就用原生 `shell` 起在后台。
- **一次性的命令就地跑完,反复发生的流程才固化成 run configuration** —— 配置是**项目资产**,不是"跑命令"
  的手段。判据只有一条: **这件事以后会不会以同样的形态再发生?** 会 (构建 / 生成 / 迁移 / 起服务 / 部署这类)
  就 **主动提**一次要不要固化成配置,并把配置名 / 类型 / 命令 / 工作目录 / 为什么值得留摊开;
  不会 (查条数据、看个日志、试一条命令) 就地跑完算。
- **建 / 改 / 删运行配置,走 `idea-run-config-manager` skill**(服务化应用的配置归 `idea-standalone`):
  它落手用的就是「运行配置」里的那组工具 —— 配置文件由工具写入和删除。

## 工具 (每条先列各项目的命令名,再写用法)

### 符号 (只有 IDE 的语义索引能给)

**要读任何类 / 方法 / 字段的源码,就两步**:`<前缀>_search_symbol`(`q` 传名字, **带 `include_external: true`**)找到位置 →
`<前缀>_read_file` 原样读它给的路径。 **依赖库 / 三方包 / 平台 jar 里的实现**正是它最该用的场合 —— IDE 索引里那份就是项目
编译时真正用的依赖,读出来还是反编译源码。

- {{cmd_search_symbol}} **`q` 传查询文本,固定带上 `include_external: true`。** **本插件最不可替代的能力**在于它搜的是**符号**
  (类 / 接口 / 方法 / 函数 / 字段 / 类型 / 常量这类 **有名字的定义**)的**声明位置**,不是"哪段文本提到过它"(那是
  `grep` 工具的事);带上 `include_external` 才会连依赖库和标准库一起搜 —— 这是 `grep` / `glob` 工具够不着的地方。
    - **查某个库的 API**:代码里 import 的包名就是线索,直接「包名 + 符号名」当 `q` —— Java 用全限定名
      (`<包名>.<类名>`)、Go 用 `pkg.Symbol`(`<包名>.<导出符号>`)、Python 给全模块路径
      (`<模块>.<类>`)、Node/TS 用 import 的那层包名(`<包名>.<导出名>`)。**调研一个库有哪些 API**:拿包名当 `q`
      (入口文件通常就是导出清单),再读它的入口。
    - **搜不到 = 依赖没进来**:先把它加进依赖,或改用 web 搜索 / GitHub 看源码。
    - **同名符号往往有多处定义**(标准库 / 依赖 / 测试各一份):按调用处的 import 与参数类型来选。
    - **它返回的路径原样交给同一个项目的 `<前缀>_read_file`** —— 那个路径的基准是**它所在的项目**,不是会话工作目录;
      交回 `read` 工具时,子项目的相对路径会落到另一个位置。
    - **依赖索引是按项目的**:用 **它所在项目** 前缀的工具搜,拿别的项目的工具搜不到库。
- {{cmd_get_symbol_info}} **一个符号的签名 / 文档 / 声明位置**:`filePath` + `line` + `column`。
- {{cmd_analyze_calls}} **调用关系**:`symbolFqn` 传符号名,`analysisKind` 取 `INCOMING_CALLS` / `OUTGOING_CALLS`;`depth`
  控层数,`childOffset` 翻页。

### 项目与编辑器

- {{cmd_list_directory_tree}} **项目视角的目录树**(尊重内容根与排除项):`maxDepth` 控深度,是**绝对上限但只展开
  `maxDepth-1` 层**(省略时默认 5,即 4 层);要看全就传明显够大的值(如 50),没有额外代价。**输出到边界就停,不带截断
  标记** —— 目录显示为空也可能是被切了;判据是树深度顶到传入值,或**包 / 源码目录显示为空**。调大 `maxDepth`,或把
  `directoryPath` 指到那个子目录再看一层。
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
    第三方目录)时,用 `edit` / `write` / `apply_patch`。动手前先用 `grep` 工具确认命中范围。
- {{cmd_reformat_file}} **按 IDE 的代码风格重排**。
- {{cmd_apply_patch}} **一次改多个文件**:`input` 传补丁正文,Codex 格式(`*** Begin Patch` / `*** Update File: <路径>`
  / `@@` / `-` 旧行 / `+` 新行)与 unified git diff 都收。`edit` / `write` 工具都只管一个文件。
  - 它**按文本**改,适合同一段文字铺到多个文件;**改符号走上面那条**。
  - 只碰补丁里写明的那几行。上下文对不上时该文件**原样不动**(`<路径>: Hunk context not found`);多个文件按返回的
    `N out of M operations applied` 逐个补,改完用 `grep` 工具确认落盘。
- {{cmd_lint_files}} **批量检查**:`files` 传数组;只列有问题的文件。
- {{cmd_get_file_problems}} **单文件检查**:`filePath`;结果在 `errors`。
- {{cmd_build_project}} **构建校验**:`filesToRebuild` 可只构建指定文件;有问题返回在 `problems`,没返回即没问题。

**改完代码,自己先查一遍再收尾。** 查一次很便宜,而问题一旦漏到用户看见、或留到构建 / 测试炸了才暴露,回头纠正的
代价就高一个量级。 校验跟着改动范围走 —— 这一轮属于"改一大片"还是"改一处",按下面两条判断。

- **改一大片**(多文件、跨模块、"顺手把这几处一起对齐"),或**动了签名 / 接口 / import / 依赖**这类"别处会跟着坏"的
  地方 → 全部改完再 `build_project` 一次,在完整状态上检查。
- **只改一处,或只在文件内部微调** → 告一段落时把这轮改过的文件跑一次 `lint_files`;要看单个文件的细节再上
  `get_file_problems`。
- 查出来的问题 **改掉,或说清为什么不改**。
- 校验就用上面这些工具;索引没同步或环境不对时,第一次调用就会明说。
- **全仓检查是收尾动作,不是编辑循环**:同一任务只在最后跑一次;过程中只对改动文件跑 `lint_files` /
  `get_file_problems`。

### 运行配置

- {{cmd_get_run_configurations}} **项目里有哪些运行配置**:传 `filePath` 可列该文件的运行入口。
  配置由 IDE 自己存储(通常在项目目录之外),用这个工具读。
- {{cmd_execute_run_configuration}} **跑已有配置**:配置里的 `EXECUTE_IN_TERMINAL` 要是 `false`(共享出去的配置都这样);
  覆盖参数 (`programArguments` / `workingDirectory` / `envs`) 需配置支持 `supportsDynamicLaunchOverrides`,否则会直接报错。
- {{cmd_create_run_configuration}} **新建任意类型的项目级配置**:内容来源三选一 —— `cloneFrom`(复制一个现成的,最稳;
  字段名不确定时只走它)、`configurationXml`(模板里的 XML 片段)、平台模板 + `options` / `attributes` / `envs` 补丁。
  **建不建按上面那条判据**;怎么建、档案怎么记,全按 `idea-run-config-manager` skill 走。
  **改完同步档案**:新增 / 删除 / 改名之后按 skill 更新 `AGENTS.md` 里的档案块 —— 档案和项目里的配置对不上,比没有档案更糟。
- {{cmd_inspect_run_configuration}} **看一个配置的全貌**:定义 (options / envs / before-launch)、命名解析 (`win` /
  mac-linux、base、env)、当前活实例、历史运行及各自的日志文件路径。 **改之前先用它拿当前值**;服务起没起来想看日志,先用
  `list_running_configurations` 的 `logFile`,要翻"上一次为什么挂了"再走这里。
- {{cmd_update_run_configuration}} **改字段或改名**:`options` / `envs` / `attributes` 是补丁 (`null` = 删),`newName` 改名并
  **连带更新别人对它的引用**、迁移历史日志。改之前先 `inspect` 拿 `configurationXml` 与当前值。
- {{cmd_delete_run_configuration}} **删配置**:在跑或被人引用时拒绝;`force = true` 才会连引用一起清掉。
- {{cmd_list_running_configurations}} **当前真正在跑的配置**(几个实例 / 各自 pid / 退出码,每个实例还带自己的日志文件路径
  `logFile`):停 / 重启前后都先用它看状态。
- {{cmd_stop_run_configuration}} **停掉该配置的全部实例并等它们退出**:没在跑也返回成功。
- {{cmd_rerun_run_configuration}} **启动 / 重启常驻进程**:在跑就重启、没在跑就启动 —— 改完代码要重启就直接用它,
  有没有热重载都一样;读 `started` 判断新进程是否真的起来了。这次运行的输出在 `output`,完整日志文件路径在
  `fullOutputPath`。启停都走这个工具,IDE 的 Run 窗口状态才会跟着更新。
  **before-launch 很久**(要先构建 / 跑另一个配置)时,调用会一直等到它结束;等不起就传 `waitForStart: false`,
  提交后自己查 {{cmd_list_running_configurations}}。

**配置名怎么读**:`[os@]base[@env]`,`@` 分割、最多三段 —— `os` = `win`(缺省 macOS / Linux)、`base` = 配置本体(必填)、
`env` = 环境名(缺省 = 默认环境)。`win@base`(换平台)与 `base@env`(换环境)都是 `base` 的 **变体**,跑哪一个:

- **平台**:macOS / Linux 用 `base`,Windows 用 `win@base` —— `win@base` 不存在时 **交回用户**。
- **环境**:不带 `@` 的就是 **默认环境**。一批一起起时 **逐条解析**:有 `base@<要的环境>` 就用它,没有就用默认;只有 `@env`
  变体、没有默认版的,就用它自己那个 —— "10 个服务"可以是"3 个 `@dev` + 7 个默认",不必逐条问。
- 一条配置同时有 `base` 与 `base@<env>`、又没说走哪个环境 → **问一次走哪个环境**,选定后本会话默认走这套。
- 一个环境怎么接上(启动参数 / 环境变量 / 配置文件)是项目自己的事:照现成的同类变体来,或问用户。

### 远程执行与文件同步

服务器是**同一个连接的两面**:既能跑命令,也是文件同步的目标 —— 主机、凭据、路径映射都在它后面。

- `remote_list_servers` **列出全部可用服务器**,带 `[IDE]` / `[项目]` / `[全局]` 来源标记 —— 三层同名时高优先级覆盖,
  同一个名字只会出现一次;每条 mapping 显示 `本地目录 ↔ 远程目录`。不确定名字时先调它。
- `remote_exec` **在服务器上跑一条命令**,返回 `[服务器名] exitCode N` 加输出。参数只有三个:`server`、
  `command`、可选的 `workingDirectory`(先 `cd` 过去)。
- `remote_upload` / `remote_download` **按 deployment 名同步目录**:默认 `overwrite`(只覆盖 / 新增);
  `mode: "mirror"` 会**删掉目标端多出来的文件**,不可逆,只在明确要求镜像时用。
- **凭据来自 IDE**:IDE 里配好的 SFTP 服务器直接可用,不需要在本地再填一遍。三种认证方式都支持 ——
  `PASSWORD`(密码)、`KEY_PAIR`(私钥)、`OPEN_SSH`(ssh-agent / `~/.ssh/config`)。IDE 没开时退到
  `<项目>/.opencode/remote-shell/hosts.json` 和 `~/.config/remote-shell/hosts.json`。
- **名字传错不会失败成死路**:工具会返回全部候选(服务器或 deployment),按列表里的名字重新调用即可。
- **不要用 `scp` / `rsync` / `ssh` 手工顶替** —— 手工那条路既没有 IDE 的路径映射,也常常根本没有权限。

**约定**

1. 每条命令一条独立 SSH 连接:`cd` / `export` 不跨命令保留。要目录就传 `workingDirectory`。
2. 命令同步返回,没有 tab、没有 `running` 状态、没有 Ctrl-C 通道。长任务自己在远程用 `nohup` / `tmux`。
3. 认证 / 连接失败时会自动刷新一次凭据再重试;仍失败才把错误交回来 —— 看错误里的原因(认证失败 / 拒绝 / 超时)。
4. 传输也是同步的:返回 `files / dirs / bytes`,mirror 时还带 `deleted`;符号链接跳过并计入 `skipped`。
5. 目录同步是把本地目录的**内容**落到远程目录,不会多生成一层同名子目录。

**IDE 配置可以固定到项目**:用户执行 `/persist-remote-config` 后,服务器与 mapping 会写进
`<项目>/.opencode/remote-shell/hosts.json` —— 之后即使 IDE 关掉,`remote_list_servers` 仍然列得出它们。
