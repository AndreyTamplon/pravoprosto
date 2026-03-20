# Право Просто

Интерактивная образовательная платформа по правовой грамотности для детей и подростков. Duolingo-стиль: комиксы, квесты, XP-система.

**Прод:** https://smartgoschool.ru

## Стек

| Слой | Технология |
|------|-----------|
| Frontend | React 19, TypeScript, Vite, CSS Modules |
| Backend | Go 1.24, Chi router, PostgreSQL 16, pgx |
| Auth | Яндекс ID (OAuth2 SSO) |
| LLM | OpenAI-совместимый API (оценка свободных ответов) |
| Тесты | Playwright E2E (62 теста, реальный стек) |
| Деплой | Docker Compose, nginx, Let's Encrypt |

## Быстрый старт

```bash
# 1. Склонировать
git clone <repo-url> && cd pravoprost

# 2. Настроить
cp .env.example .env
# Заполнить .env реальными значениями (см. CLAUDE.md)

# 3. Запустить
docker compose up -d

# Сайт доступен на http://localhost
```

### Локальная разработка (без Docker)

```bash
# Backend
cd backend && go run ./cmd/server

# Mock SSO + LLM
cd backend && go run ./cmd/mockserver

# Frontend
cd frontend && npm install && npm run dev
```

## Роли

| Роль | Что может |
|------|----------|
| **Ученик** | Проходить уроки, зарабатывать XP, поддерживать streak |
| **Родитель** | Привязать ребёнка, следить за прогрессом |
| **Учитель** | Создавать курсы, раздавать по ссылке, смотреть прогресс учеников |
| **Админ** | Управлять платформенными курсами, модерировать, управлять пользователями и коммерцией |

## Структура проекта

```
├── backend/           Go API сервер
│   ├── cmd/server/    Основной сервер
│   ├── cmd/mockserver/ Mock SSO + LLM для разработки
│   └── internal/      Бизнес-логика (identity, courses, lessonruntime, commerce, ...)
├── frontend/          React SPA
│   ├── src/pages/     28 экранов по 4 ролям
│   ├── src/components/ UI-компоненты (comic-стиль)
│   └── nginx.conf     Prod nginx конфиг
├── e2e/               Playwright E2E тесты
│   ├── tests/gate2/   6 критических сценариев
│   └── tests/         22 теста по ролям
├── specs/             Спецификации и проектная документация
├── docker-compose.yml Prod деплой
└── CLAUDE.md          Гайд по разработке
```

## Тестирование

62 E2E теста через реальный стек (Go + PostgreSQL + mock SSO + mock LLM):

```bash
cd e2e && npx playwright test
```

Покрытие: все 21 user story, все 4 роли, включая полное прохождение урока, оценку LLM, платный контент и связку родитель-ребёнок.

## Деплой

Docker Compose на VM. Подробности в [CLAUDE.md](CLAUDE.md).

```bash
docker compose build && docker compose up -d
```

## Лицензия

Проект создан в рамках учебного задания НИУ ВШЭ.
