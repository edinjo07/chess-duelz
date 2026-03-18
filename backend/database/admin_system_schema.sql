-- Admin System Tables - RBAC, Audit Logs, and Security

-- Admin roles and permissions table
CREATE TABLE IF NOT EXISTS admin_roles (
  id INT PRIMARY KEY AUTO_INCREMENT,
  role_name VARCHAR(50) NOT NULL UNIQUE,
  description TEXT,
  permissions JSON NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_role_name (role_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- User admin role assignments
CREATE TABLE IF NOT EXISTS user_admin_roles (
  id INT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL,
  role_id INT NOT NULL,
  assigned_by INT,
  assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NULL,
  is_active BOOLEAN DEFAULT TRUE,
  UNIQUE KEY unique_user_role (user_id, role_id),
  FOREIGN KEY (role_id) REFERENCES admin_roles(id) ON DELETE CASCADE,
  INDEX idx_user_id (user_id),
  INDEX idx_role_id (role_id),
  INDEX idx_is_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Enhanced admin audit logs with more detail
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL,
  username VARCHAR(50) NOT NULL,
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(50),
  resource_id VARCHAR(100),
  old_value TEXT,
  new_value TEXT,
  details JSON,
  ip_address VARCHAR(45),
  user_agent TEXT,
  status ENUM('success', 'failed', 'pending') DEFAULT 'success',
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_id (user_id),
  INDEX idx_action (action),
  INDEX idx_resource (resource_type, resource_id),
  INDEX idx_created_at (created_at),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Admin sessions table for better security
CREATE TABLE IF NOT EXISTS admin_sessions (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL,
  session_token VARCHAR(255) NOT NULL UNIQUE,
  refresh_token VARCHAR(255) UNIQUE,
  ip_address VARCHAR(45),
  user_agent TEXT,
  last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  requires_2fa BOOLEAN DEFAULT FALSE,
  two_fa_verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_id (user_id),
  INDEX idx_session_token (session_token),
  INDEX idx_is_active (is_active),
  INDEX idx_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Balance adjustment ledger (critical for money system)
CREATE TABLE IF NOT EXISTS balance_adjustments (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL,
  admin_id INT NOT NULL,
  adjustment_type ENUM('admin_credit', 'admin_debit', 'correction', 'bonus', 'penalty', 'refund', 'chargeback') NOT NULL,
  amount DECIMAL(20, 8) NOT NULL,
  currency VARCHAR(10) NOT NULL,
  balance_before DECIMAL(20, 8) NOT NULL,
  balance_after DECIMAL(20, 8) NOT NULL,
  reason TEXT NOT NULL,
  ticket_reference VARCHAR(100),
  admin_notes TEXT,
  approval_status ENUM('pending', 'approved', 'rejected') DEFAULT 'approved',
  approved_by INT,
  approved_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_id (user_id),
  INDEX idx_admin_id (admin_id),
  INDEX idx_adjustment_type (adjustment_type),
  INDEX idx_created_at (created_at),
  INDEX idx_approval_status (approval_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Security events log
CREATE TABLE IF NOT EXISTS security_events (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  event_type ENUM('login_success', 'login_failed', 'password_change', 'email_change', 'admin_access_denied', 'suspicious_activity', 'account_locked', 'account_unlocked', 'withdrawal_blocked', 'large_transaction') NOT NULL,
  user_id INT,
  username VARCHAR(50),
  severity ENUM('low', 'medium', 'high', 'critical') DEFAULT 'medium',
  description TEXT NOT NULL,
  ip_address VARCHAR(45),
  user_agent TEXT,
  metadata JSON,
  resolved BOOLEAN DEFAULT FALSE,
  resolved_by INT,
  resolved_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_event_type (event_type),
  INDEX idx_user_id (user_id),
  INDEX idx_severity (severity),
  INDEX idx_resolved (resolved),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insert default admin roles
INSERT INTO admin_roles (role_name, description, permissions) VALUES
('super_admin', 'Full system access with all permissions', JSON_ARRAY(
  'users.view', 'users.edit', 'users.delete', 'users.ban',
  'withdrawals.view', 'withdrawals.approve', 'withdrawals.reject', 'withdrawals.send',
  'deposits.view', 'deposits.edit',
  'kyc.view', 'kyc.approve', 'kyc.reject',
  'support.view', 'support.respond', 'support.assign', 'support.close',
  'admin.manage', 'admin.create', 'admin.revoke',
  'audit.view', 'audit.export',
  'balance.adjust', 'balance.view',
  'games.view', 'games.manage',
  'reports.view', 'reports.export',
  'settings.view', 'settings.edit'
)),
('finance', 'Manage deposits, withdrawals, and balance adjustments', JSON_ARRAY(
  'users.view', 'users.edit',
  'withdrawals.view', 'withdrawals.approve', 'withdrawals.reject', 'withdrawals.send',
  'deposits.view', 'deposits.edit',
  'balance.adjust', 'balance.view',
  'reports.view', 'reports.export'
)),
('kyc_officer', 'Review and approve KYC documents', JSON_ARRAY(
  'users.view',
  'kyc.view', 'kyc.approve', 'kyc.reject',
  'audit.view'
)),
('support', 'Handle customer support tickets', JSON_ARRAY(
  'users.view',
  'support.view', 'support.respond', 'support.assign', 'support.close',
  'audit.view'
)),
('operations', 'General operations and monitoring', JSON_ARRAY(
  'users.view',
  'withdrawals.view', 'deposits.view',
  'kyc.view',
  'support.view',
  'games.view',
  'reports.view',
  'audit.view'
))
ON DUPLICATE KEY UPDATE
  description = VALUES(description),
  permissions = VALUES(permissions);
