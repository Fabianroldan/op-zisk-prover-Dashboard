#!/usr/bin/env bash
# Refresh the dashboard's status.json from the live girona coordinator.
#
# Pulls /metrics over SSH, regenerates status.json through the poller's
# metrics parser, and commits+pushes ONLY when the data changed (no spam).
#
# Local low-frequency option: cron this every few minutes, e.g.
#   */5 * * * * /Users/abix/Downloads/deploy/refresh.sh >> /tmp/opzisk-dash.log 2>&1
#
# Proper live option (no git): run feed-poller.mjs --metrics ON the box and
# PUSH_CMD it to an R2/S3 bucket; point window.OPZISK_FEED_URL at that URL.
set -euo pipefail
cd "$(dirname "$0")"

SSH_HOST="${SSH_HOST:-girona-coord}"
METRICS_URL="${METRICS_URL:-http://localhost:9090/metrics}"

ssh -o ConnectTimeout=12 -o BatchMode=yes "$SSH_HOST" "curl -s -m 3 $METRICS_URL" \
  | node feed-poller.mjs --metrics-stdin

if ! git diff --quiet -- status.json; then
  git -c user.name="Abix" -c user.email="ayushbhadaur2319@gmail.com" \
    commit -q -m "Refresh coordinator status.json" -- status.json
  git push -q origin main
  echo "pushed updated status.json"
else
  echo "no change"
fi
