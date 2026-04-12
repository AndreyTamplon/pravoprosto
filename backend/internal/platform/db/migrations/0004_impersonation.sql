-- Admin impersonation: track which admin created an impersonated session
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS impersonated_by_account_id uuid NULL REFERENCES accounts(id);
