# Node.js(`NodeJSConfigurationType`)

**用途**:直接跑一个 `.js` / `.mjs` 入口。**跑 `package.json` 脚本请用 [npm.md](npm.md)** —— 那是另一回事。

⚠️ **本模板验证程度有限**:`type` 与下面三个属性已由实物确认;**环境变量、Node 解释器等字段没有实物样本**,照抄本项目里已有配置的写法,或让用户在 IDE 里补,不要凭名字猜。

## 模板(已验证的最小形态)

```xml
<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="Drop metadb" type="NodeJSConfigurationType" path-to-js-file="$PROJECT_DIR$/packages/nocodb-legacy/src/run/deleteMetaDb.js" working-dir="$PROJECT_DIR$/packages/nocodb-legacy/src/run">
    <method v="2" />
  </configuration>
</component>
```

## 字段(已验证)

| 字段                     | 形态     | 含义                                |
| ------------------------ | -------- | ----------------------------------- |
| `path-to-js-file`        | **属性** | 入口 JS 文件,`$PROJECT_DIR$/…`      |
| `working-dir`            | **属性** | 工作目录                            |
| `application-parameters` | **属性** | 传给脚本的参数(实物里是 `dev` 这种) |
| `factoryName`            | 属性     | `Node.js`(实测有写、也有省略)       |

## 坑

- **这个类型用属性写法,不是 `<option>` 子元素** —— 照别的类型套会静默失效。
- **能不用它就不用**:绝大多数"跑前端/跑服务"的场景,`js.build_tools.npm`(`<command value="run">` + 脚本名)才是团队共享配置的主流写法,也更好懂。
- 需要环境变量(`dotenv`)或指定 Node 版本时,本模板没有可用字段 —— **照项目里已有的 Node.js 配置抄**,或让用户在 IDE 里配好再让你同步文档。
