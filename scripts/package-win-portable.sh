#!/usr/bin/env bash
# 打包「发票捕手」为 Windows x64 免安装版（解压即用，无需安装）
#
# 在 macOS / Linux / Windows Git Bash 上都能运行，不需要 Wine。
# 需要：Node.js 18+、pnpm（首次先执行 `pnpm install`）
# 用法：
#   pnpm run package:win-portable
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

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

ELECTRON_VERSION="$("$NODE" -p "require('$ROOT/package.json').devDependencies.electron")"
VERSION="$("$NODE" -p "require('$ROOT/package.json').version")"
STAGE="$ROOT/dist/.stage"
OUT="$ROOT/dist-win-out/发票捕手-win32-x64"
ZIP="$ROOT/dist-win-out/invoice-catcher-${VERSION}-win-x64-portable.zip"

if [ ! -d "$STAGE/node_modules" ]; then
  echo "→ 准备运行依赖（生产环境、扁平 node_modules）"
  rm -rf "$STAGE"
  mkdir -p "$STAGE"
  cp "$ROOT/package.json" "$STAGE/package.json"
  cp -R "$ROOT/src" "$STAGE/src"
  cp "$ROOT/.npmrc" "$STAGE/.npmrc"
  (
    cd "$STAGE"
    run_pnpm install --prod --config.node-linker=hoisted --ignore-scripts --reporter=append-only
  )
  rm -rf "$STAGE/node_modules/.pnpm" "$STAGE/node_modules/.modules.yaml" "$STAGE/node_modules/.bin"
fi

PACKAGER="$ROOT/node_modules/@electron/packager/bin/electron-packager.js"
if [ ! -f "$PACKAGER" ]; then
  echo "缺少 @electron/packager，请先运行 pnpm install" >&2
  exit 1
fi

echo "→ 下载/打包 Windows 运行时 Electron ${ELECTRON_VERSION} (x64)"
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
mkdir -p "$ROOT/dist-win-out"
rm -rf "$OUT"
"$NODE" "$PACKAGER" "$STAGE" "发票捕手" \
  --platform=win32 \
  --arch=x64 \
  --electron-version="$ELECTRON_VERSION" \
  --out="$ROOT/dist-win-out" \
  --overwrite \
  --no-prune \
  --icon="$ROOT/build/icon.ico" \
  --app-version="$VERSION" \
  --build-version="$VERSION" \
  --app-copyright="Copyright © 2026 Jello"

echo "→ 压缩免安装包"
rm -f "$ZIP"
if command -v ditto >/dev/null 2>&1; then
  ( cd "$OUT" && ditto -c -k --sequesterRsrc --keepParent . "$ZIP" )
else
  ( cd "$OUT" && zip -ryq "$ZIP" . )
fi

echo ""
echo "完成：$OUT"
echo "免安装包：$ZIP"
