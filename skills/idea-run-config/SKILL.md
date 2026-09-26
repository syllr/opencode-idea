---
name: idea-run-config
description: "管理 JetBrains IDE 的 run configuration:在项目级 `.run/*.run.xml` 里创建、修改、删除运行配置。当用户要新建运行配置、修改或删除已有配置、把脚本或执行流程包成可运行的配置,或让 AI 执行用户手配的配置时使用。只操作项目级 `.run/` 文件,不碰 `.idea/workspace.xml`。"
---

# JetBrains Run Configuration 管理

## 怎么操作:查询走 MCP,增删改走文件

| 动作                          | 手段                                                                      |
| ----------------------------- | ------------------------------------------------------------------------- |
| 查看有哪些配置 / 判断是否生效 | **MCP 工具** `idea_get_run_configurations`                                |
| 新增 / 修改 / 删除            | **直接操作文件** `.run/<name>.run.xml`                                    |
| 执行 / 调试                   | **MCP 工具** `idea_execute_run_configuration`                             |
| 找同类型样本                  | 只读 **`.run/`** 下的 `*.run.xml`(`idea_search_file` + `paths: [".run"]`) |

## 存放位置:只有 `.run/`

所有配置都写 **项目根 `.run/<name>.run.xml`**。

**只做项目级配置,不存在全局(IDE 级)配置** —— 所以永远不写 IDE 的全局配置目录,也不写 `.idea/workspace.xml`。

新建配置时 `.run/` 的结构:

```xml

<component name="ProjectRunConfigurationManager">
    <configuration default="false" name="<名字>" type="<类型 ID>">
        <option name="..." value="..."/>
        <envs/>
        <method v="2"/>
    </configuration>
</component>
```

## 铁律

1. 不要凭空写 option 名。先在 **`.run/` 里**找真实样本:
   - 用 `idea_search_file` 传 `q="*.run.xml"` + `paths: [".run"]` 看项目里已有的配置(**只看 `.run/`**,不去翻 `.idea/`)。
   - 没有目标类型 → 请用户在 IDEA 里新建一个配置,勾选 "Store as project file" 并**存到项目根的 `.run/`**,再读生成的 XML 当模板。
   - 仍然没有 → 直接说明需要该类型的真实样本,不要猜 option 名。
2. 写完必须校验:
   - **唯一判据**是 `idea_get_run_configurations` 里能看到它。**看不到就是错的** —— 不许用"应该生效了"结案。
   - 看不到的常见原因(按概率):`type` 不是 IDE 当前启用的类型(**IDEA 会静默忽略整个文件,日志里也不报**)、根 component 名写错、
     结构或 option 名不对。改掉重试。
   - 能看到不等于能跑:`idea_execute_run_configuration` 传 `configurationName` 实跑一次确认。Shell Script 必须
     `EXECUTE_IN_TERMINAL=false`,否则实跑直接失败(见"样本"一节)。
   - IDE MCP 不可用 → 提示用户执行 `/open-in-idea` 后再校验,不要跳过校验当成成功。
3. 改配置用定向修改:只用 `idea_apply_patch` 改需要的那几行 option,不要整文件重写。
4. 删除配置 = 删除对应的 `.run/<name>.run.xml`;不要试图从 `.idea/workspace.xml` 里删。

## 常见字段

- `$PROJECT_DIR$`:项目根;`$MODULE_WORKING_DIR$`:模块目录。
- 环境变量:

```xml

<envs>
    <env name="KEY" value="VALUE"/>
</envs>
```

- Before launch 流程:`<method v="2">` 里加 `Make` 选项会先构建。

## 起步参考 (不是契约;动手前一律以真实样本为准)

| 用途       | type                       | 关键 option                                                                                                                                            |
| ---------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shell 脚本 | `ShConfigurationType`      | 内联脚本:`SCRIPT_TEXT` + `EXECUTE_SCRIPT_FILE=false`;脚本文件:`SCRIPT_PATH` + `EXECUTE_SCRIPT_FILE=true`;`INTERPRETER_PATH`;`SCRIPT_WORKING_DIRECTORY` |
| Java 应用  | `Application`              | `MAIN_CLASS_NAME`;`WORKING_DIRECTORY`;`PROGRAM_PARAMETERS`;`VM_PARAMETERS`                                                                             |
| JUnit      | `JUnit`                    | `TEST_OBJECT`;`MAIN_CLASS_NAME`;`WORKING_DIRECTORY`                                                                                                    |
| Gradle     | `GradleRunConfiguration`   | `ExternalProjectPath`;`TaskList`                                                                                                                       |
| npm        | `js.build_tools.npm`       | `package-json`;`command`;`scripts`                                                                                                                     |
| 串行流程   | `CompoundRunConfiguration` | `method` 里多个 `RunConfigurationTask`(带 `run_configuration_name` / `run_configuration_type`)                                                         |

### 样本:Shell Script(IDEA 自己生成的 `.run/*.run.xml`)

```xml
<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="Unnamed" type="ShConfigurationType" nameIsGenerated="true">
    <option name="SCRIPT_TEXT" value="" />
    <option name="INDEPENDENT_SCRIPT_PATH" value="true" />
    <option name="SCRIPT_PATH" value="" />
    <option name="SCRIPT_OPTIONS" value="" />
    <option name="INDEPENDENT_SCRIPT_WORKING_DIRECTORY" value="true" />
    <option name="SCRIPT_WORKING_DIRECTORY" value="$PROJECT_DIR$" />
    <option name="INDEPENDENT_INTERPRETER_PATH" value="true" />
    <option name="INTERPRETER_PATH" value="/bin/zsh" />
    <option name="INTERPRETER_OPTIONS" value="" />
    <option name="EXECUTE_IN_TERMINAL" value="true" />
    <option name="EXECUTE_SCRIPT_FILE" value="true" />
    <envs />
    <method v="2" />
  </configuration>
</component>
```

要点:`INDEPENDENT_*` 三件套表示该字段**独立于模板**(true = 用本配置里的值)。**内联脚本**要 `EXECUTE_SCRIPT_FILE=false` 并填
`SCRIPT_TEXT`;**跑脚本文件**要 `EXECUTE_SCRIPT_FILE=true` 并填 `SCRIPT_PATH`(上面的样本是未配置的空模板,所以两处都是空串)。

AI 自己写的配置一律给 `EXECUTE_IN_TERMINAL=false`;用户已有的 `true` 配置要执行,先问要不要改。

## 命名

- 把 `name` 转成文件名:去掉 `/ \ : * ? " < > |` 等非法字符,写成 `.run/<净化后的名字>.run.xml`。
- 目标文件已存在时,先确认是要覆盖。

## 流程

1. **查现状**:`idea_get_run_configurations`(有哪些配置)。要找样本则在 `.run/` 里读 `*.run.xml`(限定 `paths: [".run"]`)。
2. **定结构**:有同类样本 → 照它的结构改写;没有 → 请用户在 IDEA 里建一个并**存到 `.run/`**;仍然没有 → 说明需要真实样本,
   不猜 option 名。
3. **写文件**:`idea_create_new_file` 写 `.run/<name>.run.xml`。
4. **校验(必做)**:`idea_get_run_configurations` 必须能看到它 —— 看不到就是错的,不许用"应该生效了"结案。
5. **实跑(必做)**:`idea_execute_run_configuration` 传 `configurationName` 确认能跑(Shell Script 必须
   `EXECUTE_IN_TERMINAL=false`)。
6. **改 / 删**:改 = `idea_apply_patch` 定向改 option,不要整文件重写;删 = 删除 `.run/<name>.run.xml`,再确认它从列表里消失。
