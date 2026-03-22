#!/bin/bash
# ============================================================================
# Право Просто — Полезные скрипты
# ============================================================================

SSH_KEY="/Users/aatamplon/Downloads/id_rsa"
SSH_HOST="andrey@176.123.166.189"
SSH="ssh -i $SSH_KEY $SSH_HOST"
PSQL="sudo docker exec pravoprost-postgres-1 psql -U pravoprost -d pravoprost -c"

# ============================================================================
# ПРОД: Администрирование
# ============================================================================

# Список всех пользователей
prod-users() {
  $SSH "$PSQL \"SELECT a.role, a.status, ei.email, a.created_at::date FROM accounts a JOIN external_identities ei ON ei.account_id = a.id ORDER BY a.created_at;\""
}

# Промоутнуть в админа по email
prod-make-admin() {
  local email="$1"
  if [ -z "$email" ]; then echo "Usage: prod-make-admin email@yandex.ru"; return 1; fi
  $SSH "$PSQL \"UPDATE accounts SET role = 'admin' WHERE id = (SELECT account_id FROM external_identities WHERE email = '$email'); SELECT role, email FROM accounts a JOIN external_identities ei ON ei.account_id = a.id WHERE ei.email = '$email';\""
}

# Заблокировать пользователя по email
prod-block-user() {
  local email="$1"
  if [ -z "$email" ]; then echo "Usage: prod-block-user email@yandex.ru"; return 1; fi
  $SSH "$PSQL \"UPDATE accounts SET status = 'blocked' WHERE id = (SELECT account_id FROM external_identities WHERE email = '$email'); SELECT role, status, email FROM accounts a JOIN external_identities ei ON ei.account_id = a.id WHERE ei.email = '$email';\""
}

# Разблокировать пользователя
prod-unblock-user() {
  local email="$1"
  if [ -z "$email" ]; then echo "Usage: prod-unblock-user email@yandex.ru"; return 1; fi
  $SSH "$PSQL \"UPDATE accounts SET status = 'active' WHERE id = (SELECT account_id FROM external_identities WHERE email = '$email'); SELECT role, status, email FROM accounts a JOIN external_identities ei ON ei.account_id = a.id WHERE ei.email = '$email';\""
}

# ============================================================================
# ПРОД: Деплой
# ============================================================================

# Полный деплой (копировать + собрать + перезапустить)
prod-deploy() {
  echo "=== Копирую файлы ===" && \
  rsync -avz --progress \
    -e "ssh -i $SSH_KEY" \
    --exclude='node_modules' --exclude='.git' --exclude='dist' \
    --exclude='test-results' --exclude='playwright-report' \
    --exclude='.auth' --exclude='.test-fixtures.json' \
    --exclude='backend/server' --exclude='backend/mockserver' \
    --exclude='materials' --exclude='.idea' --exclude='.env' \
    ./ $SSH_HOST:~/pravoprost/ && \
  echo "=== Собираю и перезапускаю ===" && \
  $SSH "cd ~/pravoprost && sudo docker compose build && sudo docker compose up -d" && \
  echo "=== Готово ==="
}

# Деплой только фронтенда
prod-deploy-frontend() {
  rsync -avz -e "ssh -i $SSH_KEY" \
    --exclude='node_modules' --exclude='dist' \
    frontend/ $SSH_HOST:~/pravoprost/frontend/ && \
  $SSH "cd ~/pravoprost && sudo docker compose build frontend && sudo docker compose up -d frontend"
}

# Деплой только бекенда
prod-deploy-backend() {
  rsync -avz -e "ssh -i $SSH_KEY" \
    --exclude='server' --exclude='mockserver' \
    backend/ $SSH_HOST:~/pravoprost/backend/ && \
  $SSH "cd ~/pravoprost && sudo docker compose build backend && sudo docker compose up -d backend"
}

# ============================================================================
# ПРОД: Мониторинг
# ============================================================================

# Статус сервисов
prod-status() {
  $SSH "cd ~/pravoprost && sudo docker compose ps && echo '===' && curl -sS http://localhost/health"
}

# Логи бекенда (последние 50 строк)
prod-logs-backend() {
  $SSH "sudo docker logs pravoprost-backend-1 --tail=${1:-50}"
}

# Логи фронтенда/nginx
prod-logs-frontend() {
  $SSH "sudo docker logs pravoprost-frontend-1 --tail=${1:-50}"
}

# Логи PostgreSQL
prod-logs-db() {
  $SSH "sudo docker logs pravoprost-postgres-1 --tail=${1:-50}"
}

# Перезапуск всех сервисов
prod-restart() {
  $SSH "cd ~/pravoprost && sudo docker compose restart"
}

# ============================================================================
# ЛОКАЛЬНАЯ РАЗРАБОТКА
# ============================================================================

# Запустить всё для разработки (3 терминала)
dev-start() {
  echo "Запусти в трёх терминалах:"
  echo "  1) cd backend && go run ./cmd/mockserver"
  echo "  2) cd backend && go run ./cmd/server"
  echo "  3) cd frontend && npm run dev"
}

# Собрать Go бинарники
dev-build() {
  cd backend && go build -o server ./cmd/server && go build -o mockserver ./cmd/mockserver && cd ..
  echo "Backend binaries built"
}

# Проверить TypeScript
dev-check-frontend() {
  cd frontend && npx tsc --noEmit && npx vite build && cd ..
}

# ============================================================================
# ТЕСТИРОВАНИЕ
# ============================================================================

# Полный прогон E2E (нужен PostgreSQL на localhost:5432)
test-e2e() {
  cd e2e && npx playwright test "$@" && cd ..
}

# Только Gate 2 (критический путь)
test-gate2() {
  cd e2e && npx playwright test tests/gate2/ "$@" && cd ..
}

# E2E отчёт
test-report() {
  cd e2e && npx playwright show-report && cd ..
}

# Бекенд тесты (нужен Docker для testcontainers)
test-backend() {
  cd backend && go test ./tests/... -v -count=1 "$@" && cd ..
}

# ============================================================================
echo "Право Просто — скрипты загружены."
echo "Использование: source scripts.sh"
echo ""
echo "Прод:  prod-users | prod-make-admin | prod-deploy | prod-status | prod-logs-backend"
echo "Dev:   dev-start | dev-build | dev-check-frontend"
echo "Тесты: test-e2e | test-gate2 | test-report | test-backend"
