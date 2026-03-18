-- Phase 2: Risk & Fraud Controls Database Schema
-- Purpose: Enhance withdrawal security with risk scoring and fraud detection

-- ============================================
-- User Risk Profiles
-- ============================================
CREATE TABLE IF NOT EXISTS user_risk_profiles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL UNIQUE,
  
  -- Risk Score (0-100, higher = riskier)
  risk_score INT DEFAULT 0,
  risk_level ENUM('low', 'medium', 'high', 'critical') DEFAULT 'low',
  
  -- Account Flags
  is_frozen BOOLEAN DEFAULT FALSE,
  freeze_reason TEXT,
  frozen_at DATETIME,
  frozen_by INT,
  
  withdrawals_frozen BOOLEAN DEFAULT FALSE,
  withdrawal_freeze_reason TEXT,
  
  requires_manual_review BOOLEAN DEFAULT FALSE,
  custom_withdrawal_limit DECIMAL(10, 2),
  
  -- Behavior Tracking
  total_deposits DECIMAL(10, 2) DEFAULT 0,
  total_withdrawals DECIMAL(10, 2) DEFAULT 0,
  deposit_count INT DEFAULT 0,
  withdrawal_count INT DEFAULT 0,
  first_deposit_at DATETIME,
  last_deposit_at DATETIME,
  first_withdrawal_at DATETIME,
  last_withdrawal_at DATETIME,
  
  -- Velocity Metrics
  deposit_withdraw_ratio DECIMAL(5, 2) DEFAULT 0, -- withdrawals/deposits
  avg_deposit_amount DECIMAL(10, 2) DEFAULT 0,
  avg_withdrawal_amount DECIMAL(10, 2) DEFAULT 0,
  max_single_deposit DECIMAL(10, 2) DEFAULT 0,
  max_single_withdrawal DECIMAL(10, 2) DEFAULT 0,
  
  -- Red Flags Count
  rapid_inout_flags INT DEFAULT 0,
  linked_account_flags INT DEFAULT 0,
  address_reuse_flags INT DEFAULT 0,
  chargeback_count INT DEFAULT 0,
  
  -- Timestamps
  last_calculated_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (frozen_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_risk_level (risk_level),
  INDEX idx_frozen (is_frozen),
  INDEX idx_risk_score (risk_score DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- Risk Rules Configuration
-- ============================================
CREATE TABLE IF NOT EXISTS risk_rules (
  id INT AUTO_INCREMENT PRIMARY KEY,
  rule_key VARCHAR(100) NOT NULL UNIQUE,
  rule_name VARCHAR(200) NOT NULL,
  rule_value VARCHAR(500) NOT NULL,
  rule_type ENUM('number', 'boolean', 'string', 'json') DEFAULT 'string',
  category ENUM('kyc', 'withdrawal', 'deposit', 'velocity', 'security', 'general') DEFAULT 'general',
  description TEXT,
  is_enabled BOOLEAN DEFAULT TRUE,
  
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by INT,
  
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_category (category),
  INDEX idx_enabled (is_enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insert default risk rules
INSERT INTO risk_rules (rule_key, rule_name, rule_value, rule_type, category, description) VALUES
-- KYC Tier Limits
('kyc_tier0_daily_withdraw', 'Tier 0 Daily Withdraw Limit', '50', 'number', 'kyc', 'Max daily withdrawal for unverified users'),
('kyc_tier0_max_deposit', 'Tier 0 Max Single Deposit', '100', 'number', 'kyc', 'Max single deposit for unverified users'),
('kyc_tier1_daily_withdraw', 'Tier 1 Daily Withdraw Limit', '500', 'number', 'kyc', 'Max daily withdrawal for ID verified users'),
('kyc_tier1_max_deposit', 'Tier 1 Max Single Deposit', '1000', 'number', 'kyc', 'Max single deposit for ID verified users'),
('kyc_tier2_daily_withdraw', 'Tier 2 Daily Withdraw Limit', '0', 'number', 'kyc', 'Max daily withdrawal for full KYC (0 = unlimited)'),
('kyc_tier2_max_deposit', 'Tier 2 Max Single Deposit', '0', 'number', 'kyc', 'Max single deposit for full KYC (0 = unlimited)'),

-- Security Cooldowns
('cooldown_password_change_hours', 'Password Change Cooldown', '24', 'number', 'security', 'Hours to wait after password change before withdrawal'),
('cooldown_email_change_hours', 'Email Change Cooldown', '48', 'number', 'security', 'Hours to wait after email change before withdrawal'),
('cooldown_new_address_hours', 'New Address Cooldown', '12', 'number', 'security', 'Hours to wait after adding new withdrawal address'),
('min_account_age_days', 'Minimum Account Age', '1', 'number', 'security', 'Minimum account age in days for withdrawals'),

-- Velocity Checks
('max_deposit_withdraw_ratio', 'Max Deposit/Withdraw Ratio', '0.95', 'number', 'velocity', 'Max ratio of withdrawals to deposits (0.95 = 95%)'),
('rapid_inout_threshold_minutes', 'Rapid In/Out Threshold', '30', 'number', 'velocity', 'Minutes between deposit and withdrawal to flag as suspicious'),
('max_withdrawals_per_day', 'Max Withdrawals Per Day', '5', 'number', 'velocity', 'Maximum withdrawal requests per user per day'),

-- Amount Thresholds
('large_transaction_threshold', 'Large Transaction Threshold', '1000', 'number', 'withdrawal', 'Withdrawal amount requiring enhanced review'),
('auto_approve_threshold', 'Auto-Approve Threshold', '100', 'number', 'withdrawal', 'Max amount for auto-approval (if enabled)'),

-- Confirmations
('btc_min_confirmations', 'BTC Minimum Confirmations', '2', 'number', 'deposit', 'Required confirmations for Bitcoin deposits'),
('eth_min_confirmations', 'ETH Minimum Confirmations', '12', 'number', 'deposit', 'Required confirmations for Ethereum deposits'),
('usdt_trc20_min_confirmations', 'USDT TRC20 Min Confirmations', '19', 'number', 'deposit', 'Required confirmations for USDT on Tron'),
('usdt_erc20_min_confirmations', 'USDT ERC20 Min Confirmations', '12', 'number', 'deposit', 'Required confirmations for USDT on Ethereum'),

-- General Settings
('manual_review_enabled', 'Manual Review Required', 'false', 'boolean', 'general', 'Require manual review for all withdrawals'),
('address_blacklist_enabled', 'Address Blacklist Enabled', 'true', 'boolean', 'general', 'Check withdrawals against blacklist')
ON DUPLICATE KEY UPDATE rule_value=VALUES(rule_value);

-- ============================================
-- Linked Accounts Detection
-- ============================================
CREATE TABLE IF NOT EXISTS linked_accounts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  linked_user_id INT NOT NULL,
  
  link_type ENUM('ip_address', 'device_fingerprint', 'wallet_address', 'email_similarity', 'phone', 'manual') NOT NULL,
  link_value VARCHAR(500), -- The shared value (IP, device ID, wallet, etc.)
  
  confidence_score DECIMAL(3, 2) DEFAULT 0.5, -- 0.0 to 1.0
  first_detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  occurrences INT DEFAULT 1,
  
  is_verified BOOLEAN DEFAULT FALSE, -- Admin confirmed this link
  verified_by INT,
  verified_at DATETIME,
  notes TEXT,
  
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (linked_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (verified_by) REFERENCES users(id) ON DELETE SET NULL,
  
  UNIQUE KEY unique_link (user_id, linked_user_id, link_type),
  INDEX idx_link_type (link_type),
  INDEX idx_confidence (confidence_score DESC),
  INDEX idx_verified (is_verified)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- Withdrawal Risk Assessments
-- ============================================
CREATE TABLE IF NOT EXISTS withdrawal_risk_assessments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  withdrawal_id INT NOT NULL UNIQUE,
  user_id INT NOT NULL,
  
  -- Overall Assessment
  risk_score INT NOT NULL, -- 0-100
  risk_level ENUM('low', 'medium', 'high', 'critical') NOT NULL,
  recommendation ENUM('auto_approve', 'manual_review', 'reject', 'hold') NOT NULL,
  
  -- Individual Checks
  kyc_status_check ENUM('pass', 'fail', 'warning') DEFAULT 'pass',
  account_age_check ENUM('pass', 'fail', 'warning') DEFAULT 'pass',
  velocity_check ENUM('pass', 'fail', 'warning') DEFAULT 'pass',
  address_check ENUM('pass', 'fail', 'warning') DEFAULT 'pass',
  linked_accounts_check ENUM('pass', 'fail', 'warning') DEFAULT 'pass',
  recent_changes_check ENUM('pass', 'fail', 'warning') DEFAULT 'pass',
  
  -- Risk Factors (JSON details)
  risk_factors JSON,
  
  -- Flags
  is_first_withdrawal BOOLEAN DEFAULT FALSE,
  is_new_address BOOLEAN DEFAULT FALSE,
  recent_password_change BOOLEAN DEFAULT FALSE,
  recent_email_change BOOLEAN DEFAULT FALSE,
  rapid_deposit_withdraw BOOLEAN DEFAULT FALSE,
  unusual_amount BOOLEAN DEFAULT FALSE,
  linked_accounts_found BOOLEAN DEFAULT FALSE,
  
  -- Metadata
  assessed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  reassessed_at DATETIME,
  assessment_version INT DEFAULT 1,
  
  FOREIGN KEY (withdrawal_id) REFERENCES withdrawals(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_risk_level (risk_level),
  INDEX idx_recommendation (recommendation)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- IP and Device Tracking
-- ============================================
CREATE TABLE IF NOT EXISTS user_access_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  
  action_type ENUM('login', 'logout', 'deposit', 'withdrawal', 'bet', 'password_change', 'email_change') NOT NULL,
  
  ip_address VARCHAR(45),
  country_code CHAR(2),
  city VARCHAR(100),
  
  device_fingerprint VARCHAR(255),
  user_agent TEXT,
  browser VARCHAR(100),
  os VARCHAR(100),
  device_type ENUM('desktop', 'mobile', 'tablet', 'unknown') DEFAULT 'unknown',
  
  is_vpn BOOLEAN DEFAULT FALSE,
  is_proxy BOOLEAN DEFAULT FALSE,
  is_tor BOOLEAN DEFAULT FALSE,
  
  session_id VARCHAR(255),
  
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user_created (user_id, created_at DESC),
  INDEX idx_ip (ip_address),
  INDEX idx_device (device_fingerprint),
  INDEX idx_action (action_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- Wallet Address Blacklist
-- ============================================
CREATE TABLE IF NOT EXISTS wallet_blacklist (
  id INT AUTO_INCREMENT PRIMARY KEY,
  wallet_address VARCHAR(255) NOT NULL UNIQUE,
  network VARCHAR(50) NOT NULL,
  
  reason TEXT NOT NULL,
  risk_category ENUM('fraud', 'money_laundering', 'sanctioned', 'stolen_funds', 'mixer', 'other') NOT NULL,
  
  added_by INT NOT NULL,
  added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  is_active BOOLEAN DEFAULT TRUE,
  notes TEXT,
  
  FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_address_network (wallet_address, network),
  INDEX idx_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- Views for Quick Access
-- ============================================

-- High Risk Users View
CREATE OR REPLACE VIEW v_high_risk_users AS
SELECT 
  u.id,
  u.username,
  u.email,
  urp.risk_score,
  urp.risk_level,
  urp.is_frozen,
  urp.withdrawals_frozen,
  urp.deposit_withdraw_ratio,
  urp.rapid_inout_flags,
  urp.linked_account_flags,
  urp.last_calculated_at
FROM users u
JOIN user_risk_profiles urp ON u.id = urp.user_id
WHERE urp.risk_level IN ('high', 'critical')
   OR urp.is_frozen = TRUE
   OR urp.withdrawals_frozen = TRUE
ORDER BY urp.risk_score DESC;

-- Pending High Risk Withdrawals View
CREATE OR REPLACE VIEW v_high_risk_withdrawals AS
SELECT 
  w.*,
  u.username,
  u.email,
  wra.risk_score,
  wra.risk_level,
  wra.recommendation,
  wra.risk_factors
FROM withdrawals w
JOIN users u ON w.user_id = u.id
LEFT JOIN withdrawal_risk_assessments wra ON w.id = wra.withdrawal_id
WHERE w.status = 'pending'
  AND (wra.risk_level IN ('high', 'critical') OR wra.recommendation != 'auto_approve')
ORDER BY wra.risk_score DESC, w.created_at ASC;

-- Recent Suspicious Activity View
CREATE OR REPLACE VIEW v_suspicious_activity AS
SELECT 
  u.id as user_id,
  u.username,
  u.email,
  urp.risk_score,
  COUNT(DISTINCT la.linked_user_id) as linked_accounts_count,
  MAX(urp.rapid_inout_flags) as rapid_flags,
  MAX(urp.last_calculated_at) as last_check
FROM users u
JOIN user_risk_profiles urp ON u.id = urp.user_id
LEFT JOIN linked_accounts la ON u.id = la.user_id
WHERE urp.risk_score > 50
   OR urp.rapid_inout_flags > 0
   OR urp.linked_account_flags > 0
GROUP BY u.id, u.username, u.email, urp.risk_score
ORDER BY urp.risk_score DESC;
