// Chess game routes integrated with main server
const express = require('express');
const router = express.Router();

// Middleware to verify JWT token
function verifyToken(req, res, next) {
  const header = req.header('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(403).json({ error: 'Token missing' });

  try {
    const decoded = require('jsonwebtoken').verify(token, process.env.JWT_ACCESS_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Get user chess profile and stats
router.get('/profile', verifyToken, async (req, res) => {
  try {
    const db = req.app.get('db');
    
    // Get or create chess stats
    let stats = await new Promise((resolve, reject) => {
      db.query(
        'SELECT * FROM chess_statistics WHERE user_id = ?',
        [req.user.userId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows[0]);
        }
      );
    });

    if (!stats) {
      // Create initial stats
      await new Promise((resolve, reject) => {
        db.query(
          'INSERT INTO chess_statistics (user_id, elo_rating) VALUES (?, 1200)',
          [req.user.userId],
          (err, result) => {
            if (err) reject(err);
            else resolve(result);
          }
        );
      });
      
      stats = { user_id: req.user.userId, elo_rating: 1200, total_games: 0, wins: 0, losses: 0, draws: 0 };
    }

    // Get user balance
    const user = await new Promise((resolve, reject) => {
      db.query(
        'SELECT username, balance, currency FROM users WHERE id = ?',
        [req.user.userId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows[0]);
        }
      );
    });

    res.json({
      username: user.username,
      balance: user.balance || 0,
      currency: user.currency || 'USD',
      elo: stats.elo_rating || 1200,
      gamesPlayed: stats.total_games || 0,
      wins: stats.wins || 0,
      losses: stats.losses || 0,
      draws: stats.draws || 0,
      totalWinnings: stats.total_winnings || 0
    });

  } catch (error) {
    console.error('Chess profile error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// Join matchmaking queue
router.post('/matchmaking/join', verifyToken, async (req, res) => {
  try {
    const { betAmount } = req.body;
    const db = req.app.get('db');
    
    // Whitelist of allowed bet amounts
    const ALLOWED_BETS = [1, 5, 10, 50, 100];

    // Validate bet amount
    if (!betAmount || !ALLOWED_BETS.includes(Number(betAmount))) {
      return res.status(400).json({ error: `Invalid bet. Allowed: $${ALLOWED_BETS.join(', $')}` });
    }

    // Check user balance
    const user = await new Promise((resolve, reject) => {
      db.query(
        'SELECT balance FROM users WHERE id = ?',
        [req.user.userId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows[0]);
        }
      );
    });

    if (!user || user.balance < betAmount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Get user's ELO
    const stats = await new Promise((resolve, reject) => {
      db.query(
        'SELECT elo_rating FROM chess_statistics WHERE user_id = ?',
        [req.user.userId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows[0] || { elo_rating: 1200 });
        }
      );
    });

    // Add to matchmaking queue
    await new Promise((resolve, reject) => {
      db.query(
        'INSERT INTO chess_matchmaking (user_id, bet_amount, elo_rating) VALUES (?, ?, ?)',
        [req.user.userId, betAmount, stats.elo_rating],
        (err, result) => {
          if (err) reject(err);
          else resolve(result);
        }
      );
    });

    res.json({ success: true, message: 'Joined matchmaking queue' });

  } catch (error) {
    console.error('Matchmaking join error:', error);
    res.status(500).json({ error: 'Failed to join queue' });
  }
});

// Create new chess game
router.post('/game/create', verifyToken, async (req, res) => {
  try {
    const { betAmount, opponent } = req.body;
    const db = req.app.get('db');
    const ALLOWED_BETS = [1, 5, 10, 50, 100];

    if (!betAmount || !ALLOWED_BETS.includes(Number(betAmount))) {
      return res.status(400).json({ error: `Invalid bet. Allowed: $${ALLOWED_BETS.join(', $')}` });
    }

    // Deduct bet from player's balance
    await new Promise((resolve, reject) => {
      db.query(
        'UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?',
        [betAmount, req.user.userId, betAmount],
        (err, result) => {
          if (err) reject(err);
          else if (result.affectedRows === 0) reject(new Error('Insufficient balance'));
          else resolve(result);
        }
      );
    });

    // Create game
    const initialFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const result = await new Promise((resolve, reject) => {
      db.query(
        `INSERT INTO chess_games (white_player_id, black_player_id, game_state, bet_amount, pot_amount, status)
         VALUES (?, ?, ?, ?, ?, 'active')`,
        [req.user.userId, opponent === 'bot' ? null : opponent, initialFen, betAmount, betAmount * 2],
        (err, result) => {
          if (err) reject(err);
          else resolve(result);
        }
      );
    });

    res.json({
      success: true,
      gameId: result.insertId,
      message: 'Game created successfully'
    });

  } catch (error) {
    console.error('Game creation error:', error);
    res.status(500).json({ error: error.message || 'Failed to create game' });
  }
});

// Record game result
router.post('/game/result', verifyToken, async (req, res) => {
  try {
    const { gameId, result, winnerId } = req.body;
    const db = req.app.get('db');

    // Get game details
    const game = await new Promise((resolve, reject) => {
      db.query(
        'SELECT * FROM chess_games WHERE id = ?',
        [gameId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows[0]);
        }
      );
    });

    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }

    // Update game status
    await new Promise((resolve, reject) => {
      db.query(
        `UPDATE chess_games SET status = 'finished', game_result = ?, winner_id = ?, finished_at = NOW()
         WHERE id = ?`,
        [result, winnerId, gameId],
        (err, result) => {
          if (err) reject(err);
          else resolve(result);
        }
      );
    });

    // Award winnings if there's a winner
    if (winnerId && result !== 'draw') {
      await new Promise((resolve, reject) => {
        db.query(
          'UPDATE users SET balance = balance + ? WHERE id = ?',
          [game.pot_amount, winnerId],
          (err, result) => {
            if (err) reject(err);
            else resolve(result);
          }
        );
      });

      // Update chess statistics
      await new Promise((resolve, reject) => {
        db.query(
          `UPDATE chess_statistics SET 
           wins = wins + 1, 
           total_games = total_games + 1, 
           total_winnings = total_winnings + ?, 
           current_streak = current_streak + 1,
           longest_streak = GREATEST(longest_streak, current_streak + 1)
           WHERE user_id = ?`,
          [game.pot_amount, winnerId],
          (err, result) => {
            if (err) reject(err);
            else resolve(result);
          }
        );
      });
    }

    // Update loser's stats
    const loserId = game.white_player_id === winnerId ? game.black_player_id : game.white_player_id;
    if (loserId) {
      await new Promise((resolve, reject) => {
        db.query(
          `UPDATE chess_statistics SET 
           losses = losses + 1, 
           total_games = total_games + 1, 
           current_streak = 0
           WHERE user_id = ?`,
          [loserId],
          (err, result) => {
            if (err) reject(err);
            else resolve(result);
          }
        );
      });
    }

    res.json({ success: true, message: 'Game result recorded' });

  } catch (error) {
    console.error('Game result error:', error);
    res.status(500).json({ error: 'Failed to record result' });
  }
});

// Get active games count
router.get('/stats/active', async (req, res) => {
  try {
    const db = req.app.get('db');
    
    const result = await new Promise((resolve, reject) => {
      db.query(
        "SELECT COUNT(*) as count FROM chess_games WHERE status = 'active'",
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows[0]);
        }
      );
    });

    res.json({ activeGames: result.count || 0 });

  } catch (error) {
    console.error('Stats error:', error);
    res.json({ activeGames: 0 });
  }
});

module.exports = router;
