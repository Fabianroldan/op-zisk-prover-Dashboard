#!/usr/bin/env bash
# SINGLE-INSTANCE refresh: pull Vast's live feed -> status.json -> push on change.
set -uo pipefail
cd /tmp/opzdash
LOCK=/tmp/opzdash-refresh.lock
exec 9>"$LOCK"; flock -n 9 || { echo "another refresh running; exit"; exit 0; }
while true; do
  if scp -P 25481 -o ConnectTimeout=15 -o BatchMode=yes root@79.117.60.197:/root/opzdash/feed.json /tmp/vast_feed.json 2>/dev/null; then
    # keep the feed's REAL source verbatim — never fake a "live proving" label
    cp /tmp/vast_feed.json status.json
    if ! git diff --quiet -- status.json; then
      git -c user.name="Abix" -c user.email="ayushbhadaur2319@gmail.com" commit -q -m "Refresh Vast proving status.json" -- status.json
      git push -q origin main 2>/dev/null && echo "$(date +%H:%M:%S) pushed update"
    fi
  fi
  sleep 60
done
