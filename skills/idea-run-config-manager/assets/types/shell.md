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

## 环境 / 平台差异

**本机配置不写 `@env`**（`@env` 只属于部署型配置，见 [remote-process.md](remote-process.md)）。同一条 shell 配置要在
Mac / Linux / Windows 上用，就把命令本身写成三边都能跑的；**不要为平台差异建第二份配置**，老的 `win@base` 写法已废弃。

命令确实只能在某一个平台成立（`./gradlew`、`rm -rf`、PowerShell 语法）时，先想办法换成跨平台写法；换不了才
单独起一个 base，并把平台写进名字（`build-win`），同时在档案的 `说明` 里写清“只在 Windows 上跑”。

建完之后确认两件事：

- **名字与实际行为一致**：名字里的平台 / 环境段和它真正跑的地方对得上；
- **它真的生效了**（应用启动日志里通常有一行“已加载配置 <名字>”之类）。

## 坑

- **`EXECUTE_IN_TERMINAL` 必须是 `false`**:引导文本里"执行 Shell 配置要 `EXECUTE_IN_TERMINAL: false`"说的就是它,开成
  true 的配置到了别人机器上行为不一样。
- **解释器是用户 / IDE 级的配置,新建时不要配、不要碰** —— 留空即默认 (实测:这三个字段整个不写,IDE
  一样认、一样跑,文件也不会被它改回去)。它属于每个用户自己那份设置,写进共享的配置只会给别人的机器添麻烦。
- **别为“解释器不同”去建第二份**:要不要分平台,只看 **命令本身**在两个 OS 上能不能跑。
- `factoryName` 可以省略 (实测有省略也能被认),但同一项目里 **跟着已有文件的写法**更一致。
- 文件里可以有 XML 注释说明这条配置实际跑的是什么 (实测项目就这么写的),有助于后来的人看懂。

## 跨机器共享 (配置进 git 给全组用)

按"绑在哪一层"分三档,建配置前对着过一遍:

| 档              | 内容                                                                 | 跨机器怎么办                                                                 |
| --------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **项目级**      | 配置名、`SCRIPT_TEXT`、仓库内的路径、工作目录、`EXECUTE_*`、前置任务 | 直接进 git                                                                   |
| **平台相关**    | 命令写法差异、平台专属工具                                            | **优先换成跨平台写法**；实在不行才单独起一个 base 并在名字里标平台           |
| **机器 / 人级** | 本机绝对路径、本机 SDK 实例、envs 里的本机值                         | **不要写进 run config** —— 挪到 `.env`、仓库里的配置文件,或 IDE 的项目级设置 |

- **`SCRIPT_OPTIONS` 里传相对路径**,不要传绝对路径。
- **`envs` 只放不随机器变的东西**(`PYTHONUNBUFFERED=1` 这种);本机路径、端口、主机名、凭据一律不进。
- **命令本身要两边都跑得通**:`pnpm --filter x build` 两边都行;`./gradlew`、`rm -rf`、`set -a` 这类只在一个平台成立的,
  先想办法换成跨平台写法,换不了才单独起一个 base 并把平台写进名字(见上文)。
