#!/usr/bin/env bash
# publish.sh — 一键发布 opencode-jetbrains-mcp 到 npm 官方 registry
#
# token 通过环境变量传入,不写入 .npmrc / shell 历史:
#   NPM_TOKEN=npm_xxxxxxxxxxxxxxxxxx ./scripts/publish.sh
#
# 生成 token: npmjs.com → Access Tokens → Generate New Token
#   - 选 "Granular Access Token"
#   - 勾选 "Bypass two-factor authentication (2FA)"
#   - Packages: Read and write,范围 opencode-jetbrains-mcp
#
# 说明:
#   npm 优先级 --registry 参数 > .npmrc > 默认,所以脚本强制走官方 registry,
#   不会碰用户 ~/.npmrc 里的镜像或旧 token。

set -euo pipefail

if [ -z "${NPM_TOKEN:-}" ]; then
  echo "错误: NPM_TOKEN 环境变量未设置" >&2
  echo "用法: NPM_TOKEN=npm_xxxxxxxxxxxxxxxxxx ./scripts/publish.sh" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

echo "[1/3] 跑测试..."
npm test

echo ""
echo "[2/3] npm pack --dry-run (确认文件清单)..."
npm pack --dry-run

echo ""
echo "[3/3] npm publish ..."
env NPM_TOKEN="$NPM_TOKEN" npm publish --registry https://registry.npmjs.org

echo ""
echo "✅ publish 完成"
