#!/bin/sh
# Render benchmark of a stored session in headless Chrome.
# usage: sh test/bench.sh <session dir> <session id> <name> [tab title substring]
C="/c/Program Files/Google/Chrome/Application/chrome.exe"
U="${CHROME_PROFILE:-$TEMP/claude-panel-chrome-profile}"
BENCH=1 node .test/harness.mjs "$1" "$2" "${4:-}" ".test/harness/$3.html" >/dev/null || exit 1
D="$(pwd -W)/.test/harness"
timeout 180 "$C" --headless=new --user-data-dir="$U" --disable-gpu --no-first-run --allow-file-access-from-files \
  --window-size=1000,1250 --virtual-time-budget=90000 --dump-dom "file:///$D/$3.html" 2>/dev/null |
  grep -o 'id="perf"[^<]*' | sed 's/.*none">//'
