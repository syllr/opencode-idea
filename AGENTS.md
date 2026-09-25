# Agent Release Rules

## npm 版本发布规则

- npm 已发布的版本不可覆盖；同一个版本号不能再次发布不同内容。
- 每次发布前必须先递增版本号，并同步更新 `package.json`、`package-lock.json`、MCP `clientInfo.version` 和 `CHANGELOG.md`。
- 普通修复和兼容性更新只递增最后一位（patch）：`0.3.1 → 0.3.2 → 0.3.3`。
- 更新 minor 或 major 版本（例如 `0.3.x → 0.4.x` 或 `1.0.0`）前，必须先得到用户明确同意。
- 不使用 `--force` 或任何方式覆盖已发布版本；发布失败时保留旧版本，改用新版本号。
- 发布前运行 `npm test` 和 `npm publish --dry-run`；发布后验证 `npm view <package> dist-tags`，确认 `latest` 指向新版本。
- 当前发布基线：`0.3.1`。
