#!/bin/bash
# 跑全部 e2e
set -e
cd "$(dirname "$0")/../.."
fail=0
for f in scripts/e2e/*.js; do
  echo "▶ $(basename "$f")"
  ./scripts/e2e/run.sh "$f" 30 || fail=1
done
exit $fail
