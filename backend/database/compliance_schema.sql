-- ============================================
-- Phase 4: Compliance Operations Schema
-- Enhanced KYC tiers, AML monitoring, and regulatory compliance
-- ============================================

-- ============================================
-- 1. KYC Tiers Table (Enhanced)
-- Multi-tier KYC system with document requirements
-- ============================================
CREATE TABLE IF NOT EXISTS kyc_tiers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  
  tier_level INT NOT NULL UNIQUE, -- 0, 1, 2, 3
  tier_name VARCHAR(50) NOT NULL, -- Basic, Standard, Enhanced, VIP
  
  -- Limits
  daily_deposit_limit DECIMAL(20, 8) NULL,
  daily_withdrawal_limit DECIMAL(20, 8) NULL,
  monthly_deposit_limit DECIMAL(20, 8) NULL,
  monthly_withdrawal_limit DECIMAL(20, 8) NULL,
  single_transaction_limit DECIMAL(20, 8) NULL,
  
  -- Requirements
  documents_required JSON NOT NULL, -- ["id_front", "id_back", "selfie", "proof_of_address"]
  verification_time_hours INT NOT NULL DEFAULT 24,
  requires_manual_review BOOLEAN DEFAULT FALSE,
  
  -- Features
  features JSON NULL, -- ["priority_support", "reduced_fees", "higher_limits"]
  
  -- Status
  is_active BOOLEAN DEFAULT TRUE,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  INDEX idx_tier_level (tier_level),
  INDEX idx_is_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Insert default KYC tiers
INSERT INTO kyc_tiers (tier_level, tier_name, daily_deposit_limit, daily_withdrawal_limit, monthly_deposit_limit, monthly_withdrawal_limit, single_transaction_limit, documents_required, verification_time_hours, requires_manual_review, features) VALUES
(0, 'Unverified', 100, 50, 500, 200, 50, '[]', 0, FALSE, '["basic_games"]'),
(1, 'Basic', 1000, 500, 10000, 5000, 500, '["id_front", "id_back", "selfie"]', 24, FALSE, '["all_games", "chat_access"]'),
(2, 'Standard', 10000, 5000, 100000, 50000, 5000, '["id_front", "id_back", "selfie", "proof_of_address"]', 48, TRUE, '["priority_support", "tournaments", "reduced_fees"]'),
(3, 'VIP', NULL, NULL, NULL, NULL, NULL, '["id_front", "id_back", "selfie", "proof_of_address", "proof_of_funds"]', 72, TRUE, '["vip_support", "custom_limits", "lowest_fees", "exclusive_games"]')
ON DUPLICATE KEY UPDATE tier_name = VALUES(tier_name);


-- ============================================
-- 2. User KYC Status Table (Enhanced)
-- ============================================
CREATE TABLE IF NOT EXISTS user_kyc_status (
  id INT AUTO_INCREMENT PRIMARY KEY,
  
  user_id INT NOT NULL UNIQUE,
  username VARCHAR(100) NOT NULL,
  
  -- Current Tier
  current_tier INT NOT NULL DEFAULT 0,
  previous_tier INT NULL,
  tier_upgraded_at TIMESTAMP NULL,
  
  -- Application Status
  application_status ENUM('none', 'pending', 'under_review', 'approved', 'rejected', 'expired') NOT NULL DEFAULT 'none',
  applied_for_tier INT NULL,
  applied_at TIMESTAMP NULL,
  
  -- Documents Submitted
  documents_submitted JSON NULL, -- {"id_front": {...}, "id_back": {...}, ...}
  documents_status JSON NULL, -- {"id_front": "approved", "id_back": "pending", ...}
  
  -- Verification
  verified_by INT NULL, -- admin user_id
  verified_by_username VARCHAR(100) NULL,
  verified_at TIMESTAMP NULL,
  verification_notes TEXT NULL,
  
  -- Rejection
  rejection_reason TEXT NULL,
  rejected_at TIMESTAMP NULL,
  can_reapply_at TIMESTAMP NULL,
  
  -- Personal Info (for compliance)
  full_name VARCHAR(255) NULL,
  date_of_birth DATE NULL,
  nationality VARCHAR(100) NULL,
  country_of_residence VARCHAR(100) NULL,
  address_line1 VARCHAR(255) NULL,
  address_line2 VARCHAR(255) NULL,
  city VARCHAR(100) NULL,
  state_province VARCHAR(100) NULL,
  postal_code VARCHAR(20) NULL,
  phone_verified BOOLEAN DEFAULT FALSE,
  email_verified BOOLEAN DEFAULT FALSE,
  
  -- Risk Assessment
  risk_score INT NULL, -- From Phase 2
  is_pep BOOLEAN DEFAULT FALSE, -- Politically Exposed Person
  is_sanctioned BOOLEAN DEFAULT FALSE,
  sanctions_list VARCHAR(255) NULL,
  
  -- Compliance Flags
  requires_enhanced_dd BOOLEAN DEFAULT FALSE, -- Enhanced Due Diligence
  aml_flagged BOOLEAN DEFAULT FALSE,
  source_of_funds_verified BOOLEAN DEFAULT FALSE,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (verified_by) REFERENCES users(id) ON DELETE SET NULL,
  
  INDEX idx_user (user_id),
  INDEX idx_current_tier (current_tier),
  INDEX idx_application_status (application_status),
  INDEX idx_applied_for_tier (applied_for_tier),
  INDEX idx_aml_flagged (aml_flagged)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================
-- 3. AML Transaction Monitoring
-- ============================================
CREATE TABLE IF NOT EXISTS aml_alerts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  
  -- Alert Identification
  alert_number VARCHAR(50) UNIQUE NOT NULL, -- e.g., "AML-2026-0001"
  alert_type ENUM(
    'rapid_movement',        -- Quick deposit→withdraw
    'structuring',           -- Breaking up transactions
    'high_volume',           -- Unusual volume
    'round_tripping',        -- Circular transactions
    'unusual_pattern',       -- Atypical behavior
    'blacklist_match',       -- Wallet/IP on blacklist
    'high_risk_jurisdiction',-- Sanctioned country
    'velocity_breach',       -- Too many transactions
    'layering_detected'      -- Complex transaction chains
  ) NOT NULL,
  
  -- User
  user_id INT NOT NULL,
  username VARCHAR(100) NOT NULL,
  
  -- Alert Details
  severity ENUM('low', 'medium', 'high', 'critical') NOT NULL,
  description TEXT NOT NULL,
  risk_score INT NOT NULL, -- Calculated risk (0-100)
  
  -- Related Transactions
  related_transaction_ids JSON NULL, -- Array of transaction IDs
  total_amount DECIMAL(20, 8) NULL,
  currency VARCHAR(10) NULL,
  time_window_hours INT NULL,
  
  -- Pattern Details
  pattern_data JSON NULL, -- Structured data about the pattern
  
  -- Status
  status ENUM('new', 'investigating', 'escalated', 'resolved', 'false_positive') NOT NULL DEFAULT 'new',
  
  -- Investigation
  assigned_to INT NULL, -- compliance officer user_id
  assigned_to_username VARCHAR(100) NULL,
  assigned_at TIMESTAMP NULL,
  
  investigation_notes TEXT NULL,
  resolution TEXT NULL,
  
  -- Actions Taken
  actions_taken JSON NULL, -- ["account_frozen", "withdrawal_blocked", "reported_to_authorities"]
  
  -- SAR Filing (Suspicious Activity Report)
  sar_filed BOOLEAN DEFAULT FALSE,
  sar_number VARCHAR(100) NULL,
  sar_filed_at TIMESTAMP NULL,
  sar_filed_by INT NULL,
  
  -- Timestamps
  detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL,
  
  INDEX idx_user (user_id),
  INDEX idx_alert_type (alert_type),
  INDEX idx_severity (severity),
  INDEX idx_status (status),
  INDEX idx_detected_at (detected_at),
  INDEX idx_sar_filed (sar_filed)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================
-- 4. Transaction Monitoring Rules
-- ============================================
CREATE TABLE IF NOT EXISTS aml_rules (
  id INT AUTO_INCREMENT PRIMARY KEY,
  
  rule_name VARCHAR(100) NOT NULL,
  rule_type VARCHAR(50) NOT NULL, -- 'velocity', 'amount', 'pattern', 'geolocation'
  
  -- Rule Parameters
  threshold_value DECIMAL(20, 8) NULL,
  time_window_hours INT NULL,
  transaction_count INT NULL,
  
  -- Conditions
  conditions JSON NOT NULL, -- {"min_amount": 1000, "max_time_hours": 1}
  
  -- Action
  alert_severity ENUM('low', 'medium', 'high', 'critical') NOT NULL,
  auto_block BOOLEAN DEFAULT FALSE,
  auto_flag BOOLEAN DEFAULT TRUE,
  
  -- Status
  is_active BOOLEAN DEFAULT TRUE,
  
  -- Metadata
  description TEXT NULL,
  created_by INT NULL,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  INDEX idx_rule_type (rule_type),
  INDEX idx_is_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Insert default AML rules
INSERT INTO aml_rules (rule_name, rule_type, threshold_value, time_window_hours, transaction_count, conditions, alert_severity, auto_block, auto_flag, description) VALUES
('Rapid Deposit-Withdraw', 'velocity', 1000, 1, NULL, '{"min_amount": 100, "max_time_between_minutes": 30}', 'high', FALSE, TRUE, 'Detect quick deposit followed by withdrawal within 30 minutes'),
('High Volume 24h', 'amount', 10000, 24, NULL, '{"total_deposits": 10000}', 'medium', FALSE, TRUE, 'Total deposits exceed $10k in 24 hours'),
('Structuring Pattern', 'pattern', 9999, 24, 10, '{"similar_amounts": true, "below_threshold": 10000}', 'high', FALSE, TRUE, 'Multiple transactions just below $10k threshold'),
('Excessive Velocity', 'velocity', NULL, 1, 20, '{"transaction_count": 20}', 'medium', FALSE, TRUE, 'More than 20 transactions in 1 hour'),
('Round Tripping', 'pattern', 500, 48, NULL, '{"same_addresses": true, "circular": true}', 'critical', TRUE, TRUE, 'Funds moving in circular pattern'),
('Sanctioned Country', 'geolocation', NULL, NULL, NULL, '{"blocked_countries": ["KP", "IR", "SY"]}', 'critical', TRUE, TRUE, 'Transaction from sanctioned jurisdiction')
ON DUPLICATE KEY UPDATE rule_name = VALUES(rule_name);


-- ============================================
-- 5. Source of Funds Documentation
-- ============================================
CREATE TABLE IF NOT EXISTS source_of_funds (
  id INT AUTO_INCREMENT PRIMARY KEY,
  
  user_id INT NOT NULL,
  username VARCHAR(100) NOT NULL,
  
  -- Source Details
  source_type ENUM(
    'employment',
    'business_income',
    'savings',
    'investment_returns',
    'inheritance',
    'gift',
    'crypto_mining',
    'other'
  ) NOT NULL,
  
  description TEXT NOT NULL,
  estimated_annual_income DECIMAL(20, 8) NULL,
  
  -- Documentation
  documents JSON NULL, -- Array of document IDs/URLs
  supporting_evidence TEXT NULL,
  
  -- Verification
  status ENUM('pending', 'verified', 'rejected', 'requires_more_info') NOT NULL DEFAULT 'pending',
  verified_by INT NULL,
  verified_by_username VARCHAR(100) NULL,
  verified_at TIMESTAMP NULL,
  verification_notes TEXT NULL,
  
  -- Timestamps
  submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (verified_by) REFERENCES users(id) ON DELETE SET NULL,
  
  INDEX idx_user (user_id),
  INDEX idx_status (status),
  INDEX idx_source_type (source_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================
-- 6. Compliance Actions Log
-- ============================================
CREATE TABLE IF NOT EXISTS compliance_actions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  
  user_id INT NOT NULL,
  username VARCHAR(100) NOT NULL,
  
  action_type ENUM(
    'kyc_upgraded',
    'kyc_downgraded',
    'account_frozen',
    'account_unfrozen',
    'withdrawals_blocked',
    'withdrawals_unblocked',
    'aml_alert_created',
    'sar_filed',
    'enhanced_dd_required',
    'limits_adjusted',
    'account_closed'
  ) NOT NULL,
  
  -- Action Details
  reason TEXT NOT NULL,
  details JSON NULL,
  
  -- Compliance Officer
  officer_id INT NOT NULL,
  officer_username VARCHAR(100) NOT NULL,
  
  -- References
  related_alert_id INT NULL,
  related_kyc_id INT NULL,
  
  -- Metadata
  ip_address VARCHAR(45) NULL,
  user_agent TEXT NULL,
  
  -- Timestamp
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (officer_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (related_alert_id) REFERENCES aml_alerts(id) ON DELETE SET NULL,
  
  INDEX idx_user (user_id),
  INDEX idx_action_type (action_type),
  INDEX idx_officer (officer_id),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================
-- 7. Views for Quick Access
-- ============================================

-- Pending KYC Applications
CREATE OR REPLACE VIEW v_pending_kyc AS
SELECT 
  uks.*,
  kt.tier_name AS applied_tier_name,
  TIMESTAMPDIFF(HOUR, uks.applied_at, NOW()) AS hours_pending
FROM user_kyc_status uks
JOIN kyc_tiers kt ON uks.applied_for_tier = kt.tier_level
WHERE uks.application_status IN ('pending', 'under_review')
ORDER BY 
  uks.applied_for_tier DESC,
  uks.applied_at ASC;


-- Active AML Alerts
CREATE OR REPLACE VIEW v_active_aml_alerts AS
SELECT 
  aa.*,
  uks.current_tier,
  uks.is_pep,
  uks.is_sanctioned,
  TIMESTAMPDIFF(HOUR, aa.detected_at, NOW()) AS hours_open
FROM aml_alerts aa
LEFT JOIN user_kyc_status uks ON aa.user_id = uks.user_id
WHERE aa.status IN ('new', 'investigating', 'escalated')
ORDER BY 
  CASE aa.severity
    WHEN 'critical' THEN 1
    WHEN 'high' THEN 2
    WHEN 'medium' THEN 3
    WHEN 'low' THEN 4
  END,
  aa.detected_at ASC;


-- High Risk Users (Compliance View)
CREATE OR REPLACE VIEW v_high_risk_users_compliance AS
SELECT 
  u.id,
  u.username,
  u.email,
  uks.current_tier,
  uks.is_pep,
  uks.is_sanctioned,
  uks.aml_flagged,
  uks.risk_score,
  COUNT(DISTINCT aa.id) AS active_alerts,
  SUM(CASE WHEN aa.severity = 'critical' THEN 1 ELSE 0 END) AS critical_alerts,
  MAX(aa.detected_at) AS last_alert_date
FROM users u
LEFT JOIN user_kyc_status uks ON u.id = uks.user_id
LEFT JOIN aml_alerts aa ON u.id = aa.user_id AND aa.status IN ('new', 'investigating', 'escalated')
WHERE uks.aml_flagged = TRUE 
   OR uks.is_pep = TRUE 
   OR uks.is_sanctioned = TRUE
   OR uks.requires_enhanced_dd = TRUE
GROUP BY u.id
ORDER BY critical_alerts DESC, active_alerts DESC;


-- KYC Tier Distribution
CREATE OR REPLACE VIEW v_kyc_tier_distribution AS
SELECT 
  kt.tier_level,
  kt.tier_name,
  COUNT(uks.user_id) AS user_count,
  SUM(CASE WHEN uks.application_status = 'pending' THEN 1 ELSE 0 END) AS pending_upgrades
FROM kyc_tiers kt
LEFT JOIN user_kyc_status uks ON kt.tier_level = uks.current_tier
GROUP BY kt.tier_level, kt.tier_name
ORDER BY kt.tier_level;


-- Compliance Statistics
CREATE OR REPLACE VIEW v_compliance_stats AS
SELECT 
  (SELECT COUNT(*) FROM user_kyc_status WHERE application_status = 'pending') AS pending_kyc,
  (SELECT COUNT(*) FROM aml_alerts WHERE status IN ('new', 'investigating')) AS active_alerts,
  (SELECT COUNT(*) FROM aml_alerts WHERE severity = 'critical' AND status IN ('new', 'investigating')) AS critical_alerts,
  (SELECT COUNT(*) FROM user_kyc_status WHERE is_pep = TRUE) AS pep_count,
  (SELECT COUNT(*) FROM user_kyc_status WHERE is_sanctioned = TRUE) AS sanctioned_count,
  (SELECT COUNT(*) FROM aml_alerts WHERE sar_filed = TRUE) AS total_sars,
  (SELECT COUNT(*) FROM source_of_funds WHERE status = 'pending') AS pending_sof;


-- ============================================
-- Schema Complete
-- ============================================
