# Право Просто — Backend Test Plan

## Цель

- У проекта не будет ручного QA.
- Следовательно, backend должен приниматься в эксплуатацию только через автоматические тесты.
- Этот документ фиксирует такой набор backend-тестов, который должен заменить ручную приемку для MVP.

## Важная оговорка

- Абсолютная `100%` гарантия в инженерном смысле недостижима.
- Реалистичная цель: сделать такой автоматический quality gate, после прохождения которого:
  - все известные продуктовые сценарии покрыты;
  - все критичные инварианты БД, API и доменной логики проверяются автоматически;
  - все внешние интеграции либо тестируются через controlled fake, либо через контрактный слой;
  - регресс в backend-сценариях практически не сможет пройти незамеченным.

Для этого MVP приемка backend-а запрещается без прохождения полного набора тестов из этого документа.

## Scope

Покрываем:

- HTTP API из [API_SPEC.md](/Users/aatamplon/PycharmProjects/hse/pravoprost/API_SPEC.md)
- доменные правила из [ARCHITECTURE.md](/Users/aatamplon/PycharmProjects/hse/pravoprost/ARCHITECTURE.md)
- persistence-инварианты из [DB_SCHEMA.md](/Users/aatamplon/PycharmProjects/hse/pravoprost/DB_SCHEMA.md)
- продуктовые сценарии из [USER_STORIES.md](/Users/aatamplon/PycharmProjects/hse/pravoprost/USER_STORIES.md)
- UI-критичные backend DTO и state transitions из [UI_PLAN.md](/Users/aatamplon/PycharmProjects/hse/pravoprost/UI_PLAN.md)

Не покрываем этим документом:

- frontend rendering details
- visual regression
- browser E2E
- production infra

## Принцип приемки

Backend считается готовым только если одновременно выполнены все условия:

1. Все migration tests проходят на реальном PostgreSQL.
2. Все integration tests проходят против реального PostgreSQL.
3. Все HTTP integration tests проходят через поднятый app instance.
4. Все concurrency/idempotency tests проходят стабильно.
5. Все contract tests с mock LLM проходят.
6. Нет flaky tests в repeated run.
7. Есть coverage report по критичным backend package-ам.

## Базовая стратегия

Основной упор делаем на 3 слоя:

1. `integration tests` против реального Postgres и реального application wiring.
2. `HTTP scenario tests` через API, чтобы проверять end-to-end backend use cases.
3. `contract tests` для OpenAI-compatible LLM adapter через mock HTTP server.

Дополнительно нужны:

4. `migration tests`
5. `concurrency/idempotency tests`
6. `policy/unit tests` для узких чистых правил, где дешевле тестировать изолированно

## Обязательная тестовая инфраструктура

### 1. Реальный PostgreSQL

Требование:

- тесты используют настоящий PostgreSQL, а не sqlite и не in-memory substitute.

Рекомендуемая реализация:

- `testcontainers-go` с ephemeral Postgres container;
- один DB instance на suite;
- отдельная database/schema на test case или полная cleanup/reset между tests.

Почему так:

- нам критичны partial unique indexes, FK, check constraints, transaction behavior, row locking и concurrency semantics;
- это нельзя надежно проверить на fake DB.

### 2. Mock LLM

Требование:

- LLM в integration tests не вызывается по сети во внешний сервис.

Рекомендуемая реализация:

- локальный HTTP fake server с OpenAI-compatible API;
- deterministic responses по тестовым prompt markers;
- режимы:
  - success `correct`
  - success `partial`
  - success `incorrect`
  - malformed JSON
  - timeout
  - 5xx
  - slow response

### 3. Mock SSO

Требование:

- backend auth flow нельзя оставлять вне integration coverage.

Рекомендуемая реализация:

- fake SSO provider со стабильным callback contract;
- возможность задавать:
  - provider subject
  - email
  - verified flag
  - provider failure
  - invalid state

### 4. Mock object storage

Для backend-тестов достаточно:

- fake assets storage adapter;
- либо temp local implementation, если production storage абстрагирован портом.

### 5. Test app factory

Нужна единая фабрика тестового приложения:

- поднимает app with real wiring;
- подключает real Postgres;
- подключает fake SSO;
- подключает mock LLM;
- позволяет создавать seeded users/courses/orders via helper API или fixture builders;
- отдает HTTP client с cookie jar.

## Общая структура test suites

Рекомендуемая структура:

```text
internal/
  testkit/
    app/
    fixtures/
    postgres/
    fake_sso/
    fake_llm/
    auth/
    assertions/

  identity/
    integration/
  guardianship/
    integration/
  courses/
    integration/
  lessonruntime/
    integration/
  commerce/
    integration/
  progress/
    integration/
  gamification/
    integration/

tests/
  api/
  concurrency/
  migrations/
```

## Test Data Policy

- Никаких shared mutable fixtures между тестами.
- Каждый test case должен сам собрать минимально нужный state.
- Для сложных сценариев использовать builders:
  - `StudentBuilder`
  - `TeacherBuilder`
  - `ParentBuilder`
  - `PlatformCourseBuilder`
  - `TeacherCourseBuilder`
  - `PublishedRevisionBuilder`
  - `CommercialOfferBuilder`
  - `ManualOrderBuilder`

## Isolation Policy

Есть два допустимых режима:

1. `suite-level postgres + per-test DB cleanup`
2. `suite-level postgres + per-test transaction rollback`, но только там, где тест не проверяет межтранзакционную конкуренцию

Для concurrency tests rollback-транзакции недостаточны. Там нужны реальные параллельные соединения и коммиты.

## Набор обязательных suite-ов

### A. Migration Suite

Цель:

- убедиться, что schema поднимается с нуля;
- миграции применяются последовательно;
- downgrade policy, если будет поддерживаться, не ломает данные.

Обязательные тесты:

- `A1` apply all migrations on empty postgres
- `A2` boot app on migrated schema
- `A3` verify required tables/indexes/checks exist
- `A4` verify partial unique indexes exist for:
  - active guardian slots
  - active course revision
  - active teacher access grant
  - active offer uniqueness
  - active entitlement uniqueness
  - active lesson session uniqueness
  - active course progress uniqueness
  - pending review uniqueness
- `A5` verify critical check constraints exist:
  - `accounts.role`
  - `commercial_offers.target_type`
  - `entitlements.target_type`
  - `payment_records` manual confirmation uniqueness checks
- `A6` verify persistence-level platform-only monetization enforcement exists and works:
  - DB trigger/check rejects `commercial_offers` for teacher-owned course even if application-layer guard is bypassed

### B. Auth / Session / Onboarding Suite

Цель:

- полностью закрыть first login flow и session lifecycle.

Обязательные тесты:

- `B1` first SSO login creates account with `role=unselected`
- `B2` `GET /session` returns `role_selection_required=true` for unselected user
- `B3` onboarding sets role to `student`
- `B4` repeat onboarding with same role is idempotent
- `B5` repeat onboarding with different role returns `409`
- `B6` public onboarding rejects `admin`
- `B7` logout invalidates session
- `B8` invalid SSO callback state is rejected
- `B9` `return_to` survives SSO and redirects into claim flow
- `B10` invalid external `return_to` is rejected
- `B11` blocked account cannot continue using previously issued session after admin block
- `B12` teacher session returns `teacher_profile_required=true` until teacher profile is completed

### C. Profiles Suite

Цель:

- проверить role-specific profile CRUD.

Обязательные тесты:

- `C1` student profile read/update
- `C2` teacher profile read/update with `organization_name`
- `C3` parent profile read/update
- `C4` admin profile read/update
- `C5` role cannot access profile endpoint of another role
- `C6` teacher authoring endpoints are blocked until teacher profile contains required onboarding fields

### D. Guardianship Suite

Цель:

- проверить invite -> child claim -> parent visibility и hard limit `max 2 parents`.

Обязательные тесты:

- `D1` parent creates link invite
- `D2` student claims valid invite
- `D3` claimed invite cannot be reused
- `D4` expired invite cannot be claimed
- `D5` revoked invite cannot be claimed
- `D6` same parent-child pair cannot be duplicated
- `D7` student can have exactly two active parents
- `D8` third parent claim is rejected
- `D9` parent sees only linked children
- `D10` unrelated parent cannot read child progress
- `D11` concurrency test: two parallel claims fight for second parent slot, only one succeeds
- `D12` parent can revoke active invite before child claim

### E. Course Authoring Suite

Цель:

- проверить draft lifecycle, optimistic locking и draft validation.

Обязательные тесты:

- `E1` teacher creates course and draft
- `E2` admin creates platform course and draft
- `E3` draft update succeeds with current `draft_version`
- `E4` draft update with stale `draft_version` returns `409`
- `E5` invalid lesson graph returns `422`
- `E6` graph with cycle is rejected
- `E7` unreachable node is rejected
- `E8` free_text node without all three transitions is rejected
- `E9` duplicate lesson ids in course are rejected
- `E10` referenced missing asset is rejected
- `E11` teacher cannot edit admin course
- `E12` admin cannot accidentally access teacher draft without explicit admin route
- `E13` uploaded asset can be referenced by draft content after successful upload flow

### F. Preview Suite

Цель:

- гарантировать, что preview реально исполняет тот же graph engine, что и runtime, но без записи learner state.

Обязательные тесты:

- `F1` teacher preview start returns first step
- `F2` admin preview start returns first step
- `F3` preview next advances story node
- `F4` preview answer evaluates single_choice
- `F5` preview answer evaluates free_text через mock LLM
- `F6` preview step DTO contains `state_version`
- `F7` preview session state conflict returns `409`
- `F8` preview does not create `course_progress`
- `F9` preview does not create `lesson_sessions`
- `F10` preview does not mutate `student_game_state`
- `F11` same graph produces identical navigation in preview and student runtime for the same answer sequence
- `F12` student cannot access shared preview-session endpoints
- `F13` parent cannot access shared preview-session endpoints
- `F14` teacher cannot drive preview session created by another teacher
- `F15` admin can use shared preview session only for preview it initiated or is explicitly allowed to inspect by policy

### G. Publication / Moderation Suite

Цель:

- проверить moderation queue, approve/reject, publish revisions.

Обязательные тесты:

- `G1` teacher submit-review creates pending review
- `G2` second pending review for same draft is rejected
- `G3` moderation queue returns pending review
- `G4` approve by `review_id` publishes immutable revision
- `G5` reject by `review_id` sets draft back to `changes_requested`
- `G6` rejected draft keeps review comment
- `G7` teacher edits rejected draft and re-submits
- `G8` platform admin publish creates new revision without moderation queue
- `G9` exactly one current revision stays active
- `G10` version_no increments monotonically
- `G11` publish builds `course_revision_lessons`
- `G12` published revision stays immutable after draft edits
- `G13` approve on already resolved review is rejected
- `G14` reject on already resolved review is rejected
- `G15` approve-after-reject does not create extra revision
- `G16` reject-after-approve does not mutate published revision

### H. Student Catalog / Tree Suite

Цель:

- проверить, что студент получает правильный unified catalog и pinned course tree.

Обязательные тесты:

- `H1` platform published course appears in student catalog
- `H2` teacher course does not appear before claim
- `H3` teacher course appears after link claim
- `H4` course tree uses current published revision on first start
- `H5` started course stays pinned to old revision after new publish
- `H6` paid lesson node returns `locked_paid`
- `H7` awaiting confirmation state returns `awaiting_payment_confirmation`
- `H8` granted entitlement returns `granted`
- `H9` locked prerequisite state is returned correctly
- `H10` unrelated teacher course is not visible to student

### I. Student Runtime Suite

Цель:

- покрыть весь lesson execution flow.

Обязательные тесты:

- `I1` start creates active lesson session
- `I2` repeated start returns same active session
- `I3` session restore works after reopen
- `I4` next on story node advances correctly
- `I5` single_choice correct returns `correct`
- `I6` single_choice incorrect returns `incorrect`
- `I7` free_text mock LLM returns `correct`
- `I8` free_text mock LLM returns `partial`
- `I9` free_text mock LLM returns `incorrect`
- `I10` malformed LLM response returns retryable error and does not corrupt session
- `I11` LLM timeout returns retryable error and does not commit attempt
- `I12` attempt write persists verdict, feedback, evaluator metadata
- `I13` state_version conflict on `next`
- `I14` state_version conflict on `answer`
- `I15` duplicate retry of `next` from the same prior state is duplicate-safe
- `I16` duplicate `Idempotency-Key` on `answer` is safe
- `I17` wrong node id is rejected
- `I18` answer on non-question node is rejected
- `I19` reaching terminal node completes lesson
- `I20` completion response contains lesson summary for `S-10`
- `I21` retry completed lesson creates new session
- `I22` out_of_hearts blocks answer before evaluation
- `I23` paid lesson start is blocked without entitlement
- `I24` entitlement revoke actively terminates active paid lesson session
- `I25` paid lesson session fetch is blocked after entitlement revoke
- `I26` paid lesson next is blocked after entitlement revoke
- `I27` access to teacher lesson is blocked without access grant

### J. Progress Suite

Цель:

- проверить агрегаты progress и pinned revision semantics.

Обязательные тесты:

- `J1` starting first lesson creates `course_progress`
- `J2` one active `course_progress` per student/course
- `J3` lesson completion updates `lesson_progress`
- `J4` course stats counters update `correct/partial/incorrect`
- `J5` replay increments `replay_count`
- `J6` progress remains tied to original `course_revision_id`
- `J7` parent progress view returns only linked child data
- `J8` teacher student progress shows only own course students

### K. Gamification Suite

Цель:

- гарантировать, что игровой state всегда синхронен с runtime events.

Обязательные тесты:

- `K1` correct answer grants XP
- `K2` partial answer grants partial XP
- `K3` incorrect answer deducts heart by policy
- `K4` hearts never drop below zero
- `K5` hearts recovery by time works
- `K6` lesson retry recovery policy restores hearts when allowed
- `K7` streak increments on new active day
- `K8` streak does not double-count same day
- `K9` level recalculates from XP
- `K10` first lesson badge is awarded once
- `K11` duplicate event does not duplicate badge
- `K12` `game_events` ledger stays consistent with resulting state

### L. Teacher Access Suite

Цель:

- проверить private course link flow.

Обязательные тесты:

- `L1` teacher cannot create access link before publish
- `L2` teacher can create access link after publish
- `L3` student claim creates access grant
- `L4` duplicate claim stays idempotent
- `L5` revoked link cannot be claimed
- `L6` expired link cannot be claimed
- `L7` teacher can list own access links
- `L8` teacher can revoke own access link
- `L9` teacher can archive own course
- `L10` teacher student detail endpoint returns lesson-level progress for own course
- `L11` admin manual access grant works only for `teacher_private`
- `L12` admin course access grant against platform content is rejected

### M. Commerce / Monetization Suite

Цель:

- полностью закрыть manual paid flow и entitlement semantics.

Обязательные тесты:

- `M1` admin cannot create offer for teacher-owned content
- `M1a` direct persistence attempt to create offer for teacher-owned content is rejected by DB-level enforcement
- `M2` admin can create lesson offer for platform content
- `M3` offer activation validates lesson against current `course_revision_lessons`
- `M4` student can create purchase request for active offer
- `M5` duplicate open purchase request for same student/offer is rejected
- `M6` purchase request for archived offer is rejected
- `M7` manual order creation snapshots price and target
- `M8` manual order creation from purchase request marks request as `processed`
- `M9` duplicate awaiting-confirmation order for same student/monetization target is rejected
- `M10` manual order creation for archived offer is rejected
- `M10a` admin can decline open purchase request
- `M10b` repeat decline or decline-after-process returns deterministic conflict
- `M11` manual confirm with valid amount/currency succeeds
- `M12` manual confirm requires `Idempotency-Key`
- `M13` manual confirm requires `external_reference`
- `M14` manual confirm with amount mismatch fails without override
- `M15` manual confirm with override succeeds and stores override reason
- `M16` duplicate manual confirm does not create second payment record
- `M17` successful manual confirm creates active entitlement
- `M18` fulfillment log is created once
- `M19` complimentary grant creates entitlement without payment record
- `M20` complimentary grant cancels unpaid pending order and closes matching open purchase requests
- `M21` revoke entitlement terminates active paid session and blocks further paid access
- `M22` active entitlement uniqueness for lesson target
- `M23` active entitlement uniqueness for course target
- `M24` `awaiting_payment_confirmation` access state appears in student tree when awaiting-confirmation order exists
- `M25` paid lesson becomes `granted` after entitlement
- `M26` same `external_reference` with different `Idempotency-Key` does not create duplicate payment record
- `M27` second manual confirm after order already fulfilled returns deterministic conflict and creates no new side effects
- `M28` already-created order can still be confirmed after offer archived
- `M29` complimentary grant for already fulfilled target returns deterministic no-op or conflict without duplicate entitlement

### O. ACL / Security Suite

Цель:

- проверить, что роль и ownership не дырявы.

Обязательные тесты:

- `O1` student cannot call parent endpoints
- `O2` student cannot call teacher endpoints
- `O3` student cannot call admin endpoints
- `O4` parent cannot call student runtime as child
- `O5` teacher cannot moderate
- `O6` teacher cannot create commercial offer
- `O7` admin can read all required admin resources
- `O8` teacher sees only own course analytics
- `O9` parent sees only linked child progress
- `O10` session cookie absence -> `401`
- `O11` missing CSRF on mutating cookie-authenticated endpoint -> reject
- `O12` admin block endpoint revokes all active sessions of blocked account
- `O13` blocked user cannot call authenticated endpoints with previously valid cookie

### P. Concurrency / Race Suite

Цель:

- проверить те вещи, которые чаще всего ломаются уже после “зеленых” простых integration tests.

Обязательные тесты:

- `P1` parallel onboarding role selection: only one final role transition
- `P2` parallel guardian claim for last free parent slot: only one succeeds
- `P3` parallel lesson start: only one active lesson session
- `P4` parallel course start: only one active course_progress
- `P5` parallel answer submit with same idempotency key: no duplicate attempt/event
- `P6` parallel answer submit with stale/new state version: exactly one wins
- `P7` parallel submit-review: one pending review only
- `P8` parallel manual confirm with same idempotency key: one payment record only
- `P9` parallel grant/revoke entitlement does not leave duplicate active entitlements
- `P10` parallel manual confirm with same external reference but different idempotency keys: exactly one payment record and one fulfillment
- `P11` parallel complimentary grant and pending order resolution leaves deterministic final order state and one active entitlement

### Q. Repository / Query Contract Suite

Цель:

- проверить query handlers, от которых зависит UI.

Обязательные тесты:

- `Q1` landing promo query returns only published platform courses
- `Q2` student catalog sections are stable and ordered
- `Q3` student course tree returns lesson access metadata
- `Q4` parent child summary query returns aggregate metrics
- `Q5` teacher students table query returns expected fields
- `Q6` admin moderation queue query returns pending reviews only
- `Q7` admin commerce order list query reflects actual order/payment/entitlement state

### R. Assets Suite

Цель:

- проверить upload request flow для аватаров и course assets.

Обязательные тесты:

- `R1` authenticated user can request upload slot for avatar image
- `R2` teacher/admin can request upload slot for course illustration
- `R3` invalid mime type or oversized file is rejected
- `R4` unowned or nonexistent asset cannot be attached to profile or draft

## LLM Contract Matrix

Mock LLM must support deterministic scripted cases:

- `LLM1` `correct` verdict + feedback
- `LLM2` `partial` verdict + feedback
- `LLM3` `incorrect` verdict + feedback
- `LLM4` malformed JSON body
- `LLM5` valid JSON but unknown verdict
- `LLM6` transport timeout
- `LLM7` provider 500
- `LLM8` slow response beyond configured timeout

Expected backend guarantees:

- transport/format error does not silently continue lesson;
- no progress/game mutation on failed evaluation;
- student gets retryable application error;
- no duplicate attempt on retry with same idempotency key.

## Minimum Test Count Expectation

Это не точное число, а sanity floor.

- migration suite: 6+
- auth/session/onboarding: 10+
- guardianship: 11+
- authoring/preview/publication: 20+
- student runtime/progress/gamification: 35+
- teacher access: 12+
- commerce: 25+
- acl/security/concurrency: 20+
- query/assets: 10+

Итого: ориентир `140+` содержательных backend tests.

Если итоговая реализация дает заметно меньше, значит покрытие, скорее всего, неполное.

## Acceptance Gates

### Gate 1. Smoke

- app boots on migrated schema
- health/readiness ok
- fake SSO and mock LLM reachable

### Gate 2. Core Regression

Обязательные сценарии:

- first login -> onboarding -> student catalog
- teacher create draft -> submit review -> admin approve -> student sees course
- student passes lesson with single_choice
- student passes lesson with free_text + mock LLM
- parent invite -> child claim -> parent progress read
- platform paid lesson -> purchase request -> manual order -> manual confirm -> lesson opens

### Gate 3. Full Integration

- весь matrix выше зеленый

### Gate 4. Repetition

- `go test` full backend integration suite must pass repeatedly, минимум:
  - 3 consecutive runs locally
  - 1 CI run with race detector where applicable

### Gate 5. Coverage Floor

Не делать coverage vanity metric, но нужен minimum floor:

- critical domain/application packages: не ниже `85%` statements
- integration-only flow acceptance: все обязательные scenario IDs из этого документа реализованы

Критичные пакеты:

- `identity`
- `guardianship`
- `courses/authoring`
- `courses/publication`
- `courses/access`
- `lessonengine`
- `lessonruntime`
- `progress`
- `gamification`
- `commerce`
- `evaluation`

## Test Naming Convention

Рекомендуемый формат:

- `TestAuth_FirstLoginCreatesUnselectedAccount`
- `TestGuardianship_ThirdParentRejected`
- `TestLessonRuntime_FreeTextPartialVerdict`
- `TestCommerce_ManualConfirmIsIdempotent`

Для matrix tracing:

- каждый integration test в комментарии или subtest name должен ссылаться на scenario ID, например `I14`, `M12`.

## Test Implementation Rules

- Не mock-ать Postgres.
- Не mock-ать application service boundary.
- Не проверять только HTTP status; всегда проверять persisted DB state.
- После каждого critical API action проверять:
  - response DTO
  - DB rows
  - side effects в dependent tables
- Для runtime tests проверять одновременно:
  - `lesson_sessions`
  - `step_attempts`
  - `course_progress`
  - `lesson_progress`
  - `student_game_state`
  - `game_events`
- Для commerce tests проверять одновременно:
  - `purchase_requests`
  - `commercial_orders`
  - `payment_records`
  - `entitlements`
  - `entitlement_fulfillment_log`

## Что обязательно проверять в каждом сценарии

Минимум:

1. HTTP status
2. Error code или response payload
3. DB state
4. absence of forbidden side effects

Пример:

- при LLM timeout:
  - клиент получает retryable error
  - `step_attempts` не создается
  - `lesson_sessions.state_version` не меняется
  - `student_game_state` не меняется

## Flaky Test Policy

- Любой flaky test блокирует релиз так же, как обычный failing test.
- Ретраи в CI не считаются исправлением flaky behavior.
- Если flaky возникает из-за времени:
  - внедряется fake clock
- если из-за concurrency:
  - тест и код переписываются до детерминированности

## Recommended Execution Layout

### Быстрый локальный прогон

- unit/policy tests
- короткий smoke integration pack

### Полный локальный прогон

- все backend integration tests
- contract tests with mock LLM
- concurrency suite

### CI blocking pipeline

1. migrations
2. unit/policy
3. integration postgres
4. API scenario tests
5. concurrency/idempotency
6. coverage check

## Итоговая рекомендация

- Делать backend так, чтобы его можно было принимать только по автоматическим тестам, а не “посмотрим руками”.
- Основа доверия здесь не в одном huge E2E, а в комбинации:
  - real Postgres
  - full HTTP scenario coverage
  - deterministic mock LLM
  - DB state assertions
  - concurrency/idempotency tests
- Если весь этот план реализован и стабильно зеленый, это максимально близкий к “без ручного тестирования” вариант для данного MVP.
