-- NOWPayments Deposit System Schema
-- Run this on your Aiven MySQL database

-- Table: deposit_intents
-- Stores payment creation requests and tracks status
CREATE TABLE IF NOT EXISTS deposit_intents (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  provider VARCHAR(32) NOT NULL DEFAULT 'nowpayments',
  payment_id BIGINT NOT NULL,
  pay_currency VARCHAR(32) NOT NULL,
  price_amount DECIMAL(18,8) NOT NULL,
  price_currency VARCHAR(16) NOT NULL,
  pay_amount DECIMAL(36,18) NULL,
  pay_address VARCHAR(128) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'created',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_payment (provider, payment_id),
  KEY idx_user (user_id),
  KEY idx_status (status),
  KEY idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table: balances
-- Stores user crypto balances in atomic units (prevents float precision issues)
CREATE TABLE IF NOT EXISTS balances (
  user_id BIGINT NOT NULL,
  asset ENUM('BTC','ETH','USDT','USDC') NOT NULL,
  available_atomic DECIMAL(65,0) NOT NULL DEFAULT 0,
  locked_atomic DECIMAL(65,0) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, asset),
  KEY idx_available (available_atomic)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Index for fast balance lookups
CREATE INDEX IF NOT EXISTS idx_user_asset ON balances(user_id, asset);

-- Notes:
-- 1. deposit_intents.status values: 'created', 'waiting', 'confirming', 'confirmed', 'finished', 'partially_paid', 'failed', 'refunded', 'expired', 'credited'
-- 2. 'credited' status is internal - marks that funds were added to balances table
-- 3. available_atomic stores amounts without decimals (e.g., 1 BTC = 100000000 satoshis)
-- 4. Decimal precision mapping:
--    - BTC: 8 decimals (satoshis)
--    - ETH: 18 decimals (wei)
--    - USDT/USDC: 6 decimals (standard ERC20)
