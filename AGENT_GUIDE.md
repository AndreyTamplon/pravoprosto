# Руководство для агентов — Право Просто

Полная инструкция для AI-агентов (Claude, Codex, Cursor и т.д.) по локальной работе, тестированию и деплою проекта.

## Архитектура проекта

```
pravoprost/
├── backend/                  Go 1.24 API сервер
│   ├── cmd/server/           Основной HTTP сервер (Chi router)
│   ├── cmd/mockserver/       Mock SSO + Mock LLM для разработки
│   ├── internal/
│   │   ├── httpserver/       router.go — все HTTP обработчики и роуты
│   │   ├── identity/         Auth, SSO, sessions, user management
│   │   ├── courses/          Курсы, черновики, ревизии, preview, модерация
│   │   ├── lessonruntime/    Lesson player: сессии, steps, answers, game state
│   │   ├── commerce/         Офферы, заявки, заказы, оплата, entitlements
│   │   ├── guardianship/     Parent-child связь, инвайты
│   │   ├── teacheraccess/    Teacher access links, student progress
│   │   ├── evaluation/       LLM оценка свободных ответов
│   │   ├── assets/           Загрузка файлов
│   │   └── platform/         Config, DB, crypto utilities
│   ├── Dockerfile            Multi-stage build
│   └── go.mod
├── frontend/                 React 19 + TypeScript + Vite SPA
│   ├── src/
│   │   ├── api/
│   │   │   ├── client.ts     Все API вызовы (~55 функций) с нормализацией DTO
│   │   │   └── types.ts      TypeScript интерфейсы + graphToBackendFormat/graphFromBackendFormat
│   │   ├── contexts/
│   │   │   └── AuthContext.tsx  Session management, CSRF, login/logout
│   │   ├── pages/            28 экранов по 4 ролям (student, parent, teacher, admin)
│   │   ├── components/       UI компоненты (comic-стиль)
│   │   └── App.tsx           Все роуты и guards
│   ├── nginx.conf            Prod nginx (proxy, security headers, SPA fallback)
│   ├── Dockerfile            Multi-stage build (npm build → nginx)
│   └── vite.config.ts
├── e2e/                      Playwright E2E тесты
│   ├── playwright.config.ts  Config: webServer поднимает 3 процесса
│   ├── global-setup.ts       Seed данные через API, парсит fixture IDs
│   ├── global-teardown.ts    Дропает тестовую БД
│   ├── auth.setup.ts         Логин за 5 ролей, сохраняет storageState
│   ├── seed.sh               Сидирование через API (не SQL)
│   ├── helpers/              fixtures.ts, sso-login.ts, lesson-walker.ts
│   └── tests/                gate2/ student/ parent/ teacher/ admin/ qa-regression/
├── docker-compose.yml        Прод деплой (postgres + backend + frontend)
├── scripts.sh                Утилиты для работы с продом
├── CLAUDE.md                 Основной гайд
├── INTEGRATION_FIX_PLAN.md   Текущий план исправлений
└── specs/                    Проектная документация
```

## Локальная разработка

### Предварительные требования

- Go 1.24+
- Node.js 22+ (LTS)
- PostgreSQL 16 (в Docker или локально)
- Docker (для PostgreSQL и для деплоя)

### Запуск для разработки (3 терминала)

```bash
# Терминал 1: Mock SSO (порт 8091) + Mock LLM (порт 8090)
cd backend && go run ./cmd/mockserver

# Терминал 2: Go backend (порт 8080)
cd backend && go run ./cmd/server
# Нужны env-переменные — см. секцию "Env-переменные для локальной разработки"

# Терминал 3: Vite frontend (порт 5173, проксирует /api → :8080)
cd frontend && npm install && npm run dev
```

### Env-переменные для локальной разработки

Backend (`cmd/server`) требует эти переменные. Можно задать через export или `.env`:

```bash
export PRAVO_DATABASE_URL="postgres://postgres:postgres@localhost:5432/pravoprost?sslmode=disable"
export PRAVO_SIGNING_SECRET="local-dev-signing-secret-32chars!"
export PRAVO_HTTP_ADDR=":8080"
export PRAVO_BASE_URL="http://localhost:5173"
export PRAVO_COOKIE_SECURE="false"
export PRAVO_LLM_API_KEY="dev-key"
export PRAVO_LLM_BASE_URL="http://localhost:8090"
export PRAVO_LLM_MODEL="mock-gpt"
export PRAVO_YANDEX_CLIENT_ID="mock-client-id"
export PRAVO_YANDEX_CLIENT_SECRET="mock-client-secret"
export PRAVO_YANDEX_AUTH_URL="http://localhost:8091/authorize"
export PRAVO_YANDEX_TOKEN_URL="http://localhost:8091/token"
export PRAVO_YANDEX_USERINFO_URL="http://localhost:8091/info"
```

### PostgreSQL для разработки

```bash
# Через Docker (рекомендуется)
docker run -d --name pravoprost-dev-postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=pravoprost \
  -p 5432:5432 \
  postgres:16-alpine

# Бекенд создаёт таблицы автоматически при первом запуске (auto-migrate)
```

### Сборка Go бинарников

```bash
cd backend
go build -o server ./cmd/server
go build -o mockserver ./cmd/mockserver
```

### Проверка TypeScript

```bash
cd frontend && npx tsc --noEmit
```

### Сборка фронтенда

```bash
cd frontend && npx vite build   # output → frontend/dist/
```

---

## E2E тестирование

### Как это работает

Playwright поднимает **собственный стек** на нестандартных портах:

| Сервис | Порт | Что делает |
|--------|------|-----------|
| Mock SSO | 3091 | Эмулирует Яндекс OAuth (HTML страница с кнопками юзеров) |
| Mock LLM | 3090 | Эмулирует OpenAI API (управляется маркерами в тексте ответа) |
| Backend | 3080 | Go сервер с тестовой БД `pravoprost_e2e` |
| Frontend | 3173 | Vite dev server с proxy `/api → :3080` |

### Предварительные требования для E2E

1. **PostgreSQL доступен на localhost:5432** с пользователем `postgres:postgres`
2. **Go бинарники собраны**: `cd backend && go build -o server ./cmd/server && go build -o mockserver ./cmd/mockserver`
3. **npm зависимости установлены**: `cd frontend && npm install` и `cd e2e && npm install`
4. **Playwright браузеры установлены**: `cd e2e && npx playwright install chromium`

### Запуск PostgreSQL для E2E (Docker)

```bash
docker run -d --name pravoprost-e2e-postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 \
  postgres:16-alpine

# Подождать готовности
sleep 3 && docker exec pravoprost-e2e-postgres pg_isready -U postgres
```

### Запуск тестов

```bash
cd e2e

# Полный прогон (~2.5 мин, 74 теста)
npx playwright test

# Только критический путь (gate2)
npx playwright test tests/gate2/

# Только QA regression тесты
npx playwright test tests/qa-regression/

# Конкретный файл
npx playwright test tests/gate2/03-lesson-single-choice.spec.ts

# Без ретраев (для отладки)
npx playwright test --retries=0

# С verbose выводом
npx playwright test --reporter=list

# HTML-отчёт
npx playwright show-report
```

### Что делает global-setup

1. Playwright config (`webServer`) запускает 3 процесса и создаёт/пересоздаёт БД `pravoprost_e2e`
2. `global-setup.ts` ждёт health-check всех сервисов
3. Запускает `seed.sh` — создаёт тестовые данные через API:
   - 5 пользователей: admin, teacher, student, parent, student2
   - Platform course "Безопасность в интернете" (3 урока: phishing, passwords, personal_data)
   - Teacher course "Покупки онлайн" (1 урок, approved + published)
   - Access link для teacher course
   - Paid offer для lesson_personal_data (490 RUB)
   - Guardian link: parent → student
4. Парсит fixture IDs из вывода seed.sh → `.test-fixtures.json`
5. `auth.setup.ts` логинится за каждую роль → `.auth/*.json` (storageState)

### Seeded fixture IDs

Тесты получают IDs через `fixtures` proxy из `e2e/helpers/fixtures.ts`:

```typescript
import { fixtures } from '../../helpers/fixtures';
const { platformCourseId, teacherCourseId, accessLinkToken, offerId } = fixtures;
```

### Mock SSO

Mock SSO (`cmd/mockserver`) рендерит HTML страницу с кнопками юзеров:
- Admin, Teacher (Мария Ивановна), Student (Алиса), Parent (Елена), Student 2 (Борис)
- Есть поле для произвольного кода (для теста first login)
- Playwright кликает по ним как обычный пользователь

### Mock LLM

Mock LLM реагирует на маркеры в тексте ответа ученика:
- `[llm:correct]` → verdict: correct
- `[llm:partial]` → verdict: partial
- `[llm:incorrect]` → verdict: incorrect
- `[llm:500]` → HTTP 500 ошибка
- `[llm:timeout]` → таймаут

### Структура тестов

```
e2e/tests/
├── gate2/                    6 критических сценариев (release gate)
│   ├── 01-first-login        SSO → role select → onboarding → каталог
│   ├── 02-teacher-publish    Teacher create course + student claim link
│   ├── 03-lesson-single-choice  Полный урок с выбором ответа
│   ├── 04-lesson-free-text   Урок с LLM оценкой
│   ├── 05-parent-child       Родительский dashboard + прогресс
│   └── 06-paid-lesson        Платный урок: заявка → заказ → оплата → unlock
├── student/                  5 тестов (каталог, дерево, уроки, геймификация, профиль)
├── parent/                   3 теста (инвайт, прогресс, профиль)
├── teacher/                  5 тестов (курсы, конструктор, preview, ссылки, прогресс)
├── admin/                    5 тестов (курсы, модерация, коммерция, юзеры, профиль)
└── qa-regression/            5 файлов — regression тесты на найденные QA баги
```

### Паттерн написания тестов

```typescript
import { test, expect } from '@playwright/test';
import { fixtures } from '../../helpers/fixtures';

// Переиспользуем сохранённую auth сессию (не логинимся каждый раз)
test.use({ storageState: '.auth/student.json' });

test.describe('Feature name', () => {
  test('scenario description', async ({ page }) => {
    const { platformCourseId } = fixtures;

    await page.goto(`/student/courses/${platformCourseId}`);
    await expect(page.getByText('Course Title')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: /Action/i }).click();
  });
});
```

Для мульти-ролевых тестов используй `browser.newContext()`:

```typescript
test('multi-role scenario', async ({ browser }) => {
  const teacherCtx = await browser.newContext({ storageState: '.auth/teacher.json' });
  const teacherPage = await teacherCtx.newPage();
  // ... teacher actions ...
  await teacherCtx.close();

  const adminCtx = await browser.newContext({ storageState: '.auth/admin.json' });
  const adminPage = await adminCtx.newPage();
  // ... admin actions ...
  await adminCtx.close();
});
```

### Важные правила для тестов

- **workers: 1** — все тесты шарят одну БД, выполняются последовательно
- **Не мутируй seeded данные** — создавай свои курсы/офферы для мутаций
- **Используй `getByRole`, `getByText`** — не CSS селекторы
- **Обязательные предусловия** — не `if (hasData) { assert }`, а гарантируй данные в setup
- **Network inspection** для contract-critical проверок:
  ```typescript
  page.on('request', req => {
    if (req.url().includes('/api/path') && req.method() === 'PUT') {
      const body = req.postDataJSON();
      expect(body.field).toBeDefined();
    }
  });
  ```

### Очистка после тестов

```bash
# Остановить Docker PostgreSQL
docker stop pravoprost-e2e-postgres && docker rm pravoprost-e2e-postgres

# global-teardown.ts автоматически дропает БД pravoprost_e2e
# Если нужно сохранить БД для отладки: E2E_KEEP_DB=1 npx playwright test
```

---

## Деплой на прод

### Инфраструктура

- **VM**: cloud.ru, IP 176.123.166.189
- **Домен**: smartgoschool.ru (A-запись → 176.123.166.189)
- **OS**: Ubuntu
- **SSH**: `ssh -i /Users/aatamplon/Downloads/id_rsa andrey@176.123.166.189`
- **SSL**: Let's Encrypt через certbot, сертификаты в `/etc/letsencrypt/`
- **Firewall**: UFW (порты 22, 80, 443)
- **Security Groups**: cloud.ru — TCP 22, 80, 443 открыты

### Стек на VM

```
docker compose (3 сервиса):
├── postgres     (16-alpine, volume pgdata, НЕ exposed наружу)
├── backend      (Go binary, порт 8080 внутренний)
└── frontend     (nginx + static, порты 80 + 443)
    ├── проксирует /api/ → backend:8080
    ├── раздаёт SPA статику
    ├── security headers (CSP, HSTS, X-Frame-Options)
    ├── rate limiting (10 req/s per IP на /api/)
    └── SSL через Let's Encrypt (маунт /etc/letsencrypt)
```

### .env на VM

Файл `~/pravoprost/.env` (chmod 600):

```bash
POSTGRES_PASSWORD=<сгенерировать: openssl rand -hex 16>
SIGNING_SECRET=<сгенерировать: openssl rand -hex 32>
BASE_URL=https://smartgoschool.ru
LLM_BASE_URL=https://api.openai.com
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4o-mini
YANDEX_CLIENT_ID=0a0be8a3a98c491f9060da0299c155e5
YANDEX_CLIENT_SECRET=d64f856aba8a4d46affa2023b587daa2
```

### Полный деплой

```bash
# 1. Копировать файлы на VM
rsync -avz --progress \
  -e "ssh -i /Users/aatamplon/Downloads/id_rsa" \
  --exclude='node_modules' --exclude='.git' --exclude='dist' \
  --exclude='test-results' --exclude='playwright-report' \
  --exclude='.auth' --exclude='.test-fixtures.json' \
  --exclude='backend/server' --exclude='backend/mockserver' \
  --exclude='materials' --exclude='.idea' --exclude='.env' \
  ./ andrey@176.123.166.189:~/pravoprost/

# 2. Собрать и перезапустить
ssh -i /Users/aatamplon/Downloads/id_rsa andrey@176.123.166.189 \
  "cd ~/pravoprost && sudo docker compose build && sudo docker compose up -d"
```

### Деплой отдельных сервисов

```bash
SSH="ssh -i /Users/aatamplon/Downloads/id_rsa andrey@176.123.166.189"

# Только фронтенд
rsync -avz -e "ssh -i /Users/aatamplon/Downloads/id_rsa" \
  --exclude='node_modules' --exclude='dist' \
  frontend/ andrey@176.123.166.189:~/pravoprost/frontend/
$SSH "cd ~/pravoprost && sudo docker compose build frontend && sudo docker compose up -d frontend"

# Только бекенд
rsync -avz -e "ssh -i /Users/aatamplon/Downloads/id_rsa" \
  --exclude='server' --exclude='mockserver' \
  backend/ andrey@176.123.166.189:~/pravoprost/backend/
$SSH "cd ~/pravoprost && sudo docker compose build backend && sudo docker compose up -d backend"
```

### Мониторинг

```bash
SSH="ssh -i /Users/aatamplon/Downloads/id_rsa andrey@176.123.166.189"

# Статус сервисов
$SSH "cd ~/pravoprost && sudo docker compose ps"

# Логи бекенда (последние 50 строк)
$SSH "sudo docker logs pravoprost-backend-1 --tail=50"

# Логи фронтенда/nginx
$SSH "sudo docker logs pravoprost-frontend-1 --tail=50"

# Логи PostgreSQL
$SSH "sudo docker logs pravoprost-postgres-1 --tail=50"

# Health check
$SSH "curl -sS http://localhost/health"

# Перезапуск
$SSH "cd ~/pravoprost && sudo docker compose restart"
```

### Администрирование пользователей (прод)

```bash
PSQL="sudo docker exec pravoprost-postgres-1 psql -U pravoprost -d pravoprost -c"

# Список всех пользователей
$SSH "$PSQL \"SELECT a.role, a.status, ei.email, a.created_at::date FROM accounts a JOIN external_identities ei ON ei.account_id = a.id ORDER BY a.created_at;\""

# Промоутнуть в админа по email
$SSH "$PSQL \"UPDATE accounts SET role = 'admin' WHERE id = (SELECT account_id FROM external_identities WHERE email = 'user@yandex.ru');\""

# Заблокировать пользователя
$SSH "$PSQL \"UPDATE accounts SET status = 'blocked' WHERE id = (SELECT account_id FROM external_identities WHERE email = 'user@yandex.ru');\""
```

### SSL сертификат

```bash
# Первоначальная установка (уже сделана)
$SSH "sudo certbot certonly --standalone -d smartgoschool.ru --agree-tos -m admin@email.com"

# Обновление (certbot автоматически обновляет через systemd timer)
$SSH "sudo certbot renew --dry-run"

# Перезапуск nginx после обновления сертификата
$SSH "cd ~/pravoprost && sudo docker compose restart frontend"
```

---

## Работа с кодом — важные контракты

### API клиент (frontend/src/api/client.ts)

Центральное место нормализации backend → frontend DTO. Многие бекенд ответы имеют отличную от фронтенда структуру. Нормализация происходит здесь:

- `getList(path, key)` — unwrap `{items: [...]}` или `{students: [...]}` и т.д.
- `getPurchaseRequests()` — nested `student.display_name` → flat `student_name`
- `getOrders()` — nested `student`, `offer` → flat fields
- `getTeacherStudents()` — key `'students'` + field mapping `progress_percent → progress_pct`
- `getChildProgress()` — nested `student`, `summary`, `courses` → flat

### Формат графа уроков

Фронтенд-редактор использует формат `{type, data, edges}`, бекенд — `{kind, nextNodeId, options, transitions}`.

Конвертеры в `frontend/src/api/types.ts`:
- `graphToBackendFormat()` — при сохранении
- `graphFromBackendFormat()` — при загрузке

Ключевые различия:
- `type: 'terminal'` → `kind: 'end'`
- `options[].option_id` → `options[].id`
- `options[].is_correct` → `options[].result: 'correct'/'incorrect'`
- Отдельный `edges[]` → inline `nextNodeId` в каждой ноде
- `rubric.referenceAnswer` (camelCase!) — не snake_case

### Mock LLM маркеры

В тексте ответа ученика:
- `[llm:correct]` → verdict correct, feedback positive
- `[llm:partial]` → verdict partial
- `[llm:incorrect]` → verdict incorrect

### Роли и guards

| Роль | Frontend guard | Backend guard |
|------|---------------|--------------|
| student | `RequireRole('student')` | `requireRole("student")` |
| parent | `RequireRole('parent')` | `requireRole("parent")` |
| teacher | `RequireRole('teacher')` | `requireTeacherReady()` (+ profile check) |
| admin | `RequireRole('admin')` | `requireRole("admin")` |

### CSRF

Все мутирующие запросы (POST/PUT/DELETE) должны включать заголовок `X-CSRF-Token`. Токен получается из `GET /api/v1/session` → `csrf_token`. Frontend `client.ts` делает это автоматически.

---

## Известные проблемы (INTEGRATION_FIX_PLAN.md)

На момент написания есть ~20 расхождений между frontend и backend DTO. 8 из них P0 (функционал сломан), 6 P1 (деградирован), остальные P2 (отображаются дефолты). Полный список и план исправления — в `INTEGRATION_FIX_PLAN.md`.
