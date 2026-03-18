-- ============================================
-- PHASE 1: FINANCE CORE - DATABASE SCHEMA
-- Money Safety: Deposits & Ledger System
-- ============================================

-- ============================================
-- DEPOSITS TABLE
-- Complete tracking of all incoming payments
-- ============================================
CREATE TABLE IF NOT EXISTS deposits (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL,
  
  -- Provider details
  provider VARCHAR(50) NOT NULL DEFAULT 'nowpayments', -- nowpayments, coinbase, manual
  provider_payment_id VARCHAR(255) UNIQUE, -- NOWPayments payment_id or provider reference
  provider_order_id VARCHAR(255), -- Our order_id sent to provider
  
  -- Payment details
  coin VARCHAR(20) NOT NULL, -- BTC, ETH, USDT, etc.
  network VARCHAR(50), -- mainnet, ERC20, TRC20, BEP20, etc.
  address VARCHAR(255), -- Deposit address generated
  expected_amount DECIMAL(20, 8) NOT NULL, -- Amount we expect to receive
  received_amount DECIMAL(20, 8) DEFAULT 0, -- Actual amount received
  amount_usd DECIMAL(12, 2), -- USD value at time of deposit
  
  -- Status tracking
  status ENUM(
    'created',        -- Invoice created, waiting for payment
    'waiting',        -- Waiting for blockchain confirmations
    'confirming',     -- Confirmations in progress
    'confirmed',      -- Fully confirmed
    'finished',       -- Completed and credited
    'failed',         -- Payment failed
    'expired',        -- Invoice expired
    'refunded',       -- Payment refunded
    'partially_paid'  -- Received less than expected
  ) DEFAULT 'created',
  
  -- Confirmation tracking
  confirmations_current INT DEFAULT 0,
  confirmations_required INT DEFAULT 1,
  
  -- Webhook tracking
  webhook_received_at TIMESTAMP NULL,
  webhook_verified BOOLEAN DEFAULT FALSE,
  webhook_data JSON, -- Raw provider payload
  webhook_retry_count INT DEFAULT 0,
  
  -- Admin review
  reviewed_by INT NULL, -- Admin user_id who reviewed
  reviewed_at TIMESTAMP NULL,
  admin_notes TEXT,
  
  -- Ledger integration
  ledger_entry_id BIGINT NULL, -- Link to ledger_entries table
  credited_at TIMESTAMP NULL, -- When balance was credited
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NULL, -- Invoice expiration
  
  -- Indexes
  INDEX idx_user_id (user_id),
  INDEX idx_provider_payment_id (provider_payment_id),
  INDEX idx_status (status),
  INDEX idx_created_at (created_at),
  INDEX idx_coin_network (coin, network),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (ledger_entry_id) REFERENCES ledger_entries(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- LEDGER ENTRIES TABLE
-- Single source of truth for ALL balance changes
-- IMMUTABLE - Never UPDATE, only INSERT
-- ============================================
CREATE TABLE IF NOT EXISTS ledger_entries (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL,
  
  -- Entry type
  entry_type ENUM(
    'deposit',           -- Funds added via payment
    'deposit_bonus',     -- Bonus credited for deposit
    'bet',               -- Funds deducted for bet
    'win',               -- Funds added from winning
    'refund',            -- Bet refunded
    'admin_adjustment',  -- Manual admin correction
    'withdrawal',        -- Funds deducted for withdrawal
    'withdrawal_fee',    -- Fee charged for withdrawal
    'withdrawal_cancel', -- Withdrawal cancelled, funds returned
    'referral_bonus',    -- Referral reward
    'promo_credit',      -- Promotional credit
    'chargeback',        -- Disputed payment reversed
    'penalty'            -- Penalty/fine applied
  ) NOT NULL,
  
  -- Amount and balance
  amount DECIMAL(20, 8) NOT NULL, -- Positive for credits, negative for debits
  currency VARCHAR(10) NOT NULL DEFAULT 'USD',
  balance_before DECIMAL(20, 8) NOT NULL, -- Balance before this entry
  balance_after DECIMAL(20, 8) NOT NULL,  -- Balance after this entry (balance_before + amount)
  
  -- Reference to source transaction
  reference_type VARCHAR(50), -- 'deposit', 'game_session', 'withdrawal', 'admin', etc.
  reference_id VARCHAR(100),  -- ID of the referenced entity
  
  -- Additional context
  description TEXT, -- Human-readable description
  metadata JSON, -- Additional data (game details, admin reason, etc.)
  
  -- Admin tracking (for manual adjustments)
  admin_id INT NULL,
  admin_username VARCHAR(50),
  admin_reason TEXT,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  -- Indexes
  INDEX idx_user_id (user_id),
  INDEX idx_entry_type (entry_type),
  INDEX idx_created_at (created_at),
  INDEX idx_reference (reference_type, reference_id),
  INDEX idx_user_created (user_id, created_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- WEBHOOK QUEUE TABLE
-- Track all incoming webhooks for debugging
-- ============================================
CREATE TABLE IF NOT EXISTS webhook_queue (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  provider VARCHAR(50) NOT NULL,
  event_type VARCHAR(100),
  payload JSON NOT NULL,
  signature VARCHAR(500),
  signature_verified BOOLEAN DEFAULT FALSE,
  
  status ENUM('pending', 'processing', 'processed', 'failed') DEFAULT 'pending',
  processed_at TIMESTAMP NULL,
  error_message TEXT,
  retry_count INT DEFAULT 0,
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_status (status),
  INDEX idx_provider (provider),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- RECONCILIATION LOGS TABLE
-- Track deposit reconciliation between provider and ledger
-- ============================================
CREATE TABLE IF NOT EXISTS reconciliation_logs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  reconciliation_date DATE NOT NULL,
  provider VARCHAR(50) NOT NULL,
  
  -- Totals
  provider_deposits_count INT,
  provider_deposits_total DECIMAL(20, 8),
  ledger_credits_count INT,
  ledger_credits_total DECIMAL(20, 8),
  
  -- Discrepancies
  missing_in_ledger_count INT DEFAULT 0,
  missing_in_provider_count INT DEFAULT 0,
  amount_mismatch_count INT DEFAULT 0,
  
  discrepancies JSON, -- Array of discrepancy details
  
  -- Resolution
  status ENUM('pending', 'reviewed', 'resolved') DEFAULT 'pending',
  reviewed_by INT NULL,
  reviewed_at TIMESTAMP NULL,
  notes TEXT,
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_date (reconciliation_date),
  INDEX idx_provider (provider),
  INDEX idx_status (status),
  FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- USER BALANCE SNAPSHOTS (for integrity checks)
-- ============================================
CREATE TABLE IF NOT EXISTS balance_snapshots (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL,
  balance DECIMAL(20, 8) NOT NULL,
  currency VARCHAR(10) NOT NULL,
  snapshot_type ENUM('daily', 'manual', 'reconciliation') DEFAULT 'daily',
  ledger_entry_count INT, -- Number of ledger entries for this user at snapshot
  last_ledger_entry_id BIGINT, -- Last ledger entry ID at time of snapshot
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_user_id (user_id),
  INDEX idx_created_at (created_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- VIEWS FOR EASY QUERYING
-- ============================================

-- View: Pending deposits (needs attention)
CREATE OR REPLACE VIEW v_pending_deposits AS
SELECT 
  d.*,
  u.username,
  u.email,
  TIMESTAMPDIFF(HOUR, d.created_at, NOW()) as hours_pending
FROM deposits d
JOIN users u ON d.user_id = u.id
WHERE d.status IN ('created', 'waiting', 'confirming', 'partially_paid')
  AND d.created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)
ORDER BY d.created_at DESC;

-- View: Ledger with user details
CREATE OR REPLACE VIEW v_ledger_with_users AS
SELECT 
  l.*,
  u.username,
  u.email,
  a.username as admin_username
FROM ledger_entries l
JOIN users u ON l.user_id = u.id
LEFT JOIN users a ON l.admin_id = a.id;

-- ============================================
-- INITIAL DATA
-- ============================================

-- Insert test data marker
INSERT INTO deposits (user_id, provider, coin, network, expected_amount, status) 
VALUES (1, 'nowpayments', 'BTC', 'mainnet', 0.001, 'created')
ON DUPLICATE KEY UPDATE id=id;

-- ============================================
-- MIGRATION COMPLETE
-- ============================================
