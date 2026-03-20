# Право Просто — API Spec MVP

## Scope

- Этот документ фиксирует HTTP JSON API для MVP.
- Источники истины для доменной модели:
  - [ARCHITECTURE.md](/Users/aatamplon/PycharmProjects/hse/pravoprost/ARCHITECTURE.md)
  - [DB_SCHEMA.md](/Users/aatamplon/PycharmProjects/hse/pravoprost/DB_SCHEMA.md)
- API проектируется под:
  - backend: Go modular monolith;
  - frontend: React SPA;
  - auth: SSO + server-side session cookie.

## API Principles

- Base path: `/api/v1`.
- Transport: `application/json`.
- Успешные ответы возвращают JSON object/array без универсального `data` envelope.
- Ошибки возвращаются в едином error shape.
- Success DTO ориентированы на UI read models, а не на прямую выдачу внутренних таблиц.
- Backend остается source of truth для:
  - access state;
  - lesson progress;
  - DAG navigation;
  - hearts/xp/streak changes;
  - moderation and commerce transitions.

## Auth Model

- Аутентификация через server-side session cookie.
- Cookie: `HttpOnly`, `Secure`, `SameSite=Lax`.
- Все cookie-authenticated mutating endpoints требуют CSRF protection.
- JWT в local storage не используется.

## Headers

Общие:

- `Content-Type: application/json`
- `Accept: application/json`
- `X-Request-ID` optional

Cookie-authenticated mutating endpoints:

- `X-CSRF-Token` required

Idempotent write endpoints:

- `Idempotency-Key` required for:
  - `POST /api/v1/student/lesson-sessions/{sessionID}/answer`
  - `POST /api/v1/admin/commerce/orders/{orderID}/payments/manual-confirm`

## Error Model

Все non-2xx ответы используют единый shape:

```json
{
  "error": {
    "code": "content_locked_paid",
    "message": "Lesson is locked until access is granted",
    "details": {
      "lesson_id": "lesson_3"
    },
    "request_id": "req_123"
  }
}
```

### Error Fields

- `code`: machine-readable domain/application error code
- `message`: human-readable message
- `details`: optional structured payload
- `request_id`: optional trace id

### Common HTTP Statuses

- `400 Bad Request` — invalid input
- `401 Unauthorized` — no session
- `403 Forbidden` — role mismatch / ACL deny
- `404 Not Found` — object not found or not visible to caller
- `409 Conflict` — version conflict, invalid state transition, duplicate pending action
- `422 Unprocessable Entity` — draft validation errors, domain validation errors
- `429 Too Many Requests` — optional rate limiting

### Common Error Codes

- `unauthorized`
- `forbidden`
- `role_not_selected`
- `role_already_set`
- `forbidden_admin_role_selection`
- `invalid_return_to`
- `teacher_profile_required`
- `draft_version_conflict`
- `content_locked_paid`
- `content_access_awaiting_confirmation`
- `locked_prerequisite`
- `locked_teacher_access`
- `out_of_hearts`
- `lesson_session_not_active`
- `lesson_session_state_conflict`
- `preview_session_not_found`
- `preview_session_state_conflict`
- `invalid_preview_action`
- `duplicate_answer_submission`
- `llm_temporarily_unavailable`
- `draft_validation_failed`
- `moderation_review_already_pending`
- `course_not_publishable`
- `manual_payment_mismatch`
- `payment_already_confirmed`
- `entitlement_already_active`
- `order_already_pending_for_target`
- `offer_not_found`
- `offer_not_active`
- `purchase_request_already_open`
- `account_blocked`

## Common Enums

```json
{
  "role": "unselected | student | parent | teacher | admin",
  "verdict": "correct | partial | incorrect",
  "access_state": "free | granted | locked_paid | awaiting_payment_confirmation | locked_prerequisite | locked_teacher_access",
  "course_kind": "platform_catalog | teacher_private",
  "course_owner_kind": "platform | teacher",
  "draft_workflow_status": "editing | in_review | changes_requested | archived",
  "review_status": "pending | approved | rejected",
  "order_status": "awaiting_confirmation | fulfilled | canceled"
}
```

## Shared DTOs

### SessionView

```json
{
  "authenticated": true,
  "csrf_token": "csrf_123",
  "user": {
    "account_id": "uuid",
    "role": "student",
    "status": "active"
  },
  "onboarding": {
    "role_selection_required": false,
    "teacher_profile_required": false
  }
}
```

### UserSummary

```json
{
  "account_id": "uuid",
  "role": "student",
  "display_name": "Ира",
  "avatar_url": "https://..."
}
```

### StudentCatalogItem

```json
{
  "course_id": "uuid",
  "title": "Мошенники в интернете",
  "description": "Короткий курс о цифровой безопасности",
  "cover_url": "https://...",
  "course_kind": "platform_catalog",
  "owner_kind": "platform",
  "source_section": "platform_catalog",
  "progress_percent": 40,
  "is_new": true,
  "badges": ["new", "popular"]
}
```

### StudentLessonAccessState

```json
{
  "lesson_id": "lesson_3",
  "access_state": "locked_paid",
  "offer": {
    "offer_id": "uuid",
    "title": "Урок 3",
    "price_amount_minor": 49000,
    "currency": "RUB",
    "target_type": "lesson",
    "target_lesson_id": "lesson_3"
  },
  "order": null,
  "support_hint": "Доступ выдается после подтверждения администратором"
}
```

### StudentCourseTree

```json
{
  "course_id": "uuid",
  "course_revision_id": "uuid",
  "title": "Мошенники в интернете",
  "description": "Курс о цифровой безопасности",
  "modules": [
    {
      "module_id": "module_1",
      "title": "Подозрительные сообщения",
      "lessons": [
        {
          "lesson_id": "lesson_1",
          "title": "Подозрительная ссылка",
          "status": "completed",
          "progress_percent": 100,
          "access": {
            "lesson_id": "lesson_1",
            "access_state": "free",
            "offer": null,
            "order": null,
            "support_hint": null
          }
        }
      ]
    }
  ]
}
```

### LessonStepView

```json
{
  "session_id": "uuid",
  "course_id": "uuid",
  "lesson_id": "lesson_1",
  "state_version": 3,
  "node_id": "n2",
  "node_kind": "single_choice",
  "payload": {
    "prompt": "Что ты сделаешь?",
    "asset_url": "https://...",
    "options": [
      { "id": "a1", "text": "Открою ссылку" },
      { "id": "a2", "text": "Покажу взрослому" }
    ]
  },
  "steps_completed": 2,
  "steps_total": 5,
  "progress_ratio": 0.4,
  "game_state": {
    "xp_total": 120,
    "level": 2,
    "hearts_current": 4,
    "hearts_max": 5,
    "hearts_restore_at": "2026-03-14T11:30:00Z"
  }
}
```

### AnswerOutcome

`next_action` может принимать значения:
- `show_next_node`
- `lesson_completed`
- `out_of_hearts`
- `retry_llm`

```json
{
  "verdict": "partial",
  "feedback_text": "Ты назвал верную идею, но не объяснил, почему пароль нельзя сообщать.",
  "xp_delta": 5,
  "hearts_delta": 0,
  "game_state": {
    "xp_total": 125,
    "level": 2,
    "hearts_current": 4,
    "hearts_max": 5,
    "hearts_restore_at": "2026-03-14T11:30:00Z"
  },
  "next_action": "show_next_node",
  "next_node_id": "n7",
  "lesson_completion": null,
  "next_step": {
    "session_id": "uuid",
    "course_id": "uuid",
    "lesson_id": "lesson_1",
    "state_version": 4,
    "node_id": "n7",
    "node_kind": "story",
    "payload": {
      "text": "Подумай, кому можно доверять пароль.",
      "asset_url": "https://..."
    },
    "steps_completed": 3,
    "steps_total": 5,
    "progress_ratio": 0.6,
    "game_state": {
      "xp_total": 125,
      "level": 2,
      "hearts_current": 4,
      "hearts_max": 5,
      "hearts_restore_at": "2026-03-14T11:30:00Z"
    }
  }
}
```

### PreviewAnswerOutcome

Preview использует отдельный shape без XP/hearts/game mutations:

```json
{
  "preview": true,
  "verdict": "correct",
  "feedback_text": "Это безопасный вариант",
  "next_step": {
    "session_id": "preview_session",
    "course_id": "uuid",
    "lesson_id": "lesson_1",
    "state_version": 3,
    "node_id": "n4",
    "node_kind": "story",
    "payload": {
      "text": "Верно, сначала покажи сообщение взрослому."
    },
    "steps_completed": 2,
    "steps_total": 5,
    "progress_ratio": 0.4,
    "game_state": null
  }
}
```

For completion:

```json
{
  "verdict": "correct",
  "feedback_text": "Отлично!",
  "xp_delta": 10,
  "hearts_delta": 0,
  "game_state": {
    "xp_total": 140,
    "level": 3,
    "hearts_current": 4,
    "hearts_max": 5,
    "hearts_restore_at": "2026-03-14T11:30:00Z"
  },
  "next_action": "lesson_completed",
  "next_node_id": null,
  "lesson_completion": {
    "lesson_id": "lesson_1",
    "accuracy_percent": 80,
    "time_spent_seconds": 185,
    "lesson_xp_earned": 25,
    "current_streak_days": 4,
    "next_lesson_id": "lesson_2"
  },
  "next_step": null
}
```

### ValidationErrorView

```json
{
  "error": {
    "code": "draft_validation_failed",
    "message": "Draft contains validation errors",
    "details": {
      "errors": [
        {
          "path": "modules[0].lessons[1].graph.nodes[3]",
          "code": "missing_transition",
          "message": "Free text node must define transitions for all three verdicts"
        }
      ]
    }
  }
}
```

## Auth / Session

### GET `/api/v1/session`

Purpose:
- получить текущую сессию;
- узнать, нужен ли role onboarding;
- узнать, нужен ли teacher onboarding;
- получить CSRF token.

Auth:
- public

Response `200`:
- `SessionView`

### POST `/api/v1/auth/logout`

Purpose:
- завершить сессию.

Auth:
- any authenticated role

Response `204`

### GET `/api/v1/auth/sso/{provider}/start`

Purpose:
- начать SSO login flow.

Query:

```json
{
  "return_to": "/claim/course-link#token=opaque123"
}
```

Notes:
- `return_to` optional;
- raw claim token should travel in URL fragment or other client-side container, not in path/query sent to backend;
- backend stores it in pre-auth server session state.

Response:
- `302` redirect to provider

### GET `/api/v1/auth/sso/{provider}/callback`

Purpose:
- завершить SSO flow;
- создать/найти account;
- восстановить `return_to`.

Response:
- `302` to:
  - onboarding role selection if `role = unselected`
  - stored `return_to`, if present and valid
  - role home screen otherwise

### POST `/api/v1/onboarding/role`

Purpose:
- one-time role selection.

Auth:
- authenticated, `role = unselected` or same role idempotent repeat

Request:

```json
{
  "role": "student"
}
```

Allowed values:
- `student`
- `parent`
- `teacher`

Response `200`:

```json
{
  "account_id": "uuid",
  "role": "student"
}
```

Notes:
- backend lazily initializes missing `student_game_state` / `student_streak_state` and must not return `404` for a new student.

Errors:
- `409 role_already_set`
- `403 forbidden_admin_role_selection`
- `422 invalid_role_selection`

## Student API

### GET `/api/v1/student/catalog`

Purpose:
- unified catalog for student.

Auth:
- `student`

Response `200`:

```json
{
  "sections": [
    {
      "section": "platform_catalog",
      "title": "Курсы платформы",
      "items": [
        {
          "course_id": "uuid",
          "title": "Мошенники в интернете",
          "description": "Короткий курс",
          "cover_url": "https://...",
          "course_kind": "platform_catalog",
          "owner_kind": "platform",
          "source_section": "platform_catalog",
          "progress_percent": 40,
          "is_new": true,
          "badges": ["new"]
        }
      ]
    },
    {
      "section": "teacher_access",
      "title": "Курсы по ссылке",
      "items": []
    }
  ]
}
```

### GET `/api/v1/student/courses/{courseID}`

Purpose:
- получить course tree с pinned revision и lesson access states.

Auth:
- `student`

Response `200`:
- `StudentCourseTree`

Errors:
- `404 course_not_found`
- `403 locked_teacher_access`

### GET `/api/v1/student/game-state`

Auth:
- `student`

Response `200`:

```json
{
  "xp_total": 120,
  "level": 2,
  "hearts_current": 4,
  "hearts_max": 5,
  "hearts_restore_at": "2026-03-14T11:30:00Z",
  "current_streak_days": 3,
  "best_streak_days": 7,
  "badges": [
    {
      "badge_code": "first_lesson",
      "awarded_at": "2026-03-10T09:00:00Z"
    }
  ]
}
```

### POST `/api/v1/student/guardian-links/claim`

Purpose:
- child claims parent invite after SSO.

Auth:
- `student`

Request:

```json
{
  "token": "raw-token-from-deeplink"
}
```

Response `200`:

```json
{
  "parent": {
    "account_id": "uuid",
    "display_name": "Мама"
  },
  "link_status": "active"
}
```

Errors:
- `404 invite_not_found`
- `409 invite_already_used`
- `409 guardian_limit_reached`

### POST `/api/v1/student/course-links/claim`

Purpose:
- claim teacher course access.

Auth:
- `student`

Request:

```json
{
  "token": "raw-token-from-deeplink"
}
```

Response `200`:

```json
{
  "course_id": "uuid",
  "granted": true
}
```

Errors:
- `404 course_link_not_found`
- `409 course_link_revoked`
- `409 course_not_published`

### POST `/api/v1/student/offers/{offerID}/purchase-requests`

Purpose:
- create student-side request for manual paid access flow.

Auth:
- `student`

Request:
- empty body

Response `201`:

```json
{
  "purchase_request_id": "uuid",
  "offer_id": "uuid",
  "status": "open"
}
```

Errors:
- `404 offer_not_found`
- `409 offer_not_active`
- `409 purchase_request_already_open`

### POST `/api/v1/student/courses/{courseID}/lessons/{lessonID}/start`

Purpose:
- start or resume lesson session.

Auth:
- `student`

Request:
- empty body

Behavior:
- checks MVP prerequisite rules:
  - lessons inside one module unlock sequentially by module `sort_order`;
  - a lesson is `locked_prerequisite` until the previous lesson in the same module is completed;
- checks access state before creating/resuming session;
- reuses active `lesson_session` if it exists.

Response `200`:
- `LessonStepView`

Errors:
- `409 content_locked_paid`
- `409 content_access_awaiting_confirmation`
- `409 locked_prerequisite`
- `403 locked_teacher_access`

### GET `/api/v1/student/courses/{courseID}/lessons/{lessonID}/session`

Purpose:
- restore active session after refresh/reopen.

Auth:
- `student`

Response `200`:
- `LessonStepView`

Errors:
- `404 lesson_session_not_found`
- `409 content_locked_paid`
- `409 content_access_awaiting_confirmation`

### GET `/api/v1/student/lesson-sessions/{sessionID}`

Purpose:
- fetch active session by explicit id.

Auth:
- `student`

Response `200`:
- `LessonStepView`

Errors:
- `404 lesson_session_not_found`
- `409 content_locked_paid`
- `409 content_access_awaiting_confirmation`
- `409 lesson_session_not_active`

### POST `/api/v1/student/lesson-sessions/{sessionID}/next`

Purpose:
- advance from `story` node.

Auth:
- `student`

Request:

```json
{
  "state_version": 3,
  "expected_node_id": "n1"
}
```

Response `200`:
- `LessonStepView`

Errors:
- `409 lesson_session_state_conflict`
- `409 lesson_session_not_active`
- `409 content_locked_paid`

Notes:
- `expected_node_id` is required to disambiguate stale conflict from duplicate retry.
- If `state_version` is stale but current session state already equals the deterministic post-transition state from `expected_node_id`, backend may return `200` with current post-transition step as duplicate-safe replay.
- If current session state cannot be explained as that deterministic replay, backend must return `409 lesson_session_state_conflict`.

### POST `/api/v1/student/lesson-sessions/{sessionID}/answer`

Purpose:
- submit answer for `single_choice` or `free_text`.

Auth:
- `student`

Headers:
- `Idempotency-Key` required

Request:

```json
{
  "state_version": 3,
  "node_id": "n2",
  "answer": {
    "kind": "single_choice",
    "option_id": "a2"
  }
}
```

For free text:

```json
{
  "state_version": 4,
  "node_id": "n5",
  "answer": {
    "kind": "free_text",
    "text": "Пароль нельзя сообщать посторонним"
  }
}
```

Response `200`:
- `AnswerOutcome`

Errors:
- `409 duplicate_answer_submission`
- `409 lesson_session_state_conflict`
- `409 out_of_hearts`
- `409 content_locked_paid`
- `503 llm_temporarily_unavailable`

### POST `/api/v1/student/courses/{courseID}/lessons/{lessonID}/retry`

Purpose:
- explicit lesson retry for completed lesson.

Auth:
- `student`

Request:
- empty body

Response `200`:
- first `LessonStepView` of new session

Errors:
- `409 lesson_retry_not_allowed`

Notes:
- replay must still create a new session and not mutate historical attempts.
- retry does not restore hearts in MVP; hearts recover only by time-based recovery policy.

### GET `/api/v1/student/profile`

Auth:
- `student`

Response `200`:

```json
{
  "account_id": "uuid",
  "display_name": "Ира",
  "avatar_url": "https://...",
  "xp_total": 120,
  "level": 2,
  "current_streak_days": 3,
  "best_streak_days": 7,
  "completed_lessons": 10,
  "active_courses": [
    {
      "course_id": "uuid",
      "title": "Мошенники в интернете",
      "progress_percent": 40
    }
  ],
  "badges": [
    {
      "badge_code": "first_lesson",
      "awarded_at": "2026-03-10T09:00:00Z"
    }
  ]
}
```

### PUT `/api/v1/student/profile`

Auth:
- `student`

Request:

```json
{
  "display_name": "Ира",
  "avatar_asset_id": "uuid"
}
```

Response `200`:
- updated profile object

Notes:
- `hearts_restore_at` is a computed read-model field derived by backend from persisted `hearts_updated_at` and hearts recovery policy.
- `avatar_asset_id` must reference an asset uploaded by the same account.

## Parent API

### GET `/api/v1/parent/children`

Auth:
- `parent`

Response `200`:

```json
{
  "children": [
    {
      "student_id": "uuid",
      "display_name": "Ира",
      "avatar_url": "https://...",
      "xp_total": 120,
      "current_streak_days": 3,
      "completed_lessons": 10,
      "last_activity_at": "2026-03-14T09:00:00Z"
    }
  ]
}
```

### POST `/api/v1/parent/children/link-invites`

Auth:
- `parent`

Request:
- empty body

Response `201`:

```json
{
  "invite_id": "uuid",
  "claim_url": "https://app.example.com/claim/guardian-link#token=abc123",
  "expires_at": "2026-03-21T09:00:00Z"
}
```

### GET `/api/v1/parent/children/link-invites`

Auth:
- `parent`

Response `200`:

```json
{
  "items": [
    {
      "invite_id": "uuid",
      "status": "active",
      "expires_at": "2026-03-21T09:00:00Z",
      "used_at": null
    }
  ]
}
```

### POST `/api/v1/parent/children/link-invites/{inviteID}/revoke`

Auth:
- `parent`

Request:
- empty body

Response `200`:

```json
{
  "invite_id": "uuid",
  "status": "revoked"
}
```

Errors:
- `404 invite_not_found`
- `409 invite_already_resolved`

### GET `/api/v1/parent/children/{studentID}/progress`

Auth:
- `parent`

Response `200`:

```json
{
  "student": {
    "student_id": "uuid",
    "display_name": "Ира",
    "avatar_url": "https://..."
  },
  "summary": {
    "xp_total": 120,
    "current_streak_days": 3,
    "time_spent_minutes": 55,
    "correctness_percent": 78
  },
  "courses": [
    {
      "course_id": "uuid",
      "title": "Мошенники в интернете",
      "progress_percent": 40,
      "lessons": [
        {
          "lesson_id": "lesson_1",
          "title": "Подозрительная ссылка",
          "status": "completed",
          "best_verdict": "correct"
        }
      ]
    }
  ]
}
```

### GET `/api/v1/parent/profile`

### PUT `/api/v1/parent/profile`

Same shape as student profile without game stats.

## Teacher API

Teacher authoring rule:

- until teacher profile has non-empty `display_name` and `organization_name`, teacher authoring endpoints below return `409 teacher_profile_required`.

### GET `/api/v1/teacher/courses`

Auth:
- `teacher`

Response `200`:

```json
{
  "items": [
    {
      "course_id": "uuid",
      "title": "Финансовая грамотность",
      "workflow_status": "editing",
      "review_status": null,
      "published_revision_id": null,
      "students_count": 0,
      "updated_at": "2026-03-14T10:00:00Z"
    }
  ]
}
```

### POST `/api/v1/teacher/courses`

Auth:
- `teacher`

Request:

```json
{
  "title": "Финансовая грамотность",
  "description": "Базовый курс",
  "age_min": 9,
  "age_max": 12
}
```

Response `201`:

```json
{
  "course_id": "uuid",
  "draft_id": "uuid"
}
```

### GET `/api/v1/teacher/courses/{courseID}/draft`

Auth:
- `teacher`

Response `200`:

```json
{
  "course_id": "uuid",
  "draft_id": "uuid",
  "draft_version": 7,
  "workflow_status": "editing",
  "title": "Финансовая грамотность",
  "description": "Базовый курс",
  "age_min": 9,
  "age_max": 12,
  "cover_asset_id": "uuid",
  "content": {
    "modules": []
  },
  "last_published_revision_id": null,
  "validation": {
    "is_valid": true,
    "errors": []
  }
}
```

### PUT `/api/v1/teacher/courses/{courseID}/draft`

Auth:
- `teacher`

Purpose:
- full draft replace with optimistic locking.

Request:

```json
{
  "draft_version": 7,
  "title": "Финансовая грамотность",
  "description": "Базовый курс",
  "age_min": 9,
  "age_max": 12,
  "cover_asset_id": "uuid",
  "content": {
    "modules": [
      {
        "id": "module_1",
        "title": "Безопасные покупки",
        "lessons": []
      }
    ]
  }
}
```

Response `200`:

```json
{
  "draft_id": "uuid",
  "draft_version": 8,
  "workflow_status": "editing",
  "validation": {
    "is_valid": true,
    "errors": []
  }
}
```

Errors:
- `409 draft_version_conflict`
- `422 draft_validation_failed`

### POST `/api/v1/teacher/courses/{courseID}/preview`

Auth:
- `teacher`

Purpose:
- preview current draft through lesson engine.

Request:

```json
{
  "lesson_id": "lesson_1"
}
```

Response `200`:

```json
{
  "preview": true,
  "preview_session_id": "preview_session",
  "step": {
    "session_id": "preview_session",
    "course_id": "uuid",
    "lesson_id": "lesson_1",
    "state_version": 1,
    "node_id": "n1",
    "node_kind": "story",
    "payload": {
      "text": "Тебе пришло сообщение..."
    },
    "steps_completed": 0,
    "steps_total": 5,
    "progress_ratio": 0.0,
    "game_state": null
  }
}
```

### POST `/api/v1/preview-sessions/{previewSessionID}/next`

Auth:
- `teacher` or `admin`

Request:

```json
{
  "state_version": 1
}
```

Response `200`:

```json
{
  "preview": true,
  "step": {
    "session_id": "preview_session",
    "course_id": "uuid",
    "lesson_id": "lesson_1",
    "state_version": 2,
    "node_id": "n2",
    "node_kind": "single_choice",
    "payload": {
      "prompt": "Что ты сделаешь?",
      "options": [
        { "id": "a1", "text": "Открою ссылку" },
        { "id": "a2", "text": "Покажу взрослому" }
      ]
    },
    "steps_completed": 1,
    "steps_total": 5,
    "progress_ratio": 0.2,
    "game_state": null
  }
}
```

Errors:
- `404 preview_session_not_found`
- `409 preview_session_state_conflict`
- `409 invalid_preview_action`

### POST `/api/v1/preview-sessions/{previewSessionID}/answer`

Auth:
- `teacher` or `admin`

Request:

```json
{
  "state_version": 2,
  "node_id": "n2",
  "answer": {
    "kind": "single_choice",
    "option_id": "a2"
  }
}
```

Response `200`:
- `PreviewAnswerOutcome`

Errors:
- `404 preview_session_not_found`
- `409 preview_session_state_conflict`
- `409 invalid_preview_action`

### POST `/api/v1/teacher/courses/{courseID}/submit-review`

Auth:
- `teacher`

Request:
- empty body

Response `200`:

```json
{
  "review_id": "uuid",
  "status": "pending"
}
```

Errors:
- `409 moderation_review_already_pending`
- `422 draft_validation_failed`

### GET `/api/v1/teacher/courses/{courseID}/review-status`

Auth:
- `teacher`

Response `200`:

```json
{
  "current": {
    "review_id": "uuid",
    "status": "pending",
    "submitted_at": "2026-03-14T09:00:00Z",
    "review_comment": null
  },
  "history": []
}
```

### POST `/api/v1/teacher/courses/{courseID}/access-links`

Auth:
- `teacher`

Request:

```json
{
  "expires_at": "2026-04-01T00:00:00Z"
}
```

Response `201`:

```json
{
  "link_id": "uuid",
  "claim_url": "https://app.example.com/claim/course-link#token=abc123",
  "status": "active",
  "expires_at": "2026-04-01T00:00:00Z"
}
```

Errors:
- `409 course_not_published`
- `409 course_not_teacher_private`

### GET `/api/v1/teacher/courses/{courseID}/access-links`

Auth:
- `teacher`

Response `200`:

```json
{
  "items": [
    {
      "link_id": "uuid",
      "status": "active",
      "claim_url": "https://app.example.com/claim/course-link#token=abc123",
      "expires_at": "2026-04-01T00:00:00Z"
    }
  ]
}
```

### POST `/api/v1/teacher/access-links/{linkID}/revoke`

Auth:
- `teacher`

Request:
- empty body

Response `200`:

```json
{
  "link_id": "uuid",
  "status": "revoked"
}
```

### GET `/api/v1/teacher/courses/{courseID}/students`

Auth:
- `teacher`

Response `200`:

```json
{
  "course_id": "uuid",
  "title": "Финансовая грамотность",
  "students": [
    {
      "student_id": "uuid",
      "display_name": "Ира",
      "progress_percent": 60,
      "xp_total": 120,
      "correctness_percent": 80,
      "last_activity_at": "2026-03-14T09:00:00Z"
    }
  ]
}
```

### GET `/api/v1/teacher/courses/{courseID}/students/{studentID}`

Auth:
- `teacher`

Response `200`:

```json
{
  "student": {
    "student_id": "uuid",
    "display_name": "Ира"
  },
  "summary": {
    "progress_percent": 60,
    "xp_total": 120,
    "correctness_percent": 80
  },
  "lessons": [
    {
      "lesson_id": "lesson_1",
      "title": "Подозрительная ссылка",
      "status": "completed",
      "best_verdict": "correct",
      "attempts_count": 2,
      "last_activity_at": "2026-03-14T09:00:00Z"
    }
  ]
}
```

### POST `/api/v1/teacher/courses/{courseID}/archive`

Auth:
- `teacher`

Request:
- empty body

Response `200`:

```json
{
  "course_id": "uuid",
  "status": "archived"
}
```

### GET `/api/v1/teacher/profile`

### PUT `/api/v1/teacher/profile`

Same shape as student profile, plus:

```json
{
  "organization_name": "Школа 123"
}
```

## Assets API

### POST `/api/v1/assets/upload-requests`

Auth:
- any authenticated role

Request:

```json
{
  "file_name": "cover.png",
  "mime_type": "image/png",
  "size_bytes": 123456
}
```

Response `201`:

```json
{
  "asset_id": "uuid",
  "upload_url": "https://storage.example.com/presigned",
  "method": "PUT",
  "headers": {
    "Content-Type": "image/png"
  }
}
```

## Admin API

### GET `/api/v1/admin/courses`

Auth:
- `admin`

Response `200`:

```json
{
  "items": [
    {
      "course_id": "uuid",
      "title": "Мошенники в интернете",
      "course_kind": "platform_catalog",
      "owner_kind": "platform",
      "current_revision_id": "uuid",
      "updated_at": "2026-03-14T10:00:00Z"
    }
  ]
}
```

### POST `/api/v1/admin/courses`

Auth:
- `admin`

Request/response:
- same as teacher create, but creates `platform_catalog` course

### GET `/api/v1/admin/courses/{courseID}/draft`

### PUT `/api/v1/admin/courses/{courseID}/draft`

### POST `/api/v1/admin/courses/{courseID}/preview`

Auth:
- `admin`

Behavior:
- same draft shapes and validation semantics as teacher draft endpoints
- admin preview uses the same shared preview session contract as teacher preview

### POST `/api/v1/admin/courses/{courseID}/publish`

Auth:
- `admin`

Request:
- empty body

Response `200`:

```json
{
  "course_id": "uuid",
  "course_revision_id": "uuid",
  "version_no": 3,
  "published_at": "2026-03-14T10:30:00Z"
}
```

Errors:
- `422 course_not_publishable`

### GET `/api/v1/admin/moderation/queue`

Auth:
- `admin`

Response `200`:

```json
{
  "items": [
    {
      "review_id": "uuid",
      "course_id": "uuid",
      "draft_id": "uuid",
      "title": "Финансовая грамотность",
      "teacher": {
        "account_id": "uuid",
        "display_name": "Мария Иванова"
      },
      "submitted_at": "2026-03-14T09:00:00Z"
    }
  ]
}
```

### POST `/api/v1/admin/moderation/reviews/{reviewID}/approve`

Auth:
- `admin`

Request:

```json
{
  "comment": "Курс одобрен"
}
```

Response `200`:

```json
{
  "review_id": "uuid",
  "status": "approved",
  "published_revision_id": "uuid"
}
```

### POST `/api/v1/admin/moderation/reviews/{reviewID}/reject`

Auth:
- `admin`

Request:

```json
{
  "comment": "Нужно исправить ветвление урока 2"
}
```

Response `200`:

```json
{
  "review_id": "uuid",
  "status": "rejected"
}
```

### POST `/api/v1/admin/courses/{courseID}/access-grants`

Purpose:
- manual teacher-private grant only.

Auth:
- `admin`

Request:

```json
{
  "student_id": "uuid"
}
```

Response `201`:

```json
{
  "grant_id": "uuid",
  "course_id": "uuid",
  "student_id": "uuid"
}
```

Errors:
- `409 platform_content_must_use_entitlement`

### GET `/api/v1/admin/users`

Auth:
- `admin`

Query:
- `role` optional
- `cursor` optional

Response `200`:

```json
{
  "items": [
    {
      "account_id": "uuid",
      "role": "student",
      "display_name": "Ира",
      "registered_at": "2026-03-01T09:00:00Z",
      "xp_total": 120,
      "last_activity_at": "2026-03-14T09:00:00Z"
    }
  ],
  "next_cursor": null
}
```

### GET `/api/v1/admin/users/{userID}`

Auth:
- `admin`

Response `200`:

```json
{
  "user": {
    "account_id": "uuid",
    "role": "student",
    "display_name": "Ира"
  },
  "stats": {
    "xp_total": 120,
    "completed_courses": 1,
    "completed_lessons": 10,
    "last_activity_at": "2026-03-14T09:00:00Z"
  }
}
```

### POST `/api/v1/admin/users/{userID}/block`

Auth:
- `admin`

Request:

```json
{
  "reason": "abusive content"
}
```

Response `200`:

```json
{
  "account_id": "uuid",
  "status": "blocked",
  "sessions_revoked": true
}
```

### POST `/api/v1/admin/users/{userID}/unblock`

Auth:
- `admin`

Request:
- empty body

Response `200`:

```json
{
  "account_id": "uuid",
  "status": "active"
}
```

### GET `/api/v1/admin/profile`

### PUT `/api/v1/admin/profile`

Same shape as base profile update.

## Admin Commerce API

### GET `/api/v1/admin/commerce/offers`

Auth:
- `admin`

Response `200`:

```json
{
  "items": [
    {
      "offer_id": "uuid",
      "title": "Урок 3",
      "status": "active",
      "target_type": "lesson",
      "target_course_id": "uuid",
      "target_lesson_id": "lesson_3",
      "price_amount_minor": 49000,
      "price_currency": "RUB"
    }
  ]
}
```

### POST `/api/v1/admin/commerce/offers`

Auth:
- `admin`

Request:

```json
{
  "target_type": "lesson",
  "target_course_id": "uuid",
  "target_lesson_id": "lesson_3",
  "title": "Урок 3",
  "description": "Платный урок",
  "price_amount_minor": 49000,
  "price_currency": "RUB"
}
```

Response `201`:

```json
{
  "offer_id": "uuid",
  "status": "draft"
}
```

Errors:
- `422 invalid_offer_target`
- `409 teacher_content_cannot_be_paid`

### PUT `/api/v1/admin/commerce/offers/{offerID}`

Auth:
- `admin`

Request:

```json
{
  "title": "Урок 3",
  "description": "Обновленное описание",
  "price_amount_minor": 49000,
  "price_currency": "RUB",
  "status": "active"
}
```

Response `200`:
- updated offer view

### GET `/api/v1/admin/commerce/purchase-requests`

Auth:
- `admin`

Response `200`:

```json
{
  "items": [
    {
      "purchase_request_id": "uuid",
      "student": {
        "account_id": "uuid",
        "display_name": "Ира"
      },
      "offer": {
        "offer_id": "uuid",
        "title": "Урок 3"
      },
      "status": "open",
      "created_at": "2026-03-14T10:00:00Z"
    }
  ]
}
```

### POST `/api/v1/admin/commerce/purchase-requests/{requestID}/decline`

Auth:
- `admin`

Request:

```json
{
  "reason": "Request cannot be processed right now"
}
```

Response `200`:

```json
{
  "purchase_request_id": "uuid",
  "status": "declined"
}
```

Errors:
- `404 purchase_request_not_found`
- `409 purchase_request_already_resolved`

### GET `/api/v1/admin/commerce/orders`

Auth:
- `admin`

Query:
- `status` optional
- `student_id` optional

Response `200`:

```json
{
  "items": [
    {
      "order_id": "uuid",
      "student": {
        "account_id": "uuid",
        "display_name": "Ира"
      },
      "offer": {
        "offer_id": "uuid",
        "title": "Урок 3"
      },
      "status": "awaiting_confirmation",
      "price_amount_minor": 49000,
      "currency": "RUB",
      "created_at": "2026-03-14T10:00:00Z"
    }
  ]
}
```

### POST `/api/v1/admin/commerce/orders/manual`

Auth:
- `admin`

Request:

```json
{
  "student_id": "uuid",
  "offer_id": "uuid",
  "purchase_request_id": "uuid"
}
```

Response `201`:

```json
{
  "order_id": "uuid",
  "status": "awaiting_confirmation",
  "price_amount_minor": 49000,
  "currency": "RUB"
}
```

Errors:
- `409 order_already_pending_for_target`
- `409 offer_not_active`
- `409 purchase_request_offer_mismatch`

Notes:
- if `purchase_request_id` is provided, backend must atomically mark that request as `processed` when order creation succeeds.

### POST `/api/v1/admin/commerce/orders/{orderID}/payments/manual-confirm`

Auth:
- `admin`

Headers:
- `Idempotency-Key` required

Request:

```json
{
  "external_reference": "cash-2026-03-14-001",
  "amount_minor": 49000,
  "currency": "RUB",
  "paid_at": "2026-03-14T10:15:00Z",
  "override": null
}
```

Override shape:

```json
{
  "external_reference": "cash-2026-03-14-001",
  "amount_minor": 50000,
  "currency": "RUB",
  "paid_at": "2026-03-14T10:15:00Z",
  "override": {
    "reason": "manual reconciliation approved by finance"
  }
}
```

Response `200`:

```json
{
  "order_id": "uuid",
  "payment_record_id": "uuid",
  "order_status": "fulfilled",
  "entitlement": {
    "entitlement_id": "uuid",
    "status": "active"
  }
}
```

Errors:
- `409 payment_already_confirmed`
- `409 manual_payment_mismatch`

Notes:
- order settlement uses order snapshot as source of truth; archived offer does not block manual confirm for an already created order.

### POST `/api/v1/admin/commerce/entitlements/grants`

Purpose:
- complimentary grant without payment record.

Auth:
- `admin`

Request:

```json
{
  "student_id": "uuid",
  "target_type": "lesson",
  "target_course_id": "uuid",
  "target_lesson_id": "lesson_3"
}
```

Response `201`:

```json
{
  "entitlement_id": "uuid",
  "status": "active"
}
```

Notes:
- if the same student/target has an unpaid open order, backend must cancel that order before issuing complimentary access;
- matching open purchase requests for the same student/target must be marked as `processed` in the same operation.

### POST `/api/v1/admin/commerce/entitlements/{entitlementID}/revoke`

Auth:
- `admin`

Request:

```json
{
  "reason": "Access revoked by admin"
}
```

Response `200`:

```json
{
  "entitlement_id": "uuid",
  "status": "revoked"
}
```

## Public API

### GET `/api/v1/public/promo-courses`

Purpose:
- landing page promo cards for platform courses.

Auth:
- public

Response `200`:

```json
{
  "items": [
    {
      "course_id": "uuid",
      "title": "Мошенники в интернете",
      "description": "Короткий курс о цифровой безопасности",
      "cover_url": "https://...",
      "badge": "Популярный"
    }
  ]
}
```

## Profile Update Semantics

For:
- `PUT /api/v1/student/profile`
- `PUT /api/v1/teacher/profile`
- `PUT /api/v1/parent/profile`
- `PUT /api/v1/admin/profile`

Rules:
- partial update is not supported in MVP;
- omitted nullable fields are treated as `null`;
- backend returns normalized persisted profile.
- teacher onboarding is completed only when teacher profile has non-empty `display_name` and `organization_name`.

## Draft Content Semantics

For `PUT .../draft`:

- request body contains full draft snapshot, not patch operations;
- `content` shape follows lesson document structure from [ARCHITECTURE.md](/Users/aatamplon/PycharmProjects/hse/pravoprost/ARCHITECTURE.md);
- backend validates:
  - module ids uniqueness;
  - lesson ids uniqueness within course;
  - DAG validity for each lesson graph;
  - referenced asset existence;
  - free-text transitions for all three verdicts.

## Idempotency and Concurrency

### Role Selection

- `POST /api/v1/onboarding/role` is idempotent only for repeat of the same role.
- Different role after first successful selection -> `409 role_already_set`.

### Lesson Start

- `POST /api/v1/student/courses/{courseID}/lessons/{lessonID}/start` is idempotent.
- If active session exists, backend returns it instead of creating a duplicate.

### Lesson Next / Answer

- `next` and `answer` require `state_version`.
- `next` additionally requires `expected_node_id`.
- `answer` additionally requires `Idempotency-Key`.
- `next` должен быть duplicate-safe по состоянию lesson session и может возвращать уже текущий post-transition state при retry после успешно завершенного перехода.
- Replayed `answer` with same idempotency key returns the same logical outcome or a duplicate-safe response.

### Manual Payment Confirm

- Manual confirm requires:
  - `Idempotency-Key` header
  - `external_reference` in body
- repeated confirm must not create duplicate `payment_record` or duplicate entitlement.

## Security Notes

- `return_to` accepted only from allow-listed internal paths.
- All role-scoped endpoints must check both session and role.
- Ownership checks are mandatory:
  - teacher sees only own courses and students of own published courses;
  - parent sees only linked children;
  - student sees only own progress/session/profile;
  - admin has global access.

## Non-Goals for MVP API

- No online checkout or provider payment endpoints in MVP.
- No public anonymous course catalog API beyond landing/marketing needs.
- No generic search API.
- No bulk admin mutation endpoints.
- No partial draft patch API.

## Recommended Implementation Order

1. `GET /session`, SSO endpoints, `POST /onboarding/role`
2. student profile/catalog/course tree/game-state
3. student claim flows
4. student lesson runtime endpoints
5. parent endpoints
6. teacher course authoring endpoints
7. admin publish/moderation endpoints
8. admin commerce endpoints
9. assets upload endpoint and remaining admin utilities
