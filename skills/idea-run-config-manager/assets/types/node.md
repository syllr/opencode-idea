# Node.js (`NodeJSConfigurationType`)

**用途**:直接跑一个 `.js` / `.mjs` 入口。 **跑 `package.json` 脚本请用 [npm.md](npm.md)** —— 那是另一回事。

⚠️ **本模板验证程度有限**:`type` 与下面三个属性已由实物确认; **环境变量、Node 解释器等字段没有实物样本**
,照抄本项目里已有配置的写法,或让用户在 IDE 里补,不要凭名字猜。

## XML 形状 (已验证的最小形态)

```xml
<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="Drop metadb" type="NodeJSConfigurationType" path-to-js-file="$PROJECT_DIR$/packages/nocodb-legacy/src/run/deleteMetaDb.js" working-dir="$PROJECT_DIR$/packages/nocodb-legacy/src/run">
    <method v="2" />
  </configuration>
</component>
```

## 字段 (已验证)

| 字段                     | 形态     | 含义                                |
| ------------------------ | -------- | ----------------------------------- |
| `path-to-js-file`        | **属性** | 入口 JS 文件,`$PROJECT_DIR$/…`      |
| `working-dir`            | **属性** | 工作目录                            |
| `application-parameters` | **属性** | 传给脚本的参数(实物里是 `dev` 这种) |
| `factoryName`            | 属性     | `Node.js`(实测有写、也有省略)       |

## 构建脚本（Before launch 用）

部署型应用的构建步骤固定用这一类型：一条 `{应用}-build@{env}`（node），挂在 `{应用}@{env}` 的
Before launch 上（见 [remote-process.md](remote-process.md#before-launch构建--铺产物)）。脚本本身有三条硬规矩，
违反任何一条这条配置就只能在某台电脑上跑：

### 1. 一份代码在所有 OS 上跑，不判断平台

- 目标：同一份脚本在 macOS / Windows / Linux 上**行为完全一致**，代码里**不出现 `process.platform`**，
  也不为某个系统写分支（`if (win)` / `if (process.platform === 'win32')` 都不写）。
- 做法：需要的能力都用跨平台的 Node API —— 复制 `cp()`、递归删 `rm()`、建目录 `mkdir({recursive:true})`、
  读写 `readFile` / `writeFile`；**不要** spawn `cp` / `rm` / `xcopy` / `rsync`，也不要拼 `&&` 的 shell 命令。
- 路径一律 `path.join` / `path.resolve`，不要手写 `/` 或 `\\`。
- 如果某个动作只能在某个平台上做，**换实现**，而不是加一条平台分支 —— 加了分支就不是“所有 OS 都一样”了。

### 2. 参数只走 argv，不读环境变量

- 用 `process.argv`（或 `util.parseArgs`）取参数，**不要读 `process.env`** —— 环境变量在 IDE 里是隐式的，
  配置文件与脚本对不上时没人看得见。
- 不同环境的输出目录不同 → 写进**这条配置的** `application-parameters`，不要让脚本猜。
  同一个脚本服务两个环境，就是两条配置、只有参数不同：

  ```xml
  <configuration default="false" name="aidata-build@mbp" type="NodeJSConfigurationType"
                 path-to-js-file="$PROJECT_DIR$/scripts/deploy-build.mjs" working-dir="$PROJECT_DIR$"
                 application-parameters="--out docs/deployment/mbp/app">
    <method v="2" />
  </configuration>
  ```

  ```xml
  <configuration default="false" name="aidata-build@handwrite" type="NodeJSConfigurationType"
                 path-to-js-file="$PROJECT_DIR$/scripts/deploy-build.mjs" working-dir="$PROJECT_DIR$"
                 application-parameters="--out docs/deployment/handwrite/app">
    <method v="2" />
  </configuration>
  ```

  脚本侧只解析参数，不认识“环境”这个概念：

  ```js
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  if (outIndex === -1 || !args[outIndex + 1]) {
    console.error('缺少 --out <目录>');
    process.exit(1);
  }
  const outDir = path.resolve(args[outIndex + 1]);
  ```

  反面写法：配置里塞 `DEPLOY_ENV=mbp` 环境变量，脚本里 `if (env === 'mbp') out = 'docs/deployment/mbp/app'` ——
  环境变量在 IDE 界面里是隐式配置，换台机器/换个人就丢；看 `.run` 文件也看不出这条到底输出到哪。
- 参数缺失就**报错退出（非 0）**，不要 fallback 到某个默认目录 —— 静默落到错的地方比直接崩更糟。
- 产物必须落到 deployment 的 `localPath`，否则同步上去的还是旧文件。

### 3. 配置名带 `@env`

名字是 `{应用}-build@{env}`，**文件名和 XML 的 `name` 两处相同**：

```
.run/aidata-build@mbp.run.xml         <configuration name="aidata-build@mbp" …>
.run/aidata-build@handwrite.run.xml   <configuration name="aidata-build@handwrite" …>
```

- `@` 前面是应用名；同应用有多条配置时加用途后缀（构建固定叫 `-build`）。`@` 后面是**部署到哪台远端服务器**
  （`hosts.json` 里的 server 名）。
  本机跑的配置不写 `@env` —— 脚本本来就要求跨 OS 一致，一份配置在哪台电脑上都一样。
- 它必须和所服务的 `{应用}@{env}` 用**同一个 env** —— Before launch 是按名字找配置的，
  env 不一致就会挂到别的环境上，或者根本找不到。
- **一条配置只服务一个 env**：两个环境就是两条配置，各带各的 `application-parameters`。

## 坑

- **这个类型用属性写法,不是 `<option>` 子元素** —— 照别的类型套会静默失效。
- **能不用它就不用**:绝大多数"跑前端/跑服务"的场景,`js.build_tools.npm`(`<command value="run">` + 脚本名)
  才是团队共享配置的主流写法,也更好懂。**例外:部署型应用的构建步骤固定用它** —— 见上面「构建脚本」一节。
- 需要环境变量 (`dotenv`)或指定 Node 版本时,本模板没有可用字段 —— **照项目里已有的 Node.js 配置抄**,或让用户在 IDE
  里配好再让你同步文档。
