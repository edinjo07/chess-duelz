-- Responsible Gaming Tables
-- Store deposit limits and self-exclusion data

CREATE TABLE IF NOT EXISTS responsible_gaming_limits (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  daily_limit DECIMAL(10, 2) DEFAULT NULL,
  weekly_limit DECIMAL(10, 2) DEFAULT NULL,
  monthly_limit DECIMAL(10, 2) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY unique_user_limits (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS self_exclusions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  exclusion_type ENUM('temporary', 'permanent') NOT NULL,
  excluded_until DATETIME DEFAULT NULL,
  reason TEXT DEFAULT NULL,
  status ENUM('active', 'expired', 'lifted') DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  lifted_at DATETIME DEFAULT NULL,
  lifted_by INT DEFAULT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user_status (user_id, status),
  INDEX idx_excluded_until (excluded_until)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS deposit_tracking (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  deposit_date DATE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user_date (user_id, deposit_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
