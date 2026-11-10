#!/bin/bash
# 最小 e2e：把 JS 脚本丢进 dev.json，启动 app，等日志出现标记后退出
# 用法：scripts/e2e/run.sh scripts/e2e/smoke.js [超时秒数]
set -e
cd "$(dirname "$0")/../.."
SCRIPT="${1:?用法: run.sh <脚本.js> [超时秒数]}"
TIMEOUT="${2:-15}"
SCRIPT=$(cd "$(dirname "$SCRIPT")" && pwd)/$(basename "$SCRIPT")
SUPPORT="$HOME/Library/Application Support/SuperWorkStation"
LOG="$HOME/Library/Logs/SuperWorkStation.log"
mkdir -p "$SUPPORT"
killall SuperWorkStation 2>/dev/null || true
# 等旧实例真的退出，不然 open 只会把还在关闭的进程激活，脚本不会重跑
for _ in $(seq 1 25); do
  pgrep -x SuperWorkStation >/dev/null || break
  sleep 0.2
done
sleep 0.6
rm -f "$LOG"
printf '{"bnb_script":"%s"}' "$SCRIPT" > "$SUPPORT/dev.json"
open build/SuperWorkStation.app
for i in $(seq 1 "$TIMEOUT"); do
  sleep 1
  if grep -q "E2E DONE" "$LOG" 2>/dev/null; then
    rm -f "$SUPPORT/dev.json"
    echo "PASS"
    grep -E "E2E " "$LOG"
    exit 0
  fi
done
rm -f "$SUPPORT/dev.json"
echo "FAIL (timeout)"
tail -20 "$LOG" 2>/dev/null
exit 1
