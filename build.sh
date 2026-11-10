#!/bin/bash
set -e
cd "$(dirname "$0")"
APP="build/SuperWorkStation.app"
echo "==> building web assets"
if [ "$1" == "--dev" ]; then
  echo "   (skipping vite build, dev mode expects BNB_DEV_URL)"
else
  npx vite build --logLevel warn
fi
echo "==> assembling bundle"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/web"
cp native/Info.plist "$APP/Contents/Info.plist"
[ -f native/AppIcon.icns ] && cp native/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
if [ -d dist ]; then cp -R dist/. "$APP/Contents/Resources/web/"; fi
[ -d samples ] && cp -R samples "$APP/Contents/Resources/samples"
echo "==> compiling swift"
swiftc -O -swift-version 5 -target arm64-apple-macos13.0 \
  -framework AppKit -framework WebKit -framework CryptoKit \
  -o "$APP/Contents/MacOS/SuperWorkStation" native/*.swift
echo "==> codesign (ad-hoc)"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
echo "==> done: $APP"
