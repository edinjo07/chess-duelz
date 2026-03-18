-- Withdrawal System Schema for NOWPayments Mass Payouts
-- Run this on your Aiven MySQL database

-- Table: withdrawals
-- Tracks withdrawal requests with status flow and NOWPayments integration
CREATE TABLE IF NOT EXISTS withdrawals (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  asset ENUM('BTC','ETH','USDT','USDC') NOT NULL,
  network VARCHAR(32) NOT NULL,             -- bitcoin, ethereum, tron, usdt-erc20, usdt-trc20, etc.
  to_address VARCHAR(128) NOT NULL,
  amount_atomic DECIMAL(65,0) NOT NULL,
  fee_atomic DECIMAL(65,0) NOT NULL DEFAULT 0,
  status ENUM('requested','approved','creating','verifying','processing','completed','rejected','failed','canceled') NOT NULL DEFAULT 'requested',
  provider VARCHAR(32) NOT NULL DEFAULT 'nowpayments',
  provider_payout_id VARCHAR(128) NULL,
  provider_batch_id VARCHAR(128) NULL,
  rejection_reason TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  completed_at TIMESTAMP NULL,
  KEY idx_user (user_id),
  KEY idx_status (status),
  KEY idx_provider (provider, provider_payout_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Notes:
-- 1. status flow: requested → approved → sending → completed
--                 or requested → rejected (unlock funds)
--                 or sending → failed (unlock funds)
-- 2. network examples: bitcoin, ethereum, tron, usdt-erc20, usdt-trc20, usdc-polygon
-- 3. amount_atomic and fee_atomic prevent floating point issues
-- 4. provider_payout_id tracks NOWPayments payout ID for status updates
