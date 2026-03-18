-- ================================================================
-- PRODUCTION-SAFE DEPOSIT SYSTEM SCHEMA
-- For Aiven MySQL with SSL
-- ================================================================

-- Deposit addresses (one BTC + one EVM address per user)
CREATE TABLE IF NOT EXISTS deposit_addresses (
  user_id BIGINT NOT NULL PRIMARY KEY,
  btc_address VARCHAR(128) NOT NULL,
  evm_address VARCHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_btc (btc_address),
  UNIQUE KEY uniq_evm (evm_address),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- User balances (atomic storage for precision)
CREATE TABLE IF NOT EXISTS balances (
  user_id BIGINT NOT NULL,
  asset ENUM('BTC','ETH','USDT','USDC') NOT NULL,
  available_atomic BIGINT NOT NULL DEFAULT 0,
  locked_atomic BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, asset),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_asset (asset)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Deposits (transaction tracking with unique constraint to prevent double-credit)
CREATE TABLE IF NOT EXISTS deposits (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  network ENUM('bitcoin','ethereum') NOT NULL,
  asset ENUM('BTC','ETH','USDT','USDC') NOT NULL,
  address VARCHAR(128) NOT NULL,
  tx_hash VARCHAR(128) NOT NULL,
  amount_atomic DECIMAL(65,0) NOT NULL,      -- supports wei / satoshi amounts
  decimals INT NOT NULL,
  block_number BIGINT NULL,
  confirmations INT NOT NULL DEFAULT 0,
  required_confirmations INT NOT NULL DEFAULT 0,
  status ENUM('pending','confirmed','credited','reorged','rejected') NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uniq_dep (network, asset, tx_hash, address),
  KEY idx_user (user_id),
  KEY idx_status (status),
  KEY idx_addr (address),
  KEY idx_tx_hash (tx_hash),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Deposit rules (server-authoritative configuration)
CREATE TABLE IF NOT EXISTS deposit_rules (
  network ENUM('bitcoin','ethereum') NOT NULL,
  asset ENUM('BTC','ETH','USDT','USDC') NOT NULL,
  min_display VARCHAR(32) NOT NULL,
  min_atomic DECIMAL(65,0) NOT NULL,
  decimals INT NOT NULL,
  required_confirmations INT NOT NULL,
  PRIMARY KEY (network, asset)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Insert default deposit rules
INSERT INTO deposit_rules (network, asset, min_display, min_atomic, decimals, required_confirmations)
VALUES
('bitcoin','BTC','0.0001 BTC', 10000, 8, 2),
('ethereum','ETH','0.001 ETH', 1000000000000000, 18, 12),
('ethereum','USDT','10 USDT', 10000000, 6, 12),
('ethereum','USDC','10 USDC', 10000000, 6, 12)
ON DUPLICATE KEY UPDATE
min_display=VALUES(min_display),
min_atomic=VALUES(min_atomic),
decimals=VALUES(decimals),
required_confirmations=VALUES(required_confirmations);

-- Add missing columns to users table if needed (safe ALTER)
-- Note: Run these manually if your users table doesn't have these fields

-- Add first_name, last_name if missing
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS first_name VARCHAR(100) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS last_name VARCHAR(100) DEFAULT NULL;

-- Add google_id, facebook_id for OAuth if missing
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS google_id VARCHAR(255) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS facebook_id VARCHAR(255) DEFAULT NULL,
ADD UNIQUE KEY IF NOT EXISTS uniq_google_id (google_id),
ADD UNIQUE KEY IF NOT EXISTS uniq_facebook_id (facebook_id);

-- ================================================================
-- INDEXES FOR PERFORMANCE
-- ================================================================
CREATE INDEX IF NOT EXISTS idx_deposits_user_created ON deposits(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deposits_status_updated ON deposits(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_balances_user_asset ON balances(user_id, asset);
