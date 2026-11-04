# Gradle (`GradleRunConfiguration`)

**用途**:跑 Gradle 任务 (`build`、`test`、`detekt`、`wasmJsBrowserDevelopmentRun` …)。

## XML 形状

```xml
<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="Build" type="GradleRunConfiguration" factoryName="Gradle">
    <ExternalSystemSettings>
      <option name="env">
        <map>
          <entry key="DEVELOPER_DIR" value="/Applications/Xcode.app/Contents/Developer" />
        </map>
      </option>
      <option name="executionName" />
      <option name="externalProjectPath" value="$PROJECT_DIR$" />
      <option name="externalSystemIdString" value="GRADLE" />
      <option name="scriptParameters" value="" />
      <option name="taskDescriptions">
        <list />
      </option>
      <option name="taskNames">
        <list>
          <option value="build" />
        </option>
      </option>
      <option name="vmOptions" />
    </ExternalSystemSettings>
    <ExternalSystemDebugServerProcess>true</ExternalSystemDebugServerProcess>
    <ExternalSystemReattachDebugProcess>true</ExternalSystemReattachDebugProcess>
    <DebugAllEnabled>false</DebugAllEnabled>
    <RunAsTest>false</RunAsTest>
    <method v="2" />
  </configuration>
</component>
```

## 字段

| 字段                                               | 含义            | 怎么填                                                                                      |
| -------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------- |
| `taskNames` → `<list>`                             | 要跑的任务      | 每个任务一个 `<option value="…" />`;`:module:task` 形式可跨模块                             |
| `scriptParameters`                                 | 参数            | 例如 `--stacktrace`;没有就留空                                                              |
| `externalProjectPath`                              | Gradle 项目路径 | `$PROJECT_DIR$`                                                                             |
| `externalSystemIdString`                           | 固定            | **`GRADLE`**,别改                                                                           |
| `env` → `<map>`                                    | 环境变量        | `<entry key="K" value="V" />`;没有就整个 `<option name="env" />` 去掉(实测两个文件都有保留) |
| `executionName` / `taskDescriptions` / `vmOptions` | —               | 没有就留空 / `<list />`                                                                     |
| `RunAsTest`                                        | 是否当测试跑    | 一般 `false`                                                                                |
| `DebugAllEnabled`                                  | —               | `false`                                                                                     |

## 坑

- **`externalSystemIdString` 必须是 `GRADLE`** —— 写别的值文件会被忽略 (而且没有报错)。
- 参数 (`--info`、`-Pxxx`)放 `scriptParameters`, **不是** `taskNames`。
- `env` 里像 `DEVELOPER_DIR` 这种本机特定路径,共享出去对别人无效 —— 换个不带绝对路径的做法 (写进 `gradle.properties`)。
- 多模块里跑别的模块的任务用 `:module:task`;`externalProjectPath` 仍指 Gradle 根。
