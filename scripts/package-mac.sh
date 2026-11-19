#!/usr/bin/env bash
# 打包「发票捕手」为 macOS .app 与 zip 分发包
#
# 需要：Node.js 18+、pnpm（首次先执行 `pnpm install`）
# 用法：
#   pnpm run package            # 按当前机器架构（Apple Silicon / Intel）
#   ARCH=x64 pnpm run package   # 强制指定架构
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

# pnpm 可能是带 shebang 的脚本，也可能是 .mjs，按类型调用
run_pnpm() {
  if [ -x "$PNPM" ] && [ "$(head -c 2 "$PNPM" 2>/dev/null)" = "#!" ]; then
    "$PNPM" "$@"
  else
    "$NODE" "$PNPM" "$@"
  fi
}

ELECTRON_VERSION="$("$NODE" -p "require('$ROOT/package.json').devDependencies.electron")"
VERSION="$("$NODE" -p "require('$ROOT/package.json').version")"

case "$(uname -m)" in
  arm64) HOST_ARCH="arm64" ;;
  *) HOST_ARCH="x64" ;;
esac
ARCH="${ARCH:-$HOST_ARCH}"

ZIP="$ROOT/vendor/electron-v${ELECTRON_VERSION}-darwin-${ARCH}.zip"
STAGE="$ROOT/dist/.stage"
OUT="$ROOT/dist/发票捕手-darwin-${ARCH}"
APP="$OUT/发票捕手.app"

if [ ! -f "$ZIP" ]; then
  mkdir -p "$ROOT/vendor"
  LOCAL_DIST="$ROOT/node_modules/electron/dist"
  if [ -d "$LOCAL_DIST/Electron.app" ] && [ "$(uname -m)" = "$ARCH" ]; then
    echo "→ 复用本地 Electron 运行时生成打包缓存"
    ( cd "$LOCAL_DIST" && ditto -c -k --sequesterRsrc --keepParent Electron.app "$ZIP" )
  else
    echo "→ 下载 Electron ${ELECTRON_VERSION} (${ARCH}) …"
    curl -fL --retry 5 --retry-delay 2 -o "$ZIP" \
      "https://npmmirror.com/mirrors/electron/${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-darwin-${ARCH}.zip"
  fi
fi

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

PACKAGER="$ROOT/node_modules/@electron/packager/bin/electron-packager.js"
if [ ! -f "$PACKAGER" ]; then
  echo "缺少 @electron/packager，请先运行 pnpm install" >&2
  exit 1
fi

echo "→ 生成 .app"
rm -rf "$OUT"
"$NODE" "$PACKAGER" "$STAGE" "发票捕手" \
  --platform=darwin \
  --arch="$ARCH" \
  --electron-version="$ELECTRON_VERSION" \
  --electron-zip-dir="$ROOT/vendor" \
  --out="$ROOT/dist" \
  --overwrite \
  --no-prune \
  --icon="$ROOT/build/icon.icns" \
  --app-bundle-id="com.jello.invoicecatcher" \
  --app-version="$VERSION" \
  --build-version="$VERSION" \
  --app-copyright="Copyright © 2026 Jello"

if [ -f "$ROOT/build/icon.icns" ]; then
  cp "$ROOT/build/icon.icns" "$APP/Contents/Resources/icon.icns"
  /usr/libexec/PlistBuddy -c "Set :CFBundleIconFile icon.icns" "$APP/Contents/Info.plist"
fi

echo "→ Ad-hoc 签名（未公证，首次打开需右键 → 打开）"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
codesign --verify --deep --strict "$APP" >/dev/null 2>&1 && echo "  签名校验通过" || echo "  警告：签名校验未通过"

echo "→ 压缩分发包"
ditto -c -k --keepParent "$APP" "$ROOT/dist/发票捕手-${VERSION}-macOS-${ARCH}.zip"

echo ""
echo "完成：$APP"
echo "分发包：$ROOT/dist/发票捕手-${VERSION}-macOS-${ARCH}.zip"
