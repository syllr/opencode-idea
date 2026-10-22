# Agent Rules

## 测试规则

**只测代码流程，不测文档文字。**

- **该测**：函数跑出来的结果、数据契约（`Skill.Info` 的键、schema 的形状）、结构关系
  （哪些工具被点名、哪一节出不出、返回什么）、命令返回给用户的那一句话。
- **不该测**：某句话在不在某个 markdown 里、skill 文档里每条标题和每行示例长什么样、README 的措辞。
  文档归人 review，测试只管代码。

所以不要为了「保险」给一段提示词或一份 skill 文档加断言 —— 那种断言既脆又没用，改一次文案就红一片。

另外：

- **同类变体合并成一条**。同一个场景换个错误措辞的多个用例，合成一条；对称的逻辑（比如两组能力探测）
  用表驱动共用一套。
- **一条测试盯一个契约**。断言多不等于覆盖好。
- 加了新工具、新能力、新文案，都**不用**去补断言。

## 发布规则

发布统一走 `scripts/release.mjs`（`npm run release`），它会自动完成：递增 patch → 跳过 npm 上已存在的版本 →
同步三个文件 → `npm test` → 校验 git 干净 → `npm publish` → 校验 `dist-tags`。

| 命令                    | 作用                                                          |
| ----------------------- | ------------------------------------------------------------- |
| `npm run release`       | 完整发布：bump + test + publish + 校验 dist-tags              |
| `npm run release:dry`   | 只 bump + test + `npm publish --dry-run`，不真正发布          |
| `npm run release:bump`  | 只改版本，不测试、不发布                                      |
| `npm run release:check` | 只读检查：本地版本 vs npm `latest` / 已发布版本，不改任何文件 |

约束（脚本会强制前几条，剩下的靠自觉）：

- **永远只递增 patch**（`0.0.1 → 0.0.2 → 0.0.3`），禁止跳号。**minor / major 一律不升** —— 除非用户在
  那一次任务里明确要求，否则版本号只动最后一位。脚本本身也只做 patch；`0.0.27 → 0.1.0` 是用户明确破例的一次。
- **已发布到 npm 的版本号不可覆盖**：脚本会跳过 npm 上已存在的版本。发布失败时保留旧版本，改用新版本号；
  绝不用 `--force`。
- **三个文件的版本号必须一致**：`package.json`、`package-lock.json`、`src/mcp/idea.js` 里的
  `clientInfo.version`。一个都匹配不上时脚本直接报错退出。
- 正式发布会先检查 `git status --porcelain` 必须干净；未提交就中止。
- 包名固定为 `opencode-idea`，不再使用旧包名 `opencode-jetbrains-mcp`。
- 本地改动跑 `npm test` 验证（发布脚本也会跑一遍）。

## 发布鉴权（重要）

**优先直接用 `~/.npmrc` 里的 token 发布，不要 `npm login`。**

`~/.npmrc` 中的 `//registry.npmjs.org/:_authToken=npm_xxx` 就是**可用的发布凭据**，发布时直接读它即可，不需要、也不应该再跑 `npm login`：

```bash
grep _authToken ~/.npmrc                                    # 有 token 就直接发
npm whoami --registry=https://registry.npmjs.org            # 确认身份正常（如 shenyuanlaolarou）
npm run release                                             # bump + test + publish + 校验 dist-tags
```

- 该 token 必须是**带 bypass 2FA 的 granular token**（在有 2FA 的账号上，这是能非交互发布的凭据）。
- 不要用 `npm login` 覆盖它：登录态会盖掉 token，或让凭据来源变得不确定。
- **不要擅自删除这行 token**。它一旦被删，登录态也随之失效（`ENEEDAUTH`），反而要重新手工配置，把一个能发的环境改坏。
- **`npm whoami` 必须带 `--registry=https://registry.npmjs.org`。** token 是按 registry 挂的（`//registry.npmjs.org/:_authToken`），而本机 `~/.npmrc` 的 `registry=` 可能指向镜像（如 `registry.npmmirror.com`）—— 不带 `--registry` 时 whoami 问的是镜像，必然回 `ENEEDAUTH`。**那条 `ENEEDAUTH` 只说明问错了 registry，不说明 token 不能用**，别据此重建 token。
- **往哪发/查哪，都不依赖本机 `registry=`**：`package.json` 的 `publishConfig.registry` 固定了 publish 目标，`scripts/release.mjs` 的版本与 dist-tags 检查也显式查同一个 registry。所以 `~/.npmrc` 用镜像不影响发布，也不用每次手加 `npm_config_registry=...`。
- 若确实要临时改一次：`npm_config_registry=https://registry.npmjs.org npm run release`（只影响这一次调用，不动本机配置）。

只有出现下面这条 403 时，才说明凭据本身有问题（token 缺失、被撤销、权限不含该包、或没开 bypass 2FA）：

```
Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.
```

此时的处理顺序：

1. 先确认 token 是否还在：`grep _authToken ~/.npmrc`
2. 不在 → 让用户在 npm 生成**带 bypass 2FA** 的 granular token（对该包 Read and write），再写入 `~/.npmrc`（本机配置变更，需用户授权）
3. 在但仍 403 → 让用户检查该 token 的权限与 bypass 2FA 开关，必要时重建 token

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
