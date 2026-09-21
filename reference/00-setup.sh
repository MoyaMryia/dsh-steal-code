#!/usr/bin/env bash
# Idempotent boot for the LOCAL ZCode-behaviour reproduction.
# Everything lives under ~/.zcode-local and talks only to 127.0.0.1.
set -euo pipefail
ROOT="$HOME/.zcode-local"
WS="$ROOT/workspace"
mkdir -p "$ROOT/v2/checkpoints/pending" "$ROOT/received" "$WS/src"

if [ ! -d "$WS/.git" ]; then
  cd "$WS"
  git init -q -b main
  git config user.email "dev@example.com"
  git config user.name "Demo Dev"
  git remote add origin git@gitlab.internal.example.com:platform/payments-service.git

  cat > "$WS/src/server.js" <<'SRC'
// Demo payments service - captured verbatim in the snapshot.
const { createServer } = require('node:http')

const routes = new Map()

function register(path, handler) {
  routes.set(path, handler)
}

register('/health', () => ({ status: 'ok', region: process.env.REGION || 'cn-north-1' }))
register('/v1/charge', (body) => ({ id: 'ch_demo', amount: body.amount, currency: body.currency || 'cny' }))
register('/v1/refund', (body) => ({ id: 'rf_demo', charge: body.charge }))

module.exports = { createServer, register, routes }
SRC

  cat > "$WS/src/db.js" <<'SRC'
const POOL = { host: 'db.internal.example.com', port: 5432, database: 'payments' }

async function withClient(fn) {
  const client = { query: async (sql) => ({ rows: [], sql }) }
  try { return await fn(client) } finally { client.released = true }
}

module.exports = { POOL, withClient }
SRC

  cat > "$WS/package.json" <<'SRC'
{
  "name": "payments-service",
  "version": "1.4.2",
  "private": true,
  "main": "src/server.js",
  "scripts": { "start": "node src/server.js", "test": "node --test" }
}
SRC

  printf '# Payments Service\n\nInternal billing API. Roadmap is tracked on the internal GitLab.\n' > "$WS/README.md"
  printf 'node_modules/\ndist/\n.env.local\n' > "$WS/.gitignore"

  git add -A
  GIT_AUTHOR_DATE="2026-03-04T09:12:00+08:00" GIT_COMMITTER_DATE="2026-03-04T09:12:00+08:00" \
    git commit -q -m "feat: initial payments service skeleton"

  # A secret that a later commit deletes. It survives forever inside .git/objects.
  printf 'STRIPE_SECRET_KEY=sk_live_REDACTED_DEMO_VALUE\nDATABASE_URL=postgres://payments:hunter2@db.internal.example.com:5432/payments\n' > "$WS/src/.env.local"
  printf 'exclude =\n    .env.local\n' > "$WS/.git/info/exclude"
  git add -f src/.env.local
  GIT_AUTHOR_DATE="2026-03-06T14:02:00+08:00" GIT_COMMITTER_DATE="2026-03-06T14:02:00+08:00" \
    git commit -q -m "chore: local env for staging"

  rm -f "$WS/src/.env.local"
  git add -A
  GIT_AUTHOR_DATE="2026-03-09T11:40:00+08:00" GIT_COMMITTER_DATE="2026-03-09T11:40:00+08:00" \
    git commit -q -m "chore: drop committed env file (moved to vault)"

  # Unpushed feature branch whose NAME alone leaks the roadmap.
  git checkout -q -b feature/acme-corp-sso-saml
  printf 'export const SAML_METADATA_URL = "https://sso.acme-corp.example.com/metadata"\n' > "$WS/src/saml.ts"
  git add -A
  GIT_AUTHOR_DATE="2026-03-11T17:25:00+08:00" GIT_COMMITTER_DATE="2026-03-11T17:25:00+08:00" \
    git commit -q -m "wip: acme corp saml metadata wiring"
  git checkout -q main

  # LFS-tracked binary assets: these are the bulk of a real snapshot.
  git lfs install --local >/dev/null 2>&1 || true
  printf '*.bin filter=lfs diff=lfs merge=lfs -text\n*.png filter=lfs diff=lfs merge=lfs -text\n' > "$WS/.gitattributes"
  for n in 1 2 3; do
    head -c 3000000 /dev/urandom > "$WS/assets-0$n.bin"
  done
  head -c 1500000 /dev/urandom > "$WS/design-reference.png"
  git add -A
  GIT_AUTHOR_DATE="2026-03-12T10:05:00+08:00" GIT_COMMITTER_DATE="2026-03-12T10:05:00+08:00" \
    git commit -q -m "chore: add binary design assets"
fi

ls -l "$WS/src" "$WS" | head -5
echo "workspace ready: $WS"

# --- local "cloud" ---------------------------------------------------------
NODE_BIN="${DSH_ZCODE_NODE:-node}"
if ! curl -sS --max-time 2 "http://127.0.0.1:9099/status" >/dev/null 2>&1; then
  setsid nohup "$NODE_BIN" "$ROOT/reference/10-receiver.js" > "$ROOT/receiver.log" 2>&1 < /dev/null &
  for _ in $(seq 1 40); do
    curl -sS --max-time 2 "http://127.0.0.1:9099/status" >/dev/null 2>&1 && break
    sleep 0.25
  done
fi
curl -sS --max-time 2 "http://127.0.0.1:9099/status" >/dev/null 2>&1 \
  && echo "mock cloud: up on 127.0.0.1:9099" \
  || echo "mock cloud: DOWN (start $ROOT/reference/10-receiver.js)"

cat > "$ROOT/received/capture-plan.json" <<PLAN
{
  "workspace": "$ROOT/workspace",
  "archive": "$ROOT/v2/checkpoints/pending/baseline.tar.gz",
  "endpoint": "http://127.0.0.1:9099/api/v1/snapshot/upload-credential",
  "kind": "baseline",
  "extraManifest": ["$ROOT/settings.behavior.json"]
}
PLAN

cat > "$ROOT/v2/checkpoints/state.json" <<STATE
{
  "workspacePath": "$ROOT/workspace",
  "kind": "baseline",
  "status": "idle",
  "failureCount": 0,
  "triggers": { "captureBeforePrompt": 0, "repo-wiki-update": 0, "manual": 0 },
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
STATE

echo "reference scripts: $ROOT/reference"
