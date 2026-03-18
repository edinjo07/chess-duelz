-- ============================================
-- Phase 3: Game Integrity Schema
-- Database tables for game sessions, disputes, and provably fair verification
-- ============================================

-- ============================================
-- 1. Game Sessions Table
-- Tracks every chess game played (PvP and vs Bot)
-- ============================================
CREATE TABLE IF NOT EXISTS game_sessions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  
  -- Game Identification
  game_id VARCHAR(100) UNIQUE NOT NULL,
  game_type ENUM('pvp', 'bot', 'tournament') NOT NULL DEFAULT 'pvp',
  
  -- Players
  player1_id INT NOT NULL,
  player2_id INT NULL, -- NULL for bot games
  player1_username VARCHAR(100) NOT NULL,
  player2_username VARCHAR(100) NULL,
  player1_color ENUM('white', 'black') NOT NULL,
  
  -- Game Financial Info
  bet_amount DECIMAL(20, 8) NOT NULL DEFAULT 0,
  currency VARCHAR(10) NOT NULL DEFAULT 'USD',
  prize_amount DECIMAL(20, 8) NOT NULL DEFAULT 0,
  platform_fee DECIMAL(20, 8) NOT NULL DEFAULT 0,
  
  -- Game State
  status ENUM('waiting', 'active', 'completed', 'abandoned', 'voided', 'disputed') NOT NULL DEFAULT 'waiting',
  result ENUM('player1_win', 'player2_win', 'draw', 'abandoned', 'voided') NULL,
  winner_id INT NULL,
  winner_username VARCHAR(100) NULL,
  
  -- Game Details
  time_control VARCHAR(50) NULL, -- e.g., "10+0", "5+3"
  starting_fen TEXT NULL,
  final_fen TEXT NULL,
  pgn TEXT NULL, -- Portable Game Notation (full game moves)
  move_count INT NOT NULL DEFAULT 0,
  
  -- Provably Fair
  game_seed VARCHAR(255) NULL,
  game_hash VARCHAR(255) NULL,
  client_seed VARCHAR(255) NULL,
  server_seed VARCHAR(255) NULL,
  nonce INT NULL,
  is_verified BOOLEAN DEFAULT FALSE,
  
  -- Timing
  started_at TIMESTAMP NULL,
  ended_at TIMESTAMP NULL,
  duration_seconds INT NULL,
  
  -- Admin Actions
  is_settled BOOLEAN DEFAULT FALSE,
  settled_by INT NULL, -- admin user_id
  settled_at TIMESTAMP NULL,
  settlement_reason TEXT NULL,
  
  -- Metadata
  ip_address_player1 VARCHAR(45) NULL,
  ip_address_player2 VARCHAR(45) NULL,
  user_agent_player1 TEXT NULL,
  user_agent_player2 TEXT NULL,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  -- Foreign Keys
  FOREIGN KEY (player1_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (player2_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (winner_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (settled_by) REFERENCES users(id) ON DELETE SET NULL,
  
  -- Indexes
  INDEX idx_player1 (player1_id),
  INDEX idx_player2 (player2_id),
  INDEX idx_status (status),
  INDEX idx_game_type (game_type),
  INDEX idx_created_at (created_at),
  INDEX idx_winner (winner_id),
  INDEX idx_game_id (game_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================
-- 2. Disputes Table
-- User complaints about games
-- ============================================
CREATE TABLE IF NOT EXISTS disputes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  
  -- Dispute Identification
  dispute_number VARCHAR(50) UNIQUE NOT NULL, -- e.g., "DSP-2026-0001"
  
  -- Related Game
  game_session_id INT NOT NULL,
  game_id VARCHAR(100) NOT NULL,
  
  -- User Info
  user_id INT NOT NULL,
  username VARCHAR(100) NOT NULL,
  
  -- Dispute Details
  dispute_type ENUM(
    'unfair_result', 
    'connection_issue', 
    'bot_malfunction', 
    'stuck_game',
    'wrong_payout',
    'technical_error',
    'cheating_suspected',
    'other'
  ) NOT NULL,
  
  subject VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  
  -- Status
  status ENUM('pending', 'investigating', 'resolved', 'rejected', 'closed') NOT NULL DEFAULT 'pending',
  priority ENUM('low', 'medium', 'high', 'critical') NOT NULL DEFAULT 'medium',
  
  -- Resolution
  resolution TEXT NULL,
  resolution_type ENUM(
    'refund_issued',
    'game_voided',
    'no_action_needed',
    'technical_fix',
    'user_error',
    'closed_duplicate'
  ) NULL,
  refund_amount DECIMAL(20, 8) NULL,
  refund_issued BOOLEAN DEFAULT FALSE,
  
  -- Admin Handling
  assigned_to INT NULL, -- admin user_id
  assigned_to_username VARCHAR(100) NULL,
  resolved_by INT NULL, -- admin user_id
  resolved_by_username VARCHAR(100) NULL,
  
  -- Evidence
  attachments JSON NULL, -- Array of file paths/URLs
  admin_notes TEXT NULL,
  internal_notes TEXT NULL, -- Not visible to user
  
  -- Timestamps
  submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  assigned_at TIMESTAMP NULL,
  resolved_at TIMESTAMP NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  -- Foreign Keys
  FOREIGN KEY (game_session_id) REFERENCES game_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL,
  
  -- Indexes
  INDEX idx_user (user_id),
  INDEX idx_game_session (game_session_id),
  INDEX idx_status (status),
  INDEX idx_priority (priority),
  INDEX idx_dispute_type (dispute_type),
  INDEX idx_submitted_at (submitted_at),
  INDEX idx_dispute_number (dispute_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================
-- 3. Game Interventions Log
-- Tracks all admin actions on games (force settle, void, refund)
-- ============================================
CREATE TABLE IF NOT EXISTS game_interventions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  
  -- Intervention Details
  game_session_id INT NOT NULL,
  game_id VARCHAR(100) NOT NULL,
  
  intervention_type ENUM(
    'force_settle',
    'void_bet',
    'refund',
    'manual_payout',
    'result_override',
    'game_cancellation'
  ) NOT NULL,
  
  -- Admin Info
  admin_id INT NOT NULL,
  admin_username VARCHAR(100) NOT NULL,
  
  -- Action Details
  reason TEXT NOT NULL,
  details JSON NULL, -- Additional structured data
  
  -- Financial Impact
  player1_refund DECIMAL(20, 8) NULL,
  player2_refund DECIMAL(20, 8) NULL,
  manual_payout_user_id INT NULL,
  manual_payout_amount DECIMAL(20, 8) NULL,
  
  -- Result Override
  old_result VARCHAR(50) NULL,
  new_result VARCHAR(50) NULL,
  new_winner_id INT NULL,
  
  -- Ledger References
  ledger_entry_ids JSON NULL, -- Array of ledger_entries.id that were created
  
  -- Metadata
  ip_address VARCHAR(45) NULL,
  user_agent TEXT NULL,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  -- Foreign Keys
  FOREIGN KEY (game_session_id) REFERENCES game_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (manual_payout_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (new_winner_id) REFERENCES users(id) ON DELETE SET NULL,
  
  -- Indexes
  INDEX idx_game_session (game_session_id),
  INDEX idx_admin (admin_id),
  INDEX idx_intervention_type (intervention_type),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================
-- 4. Provably Fair Verifications
-- Logs when users verify game fairness
-- ============================================
CREATE TABLE IF NOT EXISTS provably_fair_verifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  
  game_session_id INT NOT NULL,
  game_id VARCHAR(100) NOT NULL,
  
  -- User who verified
  user_id INT NOT NULL,
  username VARCHAR(100) NOT NULL,
  
  -- Verification Data
  server_seed_hash VARCHAR(255) NOT NULL,
  client_seed VARCHAR(255) NOT NULL,
  nonce INT NOT NULL,
  revealed_server_seed VARCHAR(255) NULL,
  
  -- Result
  is_valid BOOLEAN NOT NULL,
  verification_details JSON NULL,
  
  -- Timestamps
  verified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  -- Foreign Keys
  FOREIGN KEY (game_session_id) REFERENCES game_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  
  -- Indexes
  INDEX idx_game_session (game_session_id),
  INDEX idx_user (user_id),
  INDEX idx_verified_at (verified_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================
-- 5. Views for Quick Access
-- ============================================

-- Active Games View
CREATE OR REPLACE VIEW v_active_games AS
SELECT 
  gs.*,
  TIMESTAMPDIFF(MINUTE, gs.started_at, NOW()) AS minutes_elapsed,
  CASE 
    WHEN gs.player2_id IS NULL THEN 'bot'
    ELSE 'pvp'
  END AS actual_type
FROM game_sessions gs
WHERE gs.status = 'active'
ORDER BY gs.started_at DESC;


-- Stuck Games View (active for > 1 hour)
CREATE OR REPLACE VIEW v_stuck_games AS
SELECT 
  gs.*,
  TIMESTAMPDIFF(MINUTE, gs.started_at, NOW()) AS minutes_stuck
FROM game_sessions gs
WHERE gs.status = 'active'
  AND TIMESTAMPDIFF(MINUTE, gs.started_at, NOW()) > 60
ORDER BY gs.started_at ASC;


-- Pending Disputes View
CREATE OR REPLACE VIEW v_pending_disputes AS
SELECT 
  d.*,
  gs.bet_amount,
  gs.status AS game_status,
  TIMESTAMPDIFF(HOUR, d.submitted_at, NOW()) AS hours_pending
FROM disputes d
JOIN game_sessions gs ON d.game_session_id = gs.id
WHERE d.status IN ('pending', 'investigating')
ORDER BY 
  d.priority DESC,
  d.submitted_at ASC;


-- High-Value Games View (bet > $100)
CREATE OR REPLACE VIEW v_high_value_games AS
SELECT 
  gs.*,
  CASE 
    WHEN gs.status = 'active' THEN TIMESTAMPDIFF(MINUTE, gs.started_at, NOW())
    ELSE NULL
  END AS active_minutes
FROM game_sessions gs
WHERE gs.bet_amount > 100
ORDER BY gs.bet_amount DESC, gs.created_at DESC;


-- Recent Interventions View
CREATE OR REPLACE VIEW v_recent_interventions AS
SELECT 
  gi.*,
  gs.player1_username,
  gs.player2_username,
  gs.bet_amount,
  gs.status AS game_status
FROM game_interventions gi
JOIN game_sessions gs ON gi.game_session_id = gs.id
ORDER BY gi.created_at DESC
LIMIT 100;


-- ============================================
-- 6. Initial Data / Example Records
-- ============================================

-- (None needed - tables will be populated by game activity)


-- ============================================
-- 7. Indexes for Performance
-- ============================================

-- Additional composite indexes for common queries
ALTER TABLE game_sessions ADD INDEX idx_status_created (status, created_at);
ALTER TABLE game_sessions ADD INDEX idx_player1_status (player1_id, status);
ALTER TABLE game_sessions ADD INDEX idx_player2_status (player2_id, status);
ALTER TABLE disputes ADD INDEX idx_status_priority (status, priority);
ALTER TABLE disputes ADD INDEX idx_user_status (user_id, status);


-- ============================================
-- Schema Complete
-- ============================================
