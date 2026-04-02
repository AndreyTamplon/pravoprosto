package commerce

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	platformconfig "pravoprost/backend/internal/platform/config"
)

type Service struct {
	db                    *pgxpool.Pool
	tbankTerminalKey      string
	tbankPassword         string
	tbankAPIBaseURL       string
	tbankNotificationURL  string
	tbankSuccessURL       string
	tbankFailURL          string
	httpClient            *http.Client
}

func NewService(db *pgxpool.Pool, cfg ...platformconfig.Config) *Service {
	c := platformconfig.Config{}
	if len(cfg) > 0 {
		c = cfg[0]
	}
	apiBaseURL := strings.TrimRight(strings.TrimSpace(c.TBankAPIBaseURL), "/")
	if apiBaseURL == "" {
		apiBaseURL = "https://securepay.tinkoff.ru"
	}
	notificationPath := strings.TrimSpace(c.TBankNotificationPath)
	if notificationPath == "" {
		notificationPath = "/api/v1/billing/tbank/notifications"
	}
	baseURL := strings.TrimRight(strings.TrimSpace(c.BaseURL), "/")
	notificationURL := ""
	if baseURL != "" {
		if strings.HasPrefix(notificationPath, "/") {
			notificationURL = baseURL + notificationPath
		} else {
			notificationURL = baseURL + "/" + notificationPath
		}
	}
	successURL := strings.TrimSpace(c.TBankSuccessURL)
	if successURL == "" && baseURL != "" {
		successURL = baseURL + "/parent"
	}
	failURL := strings.TrimSpace(c.TBankFailURL)
	if failURL == "" && baseURL != "" {
		failURL = baseURL + "/parent"
	}

	return &Service{
		db:                   db,
		tbankTerminalKey:     strings.TrimSpace(c.TBankTerminalKey),
		tbankPassword:        strings.TrimSpace(c.TBankPassword),
		tbankAPIBaseURL:      apiBaseURL,
		tbankNotificationURL: notificationURL,
		tbankSuccessURL:      successURL,
		tbankFailURL:         failURL,
		httpClient:           &http.Client{Timeout: 15 * time.Second},
	}
}

type OfferInput struct {
	TargetType       string `json:"target_type"`
	TargetCourseID   string `json:"target_course_id"`
	TargetLessonID   string `json:"target_lesson_id"`
	Title            string `json:"title"`
	Description      string `json:"description"`
	PriceAmountMinor int64  `json:"price_amount_minor"`
	PriceCurrency    string `json:"price_currency"`
}

type UpdateOfferInput struct {
	Title            string `json:"title"`
	Description      string `json:"description"`
	PriceAmountMinor int64  `json:"price_amount_minor"`
	PriceCurrency    string `json:"price_currency"`
	Status           string `json:"status"`
}

type ManualOrderInput struct {
	StudentID         string  `json:"student_id"`
	OfferID           string  `json:"offer_id"`
	PurchaseRequestID *string `json:"purchase_request_id"`
}

type ManualConfirmInput struct {
	ExternalReference string `json:"external_reference"`
	AmountMinor       int64  `json:"amount_minor"`
	Currency          string `json:"currency"`
	PaidAt            string `json:"paid_at"`
	Override          *struct {
		Reason string `json:"reason"`
	} `json:"override"`
}

type ComplimentaryGrantInput struct {
	StudentID      string `json:"student_id"`
	TargetType     string `json:"target_type"`
	TargetCourseID string `json:"target_course_id"`
	TargetLessonID string `json:"target_lesson_id"`
}

func DecodeOfferInput(r *http.Request) (OfferInput, error) {
	var input OfferInput
	return input, json.NewDecoder(r.Body).Decode(&input)
}

func DecodeUpdateOfferInput(r *http.Request) (UpdateOfferInput, error) {
	var input UpdateOfferInput
	return input, json.NewDecoder(r.Body).Decode(&input)
}

func DecodeManualOrderInput(r *http.Request) (ManualOrderInput, error) {
	var input ManualOrderInput
	return input, json.NewDecoder(r.Body).Decode(&input)
}

func DecodeManualConfirmInput(r *http.Request) (ManualConfirmInput, error) {
	var input ManualConfirmInput
	return input, json.NewDecoder(r.Body).Decode(&input)
}

func DecodeComplimentaryGrantInput(r *http.Request) (ComplimentaryGrantInput, error) {
	var input ComplimentaryGrantInput
	return input, json.NewDecoder(r.Body).Decode(&input)
}

func (s *Service) ListOffers(ctx context.Context) (map[string]any, error) {
	rows, err := s.db.Query(ctx, `
		select o.id::text,
		       o.title,
		       o.description,
		       o.status,
		       o.target_type,
		       o.target_course_id::text,
		       o.target_lesson_id,
		       o.price_amount_minor,
		       o.price_currency,
		       o.created_at::text,
		       coalesce(cr.title, d.title) as course_title,
		       coalesce(crl.title, draft_lesson.lesson_title) as lesson_title
		from commercial_offers o
		left join course_drafts d on d.course_id = o.target_course_id
		left join course_revisions cr on cr.course_id = o.target_course_id and cr.is_current = true
		left join course_revision_lessons crl on crl.course_revision_id = cr.id and crl.lesson_id = o.target_lesson_id
		left join lateral (
		    select lesson->>'title' as lesson_title
		    from jsonb_array_elements(coalesce(d.content_json->'modules', '[]'::jsonb)) module,
		         jsonb_array_elements(coalesce(module->'lessons', '[]'::jsonb)) lesson
		    where lesson->>'id' = o.target_lesson_id
		    limit 1
		) draft_lesson on true
		order by created_at desc
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]map[string]any, 0)
	for rows.Next() {
		var offerID, title, description, status, targetType, targetCourseID, priceCurrency, createdAt, courseTitle string
		var targetLessonID, lessonTitle *string
		var amount int64
		if err := rows.Scan(&offerID, &title, &description, &status, &targetType, &targetCourseID, &targetLessonID, &amount, &priceCurrency, &createdAt, &courseTitle, &lessonTitle); err != nil {
			return nil, err
		}
		items = append(items, map[string]any{
			"offer_id":           offerID,
			"title":              title,
			"description":        description,
			"status":             status,
			"target_type":        targetType,
			"target_course_id":   targetCourseID,
			"target_lesson_id":   targetLessonID,
			"price_amount_minor": amount,
			"price_currency":     priceCurrency,
			"created_at":         createdAt,
			"course_title":       courseTitle,
			"lesson_title":       lessonTitle,
		})
	}
	return map[string]any{"items": items}, rows.Err()
}

func (s *Service) CreateOffer(ctx context.Context, adminID string, input OfferInput) (map[string]any, error) {
	targetLessonID, err := normalizeTarget(input.TargetType, input.TargetCourseID, input.TargetLessonID)
	if err != nil {
		return nil, err
	}
	if err := s.validateOfferTarget(ctx, input.TargetType, input.TargetCourseID, targetLessonID); err != nil {
		return nil, err
	}
	var offerID string
	err = s.db.QueryRow(ctx, `
		insert into commercial_offers(owner_kind, target_type, target_course_id, target_lesson_id, title, description, price_amount_minor, price_currency, status, created_by_account_id)
		values ('platform', $1, $2, $3, $4, $5, $6, $7, 'draft', $8)
		returning id::text
	`, input.TargetType, input.TargetCourseID, targetLessonID, input.Title, input.Description, input.PriceAmountMinor, strings.ToUpper(input.PriceCurrency), adminID).Scan(&offerID)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && strings.Contains(pgErr.Message, "teacher content cannot be monetized") {
			return nil, ErrTeacherContentCannotBePaid
		}
		return nil, err
	}
	return map[string]any{"offer_id": offerID, "status": "draft"}, nil
}

func (s *Service) UpdateOffer(ctx context.Context, offerID string, input UpdateOfferInput) (map[string]any, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var targetType, targetCourseID string
	var targetLessonID *string
	if err := tx.QueryRow(ctx, `
		select target_type, target_course_id::text, target_lesson_id
		from commercial_offers
		where id = $1
		for update
	`, offerID).Scan(&targetType, &targetCourseID, &targetLessonID); err != nil {
		if err == pgx.ErrNoRows {
			return nil, ErrOfferNotFound
		}
		return nil, err
	}
	if input.Status == "active" {
		if err := s.validateOfferTargetTx(ctx, tx, targetType, targetCourseID, targetLessonID); err != nil {
			return nil, err
		}
	}
	var archivedAt any
	if input.Status == "archived" {
		archivedAt = time.Now().UTC()
	}
	if _, err := tx.Exec(ctx, `
		update commercial_offers
		set title = $2,
		    description = $3,
		    price_amount_minor = $4,
		    price_currency = $5,
		    status = $6,
		    archived_at = $7,
		    updated_at = now()
		where id = $1
	`, offerID, input.Title, input.Description, input.PriceAmountMinor, strings.ToUpper(input.PriceCurrency), input.Status, archivedAt); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s.offerView(ctx, offerID)
}

func (s *Service) CreatePurchaseRequest(ctx context.Context, studentID string, offerID string) (map[string]any, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var status string
	if err := tx.QueryRow(ctx, `select status from commercial_offers where id = $1 for update`, offerID).Scan(&status); err != nil {
		if err == pgx.ErrNoRows {
			return nil, ErrOfferNotFound
		}
		return nil, err
	}
	if status != "active" {
		return nil, ErrOfferNotActive
	}
	var requestID string
	err = tx.QueryRow(ctx, `
		insert into purchase_requests(student_id, offer_id, status)
		values ($1, $2, 'open')
		returning id::text
	`, studentID, offerID).Scan(&requestID)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return nil, ErrPurchaseRequestAlreadyOpen
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return map[string]any{"purchase_request_id": requestID, "offer_id": offerID, "status": "open"}, nil
}

func (s *Service) ListPurchaseRequests(ctx context.Context) (map[string]any, error) {
	rows, err := s.db.Query(ctx, `
		select pr.id::text, sp.account_id::text, sp.display_name, o.id::text, o.title, o.target_type, pr.status, pr.created_at::text
		from purchase_requests pr
		join student_profiles sp on sp.account_id = pr.student_id
		join commercial_offers o on o.id = pr.offer_id
		order by pr.created_at desc
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]map[string]any, 0)
	for rows.Next() {
		var requestID, studentID, displayName, offerID, title, targetType, status, createdAt string
		if err := rows.Scan(&requestID, &studentID, &displayName, &offerID, &title, &targetType, &status, &createdAt); err != nil {
			return nil, err
		}
		items = append(items, map[string]any{
			"purchase_request_id": requestID,
			"student": map[string]any{
				"account_id":   studentID,
				"display_name": displayName,
			},
				"offer": map[string]any{
					"offer_id": offerID,
					"title":    title,
				},
				"target_type": targetType,
				"status":      status,
				"created_at":  createdAt,
			})
		}
	return map[string]any{"items": items}, rows.Err()
}

func (s *Service) DeclinePurchaseRequest(ctx context.Context, requestID string, adminID string) (map[string]any, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var status string
	if err := tx.QueryRow(ctx, `select status from purchase_requests where id = $1 for update`, requestID).Scan(&status); err != nil {
		if err == pgx.ErrNoRows {
			return nil, ErrPurchaseRequestNotFound
		}
		return nil, err
	}
	if status != "open" {
		return nil, ErrPurchaseRequestAlreadyResolved
	}
	if _, err := tx.Exec(ctx, `
		update purchase_requests
		set status = 'declined', processed_at = now(), processed_by_account_id = $2
		where id = $1
	`, requestID, adminID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return map[string]any{"purchase_request_id": requestID, "status": "declined"}, nil
}

func (s *Service) ListOrders(ctx context.Context, status string, studentID string) (map[string]any, error) {
	query := `
		select o.id::text,
		       sp.account_id::text,
		       sp.display_name,
		       co.id::text,
		       co.title,
		       o.target_type,
		       o.target_course_id::text,
		       o.target_lesson_id,
		       o.status,
		       o.price_snapshot_amount_minor,
		       o.price_snapshot_currency,
		       o.created_at::text,
		       o.fulfilled_at::text
		from commercial_orders o
		join student_profiles sp on sp.account_id = o.student_id
		join commercial_offers co on co.id = o.offer_id
		where ($1 = '' or o.status = $1)
		  and ($2 = '' or sp.account_id::text = $2)
		order by o.created_at desc
	`
	rows, err := s.db.Query(ctx, query, status, studentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]map[string]any, 0)
	for rows.Next() {
		var orderID, accountID, displayName, offerID, title, targetType, targetCourseID, orderStatus, currency, createdAt string
		var targetLessonID, fulfilledAt *string
		var amount int64
		if err := rows.Scan(&orderID, &accountID, &displayName, &offerID, &title, &targetType, &targetCourseID, &targetLessonID, &orderStatus, &amount, &currency, &createdAt, &fulfilledAt); err != nil {
			return nil, err
		}
		items = append(items, map[string]any{
			"order_id": orderID,
			"student": map[string]any{
				"account_id":   accountID,
				"display_name": displayName,
			},
			"offer": map[string]any{
				"offer_id": offerID,
				"title":    title,
			},
			"target_type":        targetType,
			"target_course_id":   targetCourseID,
			"target_lesson_id":   targetLessonID,
			"status":             orderStatus,
			"price_amount_minor": amount,
			"currency":           currency,
			"created_at":         createdAt,
			"fulfilled_at":       fulfilledAt,
		})
	}
	return map[string]any{"items": items}, rows.Err()
}

func (s *Service) CreateManualOrder(ctx context.Context, adminID string, input ManualOrderInput) (map[string]any, error) {
	if err := s.validateStudentID(ctx, input.StudentID); err != nil {
		return nil, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var offer struct {
		ID               string
		TargetType       string
		TargetCourseID   string
		TargetLessonID   *string
		Title            string
		Description      string
		PriceAmountMinor int64
		PriceCurrency    string
		Status           string
	}
	if err := tx.QueryRow(ctx, `
		select id::text, target_type, target_course_id::text, target_lesson_id, title, description, price_amount_minor, price_currency, status
		from commercial_offers
		where id = $1
		for update
	`, input.OfferID).Scan(&offer.ID, &offer.TargetType, &offer.TargetCourseID, &offer.TargetLessonID, &offer.Title, &offer.Description, &offer.PriceAmountMinor, &offer.PriceCurrency, &offer.Status); err != nil {
		if err == pgx.ErrNoRows {
			return nil, ErrOfferNotFound
		}
		return nil, err
	}
	if offer.Status != "active" {
		return nil, ErrOfferNotActive
	}

	if input.PurchaseRequestID != nil && strings.TrimSpace(*input.PurchaseRequestID) != "" {
		var requestOfferID, requestStudentID, requestStatus string
		if err := tx.QueryRow(ctx, `
			select offer_id::text, student_id::text, status
			from purchase_requests
			where id = $1
			for update
		`, *input.PurchaseRequestID).Scan(&requestOfferID, &requestStudentID, &requestStatus); err != nil {
			if err == pgx.ErrNoRows {
				return nil, ErrPurchaseRequestNotFound
			}
			return nil, err
		}
		if requestOfferID != input.OfferID || requestStudentID != input.StudentID {
			return nil, ErrPurchaseRequestOfferMismatch
		}
		if requestStatus != "open" {
			return nil, ErrPurchaseRequestAlreadyResolved
		}
	}

	snapshot, err := json.Marshal(map[string]any{
		"offer_id":           offer.ID,
		"title":              offer.Title,
		"description":        offer.Description,
		"target_type":        offer.TargetType,
		"target_course_id":   offer.TargetCourseID,
		"target_lesson_id":   offer.TargetLessonID,
		"price_amount_minor": offer.PriceAmountMinor,
		"price_currency":     offer.PriceCurrency,
	})
	if err != nil {
		return nil, err
	}

	var orderID string
	err = tx.QueryRow(ctx, `
		insert into commercial_orders(student_id, offer_id, purchase_request_id, status, target_type, target_course_id, target_lesson_id, offer_snapshot_json, price_snapshot_amount_minor, price_snapshot_currency, created_by_account_id)
		values ($1, $2, $3, 'awaiting_confirmation', $4, $5, $6, $7, $8, $9, $10)
		returning id::text
	`, input.StudentID, offer.ID, input.PurchaseRequestID, offer.TargetType, offer.TargetCourseID, offer.TargetLessonID, snapshot, offer.PriceAmountMinor, offer.PriceCurrency, adminID).Scan(&orderID)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return nil, ErrOrderAlreadyPendingForTarget
		}
		return nil, err
	}

	if input.PurchaseRequestID != nil && strings.TrimSpace(*input.PurchaseRequestID) != "" {
		if _, err := tx.Exec(ctx, `
			update purchase_requests
			set status = 'processed', processed_at = now(), processed_by_account_id = $2
			where id = $1
		`, *input.PurchaseRequestID, adminID); err != nil {
			return nil, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return map[string]any{
		"order_id":           orderID,
		"status":             "awaiting_confirmation",
		"price_amount_minor": offer.PriceAmountMinor,
		"currency":           offer.PriceCurrency,
	}, nil
}

func (s *Service) ManualConfirm(ctx context.Context, orderID string, adminID string, idempotencyKey string, input ManualConfirmInput) (map[string]any, error) {
	paidAt, err := time.Parse(time.RFC3339, input.PaidAt)
	if err != nil {
		return nil, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var order struct {
		ID             string
		StudentID      string
		Status         string
		TargetType     string
		TargetCourseID string
		TargetLessonID *string
		AmountMinor    int64
		Currency       string
	}
	if err := tx.QueryRow(ctx, `
		select id::text, student_id::text, status, target_type, target_course_id::text, target_lesson_id, price_snapshot_amount_minor, price_snapshot_currency
		from commercial_orders
		where id = $1
		for update
	`, orderID).Scan(&order.ID, &order.StudentID, &order.Status, &order.TargetType, &order.TargetCourseID, &order.TargetLessonID, &order.AmountMinor, &order.Currency); err != nil {
		if err == pgx.ErrNoRows {
			return nil, ErrOrderNotFound
		}
		return nil, err
	}

	if order.Status == "fulfilled" {
		return s.existingConfirmResult(ctx, tx, orderID, idempotencyKey, input.ExternalReference)
	}
	if order.Status != "awaiting_confirmation" {
		return nil, ErrPaymentAlreadyConfirmed
	}
	if input.AmountMinor != order.AmountMinor || strings.ToUpper(input.Currency) != strings.ToUpper(order.Currency) {
		if input.Override == nil || strings.TrimSpace(input.Override.Reason) == "" {
			return nil, ErrManualPaymentMismatch
		}
	}

	var paymentID string
	overrideReason := ""
	if input.Override != nil {
		overrideReason = input.Override.Reason
	}
	err = tx.QueryRow(ctx, `
		insert into payment_records(order_id, amount_minor, currency, idempotency_key, external_reference, confirmed_by_admin_id, override_reason, paid_at)
		values ($1, $2, $3, $4, $5, $6, $7, $8)
		returning id::text
	`, orderID, input.AmountMinor, strings.ToUpper(input.Currency), idempotencyKey, input.ExternalReference, adminID, nullableString(overrideReason), paidAt).Scan(&paymentID)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return s.existingConfirmResult(ctx, tx, orderID, idempotencyKey, input.ExternalReference)
		}
		return nil, err
	}

	entitlementID, err := s.fulfillPurchaseEntitlementTx(ctx, tx, adminID, order, paymentID)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		update commercial_orders
		set status = 'fulfilled', fulfilled_at = now(), updated_at = now()
		where id = $1
	`, orderID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return map[string]any{
		"order_id":          orderID,
		"payment_record_id": paymentID,
		"order_status":      "fulfilled",
		"entitlement": map[string]any{
			"entitlement_id": entitlementID,
			"status":         "active",
		},
	}, nil
}

func (s *Service) ComplimentaryGrant(ctx context.Context, adminID string, input ComplimentaryGrantInput) (map[string]any, error) {
	targetLessonID, err := normalizeTarget(input.TargetType, input.TargetCourseID, input.TargetLessonID)
	if err != nil {
		return nil, err
	}
	if err := s.validateStudentID(ctx, input.StudentID); err != nil {
		return nil, err
	}
	if err := s.validateOfferTarget(ctx, input.TargetType, input.TargetCourseID, targetLessonID); err != nil {
		return nil, err
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var entitlementID string
	err = tx.QueryRow(ctx, `
		insert into entitlements(student_id, target_type, target_course_id, target_lesson_id, source_type, order_id, status, granted_by_account_id)
		values ($1, $2, $3, $4, 'complimentary', null, 'active', $5)
		returning id::text
	`, input.StudentID, input.TargetType, input.TargetCourseID, targetLessonID, adminID).Scan(&entitlementID)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return nil, ErrEntitlementAlreadyActive
		}
		return nil, err
	}

	if _, err := tx.Exec(ctx, `
		update commercial_orders
		set status = 'canceled', canceled_at = now(), updated_at = now()
		where student_id = $1 and target_type = $2 and target_course_id = $3
		  and coalesce(target_lesson_id, '') = coalesce($4, '')
		  and status = 'awaiting_confirmation'
	`, input.StudentID, input.TargetType, input.TargetCourseID, targetLessonID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		update purchase_requests pr
		set status = 'processed', processed_at = now(), processed_by_account_id = $2
		where pr.student_id = $1 and pr.status = 'open' and exists (
		    select 1 from commercial_offers o
		    where o.id = pr.offer_id
		      and o.target_type = $3
		      and o.target_course_id = $4
		      and coalesce(o.target_lesson_id, '') = coalesce($5, '')
		)
	`, input.StudentID, adminID, input.TargetType, input.TargetCourseID, targetLessonID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return map[string]any{"entitlement_id": entitlementID, "status": "active"}, nil
}

func (s *Service) RevokeEntitlement(ctx context.Context, entitlementID string) (map[string]any, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var studentID, targetType, targetCourseID string
	var targetLessonID *string
	var status string
	if err := tx.QueryRow(ctx, `
		select student_id::text, target_type, target_course_id::text, target_lesson_id, status
		from entitlements
		where id = $1
		for update
	`, entitlementID).Scan(&studentID, &targetType, &targetCourseID, &targetLessonID, &status); err != nil {
		if err == pgx.ErrNoRows {
			return nil, ErrEntitlementNotFound
		}
		return nil, err
	}
	if status != "active" {
		return nil, ErrEntitlementAlreadyResolved
	}
	if _, err := tx.Exec(ctx, `
		update entitlements
		set status = 'revoked', revoked_at = now()
		where id = $1
	`, entitlementID); err != nil {
		return nil, err
	}
	if targetType == "course" {
		if _, err := tx.Exec(ctx, `
			update lesson_sessions ls
			set status = 'terminated', terminated_at = now(), termination_reason = 'entitlement_revoked'
			from course_progress cp
			where ls.course_progress_id = cp.id and ls.student_id = $1 and cp.course_id = $2 and ls.status = 'in_progress'
		`, studentID, targetCourseID); err != nil {
			return nil, err
		}
	} else {
		if _, err := tx.Exec(ctx, `
			update lesson_sessions ls
			set status = 'terminated', terminated_at = now(), termination_reason = 'entitlement_revoked'
			from course_progress cp
			where ls.course_progress_id = cp.id and ls.student_id = $1 and cp.course_id = $2 and ls.lesson_id = $3 and ls.status = 'in_progress'
		`, studentID, targetCourseID, targetLessonID); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return map[string]any{"entitlement_id": entitlementID, "status": "revoked"}, nil
}

func (s *Service) existingConfirmResult(ctx context.Context, tx pgx.Tx, orderID string, idempotencyKey string, externalReference string) (map[string]any, error) {
	var paymentID, entitlementID string
	err := tx.QueryRow(ctx, `
		select p.id::text, e.id::text
		from payment_records p
		join entitlement_fulfillment_log l on l.payment_record_id = p.id
		join entitlements e on e.id = l.entitlement_id
		where p.order_id = $1 and (p.idempotency_key = $2 or p.external_reference = $3)
	`, orderID, idempotencyKey, externalReference).Scan(&paymentID, &entitlementID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, ErrPaymentAlreadyConfirmed
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return map[string]any{
		"order_id":          orderID,
		"payment_record_id": paymentID,
		"order_status":      "fulfilled",
		"entitlement": map[string]any{
			"entitlement_id": entitlementID,
			"status":         "active",
		},
	}, nil
}

func (s *Service) fulfillPurchaseEntitlementTx(ctx context.Context, tx pgx.Tx, adminID string, order struct {
	ID             string
	StudentID      string
	Status         string
	TargetType     string
	TargetCourseID string
	TargetLessonID *string
	AmountMinor    int64
	Currency       string
}, paymentID string) (string, error) {
	var entitlementID string
	err := tx.QueryRow(ctx, `
		insert into entitlements(student_id, target_type, target_course_id, target_lesson_id, source_type, order_id, status, granted_by_account_id)
		values ($1, $2, $3, $4, 'purchase', $5, 'active', $6)
		returning id::text
	`, order.StudentID, order.TargetType, order.TargetCourseID, order.TargetLessonID, order.ID, adminID).Scan(&entitlementID)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return "", ErrEntitlementAlreadyActive
		}
		return "", err
	}
	if _, err := tx.Exec(ctx, `
		insert into entitlement_fulfillment_log(order_id, payment_record_id, entitlement_id)
		values ($1, $2, $3)
	`, order.ID, paymentID, entitlementID); err != nil {
		return "", err
	}
	return entitlementID, nil
}

func (s *Service) offerView(ctx context.Context, offerID string) (map[string]any, error) {
	var view map[string]any
	err := s.db.QueryRow(ctx, `
		select jsonb_build_object(
		    'offer_id', id::text,
		    'title', title,
		    'description', description,
		    'status', status,
		    'target_type', target_type,
		    'target_course_id', target_course_id::text,
		    'target_lesson_id', target_lesson_id,
		    'price_amount_minor', price_amount_minor,
		    'price_currency', price_currency
		)
		from commercial_offers
		where id = $1
	`, offerID).Scan(&view)
	return view, err
}

func normalizeTarget(targetType string, courseID string, lessonID string) (*string, error) {
	targetType = strings.TrimSpace(targetType)
	courseID = strings.TrimSpace(courseID)
	if courseID == "" {
		return nil, ErrInvalidOfferTarget
	}
	switch targetType {
	case "course":
		return nil, nil
	case "lesson":
		lessonID = strings.TrimSpace(lessonID)
		if lessonID == "" {
			return nil, ErrInvalidOfferTarget
		}
		return &lessonID, nil
	default:
		return nil, ErrInvalidOfferTarget
	}
}

func (s *Service) validateOfferTarget(ctx context.Context, targetType string, courseID string, lessonID *string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := s.validateOfferTargetTx(ctx, tx, targetType, courseID, lessonID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) validateOfferTargetTx(ctx context.Context, tx pgx.Tx, targetType string, courseID string, lessonID *string) error {
	var ownerKind string
	var hasCurrentRevision bool
	if err := tx.QueryRow(ctx, `
		select owner_kind, exists(select 1 from course_revisions cr where cr.course_id = c.id and cr.is_current = true)
		from courses c
		where c.id = $1 and c.deleted_at is null
	`, courseID).Scan(&ownerKind, &hasCurrentRevision); err != nil {
		if err == pgx.ErrNoRows {
			return ErrInvalidOfferTarget
		}
		return err
	}
	if ownerKind != "platform" {
		return ErrTeacherContentCannotBePaid
	}
	if !hasCurrentRevision {
		return ErrInvalidOfferTarget
	}
	if targetType == "lesson" {
		var count int
		if err := tx.QueryRow(ctx, `
			select count(*)
			from course_revision_lessons crl
			join course_revisions cr on cr.id = crl.course_revision_id and cr.is_current = true
			where cr.course_id = $1 and crl.lesson_id = $2
		`, courseID, *lessonID).Scan(&count); err != nil {
			return err
		}
		if count == 0 {
			return ErrInvalidOfferTarget
		}
	}
	return nil
}

func nullableString(value string) any {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return value
}

func (s *Service) validateStudentID(ctx context.Context, studentID string) error {
	if _, err := uuid.Parse(strings.TrimSpace(studentID)); err != nil {
		return ErrInvalidStudentID
	}
	var role string
	if err := s.db.QueryRow(ctx, `select role from accounts where id = $1`, studentID).Scan(&role); err != nil {
		if err == pgx.ErrNoRows {
			return ErrInvalidStudentID
		}
		return err
	}
	if role != "student" {
		return ErrInvalidStudentID
	}
	return nil
}

var (
	ErrInvalidOfferTarget             = fmt.Errorf("invalid_offer_target")
	ErrTeacherContentCannotBePaid     = fmt.Errorf("teacher_content_cannot_be_paid")
	ErrOfferNotFound                  = fmt.Errorf("offer_not_found")
	ErrOfferNotActive                 = fmt.Errorf("offer_not_active")
	ErrPurchaseRequestAlreadyOpen     = fmt.Errorf("purchase_request_already_open")
	ErrPurchaseRequestNotFound        = fmt.Errorf("purchase_request_not_found")
	ErrPurchaseRequestAlreadyResolved = fmt.Errorf("purchase_request_already_resolved")
	ErrPurchaseRequestOfferMismatch   = fmt.Errorf("purchase_request_offer_mismatch")
	ErrOrderAlreadyPendingForTarget   = fmt.Errorf("order_already_pending_for_target")
	ErrOrderNotFound                  = fmt.Errorf("order_not_found")
	ErrPaymentAlreadyConfirmed        = fmt.Errorf("payment_already_confirmed")
	ErrManualPaymentMismatch          = fmt.Errorf("manual_payment_mismatch")
	ErrEntitlementAlreadyActive       = fmt.Errorf("entitlement_already_active")
	ErrEntitlementNotFound            = fmt.Errorf("entitlement_not_found")
	ErrEntitlementAlreadyResolved     = fmt.Errorf("entitlement_already_resolved")
	ErrInvalidStudentID               = fmt.Errorf("invalid_student_id")
	ErrChildNotVisible                = fmt.Errorf("child_not_visible")
	ErrBillingNotConfigured           = fmt.Errorf("billing_not_configured")
	ErrBillingProviderRejected        = fmt.Errorf("billing_provider_rejected")
	ErrInvalidBillingNotification     = fmt.Errorf("invalid_billing_notification")
	ErrBillingAmountMismatch          = fmt.Errorf("billing_amount_mismatch")
)
