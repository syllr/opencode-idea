# Shell Script (`ShConfigurationType`)

**用途**:一条固定命令或一个脚本文件 —— 构建、打包、生成代码、跑迁移、同步某个环境的 DDL、起服务。 **绝大多数"
反复要跑的固定流程"都归它,先别换类型。**

## 二选一:脚本文本 / 脚本文件

| 形态               | 关键字段                                                              | 用在什么时候                            |
| ------------------ | --------------------------------------------------------------------- | --------------------------------------- |
| **脚本文本**(默认) | `EXECUTE_SCRIPT_FILE="false"` + `SCRIPT_TEXT` 有值 + `SCRIPT_PATH` 空 | 就一条命令,不需要单独脚本文件           |
| **脚本文件**       | `EXECUTE_SCRIPT_FILE="true"` + `SCRIPT_PATH` 有值 + `SCRIPT_TEXT` 空  | 命令已经写成仓库里的 `.sh`,或脚本比较长 |

## XML 形状:脚本文本形态

```xml

<component name="ProjectRunConfigurationManager">
    <configuration default="false" name="db-migrate" type="ShConfigurationType" factoryName="Shell Script">
        <option name="SCRIPT_TEXT" value="pnpm -C packages/db generate&#10;pnpm -C packages/db migrate:deploy"/>
        <option name="INDEPENDENT_SCRIPT_PATH" value="true"/>
        <option name="SCRIPT_PATH" value=""/>
        <option name="SCRIPT_OPTIONS" value=""/>
        <option name="INDEPENDENT_SCRIPT_WORKING_DIRECTORY" value="true"/>
        <option name="SCRIPT_WORKING_DIRECTORY" value="$PROJECT_DIR$"/>
        <option name="INDEPENDENT_INTERPRETER_PATH" value="true"/>
        <option name="INTERPRETER_PATH" value=""/>
        <option name="INTERPRETER_OPTIONS" value=""/>
        <option name="EXECUTE_IN_TERMINAL" value="false"/>
        <option name="EXECUTE_SCRIPT_FILE" value="false"/>
        <envs/>
        <method v="2"/>
    </configuration>
</component>
```

## XML 形状:脚本文件形态

```xml

<component name="ProjectRunConfigurationManager">
    <configuration default="false" name="go-server" type="ShConfigurationType" factoryName="Shell Script">
        <option name="SCRIPT_TEXT" value=""/>
        <option name="INDEPENDENT_SCRIPT_PATH" value="true"/>
        <option name="SCRIPT_PATH" value="$PROJECT_DIR$/go/run.sh"/>
        <option name="SCRIPT_OPTIONS" value=""/>
        <option name="INDEPENDENT_SCRIPT_WORKING_DIRECTORY" value="true"/>
        <option name="SCRIPT_WORKING_DIRECTORY" value="$PROJECT_DIR$/go"/>
        <option name="INDEPENDENT_INTERPRETER_PATH" value="true"/>
        <option name="INTERPRETER_PATH" value=""/>
        <option name="INTERPRETER_OPTIONS" value=""/>
        <option name="EXECUTE_IN_TERMINAL" value="false"/>
        <option name="EXECUTE_SCRIPT_FILE" value="true"/>
        <envs/>
        <method v="2"/>
    </configuration>
</component>
```

## 字段

| 字段                                                                                                | 含义                           | 怎么填                                                                                                                   |
| --------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `SCRIPT_TEXT`                                                                                       | 要执行的命令                   | **多行用 `&#10;` 分隔**(实测这么存的),不要塞真实换行                                                                     |
| `EXECUTE_SCRIPT_FILE`                                                                               | `false` 跑文本 / `true` 跑文件 | 决定上面两个字段谁生效                                                                                                   |
| `SCRIPT_PATH`                                                                                       | 脚本路径                       | `$PROJECT_DIR$/...`                                                                                                      |
| `SCRIPT_OPTIONS`                                                                                    | 传给脚本的参数                 | 没有就留空                                                                                                               |
| `SCRIPT_WORKING_DIRECTORY`                                                                          | 工作目录                       | `$PROJECT_DIR$` 或其子目录;**不要留空** —— 留空会继承 IDE 安装目录(实测 `pwd` 输出 `…/idea-2026.2.3-aarch64`,不是项目根) |
| `INDEPENDENT_SCRIPT_PATH` / `INDEPENDENT_SCRIPT_WORKING_DIRECTORY` / `INDEPENDENT_INTERPRETER_PATH` | 三处"各自独立"开关             | 照抄上面 XML 形状里的默认写法即可,不用管                                                                                 |
| `INTERPRETER_PATH` / `INTERPRETER_OPTIONS`                                                          | 解释器 / 解释器参数            | **不碰** —— 用户 / IDE 级配置,留空即默认,不要填具体路径                                                                  |
| `EXECUTE_IN_TERMINAL`                                                                               | 是否开终端跑                   | **`false`** —— 共享出去的配置不要依赖本机终端                                                                            |
| `envs`                                                                                              | 环境变量                       | 没有就 `<envs />`;有就 `<env name="K" value="V" />`                                                                      |

## 环境变体 (`base@env`)

名字:`base@<环境名>`(mac/Linux)、`win@base@<环境名>`(Windows)。 **base 与变体是同一件事的两种配置**
,变体只是把"用哪套环境"接上。

**环境怎么切有三条路,选哪条由该语言 / 框架的业务决定** —— 本 skill 不统一规定,但 **必须把环境真正接上**:

### 路线 1:应用按环境变量选配置

运行配置的 `envs` 里给环境名,应用启动时按它选自己那份配置。 **不读配置文件的业务就走这条。**

```xml
<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="console-web@yutairstandalone" type="ShConfigurationType" factoryName="Shell Script">
    <option name="SCRIPT_TEXT" value="APP_ENV=yutairstandalone pnpm --filter @aidata/console dev" />
    <option name="INDEPENDENT_SCRIPT_PATH" value="true" />
    <option name="SCRIPT_PATH" value="" />
    <option name="SCRIPT_OPTIONS" value="" />
    <option name="INDEPENDENT_SCRIPT_WORKING_DIRECTORY" value="true" />
    <option name="SCRIPT_WORKING_DIRECTORY" value="$PROJECT_DIR$" />
    <option name="INDEPENDENT_INTERPRETER_PATH" value="true" />
    <option name="INTERPRETER_PATH" value="" />
    <option name="INTERPRETER_OPTIONS" value="" />
    <option name="EXECUTE_IN_TERMINAL" value="false" />
    <option name="EXECUTE_SCRIPT_FILE" value="false" />
    <envs>
      <env name="APP_ENV" value="yutairstandalone" />
    </envs>
    <method v="2" />
  </configuration>
</component>
```

**环境名要同时写进 `SCRIPT_TEXT` 前缀**(`APP_ENV=yutairstandalone pnpm ...`):IDE 面板点 Run 认 `envs`,但 MCP 执行通道只认
`SCRIPT_TEXT`(实测)。

### 路线 2:脚本里加载配置文件

应用自己读不到环境变量,就让脚本先把 `env/<环境名>.env` 灌进进程环境再起它。

```xml
    <option name="SCRIPT_TEXT" value="set -a
. env/ytairstandalone.env
set +a
pnpm --filter @aidata/console dev" />
```

- 工作目录必须是 `$PROJECT_DIR$` —— `. env/...` 是相对路径,靠它定位仓库根。 **留空不等于项目根**:实测会继承 IDE 进程的
  cwd (IDE 安装目录),命令会在错误的地方跑。
- **这段是 POSIX shell 语法,绑平台**:Windows 侧要用 PowerShell 的写法 (把 env 文件读成环境变量),别把 mac 那份直接拷过去。
- **这段脚本内容跟着平台走**:mac / Linux 用 POSIX 语法,Windows 用 PowerShell 的写法,别把一边直接拷到另一边。

### 路线 3:启动参数指向配置文件

应用本来就支持配置文件参数时最省事:**`--profile=yutairstandalone` / `--env-file=env/yutairstandalone.env`** 写进
`SCRIPT_TEXT`。跨 shell 最安全 (只是个参数),也最不容易被"忘了设环境变量"坑到。

### 铁律

- **名字对了但环境没接上 = 没配好**。建完变体,确认它真的加载了那套配置 (应用启动日志里通常有一行"已加载配置 <名字>"之类)。
- **环境名是项目级的、可共享**(进 git);地址 / 凭据在 `env/<环境名>.env` 里, **不进 run config**。
- **base 与 `base@<env>` 同时存在时,启动前问一次用户走哪套**;问过之后本会话内默认走那一套,别反复打扰
  (细则见 [../SKILL.md](../SKILL.md) 硬性契约第 9 条)。

## 坑

- **`EXECUTE_IN_TERMINAL` 必须是 `false`**:引导文本里"执行 Shell 配置要 `EXECUTE_IN_TERMINAL: false`"说的就是它,开成
  true 的配置到了别人机器上行为不一样。
- **解释器是用户 / IDE 级的配置,新建时不要配、不要碰** —— 留空即默认 (实测:这三个字段整个不写,IDE
  一样认、一样跑,文件也不会被它改回去)。它属于每个用户自己那份设置,写进共享的配置只会给别人的机器添麻烦。
- **别为"解释器不同"去建 win@ 那一份**:要不要分平台,只看 **命令本身**在两个 OS 上能不能跑。
- `factoryName` 可以省略 (实测有省略也能被认),但同一项目里 **跟着已有文件的写法**更一致。
- 文件里可以有 XML 注释说明这条配置实际跑的是什么 (实测项目就这么写的),有助于后来的人看懂。

## 跨机器共享 (配置进 git 给全组用)

按"绑在哪一层"分三档,建配置前对着过一遍:

| 档              | 内容                                                                 | 跨机器怎么办                                                                 |
| --------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **项目级**      | 配置名、`SCRIPT_TEXT`、仓库内的路径、工作目录、`EXECUTE_*`、前置任务 | 直接进 git                                                                   |
| **OS 级**       | 脚本后缀、命令语法差异、平台专属工具                                 | 每个 OS 一份(macOS/Linux 默认,Windows 用 `win@` 前缀)                        |
| **机器 / 人级** | 本机绝对路径、本机 SDK 实例、envs 里的本机值                         | **不要写进 run config** —— 挪到 `.env`、仓库里的配置文件,或 IDE 的项目级设置 |

- **项目内的路径一律 `$PROJECT_DIR$`**(或它的子目录),不要写本机的绝对路径 —— 写死了别人 clone 下来就指到不存在的目录。
- **`SCRIPT_OPTIONS` 里传相对路径**,不要传绝对路径。
- **`envs` 只放不随机器变的东西**(`PYTHONUNBUFFERED=1` 这种);本机路径、端口、主机名、凭据一律不进。
- **命令本身要两边都跑得通**:`pnpm --filter x build` 两边都行;`./gradlew`、`rm -rf`、`set -a` 这类只在一个平台成立的,才值得分一份
  win@ 版本。
