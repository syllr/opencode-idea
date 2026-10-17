# Python(`PythonConfigurationType`)

**用途**:跑一个 Python 脚本(通常是服务入口)。**这个类型来自 Python 插件**(PyCharm 一定有,IDEA 装了 Python 插件也有)。

## 模板

```xml
<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="backend" type="PythonConfigurationType" factoryName="Python">
    <module name="my-project" />
    <option name="ENV_FILES" value="" />
    <option name="INTERPRETER_OPTIONS" value="" />
    <option name="PARENT_ENVS" value="true" />
    <envs>
      <env name="PYTHONUNBUFFERED" value="1" />
    </envs>
    <option name="SDK_HOME" value="" />
    <option name="SDK_NAME" value="my-project" />
    <option name="WORKING_DIRECTORY" value="$PROJECT_DIR$/backend/app" />
    <option name="IS_MODULE_SDK" value="false" />
    <option name="ADD_CONTENT_ROOTS" value="true" />
    <option name="ADD_SOURCE_ROOTS" value="true" />
    <option name="DEBUG_JUST_MY_CODE" value="false" />
    <option name="RUN_TOOL" value="" />
    <option name="SCRIPT_NAME" value="$PROJECT_DIR$/backend/app/main.py" />
    <option name="PARAMETERS" value="" />
    <option name="SHOW_COMMAND_LINE" value="false" />
    <option name="EMULATE_TERMINAL" value="false" />
    <option name="MODULE_MODE" value="false" />
    <option name="REDIRECT_INPUT" value="false" />
    <option name="INPUT_FILE" value="" />
    <method v="2" />
  </configuration>
</component>
```

## 字段

| 字段                                                                                                            | 含义                               | 怎么填                                                                          |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------- |
| `module name`                                                                                                   | 用哪个模块                         | **必须是这个项目里真实存在的模块名**,拿不准就问用户                             |
| `SCRIPT_NAME`                                                                                                   | 入口脚本                           | `$PROJECT_DIR$/…/main.py`                                                       |
| `PARAMETERS`                                                                                                    | 传给脚本的参数                     | 没有就空                                                                        |
| `WORKING_DIRECTORY`                                                                                             | 工作目录                           | `$PROJECT_DIR$/…`(实测指向 `backend/app` 这种应用目录)                          |
| `SDK_NAME` / `IS_MODULE_SDK` / `SDK_HOME`                                                                       | 用哪个解释器                       | `IS_MODULE_SDK=false` + `SDK_NAME` 填项目里配好的解释器名;本机路径写 `SDK_HOME` |
| `ENV_FILES`                                                                                                     | dotenv 文件                        | 没有就空                                                                        |
| `PARENT_ENVS`                                                                                                   | 继承父环境变量                     | `true`                                                                          |
| `envs` → `<env name value>`                                                                                     | 额外环境变量                       | 例如 `PYTHONUNBUFFERED=1`(让日志实时)                                           |
| `ADD_CONTENT_ROOTS` / `ADD_SOURCE_ROOTS`                                                                        | 把项目根 / 源码根加进 `PYTHONPATH` | `true`                                                                          |
| `DEBUG_JUST_MY_CODE`                                                                                            | 只断自己的代码                     | `false`                                                                         |
| `MODULE_MODE`                                                                                                   | 当模块跑(`python -m`)              | 一般 `false`                                                                    |
| `SHOW_COMMAND_LINE` / `EMULATE_TERMINAL` / `REDIRECT_INPUT` / `INPUT_FILE` / `INTERPRETER_OPTIONS` / `RUN_TOOL` | —                                  | 按实测默认值留空 / `false`                                                      |

## 坑

- **`module name` 与 `SDK_NAME` 必须是本项目真实的模块 / 解释器名** —— 写错 IDE 会用不了,但不一定立刻报错。**先查项目里已有的 Python 配置照抄**,查不到就问用户。
- 实测样本里带一个 `<EXTENSION ID="PythonCoverageRunConfigurationExtension" …/>`(覆盖率插件加的),**别抄**。
- 依赖装在哪决定能不能跑:走项目解释器 + `ADD_SOURCE_ROOTS`,不要指向本机某个 venv 的绝对路径。
- 服务类进程改代码后要重启才生效(没有热重载)—— 这条属于 `idea-standalone` 的纪律。
