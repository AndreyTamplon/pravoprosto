#!/usr/bin/env bash
# =============================================================================
# SmartGo School — Start all services for E2E testing
#
# Creates a fresh database, starts mock servers and backend.
# Press Ctrl+C to stop everything.
#
# Usage:
#   chmod +x e2e/start.sh
#   ./e2e/start.sh
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$PROJECT_DIR/backend"

# Postgres connection for creating the database
PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5432}"
PG_USER="${PG_USER:-postgres}"
PG_PASSWORD="${PG_PASSWORD:-postgres}"
DB_NAME="${DB_NAME:-pravoprost_e2e}"

MOCK_SSO_PORT="${MOCK_SSO_PORT:-8091}"
MOCK_LLM_PORT="${MOCK_LLM_PORT:-8090}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[+]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }

# ---------------------------------------------------------------------------
# 1. Create fresh database
# ---------------------------------------------------------------------------

info "Creating database $DB_NAME (dropping if exists)..."
PGPASSWORD="$PG_PASSWORD" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d postgres -q -c "
  SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB_NAME';
" 2>/dev/null || true
PGPASSWORD="$PG_PASSWORD" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME;" 2>/dev/null
PGPASSWORD="$PG_PASSWORD" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d postgres -q -c "CREATE DATABASE $DB_NAME;"
info "Database $DB_NAME created."

# ---------------------------------------------------------------------------
# 2. Export environment
# ---------------------------------------------------------------------------

MOCK_SSO_URL="http://localhost:${MOCK_SSO_PORT}"

export PRAVO_DATABASE_URL="postgres://$PG_USER:$PG_PASSWORD@$PG_HOST:$PG_PORT/$DB_NAME?sslmode=disable"
export PRAVO_SIGNING_SECRET="e2e-test-signing-secret-32chars!"
export PRAVO_LLM_API_KEY="e2e-test-key"
export PRAVO_LLM_BASE_URL="http://localhost:${MOCK_LLM_PORT}"
export PRAVO_COOKIE_SECURE="false"
export PRAVO_BASE_URL="http://localhost:8080"
export PRAVO_HTTP_ADDR=":8080"
export PRAVO_LLM_MODEL="mock-gpt"
export PRAVO_LLM_TIMEOUT_SECONDS="10"

# Yandex ID via mock — real OAuth2 protocol with overridden endpoints
export PRAVO_YANDEX_CLIENT_ID="mock-client-id"
export PRAVO_YANDEX_CLIENT_SECRET="mock-client-secret"
export PRAVO_YANDEX_AUTH_URL="${MOCK_SSO_URL}/authorize"
export PRAVO_YANDEX_TOKEN_URL="${MOCK_SSO_URL}/token"
export PRAVO_YANDEX_USERINFO_URL="${MOCK_SSO_URL}/info"

# Disable legacy SSO provider — use real Yandex provider with mocked endpoints
export PRAVO_SSO_BASE_URL=""

info "Environment configured."
info "  DB:       $PRAVO_DATABASE_URL"
info "  Yandex:   mock at $MOCK_SSO_URL (auth/token/userinfo)"
info "  LLM:      $PRAVO_LLM_BASE_URL"
info "  App:      $PRAVO_BASE_URL"

# ---------------------------------------------------------------------------
# 3. Start mock servers (background)
# ---------------------------------------------------------------------------

PIDS=()
cleanup() {
  warn "Shutting down..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  info "All processes stopped."
}
trap cleanup EXIT

info "Starting mock servers..."
cd "$BACKEND_DIR"
MOCK_SSO_ADDR=":${MOCK_SSO_PORT}" MOCK_LLM_ADDR=":${MOCK_LLM_PORT}" go run ./cmd/mockserver &
PIDS+=($!)
sleep 1

# Verify mocks are up
for i in {1..10}; do
  if curl -sS "http://localhost:${MOCK_SSO_PORT}/health" > /dev/null 2>&1 && \
     curl -sS "http://localhost:${MOCK_LLM_PORT}/health" > /dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

info "Mock servers running."

# ---------------------------------------------------------------------------
# 4. Start backend
# ---------------------------------------------------------------------------

info "Starting backend..."
go run ./cmd/server &
PIDS+=($!)

# Wait for backend
for i in {1..20}; do
  if curl -sS http://localhost:8080/health > /dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if ! curl -sS http://localhost:8080/health > /dev/null 2>&1; then
  echo -e "${RED}Backend failed to start!${NC}"
  exit 1
fi

info "Backend running on :8080"

# ---------------------------------------------------------------------------
# 5. Done
# ---------------------------------------------------------------------------

echo ""
echo "============================================================================="
echo -e "${GREEN}  ALL SERVICES RUNNING${NC}"
echo "============================================================================="
echo ""
echo "  Backend:        http://localhost:8080"
echo "  Mock Yandex ID: http://localhost:${MOCK_SSO_PORT}  (authorize, token, info)"
echo "  Mock LLM:       http://localhost:${MOCK_LLM_PORT}"
echo "  Database:       $DB_NAME on $PG_HOST:$PG_PORT"
echo ""
echo "  Next step:  ./e2e/seed.sh"
echo ""
echo "  Press Ctrl+C to stop all services."
echo "============================================================================="
echo ""

wait
