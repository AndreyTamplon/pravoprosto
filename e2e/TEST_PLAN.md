# E2E Manual Test Plan

## Подготовка

```bash
# 1. Запустить всё (Postgres, mock Yandex ID + LLM, backend)
./e2e/start.sh

# 2. В другом терминале — посеять данные
./e2e/seed.sh

# 3. Для вызовов API использовать cookie-файлы из seed:
#    curl -b /tmp/xxx/student.txt http://localhost:8080/api/v1/...
```

Mock Yandex ID реализует настоящий OAuth2 протокол:
- `GET /authorize` — страница выбора пользователя (аналог login.yandex.ru)
- `POST /token` — обмен code на access_token
- `GET /info` — Yandex userinfo (аналог login.yandex.ru/info)

Backend подключается через `PRAVO_YANDEX_CLIENT_ID` + override endpoints.

Seed создаёт:
- **admin** — аккаунт с ролью admin
- **teacher** — аккаунт с ролью teacher, профиль "Мария Ивановна"
- **student** — аккаунт с ролью student, профиль "Алиса", привязан к parent
- **student2** — аккаунт с ролью student, профиль "Борис"
- **parent** — аккаунт с ролью parent, профиль "Елена", привязан к student
- **Platform course** — "Безопасность в интернете" с 3 уроками (2 free + 1 paid)
- **Teacher course** — "Покупки онлайн", approved, с access-ссылкой
- **Commercial offer** — 490 RUB за платный урок
- **Guardian link** — parent ↔ student

---

## Mock LLM — управление вердиктами

При ответе на free_text вопрос, включи в текст ответа контрольный код:

| Код в ответе | Результат |
|---|---|
| `[llm:correct]` | verdict: correct |
| `[llm:partial]` | verdict: partial |
| `[llm:incorrect]` | verdict: incorrect |
| `[llm:500]` | LLM возвращает 500 |
| `[llm:timeout]` | LLM зависает (timeout) |
| `[llm:malformed]` | LLM возвращает битый JSON |
| (без кода) | Auto: эвристика по ключевым словам |

---

## Сценарии

### A. Auth / Session / Onboarding

| # | Что проверяем | Как | Ожидание |
|---|---|---|---|
| A1 | Новый SSO login | `GET /api/v1/auth/sso/yandex/start` → redirect → callback с новым кодом | Account с role=unselected |
| A2 | Session info | `GET /api/v1/session` для unselected | `role_selection_required: true` |
| A3 | Выбор роли student | `POST /api/v1/onboarding/role {"role":"student"}` | 200, role=student |
| A4 | Повторный выбор | Повторить A3 с той же ролью | 200, идемпотентно |
| A5 | Смена роли | `POST /api/v1/onboarding/role {"role":"teacher"}` для student | 409 |
| A6 | Выбор admin | `POST /api/v1/onboarding/role {"role":"admin"}` | 403 |
| A7 | Logout | `POST /api/v1/auth/logout` | 204, session invalidated |
| A8 | Запрос без cookie | `GET /api/v1/student/catalog` без cookie | 401 |
| A9 | CSRF отсутствует | POST без X-CSRF-Token | 403 |
| A10 | Teacher profile required | Teacher без профиля → create course | 409 teacher_profile_required |

### B. Profiles

| # | Что проверяем | Как | Ожидание |
|---|---|---|---|
| B1 | Student profile read | `GET /api/v1/student/profile` | display_name, etc. |
| B2 | Student profile update | `PUT /api/v1/student/profile` | 200 |
| B3 | Teacher profile read | `GET /api/v1/teacher/profile` | display_name, organization |
| B4 | Parent profile read | `GET /api/v1/parent/profile` | display_name |
| B5 | Cross-role access | Student → GET /api/v1/teacher/profile | 403 |

### C. Student Catalog & Course Tree

| # | Что проверяем | Как | Ожидание |
|---|---|---|---|
| C1 | Каталог | `GET /api/v1/student/catalog` | Platform course видна |
| C2 | Teacher course не видна | catalog до claim | Teacher course отсутствует |
| C3 | Course tree | `GET /api/v1/student/courses/{id}` | 3 lessons с access state |
| C4 | Paid lesson state | tree для lesson_personal_data | `locked_paid` |
| C5 | Free lesson state | tree для lesson_phishing | accessible |
| C6 | Public promo | `GET /api/v1/public/promo-courses` (без auth) | Platform course |

### D. Student Runtime — Single Choice

| # | Что проверяем | Как | Ожидание |
|---|---|---|---|
| D1 | Start lesson | `POST /student/courses/{id}/lessons/lesson_phishing/start` | session_id, node s1 (story) |
| D2 | Next (story) | `POST /student/lesson-sessions/{id}/next` с state_version, node_id=s1 | Переход к q1 (single_choice) |
| D3 | Correct answer | `POST .../answer` option_id=q1b | verdict: correct, +XP |
| D4 | Incorrect answer | Start заново, ответить q1a | verdict: incorrect, -heart |
| D5 | Next до end | Продолжить до end node | Lesson complete, summary |
| D6 | State version conflict | Отправить answer с устаревшим state_version | 409 |
| D7 | Idempotency | Повторить answer с тем же Idempotency-Key | Тот же результат, без дубликата |
| D8 | Retry completed | `POST .../retry` | Новая session, меньше XP |

### E. Student Runtime — Free Text (LLM)

| # | Что проверяем | Как | Ожидание |
|---|---|---|---|
| E1 | Free text correct | Пройти до pq2 в lesson_passwords, ответить `[llm:correct]` | verdict: correct |
| E2 | Free text partial | Ответить `[llm:partial]` | verdict: partial, partial XP |
| E3 | Free text incorrect | Ответить `[llm:incorrect]` | verdict: incorrect, -heart |
| E4 | LLM timeout | Ответить `[llm:timeout]` | 503 retryable error |
| E5 | LLM 500 | Ответить `[llm:500]` | 503 retryable error |
| E6 | LLM malformed | Ответить `[llm:malformed]` | 503, session state не повреждён |
| E7 | Retry after LLM error | Повторить answer после E4/E5/E6 | Нормальный результат |

### F. Gamification

| # | Что проверяем | Как | Ожидание |
|---|---|---|---|
| F1 | Game state | `GET /api/v1/student/game-state` | xp, hearts, streak, level |
| F2 | XP after correct | Проверить XP до и после correct answer | xp увеличился |
| F3 | Heart loss | Проверить hearts после incorrect | hearts -1 |
| F4 | Hearts floor | Много incorrect → hearts = 0 | Answer blocked |
| F5 | Streak | Проверить streak после lesson complete | streak_days = 1 |
| F6 | Heart recovery | Подождать PRAVO_HEARTS_RESTORE_MINUTES | Hearts восстановились |

### G. Course Authoring — Teacher

| # | Что проверяем | Как | Ожидание |
|---|---|---|---|
| G1 | List courses | `GET /api/v1/teacher/courses` | Видит свой курс |
| G2 | Create course | `POST /api/v1/teacher/courses` | 201, course_id |
| G3 | Get draft | `GET /api/v1/teacher/courses/{id}/draft` | content_json, draft_version |
| G4 | Update draft | `PUT .../draft` с правильным draft_version | 200 |
| G5 | Optimistic lock | PUT с устаревшим draft_version | 409 |
| G6 | Invalid graph: cycle | Node A → B → A | 422 |
| G7 | Invalid graph: unreachable | Node без входящих edges | 422 |
| G8 | Missing free_text transitions | free_text без всех 3 verdict transitions | 422 |
| G9 | Submit review | `POST .../submit-review` | pending review |
| G10 | Double submit | Повторить submit без resolve | 409 |

### H. Course Authoring — Admin (Platform)

| # | Что проверяем | Как | Ожидание |
|---|---|---|---|
| H1 | Create platform course | `POST /api/v1/admin/courses` | 201 |
| H2 | Direct publish | `POST /api/v1/admin/courses/{id}/publish` | Revision created |
| H3 | Re-publish | Обновить draft и publish | Новая revision, is_current=true |

### I. Moderation

| # | Что проверяем | Как | Ожидание |
|---|---|---|---|
| I1 | Queue | `GET /api/v1/admin/moderation/queue` | Pending reviews |
| I2 | Approve | `POST .../reviews/{id}/approve` | Course published |
| I3 | Reject | Создать новый teacher course → submit → reject | Draft → changes_requested |
| I4 | Reject comment | Проверить review comment | Комментарий сохранён |
| I5 | Re-submit after reject | Teacher edit → re-submit | Новый pending review |

### J. Preview

| # | Что проверяем | Как | Ожидание |
|---|---|---|---|
| J1 | Teacher preview | `POST /api/v1/teacher/courses/{id}/preview/start` | Preview session |
| J2 | Admin preview | `POST /api/v1/admin/courses/{id}/preview/start` | Preview session |
| J3 | Preview next/answer | Пройти preview | Работает как runtime |
| J4 | No side effects | Проверить course_progress | Не создался |

### K. Guardianship

| # | Что проверяем | Как | Ожидание |
|---|---|---|---|
| K1 | Parent list children | `GET /api/v1/parent/children` | student виден |
| K2 | Parent child progress | `GET /api/v1/parent/children/{id}/progress` | Progress данные |
| K3 | Unlinked parent | student2 не видна для parent | Не виден |
| K4 | Create new invite | `POST /api/v1/parent/guardian-invites` | token |
| K5 | student2 claims invite | `POST /student/guardian-invites/{token}/claim` | Link created |
| K6 | Max 2 parents | Третий parent claim для student | 409 |
| K7 | Revoke invite | `DELETE /parent/guardian-invites/{id}` | Revoked |

### L. Teacher Access (Private Courses)

| # | Что проверяем | Как | Ожидание |
|---|---|---|---|
| L1 | List links | `GET /teacher/courses/{id}/access-links` | 1 active link |
| L2 | Student claim link | `POST /student/course-links/{token}/claim` | Access granted |
| L3 | Teacher course visible | Student catalog после claim | Teacher course видна |
| L4 | Duplicate claim | Повторить L2 | Идемпотентно |
| L5 | Revoke link | `DELETE /teacher/courses/{id}/access-links/{id}` | Link revoked |
| L6 | Claim revoked link | Новый student пробует claim | 404/410 |
| L7 | Teacher sees students | `GET /teacher/courses/{id}/students` | Student в списке |

### M. Commerce

| # | Что проверяем | Как | Ожидание |
|---|---|---|---|
| M1 | Student purchase request | `POST /student/offers/{id}/purchase-requests` | 201, request_id |
| M2 | Duplicate request | Повторить M1 | 409 |
| M3 | Course tree after request | GET course tree | lesson_personal_data status change |
| M4 | Admin list requests | `GET /admin/commerce/purchase-requests` | Student request видна |
| M5 | Admin create order | `POST /admin/commerce/orders/manual` | 201, order_id |
| M6 | Student tree: awaiting | GET course tree | `awaiting_payment_confirmation` |
| M7 | Manual confirm | `POST /admin/commerce/orders/{id}/payments/manual-confirm` с Idempotency-Key | 200, entitlement created |
| M8 | Duplicate confirm | Повторить M7 с тем же Idempotency-Key | 200, no-op |
| M9 | Student tree: granted | GET course tree | `granted`, lesson accessible |
| M10 | Start paid lesson | `POST /student/.../lesson_personal_data/start` | Session created |
| M11 | Complimentary grant | Admin grant без payment | Entitlement created |
| M12 | Revoke entitlement | Admin revoke | Session terminated, access blocked |
| M13 | Teacher offer rejected | Admin create offer for teacher course | 422/403 |

### N. Admin

| # | Что проверяем | Как | Ожидание |
|---|---|---|---|
| N1 | User list | `GET /api/v1/admin/users` | Все аккаунты |
| N2 | User detail | `GET /api/v1/admin/users/{id}` | Детали аккаунта |
| N3 | Commerce orders | `GET /api/v1/admin/commerce/orders` | Список заказов |
| N4 | Offer list | `GET /api/v1/admin/commerce/offers` | Active offers |

### O. ACL / Security

| # | Что проверяем | Как | Ожидание |
|---|---|---|---|
| O1 | Student → admin | Student calls admin endpoint | 403 |
| O2 | Student → teacher | Student calls teacher endpoint | 403 |
| O3 | Teacher → admin | Teacher calls admin endpoint | 403 |
| O4 | Parent → student runtime | Parent calls start lesson | 403 |
| O5 | No cookie | Any authenticated endpoint без cookie | 401 |
| O6 | Missing CSRF | Mutating endpoint без X-CSRF-Token | 403 |
| O7 | Block account | Admin blocks student → student calls API | 403 account_blocked |

---

## Порядок прохождения

Рекомендуемый порядок для полного прохода:

1. **A1-A10** — Auth (можно частично на свежем аккаунте, не из seed)
2. **B1-B5** — Profiles
3. **C1-C6** — Catalog и tree (проверяем seed data)
4. **D1-D8** — Runtime single_choice (lesson_phishing)
5. **E1-E7** — Runtime free_text (lesson_passwords)
6. **F1-F6** — Gamification (по ходу D и E)
7. **K1-K7** — Guardianship
8. **L1-L7** — Teacher access links
9. **M1-M13** — Commerce (полный paid flow)
10. **G1-G10** — Authoring teacher
11. **H1-H3** — Authoring admin
12. **I1-I5** — Moderation
13. **J1-J4** — Preview
14. **N1-N4** — Admin operations
15. **O1-O7** — Security / ACL

---

## Curl-примеры

### Аутентификация (новый пользователь)

```bash
# Шаг 1: Начать SSO flow
curl -v -c cookies.txt http://localhost:8080/api/v1/auth/sso/yandex/start
# Следуйте redirect в Location → Mock Yandex ID покажет страницу выбора пользователя
# (реальный OAuth2: /authorize → выбор user → callback с code → backend обменивает code на token)

# Шаг 2: Получить session
curl -b cookies.txt http://localhost:8080/api/v1/session | jq .

# Шаг 3: Выбрать роль
CSRF=$(curl -sS -b cookies.txt http://localhost:8080/api/v1/session | jq -r .csrf_token)
curl -b cookies.txt -X POST http://localhost:8080/api/v1/onboarding/role \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: $CSRF" \
  -d '{"role":"student"}'
```

### Прохождение урока

```bash
# Использовать cookies из seed
JAR=/tmp/.../student.txt
CSRF=<csrf из seed>

# Start lesson
curl -b $JAR -X POST http://localhost:8080/api/v1/student/courses/$COURSE_ID/lessons/lesson_phishing/start \
  -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF" | jq .

# Next (story node)
curl -b $JAR -X POST http://localhost:8080/api/v1/student/lesson-sessions/$SESSION_ID/next \
  -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF" \
  -d '{"state_version": 1, "node_id": "s1"}' | jq .

# Answer (single_choice)
curl -b $JAR -X POST http://localhost:8080/api/v1/student/lesson-sessions/$SESSION_ID/answer \
  -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF" \
  -H "Idempotency-Key: ans-001" \
  -d '{"state_version": 2, "node_id": "q1", "answer": {"kind": "single_choice", "option_id": "q1b"}}' | jq .

# Answer (free_text — force correct verdict)
curl -b $JAR -X POST http://localhost:8080/api/v1/student/lesson-sessions/$SESSION_ID/answer \
  -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF" \
  -H "Idempotency-Key: ans-002" \
  -d '{"state_version": 3, "node_id": "pq2", "answer": {"kind": "free_text", "text": "потому что это нельзя [llm:correct]"}}' | jq .
```

### Commerce flow

```bash
ADMIN_JAR=/tmp/.../admin.txt
STUDENT_JAR=/tmp/.../student.txt

# Student: purchase request
curl -b $STUDENT_JAR -X POST http://localhost:8080/api/v1/student/offers/$OFFER_ID/purchase-requests \
  -H "Content-Type: application/json" -H "X-CSRF-Token: $STUDENT_CSRF" | jq .

# Admin: create order
curl -b $ADMIN_JAR -X POST http://localhost:8080/api/v1/admin/commerce/orders/manual \
  -H "Content-Type: application/json" -H "X-CSRF-Token: $ADMIN_CSRF" \
  -d "{\"student_id\":\"$STUDENT_ID\",\"offer_id\":\"$OFFER_ID\"}" | jq .

# Admin: confirm payment
curl -b $ADMIN_JAR -X POST http://localhost:8080/api/v1/admin/commerce/orders/$ORDER_ID/payments/manual-confirm \
  -H "Content-Type: application/json" -H "X-CSRF-Token: $ADMIN_CSRF" \
  -H "Idempotency-Key: pay-001" \
  -d '{"external_reference":"cash-001","amount_minor":49000,"currency":"RUB","paid_at":"2026-03-15T12:00:00Z"}' | jq .
```
