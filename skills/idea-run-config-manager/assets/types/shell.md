# Shell Script(`ShConfigurationType`)

**用途**:一条固定命令或一个脚本文件 —— 构建、打包、生成代码、跑迁移、同步某个环境的 DDL、起服务。**绝大多数"反复要跑的固定流程"都归它,先别换类型。**

## 二选一:脚本文本 / 脚本文件

| 形态               | 关键字段                                                              | 用在什么时候                            |
| ------------------ | --------------------------------------------------------------------- | --------------------------------------- |
| **脚本文本**(默认) | `EXECUTE_SCRIPT_FILE="false"` + `SCRIPT_TEXT` 有值 + `SCRIPT_PATH` 空 | 就一条命令,不需要单独脚本文件           |
| **脚本文件**       | `EXECUTE_SCRIPT_FILE="true"` + `SCRIPT_PATH` 有值 + `SCRIPT_TEXT` 空  | 命令已经写成仓库里的 `.sh`,或脚本比较长 |

## 模板:脚本文本形态

```xml
<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="db-migrate" type="ShConfigurationType" factoryName="Shell Script">
    <option name="SCRIPT_TEXT" value="pnpm -C packages/db generate&#10;pnpm -C packages/db migrate:deploy" />
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
    <envs />
    <method v="2" />
  </configuration>
</component>
```

## 模板:脚本文件形态

```xml
<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="go-server" type="ShConfigurationType" factoryName="Shell Script">
    <option name="SCRIPT_TEXT" value="" />
    <option name="INDEPENDENT_SCRIPT_PATH" value="true" />
    <option name="SCRIPT_PATH" value="$PROJECT_DIR$/go/run.sh" />
    <option name="SCRIPT_OPTIONS" value="" />
    <option name="INDEPENDENT_SCRIPT_WORKING_DIRECTORY" value="true" />
    <option name="SCRIPT_WORKING_DIRECTORY" value="$PROJECT_DIR$/go" />
    <option name="INDEPENDENT_INTERPRETER_PATH" value="true" />
    <option name="INTERPRETER_PATH" value="/bin/zsh" />
    <option name="INTERPRETER_OPTIONS" value="" />
    <option name="EXECUTE_IN_TERMINAL" value="false" />
    <option name="EXECUTE_SCRIPT_FILE" value="true" />
    <envs />
    <method v="2" />
  </configuration>
</component>
```

## 字段

| 字段                                                                                                | 含义                           | 怎么填                                                                                                                                        |
| --------------------------------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `SCRIPT_TEXT`                                                                                       | 要执行的命令                   | **多行用 `&#10;` 分隔**(实测这么存的),不要塞真实换行                                                                                          |
| `EXECUTE_SCRIPT_FILE`                                                                               | `false` 跑文本 / `true` 跑文件 | 决定上面两个字段谁生效                                                                                                                        |
| `SCRIPT_PATH`                                                                                       | 脚本路径                       | `$PROJECT_DIR$/...`                                                                                                                           |
| `SCRIPT_OPTIONS`                                                                                    | 传给脚本的参数                 | 没有就留空                                                                                                                                    |
| `SCRIPT_WORKING_DIRECTORY`                                                                          | 工作目录                       | `$PROJECT_DIR$` 或其子目录;留空 = 项目根                                                                                                      |
| `INDEPENDENT_SCRIPT_PATH` / `INDEPENDENT_SCRIPT_WORKING_DIRECTORY` / `INDEPENDENT_INTERPRETER_PATH` | 三处"各自独立"开关             | **保持实测值 `true`,别改**                                                                                                                    |
| `INTERPRETER_PATH`                                                                                  | 解释器                         | macOS/Linux:`/bin/zsh`、`/bin/bash`,或**留空用 IDE 默认**(实测留空也能跑);Windows:`C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe` |
| `INTERPRETER_OPTIONS`                                                                               | 解释器参数                     | 一般空                                                                                                                                        |
| `EXECUTE_IN_TERMINAL`                                                                               | 是否开终端跑                   | **`false`** —— 共享出去的配置不要依赖本机终端                                                                                                 |
| `envs`                                                                                              | 环境变量                       | 没有就 `<envs />`;有就 `<env name="K" value="V" />`                                                                                           |

## 坑

- **`EXECUTE_IN_TERMINAL` 必须是 `false`**:引导文本里"执行 Shell 配置要 `EXECUTE_IN_TERMINAL: false`"说的就是它,开成 true 的配置到了别人机器上行为不一样。
- **`INDEPENDENT_INTERPRETER_PATH` 实测有两种**:解释器填了绝对路径的用 `true`(老写法),Windows 相对写法的那两个文件是 `false`。**照抄同项目里已有的那个**,别自己换。
- Windows 解释器两种斜杠都实测出现过,`C:/...` 更稳(反斜杠在 XML 里要转义)。
- `factoryName` 可以省略(实测有省略也能被认),但同一项目里**跟着已有文件的写法**更一致。
- 文件里可以有 XML 注释说明这条配置实际跑的是什么(实测项目就这么写的),有助于后来的人看懂。
