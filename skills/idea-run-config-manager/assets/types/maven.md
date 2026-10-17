# Maven(`MavenRunConfiguration`)

**用途**:跑 Maven 目标(`clean package`、`test`、`spring-boot:run` …)。

## 模板

```xml
<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="maven-package" type="MavenRunConfiguration" factoryName="Maven">
    <MavenSettings>
      <option name="myGeneralSettings" />
      <option name="myRunnerSettings" />
      <option name="myRunnerParameters">
        <MavenRunnerParameters>
          <option name="cmdOptions" />
          <option name="profiles">
            <set />
          </option>
          <option name="goals">
            <list>
              <option value="clean" />
              <option value="package" />
            </option>
          </option>
          <option name="multimoduleDir" />
          <option name="pomFileName" value="pom.xml" />
          <option name="profilesMap">
            <map />
          </option>
          <option name="projectsCmdOptionValues">
            <list />
          </option>
          <option name="resolveToWorkspace" value="false" />
          <option name="workingDirPath" value="$PROJECT_DIR$" />
        </MavenRunnerParameters>
      </option>
    </MavenSettings>
    <method v="2" />
  </configuration>
</component>
```

## 字段

| 字段                       | 含义           | 怎么填                                                 |
| -------------------------- | -------------- | ------------------------------------------------------ |
| `goals` → `<list>`         | 要跑的目标     | 每个目标一个 `<option value="…" />`,顺序就是命令行顺序 |
| `pomFileName`              | 哪个 pom       | 根项目 `pom.xml`;子模块填它自己的 pom 文件名           |
| `workingDirPath`           | 工作目录       | `$PROJECT_DIR$` 或其子目录(实测有直接指向子模块目录的) |
| `profiles` / `profilesMap` | Maven profile  | 不指定就保持 `<set />` / `<map />`                     |
| `cmdOptions`               | 额外命令行参数 | 例如 `-DskipTests`;没有就留空                          |
| `multimoduleDir`           | 多模块根目录   | 单模块留空                                             |
| `projectsCmdOptionValues`  | 项目级参数列表 | 一般 `<list />`                                        |
| `resolveToWorkspace`       | —              | 保持 `false`                                           |

## 坑

- **嵌套层级别少**:`MavenSettings` → `myRunnerParameters` → `MavenRunnerParameters`,三层都在才认;空的 `<set />` / `<map />` / `<list />` **不要删**(实测文件里都有)。
- `pomFileName` 只写**文件名**,不要写相对路径。
- 多模块项目:要么 `pomFileName` 指子模块,要么用 `multimoduleDir` 指根 —— 二选一,别都填。
- 跑测试类目标(`-Dtest=…`)时 `cmdOptions` 里带 `-D`,不要放进 `goals`。
