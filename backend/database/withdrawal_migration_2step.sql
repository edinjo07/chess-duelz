-- Add missing columns to withdrawals table for 2-step approval flow
-- Run this migration after deploying ledger system

ALTER TABLE withdrawals
  ADD COLUMN approved_by BIGINT NULL AFTER status,
  ADD COLUMN approved_at TIMESTAMP NULL AFTER approved_by,
  ADD COLUMN sent_by BIGINT NULL AFTER approved_at,
  ADD COLUMN sent_at TIMESTAMP NULL AFTER sent_by,
  ADD COLUMN txid VARCHAR(128) NULL AFTER sent_at,
  ADD COLUMN internal_notes TEXT NULL AFTER txid,
  ADD KEY idx_approved_by (approved_by),
  ADD KEY idx_sent_by (sent_by);

-- Add foreign keys if users table exists
-- ALTER TABLE withdrawals ADD FOREIGN KEY (approved_by) REFERENCES users(id);
-- ALTER TABLE withdrawals ADD FOREIGN KEY (sent_by) REFERENCES users(id);
