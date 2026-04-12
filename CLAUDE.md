# CLAUDE.md — SmartGo School

## Как запускать

### Локальная разработка

```bash
# Backend (нужен PostgreSQL на localhost:5432)
cd backend && go run ./cmd/server

# Mock SSO + LLM (для разработки без реального Яндекс ID)
cd backend && go run ./cmd/mockserver

# Frontend (Vite dev server, проксирует /api на backend)
cd frontend && npm run dev
```

### E2E тесты

```bash
cd e2e && npx playwright test           # полный прогон (~2 мин)
npx playwright test tests/gate2/        # только критический путь
npx playwright test --retries=0         # без ретраев (для отладки)
npx playwright show-report              # HTML-отчёт
```

Тесты поднимают свой стек автоматически: mockserver (порт 3091/3090), backend (3080), Vite (3173), PostgreSQL БД `pravoprost_e2e`. Нужен только запущенный PostgreSQL.

### Деплой на прод (VM 176.123.166.189)

```bash
# Копировать изменения
rsync -avz --exclude='node_modules' --exclude='.git' --exclude='dist' \
  -e "ssh -i /path/to/id_rsa" ./ andrey@176.123.166.189:~/pravoprost/

# Пересобрать и перезапустить
ssh andrey@176.123.166.189 "cd ~/pravoprost && sudo docker compose build && sudo docker compose up -d"
```

Или для отдельного сервиса:
```bash
ssh andrey@176.123.166.189 "cd ~/pravoprost && sudo docker compose build frontend && sudo docker compose up -d frontend"
```

## Подход к разработке

### Фронтенд

- **CSS Modules** — каждый компонент имеет свой `.module.css`, глобальные стили только в `index.css`
- **Современный стиль SmartGo** — тонкие обводки (1px), мягкие тени (blur), шрифт Nunito Sans, светлый фон (#F8FAFB)
- **UI лексика для ученика** — Курс = Миссия, Урок = Этап, Каталог = Штаб героя, Профиль = Досье героя, Правильно = ВЕРНО!, Неправильно = ПРОМАХ!, Частично = ПОЧТИ!
- **Учитель/админ** — используют обычные термины (Курс, Урок), не игровые

### Бекенд

- **Все SQL запросы параметризованы** (`$1`, `$2`) через pgx — никогда не конкатенация строк
- **CSRF на всех мутирующих эндпоинтах** — через `requireCSRF` middleware или ручная проверка через `secureEquals`
- **Role guards на каждом роуте** — `requireRole("student")`, `requireTeacherReady()`, `requireRole("admin")`
- **Секреты только через env** — `ValidateRuntime()` блокирует старт с дефолтными значениями

### Тестирование

- **E2E через реальный стек** — Playwright ходит в настоящий Go-бекенд с PostgreSQL, mock SSO и mock LLM. Не моки API, не jsdom — реальные HTTP-запросы через браузер
- **Mock LLM** управляется маркерами в тексте ответа: `[llm:correct]`, `[llm:partial]`, `[llm:incorrect]`
- **Mock SSO** — рендерит HTML-страницу с кнопками юзеров, Playwright кликает по ним как пользователь
- **storageState** — логинимся один раз за каждую роль в setup-проекте, тесты переиспользуют сохранённые cookies
- **seed.sh** — сидирует данные через API (не через SQL), максимально приближённо к реальному использованию

### Валидация

- **Agent team** — после написания кода запускаем параллельных агентов-валидаторов:
  - Соответствие типов Go ↔ TypeScript (поле-за-полем)
  - Покрытие всех API эндпоинтов
  - Корректность роутов и навигации
  - Соответствие дизайн-системе
  - Security аудит
- **Исправляем по результатам**, потом перевалидируем

### Деплой

- **docker compose** на одной VM — простой стек без K8s
- **nginx** в контейнере фронтенда — проксирует `/api/` на бекенд, раздаёт статику, security headers, rate limiting
- **Let's Encrypt** сертификат через certbot на хосте, маунтится в контейнер

## Env-переменные

### Обязательные для прода (в `.env` на VM)

| Переменная | Откуда взять | Пример |
|---|---|---|
| `POSTGRES_PASSWORD` | Сгенерировать: `openssl rand -hex 16` | `a1b2c3d4...` |
| `SIGNING_SECRET` | Сгенерировать: `openssl rand -hex 32` | `e5f6a7b8...` |
| `BASE_URL` | Домен сайта | `https://smartgoschool.ru` |
| `LLM_BASE_URL` | URL OpenAI-совместимого API | `https://api.openai.com` |
| `LLM_API_KEY` | Ключ API из кабинета провайдера | `sk-...` |
| `LLM_MODEL` | Название модели | `gpt-4o-mini` |
| `YANDEX_CLIENT_ID` | oauth.yandex.ru → создать приложение | `0a0be8a3...` |
| `YANDEX_CLIENT_SECRET` | Там же, при создании | `d64f856a...` |

### Яндекс OAuth

Redirect URI при создании приложения: `https://<домен>/api/v1/auth/sso/yandex/callback`
Права доступа: "Доступ к логину, имени и фамилии" + "Доступ к email"

### Назначение админа

Админ назначается через SQL после первого входа пользователя:
```bash
ssh andrey@176.123.166.189 "sudo docker exec pravoprost-postgres-1 psql -U pravoprost -d pravoprost -c \"UPDATE accounts SET role = 'admin' WHERE id = '<account_id>';\""
```
ID аккаунта можно найти: `SELECT id, role FROM accounts ORDER BY created_at DESC LIMIT 5;`
