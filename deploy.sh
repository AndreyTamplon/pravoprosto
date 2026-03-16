#!/bin/bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# 1. Check prerequisites
command -v docker >/dev/null 2>&1 || error "Docker is not installed. Install it first: https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || error "Docker Compose (v2) is not available. Install it first."

info "Docker and Docker Compose found."

# 2. Check .env file
if [ ! -f .env ]; then
    error ".env file not found. Copy .env.example to .env and fill in your values:\n  cp .env.example .env"
fi

info ".env file found."

# 3. Build images
info "Building Docker images..."
docker compose build

# 4. Start services
info "Starting services..."
docker compose up -d

# 5. Wait for health checks
info "Waiting for services to become healthy..."
TRIES=0
MAX_TRIES=30
until [ "$(docker compose ps --format json | python3 -c "
import sys, json
lines = sys.stdin.read().strip().split('\n')
services = [json.loads(l) for l in lines if l]
healthy = all(s.get('Health','') == 'healthy' or s.get('State','') == 'running' for s in services)
print('ok' if healthy else 'wait')
" 2>/dev/null)" = "ok" ] || [ $TRIES -ge $MAX_TRIES ]; do
    TRIES=$((TRIES + 1))
    sleep 2
done

if [ $TRIES -ge $MAX_TRIES ]; then
    warn "Timed out waiting for all services to become healthy. Check logs:"
    docker compose ps
    docker compose logs --tail=20
    exit 1
fi

# 6. Print status
echo ""
info "Deployment complete!"
echo ""
docker compose ps
echo ""
info "The application is running on port 80."
echo ""
warn "HTTPS setup (recommended):"
echo "  1. Install certbot:  sudo apt install certbot python3-certbot-nginx"
echo "  2. Obtain certificate:  sudo certbot certonly --standalone -d your-domain.com"
echo "  3. Mount certs into the frontend container and update nginx.conf to listen on 443 with SSL."
echo "  Alternatively, use a reverse proxy like Caddy or Traefik for automatic HTTPS."
