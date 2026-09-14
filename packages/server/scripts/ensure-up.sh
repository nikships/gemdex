#!/usr/bin/env bash
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# Wait for docker/colima
for i in $(seq 1 90); do
  if docker info >/dev/null 2>&1; then break; fi
  # try start colima if present
  if command -v colima >/dev/null 2>&1; then
    colima status >/dev/null 2>&1 || colima start >/dev/null 2>&1 || true
  fi
  sleep 2
done
docker context use colima >/dev/null 2>&1 || true
cd /Users/nikhilanand/gemdex/packages/server
docker compose up -d
# Named Docker volumes are root-owned; the server process is uid 10001 (gemdex).
# Without this, file-blob attachments (Option C transcripts) fail with EACCES.
for i in $(seq 1 30); do
  if docker compose exec -T gemdex-server true >/dev/null 2>&1; then
    docker compose exec -u 0 -T gemdex-server \
      chown -R 10001:10001 /var/lib/gemdex/blobs >/dev/null 2>&1 || true
    break
  fi
  sleep 1
done
# wait health
for i in $(seq 1 60); do
  curl -sf http://127.0.0.1:8765/v1/health >/dev/null && exit 0
  sleep 1
done
exit 1
