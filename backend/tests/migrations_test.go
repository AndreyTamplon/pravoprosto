package tests

import (
	"context"
	"testing"

	"pravoprost/backend/internal/testkit/app"
)

func TestMigrations_ApplyAndCriticalIndexesExist(t *testing.T) {
	testApp := app.New(t)
	ctx := context.Background()

	var count int
	err := testApp.DB.Pool().QueryRow(ctx, `
		select count(*)
		from pg_indexes
		where schemaname = 'public'
		  and indexname in (
		      'uq_guardian_links_active_slot',
		      'uq_course_revisions_current',
		      'uq_course_access_grants_active',
		      'uq_commercial_offers_active_course',
		      'uq_commercial_offers_active_lesson',
		      'uq_entitlements_active_course',
		      'uq_entitlements_active_lesson',
		      'uq_lesson_sessions_active',
		      'idx_lesson_session_path_entries_active',
		      'uq_course_progress_active',
		      'uq_course_reviews_pending_draft'
		  )
	`).Scan(&count)
	if err != nil {
		t.Fatalf("query indexes: %v", err)
	}
	if count != 11 {
		t.Fatalf("expected 11 critical indexes, got %d", count)
	}

	var triggerExists bool
	err = testApp.DB.Pool().QueryRow(ctx, `
		select exists(
			select 1
			from pg_trigger t
			join pg_class c on c.oid = t.tgrelid
			where c.relname = 'commercial_offers'
			  and t.tgname = 'trg_enforce_platform_only_offer'
			  and not t.tgisinternal
		)
	`).Scan(&triggerExists)
	if err != nil {
		t.Fatalf("query triggers: %v", err)
	}
	if !triggerExists {
		t.Fatalf("expected monetization enforcement trigger")
	}
}

func TestMigrations_CheckConstraintsAndPaymentUniqueness(t *testing.T) {
	testApp := app.New(t)
	ctx := context.Background()

	var accountsCheckCount, offersCheckCount, entitlementsCheckCount int
	if err := testApp.DB.Pool().QueryRow(ctx, `
		select count(*)
		from pg_constraint
		where conrelid = 'accounts'::regclass
		  and contype = 'c'
	`).Scan(&accountsCheckCount); err != nil {
		t.Fatalf("query accounts role check: %v", err)
	}
	if err := testApp.DB.Pool().QueryRow(ctx, `
		select count(*)
		from pg_constraint
		where conrelid = 'commercial_offers'::regclass
		  and contype = 'c'
	`).Scan(&offersCheckCount); err != nil {
		t.Fatalf("query offers target_type check: %v", err)
	}
	if err := testApp.DB.Pool().QueryRow(ctx, `
		select count(*)
		from pg_constraint
		where conrelid = 'entitlements'::regclass
		  and contype = 'c'
	`).Scan(&entitlementsCheckCount); err != nil {
		t.Fatalf("query entitlements target_type check: %v", err)
	}
	if accountsCheckCount == 0 || offersCheckCount == 0 || entitlementsCheckCount == 0 {
		t.Fatalf("missing critical check constraints accounts=%d offers=%d entitlements=%d", accountsCheckCount, offersCheckCount, entitlementsCheckCount)
	}

	var paymentUniqueCount int
	if err := testApp.DB.Pool().QueryRow(ctx, `
		select count(*)
		from pg_constraint
		where conrelid = 'payment_records'::regclass
		  and contype = 'u'
	`).Scan(&paymentUniqueCount); err != nil {
		t.Fatalf("query payment unique constraints: %v", err)
	}
	if paymentUniqueCount < 2 {
		t.Fatalf("expected at least two payment uniqueness constraints, got %d", paymentUniqueCount)
	}

	if _, err := testApp.DB.Pool().Exec(ctx, `insert into accounts(role, status) values ('nope', 'active')`); err == nil {
		t.Fatalf("expected invalid accounts.role insert to fail")
	}

	var adminID, studentID, courseID, offerID, orderID string
	if err := testApp.DB.Pool().QueryRow(ctx, `insert into accounts(role, status) values ('admin', 'active') returning id::text`).Scan(&adminID); err != nil {
		t.Fatalf("insert admin: %v", err)
	}
	if err := testApp.DB.Pool().QueryRow(ctx, `insert into accounts(role, status) values ('student', 'active') returning id::text`).Scan(&studentID); err != nil {
		t.Fatalf("insert student: %v", err)
	}
	if _, err := testApp.DB.Pool().Exec(ctx, `insert into student_profiles(account_id, display_name) values ($1, 'Student')`, studentID); err != nil {
		t.Fatalf("insert student profile: %v", err)
	}
	if err := testApp.DB.Pool().QueryRow(ctx, `
		insert into courses(owner_kind, owner_account_id, course_kind, status)
		values ('platform', null, 'platform_catalog', 'active')
		returning id::text
	`).Scan(&courseID); err != nil {
		t.Fatalf("insert course: %v", err)
	}

	if _, err := testApp.DB.Pool().Exec(ctx, `
		insert into commercial_offers(owner_kind, target_type, target_course_id, target_lesson_id, title, description, price_amount_minor, price_currency, status, created_by_account_id)
		values ('platform', 'bad', $1, null, 'Broken', 'Broken', 100, 'RUB', 'draft', $2)
	`, courseID, adminID); err == nil {
		t.Fatalf("expected invalid commercial_offers.target_type insert to fail")
	}
	if _, err := testApp.DB.Pool().Exec(ctx, `
		insert into entitlements(student_id, target_type, target_course_id, target_lesson_id, source_type, order_id, status, granted_by_account_id)
		values ($1, 'bad', $2, null, 'complimentary', null, 'active', $3)
	`, studentID, courseID, adminID); err == nil {
		t.Fatalf("expected invalid entitlements.target_type insert to fail")
	}

	if err := testApp.DB.Pool().QueryRow(ctx, `
		insert into commercial_offers(owner_kind, target_type, target_course_id, target_lesson_id, title, description, price_amount_minor, price_currency, status, created_by_account_id)
		values ('platform', 'course', $1, null, 'Offer', 'Offer', 100, 'RUB', 'draft', $2)
		returning id::text
	`, courseID, adminID).Scan(&offerID); err != nil {
		t.Fatalf("insert valid offer: %v", err)
	}
	if err := testApp.DB.Pool().QueryRow(ctx, `
		insert into commercial_orders(student_id, offer_id, status, target_type, target_course_id, target_lesson_id, offer_snapshot_json, price_snapshot_amount_minor, price_snapshot_currency, created_by_account_id)
		values ($1, $2, 'awaiting_confirmation', 'course', $3, null, '{}'::jsonb, 100, 'RUB', $4)
		returning id::text
	`, studentID, offerID, courseID, adminID).Scan(&orderID); err != nil {
		t.Fatalf("insert order: %v", err)
	}
	if _, err := testApp.DB.Pool().Exec(ctx, `
		insert into payment_records(order_id, amount_minor, currency, idempotency_key, external_reference, confirmed_by_admin_id, paid_at)
		values ($1, 100, 'RUB', 'idem-1', 'ref-1', $2, now())
	`, orderID, adminID); err != nil {
		t.Fatalf("insert payment: %v", err)
	}
	if _, err := testApp.DB.Pool().Exec(ctx, `
		insert into payment_records(order_id, amount_minor, currency, idempotency_key, external_reference, confirmed_by_admin_id, paid_at)
		values ($1, 100, 'RUB', 'idem-1', 'ref-2', $2, now())
	`, orderID, adminID); err == nil {
		t.Fatalf("expected duplicate order/idempotency payment insert to fail")
	}
	if _, err := testApp.DB.Pool().Exec(ctx, `
		insert into payment_records(order_id, amount_minor, currency, idempotency_key, external_reference, confirmed_by_admin_id, paid_at)
		values ($1, 100, 'RUB', 'idem-2', 'ref-1', $2, now())
	`, orderID, adminID); err == nil {
		t.Fatalf("expected duplicate external_reference payment insert to fail")
	}
}
