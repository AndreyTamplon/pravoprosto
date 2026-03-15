# Право Просто — DB Schema MVP

## Подход

- Основная БД MVP: PostgreSQL.
- Схема проектируется под модульный монолит, а не под набор независимых микросервисных БД.
- Решение должно быть качественным, но не overengineered:
  - реляционно моделируем то, что требует транзакционной целостности, ACL, аудита и отчетности;
  - document-like lesson/course content храним в `jsonb`;
  - read models на старте не материализуем отдельными projection tables без явной необходимости.

## Ключевые принципы

- Все таблицы живут в одной БД и в одном logical schema `public`.
- PK везде: `uuid`.
- Временные поля: `timestamptz`.
- Денежные суммы: `amount_minor bigint`, валюта: `currency char(3)`.
- Статусы и типы в MVP лучше хранить как `text` + `check constraint`, а не как PostgreSQL enum.
- Soft delete используем только там, где это уже зафиксировано архитектурой: `courses`, `course_access_links`, `assets`.
- Published revisions, progress, attempts, payment records и game events являются append-friendly и не удаляются.
- Логические идентификаторы модулей, уроков и шагов живут внутри `content_json` как строковые stable IDs. Они не становятся отдельными SQL PK.

## Что сознательно не делаем в MVP

- Не строим отдельный event store.
- Не строим отдельные projection tables под каждый экран.
- Не нормализуем `nodes` и `edges` lesson graph в отдельные SQL-таблицы.
- Не вводим generic `acl_entries` и generic `payments` для всех сценариев.
- Не делаем polymorphic ownership через универсальную таблицу `entities`.

## Общие соглашения

### Идентификаторы

- `accounts.id`, `courses.id`, `commercial_offers.id` и прочие сущности используют `uuid`.
- В `content_json`:
  - `module.id`, `lesson.id`, `node.id`, `option.id` являются строками;
  - `lesson.id` обязан быть логически стабильным в рамках `course_id`, если lesson участвует в monetization.

### Аудит

- Почти все mutable таблицы имеют `created_at`.
- Mutable business state дополнительно имеет `updated_at`.
- Для административно значимых действий сохраняем `created_by_account_id`, `reviewer_id`, `confirmed_by_admin_id`, `granted_by_account_id` или эквивалентное поле.

### Идемпотентность

- Где она важна, идемпотентность обеспечивается не отдельным cross-cutting framework, а целевыми уникальными ключами:
  - `payment_records(order_id, idempotency_key)`
  - `step_attempts(lesson_session_id, client_idempotency_key)`

### Read models

- `StudentCatalogItem`, `StudentCourseTree`, `ParentChildSummary`, `TeacherStudentProgressRow` и похожие DTO на старте строятся SQL-query слоями и application handlers.
- Материализованные projection tables добавляются только после появления реальной performance pain.

## Таблицы

### 1. Identity

#### `accounts`

Назначение: основной аккаунт пользователя и его единственная роль.

| Поле | Тип | Ограничения | Примечание |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `role` | `text` | not null, check in (`unselected`,`student`,`parent`,`teacher`,`admin`) | после первого SSO входа аккаунт создается с `unselected` |
| `status` | `text` | not null, check in (`active`,`blocked`) | |
| `created_at` | `timestamptz` | not null | |
| `updated_at` | `timestamptz` | not null | |

Индексы:
- `idx_accounts_role` on `(role)`

Инвариант:
- допустим единственный one-way transition `unselected -> student|parent|teacher`;
- `admin` назначается административно и не выбирается публичным onboarding flow.

#### `external_identities`

Назначение: привязка аккаунта к SSO identity provider.

| Поле | Тип | Ограничения | Примечание |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `account_id` | `uuid` | not null, FK -> `accounts(id)` | |
| `provider` | `text` | not null | например `yandex` |
| `provider_subject` | `text` | not null | стабильный user id у провайдера |
| `email` | `text` | null | |
| `email_verified` | `boolean` | not null default `false` | |
| `raw_profile_json` | `jsonb` | not null default `'{}'::jsonb` | минимальный debug/audit snapshot с retention policy |
| `created_at` | `timestamptz` | not null | |
| `updated_at` | `timestamptz` | not null | |

Индексы и ограничения:
- unique `(provider, provider_subject)`
- `idx_external_identities_account_id` on `(account_id)`

#### `sessions`

Назначение: серверные пользовательские сессии.

| Поле | Тип | Ограничения | Примечание |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `account_id` | `uuid` | not null, FK -> `accounts(id)` | |
| `session_token_hash` | `text` | not null, unique | raw cookie token в БД не храним |
| `csrf_secret` | `text` | not null | |
| `expires_at` | `timestamptz` | not null | |
| `created_at` | `timestamptz` | not null | |
| `last_seen_at` | `timestamptz` | not null | |
| `revoked_at` | `timestamptz` | null | |

Индексы:
- `idx_sessions_account_id` on `(account_id)`
- `idx_sessions_expires_at` on `(expires_at)`

Важный инвариант:
- блокировка пользователя должна помечать его активные sessions как revoked.

### 2. Profiles

Профили разнесены по ролям, чтобы не тащить sparse nullable mega-table.

#### `student_profiles`

| Поле | Тип | Ограничения |
|---|---|---|
| `account_id` | `uuid` | PK, FK -> `accounts(id)` |
| `display_name` | `text` | not null |
| `avatar_asset_id` | `uuid` | null, FK -> `assets(id)` |
| `created_at` | `timestamptz` | not null |
| `updated_at` | `timestamptz` | not null |

#### `parent_profiles`

| Поле | Тип | Ограничения |
|---|---|---|
| `account_id` | `uuid` | PK, FK -> `accounts(id)` |
| `display_name` | `text` | not null |
| `avatar_asset_id` | `uuid` | null, FK -> `assets(id)` |
| `created_at` | `timestamptz` | not null |
| `updated_at` | `timestamptz` | not null |

#### `teacher_profiles`

| Поле | Тип | Ограничения |
|---|---|---|
| `account_id` | `uuid` | PK, FK -> `accounts(id)` |
| `display_name` | `text` | not null |
| `organization_name` | `text` | null |
| `avatar_asset_id` | `uuid` | null, FK -> `assets(id)` |
| `created_at` | `timestamptz` | not null |
| `updated_at` | `timestamptz` | not null |

#### `admin_profiles`

| Поле | Тип | Ограничения |
|---|---|---|
| `account_id` | `uuid` | PK, FK -> `accounts(id)` |
| `display_name` | `text` | not null |
| `avatar_asset_id` | `uuid` | null, FK -> `assets(id)` |
| `created_at` | `timestamptz` | not null |
| `updated_at` | `timestamptz` | not null |

### 3. Guardianship

#### `guardian_link_invites`

Назначение: parent-generated invite, который потом claim-ит student после SSO.

| Поле | Тип | Ограничения | Примечание |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `created_by_parent_id` | `uuid` | not null, FK -> `accounts(id)` | parent account |
| `token_hash` | `text` | not null, unique | raw token в БД не храним |
| `status` | `text` | not null, check in (`active`,`claimed`,`expired`,`revoked`) | |
| `claimed_by_student_id` | `uuid` | null, FK -> `accounts(id)` | |
| `expires_at` | `timestamptz` | not null | |
| `used_at` | `timestamptz` | null | |
| `revoked_at` | `timestamptz` | null | |
| `created_at` | `timestamptz` | not null | |

Индексы:
- `idx_guardian_link_invites_parent_id` on `(created_by_parent_id, created_at desc)`

#### `guardian_links`

Назначение: активные и исторические связи parent ↔ student.

| Поле | Тип | Ограничения | Примечание |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `parent_id` | `uuid` | not null, FK -> `accounts(id)` | |
| `student_id` | `uuid` | not null, FK -> `accounts(id)` | |
| `parent_slot` | `smallint` | not null, check in (`1`,`2`) | ограничение максимум двух активных родителей |
| `status` | `text` | not null, check in (`active`,`revoked`) | |
| `invite_id` | `uuid` | null, FK -> `guardian_link_invites(id)` | |
| `created_at` | `timestamptz` | not null | |
| `accepted_at` | `timestamptz` | not null | |
| `revoked_at` | `timestamptz` | null | |

Индексы и ограничения:
- unique `(parent_id, student_id)`
- unique partial index on `(student_id, parent_slot)` where `status = 'active'`
- `idx_guardian_links_student_id` on `(student_id)`

Важный инвариант:
- у одного `student_id` не более двух `active` guardian links;
- `parent_slot` выбирается сервисом `guardianship` в транзакции и дополнительно страхуется unique partial index.

### 4. Assets

#### `assets`

| Поле | Тип | Ограничения | Примечание |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `owner_account_id` | `uuid` | null, FK -> `accounts(id)` | для системных ассетов может быть null |
| `storage_key` | `text` | not null, unique | S3-compatible object key |
| `mime_type` | `text` | not null | |
| `size_bytes` | `bigint` | not null | |
| `width` | `int` | null | |
| `height` | `int` | null | |
| `created_at` | `timestamptz` | not null | |
| `deleted_at` | `timestamptz` | null | soft delete |

### 5. Courses

#### `courses`

Назначение: корневая сущность курса и его ownership.

| Поле | Тип | Ограничения | Примечание |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `owner_kind` | `text` | not null, check in (`platform`,`teacher`) | |
| `owner_account_id` | `uuid` | null, FK -> `accounts(id)` | для `platform` может быть null |
| `course_kind` | `text` | not null, check in (`platform_catalog`,`teacher_private`) | |
| `status` | `text` | not null, check in (`active`,`archived`) | coarse-grained lifecycle |
| `deleted_at` | `timestamptz` | null | soft delete |
| `created_at` | `timestamptz` | not null | |
| `updated_at` | `timestamptz` | not null | |

Индексы:
- `idx_courses_owner_account_id` on `(owner_account_id)`
- `idx_courses_kind_status` on `(course_kind, status)`

#### `course_drafts`

Назначение: текущий editable draft на курс.

| Поле | Тип | Ограничения | Примечание |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `course_id` | `uuid` | not null, unique, FK -> `courses(id)` | один активный draft на курс |
| `workflow_status` | `text` | not null, check in (`editing`,`in_review`,`changes_requested`,`archived`) | refined status для реального draft lifecycle |
| `draft_version` | `bigint` | not null | optimistic locking |
| `title` | `text` | not null | |
| `description` | `text` | not null | |
| `age_min` | `int` | null | |
| `age_max` | `int` | null | |
| `cover_asset_id` | `uuid` | null, FK -> `assets(id)` | |
| `content_json` | `jsonb` | not null | modules/lessons/graphs |
| `last_submitted_at` | `timestamptz` | null | |
| `last_rejected_at` | `timestamptz` | null | |
| `last_published_revision_id` | `uuid` | null | удобно для diff и preview against published |
| `created_at` | `timestamptz` | not null | |
| `updated_at` | `timestamptz` | not null | |

Индексы:
- `idx_course_drafts_status` on `(workflow_status)`

#### `course_reviews`

Назначение: submission/decision history по teacher moderation.

| Поле | Тип | Ограничения | Примечание |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `course_draft_id` | `uuid` | not null, FK -> `course_drafts(id)` | |
| `submitted_by_account_id` | `uuid` | not null, FK -> `accounts(id)` | |
| `submitted_draft_version` | `bigint` | not null | фиксирует snapshot версии |
| `status` | `text` | not null, check in (`pending`,`approved`,`rejected`) | |
| `reviewer_id` | `uuid` | null, FK -> `accounts(id)` | admin |
| `review_comment` | `text` | null | |
| `submitted_at` | `timestamptz` | not null | |
| `resolved_at` | `timestamptz` | null | |
| `created_at` | `timestamptz` | not null | |

Индексы:
- `idx_course_reviews_pending` on `(status, submitted_at)` where `status = 'pending'`
- unique partial index on `(course_draft_id)` where `status = 'pending'`
- `idx_course_reviews_draft_id` on `(course_draft_id, submitted_at desc)`

#### `course_revisions`

Назначение: immutable published snapshots.

| Поле | Тип | Ограничения | Примечание |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `course_id` | `uuid` | not null, FK -> `courses(id)` | |
| `version_no` | `int` | not null | |
| `title` | `text` | not null | |
| `description` | `text` | not null | |
| `age_min` | `int` | null | |
| `age_max` | `int` | null | |
| `cover_asset_id` | `uuid` | null, FK -> `assets(id)` | |
| `content_json` | `jsonb` | not null | immutable snapshot |
| `monetization_policy_json` | `jsonb` | not null default `'{}'::jsonb` | lesson-level paid/free snapshot |
| `created_from_draft_id` | `uuid` | null, FK -> `course_drafts(id)` | |
| `published_by_account_id` | `uuid` | not null, FK -> `accounts(id)` | |
| `published_at` | `timestamptz` | not null | |
| `is_current` | `boolean` | not null default `false` | |
| `disabled_at` | `timestamptz` | null | revision itself не удаляем |

Индексы и ограничения:
- unique `(course_id, version_no)`
- unique partial index on `(course_id)` where `is_current = true`
- `idx_course_revisions_course_id_published_at` on `(course_id, published_at desc)`

#### `course_revision_lessons`

Назначение: легковесный registry опубликованных lessons, извлекаемый из `course_revisions.content_json` в publish pipeline.

| Поле | Тип | Ограничения | Примечание |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `course_revision_id` | `uuid` | not null, FK -> `course_revisions(id)` | |
| `course_id` | `uuid` | not null, FK -> `courses(id)` | |
| `module_id` | `text` | not null | logical module id |
| `lesson_id` | `text` | not null | logical lesson id |
| `title` | `text` | not null | |
| `sort_order` | `int` | not null | стабильный порядок в tree |
| `created_at` | `timestamptz` | not null | |

Индексы и ограничения:
- unique `(course_revision_id, lesson_id)`
- `idx_course_revision_lessons_course_id` on `(course_id, lesson_id)`

### 6. Teacher access

#### `course_access_links`

Назначение: share link для опубликованного teacher course.

| Поле | Тип | Ограничения | Примечание |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `course_id` | `uuid` | not null, FK -> `courses(id)` | только `teacher_private` |
| `token_hash` | `text` | not null, unique | |
| `status` | `text` | not null, check in (`active`,`expired`,`revoked`) | |
| `expires_at` | `timestamptz` | null | |
| `created_by_account_id` | `uuid` | not null, FK -> `accounts(id)` | teacher/admin |
| `created_at` | `timestamptz` | not null | |
| `revoked_at` | `timestamptz` | null | |

Индексы:
- `idx_course_access_links_course_id` on `(course_id, created_at desc)`

Важный инвариант:
- `course_access_links` создается только для `teacher_private` course с текущей published revision;
- это проверяется application service и integration tests.

#### `course_access_grants`

Назначение: student access к teacher/private course.

| Поле | Тип | Ограничения | Примечание |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `course_id` | `uuid` | not null, FK -> `courses(id)` | только `teacher_private` |
| `student_id` | `uuid` | not null, FK -> `accounts(id)` | |
| `source` | `text` | not null, check in (`teacher_link`,`admin_grant`) | |
| `granted_by_account_id` | `uuid` | not null, FK -> `accounts(id)` | |
| `first_claimed_via_link_id` | `uuid` | null, FK -> `course_access_links(id)` | |
| `granted_at` | `timestamptz` | not null | |
| `archived_at` | `timestamptz` | null | |

Индексы и ограничения:
- unique partial index on `(course_id, student_id)` where `archived_at is null`
- `idx_course_access_grants_student_id` on `(student_id, granted_at desc)`

Важный инвариант:
- эта таблица не используется для platform paid content.

### 7. Commerce

#### `commercial_offers`

Назначение: sellable offer для platform-owned course или lesson.

| Поле | Тип | Ограничения | Примечание |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `owner_kind` | `text` | not null, check = `platform` | teacher monetization запрещена |
| `target_type` | `text` | not null, check in (`course`,`lesson`) | |
| `target_course_id` | `uuid` | not null, FK -> `courses(id)` | |
| `target_lesson_id` | `text` | null | обязателен для `lesson` |
| `title` | `text` | not null | |
| `description` | `text` | not null | |
| `price_amount_minor` | `bigint` | not null | текущая цена offer в MVP |
| `price_currency` | `char(3)` | not null | |
| `status` | `text` | not null, check in (`draft`,`active`,`archived`) | |
| `created_by_account_id` | `uuid` | not null, FK -> `accounts(id)` | |
| `created_at` | `timestamptz` | not null | |
| `updated_at` | `timestamptz` | not null | |
| `archived_at` | `timestamptz` | null | |

Индексы и ограничения:
- check:
  - `target_type = 'course'` -> `target_lesson_id is null`
  - `target_type = 'lesson'` -> `target_lesson_id is not null`
- unique partial index on `(target_course_id)` where `status = 'active' and target_type = 'course'`
- unique partial index on `(target_course_id, target_lesson_id)` where `status = 'active' and target_type = 'lesson'`
- `idx_commercial_offers_status` on `(status, created_at desc)`

Важный инвариант:
- `target_course_id` должен ссылаться только на `courses.owner_kind = 'platform'`.
- Для `target_type = 'lesson'` активация offer валидируется против `course_revision_lessons` текущей published revision.
- Это проверяется application service, integration tests и DB trigger на activation/write-path.

#### `purchase_requests`

Назначение: student-side заявка на платный lesson/course для ручной обработки админом.

| Поле | Тип | Ограничения | Примечание |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `student_id` | `uuid` | not null, FK -> `accounts(id)` | |
| `offer_id` | `uuid` | not null, FK -> `commercial_offers(id)` | |
| `status` | `text` | not null, check in (`open`,`processed`,`declined`) | |
| `created_at` | `timestamptz` | not null | |
| `processed_at` | `timestamptz` | null | |
| `processed_by_account_id` | `uuid` | null, FK -> `accounts(id)` | |

Индексы и ограничения:
- unique partial index on `(student_id, offer_id)` where `status = 'open'`
- `idx_purchase_requests_status` on `(status, created_at desc)`

#### `commercial_orders`

Назначение: order lifecycle для ручного paid access flow в MVP.

| Поле | Тип | Ограничения | Примечание |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `student_id` | `uuid` | not null, FK -> `accounts(id)` | |
| `offer_id` | `uuid` | not null, FK -> `commercial_offers(id)` | |
| `purchase_request_id` | `uuid` | null, FK -> `purchase_requests(id)` | optional source request |
| `status` | `text` | not null, check in (`awaiting_confirmation`,`fulfilled`,`canceled`) | |
| `target_type` | `text` | not null, check in (`lesson`,`course`) | denormalized target for uniqueness/query simplicity |
| `target_course_id` | `uuid` | not null, FK -> `courses(id)` | |
| `target_lesson_id` | `text` | null | null for course-wide order |
| `offer_snapshot_json` | `jsonb` | not null | title/target snapshot |
| `price_snapshot_amount_minor` | `bigint` | not null | |
| `price_snapshot_currency` | `char(3)` | not null | |
| `created_by_account_id` | `uuid` | not null, FK -> `accounts(id)` | admin for MVP |
| `created_at` | `timestamptz` | not null | |
| `updated_at` | `timestamptz` | not null | |
| `fulfilled_at` | `timestamptz` | null | |
| `canceled_at` | `timestamptz` | null | |

Индексы и ограничения:
- `idx_commercial_orders_student_id` on `(student_id, created_at desc)`
- `idx_commercial_orders_status` on `(status, created_at desc)`
- unique partial index on `(student_id, target_type, target_course_id, coalesce(target_lesson_id, ''))` where `status = 'awaiting_confirmation'`
- optional secondary index on `(student_id, offer_id, created_at desc)` for admin tracing

#### `payment_records`

Назначение: audit trail успешных manual payment confirmations.

| Поле | Тип | Ограничения | Примечание |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `order_id` | `uuid` | not null, FK -> `commercial_orders(id)` | |
| `amount_minor` | `bigint` | not null | |
| `currency` | `char(3)` | not null | |
| `idempotency_key` | `text` | not null | обязателен для manual confirm |
| `external_reference` | `text` | not null | внешнее подтверждение оплаты |
| `confirmed_by_admin_id` | `uuid` | not null, FK -> `accounts(id)` | |
| `override_reason` | `text` | null | |
| `paid_at` | `timestamptz` | not null | |
| `created_at` | `timestamptz` | not null | |

Индексы и ограничения:
- unique `(order_id, idempotency_key)`
- unique `(external_reference)`
- `idx_payment_records_order_id` on `(order_id, created_at desc)`

#### `entitlements`

Назначение: единственный источник истины по доступу к paid platform content.

| Поле | Тип | Ограничения | Примечание |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `student_id` | `uuid` | not null, FK -> `accounts(id)` | |
| `target_type` | `text` | not null, check in (`course`,`lesson`) | |
| `target_course_id` | `uuid` | not null, FK -> `courses(id)` | |
| `target_lesson_id` | `text` | null | |
| `source_type` | `text` | not null, check in (`purchase`,`complimentary`) | |
| `order_id` | `uuid` | null, FK -> `commercial_orders(id)` | |
| `status` | `text` | not null, check in (`active`,`revoked`) | |
| `granted_by_account_id` | `uuid` | not null, FK -> `accounts(id)` | |
| `granted_at` | `timestamptz` | not null | |
| `revoked_at` | `timestamptz` | null | |

Индексы и ограничения:
- check:
  - `target_type = 'course'` -> `target_lesson_id is null`
  - `target_type = 'lesson'` -> `target_lesson_id is not null`
  - `source_type = 'purchase'` -> `order_id is not null`
  - `source_type = 'complimentary'` -> `order_id is null`
- unique partial index on `(student_id, target_course_id)` where `status = 'active' and target_type = 'course'`
- unique partial index on `(student_id, target_course_id, target_lesson_id)` where `status = 'active' and target_type = 'lesson'`
- `idx_entitlements_student_id` on `(student_id, granted_at desc)`

#### `entitlement_fulfillment_log`

Назначение: идемпотентный аудируемый след выдачи доступа.

| Поле | Тип | Ограничения | Примечание |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `order_id` | `uuid` | not null, FK -> `commercial_orders(id)` | |
| `payment_record_id` | `uuid` | not null, FK -> `payment_records(id)` | |
| `entitlement_id` | `uuid` | not null, FK -> `entitlements(id)` | |
| `created_at` | `timestamptz` | not null | |

Индексы и ограничения:
- unique `(order_id, payment_record_id)`
- unique `(entitlement_id)`


### 8. Progress and runtime

#### `course_progress`

Назначение: pinned прохождение курса на конкретной published revision.

| Поле | Тип | Ограничения | Примечание |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `student_id` | `uuid` | not null, FK -> `accounts(id)` | |
| `course_id` | `uuid` | not null, FK -> `courses(id)` | |
| `course_revision_id` | `uuid` | not null, FK -> `course_revisions(id)` | pinned revision |
| `status` | `text` | not null, check in (`in_progress`,`completed`,`abandoned`) | |
| `started_at` | `timestamptz` | not null | |
| `completed_at` | `timestamptz` | null | |
| `last_lesson_id` | `text` | null | |
| `last_activity_at` | `timestamptz` | not null | |
| `correct_answers` | `int` | not null default `0` | aggregated counter |
| `partial_answers` | `int` | not null default `0` | aggregated counter |
| `incorrect_answers` | `int` | not null default `0` | aggregated counter |

Индексы и ограничения:
- `idx_course_progress_student_id` on `(student_id, last_activity_at desc)`
- unique partial index on `(student_id, course_id)` where `status = 'in_progress'`

#### `lesson_progress`

Назначение: агрегированное состояние по конкретному lesson внутри course_progress.

| Поле | Тип | Ограничения | Примечание |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `student_id` | `uuid` | not null, FK -> `accounts(id)` | денормализация для query speed |
| `course_progress_id` | `uuid` | not null, FK -> `course_progress(id)` | |
| `course_revision_id` | `uuid` | not null, FK -> `course_revisions(id)` | |
| `lesson_id` | `text` | not null | logical lesson id внутри revision |
| `status` | `text` | not null, check in (`not_started`,`in_progress`,`completed`) | |
| `best_verdict` | `text` | null, check in (`incorrect`,`partial`,`correct`) | |
| `attempts_count` | `int` | not null default `0` | |
| `replay_count` | `int` | not null default `0` | |
| `started_at` | `timestamptz` | null | |
| `completed_at` | `timestamptz` | null | |
| `last_activity_at` | `timestamptz` | not null | |

Индексы и ограничения:
- unique `(course_progress_id, lesson_id)`
- FK `(course_revision_id, lesson_id)` -> `course_revision_lessons(course_revision_id, lesson_id)`
- `idx_lesson_progress_student_id` on `(student_id, last_activity_at desc)`

#### `lesson_sessions`

Назначение: активная или завершенная runtime session lesson player.

| Поле | Тип | Ограничения | Примечание |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `student_id` | `uuid` | not null, FK -> `accounts(id)` | |
| `course_progress_id` | `uuid` | not null, FK -> `course_progress(id)` | |
| `course_revision_id` | `uuid` | not null, FK -> `course_revisions(id)` | |
| `lesson_id` | `text` | not null | |
| `status` | `text` | not null, check in (`in_progress`,`completed`,`terminated`) | |
| `current_node_id` | `text` | null | |
| `state_version` | `bigint` | not null default `1` | optimistic concurrency |
| `started_at` | `timestamptz` | not null | |
| `completed_at` | `timestamptz` | null | |
| `terminated_at` | `timestamptz` | null | |
| `termination_reason` | `text` | null | for revoke/out_of_hearts/admin stop |
| `last_activity_at` | `timestamptz` | not null | |

Индексы и ограничения:
- unique partial index on `(student_id, course_progress_id, lesson_id)` where `status = 'in_progress'`
- FK `(course_revision_id, lesson_id)` -> `course_revision_lessons(course_revision_id, lesson_id)`
- `idx_lesson_sessions_student_id` on `(student_id, last_activity_at desc)`

#### `step_attempts`

Назначение: факт ответа на конкретном узле урока.

| Поле | Тип | Ограничения | Примечание |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `lesson_session_id` | `uuid` | not null, FK -> `lesson_sessions(id)` | |
| `node_id` | `text` | not null | |
| `attempt_no` | `int` | not null | |
| `client_idempotency_key` | `text` | null | |
| `answer_json` | `jsonb` | not null | |
| `verdict` | `text` | not null, check in (`incorrect`,`partial`,`correct`) | |
| `feedback_text` | `text` | not null | |
| `next_node_id` | `text` | null | |
| `evaluator_type` | `text` | not null, check in (`single_choice`,`llm_free_text`) | |
| `model_name` | `text` | null | |
| `evaluator_latency_ms` | `int` | null | |
| `evaluator_trace_id` | `text` | null | |
| `created_at` | `timestamptz` | not null | |

Индексы и ограничения:
- unique `(lesson_session_id, attempt_no)`
- unique `(lesson_session_id, client_idempotency_key)` where `client_idempotency_key is not null`
- `idx_step_attempts_session_id` on `(lesson_session_id, created_at)`

### 9. Gamification

#### `student_game_state`

Назначение: текущее игровое состояние ученика.

| Поле | Тип | Ограничения |
|---|---|---|
| `student_id` | `uuid` | PK, FK -> `accounts(id)` |
| `xp_total` | `bigint` | not null default `0` |
| `level` | `int` | not null default `1` |
| `hearts_current` | `int` | not null |
| `hearts_max` | `int` | not null |
| `hearts_updated_at` | `timestamptz` | not null |
| `created_at` | `timestamptz` | not null |
| `updated_at` | `timestamptz` | not null |

#### `student_streak_state`

| Поле | Тип | Ограничения |
|---|---|---|
| `student_id` | `uuid` | PK, FK -> `accounts(id)` |
| `current_streak_days` | `int` | not null default `0` |
| `best_streak_days` | `int` | not null default `0` |
| `last_activity_date` | `date` | null |
| `updated_at` | `timestamptz` | not null |

#### `game_events`

Назначение: ledger начислений и списаний.

| Поле | Тип | Ограничения | Примечание |
|---|---|---|---|
| `id` | `uuid` | PK | |
| `student_id` | `uuid` | not null, FK -> `accounts(id)` | |
| `source_type` | `text` | not null | например `step_attempt`, `lesson_complete`, `lesson_retry` |
| `source_id` | `uuid` | not null | id бизнес-источника |
| `event_type` | `text` | not null | |
| `xp_delta` | `int` | not null default `0` | |
| `hearts_delta` | `int` | not null default `0` | |
| `streak_delta` | `int` | not null default `0` | |
| `created_at` | `timestamptz` | not null | |

Индексы и ограничения:
- unique `(source_type, source_id, event_type)`
- `idx_game_events_student_id` on `(student_id, created_at desc)`

#### `student_badges`

| Поле | Тип | Ограничения |
|---|---|---|
| `id` | `uuid` | PK |
| `student_id` | `uuid` | not null, FK -> `accounts(id)` |
| `badge_code` | `text` | not null |
| `source_type` | `text` | not null |
| `source_id` | `uuid` | not null |
| `awarded_at` | `timestamptz` | not null |

Индексы и ограничения:
- unique `(student_id, badge_code)`
- `idx_student_badges_student_id` on `(student_id, awarded_at desc)`

## Специальные инварианты

### Draft -> publication

- `course_revisions` immutable.
- Publish создает новую строку в `course_revisions`, а не меняет старую.
- Ровно одна `is_current = true` revision на `course_id`.
- `course_progress.course_revision_id` после старта больше не меняется.

### DAG lesson graph

- В БД граф лежит в `content_json`.
- Для published revisions дополнительно извлекается только lesson registry `course_revision_lessons`; он не заменяет graph document и не хранит nodes/edges.
- Целостность DAG проверяется только application validator перед preview и publish:
  - один `startNodeId`
  - все узлы достижимы
  - циклы запрещены
  - для `free_text` есть transitions для всех verdict

### Teacher access vs commerce

- `course_access_grants` применимы только к `teacher_private`.
- `entitlements` применимы только к platform monetization.
- Платный platform lesson не должен открываться через `course_access_grants`.

### Payment vs access

- Payment state сам по себе не дает доступ.
- Доступ к paid content определяется только `entitlements.status = 'active'`.
- `commercial_orders.status = 'fulfilled'` невозможен без `entitlement_fulfillment_log`.
- active paid session при revoke должна переводиться в `lesson_sessions.status = 'terminated'`.

### Parent limit

- У ребенка максимум два активных родителя.
- Инвариант реализуется сервисом `guardianship` транзакционно.

### Role guards

- Для role-sensitive FK-полей сервисы обязаны валидировать роль аккаунта до записи:
  - `guardian_links.parent_id` -> `parent`
  - `guardian_links.student_id` -> `student`
  - `course_access_grants.student_id` -> `student`
  - `commercial_orders.student_id` -> `student`
  - `entitlements.student_id` -> `student`
  - `course_reviews.reviewer_id` -> `admin`
- Для guardianship и commerce write-path это дополнительно рекомендуется усиливать DB trigger-проверками, потому что ошибка там бьет по ACL и деньгам.

### Game state initialization

- `student_game_state` и `student_streak_state` должны существовать не позже первого успешного `GET /student/game-state`.
- Допустим lazy-create на первом student onboarding или на первом запросе game state, но API не должен отдавать `404` новому student.

### Paid content lifecycle

- В MVP не поддерживаем webhook inbox и provider event store.
- В MVP не поддерживаем target replacement table для уже проданного lesson.
- Если у paid lesson уже есть активные entitlements или purchase history, его удаление/архивация должны быть запрещены policy-слоем до появления отдельной migration strategy.
- `purchase_requests` создаются только для `commercial_offers.status = 'active'`.
- archived offer может использоваться как source только для уже созданного `commercial_order`; новые requests/orders для него запрещены policy-слоем.
- complimentary grant по target должен в той же transaction cancel-ить неоплаченный pending order для того же student/target и помечать matching open `purchase_requests` как `processed`.

## Что будет query-only в MVP

На старте не создаем отдельные persistent таблицы для:

- student catalog projection;
- student course tree projection;
- parent dashboard summary;
- teacher students table;
- admin moderation dashboard;
- admin commerce dashboard.

Эти представления строятся запросами поверх:

- `courses` + `course_revisions` + `course_revision_lessons`
- `course_access_grants`
- `course_progress` + `lesson_progress`
- `student_game_state` + `student_streak_state`
- `commercial_offers` + `purchase_requests` + `commercial_orders` + `entitlements`

## Минимальный порядок миграций

1. `accounts`, `external_identities`, `sessions`
2. `assets`
3. role profiles
4. `guardian_link_invites`, `guardian_links`
5. `courses`, `course_drafts`, `course_reviews`, `course_revisions`
6. `course_revision_lessons`
7. `course_access_links`, `course_access_grants`
8. `commercial_offers`, `purchase_requests`, `commercial_orders`
9. `payment_records`
10. `entitlements`, `entitlement_fulfillment_log`
11. `course_progress`, `lesson_progress`, `lesson_sessions`, `step_attempts`
12. `student_game_state`, `student_streak_state`, `game_events`, `student_badges`

## Итог

- Схема остается модульной, но не распадается на искусственные generic abstractions.
- Вся транзакционно важная доменная логика имеет явные таблицы.
- Authoring и published content остаются document-oriented там, где это реально упрощает продукт.
- Manual sales и будущий acquiring ложатся на одну и ту же commerce модель без переделки student ACL и runtime.
