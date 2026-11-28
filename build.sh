#!/bin/bash
set -e
cd "$(dirname "$0")"
APP="build/OneStation.app"
echo "==> building web assets"
if [ "$1" == "--dev" ]; then
  echo "   (skipping vite build, dev mode expects BNB_DEV_URL)"
else
  # 关键：vite 失败必须立刻中止。以前失败时 make_dmg 会静默打包旧 build 目录，
  # 结果发布出去的版本和源码不一致（0.9.13 就踩过）。
  if ! npx vite build --logLevel warn; then
    echo "!! vite build 失败，中止（不覆盖旧产物）" >&2
    exit 1
  fi
  if [ ! -f dist/index.html ]; then
    echo "!! dist/index.html 不存在，vite 产物异常" >&2
    exit 1
  fi
fi
echo "==> assembling bundle"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/web"
cp native/Info.plist "$APP/Contents/Info.plist"
[ -f native/AppIcon.icns ] && cp native/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
if [ -d dist ]; then cp -R dist/. "$APP/Contents/Resources/web/"; fi
[ -d samples ] && cp -R samples "$APP/Contents/Resources/samples"
if [ -d native/cosmos ]; then
  echo "   (bundling cosmos)"
  mkdir -p "$APP/Contents/Resources/cosmos"
  cp -R native/cosmos/. "$APP/Contents/Resources/cosmos/"
fi
echo "==> compiling swift"
swiftc -O -swift-version 5 -target arm64-apple-macos13.0 \
  -framework AppKit -framework WebKit -framework CryptoKit \
  -o "$APP/Contents/MacOS/OneStation" native/*.swift
echo "==> codesign (ad-hoc)"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
echo "==> done: $APP"

# 可选：构建完直接装到 /Applications（用户验证时不用手动拷）
if [ "$1" == "--install" ] || [ -n "$INSTALL_TO_APPLICATIONS" ]; then
  echo "==> 安装到 /Applications"
  /usr/bin/ditto "$APP" "/Applications/OneStation.app"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
    -f /Applications/OneStation.app >/dev/null 2>&1 || true
  echo "==> 已安装：/Applications/OneStation.app"
fi
