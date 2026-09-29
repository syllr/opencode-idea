# Agent Release Rules

## npm 版本发布规则

- 包名固定为 `opencode-idea`，不再使用旧包名 `opencode-jetbrains-mcp`。
- npm 已发布的版本不可覆盖；同一个版本号不能再次发布不同内容。
- 每次发布前必须先递增版本号，并同步更新 `package.json`、`package-lock.json`、MCP `clientInfo.version`。
- 只允许递增最小版本位（patch）：`0.0.1 → 0.0.2 → 0.0.3`，禁止跳号。
- 更新 minor 或 major 版本（例如 `0.0.x → 0.1.0` 或 `1.0.0`）前，必须先得到用户明确同意。
- 不使用 `--force` 或任何方式覆盖已发布版本；发布失败时保留旧版本，改用新版本号。
- 发布前运行 `npm test` 和 `npm publish --dry-run`；发布后验证 `npm view opencode-idea dist-tags`，确认 `latest` 指向新版本。

## 发布脚本

发布统一走 `scripts/release.mjs`，它会自动完成：递增 patch → 跳过 npm 上已存在的版本 → 同步三个文件 → `npm test` → 校验 git 干净 → `npm publish` → 校验 `dist-tags`。

| 命令                    | 作用                                                          |
| ----------------------- | ------------------------------------------------------------- |
| `npm run release`       | 完整发布：bump + test + publish + 校验 dist-tags              |
| `npm run release:dry`   | 只 bump + test + `npm publish --dry-run`，不真正发布          |
| `npm run release:bump`  | 只改版本，不测试、不发布                                      |
| `npm run release:check` | 只读检查：本地版本 vs npm `latest` / 已发布版本，不改任何文件 |

脚本强制的约束：

- 只递增 patch，不会自行做 minor / major；需要时人工改并先征得用户同意。
- 已发布到 npm 的版本号会被跳过，绝不覆盖。
- `src/mcp/idea.js` 中两处 `clientInfo.version` 必须与 `package.json` 一致，找不到会直接报错退出。
- 正式发布会先检查 `git status --porcelain` 必须干净；未提交就中止。

### 发布鉴权（重要）

**优先直接用 `~/.npmrc` 里的 token 发布，不要 `npm login`。**

`~/.npmrc` 中的 `//registry.npmjs.org/:_authToken=npm_xxx` 就是**可用的发布凭据**，发布时直接读它即可，不需要、也不应该再跑 `npm login`：

```bash
grep _authToken ~/.npmrc          # 有 token 就直接发
npm whoami                        # 确认身份正常（如 shenyuanlaolarou）
npm publish                       # 或 npm run release
```

- 该 token 必须是**带 bypass 2FA 的 granular token**（在有 2FA 的账号上，这是能非交互发布的凭据）。
- 不要用 `npm login` 覆盖它：登录态会盖掉 token，或让凭据来源变得不确定。
- **不要擅自删除这行 token**。它一旦被删，登录态也随之失效（`ENEEDAUTH`），反而要重新手工配置，把一个能发的环境改坏。

只有出现下面这条 403 时，才说明凭据本身有问题（token 缺失、被撤销、权限不含该包、或没开 bypass 2FA）：

```
Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.
```

此时的处理顺序：

1. 先确认 token 是否还在：`grep _authToken ~/.npmrc`
2. 不在 → 让用户在 npm 生成**带 bypass 2FA** 的 granular token（对该包 Read and write），再写入 `~/.npmrc`（本机配置变更，需用户授权）
3. 在但仍 403 → 让用户检查该 token 的权限与 bypass 2FA 开关，必要时重建 token

不要用 `--force`，也不要用 token 覆盖已发布版本。

### 发布结果校验的坑

`npm publish` 返回 `202` 是**接受并异步处理**，版本会先进入 **staged** 状态，`dist-tags` 与 `versions` 可能几分钟后才更新。所以：

- 刚发布后查不到新版本，**不等于失败**，先轮询等一会儿再判断。
- 此时若重复 `npm publish`，会收到 `409 Cannot publish over previously staged version "x.y.z"` —— 这条**恰恰证明前一次已经提交成功**，不是新错误。
- 校验方法：

```bash
for i in {1..6}; do
  latest=$(npm view opencode-idea dist-tags.latest)
  [ "$latest" = "<新版本>" ] && break
  sleep 20
done
```
