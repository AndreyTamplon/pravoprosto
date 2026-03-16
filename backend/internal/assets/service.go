package assets

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Service struct {
	db *pgxpool.Pool
}

func NewService(db *pgxpool.Pool) *Service {
	return &Service{db: db}
}

type UploadRequestInput struct {
	FileName  string `json:"file_name"`
	MimeType  string `json:"mime_type"`
	SizeBytes int64  `json:"size_bytes"`
}

type UploadRequestView struct {
	AssetID   string            `json:"asset_id"`
	UploadURL string            `json:"upload_url"`
	Method    string            `json:"method"`
	Headers   map[string]string `json:"headers"`
}

func DecodeUploadRequest(r *http.Request) (UploadRequestInput, error) {
	var input UploadRequestInput
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		return UploadRequestInput{}, err
	}
	return input, nil
}

func (s *Service) CreateUploadRequest(ctx context.Context, accountID string, input UploadRequestInput) (UploadRequestView, error) {
	if !allowedMime(input.MimeType) || input.SizeBytes <= 0 || input.SizeBytes > 10*1024*1024 {
		return UploadRequestView{}, fmt.Errorf("invalid_asset_upload")
	}

	storageKey, err := randomKey()
	if err != nil {
		return UploadRequestView{}, err
	}

	var assetID string
	err = s.db.QueryRow(ctx, `
		insert into assets(owner_account_id, storage_key, mime_type, size_bytes)
		values ($1, $2, $3, $4)
		returning id::text
	`, accountID, storageKey, input.MimeType, input.SizeBytes).Scan(&assetID)
	if err != nil {
		return UploadRequestView{}, err
	}

	return UploadRequestView{
		AssetID:   assetID,
		UploadURL: "/fake-storage/" + storageKey,
		Method:    http.MethodPut,
		Headers: map[string]string{
			"Content-Type": input.MimeType,
		},
	}, nil
}

func allowedMime(mime string) bool {
	switch strings.ToLower(strings.TrimSpace(mime)) {
	case "image/png", "image/jpeg", "image/webp", "image/gif":
		return true
	default:
		return false
	}
}

func randomKey() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
