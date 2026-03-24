# Системное исправление фронтенд-бекенд интеграции — Право Просто

## Context

Ручной QA нашёл 7 багов → мы их починили → 74/74 тестов зелёные. Затем два codex-аудита (GPT-5.4) нашли ещё **~20 расхождений**. Три Claude-агента верифицировали каждое. Корень проблемы: фронтенд писался по спецификации, а не по реальным backend DTO.

Подход: фиксы группами по приоритету → E2E тесты → валидация.

---

## P0 — Функционал полностью сломан (8 issues)

### 1. Preview API (3 sub-issues)
- **1a**: `createTeacherPreview`/`createAdminPreview` типизированы как `StepView`, бекенд возвращает `PreviewStepEnvelope {preview, preview_session_id, step}`. Навигация → `/teacher/preview/undefined`
- **1b**: `PreviewPlayer.tsx` вызывает `getSessionById()` (student endpoint), preview сессии там нет → 404
- **1c**: `previewAnswer` ожидает `AnswerOutcome` с `xp_delta/hearts_delta/next_action`, бекенд возвращает `PreviewAnswerOutcome` без них

**Фикс**: frontend/src/api/client.ts, types.ts, PreviewPlayer.tsx, LessonConstructor.tsx, AdminLessonEditor.tsx
- Добавить типы `PreviewStepEnvelope`, `PreviewAnswerOutcome`
- `createTeacherPreview` → unwrap envelope, вернуть `{preview_session_id, step}`
- Навигация через `navigate(path, { state: { step } })`
- PreviewPlayer: читать initial step из `useLocation().state`, не вызывать student endpoint
- `previewAnswer`: маппить к AnswerOutcome-compatible (defaults: xp_delta=0, next_action из next_step)

### 2. Teacher students list пустой
- `getList()` дефолт key `"items"`, бекенд `StudentsView` использует `"students"`

**Фикс**: client.ts:218 — `getList(..., 'students')`

### 3. Teacher student detail падает
- Бекенд: `{student: {display_name}, summary: {...}, lessons: [...]}`
- Фронт: `data.display_name` → undefined → `.charAt(0)` crash

**Фикс**: client.ts getTeacherStudentDetail — unwrap nested `raw.student`, `raw.summary`

### 4. Commerce order from request — неверное поле
- Фронт: `request_id`, бекенд: `purchase_request_id`

**Фикс**: Commerce.tsx:276 — `purchase_request_id: req.request_id`

### 5. Graph rubric key — snake vs camelCase
- Фронт пишет `rubric.reference_answer`, бекенд читает `rubric.referenceAnswer`
- LLM не получает эталонный ответ при оценке free text

**Фикс**: types.ts graphToBackendFormat: `referenceAnswer` вместо `reference_answer`

### 6. Claim link hash теряется при SSO redirect
- `RequireAuth` → `/auth`, `login()` строит `return_to` без `location.hash`
- Неавторизованный юзер с claim link → SSO → попадает на главную, не на claim

**Фикс**: AuthContext.tsx:38 — добавить `window.location.hash` в returnTo

### 7. Teacher access link creation — пустое тело
- `createTeacherAccessLink()` вызывает `post()` без body → `undefined` → бекенд json.Decode EOF → 400
- Учитель не может поделиться ссылкой на курс

**Фикс**: client.ts:214 — `post<...>(url, {})` (пустой объект вместо undefined)

### 8. Teacher draft partial update обнуляет метаданные
- LessonConstructor.tsx шлёт только `{draft_version, content_json}` в PUT draft
- Бекенд `UpdateDraftInput` требует полный payload — перезаписывает title/description/age/cover нулями

**Фикс**: LessonConstructor.tsx и AdminLessonEditor.tsx — при сохранении включать ВСЕ поля draft (title, description, age_min, age_max, cover_asset_id) из загруженного draft

---

## P1 — Функционал деградирован (6 issues)

### 9. Teacher review status — nested shape
- Бекенд: `{current: {...}, history: []}`, фронт: `reviewStatus?.status` → undefined

**Фикс**: client.ts getTeacherReviewStatus — unwrap `raw.current`

### 10. Teacher access links — claim_url vs invite_url + missing created_at
- Бекенд отдаёт `claim_url`, фронт type ожидает `invite_url` + `created_at`

**Фикс**: client.ts getTeacherAccessLinks — map `claim_url → invite_url`; тип уже совместим для create, нужен маппинг для list

### 11. Admin users — missing status
- Бекенд не возвращает `status` → все "active"

**Фикс**: backend/internal/identity/service.go ListUsers — добавить `a.status` в SELECT

### 12. Offers list — missing description/titles/created_at
- Бекенд list не JOIN-ит курсы/уроки, не возвращает описание

**Фикс**: backend/internal/commerce/service.go ListOffers — добавить JOINs и столбцы

### 13. Parent invites list — missing claim_url
- Только при создании возвращается URL, в списке нет (token_hash не обратим)

**Фикс**: backend — добавить `token_encrypted` столбец в миграции + шифровать при создании + расшифровывать в list

### 14. Admin courses list — missing lesson_count/student_count
- Бекенд не считает

**Фикс**: backend/internal/courses/service.go ListCourses — добавить subqueries

---

## P2 — Data gaps (отображаются дефолты, не crashит)

| # | Проблема | Решение |
|---|----------|---------|
| 15 | Promo courses: нет `age_min`/`lesson_count` | Frontend: убрать отображение отсутствующих полей |
| 16 | Parent children: `courses_in_progress = 0` всегда | Frontend: убрать или показывать что есть |
| 17 | Child progress: fabricated counts | Frontend: показывать только то что бекенд отдаёт |
| 18 | Course tree offer: нет `has_open_request` | Backend: добавить поле в offer view |
| 19 | Profile PUTs: partial body может обнулить avatar | Frontend: включать текущий avatar_asset_id |
| 20 | Orders/requests: нет `target_type`, `fulfilled_at` | Backend: добавить в list queries |

---

## Порядок реализации

### Волна 1: Быстрые P0 frontend-only (issues 2, 3, 4, 5, 7)
5 однострочных/малых правок. ~15 минут.

### Волна 2: P0 Draft partial update (issue 8)
LessonConstructor.tsx и AdminLessonEditor.tsx — при save включать все поля draft. ~10 минут.

### Волна 3: P0 Preview system (issue 1)
Самый сложный. Новые типы, unwrap в client.ts, переписать PreviewPlayer. ~30 минут.

### Волна 4: P0 Auth redirect (issue 6)
AuthContext.tsx — включить hash в returnTo. ~5 минут.

### Волна 5: P1 Frontend normalizers (issues 9, 10)
client.ts — unwrap review status, map access link URLs. ~10 минут.

### Волна 6: P1 Backend fixes (issues 11, 12, 13, 14)
Go SQL queries — добавить поля и JOINs. ~30 минут.

### Волна 7: P2 cleanup
Frontend — убрать отображение отсутствующих полей, добавить avatar_asset_id в PUT. ~15 минут.

---

## E2E тесты

### Подход
- **Обязательные предусловия** вместо `if (hasX)` — тест setup должен гарантировать данные или `test.fail()`
- **Network inspection** для contract-critical flows (graph format, payment, order creation)
- **Проверка бизнес-результата**, а не "страница не 404"

### Новые тесты

| Test file | Что покрывает | Issues |
|-----------|---------------|--------|
| `tests/integration/teacher-lifecycle.spec.ts` | Create course → add module/lesson → save → submit review → admin approve → share link → student claim → teacher sees student | 1,2,3,7,8,9,10 |
| `tests/integration/preview-flow.spec.ts` | Teacher: click preview → story → answer → completion | 1 |
| `tests/integration/commerce-e2e.spec.ts` | Create offer → student request → admin order from request → confirm payment → lesson unlocks → student starts | 4,12 |
| `tests/integration/parent-bind.spec.ts` | Parent invite → student claims hash URL → parent sees new child | 6,13 |

### Усиление существующих

| Existing test | Что усилить |
|---------------|-------------|
| `qa-regression/02-lesson-editor-save` | Проверить что save не обнуляет title (issue 8), rubric key = referenceAnswer (issue 5) |
| `qa-regression/03-commerce-data` | Обязательные предусловия вместо `if`, `purchase_request_id` в network inspection (issue 4) |
| `qa-regression/04-teacher-progress-fields` | Реальный populated table с данными (issue 2) |

---

## Верификация

1. `npx tsc --noEmit` — TypeScript чист
2. `go build ./cmd/server && go build ./cmd/mockserver` — Go чист
3. `cd e2e && npx playwright test` — все тесты зелёные
4. Повторный прогон — стабильность
5. Claude агенты-валидаторы: проверка каждого фикса против backend DTO
6. Codex повторный аудит → 0 critical/high issues

---

## Ключевые файлы

| Файл | Issues |
|------|--------|
| `frontend/src/api/client.ts` | 1,2,3,7,9,10 |
| `frontend/src/api/types.ts` | 1,5 |
| `frontend/src/pages/teacher/PreviewPlayer.tsx` | 1 |
| `frontend/src/pages/teacher/LessonConstructor.tsx` | 1,8 |
| `frontend/src/pages/admin/AdminLessonEditor.tsx` | 1,8 |
| `frontend/src/pages/admin/Commerce.tsx` | 4 |
| `frontend/src/contexts/AuthContext.tsx` | 6 |
| `backend/internal/identity/service.go` | 11 |
| `backend/internal/commerce/service.go` | 12 |
| `backend/internal/guardianship/service.go` | 13 |
| `backend/internal/courses/service.go` | 14 |
