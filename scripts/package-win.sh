#!/usr/bin/env bash
# 构建 Windows x64 NSIS 安装包
#
# 需要：Node.js 18+、pnpm（首次先执行 `pnpm install`）
# 建议在 Windows 上原生执行；在 macOS / Linux 上交叉构建时，通常还需要安装 Wine。
set -euo pipefail
cd "$(dirname "$0")/.."

NODE="${NODE_BIN:-$(command -v node 2>/dev/null || true)}"
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "找不到 Node，请安装 Node.js 18+，或用 NODE_BIN 指定路径" >&2
  exit 1
fi
PNPM="${PNPM_BIN:-$(command -v pnpm 2>/dev/null || true)}"
if [ -z "$PNPM" ]; then
  echo "找不到 pnpm，请安装（npm i -g pnpm），或用 PNPM_BIN 指定路径" >&2
  exit 1
fi

run_pnpm() {
  if [ -x "$PNPM" ] && [ "$(head -c 2 "$PNPM" 2>/dev/null)" = "#!" ]; then
    "$PNPM" "$@"
  else
    "$NODE" "$PNPM" "$@"
  fi
}

if [ ! -d node_modules/electron-builder ]; then
  echo "→ 安装依赖 ..."
  run_pnpm install
fi

rm -rf dist-win
# 镜像可用环境变量覆盖；未设置时默认使用 npmmirror，国内下载更稳
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"
# 不做代码签名：安装时 SmartScreen 会提示「未知发布者」
export CSC_IDENTITY_AUTO_DISCOVERY=false
export WIN_CSC_LINK=""

echo "→ 构建 Windows 安装包 ..."
run_pnpm exec electron-builder --win nsis --x64

echo ""
echo "完成：$(pwd)/dist-win"
ls -lh dist-win/*.exe 2>/dev/null || true
