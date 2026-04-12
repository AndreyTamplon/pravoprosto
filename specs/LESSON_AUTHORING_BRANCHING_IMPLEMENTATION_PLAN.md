# Lesson Authoring And Branching Implementation Plan

## Scope

This plan covers the following product requests:

1. In multiple-choice questions, allow multiple `correct` options and also support `partial` ("almost right") and `incorrect`.
2. Allow moving lesson nodes during authoring instead of reconstructing order by deletion.
3. Add story branching and the ability to go back and change the narrative choice.
4. For free-text questions, support different consequences for `correct` / `partial` / `incorrect`.
5. Explain how to author evaluation criteria in admin/teacher editors.

The plan is intentionally implementation-oriented and tied to the current codebase.

## Current State In Code

### Lesson graph and validation

- Authoring editors use frontend graph format with `nodes[] + edges[]`.
- Backend persisted graph format is a list of backend nodes with `kind`, `nextNodeId`, `options`, and `transitions`.
- Backend validation enforces:
  - `startNodeId` exists
  - all transition targets exist
  - graph is acyclic
  - all nodes are reachable from start

Relevant files:

- `frontend/src/api/types.ts`
- `backend/internal/courses/graph.go`
- `backend/internal/courses/validator.go`
- `backend/internal/httpserver/router.go`
- `frontend/src/api/client.ts`

### Multiple-choice today

- Runtime already supports option-level `result` values and can award `correct`, `partial`, or `incorrect`.
- Editors do not expose that model correctly:
  - teacher/admin editors only store `correct_option_id`
  - only one option can be marked correct
  - editor roundtrip collapses all non-correct options into a single "incorrect" bucket

Relevant files:

- `frontend/src/pages/teacher/LessonConstructor.tsx`
- `frontend/src/pages/admin/AdminLessonEditor.tsx`
- `frontend/src/api/types.ts`
- `backend/internal/lessonruntime/helpers.go`

### Free-text today

- Backend graph already supports per-verdict transitions for free text.
- Runtime uses LLM output for verdict and UI feedback.
- Editors only expose one generic `criteria` and one generic `feedback_text`.
- `criteria` is not passed to the evaluator today.
- `feedback_text` is not serialized into the persisted backend graph today.

Relevant files:

- `backend/internal/evaluation/free_text.go`
- `backend/internal/lessonruntime/helpers.go`
- `backend/internal/courses/service.go`
- `frontend/src/pages/teacher/LessonConstructor.tsx`
- `frontend/src/pages/admin/AdminLessonEditor.tsx`

### Story branching and back today

- Existing branching exists only for scored nodes:
  - `single_choice`
  - `free_text`
- `story` supports only one `nextNodeId`.
- Session state stores only `current_node_id` and `state_version`; there is no navigation history.
- Preview sessions also store only current node/state version.

Relevant files:

- `backend/internal/platform/db/migrations/0001_init.sql`
- `backend/internal/lessonruntime/service.go`
- `backend/internal/courses/service.go`

### Reordering today

- Teacher editor has `move up / move down`.
- Admin editor has no reorder controls.
- Both editors constrain target selection to nodes after the current node in visual order.
- `normalizeLessonGraph` currently auto-fills missing edges to the next node by order. That behaviour conflicts with any reorder design that wants invalid edges cleared instead of silently recreated.

Relevant files:

- `frontend/src/pages/teacher/LessonConstructor.tsx`
- `frontend/src/pages/admin/AdminLessonEditor.tsx`
- `frontend/src/api/types.ts`

## Product Assumptions

These assumptions make the scope implementable without rewriting the lesson engine:

1. Multiple-choice remains single-selection for the student.
   The new feature means multiple authored options may independently be marked `correct`, `partial`, or `incorrect`.
   If later we need true multi-select answers from the student, that should be a separate node kind.

2. "Story branching" is implemented as a new non-scored `decision` node.
   This keeps narrative branching separate from quiz logic, avoids XP/hearts side effects, and makes "go back and change choice" tractable.

3. "Go back and change choice" in v1 applies to `decision` nodes only.
   Rewinding scored questions would require compensating game state, aggregates, and attempt history. That is a different epic and should not be hidden inside this scope.

4. The lesson graph remains acyclic.
   Back navigation is session-level state management, not a content graph cycle.

## Target Model

### 1. Shared verdict model

Introduce a shared verdict-based authoring model across scored nodes.

#### `single_choice`

- Replace frontend editor model:
  - from: `correct_option_id`, `feedback_correct`, `feedback_incorrect`
  - to: option-level fields:
    - `option_id`
    - `text`
    - `verdict: 'correct' | 'partial' | 'incorrect'`
    - `feedback`
- Persist to backend using existing option shape:
  - `id`
  - `text`
  - `result`
  - `feedback`
  - `nextNodeId`

#### `free_text`

- Replace ambiguous `criteria` with structured rubric fields:
  - `reference_answer`
  - `criteria_correct`
  - `criteria_partial`
  - `criteria_incorrect`
- Replace one `feedback_text` with:
  - `feedback_correct`
  - `feedback_partial`
  - `feedback_incorrect`
- Persist this under `rubric`:
  - `referenceAnswer`
  - `criteriaByVerdict: { correct, partial, incorrect }`
  - `feedbackByVerdict: { correct, partial, incorrect }`

#### Runtime rule for free text

- LLM determines the verdict.
- Student-facing feedback comes from authored `feedbackByVerdict[verdict]`.
- LLM free-form feedback may still be kept for logs/debugging, but it must not be the primary UX payload anymore.

This makes free-text behaviour deterministic and testable.

### 2. New `decision` node kind

Add a non-scored branching node:

- `kind: 'decision'`
- payload:
  - `prompt`
  - `options[]`
    - `id`
    - `text`
    - `nextNodeId`

Decision nodes:

- do not consume hearts
- do not award XP
- do not write to `step_attempts`
- do not affect `course_progress.correct_answers/partial_answers/incorrect_answers`
- are fully supported in preview and runtime

### 3. Navigation history for back/change-choice

Add persistent session navigation history for student runtime and in-memory history for preview runtime.

#### Student runtime persistence

Add a new table:

- `lesson_session_path_entries`
  - `id uuid pk`
  - `lesson_session_id uuid not null`
  - `seq_no int not null`
  - `node_id text not null`
  - `node_kind text not null`
  - `entered_via text not null`
  - `decision_option_id text null`
  - `active boolean not null default true`
  - `created_at timestamptz not null default now()`

Semantics:

- append an entry whenever the session advances to a node
- only one active path exists at a time
- rewinding to a prior decision marks later path entries inactive
- new branch entries append after rewind with new sequence numbers

#### Preview runtime persistence

- Extend `previewSession` with in-memory `History []PreviewPathEntry`
- Keep behaviour parity with student runtime

### 4. Step contract additions

Both runtime and preview step payloads need explicit navigation metadata so the client can render the correct affordances after reload/resume.

Add to `StepView` and `PreviewStepView`:

- `navigation`
  - `can_go_back: boolean`
  - `back_kind: 'decision' | null`
  - `back_target_node_id?: string`

### 5. Reordering invariant

Editors continue to treat visual order as authoring order.

Invariant:

- outgoing edges may only point to nodes after the current node in editor order
- if a reorder makes an edge invalid under that invariant, the editor must clear the edge and surface a validation message or inline warning instead of silently pointing somewhere else

Do not auto-retarget branch edges to "next node" during reorder. Silent retargeting is too risky for authored content.

To support this, the existing automatic "fill missing edge with next node" fallback must be removed from `normalizeLessonGraph` before reorder work ships.

## Legacy Content Compatibility And Data Migration

Existing drafts/revisions and many current tests use legacy lesson graph shapes:

- `single_choice` represented in editor by `correct_option_id`
- `free_text` rubric with only `referenceAnswer`
- no `decision` nodes
- no structured `criteriaByVerdict` or `feedbackByVerdict`

This scope needs explicit compatibility handling. Without it, existing content and seeded tests will fail validation.

Required rollout:

1. Read compatibility:
   - `graphFromBackendFormat` accepts both old and new backend graph shapes.
   - legacy free-text nodes load with empty/default values for new rubric fields.

2. Canonical writes:
   - saving from new editors always writes the new canonical format.

3. Validation rollout:
   - draft validation tolerates legacy persisted content until that content has been saved through the new editors or backfilled.

4. Backfill:
   - add a migration or maintenance script that upgrades existing `course_drafts.content_json` and `course_revisions.content_json` to the canonical free-text rubric shape.
   - update helper builders and seeded tests accordingly.

## Delivery Plan

## Phase 0. Baseline And Shared Helpers

### Goals

- Centralize graph helpers before feature work fans out across teacher/admin/runtime/preview/tests.

### Implementation

Frontend:

- Refactor `frontend/src/api/types.ts`:
  - add `GraphNode.type = 'story' | 'single_choice' | 'free_text' | 'decision' | 'terminal'`
  - introduce richer editor-side types:
    - `ChoiceOptionDraft`
    - `FreeTextRubricDraft`
    - `DecisionOptionDraft`
- update:
  - `normalizeLessonGraph`
  - `graphToBackendFormat`
  - `graphFromBackendFormat`
  - edge helpers for `decision` option edges
  - remove silent fallback edge insertion from `normalizeLessonGraph`
- add frontend unit-test plumbing in `frontend/package.json`

Backend:

- Extend parsing/step rendering in:
  - `backend/internal/courses/graph.go`
  - `backend/internal/lessonruntime/helpers.go`
- Extend validation in `backend/internal/courses/validator.go`
- Extend API surface where needed in:
  - `frontend/src/api/client.ts`
  - `backend/internal/httpserver/router.go`

### Tests

Frontend unit tests to add:

- `graphToBackendFormat` preserves:
  - multiple correct options
  - partial options
  - free-text rubric structures
  - decision nodes
- `graphFromBackendFormat` roundtrip is lossless for the above
- `normalizeLessonGraph` removes invalid edges but does not mutate valid branch wiring

If no frontend unit test harness exists, add `vitest` and keep these tests pure-function only.

Backend tests to add/update:

- authoring validation accepts `decision`
- authoring validation accepts `single_choice` with many `correct` options
- authoring validation understands legacy free-text plus canonical free-text, with strictness gated by rollout stage
- compatibility tests for loading old persisted graphs and writing new canonical graphs
- router contract tests for any new lesson/preview endpoints

### Done criteria

- No feature work starts before graph roundtrip is covered by automated tests.
- Existing legacy lesson graphs still load until the compatibility/backfill path is in place.

## Phase 1. Multi-Verdict Multiple-Choice

### Goals

- Support authored `correct`, `partial`, `incorrect` per option.
- Support multiple correct options.
- Keep student runtime single-selection.

### Implementation

Teacher editor and admin editor:

- Replace "mark one correct option" controls with per-option verdict selector:
  - `Правильно`
  - `Почти`
  - `Неправильно`
- Each option gets its own feedback textarea or collapsible inline feedback field.
- Keep per-option next-node select.
- Require at least two options.
- Require at least one option with `correct` verdict.

Frontend data model:

- Replace:
  - `correct_option_id`
  - `feedback_correct`
  - `feedback_incorrect`
- With option-level data only.

Runtime:

- No scoring algorithm change required:
  - `correct => +10 XP`
  - `partial => +5 XP`
  - `incorrect => -1 heart`
- Preview and student runtime already understand verdicts, but must render option-authored feedback correctly after roundtrip.

Validation:

- `single_choice.options[*].result` must be one of `correct|partial|incorrect`
- every option must have `id/text/result/feedback/nextNodeId`
- at least one `correct` option must exist

### Files expected to change

- `frontend/src/pages/teacher/LessonConstructor.tsx`
- `frontend/src/pages/admin/AdminLessonEditor.tsx`
- `frontend/src/api/types.ts`
- `frontend/src/api/client.ts`
- `backend/internal/courses/validator.go`
- `e2e/helpers/course-builders.ts`
- `backend/internal/httpserver/router.go`

### Tests

Backend integration:

- authoring accepts two `correct` options and one `partial`
- student runtime returns:
  - `correct` verdict and `+10 XP`
  - `partial` verdict and `+5 XP`
  - `incorrect` verdict and `-1 heart`

E2E:

- teacher editor roundtrip preserves per-option verdicts and per-option feedback
- admin editor roundtrip preserves same
- preview follows distinct branches for:
  - correct option A
  - correct option B
  - partial option
  - incorrect option
- student runtime shows correct verdict badge and reward/penalty for each path

Candidate test files:

- update `backend/tests/authoring_test.go`
- update/add `backend/tests/student_runtime_test.go`
- update `backend/internal/httpserver/router_integration_test.go`
- update/add `e2e/tests/gate2/03-lesson-single-choice.spec.ts`
- update/add `e2e/tests/qa-regression/06-branch-roundtrip.spec.ts`

### Done criteria

- At least one test proves two different options both marked `correct` complete the lesson via correct semantics.
- At least one test proves a `partial` option survives save -> reload -> preview -> runtime.
- Legacy single-choice content still loads and is upgraded on first save.

## Phase 2. Free-Text Verdict Consequences And Criteria Authoring

### Goals

- Make free-text consequences explicit per verdict.
- Make rubric authoring understandable.
- Ensure evaluator actually receives authored criteria.

### Implementation

Editor UX:

- Replace single criteria field with three rubric fields:
  - `Критерии правильного ответа`
  - `Критерии частично верного ответа`
  - `Критерии неверного ответа`
- Replace single feedback field with three feedback fields:
  - `Что увидит ученик при правильном ответе`
  - `... при частично верном`
  - `... при неверном`
- Add an inline explainer block in admin and teacher editors:
  - what belongs in each field
  - one good example
  - one bad example

Persistence:

- Update backend graph format under `rubric`:
  - `referenceAnswer`
  - `criteriaByVerdict`
  - `feedbackByVerdict`

Runtime and preview:

- evaluator input becomes:
  - `Prompt`
  - `ReferenceAnswer`
  - `CriteriaCorrect`
  - `CriteriaPartial`
  - `CriteriaIncorrect`
  - `StudentAnswer`
- evaluator returns verdict
- runtime/preview choose authored feedback from rubric
- runtime keeps branch selection based on `transitions[verdict]`

Evaluation adapter:

- update `FreeTextEvaluationInput`
- update fake LLM app/testkit to preserve deterministic `[llm:correct|partial|incorrect]` contract
- update OpenAI-compatible prompt to include structured verdict criteria

Validation:

- free-text node must contain:
  - `referenceAnswer`
  - all three `criteriaByVerdict.*`
  - all three `feedbackByVerdict.*`
  - all three transitions
  - but legacy persisted nodes must remain loadable until backfill/save-upgrade occurs

### Files expected to change

- `backend/internal/evaluation/free_text.go`
- `backend/internal/lessonruntime/helpers.go`
- `backend/internal/courses/service.go`
- `backend/internal/courses/validator.go`
- `backend/internal/testkit/app/app.go`
- `frontend/src/pages/teacher/LessonConstructor.tsx`
- `frontend/src/pages/admin/AdminLessonEditor.tsx`
- `frontend/src/api/types.ts`
- `frontend/src/api/client.ts`
- `e2e/helpers/course-builders.ts`

### Tests

Backend:

- unit/contract test that evaluator request contains all rubric fields
- runtime test that:
  - `correct` uses authored `feedback_correct`
  - `partial` uses authored `feedback_partial`
  - `incorrect` uses authored `feedback_incorrect`
- runtime/preview parity test on identical lesson graph

E2E:

- teacher editor roundtrip preserves new rubric fields
- admin editor roundtrip preserves new rubric fields
- preview routes to different branch texts for correct/partial/incorrect
- student runtime displays authored feedback, not LLM-generated free text

Candidate test files:

- update `backend/tests/llm_contract_test.go`
- update `backend/tests/student_runtime_test.go`
- update `backend/tests/preview_publication_test.go`
- update `backend/tests/acceptance_tail_test.go`
- update `backend/internal/httpserver/router_integration_test.go`
- update `e2e/tests/gate2/04-lesson-free-text.spec.ts`
- update `e2e/tests/qa-regression/02-lesson-editor-save.spec.ts`
- update `e2e/tests/qa-regression/06-branch-roundtrip.spec.ts`

### Done criteria

- Criteria fields are actually consumed by evaluator prompt assembly.
- Student-visible free-text feedback is deterministic and fully asserted in tests.
- Legacy free-text content still loads and is upgraded to canonical shape on save.

## Phase 3. Node Reordering Parity

### Goals

- Make reordering available in both teacher and admin.
- Preserve branch integrity or fail loudly.

### Implementation

Frontend:

- Extract shared reorder helper:
  - move node up
  - move node down
  - validate resulting outgoing edges against forward-order invariant
- Add reorder controls to admin editor.
- Preserve teacher controls but migrate them to shared helper.
- When reorder invalidates a target:
  - clear the invalid edge
  - show inline warning on the node
  - surface save-time validation if unresolved

Optional follow-up if arrows are too weak:

- add "move after node" select-based action

Do not introduce drag-and-drop in this phase.
Button-driven reorder is easier to automate and lower-risk.

### Files expected to change

- `frontend/src/pages/teacher/LessonConstructor.tsx`
- `frontend/src/pages/admin/AdminLessonEditor.tsx`
- `frontend/src/api/types.ts`
- `frontend/package.json`

### Tests

Frontend unit tests:

- reorder keeps valid forward edges intact
- reorder clears edges that become backward under editor invariant
- reorder does not mutate unrelated branch edges

E2E:

- teacher reorder:
  - build branching lesson
  - move nodes
  - save
  - reload
  - preview still follows expected branches
- admin reorder:
  - same parity coverage

Candidate test files:

- add frontend unit tests around reorder helper
- add `e2e/tests/teacher/lesson-constructor.spec.ts`
- add `e2e/tests/qa-regression/06-branch-roundtrip.spec.ts`

### Done criteria

- Admin and teacher have the same reorder capability.
- A test proves branch targets are not silently reassigned during reorder.

## Phase 4. Narrative Branching With `decision` Nodes

### Goals

- Support branching story paths that are not scored questions.

### Implementation

Graph model:

- add `decision` node kind to frontend and backend
- add option edges for decision options

Teacher/admin editor UX:

- new node type: `Развилка сюжета`
- fields:
  - prompt
  - options[]
    - text
    - next node
- at least two options required

Runtime:

- render `decision` similarly to single-choice, but:
  - no verdict
  - no feedback overlay
  - no XP/hearts change
  - selecting an option advances via a dedicated decision endpoint and returns the next step directly

Preview:

- mirror runtime exactly

Validation:

- `decision` requires:
  - prompt
  - at least two options
  - each option has `id/text/nextNodeId`

### Backend schema

No DB migration required for content storage beyond normal draft/revision JSON changes.

### API contract

Add dedicated endpoints instead of overloading scored-question answer semantics:

- student:
  - `POST /api/v1/student/lesson-sessions/:sessionId/decision`
- preview:
  - `POST /api/v1/preview-sessions/:previewSessionId/decision`

Request body:

- `state_version`
- `node_id`
- `option_id`

Response:

- next `StepView` / `PreviewStepEnvelope`

Why a dedicated endpoint:

- avoids inventing fake verdict/feedback payloads for non-scored choices
- keeps `step_attempts` semantics clean
- keeps runtime/preview APIs explicit

### Files expected to change

- `frontend/src/api/types.ts`
- `frontend/src/api/client.ts`
- `frontend/src/pages/teacher/LessonConstructor.tsx`
- `frontend/src/pages/admin/AdminLessonEditor.tsx`
- `frontend/src/pages/student/LessonPlayer.tsx`
- `frontend/src/pages/teacher/PreviewPlayer.tsx`
- `backend/internal/courses/graph.go`
- `backend/internal/lessonruntime/helpers.go`
- `backend/internal/courses/service.go`
- `backend/internal/courses/validator.go`
- `backend/internal/httpserver/router.go`

### Tests

Backend:

- decision node graph validation
- preview runtime can traverse different decision branches
- student runtime can traverse different decision branches
- no `step_attempts` row is created for decision choices
- no XP/hearts change on decision traversal

E2E:

- author a decision node in teacher editor, save, reload, preview both branches
- author a decision node in admin editor, save, reload, preview both branches
- student runtime sees distinct story outcomes from different narrative choices

Candidate test files:

- add backend tests near `student_runtime_test.go` and `preview_publication_test.go`
- add router contract tests in `backend/internal/httpserver/router_integration_test.go`
- add new e2e spec `e2e/tests/gate2/09-lesson-decision-branching.spec.ts`

### Done criteria

- Decision branching exists without polluting scoring metrics or attempt history.

## Phase 5. Back / Change Choice For Narrative Decisions

### Goals

- Let the student return to the previous narrative decision and choose another branch.
- Keep graph acyclic and keep scoring semantics untouched.

### Implementation

#### API

Add runtime endpoint:

- `POST /api/v1/student/lesson-sessions/:sessionId/back`

Request:

- `state_version`

Response:

- updated `StepView`

Rules:

- only available while session is `in_progress`
- only rewinds to the latest active prior `decision` node on the current path
- if there is no prior active decision node, return `409` with a specific error code

Add preview endpoint:

- `POST /api/v1/preview-sessions/:previewSessionId/back`

#### Student runtime persistence

DB migration:

- add `lesson_session_path_entries` as described above

Runtime mechanics:

- on start, insert first active path entry
- on story next / answer / decision selection, append new active path entry
- on back:
  - locate latest active prior path entry whose `node_kind = 'decision'`
  - mark later active entries inactive
  - set `lesson_sessions.current_node_id` to that decision node
  - increment `state_version`
  - return the decision step again

#### Preview mechanics

- implement same semantics against in-memory preview history

#### UI

Student runtime:

- show `Назад к выбору` when there is an active prior decision node
- do not show back button on scored single-choice or free-text nodes in this phase

Preview runtime:

- same affordance for parity

### Files expected to change

- `backend/internal/platform/db/migrations/0003_lesson_session_path_entries.sql`
- `backend/internal/lessonruntime/service.go`
- `backend/internal/courses/service.go`
- `backend/internal/httpserver/router.go`
- `frontend/src/api/client.ts`
- `frontend/src/api/types.ts`
- `frontend/src/pages/student/LessonPlayer.tsx`
- `frontend/src/pages/teacher/PreviewPlayer.tsx`

### Tests

Backend integration:

- start -> decision -> branch story -> back => returns to decision node
- choose different option after back => lands on other branch
- back does not create `step_attempts`
- back does not change XP/hearts
- back on session without prior decision returns specific conflict error
- refresh/resume after back continues from the rewound decision state
- stale `state_version` on back returns a conflict instead of corrupting path history

E2E:

- student runtime:
  - take branch A
  - navigate through resulting story nodes
  - back to decision
  - choose branch B
  - verify branch A content is no longer current path
- preview parity:
  - same flow in preview
- refresh the page after back and verify the same active decision state resumes

Candidate test files:

- add backend tests in `backend/tests/student_runtime_test.go`
- add backend preview tests in `backend/tests/preview_publication_test.go`
- add router contract tests in `backend/internal/httpserver/router_integration_test.go`
- add e2e spec `e2e/tests/gate2/10-lesson-decision-backtracking.spec.ts`
- update `backend/tests/migrations_test.go`

### Done criteria

- Branch rewind is fully automated in student runtime and preview.
- No manual QA is needed to confirm backtracking semantics.

## Phase 6. Help, Validation Messaging, And Editor Copy

### Goals

- Make criteria authoring understandable without external documentation.

### Implementation

Teacher/admin editors:

- add inline helper panel near free-text rubric fields:
  - what "correct" means
  - what "partial" means
  - what "incorrect" means
  - how specific criteria should be
  - examples of good/bad criteria
- add placeholder copy that nudges authors toward observable criteria

Validation messaging:

- extend `frontend/src/utils/editorErrors.ts` for:
  - missing decision options
  - missing per-verdict free-text feedback
  - missing per-verdict free-text criteria
  - missing at least one correct choice option

### Tests

- e2e/editor tests assert that the helper copy is visible
- validation-error regression tests assert translated Russian messages, not raw backend codes

Candidate test files:

- update `e2e/tests/qa-regression/02-lesson-editor-save.spec.ts`
- update admin validation regression tests

### Done criteria

- A new author can infer how to fill rubric fields directly from the editor.

## Test Strategy

## Layer 1. Frontend pure-function tests

Purpose:

- protect graph roundtrip and reorder behaviour
- catch serialization regressions before expensive e2e runs

Required coverage:

- graph roundtrip for all node kinds
- verdict-preserving roundtrip
- decision-node roundtrip
- reorder helper
- editor invariant around edge clearing after reorder

## Layer 2. Backend integration tests

Purpose:

- verify validation, runtime transitions, DB writes, preview/runtime parity

Required coverage:

- authoring validation for new graph contracts
- single-choice scoring matrix
- free-text verdict matrix
- decision branching
- backtracking semantics
- no unexpected `step_attempts` or game-state mutations from decision/back actions
- session resume after refresh/restart for active branched lessons
- state-version conflict protection on new back endpoints
- migration/index existence for new path-history storage

## Layer 3. E2E Playwright tests

Purpose:

- verify actual authored UX in teacher/admin/student surfaces

Required coverage:

- teacher roundtrip
- admin roundtrip
- preview traversal parity
- student runtime traversal and rewards
- back/change-choice flow
- refresh/resume flow after branching and after rewind
- progress indicator parity for different branches

## Layer 4. Build gates

Required CI commands for this epic:

- `cd frontend && npm run build`
- `cd frontend && npm run lint`
- `cd frontend && npm run test:unit`
- `cd backend && go test ./...`
- `cd e2e && npm test -- --grep "Gate 2|QA Regression|lesson"`

Targeted suites may be split in CI for speed, but the merge gate must include all new backend tests and all new/updated lesson e2e specs.

## Definition Of Done

This epic is done only when all of the following are true:

1. Teacher and admin editors can author all requested cases.
2. Save -> reload -> preview roundtrip is covered for all new node structures.
3. Student runtime covers:
   - multi-verdict multiple-choice
   - free-text per-verdict consequences
   - narrative decision branching
   - decision backtracking
4. Preview runtime matches student runtime for branching semantics.
5. No behaviour in this scope requires manual QA to verify correctness.

## Risks And Mitigations

### Risk: free-text semantic quality cannot be fully proven by deterministic tests

Reality:

- We can fully test rubric persistence, prompt assembly, branch routing, and selected student feedback.
- We cannot prove production LLM judgement quality for arbitrary natural-language answers purely with deterministic tests.

Mitigation:

- make student-facing feedback deterministic and authored
- structure criteria by verdict
- add contract tests for prompt assembly
- keep fake LLM deterministic in tests

### Risk: silent branch corruption during reorder

Mitigation:

- no silent retargeting
- clear invalid edges
- assert this in unit + e2e tests

### Risk: scoring and backtracking become entangled

Mitigation:

- restrict backtracking in this epic to `decision` nodes
- keep scored-question replay semantics unchanged

### Risk: legacy stored graphs become unsavable or unpublishable

Mitigation:

- dual-read compatibility first
- canonical-write second
- backfill third
- tighten validation only after compatibility and backfill are proven in tests

### Risk: new decision/back contracts drift between router, client, and runtime services

Mitigation:

- add router integration tests for all new lesson/preview endpoints
- keep dedicated endpoints for non-scored decision flows
- assert refresh/resume and stale `state_version` semantics in backend + e2e tests

## Recommended Delivery Order

1. Phase 0: shared graph helpers and tests
2. Phase 1: multi-verdict multiple-choice
3. Phase 2: free-text rubric + feedback overhaul
4. Phase 3: reorder parity
5. Phase 4: decision-node branching
6. Phase 5: decision backtracking
7. Phase 6: editor help and validation copy

This order minimizes schema churn and gives testable checkpoints after each phase.
