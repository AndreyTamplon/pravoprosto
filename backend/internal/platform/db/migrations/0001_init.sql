create extension if not exists pgcrypto;

create table if not exists accounts (
    id uuid primary key default gen_random_uuid(),
    role text not null check (role in ('unselected','student','parent','teacher','admin')),
    status text not null check (status in ('active','blocked')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists idx_accounts_role on accounts(role);

create table if not exists external_identities (
    id uuid primary key default gen_random_uuid(),
    account_id uuid not null references accounts(id),
    provider text not null,
    provider_subject text not null,
    email text null,
    email_verified boolean not null default false,
    raw_profile_json jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (provider, provider_subject)
);

create index if not exists idx_external_identities_account_id on external_identities(account_id);

create table if not exists sessions (
    id uuid primary key default gen_random_uuid(),
    account_id uuid not null references accounts(id),
    session_token_hash text not null unique,
    csrf_secret text not null,
    expires_at timestamptz not null,
    created_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    revoked_at timestamptz null
);

create index if not exists idx_sessions_account_id on sessions(account_id);
create index if not exists idx_sessions_expires_at on sessions(expires_at);

create table if not exists assets (
    id uuid primary key default gen_random_uuid(),
    owner_account_id uuid null references accounts(id),
    storage_key text not null unique,
    mime_type text not null,
    size_bytes bigint not null,
    width int null,
    height int null,
    created_at timestamptz not null default now(),
    deleted_at timestamptz null
);

create table if not exists student_profiles (
    account_id uuid primary key references accounts(id),
    display_name text not null,
    avatar_asset_id uuid null references assets(id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists parent_profiles (
    account_id uuid primary key references accounts(id),
    display_name text not null,
    avatar_asset_id uuid null references assets(id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists teacher_profiles (
    account_id uuid primary key references accounts(id),
    display_name text not null,
    organization_name text null,
    avatar_asset_id uuid null references assets(id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists admin_profiles (
    account_id uuid primary key references accounts(id),
    display_name text not null,
    avatar_asset_id uuid null references assets(id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists guardian_link_invites (
    id uuid primary key default gen_random_uuid(),
    created_by_parent_id uuid not null references accounts(id),
    token_hash text not null unique,
    status text not null check (status in ('active','claimed','expired','revoked')),
    claimed_by_student_id uuid null references accounts(id),
    expires_at timestamptz not null,
    used_at timestamptz null,
    revoked_at timestamptz null,
    created_at timestamptz not null default now()
);

create index if not exists idx_guardian_link_invites_parent_id on guardian_link_invites(created_by_parent_id, created_at desc);

create table if not exists guardian_links (
    id uuid primary key default gen_random_uuid(),
    parent_id uuid not null references accounts(id),
    student_id uuid not null references accounts(id),
    parent_slot smallint not null check (parent_slot in (1, 2)),
    status text not null check (status in ('active','revoked')),
    invite_id uuid null references guardian_link_invites(id),
    created_at timestamptz not null default now(),
    accepted_at timestamptz not null default now(),
    revoked_at timestamptz null,
    unique (parent_id, student_id)
);

create unique index if not exists uq_guardian_links_active_slot on guardian_links(student_id, parent_slot) where status = 'active';
create index if not exists idx_guardian_links_student_id on guardian_links(student_id);

create table if not exists courses (
    id uuid primary key default gen_random_uuid(),
    owner_kind text not null check (owner_kind in ('platform','teacher')),
    owner_account_id uuid null references accounts(id),
    course_kind text not null check (course_kind in ('platform_catalog','teacher_private')),
    status text not null check (status in ('active','archived')),
    deleted_at timestamptz null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists idx_courses_owner_account_id on courses(owner_account_id);
create index if not exists idx_courses_kind_status on courses(course_kind, status);

create table if not exists course_drafts (
    id uuid primary key default gen_random_uuid(),
    course_id uuid not null unique references courses(id),
    workflow_status text not null check (workflow_status in ('editing','in_review','changes_requested','archived')),
    draft_version bigint not null,
    title text not null,
    description text not null,
    age_min int null,
    age_max int null,
    cover_asset_id uuid null references assets(id),
    content_json jsonb not null,
    last_submitted_at timestamptz null,
    last_rejected_at timestamptz null,
    last_published_revision_id uuid null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists idx_course_drafts_status on course_drafts(workflow_status);

create table if not exists course_revisions (
    id uuid primary key default gen_random_uuid(),
    course_id uuid not null references courses(id),
    version_no int not null,
    title text not null,
    description text not null,
    age_min int null,
    age_max int null,
    cover_asset_id uuid null references assets(id),
    content_json jsonb not null,
    monetization_policy_json jsonb not null default '{}'::jsonb,
    created_from_draft_id uuid null,
    published_by_account_id uuid not null references accounts(id),
    published_at timestamptz not null default now(),
    is_current boolean not null default false,
    disabled_at timestamptz null,
    unique (course_id, version_no)
);

alter table course_drafts
    add constraint fk_course_drafts_last_published_revision
    foreign key (last_published_revision_id) references course_revisions(id);

create unique index if not exists uq_course_revisions_current on course_revisions(course_id) where is_current = true;
create index if not exists idx_course_revisions_course_id_published_at on course_revisions(course_id, published_at desc);

create table if not exists course_reviews (
    id uuid primary key default gen_random_uuid(),
    course_draft_id uuid not null references course_drafts(id),
    submitted_by_account_id uuid not null references accounts(id),
    submitted_draft_version bigint not null,
    status text not null check (status in ('pending','approved','rejected')),
    reviewer_id uuid null references accounts(id),
    review_comment text null,
    submitted_at timestamptz not null default now(),
    resolved_at timestamptz null,
    created_at timestamptz not null default now()
);

create index if not exists idx_course_reviews_pending on course_reviews(status, submitted_at) where status = 'pending';
create unique index if not exists uq_course_reviews_pending_draft on course_reviews(course_draft_id) where status = 'pending';
create index if not exists idx_course_reviews_draft_id on course_reviews(course_draft_id, submitted_at desc);

create table if not exists course_revision_lessons (
    id uuid primary key default gen_random_uuid(),
    course_revision_id uuid not null references course_revisions(id),
    course_id uuid not null references courses(id),
    module_id text not null,
    lesson_id text not null,
    title text not null,
    sort_order int not null,
    created_at timestamptz not null default now(),
    unique (course_revision_id, lesson_id)
);

create unique index if not exists uq_course_revision_lessons_course_revision_lesson on course_revision_lessons(course_revision_id, lesson_id);
create index if not exists idx_course_revision_lessons_course_id on course_revision_lessons(course_id, lesson_id);

create table if not exists course_access_links (
    id uuid primary key default gen_random_uuid(),
    course_id uuid not null references courses(id),
    token_hash text not null unique,
    token_encrypted text not null,
    status text not null check (status in ('active','expired','revoked')),
    expires_at timestamptz null,
    created_by_account_id uuid not null references accounts(id),
    created_at timestamptz not null default now(),
    revoked_at timestamptz null
);

create index if not exists idx_course_access_links_course_id on course_access_links(course_id, created_at desc);

create table if not exists course_access_grants (
    id uuid primary key default gen_random_uuid(),
    course_id uuid not null references courses(id),
    student_id uuid not null references accounts(id),
    source text not null check (source in ('teacher_link','admin_grant')),
    granted_by_account_id uuid not null references accounts(id),
    first_claimed_via_link_id uuid null references course_access_links(id),
    granted_at timestamptz not null default now(),
    archived_at timestamptz null
);

create unique index if not exists uq_course_access_grants_active on course_access_grants(course_id, student_id) where archived_at is null;
create index if not exists idx_course_access_grants_student_id on course_access_grants(student_id, granted_at desc);

create table if not exists commercial_offers (
    id uuid primary key default gen_random_uuid(),
    owner_kind text not null check (owner_kind = 'platform'),
    target_type text not null check (target_type in ('course','lesson')),
    target_course_id uuid not null references courses(id),
    target_lesson_id text null,
    title text not null,
    description text not null,
    price_amount_minor bigint not null,
    price_currency char(3) not null,
    status text not null check (status in ('draft','active','archived')),
    created_by_account_id uuid not null references accounts(id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    archived_at timestamptz null,
    constraint ck_commercial_offers_target_type_fields check (
        (target_type = 'course' and target_lesson_id is null) or
        (target_type = 'lesson' and target_lesson_id is not null)
    )
);

create unique index if not exists uq_commercial_offers_active_course on commercial_offers(target_course_id) where status = 'active' and target_type = 'course';
create unique index if not exists uq_commercial_offers_active_lesson on commercial_offers(target_course_id, target_lesson_id) where status = 'active' and target_type = 'lesson';
create index if not exists idx_commercial_offers_status on commercial_offers(status, created_at desc);

create table if not exists purchase_requests (
    id uuid primary key default gen_random_uuid(),
    student_id uuid not null references accounts(id),
    offer_id uuid not null references commercial_offers(id),
    status text not null check (status in ('open','processed','declined')),
    created_at timestamptz not null default now(),
    processed_at timestamptz null,
    processed_by_account_id uuid null references accounts(id)
);

create unique index if not exists uq_purchase_requests_open on purchase_requests(student_id, offer_id) where status = 'open';
create index if not exists idx_purchase_requests_status on purchase_requests(status, created_at desc);

create table if not exists commercial_orders (
    id uuid primary key default gen_random_uuid(),
    student_id uuid not null references accounts(id),
    offer_id uuid not null references commercial_offers(id),
    purchase_request_id uuid null references purchase_requests(id),
    status text not null check (status in ('awaiting_confirmation','fulfilled','canceled')),
    target_type text not null check (target_type in ('lesson','course')),
    target_course_id uuid not null references courses(id),
    target_lesson_id text null,
    offer_snapshot_json jsonb not null,
    price_snapshot_amount_minor bigint not null,
    price_snapshot_currency char(3) not null,
    created_by_account_id uuid not null references accounts(id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    fulfilled_at timestamptz null,
    canceled_at timestamptz null
);

create index if not exists idx_commercial_orders_student_id on commercial_orders(student_id, created_at desc);
create index if not exists idx_commercial_orders_status on commercial_orders(status, created_at desc);
create unique index if not exists uq_commercial_orders_awaiting_target on commercial_orders(student_id, target_type, target_course_id, coalesce(target_lesson_id, '')) where status = 'awaiting_confirmation';

create table if not exists payment_records (
    id uuid primary key default gen_random_uuid(),
    order_id uuid not null references commercial_orders(id),
    amount_minor bigint not null,
    currency char(3) not null,
    idempotency_key text not null,
    external_reference text not null,
    confirmed_by_admin_id uuid not null references accounts(id),
    override_reason text null,
    paid_at timestamptz not null,
    created_at timestamptz not null default now(),
    unique (order_id, idempotency_key),
    unique (external_reference)
);

create index if not exists idx_payment_records_order_id on payment_records(order_id, created_at desc);

create table if not exists entitlements (
    id uuid primary key default gen_random_uuid(),
    student_id uuid not null references accounts(id),
    target_type text not null check (target_type in ('course','lesson')),
    target_course_id uuid not null references courses(id),
    target_lesson_id text null,
    source_type text not null check (source_type in ('purchase','complimentary')),
    order_id uuid null references commercial_orders(id),
    status text not null check (status in ('active','revoked')),
    granted_by_account_id uuid not null references accounts(id),
    granted_at timestamptz not null default now(),
    revoked_at timestamptz null,
    constraint ck_entitlements_target_fields check (
        (target_type = 'course' and target_lesson_id is null) or
        (target_type = 'lesson' and target_lesson_id is not null)
    ),
    constraint ck_entitlements_source_fields check (
        (source_type = 'purchase' and order_id is not null) or
        (source_type = 'complimentary' and order_id is null)
    )
);

create unique index if not exists uq_entitlements_active_course on entitlements(student_id, target_course_id) where status = 'active' and target_type = 'course';
create unique index if not exists uq_entitlements_active_lesson on entitlements(student_id, target_course_id, target_lesson_id) where status = 'active' and target_type = 'lesson';
create index if not exists idx_entitlements_student_id on entitlements(student_id, granted_at desc);

create table if not exists entitlement_fulfillment_log (
    id uuid primary key default gen_random_uuid(),
    order_id uuid not null references commercial_orders(id),
    payment_record_id uuid not null references payment_records(id),
    entitlement_id uuid not null references entitlements(id),
    created_at timestamptz not null default now(),
    unique (order_id, payment_record_id),
    unique (entitlement_id)
);

create table if not exists course_progress (
    id uuid primary key default gen_random_uuid(),
    student_id uuid not null references accounts(id),
    course_id uuid not null references courses(id),
    course_revision_id uuid not null references course_revisions(id),
    status text not null check (status in ('in_progress','completed','abandoned')),
    started_at timestamptz not null default now(),
    completed_at timestamptz null,
    last_lesson_id text null,
    last_activity_at timestamptz not null default now(),
    correct_answers int not null default 0,
    partial_answers int not null default 0,
    incorrect_answers int not null default 0
);

create index if not exists idx_course_progress_student_id on course_progress(student_id, last_activity_at desc);
create unique index if not exists uq_course_progress_active on course_progress(student_id, course_id) where status = 'in_progress';

create table if not exists lesson_progress (
    id uuid primary key default gen_random_uuid(),
    student_id uuid not null references accounts(id),
    course_progress_id uuid not null references course_progress(id),
    course_revision_id uuid not null references course_revisions(id),
    lesson_id text not null,
    status text not null check (status in ('not_started','in_progress','completed')),
    best_verdict text null check (best_verdict in ('incorrect','partial','correct')),
    attempts_count int not null default 0,
    replay_count int not null default 0,
    started_at timestamptz null,
    completed_at timestamptz null,
    last_activity_at timestamptz not null default now(),
    unique (course_progress_id, lesson_id)
);

create index if not exists idx_lesson_progress_student_id on lesson_progress(student_id, last_activity_at desc);

alter table lesson_progress
    add constraint fk_lesson_progress_revision_lesson
    foreign key (course_revision_id, lesson_id)
    references course_revision_lessons(course_revision_id, lesson_id);

create table if not exists lesson_sessions (
    id uuid primary key default gen_random_uuid(),
    student_id uuid not null references accounts(id),
    course_progress_id uuid not null references course_progress(id),
    course_revision_id uuid not null references course_revisions(id),
    lesson_id text not null,
    status text not null check (status in ('in_progress','completed','terminated')),
    current_node_id text null,
    state_version bigint not null default 1,
    started_at timestamptz not null default now(),
    completed_at timestamptz null,
    terminated_at timestamptz null,
    termination_reason text null,
    last_activity_at timestamptz not null default now()
);

create unique index if not exists uq_lesson_sessions_active on lesson_sessions(student_id, course_progress_id, lesson_id) where status = 'in_progress';
create index if not exists idx_lesson_sessions_student_id on lesson_sessions(student_id, last_activity_at desc);

alter table lesson_sessions
    add constraint fk_lesson_sessions_revision_lesson
    foreign key (course_revision_id, lesson_id)
    references course_revision_lessons(course_revision_id, lesson_id);

create table if not exists step_attempts (
    id uuid primary key default gen_random_uuid(),
    lesson_session_id uuid not null references lesson_sessions(id),
    node_id text not null,
    attempt_no int not null,
    client_idempotency_key text null,
    answer_json jsonb not null,
    verdict text not null check (verdict in ('incorrect','partial','correct')),
    feedback_text text not null,
    next_node_id text null,
    evaluator_type text not null check (evaluator_type in ('single_choice','llm_free_text')),
    model_name text null,
    evaluator_latency_ms int null,
    evaluator_trace_id text null,
    created_at timestamptz not null default now(),
    unique (lesson_session_id, attempt_no)
);

create unique index if not exists uq_step_attempts_idempotency on step_attempts(lesson_session_id, client_idempotency_key) where client_idempotency_key is not null;
create index if not exists idx_step_attempts_session_id on step_attempts(lesson_session_id, created_at);

create table if not exists student_game_state (
    student_id uuid primary key references accounts(id),
    xp_total bigint not null default 0,
    level int not null default 1,
    hearts_current int not null,
    hearts_max int not null,
    hearts_updated_at timestamptz not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists student_streak_state (
    student_id uuid primary key references accounts(id),
    current_streak_days int not null default 0,
    best_streak_days int not null default 0,
    last_activity_date date null,
    updated_at timestamptz not null default now()
);

create table if not exists game_events (
    id uuid primary key default gen_random_uuid(),
    student_id uuid not null references accounts(id),
    source_type text not null,
    source_id uuid not null,
    event_type text not null,
    xp_delta int not null default 0,
    hearts_delta int not null default 0,
    streak_delta int not null default 0,
    created_at timestamptz not null default now(),
    unique (source_type, source_id, event_type)
);

create index if not exists idx_game_events_student_id on game_events(student_id, created_at desc);

create table if not exists student_badges (
    id uuid primary key default gen_random_uuid(),
    student_id uuid not null references accounts(id),
    badge_code text not null,
    source_type text not null,
    source_id uuid not null,
    awarded_at timestamptz not null default now(),
    unique (student_id, badge_code)
);

create index if not exists idx_student_badges_student_id on student_badges(student_id, awarded_at desc);

create or replace function enforce_platform_only_offer()
returns trigger as $$
declare
    v_owner_kind text;
begin
    select owner_kind into v_owner_kind from courses where id = new.target_course_id;
    if v_owner_kind is distinct from 'platform' then
        raise exception 'teacher content cannot be monetized';
    end if;
    return new;
end;
$$ language plpgsql;

drop trigger if exists trg_enforce_platform_only_offer on commercial_offers;
create trigger trg_enforce_platform_only_offer
before insert or update on commercial_offers
for each row execute function enforce_platform_only_offer();
