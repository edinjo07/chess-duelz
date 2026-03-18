-- KYC Verification System Database Schema

-- Create KYC documents table
CREATE TABLE IF NOT EXISTS kyc_documents (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  document_type ENUM('proof_of_id', 'proof_of_address', 'other') NOT NULL,
  document_subtype VARCHAR(50) DEFAULT NULL COMMENT 'e.g., passport, drivers_license, national_id, utility_bill, bank_statement',
  document_side ENUM('front', 'back', 'single') DEFAULT 'single' COMMENT 'For ID/DL: front and back required',
  file_path VARCHAR(500) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  file_size INT NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
  reviewed_by INT DEFAULT NULL COMMENT 'Admin user ID who reviewed',
  reviewed_at TIMESTAMP NULL DEFAULT NULL,
  rejection_reason TEXT DEFAULT NULL,
  uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user_id (user_id),
  INDEX idx_status (status),
  INDEX idx_document_type (document_type),
  INDEX idx_uploaded_at (uploaded_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Create KYC status table
CREATE TABLE IF NOT EXISTS kyc_status (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL UNIQUE,
  overall_status ENUM('not_started', 'pending', 'approved', 'rejected') DEFAULT 'not_started',
  proof_of_id_status ENUM('not_submitted', 'pending', 'approved', 'rejected') DEFAULT 'not_submitted',
  proof_of_address_status ENUM('not_submitted', 'pending', 'approved', 'rejected') DEFAULT 'not_submitted',
  submission_date TIMESTAMP NULL DEFAULT NULL,
  approval_date TIMESTAMP NULL DEFAULT NULL,
  rejection_date TIMESTAMP NULL DEFAULT NULL,
  rejection_reason TEXT DEFAULT NULL,
  notes TEXT DEFAULT NULL COMMENT 'Admin notes about the verification',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_overall_status (overall_status),
  INDEX idx_submission_date (submission_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Create KYC verification log for audit trail
CREATE TABLE IF NOT EXISTS kyc_verification_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  action ENUM('document_uploaded', 'document_approved', 'document_rejected', 'status_changed', 'admin_note_added') NOT NULL,
  document_id INT DEFAULT NULL,
  admin_id INT DEFAULT NULL,
  old_status VARCHAR(50) DEFAULT NULL,
  new_status VARCHAR(50) DEFAULT NULL,
  reason TEXT DEFAULT NULL,
  metadata JSON DEFAULT NULL,
  ip_address VARCHAR(45) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (document_id) REFERENCES kyc_documents(id) ON DELETE SET NULL,
  INDEX idx_user_id (user_id),
  INDEX idx_action (action),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Add KYC-related columns to users table (if not exists)
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_status ENUM('not_started', 'pending', 'approved', 'rejected') DEFAULT 'not_started';
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_submitted_at TIMESTAMP NULL DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_approved_at TIMESTAMP NULL DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name VARCHAR(100) DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name VARCHAR(100) DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth DATE DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS address_line1 VARCHAR(255) DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS address_line2 VARCHAR(255) DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS city VARCHAR(100) DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS state_province VARCHAR(100) DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS postal_code VARCHAR(20) DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS country VARCHAR(100) DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS nationality VARCHAR(100) DEFAULT NULL;

-- Add indexes for KYC status
ALTER TABLE users ADD INDEX IF NOT EXISTS idx_kyc_status (kyc_status);
