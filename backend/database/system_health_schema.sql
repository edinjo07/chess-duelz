-- ============================================
-- Phase 5: System Health & Monitoring Schema
-- Error logs, performance metrics, system alerts, configuration
-- ============================================

-- ============================================
-- 1. System Error Logs
-- Centralized error logging with categorization
-- ============================================
CREATE TABLE IF NOT EXISTS system_error_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  
  -- Error Identification
  error_code VARCHAR(50) NULL,
  error_level ENUM('debug', 'info', 'warning', 'error', 'critical', 'fatal') NOT NULL,
  
  -- Error Details
  error_message TEXT NOT NULL,
  error_type VARCHAR(100) NULL, -- 'DatabaseError', 'ValidationError', 'AuthError', etc.
  stack_trace TEXT NULL,
  
  -- Context
  endpoint VARCHAR(255) NULL,
  method VARCHAR(10) NULL, -- GET, POST, PUT, DELETE
  user_id INT NULL,
  username VARCHAR(100) NULL,
  
  -- Request Details
  request_body TEXT NULL,
  request_params TEXT NULL,
  request_headers TEXT NULL,
  
  -- System State
  node_version VARCHAR(50) NULL,
  memory_usage JSON NULL, -- {heapUsed, heapTotal, external, rss}
  cpu_usage DECIMAL(5, 2) NULL,
  
  -- Metadata
  ip_address VARCHAR(45) NULL,
  user_agent TEXT NULL,
  
  -- Resolution
  status ENUM('new', 'investigating', 'resolved', 'ignored') DEFAULT 'new',
  resolved_by INT NULL,
  resolved_at TIMESTAMP NULL,
  resolution_notes TEXT NULL,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_error_level (error_level),
  INDEX idx_status (status),
  INDEX idx_endpoint (endpoint),
  INDEX idx_user_id (user_id),
  INDEX idx_created_at (created_at),
  INDEX idx_error_type (error_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================
-- 2. Performance Metrics
-- Track API endpoint performance and system metrics
-- ============================================
CREATE TABLE IF NOT EXISTS performance_metrics (
  id INT AUTO_INCREMENT PRIMARY KEY,
  
  -- Endpoint Info
  endpoint VARCHAR(255) NOT NULL,
  method VARCHAR(10) NOT NULL,
  
  -- Performance
  response_time_ms INT NOT NULL, -- milliseconds
  status_code INT NOT NULL,
  
  -- User Context
  user_id INT NULL,
  username VARCHAR(100) NULL,
  is_admin BOOLEAN DEFAULT FALSE,
  
  -- System Metrics (at time of request)
  memory_heap_used INT NULL, -- bytes
  memory_heap_total INT NULL,
  cpu_usage DECIMAL(5, 2) NULL,
  
  -- Request Size
  request_size INT NULL, -- bytes
  response_size INT NULL, -- bytes
  
  -- Database Performance
  db_query_count INT NULL,
  db_query_time_ms INT NULL,
  
  -- Timestamp
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_endpoint (endpoint),
  INDEX idx_method (method),
  INDEX idx_response_time (response_time_ms),
  INDEX idx_status_code (status_code),
  INDEX idx_created_at (created_at),
  INDEX idx_endpoint_created (endpoint, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================
-- 3. System Alerts
-- Real-time system alerts and notifications
-- ============================================
CREATE TABLE IF NOT EXISTS system_alerts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  
  -- Alert Identification
  alert_type ENUM(
    'high_error_rate',
    'slow_response_time',
    'memory_threshold',
    'cpu_threshold',
    'database_connection',
    'disk_space',
    'failed_payments',
    'suspicious_activity',
    'service_down',
    'deployment_issue',
    'custom'
  ) NOT NULL,
  
  severity ENUM('low', 'medium', 'high', 'critical') NOT NULL,
  
  -- Alert Details
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  metric_value DECIMAL(20, 8) NULL, -- e.g., 85.5% CPU usage
  threshold_value DECIMAL(20, 8) NULL, -- e.g., 80% threshold
  
  -- Context
  affected_service VARCHAR(100) NULL, -- 'api', 'database', 'payment_gateway', etc.
  affected_endpoint VARCHAR(255) NULL,
  error_count INT NULL,
  
  -- Related Data
  related_error_ids JSON NULL, -- Array of error log IDs
  related_metric_ids JSON NULL,
  additional_data JSON NULL,
  
  -- Status
  status ENUM('active', 'acknowledged', 'resolved', 'muted') DEFAULT 'active',
  
  -- Acknowledgment
  acknowledged_by INT NULL,
  acknowledged_by_username VARCHAR(100) NULL,
  acknowledged_at TIMESTAMP NULL,
  
  -- Resolution
  resolved_by INT NULL,
  resolved_by_username VARCHAR(100) NULL,
  resolved_at TIMESTAMP NULL,
  resolution_notes TEXT NULL,
  
  -- Auto-resolution
  auto_resolved BOOLEAN DEFAULT FALSE,
  
  -- Timestamps
  triggered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_occurrence TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  occurrence_count INT DEFAULT 1,
  
  FOREIGN KEY (acknowledged_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL,
  
  INDEX idx_alert_type (alert_type),
  INDEX idx_severity (severity),
  INDEX idx_status (status),
  INDEX idx_triggered_at (triggered_at),
  INDEX idx_affected_service (affected_service)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================
-- 4. Alert Rules
-- Configure when alerts should be triggered
-- ============================================
CREATE TABLE IF NOT EXISTS alert_rules (
  id INT AUTO_INCREMENT PRIMARY KEY,
  
  rule_name VARCHAR(100) NOT NULL,
  alert_type VARCHAR(50) NOT NULL,
  
  -- Threshold Configuration
  metric_name VARCHAR(100) NOT NULL, -- 'error_rate', 'response_time', 'cpu_usage', etc.
  threshold_value DECIMAL(20, 8) NOT NULL,
  threshold_operator ENUM('>', '<', '>=', '<=', '=', '!=') DEFAULT '>',
  time_window_minutes INT NOT NULL DEFAULT 5, -- Check over last N minutes
  
  -- Alert Behavior
  severity ENUM('low', 'medium', 'high', 'critical') NOT NULL,
  cooldown_minutes INT DEFAULT 60, -- Don't re-alert for N minutes
  
  -- Notification
  notify_channels JSON NULL, -- ['email', 'slack', 'dashboard']
  notify_users JSON NULL, -- Array of user IDs to notify
  
  -- Conditions
  conditions JSON NULL, -- Additional conditions for complex rules
  
  -- Status
  is_active BOOLEAN DEFAULT TRUE,
  
  -- Metadata
  description TEXT NULL,
  created_by INT NULL,
  last_triggered TIMESTAMP NULL,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  INDEX idx_alert_type (alert_type),
  INDEX idx_is_active (is_active),
  INDEX idx_metric_name (metric_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Insert default alert rules
INSERT INTO alert_rules (rule_name, alert_type, metric_name, threshold_value, threshold_operator, time_window_minutes, severity, cooldown_minutes, description) VALUES
('High Error Rate', 'high_error_rate', 'error_count', 50, '>', 5, 'high', 30, 'Alert when more than 50 errors occur in 5 minutes'),
('Critical Error Rate', 'high_error_rate', 'critical_error_count', 10, '>', 5, 'critical', 15, 'Alert when more than 10 critical errors in 5 minutes'),
('Slow API Response', 'slow_response_time', 'avg_response_time', 5000, '>', 5, 'medium', 60, 'Alert when average response time exceeds 5 seconds'),
('Memory Usage High', 'memory_threshold', 'memory_usage_percent', 85, '>', 5, 'high', 120, 'Alert when memory usage exceeds 85%'),
('CPU Usage High', 'cpu_threshold', 'cpu_usage_percent', 80, '>', 5, 'high', 120, 'Alert when CPU usage exceeds 80%'),
('Failed Payment Spike', 'failed_payments', 'failed_payment_count', 10, '>', 15, 'high', 60, 'Alert when more than 10 payments fail in 15 minutes')
ON DUPLICATE KEY UPDATE rule_name = VALUES(rule_name);


-- ============================================
-- 5. System Configuration
-- Dynamic configuration values for admin control
-- ============================================
CREATE TABLE IF NOT EXISTS system_config (
  id INT AUTO_INCREMENT PRIMARY KEY,
  
  config_key VARCHAR(100) UNIQUE NOT NULL,
  config_value TEXT NOT NULL,
  value_type ENUM('string', 'number', 'boolean', 'json') NOT NULL,
  
  -- Organization
  category VARCHAR(50) NOT NULL, -- 'general', 'security', 'payments', 'limits', 'features'
  subcategory VARCHAR(50) NULL,
  
  -- Metadata
  description TEXT NULL,
  default_value TEXT NULL,
  allowed_values JSON NULL, -- For enum-like configs
  
  -- Validation
  min_value DECIMAL(20, 8) NULL,
  max_value DECIMAL(20, 8) NULL,
  regex_pattern VARCHAR(255) NULL,
  
  -- Status
  is_sensitive BOOLEAN DEFAULT FALSE, -- Mask value in logs
  requires_restart BOOLEAN DEFAULT FALSE,
  is_editable BOOLEAN DEFAULT TRUE,
  
  -- Change Tracking
  updated_by INT NULL,
  updated_by_username VARCHAR(100) NULL,
  updated_at TIMESTAMP NULL,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
  
  INDEX idx_category (category),
  INDEX idx_config_key (config_key),
  INDEX idx_is_editable (is_editable)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Insert default system configurations
INSERT INTO system_config (config_key, config_value, value_type, category, subcategory, description, default_value, is_editable) VALUES
('site.maintenance_mode', 'false', 'boolean', 'general', 'status', 'Enable maintenance mode to prevent user access', 'false', TRUE),
('site.maintenance_message', 'System is under maintenance. Please try again later.', 'string', 'general', 'status', 'Message shown during maintenance', 'System is under maintenance.', TRUE),
('security.max_login_attempts', '5', 'number', 'security', 'authentication', 'Maximum failed login attempts before lockout', '5', TRUE),
('security.lockout_duration_minutes', '30', 'number', 'security', 'authentication', 'Account lockout duration in minutes', '30', TRUE),
('security.session_timeout_hours', '24', 'number', 'security', 'sessions', 'User session timeout in hours', '24', TRUE),
('security.require_2fa_for_withdrawals', 'false', 'boolean', 'security', 'withdrawals', 'Require 2FA for all withdrawals', 'false', TRUE),
('payments.min_deposit_usd', '10', 'number', 'payments', 'deposits', 'Minimum deposit amount in USD', '10', TRUE),
('payments.max_deposit_usd', '50000', 'number', 'payments', 'deposits', 'Maximum single deposit amount in USD', '50000', TRUE),
('payments.min_withdrawal_usd', '20', 'number', 'payments', 'withdrawals', 'Minimum withdrawal amount in USD', '20', TRUE),
('payments.max_withdrawal_usd', '25000', 'number', 'payments', 'withdrawals', 'Maximum single withdrawal amount in USD', '25000', TRUE),
('payments.withdrawal_fee_percent', '0', 'number', 'payments', 'withdrawals', 'Withdrawal fee percentage', '0', TRUE),
('limits.max_active_games_per_user', '3', 'number', 'limits', 'games', 'Maximum active games per user', '3', TRUE),
('limits.min_bet_amount', '1', 'number', 'limits', 'games', 'Minimum bet amount', '1', TRUE),
('limits.max_bet_amount', '10000', 'number', 'limits', 'games', 'Maximum bet amount', '10000', TRUE),
('features.chat_enabled', 'true', 'boolean', 'features', 'social', 'Enable chat feature', 'true', TRUE),
('features.tournaments_enabled', 'true', 'boolean', 'features', 'games', 'Enable tournament mode', 'true', TRUE),
('features.pvp_enabled', 'true', 'boolean', 'features', 'games', 'Enable PvP games', 'true', TRUE),
('features.bot_games_enabled', 'true', 'boolean', 'features', 'games', 'Enable bot games', 'true', TRUE),
('monitoring.log_retention_days', '90', 'number', 'monitoring', 'logs', 'Days to retain error logs', '90', TRUE),
('monitoring.metrics_retention_days', '30', 'number', 'monitoring', 'metrics', 'Days to retain performance metrics', '30', TRUE)
ON DUPLICATE KEY UPDATE description = VALUES(description);


-- ============================================
-- 6. Scheduled Tasks Status
-- Track background jobs and cron tasks
-- ============================================
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  
  task_name VARCHAR(100) UNIQUE NOT NULL,
  task_type ENUM('cleanup', 'reconciliation', 'report', 'backup', 'notification', 'monitoring', 'custom') NOT NULL,
  
  -- Schedule
  schedule_cron VARCHAR(100) NULL, -- Cron expression
  schedule_interval_minutes INT NULL, -- Or simple interval
  
  -- Status
  is_enabled BOOLEAN DEFAULT TRUE,
  status ENUM('idle', 'running', 'failed', 'disabled') DEFAULT 'idle',
  
  -- Execution Stats
  last_run_at TIMESTAMP NULL,
  last_run_duration_ms INT NULL,
  last_run_status ENUM('success', 'failed', 'partial') NULL,
  last_run_error TEXT NULL,
  
  next_run_at TIMESTAMP NULL,
  
  -- History Stats
  total_runs INT DEFAULT 0,
  successful_runs INT DEFAULT 0,
  failed_runs INT DEFAULT 0,
  avg_duration_ms INT NULL,
  
  -- Configuration
  config JSON NULL, -- Task-specific configuration
  
  -- Metadata
  description TEXT NULL,
  created_by INT NULL,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  INDEX idx_task_name (task_name),
  INDEX idx_is_enabled (is_enabled),
  INDEX idx_status (status),
  INDEX idx_next_run_at (next_run_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Insert default scheduled tasks
INSERT INTO scheduled_tasks (task_name, task_type, schedule_interval_minutes, description, is_enabled) VALUES
('cleanup_old_sessions', 'cleanup', 1440, 'Remove expired user sessions', TRUE),
('cleanup_old_logs', 'cleanup', 1440, 'Archive old error logs', TRUE),
('cleanup_old_metrics', 'cleanup', 1440, 'Archive old performance metrics', TRUE),
('deposit_reconciliation', 'reconciliation', 60, 'Reconcile pending deposits with payment gateway', TRUE),
('withdrawal_processing', 'reconciliation', 30, 'Process pending withdrawals', TRUE),
('balance_snapshot', 'backup', 360, 'Create balance snapshots for audit', TRUE),
('daily_compliance_report', 'report', 1440, 'Generate daily compliance report', TRUE),
('system_health_check', 'monitoring', 5, 'Check system health metrics', TRUE)
ON DUPLICATE KEY UPDATE description = VALUES(description);


-- ============================================
-- 7. Views for Monitoring Dashboard
-- ============================================

-- Recent Critical Errors
CREATE OR REPLACE VIEW v_recent_critical_errors AS
SELECT 
  id,
  error_level,
  error_type,
  error_message,
  endpoint,
  method,
  user_id,
  username,
  status,
  created_at,
  TIMESTAMPDIFF(MINUTE, created_at, NOW()) AS minutes_ago
FROM system_error_logs
WHERE error_level IN ('critical', 'fatal', 'error')
  AND created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
  AND status = 'new'
ORDER BY created_at DESC
LIMIT 50;


-- Active System Alerts
CREATE OR REPLACE VIEW v_active_system_alerts AS
SELECT 
  sa.*,
  TIMESTAMPDIFF(MINUTE, sa.triggered_at, NOW()) AS minutes_active
FROM system_alerts sa
WHERE sa.status IN ('active', 'acknowledged')
ORDER BY 
  CASE sa.severity
    WHEN 'critical' THEN 1
    WHEN 'high' THEN 2
    WHEN 'medium' THEN 3
    WHEN 'low' THEN 4
  END,
  sa.triggered_at DESC;


-- Slow Endpoints (Last Hour)
CREATE OR REPLACE VIEW v_slow_endpoints AS
SELECT 
  endpoint,
  method,
  COUNT(*) AS request_count,
  AVG(response_time_ms) AS avg_response_ms,
  MAX(response_time_ms) AS max_response_ms,
  MIN(response_time_ms) AS min_response_ms
FROM performance_metrics
WHERE created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
GROUP BY endpoint, method
HAVING avg_response_ms > 2000
ORDER BY avg_response_ms DESC
LIMIT 20;


-- Error Rate by Endpoint (Last Hour)
CREATE OR REPLACE VIEW v_error_rate_by_endpoint AS
SELECT 
  endpoint,
  COUNT(*) AS total_requests,
  SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) AS server_errors,
  SUM(CASE WHEN status_code >= 400 AND status_code < 500 THEN 1 ELSE 0 END) AS client_errors,
  ROUND(SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) AS error_rate_percent
FROM performance_metrics
WHERE created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
GROUP BY endpoint
HAVING error_rate_percent > 5
ORDER BY error_rate_percent DESC, total_requests DESC
LIMIT 20;


-- System Health Dashboard
CREATE OR REPLACE VIEW v_system_health_dashboard AS
SELECT 
  (SELECT COUNT(*) FROM system_error_logs WHERE error_level IN ('critical', 'fatal', 'error') AND created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)) AS critical_errors_1h,
  (SELECT COUNT(*) FROM system_alerts WHERE status IN ('active', 'acknowledged') AND severity = 'critical') AS active_critical_alerts,
  (SELECT AVG(response_time_ms) FROM performance_metrics WHERE created_at >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)) AS avg_response_time_5m,
  (SELECT COUNT(*) FROM performance_metrics WHERE created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR) AND status_code >= 500) AS server_errors_1h,
  (SELECT COUNT(*) FROM scheduled_tasks WHERE status = 'failed') AS failed_tasks,
  (SELECT COUNT(*) FROM scheduled_tasks WHERE status = 'running') AS running_tasks,
  (SELECT COUNT(*) FROM users WHERE last_login >= DATE_SUB(NOW(), INTERVAL 1 HOUR)) AS active_users_1h;


-- ============================================
-- Schema Complete
-- ============================================
