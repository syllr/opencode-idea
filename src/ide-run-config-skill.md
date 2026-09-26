# JetBrains Run Configuration 管理

本 skill 用于 **管理 JetBrains IDEA 的 run configuration (运行配置)**:创建、修改、删除、查看,并触发运行与调试。配置以 XML
文件形式存放在项目里,AI 通过读写这些文件完成管理,再用 IDE MCP 工具做校验和执行。

## 存放位置:只有 `.run/`

所有配置都写 **项目根 `.run/<name>.run.xml`**。这是 AI 唯一能可靠写入、且 IDEA 会 **即时加载**的位置。文件要不要提交到
git,由用户自己决定,AI 不代劳、也不必追问。

### 为什么不用 `.idea/`

- `.idea/workspace.xml` → `RunManager`:IDEA 的原生私有位置,但 **IDEA 是这份文件的主人** ——
  工作区状态缓存在内存里、保存时整体重写,还有"工作区恢复"机制会覆盖或还原外部改动。AI 写进去不可靠。
- `.idea/runConfigurations/*.xml`:这是 **2020.1 之前的共享位置**(不是私有位置),而且 `.idea` 常被 gitignore,反而更难共享。

用户已有的、存在 `.idea` 里的配置,AI 仍可 **读取和运行**(`idea_get_run_configurations` 能看到),只是不负责创建、修改或删除。

## 位置速查

这是 **事实参考**(IDEA 实际有三个位置),供识别用户已有配置用:

| 位置                                 | 谁在用                                     | AI 能否写                               |
|--------------------------------------|--------------------------------------------|-----------------------------------------|
| `.run/<name>.run.xml`(项目根)        | 2020.1+ 的项目级位置                       | 能写,IDEA 即时加载                      |
| `.idea/runConfigurations/*.xml`      | 2020.1 **之前**的共享位置;现在仍兼容读取   | 一般不动,老项目可沿用                   |
| `.idea/workspace.xml` → `RunManager` | **默认**位置(不勾 "Store as project file") | **不写**(会被 IDEA 覆盖);但能读取和运行 |

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

1. 不要凭空写 option 名。先找真实样本:
    - 用 `idea_search_file` 传 `q="**/*.run.xml"` 看项目里已有的配置。
    - 没有目标类型 → 请用户在 IDEA 里新建一个配置并勾选 "Store as project file",然后读生成的 XML 当模板。
    - 仍然没有 → 直接说明需要该类型的真实样本,不要猜 option 名。
2. 写完必须校验:
    - 在 `idea_get_run_configurations` 里能看到才算写对;看不到说明 `type` 写错了,改了重试。
    - 能看到不等于能跑:`idea_execute_run_configuration` 传 `configurationName` 实跑一次确认。
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
|------------|----------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------|
| Shell 脚本 | `ShConfigurationType`      | 内联脚本:`SCRIPT_TEXT` + `EXECUTE_SCRIPT_FILE=false`;脚本文件:`SCRIPT_PATH` + `EXECUTE_SCRIPT_FILE=true`;`INTERPRETER_PATH`;`SCRIPT_WORKING_DIRECTORY` |
| Java 应用  | `Application`              | `MAIN_CLASS_NAME`;`WORKING_DIRECTORY`;`PROGRAM_PARAMETERS`;`VM_PARAMETERS`                                                                             |
| JUnit      | `JUnit`                    | `TEST_OBJECT`;`MAIN_CLASS_NAME`;`WORKING_DIRECTORY`                                                                                                    |
| Gradle     | `GradleRunConfiguration`   | `ExternalProjectPath`;`TaskList`                                                                                                                       |
| npm        | `js.build_tools.npm`       | `package-json`;`command`;`scripts`                                                                                                                     |
| 串行流程   | `CompoundRunConfiguration` | `method` 里多个 `RunConfigurationTask`(带 `run_configuration_name` / `run_configuration_type`)                                                         |

## 命名

- 把 `name` 转成文件名:去掉 `/ \ : * ? " < > |` 等非法字符,写成 `.run/<净化后的名字>.run.xml`。
- 目标文件已存在时,先确认是要覆盖。

## 流程

1. `idea_search_file` 找 `**/*.run.xml` 样本。
2. 有同类样本 → 照它的结构改写;没有 → 请用户建一个。
3. `idea_create_new_file` 写 `.run/<name>.run.xml`。
4. `idea_get_run_configurations` 校验它出现。
5. `idea_execute_run_configuration` 实跑确认。
6. 修改用 `idea_apply_patch` 定向改 option;删除后确认它从列表里消失。
