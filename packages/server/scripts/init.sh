#!/usr/bin/env bash
#
# Gemdex Server bootstrap — one command to stand up a BYOI backend with Docker.
#
# Generates the bearer token and Postgres password, writes packages/server/.env,
# brings up the Docker Compose stack (Postgres + pgvector + the server), waits
# for health, and prints the bearer token plus the exact client command to run.
#
# Usage:
#   npm run init                 # from packages/server (prompts for the Gemini key)
#   GEMINI_API_KEY=… npm run init  # non-interactive: key taken from the environment
#
set -euo pipefail

# Resolve packages/server regardless of where the script is invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SERVER_DIR"

ENV_FILE="$SERVER_DIR/.env"
PORT="${GEMDEX_SERVER_PORT:-8765}"

err() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
info() { printf '\033[36m%s\033[0m\n' "$*"; }
ok() { printf '\033[32m%s\033[0m\n' "$*"; }

# --- Preconditions ----------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
    err "docker is not installed or not on PATH. Install Docker Engine + Compose v2 first."
    exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
    err "'docker compose' (Compose v2) is required. Update Docker or install the compose plugin."
    exit 1
fi
if ! docker info >/dev/null 2>&1; then
    err "The Docker daemon is not running. Start Docker and re-run 'npm run init'."
    exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
    err "openssl is required to generate secrets. Install it and re-run."
    exit 1
fi

# --- Protect an existing deployment -----------------------------------------
if [ -f "$ENV_FILE" ]; then
    err "$ENV_FILE already exists. Refusing to overwrite an existing deployment's secrets."
    err "Delete it yourself if you intend to re-initialize, then re-run 'npm run init'."
    exit 1
fi

# --- Gemini API key ----------------------------------------------------------
GEMINI_KEY="${GEMINI_API_KEY:-}"
if [ -z "$GEMINI_KEY" ]; then
    # Read without echoing; the key is a secret.
    printf 'Google AI Studio API key (GEMINI_API_KEY): ' >&2
    read -rs GEMINI_KEY
    printf '\n' >&2
fi
if [ -z "$GEMINI_KEY" ]; then
    err "A GEMINI_API_KEY is required (the server owns embedding for all clients)."
    exit 1
fi

# --- Generate secrets + write .env ------------------------------------------
TOKEN="$(openssl rand -hex 32)"
PG_PASSWORD="$(openssl rand -hex 32)"

umask 077
cat > "$ENV_FILE" <<EOF
GEMDEX_SERVER_TOKEN=$TOKEN
GEMINI_API_KEY=$GEMINI_KEY
POSTGRES_PASSWORD=$PG_PASSWORD
GEMDEX_SERVER_PORT=$PORT
GEMDEX_SERVER_ALLOWED_ORIGINS=
EOF
chmod 600 "$ENV_FILE"
ok "Wrote $ENV_FILE (0600). Secrets generated; Gemini key stored."

# --- Bring up the stack ------------------------------------------------------
info "Building and starting the Docker Compose stack (this may take a minute on first run)…"
docker compose up -d --build

# --- Wait for health ---------------------------------------------------------
info "Waiting for the server to become healthy on http://127.0.0.1:$PORT …"
HEALTHY=0
for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1; then
        HEALTHY=1
        break
    fi
    sleep 2
done

if [ "$HEALTHY" -ne 1 ]; then
    err "Server did not become healthy in time. Inspect logs with:"
    err "  docker compose logs gemdex-server postgres"
    exit 1
fi
ok "Server is healthy."

# --- Report ------------------------------------------------------------------
cat <<EOF

$(ok "Gemdex Server is up.")

  Local URL:    http://127.0.0.1:$PORT
  Bearer token: $TOKEN

The server binds to 127.0.0.1 only. To reach it from other machines, put it on
a private network (e.g. Tailscale) or a TLS reverse proxy — never publish the
raw port. See docs/BYOI_OPERATIONS.md.

Connect a client (any machine that can reach the URL above), then point your
agent at it — no GEMINI_API_KEY needed on the client:

  npx -y gemdex-mcp@latest init-remote myserver <URL>
  # paste the bearer token above when prompted

EOF
