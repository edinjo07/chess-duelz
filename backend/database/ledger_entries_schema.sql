-- Ledger Entries Table
-- Single source of truth for all balance changes

CREATE TABLE IF NOT EXISTS ledger_entries (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL,
  type VARCHAR(50) NOT NULL,
  amount DECIMAL(15, 2) NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'USD',
  balance_before DECIMAL(15, 2) NOT NULL,
  balance_after DECIMAL(15, 2) NOT NULL,
  reference_type VARCHAR(50) NULL,
  reference_id INT NULL,
  metadata JSON NULL,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  
  INDEX idx_user_id (user_id),
  INDEX idx_type (type),
  INDEX idx_created_at (created_at),
  INDEX idx_reference (reference_type, reference_id),
  INDEX idx_user_currency (user_id, currency)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Entry types:
-- deposit_credit: Credit from confirmed deposit
-- withdrawal_debit: Debit for withdrawal request
-- withdrawal_refund: Refund from rejected/failed withdrawal
-- bet_debit: Debit for placing a bet
-- win_credit: Credit for winning a bet
-- bet_refund: Refund from cancelled/voided bet
-- admin_credit: Manual credit by admin
-- admin_debit: Manual debit by admin
-- fee_debit: Platform fee
-- bonus_credit: Bonus or promotion credit
-- adjustment: Balance adjustment/correction
