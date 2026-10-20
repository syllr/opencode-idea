# Go Build (`GoApplicationRunConfiguration`)

**用途**:跑一个 Go 程序 (`go run` 那条路)。测试是另一个类型 (`GoTestRunConfiguration`), **不在本模板范围**。

## XML 形状

```xml
<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="Server" type="GoApplicationRunConfiguration" factoryName="Go Application">
    <module name="my-project" />
    <working_directory value="$PROJECT_DIR$" />
    <parameters value="--config ./_local/server/config.yaml" />
    <envs>
      <env name="ARMADA_LOG_CONFIG" value="config/logging-dev.yaml" />
    </envs>
    <kind value="FILE" />
    <package value="github.com/owner/my-project" />
    <directory value="$PROJECT_DIR$" />
    <filePath value="$PROJECT_DIR$/cmd/server/main.go" />
    <method v="2" />
  </configuration>
</component>
```

## 字段

| 字段                        | 含义                | 怎么填                                                                  |
| --------------------------- | ------------------- | ----------------------------------------------------------------------- |
| `module name`               | Go 模块             | 本项目真实的模块名                                                      |
| `kind`                      | 跑什么              | `FILE`(文件)/ `DIRECTORY`(目录)/ `PACKAGE`(包)—— **和下面三个字段配套** |
| `filePath`                  | `kind=FILE` 时      | 入口文件路径                                                            |
| `directory`                 | `kind=DIRECTORY` 时 | 目录                                                                    |
| `package`                   | `kind=PACKAGE` 时   | 包路径(实测样本里同时填了 `package`,可留)                               |
| `working_directory`         | 工作目录            | `$PROJECT_DIR$`                                                         |
| `parameters`                | 传给程序的参数      | 例如 `--config ./_local/server/config.yaml`                             |
| `envs` → `<env name value>` | 环境变量            | 没有就整块删掉                                                          |

## 坑

- **字段写法和其他类型不一样**:这里是 `<working_directory value=…>` 这种 **自定义元素名**,不是 `<option name=…>`
  ;照别的类型的写法套会被静默忽略。
- **`kind` 与 `filePath`/`directory`/`package` 必须一致**:填了 `kind=FILE` 又给 `directory`,行为不可预期 —— 只填对应的那一个。
- `parameters` 里是 **给程序**的参数,不是 `go build` 的参数;构建参数走 IDE 的 Go 配置项,别塞这里。
- 实测样本的 `envs` 里塞了本机路径 (`localhost:6379` 之类)—— 共享出去对别人不一定适用,这类值考虑换成读本地配置文件。
- Go 服务通常是常驻进程:启停走 `rerun` / `stop`,不要 `pkill`(规则见 `idea-standalone`)。
