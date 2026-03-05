#!/usr/bin/env bash
set -euo pipefail

# ── E2E runtime smoke test ──────────────────────────────────────────────────
# Usage: bash scripts/e2e-runtime.sh <node|bun>
#
# Boots the built gateway CLI under the given runtime, starts a mock upstream,
# and verifies basic HTTP behaviour (health, free proxy, 404).
# ────────────────────────────────────────────────────────────────────────────

RUNTIME="${1:?Usage: $0 <node|bun>}"
PASS=0
FAIL=0
PIDS=()

cleanup() {
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null || true; done
  rm -f /tmp/tollbooth-e2e.yml /tmp/e2e-upstream-port /tmp/e2e-gw.log
}
trap cleanup EXIT

# ── 1. Start mock upstream ──────────────────────────────────────────────────

rm -f /tmp/e2e-upstream-port
node -e "
  const http = require('node:http');
  const fs = require('node:fs');
  const s = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ method: req.method, path: req.url }));
  });
  s.listen(0, () => fs.writeFileSync('/tmp/e2e-upstream-port', String(s.address().port)));
" &
PIDS+=($!)

for _ in $(seq 1 20); do
  [ -f /tmp/e2e-upstream-port ] && break
  sleep 0.2
done
UPSTREAM_PORT=$(cat /tmp/e2e-upstream-port)
echo "==> Mock upstream on port $UPSTREAM_PORT"

# ── 2. Write minimal config ────────────────────────────────────────────────

# Pick a random high port for the gateway
GW_PORT=$((RANDOM % 10000 + 50000))

cat > /tmp/tollbooth-e2e.yml <<EOF
gateway:
  port: ${GW_PORT}

wallets:
  base-sepolia: "0xTestWallet"

accepts:
  - asset: USDC
    network: base-sepolia

defaults:
  price: "\$0.01"
  timeout: 60

facilitator: "http://localhost:19999"

upstreams:
  api:
    url: "http://localhost:${UPSTREAM_PORT}"

routes:
  "GET /free":
    upstream: api
    price: "\$0"
EOF

# ── 3. Start gateway ───────────────────────────────────────────────────────

"$RUNTIME" dist/cli.js start --config=/tmp/tollbooth-e2e.yml > /tmp/e2e-gw.log 2>&1 &
PIDS+=($!)

# Wait for gateway to be ready (up to 10s)
READY=""
for _ in $(seq 1 20); do
  sleep 0.5
  if curl -sf "http://localhost:${GW_PORT}/health" > /dev/null 2>&1; then
    READY=1
    break
  fi
done

if [ -z "$READY" ]; then
  echo "FAIL: Gateway did not start within 10s"
  cat /tmp/e2e-gw.log
  exit 1
fi

echo "==> Gateway ($RUNTIME) on port $GW_PORT"
BASE="http://localhost:${GW_PORT}"

# ── 4. Smoke tests ─────────────────────────────────────────────────────────

check() (
  # Run in a subshell so set -e doesn't kill the parent
  set +e
  local desc="$1" url="$2" expected_status="$3" body_pattern="${4:-}"
  local tmpfile
  tmpfile=$(mktemp)

  local status
  status=$(curl -s -o "$tmpfile" -w '%{http_code}' "$url")
  local body
  body=$(cat "$tmpfile" 2>/dev/null)
  rm -f "$tmpfile"

  if [ "$status" != "$expected_status" ]; then
    echo "  FAIL: $desc — expected $expected_status, got $status"
    exit 1
  fi

  if [ -n "$body_pattern" ] && ! echo "$body" | grep -q "$body_pattern"; then
    echo "  FAIL: $desc — body missing '$body_pattern': $body"
    exit 1
  fi

  echo "  PASS: $desc"
)

echo ""
echo "=== E2E smoke tests ($RUNTIME) ==="

TESTS=("GET /health returns 200|$BASE/health|200|\"status\":\"ok\""
       "GET /free proxies to upstream|$BASE/free|200|\"path\":\"/free\""
       "GET /nonexistent returns 404|$BASE/nonexistent|404|")

for t in "${TESTS[@]}"; do
  IFS='|' read -r desc url code pattern <<< "$t"
  if check "$desc" "$url" "$code" "$pattern"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
  fi
done

echo ""

# ── 5. Summary ──────────────────────────────────────────────────────────────

TOTAL=$((PASS + FAIL))
echo "Results: $PASS/$TOTAL passed"
[ "$FAIL" -gt 0 ] && { echo "FAILED"; exit 1; }
echo "OK"
