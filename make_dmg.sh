#!/bin/bash
# 打包 DMG：./make_dmg.sh [版本号]
set -e
cd "$(dirname "$0")"

APP_NAME="SuperWorkStation"
VERSION="${1:-$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' native/Info.plist)}"
APP="build/$APP_NAME.app"
DIST="release"   # 不要放 dist：vite build 会清空 dist/

STAGE="$DIST/stage"
NAME="$APP_NAME-$VERSION"

[ -d "$APP" ] || ./build.sh

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
