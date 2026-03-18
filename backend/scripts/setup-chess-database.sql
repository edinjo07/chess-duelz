-- Chess Game Database Schema for Treasure Hunt
-- Run this script to create all chess-related tables

-- Table: chess_games
-- Stores individual chess game records
CREATE TABLE IF NOT EXISTS chess_games (
    id INT AUTO_INCREMENT PRIMARY KEY,
    white_player_id INT NOT NULL,
    black_player_id INT NULL, -- NULL for bot games
    bet_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    pot_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    outcome ENUM('win_white', 'win_black', 'draw', 'in_progress', 'abandoned') DEFAULT 'in_progress',
    winner_id INT NULL,
    fen TEXT NOT NULL DEFAULT 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', -- Starting position
    move_history TEXT NULL, -- JSON array of moves
    move_count INT DEFAULT 0,
    status ENUM('waiting', 'in_progress', 'completed', 'abandoned') DEFAULT 'in_progress',
    game_type ENUM('bot', 'multiplayer') DEFAULT 'bot',
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP NULL,
    FOREIGN KEY (white_player_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (black_player_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (winner_id) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_white_player (white_player_id),
    INDEX idx_black_player (black_player_id),
    INDEX idx_status (status),
    INDEX idx_started_at (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table: chess_game_moves
-- Stores individual moves for each game (for replay and analysis)
CREATE TABLE IF NOT EXISTS chess_game_moves (
    id INT AUTO_INCREMENT PRIMARY KEY,
    game_id INT NOT NULL,
    move_number INT NOT NULL,
    move_notation VARCHAR(20) NOT NULL, -- e.g., "e4", "Nf3", "O-O"
    fen_after TEXT NOT NULL, -- FEN position after this move
    player_id INT NOT NULL, -- Who made the move
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (game_id) REFERENCES chess_games(id) ON DELETE CASCADE,
    FOREIGN KEY (player_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_game_id (game_id),
    INDEX idx_move_number (game_id, move_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table: chess_user_stats
-- Stores chess statistics for each user
CREATE TABLE IF NOT EXISTS chess_user_stats (
    user_id INT PRIMARY KEY,
    elo_rating INT NOT NULL DEFAULT 1500,
    games_played INT NOT NULL DEFAULT 0,
    games_won INT NOT NULL DEFAULT 0,
    games_lost INT NOT NULL DEFAULT 0,
    games_drawn INT NOT NULL DEFAULT 0,
    total_winnings DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    total_losses DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    best_win_streak INT NOT NULL DEFAULT 0,
    current_win_streak INT NOT NULL DEFAULT 0,
    last_played_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_elo_rating (elo_rating),
    INDEX idx_games_played (games_played)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table: chess_settings
-- Stores user preferences for chess game (UI settings)
CREATE TABLE IF NOT EXISTS chess_settings (
    user_id INT PRIMARY KEY,
    sound_enabled BOOLEAN DEFAULT TRUE,
    sound_volume DECIMAL(3, 2) DEFAULT 0.50,
    board_theme VARCHAR(50) DEFAULT 'green-classic',
    piece_style VARCHAR(50) DEFAULT 'default',
    auto_queen BOOLEAN DEFAULT TRUE, -- Auto-promote to queen
    show_legal_moves BOOLEAN DEFAULT TRUE,
    show_coordinates BOOLEAN DEFAULT TRUE,
    animation_speed ENUM('instant', 'fast', 'normal', 'slow') DEFAULT 'normal',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Initialize chess_user_stats for existing users with default ELO
INSERT INTO chess_user_stats (user_id, elo_rating, games_played, games_won, games_lost, games_drawn)
SELECT id, 1500, 0, 0, 0, 0
FROM users
WHERE id NOT IN (SELECT user_id FROM chess_user_stats)
ON DUPLICATE KEY UPDATE user_id = user_id;

-- Initialize chess_settings for existing users with defaults
INSERT INTO chess_settings (user_id)
SELECT id
FROM users
WHERE id NOT IN (SELECT user_id FROM chess_settings)
ON DUPLICATE KEY UPDATE user_id = user_id;

-- Success message
SELECT 'Chess database tables created successfully!' AS message;
