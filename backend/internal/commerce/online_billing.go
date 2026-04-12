package commerce

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type tbankInitPayload struct {
	TerminalKey     string            `json:"TerminalKey"`
	Amount          int64             `json:"Amount"`
	OrderID         string            `json:"OrderId"`
	Description     string            `json:"Description,omitempty"`
	NotificationURL string            `json:"NotificationURL,omitempty"`
	SuccessURL      string            `json:"SuccessURL,omitempty"`
	FailURL         string            `json:"FailURL,omitempty"`
	RedirectDueDate string            `json:"RedirectDueDate,omitempty"`
	PayType         string            `json:"PayType,omitempty"`
	Data            map[string]string `json:"DATA,omitempty"`
	Receipt         *tbankReceipt     `json:"Receipt,omitempty"`
	Token           string            `json:"Token"`
}

type tbankReceipt struct {
	Email    string             `json:"Email,omitempty"`
	Taxation string             `json:"Taxation,omitempty"`
	Items    []tbankReceiptItem `json:"Items,omitempty"`
}

type tbankReceiptItem struct {
	Name          string  `json:"Name"`
	Price         int64   `json:"Price"`
	Quantity      float64 `json:"Quantity"`
	Amount        int64   `json:"Amount"`
	PaymentMethod string  `json:"PaymentMethod,omitempty"`
	PaymentObject string  `json:"PaymentObject,omitempty"`
	Tax           string  `json:"Tax,omitempty"`
}

type tbankInitResponse struct {
	Success    bool   `json:"Success"`
	ErrorCode  string `json:"ErrorCode"`
	Message    string `json:"Message"`
	Details    string `json:"Details"`
	PaymentID  string `json:"PaymentId"`
	OrderID    string `json:"OrderId"`
	Status     string `json:"Status"`
	PaymentURL string `json:"PaymentURL"`
}

func DecodeTBankNotification(r *http.Request) (map[string]any, error) {
	decoder := json.NewDecoder(r.Body)
	decoder.UseNumber()
	var payload map[string]any
	if err := decoder.Decode(&payload); err != nil {
		return nil, err
	}
	return payload, nil
}

func (s *Service) ListParentChildOffers(ctx context.Context, parentID string, studentID string) (map[string]any, error) {
	if err := s.ensureParentChildLink(ctx, parentID, studentID); err != nil {
		return nil, err
	}
	if err := s.cancelExpiredAwaitingOrders(ctx, studentID); err != nil {
		return nil, err
	}
	pendingCutoff := s.pendingOrderCutoff()

	rows, err := s.db.Query(ctx, `
		select o.id::text, o.title, o.description, o.target_type, o.target_course_id::text, o.target_lesson_id,
		       o.price_amount_minor, o.price_currency, cr.title, crl.title,
		       e.id::text, ord.id::text, tps.payment_url
		from commercial_offers o
		join course_revisions cr on cr.course_id = o.target_course_id and cr.is_current = true
		left join course_revision_lessons crl on crl.course_revision_id = cr.id and crl.lesson_id = o.target_lesson_id
		left join entitlements e
		       on e.student_id = $1 and e.status = 'active' and e.target_course_id = o.target_course_id
		      and (e.target_type = 'course' or (e.target_type = 'lesson' and e.target_lesson_id = o.target_lesson_id))
		left join commercial_orders ord
		       on ord.student_id = $1 and ord.status = 'awaiting_confirmation' and ord.target_course_id = o.target_course_id
		      and (ord.target_type = 'course' or (ord.target_type = 'lesson' and ord.target_lesson_id = o.target_lesson_id))
		      and ord.created_at >= $2
		left join tbank_payment_sessions tps on tps.order_id = ord.id
		where o.status = 'active'
		order by o.created_at desc
	`, studentID, pendingCutoff)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]map[string]any, 0)
	for rows.Next() {
		var offerID, title, description, targetType, targetCourseID, priceCurrency, courseTitle string
		var targetLessonID, lessonTitle, entitlementID, orderID, paymentURL *string
		var priceAmountMinor int64
		if err := rows.Scan(
			&offerID,
			&title,
			&description,
			&targetType,
			&targetCourseID,
			&targetLessonID,
			&priceAmountMinor,
			&priceCurrency,
			&courseTitle,
			&lessonTitle,
			&entitlementID,
			&orderID,
			&paymentURL,
		); err != nil {
			return nil, err
		}

		accessState := "locked_paid"
		if entitlementID != nil {
			accessState = "granted"
		} else if orderID != nil {
			accessState = "awaiting_payment_confirmation"
		}

		items = append(items, map[string]any{
			"offer_id":           offerID,
			"title":              title,
			"description":        description,
			"target_type":        targetType,
			"target_course_id":   targetCourseID,
			"target_lesson_id":   targetLessonID,
			"course_title":       courseTitle,
			"lesson_title":       lessonTitle,
			"price_amount_minor": priceAmountMinor,
			"price_currency":     priceCurrency,
			"access_state":       accessState,
			"order_id":           orderID,
			"payment_url":        paymentURL,
		})
	}
	return map[string]any{"items": items}, rows.Err()
}

func (s *Service) StartParentCheckout(ctx context.Context, parentID string, studentID string, offerID string) (map[string]any, error) {
	if !s.tbankEnabled() {
		return nil, ErrBillingNotConfigured
	}
	if err := s.ensureParentChildLink(ctx, parentID, studentID); err != nil {
		return nil, err
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err := s.cancelExpiredAwaitingOrdersTx(ctx, tx, studentID); err != nil {
		return nil, err
	}

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
	`, offerID).Scan(
		&offer.ID,
		&offer.TargetType,
		&offer.TargetCourseID,
		&offer.TargetLessonID,
		&offer.Title,
		&offer.Description,
		&offer.PriceAmountMinor,
		&offer.PriceCurrency,
		&offer.Status,
	); err != nil {
		if err == pgx.ErrNoRows {
			return nil, ErrOfferNotFound
		}
		return nil, err
	}
	if offer.Status != "active" {
		return nil, ErrOfferNotActive
	}

	var entitlementCount int
	if err := tx.QueryRow(ctx, `
		select count(*)
		from entitlements
		where student_id = $1 and status = 'active' and target_course_id = $2
		  and (target_type = 'course' or (target_type = 'lesson' and target_lesson_id = $3))
	`, studentID, offer.TargetCourseID, offer.TargetLessonID).Scan(&entitlementCount); err != nil {
		return nil, err
	}
	if entitlementCount > 0 {
		return nil, ErrEntitlementAlreadyActive
	}

	var orderID string
	var existingOrder bool
	err = tx.QueryRow(ctx, `
		select id::text
		from commercial_orders
		where student_id = $1 and status = 'awaiting_confirmation' and target_course_id = $2
		  and (target_type = 'course' or (target_type = 'lesson' and target_lesson_id = $3))
		for update
	`, studentID, offer.TargetCourseID, offer.TargetLessonID).Scan(&orderID)
	if err != nil && err != pgx.ErrNoRows {
		return nil, err
	}
	if err == nil {
		existingOrder = true
	}

	if _, err := tx.Exec(ctx, `
		update purchase_requests
		set status = 'processed', processed_at = now(), processed_by_account_id = $3
		where student_id = $1 and offer_id = $2 and status = 'open'
	`, studentID, offer.ID, parentID); err != nil {
		return nil, err
	}
	payerEmail := ""
	if err := tx.QueryRow(ctx, `
		select email
		from external_identities
		where account_id = $1 and email is not null and trim(email) <> ''
		order by updated_at desc
		limit 1
	`, parentID).Scan(&payerEmail); err != nil && err != pgx.ErrNoRows {
		return nil, err
	}

	if existingOrder {
		var paymentURL *string
		if err := tx.QueryRow(ctx, `
			select payment_url
			from tbank_payment_sessions
			where order_id = $1
			for update
		`, orderID).Scan(&paymentURL); err == nil {
			if paymentURL != nil && strings.TrimSpace(*paymentURL) != "" {
				if err := tx.Commit(ctx); err != nil {
					return nil, err
				}
				return map[string]any{
					"order_id":     orderID,
					"access_state": "awaiting_payment_confirmation",
					"payment_url":  paymentURL,
				}, nil
			}
		} else if err != pgx.ErrNoRows {
			return nil, err
		}
	} else {
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
		if err := tx.QueryRow(ctx, `
			insert into commercial_orders(student_id, offer_id, status, target_type, target_course_id, target_lesson_id, offer_snapshot_json, price_snapshot_amount_minor, price_snapshot_currency, created_by_account_id)
			values ($1, $2, 'awaiting_confirmation', $3, $4, $5, $6, $7, $8, $9)
			returning id::text
		`, studentID, offer.ID, offer.TargetType, offer.TargetCourseID, offer.TargetLessonID, snapshot, offer.PriceAmountMinor, offer.PriceCurrency, parentID).Scan(&orderID); err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" {
				return nil, ErrOrderAlreadyPendingForTarget
			}
			return nil, err
		}
	}

	requestSnapshot, _ := json.Marshal(map[string]any{
		"terminal_key": s.tbankTerminalKey,
		"amount_minor": offer.PriceAmountMinor,
		"order_id":     orderID,
		"offer_id":     offer.ID,
	})
	if _, err := tx.Exec(ctx, `
		insert into tbank_payment_sessions(order_id, provider_order_id, status, init_request_json, created_by_parent_id)
		values ($1, $2, 'created', $3, $4)
		on conflict (order_id) do nothing
	`, orderID, orderID, requestSnapshot, parentID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	initResp, initReqJSON, initRespJSON, err := s.initTBankPayment(ctx, orderID, offer.PriceAmountMinor, offer.Title, payerEmail)
	if err != nil {
		_, _ = s.db.Exec(ctx, `
			update tbank_payment_sessions
			set status = 'failed', init_request_json = $2, init_response_json = $3, updated_at = now()
			where order_id = $1
		`, orderID, initReqJSON, initRespJSON)
		_, _ = s.db.Exec(ctx, `
			update commercial_orders
			set status = 'canceled', canceled_at = now(), updated_at = now()
			where id = $1 and status = 'awaiting_confirmation'
		`, orderID)
		return nil, err
	}

	if _, err := s.db.Exec(ctx, `
		update tbank_payment_sessions
		set provider_payment_id = $2, payment_url = $3, status = 'initialized', init_request_json = $4, init_response_json = $5, updated_at = now()
		where order_id = $1
	`, orderID, nullableString(initResp.PaymentID), nullableString(initResp.PaymentURL), initReqJSON, initRespJSON); err != nil {
		return nil, err
	}

	return map[string]any{
		"order_id":     orderID,
		"access_state": "awaiting_payment_confirmation",
		"payment_url":  initResp.PaymentURL,
		"payment_id":   initResp.PaymentID,
	}, nil
}

func (s *Service) ProcessTBankNotification(ctx context.Context, payload map[string]any) error {
	if !s.tbankEnabled() {
		return ErrBillingNotConfigured
	}

	terminalKey := asString(payload["TerminalKey"])
	orderID := strings.TrimSpace(asString(payload["OrderId"]))
	paymentID := strings.TrimSpace(asString(payload["PaymentId"]))
	status := strings.ToUpper(strings.TrimSpace(asString(payload["Status"])))
	token := strings.TrimSpace(asString(payload["Token"]))
	success := asBool(payload["Success"])
	amountMinor := asInt64(payload["Amount"])

	if terminalKey == "" || orderID == "" || token == "" {
		return ErrInvalidBillingNotification
	}
	if terminalKey != s.tbankTerminalKey {
		return ErrInvalidBillingNotification
	}
	if !s.verifyTBankToken(payload, token) {
		return ErrInvalidBillingNotification
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
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
		CreatedBy      string
	}
	if err := tx.QueryRow(ctx, `
		select id::text, student_id::text, status, target_type, target_course_id::text, target_lesson_id,
		       price_snapshot_amount_minor, price_snapshot_currency, created_by_account_id::text
		from commercial_orders
		where id = $1
		for update
	`, orderID).Scan(
		&order.ID,
		&order.StudentID,
		&order.Status,
		&order.TargetType,
		&order.TargetCourseID,
		&order.TargetLessonID,
		&order.AmountMinor,
		&order.Currency,
		&order.CreatedBy,
	); err != nil {
		if err == pgx.ErrNoRows {
			// Unknown order must still return OK to provider.
			if err := tx.Commit(ctx); err != nil {
				return err
			}
			return nil
		}
		return err
	}

	notificationJSON, _ := json.Marshal(payload)
	if _, err := tx.Exec(ctx, `
		insert into tbank_payment_sessions(order_id, provider_order_id, provider_payment_id, status, init_request_json, init_response_json, last_notification_json, created_by_parent_id)
		values ($1, $2, $3, 'created', '{}'::jsonb, '{}'::jsonb, $4, $5)
		on conflict (order_id) do update
		    set provider_payment_id = coalesce(excluded.provider_payment_id, tbank_payment_sessions.provider_payment_id),
		        last_notification_json = excluded.last_notification_json,
		        updated_at = now()
	`, order.ID, orderID, nullableString(paymentID), notificationJSON, order.CreatedBy); err != nil {
		return err
	}

	if isTBankFailureStatus(status) {
		sessionStatus := "failed"
		if isTBankCanceledStatus(status) {
			sessionStatus = "canceled"
		}
		if _, err := tx.Exec(ctx, `
			update tbank_payment_sessions
			set status = $2, updated_at = now(), last_notification_json = $3
			where order_id = $1
		`, order.ID, sessionStatus, notificationJSON); err != nil {
			return err
		}
		if order.Status == "awaiting_confirmation" {
			if _, err := tx.Exec(ctx, `
				update commercial_orders
				set status = 'canceled', canceled_at = now(), updated_at = now()
				where id = $1
			`, order.ID); err != nil {
				return err
			}
		}
		return tx.Commit(ctx)
	}

	if !isTBankPaidStatus(status, success) {
		if _, err := tx.Exec(ctx, `
			update tbank_payment_sessions
			set status = 'initialized', updated_at = now(), last_notification_json = $2
			where order_id = $1
		`, order.ID, notificationJSON); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}

	if amountMinor != order.AmountMinor {
		if _, err := tx.Exec(ctx, `
			update tbank_payment_sessions
			set status = 'mismatch', updated_at = now(), last_notification_json = $2
			where order_id = $1
		`, order.ID, notificationJSON); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}

	if order.Status == "fulfilled" {
		if _, err := tx.Exec(ctx, `
			update tbank_payment_sessions
			set status = 'paid', paid_at = coalesce(paid_at, now()), updated_at = now(), last_notification_json = $2
			where order_id = $1
		`, order.ID, notificationJSON); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}

	if order.Status != "awaiting_confirmation" {
		if order.Status == "canceled" {
			slog.Error("PAYMENT ALERT: confirmed webhook received for canceled order — money charged but entitlement NOT granted, manual reconciliation required",
				"order_id", order.ID,
				"payment_id", paymentID,
				"order_status", order.Status,
				"amount_minor", amountMinor,
			)
		}
		return tx.Commit(ctx)
	}

	externalReference := "tbank:" + paymentID
	idempotencyKey := "tbank:" + paymentID
	if paymentID == "" {
		externalReference = "tbank:order:" + order.ID
		idempotencyKey = externalReference
	}

	var paymentRecordID string
	err = tx.QueryRow(ctx, `
		insert into payment_records(order_id, amount_minor, currency, idempotency_key, external_reference, confirmed_by_admin_id, paid_at)
		values ($1, $2, $3, $4, $5, $6, $7)
		returning id::text
	`, order.ID, order.AmountMinor, strings.ToUpper(order.Currency), idempotencyKey, externalReference, order.CreatedBy, time.Now().UTC()).Scan(&paymentRecordID)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			if err := tx.QueryRow(ctx, `
				select id::text
				from payment_records
				where order_id = $1 and (idempotency_key = $2 or external_reference = $3)
				order by created_at desc
				limit 1
			`, order.ID, idempotencyKey, externalReference).Scan(&paymentRecordID); err != nil {
				return err
			}
		} else {
			return err
		}
	}

	var existingEntitlementID string
	err = tx.QueryRow(ctx, `
		select id::text
		from entitlements
		where order_id = $1 and status = 'active'
		limit 1
	`, order.ID).Scan(&existingEntitlementID)
	if err != nil && err != pgx.ErrNoRows {
		return err
	}
	if err == pgx.ErrNoRows {
		if _, err := s.fulfillPurchaseEntitlementTx(ctx, tx, order.CreatedBy, struct {
			ID             string
			StudentID      string
			Status         string
			TargetType     string
			TargetCourseID string
			TargetLessonID *string
			AmountMinor    int64
			Currency       string
		}{
			ID:             order.ID,
			StudentID:      order.StudentID,
			Status:         order.Status,
			TargetType:     order.TargetType,
			TargetCourseID: order.TargetCourseID,
			TargetLessonID: order.TargetLessonID,
			AmountMinor:    order.AmountMinor,
			Currency:       order.Currency,
		}, paymentRecordID); err != nil && !errors.Is(err, ErrEntitlementAlreadyActive) {
			return err
		}
	}

	if order.Status != "fulfilled" {
		if _, err := tx.Exec(ctx, `
			update commercial_orders
			set status = 'fulfilled', fulfilled_at = now(), updated_at = now()
			where id = $1
		`, order.ID); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `
		update tbank_payment_sessions
		set status = 'paid', paid_at = coalesce(paid_at, now()), updated_at = now(), last_notification_json = $2
		where order_id = $1
	`, order.ID, notificationJSON); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) initTBankPayment(ctx context.Context, orderID string, amountMinor int64, description string, payerEmail string) (tbankInitResponse, []byte, []byte, error) {
	payload := tbankInitPayload{
		TerminalKey: s.tbankTerminalKey,
		Amount:      amountMinor,
		OrderID:     orderID,
		Description: description,
		PayType:     "O",
		Data: map[string]string{
			"OperationInitiatorType": "0",
		},
	}
	if s.tbankNotificationURL != "" {
		payload.NotificationURL = s.tbankNotificationURL
	}
	if s.tbankSuccessURL != "" {
		payload.SuccessURL = s.tbankSuccessURL
	}
	if s.tbankFailURL != "" {
		payload.FailURL = s.tbankFailURL
	}
	if dueDate := s.tbankRedirectDueDate(); dueDate != "" {
		payload.RedirectDueDate = dueDate
	}
	if receipt := s.buildTBankReceipt(description, amountMinor, payerEmail); receipt != nil {
		payload.Receipt = receipt
	}
	payload.Token = s.signTBankValues(map[string]string{
		"TerminalKey":     payload.TerminalKey,
		"Amount":          strconv.FormatInt(payload.Amount, 10),
		"OrderId":         payload.OrderID,
		"Description":     payload.Description,
		"NotificationURL": payload.NotificationURL,
		"SuccessURL":      payload.SuccessURL,
		"FailURL":         payload.FailURL,
		"RedirectDueDate": payload.RedirectDueDate,
		"PayType":         payload.PayType,
	})

	payloadForStorage := payload
	payloadForStorage.Token = ""
	initReqJSON := mustJSON(payloadForStorage)

	endpoint := strings.TrimRight(s.tbankAPIBaseURL, "/") + "/v2/Init"
	body, err := json.Marshal(payload)
	if err != nil {
		return tbankInitResponse{}, initReqJSON, []byte("{}"), ErrBillingProviderRejected
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return tbankInitResponse{}, initReqJSON, []byte("{}"), ErrBillingProviderRejected
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return tbankInitResponse{}, initReqJSON, []byte("{}"), ErrBillingProviderRejected
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return tbankInitResponse{}, initReqJSON, respBody, ErrBillingProviderRejected
	}

	var raw map[string]any
	decoder := json.NewDecoder(bytes.NewReader(respBody))
	decoder.UseNumber()
	if err := decoder.Decode(&raw); err != nil {
		return tbankInitResponse{}, initReqJSON, respBody, ErrBillingProviderRejected
	}
	parsed := tbankInitResponse{
		Success:    asBool(raw["Success"]),
		ErrorCode:  strings.TrimSpace(asString(raw["ErrorCode"])),
		Message:    strings.TrimSpace(asString(raw["Message"])),
		Details:    strings.TrimSpace(asString(raw["Details"])),
		PaymentID:  strings.TrimSpace(asString(raw["PaymentId"])),
		OrderID:    strings.TrimSpace(asString(raw["OrderId"])),
		Status:     strings.TrimSpace(asString(raw["Status"])),
		PaymentURL: strings.TrimSpace(asString(raw["PaymentURL"])),
	}
	if parsed.OrderID != "" && parsed.OrderID != orderID {
		return tbankInitResponse{}, initReqJSON, respBody, ErrBillingProviderRejected
	}
	if !parsed.Success || (parsed.ErrorCode != "" && parsed.ErrorCode != "0") || strings.TrimSpace(parsed.PaymentURL) == "" {
		return tbankInitResponse{}, initReqJSON, respBody, ErrBillingProviderRejected
	}
	return parsed, initReqJSON, respBody, nil
}

func (s *Service) pendingOrderCutoff() time.Time {
	if s.tbankPendingTTL <= 0 {
		return time.Unix(0, 0).UTC()
	}
	return time.Now().UTC().Add(-s.tbankPendingTTL)
}

func (s *Service) cancelExpiredAwaitingOrders(ctx context.Context, studentID string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := s.cancelExpiredAwaitingOrdersTx(ctx, tx, studentID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) cancelExpiredAwaitingOrdersTx(ctx context.Context, tx pgx.Tx, studentID string) error {
	if strings.TrimSpace(studentID) == "" || s.tbankPendingTTL <= 0 {
		return nil
	}
	cutoff := s.pendingOrderCutoff()
	if _, err := tx.Exec(ctx, `
		with expired as (
			update commercial_orders
			set status = 'canceled', canceled_at = coalesce(canceled_at, now()), updated_at = now()
			where student_id = $1
			  and status = 'awaiting_confirmation'
			  and created_at < $2
			returning id
		)
		update tbank_payment_sessions tps
		set status = 'canceled', updated_at = now()
		from expired
		where tps.order_id = expired.id
		  and tps.status in ('created', 'initialized')
	`, studentID, cutoff); err != nil {
		return err
	}
	return nil
}

func (s *Service) tbankRedirectDueDate() string {
	if s.tbankPendingTTL <= 0 {
		return ""
	}
	return time.Now().UTC().Add(s.tbankPendingTTL).Format(time.RFC3339)
}

func (s *Service) buildTBankReceipt(description string, amountMinor int64, payerEmail string) *tbankReceipt {
	if !s.tbankReceiptEnabled {
		return nil
	}
	email := strings.TrimSpace(payerEmail)
	taxation := strings.TrimSpace(s.tbankReceiptTaxation)
	if email == "" || taxation == "" || amountMinor <= 0 {
		return nil
	}
	itemName := strings.TrimSpace(description)
	if itemName == "" {
		itemName = "Scenario access"
	}
	return &tbankReceipt{
		Email:    email,
		Taxation: taxation,
		Items: []tbankReceiptItem{
			{
				Name:          itemName,
				Price:         amountMinor,
				Quantity:      1,
				Amount:        amountMinor,
				PaymentMethod: s.tbankReceiptPaymentMethod,
				PaymentObject: s.tbankReceiptPaymentObject,
				Tax:           s.tbankReceiptTax,
			},
		},
	}
}

func (s *Service) ensureParentChildLink(ctx context.Context, parentID string, studentID string) error {
	var linked bool
	if err := s.db.QueryRow(ctx, `
		select exists(
			select 1 from guardian_links
			where parent_id = $1 and student_id = $2 and status = 'active'
		)
	`, parentID, studentID).Scan(&linked); err != nil {
		return err
	}
	if !linked {
		return ErrChildNotVisible
	}
	return nil
}

func (s *Service) tbankEnabled() bool {
	return strings.TrimSpace(s.tbankTerminalKey) != "" &&
		strings.TrimSpace(s.tbankPassword) != "" &&
		strings.TrimSpace(s.tbankAPIBaseURL) != ""
}

func (s *Service) verifyTBankToken(payload map[string]any, token string) bool {
	expected := s.signTBankAnyValues(payload)
	a := []byte(strings.ToLower(expected))
	b := []byte(strings.ToLower(strings.TrimSpace(token)))
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare(a, b) == 1
}

func (s *Service) signTBankAnyValues(values map[string]any) string {
	normalized := make(map[string]string, len(values)+1)
	for key, value := range values {
		if key == "Token" {
			continue
		}
		switch value.(type) {
		case map[string]any, []any:
			continue
		}
		normalized[key] = asString(value)
	}
	normalized["Password"] = s.tbankPassword
	return signTBankStrings(normalized)
}

func (s *Service) signTBankValues(values map[string]string) string {
	normalized := make(map[string]string, len(values)+1)
	for key, value := range values {
		if strings.TrimSpace(value) == "" {
			continue
		}
		normalized[key] = value
	}
	normalized["Password"] = s.tbankPassword
	return signTBankStrings(normalized)
}

func signTBankStrings(values map[string]string) string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, key := range keys {
		b.WriteString(values[key])
	}
	sum := sha256.Sum256([]byte(b.String()))
	return hex.EncodeToString(sum[:])
}

func isTBankPaidStatus(status string, _ bool) bool {
	status = strings.ToUpper(strings.TrimSpace(status))
	if status == "CONFIRMED" {
		return true
	}
	return false
}

func isTBankFailureStatus(status string) bool {
	switch strings.ToUpper(strings.TrimSpace(status)) {
	case "REJECTED", "CANCELED", "DEADLINE_EXPIRED", "AUTH_FAIL":
		return true
	default:
		return false
	}
}

func isTBankCanceledStatus(status string) bool {
	switch strings.ToUpper(strings.TrimSpace(status)) {
	case "CANCELED", "DEADLINE_EXPIRED":
		return true
	default:
		return false
	}
}

func asString(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case json.Number:
		return typed.String()
	case float64:
		return strconv.FormatInt(int64(typed), 10)
	case float32:
		return strconv.FormatInt(int64(typed), 10)
	case int:
		return strconv.Itoa(typed)
	case int64:
		return strconv.FormatInt(typed, 10)
	case int32:
		return strconv.FormatInt(int64(typed), 10)
	case bool:
		if typed {
			return "true"
		}
		return "false"
	default:
		return fmt.Sprint(typed)
	}
}

func asInt64(value any) int64 {
	switch typed := value.(type) {
	case nil:
		return 0
	case json.Number:
		v, _ := typed.Int64()
		return v
	case int64:
		return typed
	case int:
		return int64(typed)
	case int32:
		return int64(typed)
	case float64:
		return int64(typed)
	case float32:
		return int64(typed)
	case string:
		v, _ := strconv.ParseInt(strings.TrimSpace(typed), 10, 64)
		return v
	default:
		return 0
	}
}

func asBool(value any) bool {
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		v, err := strconv.ParseBool(strings.TrimSpace(typed))
		if err != nil {
			return false
		}
		return v
	default:
		return false
	}
}

func mustJSON(value any) []byte {
	raw, err := json.Marshal(value)
	if err != nil {
		return []byte("{}")
	}
	return raw
}
