# npm / yarn / pnpm (`js.build_tools.npm`)

**用途**:跑 `package.json` 里的脚本 (dev / build / test)。三种包管理器 **共用同一个 `type`**,靠 `<package-manager>` 区分。

## 模板

```xml

<component name="ProjectRunConfigurationManager">
    <configuration default="false" name="frontend" type="js.build_tools.npm">
        <package-json value="$PROJECT_DIR$/frontend/package.json"/>
        <command value="run"/>
        <scripts>
            <script value="dev"/>
        </scripts>
        <node-interpreter value="project"/>
        <package-manager value="npm"/>
        <envs/>
        <method v="2"/>
    </configuration>
</component>
```

## 字段

| 字段                         | 含义              | 怎么填                                                            |
| ---------------------------- | ----------------- | ----------------------------------------------------------------- |
| `package-json`               | 哪个 package.json | `$PROJECT_DIR$/子目录/package.json`                               |
| `command`                    | npm 子命令        | 跑脚本用 `run`                                                    |
| `scripts` → `<script value>` | 脚本名            | `package.json` 里 `scripts` 的 key(`dev` / `build` / `test:unit`) |
| `package-manager`            | 用哪个包管理器    | `npm` / `yarn` / `pnpm`(实测值就是这三个)                         |
| `node-interpreter`           | Node 来源         | `project`(用项目里配的);**不要填系统绝对路径**(机器级)            |
| `envs`                       | 环境变量          | 空就 `<envs />`                                                   |
| `method`                     | 前置任务          | 默认空 `<method v="2" />`;需要"先跑别的再跑这个"才填(见下)        |

## 跑之前先跑别的 (build → dev)

`<method v="2">` 里可以带前置任务:

```xml

<method v="2">
    <option name="NpmBeforeRunTask" enabled="true">
        <package-json value="$PROJECT_DIR$/package.json"/>
        <command value="run"/>
        <scripts>
            <script value="build"/>
        </scripts>
        <node-interpreter value="project"/>
        <envs/>
    </option>
</method>
```

## 坑

- **`<package-manager>` 决定实际用哪个包管理器跑**:项目用 pnpm 而这里写 `npm`,脚本里 `pnpm xxx` 的调用会跟外层打架。
- 实测文件里还出现过两个 `<EXTENSION>`(better_direnv、StartBrowser)—— 那是别人本机插件加的, **别抄**,它们依赖本机插件,别人机器上没有。
- 单仓多包 (pnpm workspace / npm workspaces):`package-json` 指到 **具体那个包**,不要指根再靠 scripts 转发。
- `scripts` 里写多个脚本 = 按顺序跑同一个命令,不等于"先 A 后 B";顺序依赖要用上面的前置任务。
