---
name: remote-deployment
description: "管理远程部署映射：`.opencode/remote-shell/hosts.json` 的 server / deployment、IDE Deployment 面板的同步与遗留清理、以及 deployment 与 `RemoteProcess` 配置的对应关系。新增 / 修改 / 删除同步目录、排查「IDE 里没有 deployment」「localPath 报错」、审计遗留 server / deployment、或在配置 RemoteProcess 前确认 deployment 时使用。发布 / 回滚 / 环境说明书走项目自己的部署 skill（如 deploy-ops），本 skill 只管映射与连线。"
---

# remote-deployment — hosts.json 与 IDE Deployment 的连线

一句话：**`.opencode/remote-shell/hosts.json` 是 deployment 的唯一事实源**。IDE 的 Deployment 面板是它的投影，
`.run` 里的 `RemoteProcess` 是消费方。三者对不上时，按本 skill 的顺序修，不要靠猜。

## 边界

只管三件事：

- `hosts.json` 里 server / deployment 的新增、修改、删除
- IDE Deployment 面板的同步结果与历史遗留（`orphaned` / `kept`）
- deployment 与 `RemoteProcess` 配置的对应关系与变更影响面

**不管**：

- 发布 / 回滚 / 环境说明书 → 项目自己的部署 skill（如 `deploy-ops`）
- `.run/*.run.xml` 的写法、运行档案 → `idea-run-config-manager`
- 项目根 `AGENTS.md` 的宪法块 → `project-scaffold`
- 多容器编排（compose build + up -d）不在「一条配置 = 一个进程 / 容器」的 RemoteProcess 模型里：
  按项目发布文档走 `remote_upload` + `remote_exec`，不要硬塞成一条配置

## 事实源

| 事实 | 唯一来源 | 怎么读 |
| --- | --- | --- |
| 服务器连接信息（host / 端口 / 账号 / 凭据） | IDE 的 SSH Configurations | `remote_list_servers` 的 `[IDE]`；`/remote-config-sync` 会写回 hosts.json |
| deployment 名与两端路径 | 项目 `hosts.json` | `remote_list_servers`；`assets/hosts.mjs audit` |
| IDE 里实际存在的 deployment | IDE 的 Deployment 面板 | `/remote-config-sync` 的 `created / updated / orphaned`；列表里的 `[已同步到 IDE]` |
| 哪个配置用哪条 deployment | `.run/*.run.xml` | `ide_inspect_run_configuration` 的 `options.deployment` |
| 进程 / 容器是否在跑 | IDE / 远端 | `ide_list_remote_processes`（`status` / `pid` / `container`） |

**不要**把 hosts.json 的内容再抄进 AGENTS.md 或另建清单：那份副本一定会漂移。

## 规则

1. 项目级 `localPath` **必须相对项目根**（`.` 表示项目根），不能是绝对路径，不能用 `~` 表示家目录，
   也不能含任何 `..` 段。
   **只允许 `/` 分隔符**（`apps/agent-server`）；`apps\agent-server` 直接报错，Windows 也一样 ——
   插件、IDE 与 `hosts.json` 脚本都会拒绝。
2. `deployPath` 是**远端绝对路径**（`/srv/app`）；相对路径会被 SFTP 当成 SSH 用户的家目录，插件与 IDE 都会拒绝。
   不能是 `/` 本身，也不能含 `..`（否则会被静默归一成别的目录）。
   IDE 宏（`$PROJECT_DIR$` / `$USER_HOME$`）在远端不会展开。
3. `exclude` 只接受路径前缀或精确文件（`node_modules`、`target`、`logs/app.log`），**不支持 `*` / `?`**。
   server 级 `exclude` 作用于该机器所有 deployment，deployment 级叠加在它之上；两者都会合并进 IDE 的 Deployment 面板。
4. deployment 名**全局唯一**：不同 server 上也不能重名；运行时会在列表里报冲突，`remote_upload` 拒绝猜测。
5. `RemoteProcess` 引用的 `server` 必须**同时存在**于 IDE 的 SSH 配置和 `hosts.json`；
   只做 `remote_exec` / `remote_upload` / `remote_download` 时，`hosts.json` 里有连接信息就够了。
6. 远端目录、服务器、凭据都要**问用户**，不要从代码或目录名猜。

项目级 `hosts.json` 的 deployment 会推到 IDE；**全局 `~/.config/remote-shell/hosts.json` 的 deployment
不会推 IDE**，只参与本机的 `remote_*`，列表里标 `[全局，不推 IDE]`。需要 IDE Deployment 面板/RemoteProcess
使用时，把它放到项目级配置里。

## 四条流程

下面用 `$SKILL_DIR` 表示本 skill 所在目录（加载 skill 时给出），`$PROJECT` 表示项目根。
不确定目录时用 `glob` 找 `**/skills/remote-deployment/assets/hosts.mjs`（通常装在
`~/.cache/opencode/npm/opencode-idea*/node_modules/opencode-idea/skills/remote-deployment`）。

### A. 新增 / 修改一条 deployment

1. `remote_list_servers` 看现状。列表顶部的 `⚠`、条目后的 `[未推到 IDE：…]` 就是当前真相，先修它们。
2. 跑只读审计，确认没有会挡住推送的问题：

   ```bash
   node "$SKILL_DIR/assets/hosts.mjs" audit --project "$PROJECT"
   ```

3. 写入（脚本只动这一条，保留同 server 的其它 deployment 和其它 server）：

   ```bash
   node "$SKILL_DIR/assets/hosts.mjs" upsert --project "$PROJECT" \
     --server mbp --name my-app \
     --local-path apps/my-app --deploy-path /srv/my-app \
     --exclude node_modules,logs
   ```

   server 不存在时脚本会报错并列出候选 —— 先在 `hosts.json` 补 server 条目（或让用户在 IDE 里加 SSH 配置
   后跑 `/remote-config-sync`），**不要**自己编 host 或凭据。

4. 让改动生效：下一次工具调用会自动对账；要立刻确认就让用户跑 `/remote-config-sync`。
5. `remote_list_servers` 确认这一条后面出现 `[已同步到 IDE]`。仍是 `[未推到 IDE：…]` 就按原因修，
   不要重复推送掩盖错误。
6. 如果已有 `RemoteProcess` 引用它（改名 / 改路径），交棒 `idea-run-config-manager` 重新 `inspect`
   并更新运行档案。

### B. 只要同步文件

不建 `RemoteProcess`，直接用 `remote_upload` / `remote_download`。`remote_upload` 不启动任何进程；
一次同步只传「大小或修改时间变了」的文件。

- `remote_upload`：目标远端目录不存在会自动创建；**本地源目录不存在**时报告「未做任何修改」，不报成 SSH 失败。
- `remote_download`：本地目标目录不存在会自动创建并拉取；**远端源目录不存在**时报告「未做任何修改」，
  绝不会在 `mirror` 下删本地文件。

### C. 从零到部署

1. **确认 server**：`remote_list_servers` 里有这台机器，且 `hosts.json` 里也有同名条目。
2. **确认 deployment**：按流程 A 建好，并在列表里看到 `[已同步到 IDE]`。
3. **建 RemoteProcess 配置**：加载 `idea-run-config-manager` skill，按它的 remote-process 模板写
   `.run/<app>@<env>.run.xml`；`server` 用 IDE 的 SSH 配置名，`deployment` 用第 2 步那条。
4. **静态检查**：`ide_inspect_run_configuration`，确认 `typeKnown` / `canRun` / `warnings` / `beforeRunTasks`。
5. **部署**：`ide_deploy_remote_process`。它会先差量同步 deployment，再在远端启动。
   发布型配置的 Stop 只关日志、不 kill 远端；已在运行会直接替换。**远程配置必须用户当场授权才触发。**

### D. 审计与历史维护

先跑 `assets/hosts.mjs audit`，再对照 IDE 侧的事实。遗留分八种，处理方式不同：

| 遗留 | 从哪看 | 处理 |
| --- | --- | --- |
| `hosts.json` 里的 deployment 已无应用使用 | 读文件 + 查引用它的 `RemoteProcess` | 先确认无引用，再 `remove`；**必须用户同意** |
| IDE Deployment 面板有、`hosts.json` 没有（`orphaned`） | `/remote-config-sync` / 同步结果 | **只报告，不自动删**；需要时让用户在 IDE 的 Deployment 面板手工删 |
| `hosts.json` 有、IDE 没有（`kept` server） | 同步结果 | 报告；确认是项目独有还是 IDE 已删，不要自动补 |
| 整台 server 已废弃 | 上面两处 + 是否还有 deployments | **不提供脚本删除**（它带凭据）：先删光 deployments，再让用户手工删条目 |
| `RemoteProcess` 引用不存在的 deployment（`status: invalid`） | `ide_list_remote_processes` | **先改 / 删配置**（交棒 `idea-run-config-manager`），再动 deployment |
| 项目级 `localPath` 是绝对路径 | `audit` / 列表里的 `⚠` / 同步报错 | 改成相对路径；不提供“自动纠偏” |
| `localPath` 里写了 `\` | `audit` / `upsert` / 插件报错 | 改成 `/`；Windows 也一样 |
| `localPath` 用了 `~` | `audit` / `upsert` / 插件报错 | 改成相对项目根的路径 |

**改名 / 删除的顺序固定**，反过来会让 IDE 里出现 `invalid` 配置：

1. 找出所有引用：`ide_get_run_configurations` 逐个 `inspect` 看 `options.deployment`，或查运行档案
2. 先改 / 删这些配置（`idea-run-config-manager`）
3. 再改 / 删 `hosts.json` 里的 deployment
4. 最后处理 IDE Deployment 面板的遗留（让用户手工删；同步永不删除）

**不要为了让 `orphaned` 消失，把废弃条目加回 `hosts.json`** —— 那是把历史垃圾固化下来。

## 故障对照

| 看到什么 | 原因 | 改哪里 |
| --- | --- | --- |
| `localPath 必须是相对项目根目录的路径` | 项目级写了绝对路径 | hosts.json 改成相对路径 |
| `deployPath 必须是绝对路径`（或远端同步到奇怪目录） | 写了相对路径 / `..` / IDE 宏 | 改成远端绝对路径（`/srv/app`） |
| `exclude 不支持通配符` | 写了 `*` / `?` | 改成目录前缀或精确文件 |
| `ide_list_remote_processes` 返回「项目里还没有 Remote Process 配置」 | 项目里一条都没建 | 按流程 C 建，不是“部署用不上” |
| `ide_list_remote_processes` 返回「没有匹配的…（过滤条件没命中）」 | `name` / `server` 过滤写错 | 去掉过滤或改成实际名字 |
| `remote_list_servers` 里没有这台机器 | IDE 与 hosts.json 都没有 | 让用户在 IDE 加 SSH 配置，或补 hosts.json（含凭据） |
| deployment 在列表里但 IDE 里没有 | 没推成功 / 没触发对账 | 看 `[未推到 IDE]` 与 `⚠`，修完跑 `/remote-config-sync` |
| IDE 里有旧 deployment | 同步只增改不删 | 在 IDE Deployment 面板手工删（`orphaned` 会报告） |
| 配置列表里 `canRun: false` | server / deployment / command 缺一项 | 按 `inspect` 的 `warnings` 补齐 |

## 脚本速查

`assets/hosts.mjs` 只改 hosts.json，不连远端、不碰凭据、不删 IDE 侧配置（`$SKILL_DIR` = 本 skill 目录，`$PROJECT` = 项目根）：

```bash
node "$SKILL_DIR/assets/hosts.mjs" audit  --project "$PROJECT" [--json]
node "$SKILL_DIR/assets/hosts.mjs" upsert --project "$PROJECT" --server <name> --name <deployment> \
  --local-path <相对路径> --deploy-path <远端绝对路径> [--exclude a,b]
node "$SKILL_DIR/assets/hosts.mjs" remove --project "$PROJECT" --name <deployment> [--server <name>] --yes
```

- `audit`：只读；有 error 时退出码 1
- `upsert`：按 `--name` 原地更新，保留未提到的字段；server 不存在直接报错
- `remove`：必须 `--yes`；只删 hosts.json 里的条目
