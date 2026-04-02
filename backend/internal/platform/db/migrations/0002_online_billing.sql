create table if not exists tbank_payment_sessions (
    id uuid primary key default gen_random_uuid(),
    order_id uuid not null unique references commercial_orders(id),
    provider_order_id text not null unique,
    provider_payment_id text null unique,
    payment_url text null,
    status text not null check (status in ('created','initialized','paid','failed','canceled','mismatch')),
    init_request_json jsonb not null default '{}'::jsonb,
    init_response_json jsonb not null default '{}'::jsonb,
    last_notification_json jsonb null,
    created_by_parent_id uuid not null references accounts(id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    paid_at timestamptz null
);

create index if not exists idx_tbank_payment_sessions_status_created_at on tbank_payment_sessions(status, created_at desc);
create index if not exists idx_tbank_payment_sessions_order_id on tbank_payment_sessions(order_id);
