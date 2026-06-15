#!/usr/bin/env bash
# Self-healing SSH tunnel: localhost:8080 -> Vast:8080 (real-time feed.json).
LOCKDIR=/tmp/opzdash-tunnel.lock.d
mkdir "$LOCKDIR" 2>/dev/null || { echo "tunnel already running; exit"; exit 0; }
trap 'rmdir "$LOCKDIR" 2>/dev/null' EXIT INT TERM
while true; do
  ssh -N -p 25481 \
    -o ServerAliveInterval=10 -o ServerAliveCountMax=3 \
    -o ExitOnForwardFailure=yes -o ConnectTimeout=15 \
    -o BatchMode=yes -o StrictHostKeyChecking=no \
    -L 8080:localhost:8080 root@79.117.60.197
  echo "$(date +%H:%M:%S) tunnel dropped — reconnecting in 2s"
  sleep 2
done
