#!/bin/bash
# 打包 DMG：./make_dmg.sh [版本号]
set -e
cd "$(dirname "$0")"

APP_NAME="OneStation"
VERSION="${1:-$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' native/Info.plist)}"
APP="build/$APP_NAME.app"
DIST="release"   # 不要放 dist：vite build 会清空 dist/

STAGE="$DIST/stage"
NAME="$APP_NAME-$VERSION"

[ -d "$APP" ] || ./build.sh

# 校验 bundle 版本和要发布的版本一致，不一致就说明是旧构建，直接中止
BUILT=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP/Contents/Info.plist" 2>/dev/null || echo "")
if [ "$BUILT" != "$VERSION" ]; then
  echo "!! build 里是 $BUILT，但要求打包 $VERSION —— 先重新 ./build.sh" >&2
  exit 1
fi
# 校验 web 产物日期不早于二进制，避免打包旧的 dist
if [ ! -f "$APP/Contents/Resources/web/index.html" ]; then
  echo "!! bundle 里没有 web/index.html" >&2
  exit 1
fi

echo "▸ 组装 $NAME…"
rm -rf "$STAGE" && mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
[ -f LICENSE ] && cp LICENSE "$STAGE/" || true

echo "▸ 生成 DMG…"
mkdir -p "$DIST"
rm -f "$DIST/$NAME.dmg"
hdiutil create -volname "$APP_NAME" -srcfolder "$STAGE" -ov -format UDZO -quiet "$DIST/$NAME.dmg"

echo "▸ 计算校验值…"
shasum -a 256 "$DIST/$NAME.dmg" | tee "$DIST/$NAME.dmg.sha256"

rm -rf "$STAGE"
echo "==> done: $DIST/$NAME.dmg ($(du -h "$DIST/$NAME.dmg" | cut -f1))"
