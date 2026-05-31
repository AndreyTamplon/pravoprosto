-- 0005_free_access_and_platform_offer.sql
-- Feature: free-missions-paywall.
--  (1) Per-course free lesson tier: the first N lessons of a course are free.
--  (2) Global "Полный доступ" product (target_type='platform') that, once purchased,
--      unlocks all lessons of all courses (and future ones).
-- Constraint/index names below match the live prod schema (pinned via pg_constraint /
-- pg_indexes introspection). Additive & backward-compatible: existing course/lesson
-- offers, orders and entitlements remain valid.

-- 1) Per-course free lesson count. Lives on `courses` (revision-stable) because
--    course_revisions.monetization_policy_json is reset to '{}' on every republish.
--    DEFAULT 0 = free tier OFF (opt-in): no behavior change for any existing course until an
--    admin sets a positive count. The two catalog courses are set to 3 explicitly at rollout.
alter table courses add column if not exists free_lesson_count int not null default 0;
alter table courses drop constraint if exists ck_courses_free_lesson_count_nonneg;
alter table courses add constraint ck_courses_free_lesson_count_nonneg check (free_lesson_count >= 0);

-- 2) Allow target_type='platform' (a course-less, platform-wide product).
alter table commercial_offers drop constraint if exists commercial_offers_target_type_check;
alter table commercial_offers add constraint commercial_offers_target_type_check
    check (target_type in ('course','lesson','platform'));
alter table commercial_orders drop constraint if exists commercial_orders_target_type_check;
alter table commercial_orders add constraint commercial_orders_target_type_check
    check (target_type in ('course','lesson','platform'));
alter table entitlements drop constraint if exists entitlements_target_type_check;
alter table entitlements add constraint entitlements_target_type_check
    check (target_type in ('course','lesson','platform'));

-- 3) target_course_id becomes nullable (platform rows have no course).
--    The existing FK (*_target_course_id_fkey -> courses(id)) stays valid: NULL is allowed under a FK.
alter table commercial_offers alter column target_course_id drop not null;
alter table commercial_orders alter column target_course_id drop not null;
alter table entitlements     alter column target_course_id drop not null;

-- 4) Field-shape checks gain the platform branch (course NULL, lesson NULL).
--    The course/lesson branches are tightened to also require course IS NOT NULL (existing rows satisfy this).
alter table commercial_offers drop constraint if exists ck_commercial_offers_target_type_fields;
alter table commercial_offers add constraint ck_commercial_offers_target_type_fields check (
    (target_type = 'course'   and target_course_id is not null and target_lesson_id is null)     or
    (target_type = 'lesson'   and target_course_id is not null and target_lesson_id is not null) or
    (target_type = 'platform' and target_course_id is null     and target_lesson_id is null));
alter table entitlements drop constraint if exists ck_entitlements_target_fields;
alter table entitlements add constraint ck_entitlements_target_fields check (
    (target_type = 'course'   and target_course_id is not null and target_lesson_id is null)     or
    (target_type = 'lesson'   and target_course_id is not null and target_lesson_id is not null) or
    (target_type = 'platform' and target_course_id is null     and target_lesson_id is null));
-- commercial_orders historically has no field-shape check; add one for parity/safety.
alter table commercial_orders drop constraint if exists ck_commercial_orders_target_type_fields;
alter table commercial_orders add constraint ck_commercial_orders_target_type_fields check (
    (target_type = 'course'   and target_course_id is not null and target_lesson_id is null)     or
    (target_type = 'lesson'   and target_course_id is not null and target_lesson_id is not null) or
    (target_type = 'platform' and target_course_id is null     and target_lesson_id is null));

-- 5) At most one ACTIVE platform offer globally; at most one ACTIVE platform entitlement per student.
create unique index if not exists uq_commercial_offers_active_platform
    on commercial_offers(target_type) where status = 'active' and target_type = 'platform';
create unique index if not exists uq_entitlements_active_platform
    on entitlements(student_id) where status = 'active' and target_type = 'platform';

-- 6) Awaiting-order uniqueness must collapse a NULL course (else multiple awaiting platform
--    orders per student would be allowed, since SQL NULLs are distinct).
drop index if exists uq_commercial_orders_awaiting_target;
create unique index if not exists uq_commercial_orders_awaiting_target
    on commercial_orders(student_id, target_type, coalesce(target_course_id::text, ''), coalesce(target_lesson_id, ''))
    where status = 'awaiting_confirmation';

-- 7) The platform-only trigger guards course ownership; platform offers have no course, so skip them.
create or replace function enforce_platform_only_offer()
returns trigger as $$
declare
    v_owner_kind text;
begin
    if new.target_type = 'platform' then
        return new;
    end if;
    select owner_kind into v_owner_kind from courses where id = new.target_course_id;
    if v_owner_kind is distinct from 'platform' then
        raise exception 'teacher content cannot be monetized';
    end if;
    return new;
end;
$$ language plpgsql;
