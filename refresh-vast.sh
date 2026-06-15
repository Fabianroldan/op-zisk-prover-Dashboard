#!/usr/bin/env bash
# SINGLE-INSTANCE refresh: pull Vast's live feed -> status.json -> push on change.
set -uo pipefail
cd /Users/abix/.opzdash
LOCKDIR=/tmp/opzdash-refresh.lock.d
mkdir "$LOCKDIR" 2>/dev/null || { echo "another refresh running; exit"; exit 0; }
trap 'rmdir "$LOCKDIR" 2>/dev/null' EXIT INT TERM
while true; do
  if scp -P 25481 -o ConnectTimeout=15 -o BatchMode=yes root@79.117.60.197:/root/opzdash/feed.json /tmp/vast_feed.json 2>/dev/null; then
    cp /tmp/vast_feed.json status.json
    if ! git diff --quiet -- status.json; then
      git -c user.name="Abix" -c user.email="ayushbhadaur2319@gmail.com" commit -q -m "Refresh Vast proving status.json" -- status.json
      git push -q origin main 2>/dev/null && echo "$(date +%H:%M:%S) pushed update"
    fi
  fi
  sleep 60
done
