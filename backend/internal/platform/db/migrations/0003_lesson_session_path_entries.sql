create table if not exists lesson_session_path_entries (
    id uuid primary key default gen_random_uuid(),
    lesson_session_id uuid not null references lesson_sessions(id) on delete cascade,
    seq_no int not null,
    node_id text not null,
    node_kind text not null,
    entered_via text not null,
    decision_option_id text null,
    active boolean not null default true,
    created_at timestamptz not null default now(),
    unique (lesson_session_id, seq_no)
);

create index if not exists idx_lesson_session_path_entries_active
    on lesson_session_path_entries(lesson_session_id, active, seq_no desc);
