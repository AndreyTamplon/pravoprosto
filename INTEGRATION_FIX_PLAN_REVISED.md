# Revised Integration Fix Plan

## Scope

Этот план заменяет `INTEGRATION_FIX_PLAN.md`.

Основания:
- аудит текущей фронтенд-бекенд интеграции
- аудит тестового покрытия из `/tmp/codex-audit-tests.md`
- замечания к старому плану по preview, draft save semantics, admin courses, profile PUT и test strategy

## Rules

1. Чиним реальные контракты, а не маскируем их фронтенд-дефолтами.
2. Не смешиваем preview DTO и runtime lesson DTO.
3. Router state не может быть source of truth для preview.
4. Для критичных flows acceptance gate = executable tests и contract assertions.
5. AI-review допустим только как дополнительная проверка после зелёных тестов.

## P0 — Broken Flows And Data Loss

### 1. Preview contract: привести preview к отдельной модели, не к `StepView` / `AnswerOutcome`

Проблемы:
- `createTeacherPreview` / `createAdminPreview` ждут `StepView`, backend возвращает `PreviewStepEnvelope`
- `previewNext` тоже неверно типизирован и тоже получает envelope
- `previewAnswer` сейчас типизирован как runtime `AnswerOutcome`, хотя backend возвращает `PreviewAnswerOutcome`
- `PreviewPlayer` использует student endpoint `getSessionById()`
- `PreviewPlayer` не умеет корректно рендерить `node_kind = "end"`
- admin preview открывается через `window.open`, поэтому решение через `location.state` неприемлемо

Решение:
- Backend:
  - добавить `GET /api/v1/preview-sessions/{previewSessionID}`
  - возвращать dedicated preview DTO, например `PreviewSessionView { preview, preview_session_id, step }`
  - оставить `POST /preview-sessions/{id}/next` и `POST /preview-sessions/{id}/answer` в dedicated preview shape
- Frontend:
  - добавить типы `PreviewSessionView`, `PreviewStepEnvelope`, `PreviewAnswerView`
  - `createTeacherPreview`, `createAdminPreview`, `getPreviewSession`, `previewNext`, `previewAnswer` типизировать preview-типами
  - `previewNext` перестать отправлять `expected_node_id`, потому что backend его не читает
  - `PreviewPlayer` всегда загружает текущий preview step по `previewSessionId`
  - `PreviewPlayer` отдельно обрабатывает `story`, `single_choice`, `free_text`, `end`
  - completion в preview определять по `node_kind === "end"` и/или отсутствию `next_step`, а не через синтетический `next_action`

Файлы:
- [frontend/src/api/client.ts](/Users/aatamplon/PycharmProjects/hse/pravoprost/frontend/src/api/client.ts)
- [frontend/src/api/types.ts](/Users/aatamplon/PycharmProjects/hse/pravoprost/frontend/src/api/types.ts)
- [frontend/src/pages/teacher/PreviewPlayer.tsx](/Users/aatamplon/PycharmProjects/hse/pravoprost/frontend/src/pages/teacher/PreviewPlayer.tsx)
- [backend/internal/httpserver/router.go](/Users/aatamplon/PycharmProjects/hse/pravoprost/backend/internal/httpserver/router.go)
- [backend/internal/courses/service.go](/Users/aatamplon/PycharmProjects/hse/pravoprost/backend/internal/courses/service.go)

### 2. Moderation preview: убрать фейковый `lesson_id = "first"`

Проблема:
- moderation сейчас вызывает `createAdminPreview(review.course_id, 'first')`

Решение:
- при открытии moderation modal получать draft курса и определять реальный preview target:
  - либо автоматически брать первый реальный lesson id из `content_json.modules[].lessons`
  - либо дать явный selector lesson внутри modal
- если уроков нет, preview CTA disabled с понятным сообщением

Файлы:
- [frontend/src/pages/admin/Moderation.tsx](/Users/aatamplon/PycharmProjects/hse/pravoprost/frontend/src/pages/admin/Moderation.tsx)
- [frontend/src/api/client.ts](/Users/aatamplon/PycharmProjects/hse/pravoprost/frontend/src/api/client.ts)

### 3. Claim links for unauthenticated users: сохранить полный intended URL включая hash

Проблема:
- hash теряется до login flow, потому что `RequireAuth` редиректит на `/auth`
- фикс только в `AuthContext.login()` недостаточен

Решение:
- при заходе на защищённый route без сессии сохранять полный intended URL:
  - `pathname + search + hash`
  - через query `?return_to=` или `sessionStorage`
- `AuthPage` должен передавать именно сохранённый `return_to` в `login()`
- `login()` должен использовать этот `return_to`, а не только текущий `/auth`
- проверить teacher/course claim и guardian claim

Файлы:
- [frontend/src/App.tsx](/Users/aatamplon/PycharmProjects/hse/pravoprost/frontend/src/App.tsx)
- [frontend/src/contexts/AuthContext.tsx](/Users/aatamplon/PycharmProjects/hse/pravoprost/frontend/src/contexts/AuthContext.tsx)
- [frontend/src/pages/public/AuthPage.tsx](/Users/aatamplon/PycharmProjects/hse/pravoprost/frontend/src/pages/public/AuthPage.tsx)

### 4. Lesson editor save semantics: полный payload + актуальный `draft_version`

Проблемы:
- lesson editors шлют partial PUT против full-replacement backend DTO
- repeated save/preview используют stale `draft_version`

Решение:
- на фронте убрать возможность partial draft update для lesson editors
- в editor save helper всегда отправлять полный `UpdateDraftInput`:
  - `draft_version`
  - `title`
  - `description`
  - `age_min`
  - `age_max`
  - `cover_asset_id`
  - `content_json`
- после успешного save обновлять локальный `draft_version` из ответа
- preview должен использовать только fresh version после save
- по возможности вынести общий builder полного draft payload, чтобы не дублировать логику между admin/teacher

Файлы:
- [frontend/src/api/client.ts](/Users/aatamplon/PycharmProjects/hse/pravoprost/frontend/src/api/client.ts)
- [frontend/src/pages/teacher/LessonConstructor.tsx](/Users/aatamplon/PycharmProjects/hse/pravoprost/frontend/src/pages/teacher/LessonConstructor.tsx)
- [frontend/src/pages/admin/AdminLessonEditor.tsx](/Users/aatamplon/PycharmProjects/hse/pravoprost/frontend/src/pages/admin/AdminLessonEditor.tsx)

### 5. Teacher students pages: починить list и detail

Проблемы:
- students list читает `items`, backend отдаёт `students`
- student detail ждёт flat shape, backend отдаёт `{ student, summary, lessons }`

Решение:
- `getTeacherStudents()` читать key `students`
- `getTeacherStudentDetail()` делать явную нормализацию nested DTO
- не рисовать synthetic fields, которых backend не отдаёт
- если summary нужен UI, типизировать его отдельно, не прятать в flat detail

Файлы:
- [frontend/src/api/client.ts](/Users/aatamplon/PycharmProjects/hse/pravoprost/frontend/src/api/client.ts)
- [frontend/src/api/types.ts](/Users/aatamplon/PycharmProjects/hse/pravoprost/frontend/src/api/types.ts)
- [frontend/src/pages/teacher/StudentsProgress.tsx](/Users/aatamplon/PycharmProjects/hse/pravoprost/frontend/src/pages/teacher/StudentsProgress.tsx)
- [frontend/src/pages/teacher/StudentDetail.tsx](/Users/aatamplon/PycharmProjects/hse/pravoprost/frontend/src/pages/teacher/StudentDetail.tsx)

### 6. Teacher access links: создать корректный request и выровнять create/list contract

Проблемы:
- create endpoint падает на пустом body
- create/list backend shape = `claim_url`, frontend shape = `invite_url`
- `created_at` сейчас не нужен UI, но тип фронта требует его

Решение:
- `createTeacherAccessLink()` отправляет `{}` как body
- frontend normalizer для create/list:
  - `claim_url -> invite_url`
  - `created_at` сделать optional или убрать из `AccessLink`, если UI его не использует
- не добавлять лишние backend поля только ради type fiction

Файлы:
- [frontend/src/api/client.ts](/Users/aatamplon/PycharmProjects/hse/pravoprost/frontend/src/api/client.ts)
- [frontend/src/api/types.ts](/Users/aatamplon/PycharmProjects/hse/pravoprost/frontend/src/api/types.ts)
- [frontend/src/pages/teacher/CourseConstructor.tsx](/Users/aatamplon/PycharmProjects/hse/pravoprost/frontend/src/pages/teacher/CourseConstructor.tsx)

### 7. Commerce request -> order: отправлять `purchase_request_id`

Проблема:
- request-based manual order creation шлёт `request_id`, backend ждёт `purchase_request_id`

Решение:
- починить payload в `Commerce.tsx`
- дополнительно типизировать `createManualOrder()` на фронте, чтобы этот класс ошибок не повторялся

Файлы:
- [frontend/src/pages/admin/Commerce.tsx](/Users/aatamplon/PycharmProjects/hse/pravoprost/frontend/src/pages/admin/Commerce.tsx)
- [frontend/src/api/client.ts](/Users/aatamplon/PycharmProjects/hse/pravoprost/frontend/src/api/client.ts)

### 8. Free-text graph compatibility: чинить и запись, и чтение

Проблема:
- frontend пишет `reference_answer`, backend preview/runtime читает `referenceAnswer`
- frontend reread backend graph тоже ждёт `reference_answer`

Решение:
- `graphToBackendFormat()` писать `rubric.referenceAnswer`
- `graphFromBackendFormat()` читать оба варианта:
  - `referenceAnswer`
  - `reference_answer`
- сохранить backward compatibility для уже существующих черновиков

Файлы:
- [frontend/src/api/types.ts](/Users/aatamplon/PycharmProjects/hse/pravoprost/frontend/src/api/types.ts)

## P1 — Contract Alignment And Data Integrity

### 9. Review status: нормализовать `current | null`

Решение:
- `getTeacherReviewStatus()` должен unwrap `raw.current`
- если `current === null`, возвращать фронту `{ status: 'none' }`
- не оставлять `ReviewStatus.status` обязательным без нормализации

### 10. Admin courses list: backend должен вернуть реально все курсы, а не только platform

Проблемы:
- admin page фильтрует `all/platform/teacher` клиентом
- backend admin branch сейчас возвращает только platform courses
- counts и `created_at` тоже неполные

Решение:
- расширить admin `ListCourses()`:
  - platform + teacher-owned courses
  - `owner_kind`
  - `course_kind`
  - `current_revision_id`
  - `lesson_count`
  - `student_count`
  - `created_at`
  - согласованный status

Файлы:
- [backend/internal/courses/service.go](/Users/aatamplon/PycharmProjects/hse/pravoprost/backend/internal/courses/service.go)
- [frontend/src/api/client.ts](/Users/aatamplon/PycharmProjects/hse/pravoprost/frontend/src/api/client.ts)
- [frontend/src/pages/admin/AdminCourses.tsx](/Users/aatamplon/PycharmProjects/hse/pravoprost/frontend/src/pages/admin/AdminCourses.tsx)

### 11. Admin users: убрать synthetic `active`, вернуть реальные поля

Решение:
- backend `ListUsers` должен вернуть:
  - `status`
  - `email` или явно задокументированное отсутствие email
  - `created_at` в одном имени поля
- frontend перестаёт синтезировать `status: active`

Файлы:
- [backend/internal/identity/service.go](/Users/aatamplon/PycharmProjects/hse/pravoprost/backend/internal/identity/service.go)
- [frontend/src/api/client.ts](/Users/aatamplon/PycharmProjects/hse/pravoprost/frontend/src/api/client.ts)
- [frontend/src/pages/admin/AdminUsers.tsx](/Users/aatamplon/PycharmProjects/hse/pravoprost/frontend/src/pages/admin/AdminUsers.tsx)

### 12. Commerce list DTOs: добрать реальные поля, которые UI уже использует

Решение:
- `ListOffers` вернуть:
  - `description`
  - `created_at`
  - `course_title`
  - `lesson_title`
- `ListPurchaseRequests` вернуть `target_type`
- `ListOrders` вернуть:
  - `target_type`
  - `fulfilled_at`
  - при необходимости `offer_id`

Файлы:
- [backend/internal/commerce/service.go](/Users/aatamplon/PycharmProjects/hse/pravoprost/backend/internal/commerce/service.go)
- [frontend/src/api/client.ts](/Users/aatamplon/PycharmProjects/hse/pravoprost/frontend/src/api/client.ts)
- [frontend/src/pages/admin/Commerce.tsx](/Users/aatamplon/PycharmProjects/hse/pravoprost/frontend/src/pages/admin/Commerce.tsx)

### 13. Parent invites list: добавить URL support с явной стратегией для legacy invites

Проблемы:
- create response даёт URL, list — нет
- для уже существующих `token_hash` invites URL не восстановить

Решение:
- backend schema:
  - добавить `token_encrypted` для guardian invites
  - новые invite’ы создавать с `token_hash + token_encrypted`
- backend list:
  - если `token_encrypted` есть, возвращать `invite_url`
  - если нет, явно возвращать legacy marker, а не пустую строку как будто всё ок
- product behavior для legacy active invites:
  - показать, что URL недоступен
  - дать revoke + recreate flow
  - это должно быть явно описано и покрыто тестом

Файлы:
- [backend/internal/guardianship/service.go](/Users/aatamplon/PycharmProjects/hse/pravoprost/backend/internal/guardianship/service.go)
- миграция БД
- [frontend/src/api/client.ts](/Users/aatamplon/PycharmProjects/hse/pravoprost/frontend/src/api/client.ts)
- [frontend/src/pages/parent/Dashboard.tsx](/Users/aatamplon/PycharmProjects/hse/pravoprost/frontend/src/pages/parent/Dashboard.tsx)

### 14. Profile update semantics: убрать риск потери аватара на backend

Проблемы:
- текущий frontend не знает `avatar_asset_id`
- PUT name/org updates могут стереть avatar
- это data-loss риск, а не cosmetic P2

Решение:
- backend profile update сделать presence-aware:
  - omission `avatar_asset_id` = сохранить текущее значение
  - explicit clear = отдельное намеренное действие
- если позже понадобится полноценное редактирование avatar, отдельно добавить `avatar_asset_id` в GET DTO и UI control
- не полагаться на “фронт начнёт отправлять текущий asset id”, пока его негде взять

Файлы:
- [backend/internal/profiles/service.go](/Users/aatamplon/PycharmProjects/hse/pravoprost/backend/internal/profiles/service.go)
- [backend/internal/httpserver/router.go](/Users/aatamplon/PycharmProjects/hse/pravoprost/backend/internal/httpserver/router.go)

### 15. Course tree / promo / parent progress: выровнять backend DTO, не скрывать данные

Решение:
- `student/course tree`:
  - добавить top-level `progress`
  - добавить `has_open_request` в offer view
- `public/promo-courses`:
  - вернуть `age_min`, `age_max`, `lesson_count`
- `parent/children`:
  - вернуть `courses_in_progress`, `courses_completed`
- `parent/children/{id}/progress`:
  - вернуть реальные `status`, `completed_lessons`, `total_lessons`, `correct_answers`, `partial_answers`, `incorrect_answers`, `last_activity_at`
- убрать frontend fabrication там, где backend уже можно обогатить

Файлы:
- [backend/internal/lessonruntime/service.go](/Users/aatamplon/PycharmProjects/hse/pravoprost/backend/internal/lessonruntime/service.go)
- [backend/internal/lessonruntime/helpers.go](/Users/aatamplon/PycharmProjects/hse/pravoprost/backend/internal/lessonruntime/helpers.go)
- [backend/internal/courses/service.go](/Users/aatamplon/PycharmProjects/hse/pravoprost/backend/internal/courses/service.go)
- [backend/internal/guardianship/service.go](/Users/aatamplon/PycharmProjects/hse/pravoprost/backend/internal/guardianship/service.go)
- [frontend/src/api/client.ts](/Users/aatamplon/PycharmProjects/hse/pravoprost/frontend/src/api/client.ts)

## P2 — Test And Selector Hardening

### 16. Add real golden-path specs under existing `e2e/tests` tree

Новые spec’и:
- `e2e/tests/integration/teacher-lifecycle.spec.ts`
  - teacher create draft -> fill modules/lessons -> save -> submit review -> admin approve -> share link -> student claim -> teacher sees student
- `e2e/tests/integration/student-full-course.spec.ts`
  - catalog -> course tree -> single-choice -> unlock next lesson -> free-text -> back to tree/profile
- `e2e/tests/integration/parent-bind-and-progress.spec.ts`
  - parent create invite -> student claim real hash URL -> reload parent dashboard -> child appears -> child progress updates after lesson
- `e2e/tests/integration/admin-commerce-e2e.spec.ts`
  - create/edit offer -> student request -> admin order from request -> confirm payment -> paid lesson unlocked -> optional revoke
- `e2e/tests/integration/lesson-editor-all-node-types.spec.ts`
  - story + single_choice + free_text + terminal -> save -> reopen -> persistence -> preview walkthrough
- `e2e/tests/integration/admin-preview-and-moderation.spec.ts`
  - admin preview from course editor
  - admin preview from lesson editor
  - moderation preview with real lesson id
  - reload/direct preview URL works

### 17. Rewrite weak QA regression tests instead of treating them as protection

Переписать:
- `e2e/tests/qa-regression/01-claim-links.spec.ts`
  - не route smoke, а real claim flow с valid token и reload
- `e2e/tests/qa-regression/02-lesson-editor-save.spec.ts`
  - добавить repeated save
  - добавить stale `draft_version` guard
  - проверять `referenceAnswer`, а не только `kind`
- `e2e/tests/qa-regression/03-commerce-data.spec.ts`
  - hard preconditions, никаких noop pass branch
  - network assertion на `purchase_request_id`
- `e2e/tests/qa-regression/04-teacher-progress-fields.spec.ts`
  - проверять реальный `teacher/courses/:id/students` и detail page
- `e2e/tests/qa-regression/05-age-validation.spec.ts`
  - реально кликать publish
  - проверять published result, а не только save

### 18. Stabilize selectors and helpers

Решение:
- добавить стабильные `data-testid` или хорошие accessible names для:
  - course cards
  - lesson nodes
  - preview controls
  - request rows / order rows / offer rows
  - access-link rows
  - claim success/error states
  - profile edit controls
- убрать reliance на CSS-module selectors и `.first()` без scope
- обновить или удалить устаревшие helper’ы:
  - `e2e/helpers/lesson-walker.ts`
  - `e2e/helpers/assertions.ts`

### 19. Test discipline

Требования:
- никаких `if (hasX) { assert } else { pass }` для critical regressions
- никаких `waitForTimeout` там, где можно ждать request/response/state
- создавать own data per spec, не опираться на shared mutable state
- deep links использовать только в smoke tests, не в golden paths

## Delivery Order

### Wave 1
- P0.1 preview contract
- P0.2 moderation preview
- P0.3 claim-link redirect preservation

### Wave 2
- P0.4 draft save semantics
- P0.5 teacher students list/detail
- P0.6 teacher access links
- P0.7 commerce `purchase_request_id`
- P0.8 graph read/write compatibility

### Wave 3
- P1.9 review status
- P1.10 admin courses
- P1.11 admin users
- P1.12 commerce list DTOs
- P1.13 parent invites + legacy strategy
- P1.14 profile update semantics
- P1.15 course tree / promo / parent DTO enrichment

### Wave 4
- P2 tests and selectors

## Acceptance Gates

### Contract tests
- добавить backend HTTP/integration tests для:
  - preview create/get/next/answer JSON shape
  - teacher students list/detail
  - admin courses list
  - admin commerce list endpoints
  - parent invite list with encrypted token and legacy invite behavior
  - profile update omission semantics for avatar

### Frontend / backend build
1. `cd frontend && npx tsc --noEmit`
2. `cd backend && go build ./cmd/server ./cmd/mockserver`
3. `cd backend && go test ./...`

### Playwright
4. `cd e2e && npx playwright test`
5. повторный прогон критичных integration specs

### Optional extra review
6. дополнительный AI-review допустим только после зелёных шагов 1-5

## Done Means

Работа считается завершённой, когда одновременно выполнено всё:
- preview работает у teacher и admin, включая reload/direct URL и moderation
- lesson editors сохраняют без data loss и без stale version conflicts
- claim links survive unauthenticated SSO path с hash token
- teacher/admin/parent/commerce списки больше не зависят от synthetic frontend defaults
- profile name/org updates не могут молча стереть avatar
- новые integration specs и переписанные regression specs зелёные
