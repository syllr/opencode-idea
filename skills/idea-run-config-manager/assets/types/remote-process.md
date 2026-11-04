# Remote Process (`RemoteProcess`)

**用途**：在远端 SSH 服务器上跑一条命令，并跟踪它的 PID。这是本项目里**唯一一种“跑在别的机器上”**的
run configuration —— 本地的 shell / maven / gradle 都不该用它。

> **它一定会启动进程。** 只想把文件同步到远端时，用 `remote_upload` / `remote_download`。
>
> **它不负责构建。** 需要编译 / 打包的应用，先在本地把产物做出来，它只把产物同步上去再启动。

两种 `kind`，字段要求不同：

| `kind` | 干什么 | 启动前会做什么 |
| --- | --- | --- |
| `process` | 在宿主机上起一个进程 | 先差量同步 `deployment`（overwrite），再 `cd workingDirectory && nohup <command>` |
| `docker` | `docker run` 一个容器 | 不同步文件；用 `container` 名判断容器是否已经在跑 |

`kind` 留空时按命令推断：`docker run …` → `docker`，其余 → `process`。**建议显式写**，不要靠猜。

## 字段：只有这 7 个

多写的字段会被**静默丢弃**，不报错。

| 字段 | 必填 | 含义 | 取值来源 |
| --- | --- | --- | --- |
| `server` | ✅ | IDE SSH 配置里的服务器名，**且必须在 `hosts.json` 里** | `hosts.json` 的 server `name` |
| `deployment` | `process` 必填 | 启动前要同步的 deployment 名 | 该 server 下 `deployments[].name` |
| `command` | ✅ | 远端要跑的命令 | 仓库里的启动脚本，或一条明确的命令 |
| `workingDirectory` | `process` 建议 | 远端 `cd` 的目标目录 | 一般就是 deployment 的 `deployPath` |
| `logDir` | 可选 | **应用自己写的日志目录**，仅用于查询；相对路径拼在 `workingDirectory` 后 | 应用配置里的 log 路径 |
| `kind` | 建议 | `process` / `docker` | —— |
| `container` | `docker` 必填 | 容器名，用于判断“是否已经在跑” | 与 `docker run --name` 一致 |

`logDir` **不是** stdout 的捕获位置 —— 输出由 IDE 自己记（`fullOutputPath`）。它只告诉工具
“应用自己的日志在哪”，用于 `list_remote_processes` 这类查询。

## XML 形状：process

```xml
<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="aidata-api@mbp" type="RemoteProcess" factoryName="RemoteProcess">
    <option name="server" value="mbp" />
    <option name="deployment" value="aidata-api" />
    <option name="kind" value="process" />
    <option name="command" value="/root/aidata-api/run.sh" />
    <option name="workingDirectory" value="/root/aidata-api" />
    <option name="logDir" value="logs" />
    <method v="2" />
  </configuration>
</component>
```

## XML 形状：docker

```xml
<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="redis@mbp" type="RemoteProcess" factoryName="RemoteProcess">
    <option name="server" value="mbp" />
    <option name="kind" value="docker" />
    <option name="container" value="aidata-redis" />
    <option name="command" value="docker run -d --name aidata-redis -p 6379:6379 redis:7-alpine" />
    <option name="logDir" value="/data/logs" />
    <method v="2" />
  </configuration>
</component>
```

`docker` 不需要 `deployment`，`workingDirectory` 也不参与启动。

## 已废弃字段：旧文件里见过，现在**没有**

早期版本的插件支持过 `compose`，现在代码里已经删干净。照抄旧文件会写出**被静默丢弃**的配置：

| 旧字段 | 现在 |
| --- | --- |
| `logSource` | 已删除，没有任何替代 |
| `service` / `composeFile` | 已删除，compose 不再支持 |
| `kind="compose"` | 不支持，只认 `process` / `docker` |
| `deployOnly` | 运行时一次性标记，**不持久化**，写进 XML 只会误导读者 |

`idea-mcp-testproject/.run/` 下的三个文件都是旧版产物，只能参考**骨架**（`component` / `configuration` /
`method`），字段必须按上表裁剪。

## 路径：不要用 IDE 宏

`workingDirectory` / `logDir` / `command` 都是**远端路径**，会原样传给远端 shell。

`$PROJECT_DIR$` / `$USER_HOME$` 这类 IDE 宏**不会被展开**（只有 deployment 的 `localPath` 和 SSH 的
`keyPath` 会展开）。`$USER_HOME$` 在远端语境里没有任何意义 —— 写它等于写了一个字面目录名。

- `workingDirectory` 写远端绝对路径（通常 = deployment 的 `deployPath`）
- `logDir` 可以相对 `workingDirectory`（`logs` → `<workingDirectory>/logs`），也可以写绝对路径

## 写完之后

按 [../../SKILL.md](../../SKILL.md) 的流程：先 `inspect` 看 `canRun` / `warnings`，再真跑一次。
Remote Process 的 run 会**同步 deployment 并在远端启动**，属于有副作用的操作 —— 触发条件见 SKILL.md 的红线。
