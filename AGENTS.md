# Agent Release Rules

## npm 版本发布规则

- 包名固定为 `opencode-idea`，不再使用旧包名 `opencode-jetbrains-mcp`。
- npm 已发布的版本不可覆盖；同一个版本号不能再次发布不同内容。
- 每次发布前必须先递增版本号，并同步更新 `package.json`、`package-lock.json`、MCP `clientInfo.version` 和 `CHANGELOG.md`。
- 只允许递增最小版本位（patch）：`0.0.1 → 0.0.2 → 0.0.3`，禁止跳号。
- 更新 minor 或 major 版本（例如 `0.0.x → 0.1.0` 或 `1.0.0`）前，必须先得到用户明确同意。
- 不使用 `--force` 或任何方式覆盖已发布版本；发布失败时保留旧版本，改用新版本号。
- 发布前运行 `npm test` 和 `npm publish --dry-run`；发布后验证 `npm view opencode-idea dist-tags`，确认 `latest` 指向新版本。
- 当前发布基线：`0.0.1`。

## 发布脚本

发布统一走 `scripts/release.mjs`，它会自动完成：递增 patch → 跳过 npm 上已存在的版本 → 同步四个文件 → `npm test` → 校验 git 干净 → `npm publish` → 校验 `dist-tags`。

| 命令                    | 作用                                                          |
| ----------------------- | ------------------------------------------------------------- |
| `npm run release`       | 完整发布：bump + test + publish + 校验 dist-tags              |
| `npm run release:dry`   | 只 bump + test + `npm publish --dry-run`，不真正发布          |
| `npm run release:bump`  | 只改版本和 CHANGELOG，不测试、不发布                          |
| `npm run release:check` | 只读检查：本地版本 vs npm `latest` / 已发布版本，不改任何文件 |

脚本强制的约束：

- 只递增 patch，不会自行做 minor / major；需要时人工改并先征得用户同意。
- 已发布到 npm 的版本号会被跳过，绝不覆盖。
- `src/idea-mcp.js` 中两处 `clientInfo.version` 必须与 `package.json` 一致，找不到会直接报错退出。
- 正式发布会先检查 `git status --porcelain` 必须干净；未提交就中止。

### 发布鉴权（重要）

npm 发布要求**带 2FA 的登录态**。以下情况一定会 403：

- `~/.npmrc` 里存在 `//registry.npmjs.org/:_authToken=npm_xxx`，且该 token 是「bypass 2FA」的 granular token。
- 此时 `npm login` 的登录态会被这行 token 覆盖，`--otp=xxxxxx` 也会被忽略，命令直接报 `Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages`。

正确做法：

1. 删除 bypass token：`npm config delete //registry.npmjs.org/:_authToken`
2. 确认已删除：`grep _authToken ~/.npmrc || echo "已删除"`
3. 重新登录：`npm login`
4. 再执行 `npm run release`

不要用 `--force`，也不要用 bypass token 覆盖已发布版本。
