# Remote Process (`RemoteProcess`)

**用途**：在远端 SSH 服务器上跑一条命令，并跟踪它的 PID。这是本项目里**唯一一种“跑在别的机器上”**的
run configuration —— 本地的 shell / maven / gradle 都不该用它。

> **它一定会启动进程。** 只想把文件同步到远端时，用 `remote_upload` / `remote_download`。
>
> **它不负责构建。** 需要编译 / 打包的应用，构建挂在 **Before launch** 上（见下），它只把产物同步上去再启动。

`kind` 有两种，**一条配置只对应一个应用**：

| `kind`    | 干什么                          | 启动前会做什么                                                                       | 必填        |
|-----------|---------------------------------|--------------------------------------------------------------------------------------|-------------|
| `process` | 在宿主机上起**一个进程**        | 先把 `deployment` 同步上去（overwrite），再 `cd workingDirectory && nohup <command>` | `deployment` |
| `docker`  | 起**一个容器**（`docker run`）  | 不同步文件；用 `container` 名判断容器是否已经在跑                                    | `container` |

**一个 run configuration = 一个应用 = 一个进程 / 一个容器。** 多个应用就是多条配置。

`kind` 留空时按命令推断：`docker run …` → `docker`，其余 → `process`。

## 字段：只有这 7 个

多写的字段会被 **静默丢弃**，不报错。

| 字段               | 必填           | 含义                                                                     | 取值来源                            |
|--------------------|----------------|--------------------------------------------------------------------------|-------------------------------------|
| `server`           | ✅             | IDE SSH 配置里的服务器名，**且必须在 `hosts.json` 里**                   | `hosts.json` 的 server `name`       |
| `deployment`       | `process` 必填 | 启动前要同步的 deployment 名                                             | 该 server 下 `deployments[].name`   |
| `command`          | ✅             | 远端要跑的命令                                                           | 仓库里的启动脚本，或一条明确的命令  |
| `workingDirectory` | `process` 建议 | 远端 `cd` 的目标目录                                                     | 一般就是 deployment 的 `deployPath` |
| `logDir`           | 可选           | **应用自己写的日志目录**，仅用于查询；相对路径拼在 `workingDirectory` 后 | 应用配置里的 log 路径               |
| `kind`             | 建议           | `process` / `docker`                                                     | ——                                  |
| `container`        | `docker` 必填  | 容器名，用于判断“是否已经在跑”                                           | 与 `docker run --name` 一致         |

`logDir` **不是** stdout 的捕获位置 —— 输出由 IDE 自己记（`fullOutputPath`）。它只告诉工具
“应用自己的日志在哪”，用于 `list_remote_processes` 这类查询。

`workingDirectory` / `logDir` / `command` 都是**服务端路径**，写绝对路径 —— IDE 宏（`$PROJECT_DIR$` / `$USER_HOME$`）
不会在远端展开。本地路径的规则见 [../../SKILL.md](../../SKILL.md) 的「路径：本地 vs 服务端」。

## XML 形状：process

```xml

<component name="ProjectRunConfigurationManager">
    <configuration default="false" name="aidata-api@mbp" type="RemoteProcess" factoryName="RemoteProcess">
        <option name="server" value="mbp"/>
        <option name="deployment" value="aidata-api"/>
        <option name="kind" value="process"/>
        <option name="command" value="/root/aidata-api/run.sh"/>
        <option name="workingDirectory" value="/root/aidata-api"/>
        <option name="logDir" value="logs"/>
        <method v="2"/>
    </configuration>
</component>
```

## XML 形状：docker

```xml

<component name="ProjectRunConfigurationManager">
    <configuration default="false" name="redis@mbp" type="RemoteProcess" factoryName="RemoteProcess">
        <option name="server" value="mbp"/>
        <option name="kind" value="docker"/>
        <option name="container" value="aidata-redis"/>
        <option name="command" value="docker run -d --name aidata-redis -p 6379:6379 redis:7-alpine"/>
        <option name="logDir" value="/data/logs"/>
        <method v="2"/>
    </configuration>
</component>
```

`docker run` 不需要 `deployment`，`workingDirectory` 也不参与启动。

## `docker run` 的参数从哪来

**先读代码、再查机器、最后才问用户。** 每一步都有确定的信息来源，不要跳过前两步直接问。

**① 代码上下文**（仓库里就能读到）：

| 参数 | 从哪读 |
|---|---|
| `-p` 端口 | `Dockerfile` 的 `EXPOSE`、应用配置里的 `PORT`、`.env*`、`docker-compose.yml` 的 `ports` |
| `-v` 挂载 | 产物目录（deployment 的 `deployPath`）、配置文件、应用日志目录（同时写进 `logDir`） |
| `-e` 环境变量 | `.env.<环境>`、代码里的默认值、compose 的 `environment` |
| 镜像 | `Dockerfile` 所在目录、tag 约定、是否需要先本地 build 再传 |
| `--network` | compose 里的 `networks`、容器之间用什么主机名互相访问 |

**② 目标机器的现状**（`remote_exec` 直接查）：

```bash
docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'   # 已有的容器与占用的端口
docker network ls                                            # 可复用的网络
docker volume ls                                             # 已有的数据卷
lsof -nP -iTCP -sTCP:LISTEN                                  # 端口占用（macOS）
ss -tlnp                                                     # 端口占用（Linux）
df -h <deployPath>                                           # 磁盘余量
```

**③ 只剩真正拿不准的才问用户**，而且要把选项摊开：

- ❌ “docker 参数怎么配？”
- ✅ “6379 已经被 `aidata-redis-old` 占着，这条用 6380 还是先把旧的停掉？”

`container` 字段必须与 `--name` 逐字一致。

**重启策略（`--restart`）列出来问用户，不要自己定**：

| 取值 | 行为 |
|---|---|
| 不写（默认 `no`） | 不自动重启；进程退出就是退出，工具能如实报 `stopped` |
| `on-failure[:N]` | 非 0 退出才重启，可限次数 |
| `always` | 退出就重启（`docker stop` 和 `docker rm -f` 除外） |
| `unless-stopped` | 同 `always`，但 `docker stop` 之后保持停止 |

把四个选项连行为一起摊给用户选。**默认不写**，除非用户明确要求。

## Before launch：构建 + 铺产物

`process` 型配置几乎都有产物：先在本地构建，把结果铺到 deployment 的 `localPath`，再由 run 同步上去。
这一步挂在 `<method v="2">` 里， **不写进 `command`**：

```xml

<component name="ProjectRunConfigurationManager">
    <configuration default="false" name="aidata@mbp" type="RemoteProcess" factoryName="RemoteProcess">
        <option name="server" value="mbp"/>
        <option name="deployment" value="aidata-app"/>
        <option name="kind" value="process"/>
        <option name="command" value="node dist/server.js"/>
        <option name="workingDirectory" value="/Users/yutao/Desktop/data/aidata-platform/app"/>
        <method v="2">
            <option name="RunConfigurationTask" enabled="true"
                    run_configuration_name="aidata-build@mbp"
                    run_configuration_type="NodeJSConfigurationType"/>
        </method>
    </configuration>
</component>
```

- `run_configuration_name` 必须与那条 `.run/<名字>.run.xml` 的 `name` **逐字一致**，且 **带 `@env`**；
  一条部署链上的 build / deploy 用同一个 env。
- `run_configuration_type` 是 **被挂那条配置自己的类型 id**：node 构建填 `NodeJSConfigurationType`。
- 构建配置的产物要落到 **该 deployment 的 `localPath`** —— 那才是同步的源目录；落到别处等于没构建。
- 挂上没挂上，看 `ide_inspect_run_configuration` 的 `beforeRunTasks` 数量。
- 多个构建步骤就写多个 `RunConfigurationTask`， **按执行顺序排列**（IDE 从上到下跑）。

谁来构建（node 脚本的三条硬规矩）见 [node.md](node.md#构建脚本before-launch-用)。

## 常见错误（真实踩过）

| 写错的                                             | 为什么错                                                                                                                            | 正确写法                                                                 |
|----------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------|
| `workingDirectory="$USER_HOME$/Desktop/data/..."`  | 插件**不展开宏**，会 `cd` 到一个名字就叫 `$USER_HOME$` 的目录                                                                       | 写远端绝对路径 `/Users/yutao/Desktop/data/...`                           |
| 为了“少写绝对路径”把远端路径改成 `$PROJECT_DIR$/…` | `$PROJECT_DIR$` 是**本机**项目根，远端没有这个目录                                                                                  | 远端路径本来就该是绝对的                                                 |
| 把构建命令塞进 `command`                           | 构建在远端跑，而源码根本没上传                                                                                                      | 构建挂 Before launch（见上）                                             |
| Before launch 里挂的配置名少了 `@env`              | 同名的可能有多份，IDE 找不到或挂到别的环境                                                                                          | `{应用}-build@{env}`，env 与 deploy 一致                                 |
| 一条配置用 `docker compose up -d` 起多个容器       | 一条配置对应一个应用；`container` 只能写一个，compose 起来的那组容器状态查不到、Stop 也停不掉                                      | 每个应用一条配置，各用 `docker run -d --name <容器名> …`                 |
