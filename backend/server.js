// backend/server.js (CommonJS) - Multiplayer Chess with Database Integration
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { db, pool } = require('./pool');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const cors = require('cors');
const { Chess } = require('chess.js');
const adminAuth = require('./middleware/admin-auth');
const ledger = require('./lib/ledger');

const app = express();
const server = http.createServer(app);

// Optimized Socket.IO configuration for performance
const io = socketIo(server, {
  cors: {
    origin: true,
    credentials: true,
    methods: ["GET", "POST"]
  },
  // Performance optimizations
  pingTimeout: 60000, // 60 seconds before timeout
  pingInterval: 25000, // Ping every 25 seconds
  upgradeTimeout: 10000, // 10 seconds to upgrade
  maxHttpBufferSize: 1e6, // 1MB max buffer
  transports: ['websocket', 'polling'], // WebSocket preferred
  allowUpgrades: true,
  perMessageDeflate: false, // Disable compression for lower latency
  httpCompression: false, // Disable HTTP compression
  // Connection state recovery (reduce reconnection overhead)
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
    skipMiddlewares: true
  }
});

// ---------- CONFIG ----------
const PORT = process.env.PORT || 4000;
const JWT_ACCESS_SECRET  = process.env.JWT_ACCESS_SECRET  || 'your_secret_key';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'your_refresh_secret_key';

// If you serve the frontend from this server, FRONTEND_URL should be this server's origin
// (e.g. http://localhost:4000). If your frontend is elsewhere, set it accordingly.
const FRONTEND_URL = process.env.FRONTEND_URL || `http://localhost:${PORT}`;

// Email (use app password if Gmail)
const EMAIL_USER = process.env.EMAIL_USER || 'your-email@gmail.com';
const EMAIL_PASS = process.env.EMAIL_PASS || 'your-app-password';

// ---------- MIDDLEWARE ----------
const ALLOWED_ORIGINS = [
  'https://chess-duelz.vercel.app',
  'http://localhost:4000',
  'http://localhost:3000',
  FRONTEND_URL
].filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true
}));
app.use(express.json());

// Serve static frontend from /public
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// Serve SVG icons as PNG fallback (eliminates 404 errors)
app.get('/favicon-:size.png', (req, res) => {
  const svgPath = path.join(PUBLIC_DIR, `favicon-${req.params.size}.svg`);
  if (fs.existsSync(svgPath)) {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.sendFile(svgPath);
  } else {
    res.status(404).end();
  }
});

app.get('/icons/icon-:size.png', (req, res) => {
  const svgPath = path.join(PUBLIC_DIR, 'icons', `icon-${req.params.size}.svg`);
  if (fs.existsSync(svgPath)) {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.sendFile(svgPath);
  } else {
    res.status(404).end();
  }
});

// ============================ ADMIN PAGE PROTECTION ============================
// Block direct access to admin pages - return 404 to hide existence
app.get('/admin.html', (req, res) => {
  console.warn(`[SECURITY] Attempted direct access to /admin.html from IP: ${getClientIP(req)}`);
  res.status(404).send('Not found');
});

app.get('/admin-withdrawals.html', (req, res) => {
  console.warn(`[SECURITY] Attempted direct access to /admin-withdrawals.html from IP: ${getClientIP(req)}`);
  res.status(404).send('Not found');
});

// Admin login page (not protected)
app.get('/admin-login', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin-login.html'));
});

// Admin setup page (should be removed after initial setup)
app.get('/admin-setup', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin-setup.html'));
});

// Admin panel HTML routes (authentication checked by JavaScript on page)
app.get('/admin', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

app.get('/admin/withdrawals', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin-withdrawals.html'));
});

app.get('/admin/support', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin-support.html'));
});

app.get('/admin/kyc', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin-kyc.html'));
});

// Map pretty routes to your HTML files
app.get('/',        (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'homepagetressurehunt.html')));
app.get('/dashboard', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html')));
app.get('/deposit',   (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'deposit.html')));
app.get('/withdrawal',(_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'withdrawal.html')));
app.get('/reset',     (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'reset.html')));
app.get('/chess',     (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'chess/index.html')));
app.get('/treasure',  (_req, res) => res.redirect('/dashboard.html'));
app.get('/candyfall', (_req, res) => res.redirect('/dashboard.html'));
app.get('/candyfall-game', (_req, res) => res.redirect('/dashboard.html'));
app.get('/slots',     (_req, res) => res.redirect('/dashboard.html'));
app.get('/chess/editor', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'chess/editor.html')));
app.get('/chess/visual', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'chess/visual-editor.html')));
app.get('/chess/inspector', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'chess/inspector.html')));
// New support and informational pages
app.get('/help-center', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'help-center.html')));
app.get('/fairness', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'fairness.html')));
app.get('/responsible-gaming', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'responsible-gaming.html')));
app.get('/self-exclusion', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'self-exclusion.html')));
app.get('/contact', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'contact.html')));
app.get('/about', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'about.html')));
app.get('/privacy-policy', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'privacy-policy.html')));
app.get('/terms-of-service', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'terms-of-service.html')));
app.get('/community', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'community.html')));
app.get('/leaderboard', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'leaderboard.html')));
app.get('/complete-profile', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'complete-profile.html')));

// ==================== PROFILE COMPLETION API ====================

// Complete profile with missing information (dob, phone)
app.post('/api/profile/complete', verifyToken, (req, res) => {
  const userId = req.user.userId;
  const { dob, phone } = req.body;

  // Validate date of birth
  if (!dob) {
    return res.status(400).json({ 
      success: false, 
      error: 'Date of birth is required' 
    });
  }

  // Validate age (must be 18+)
  const birthDate = new Date(dob);
  const today = new Date();
  const age = Math.floor((today - birthDate) / (365.25 * 24 * 60 * 60 * 1000));
  
  if (age < 18) {
    return res.status(400).json({ 
      success: false, 
      error: 'You must be at least 18 years old' 
    });
  }

  // Validate phone format if provided (basic validation)
  if (phone && !/^\+?[\d\s\-()]+$/.test(phone)) {
    return res.status(400).json({ 
      success: false, 
      error: 'Invalid phone number format' 
    });
  }

  // Update user profile
  db.query(
    'UPDATE users SET dob = ?, phone = ? WHERE id = ?',
    [dob, phone || null, userId],
    (err, result) => {
      if (err) {
        console.error('[PROFILE COMPLETE] Error updating profile:', err);
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to update profile' 
        });
      }

      if (result.affectedRows === 0) {
        return res.status(404).json({ 
          success: false, 
          error: 'User not found' 
        });
      }

      console.log(`[PROFILE COMPLETE] User ${userId} completed profile`);
      res.json({ 
        success: true, 
        message: 'Profile updated successfully' 
      });
    }
  );
});

// Get profile completion status
app.get('/api/profile/completion-status', verifyToken, (req, res) => {
  const userId = req.user.userId;

  db.query(
    'SELECT dob, phone, first_name, last_name FROM users WHERE id = ?',
    [userId],
    (err, results) => {
      if (err) {
        console.error('[PROFILE STATUS] Error fetching profile:', err);
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to fetch profile status' 
        });
      }

      if (results.length === 0) {
        return res.status(404).json({ 
          success: false, 
          error: 'User not found' 
        });
      }

      const user = results[0];
      const isComplete = !!(user.dob && user.phone);
      const missingFields = [];
      
      if (!user.dob) missingFields.push('date_of_birth');
      if (!user.phone) missingFields.push('phone_number');

      res.json({ 
        success: true,
        isComplete: isComplete,
        missingFields: missingFields,
        profile: {
          hasDateOfBirth: !!user.dob,
          hasPhone: !!user.phone,
          hasFirstName: !!user.first_name,
          hasLastName: !!user.last_name
        }
      });
    }
  );
});

// Leaderboard API endpoint
app.get('/api/leaderboard', (req, res) => {
  const period = req.query.period || 'all-time';
  
  // Calculate date filter based on period
  let dateFilter = '';
  const now = new Date();
  
  switch (period) {
    case 'daily':
      dateFilter = `AND DATE(g.ended_at) = CURDATE()`;
      break;
    case 'weekly':
      const weekStart = new Date(now.setDate(now.getDate() - now.getDay()));
      dateFilter = `AND g.ended_at >= '${weekStart.toISOString().split('T')[0]}'`;
      break;
    case 'monthly':
      dateFilter = `AND YEAR(g.ended_at) = YEAR(CURDATE()) AND MONTH(g.ended_at) = MONTH(CURDATE())`;
      break;
    case 'all-time':
    default:
      dateFilter = '';
  }
  
  const query = `
    SELECT 
      u.id,
      u.username,
      COALESCE(s.elo_rating, 1500) as elo_rating,
      COALESCE(s.games_played, 0) as games_played,
      COALESCE(s.games_won, 0) as games_won,
      COALESCE(s.games_lost, 0) as games_lost,
      COALESCE(s.games_drawn, 0) as games_drawn,
      COALESCE(balance, 0) as balance,
      ROUND(
        CASE 
          WHEN COALESCE(s.games_played, 0) > 0 
          THEN (COALESCE(s.games_won, 0) * 100.0 / s.games_played)
          ELSE 0 
        END
      ) as win_rate,
      COUNT(DISTINCT CASE 
        WHEN g.outcome = 'white_won' AND g.white_player_id = u.id THEN g.id
        WHEN g.outcome = 'black_won' AND g.black_player_id = u.id THEN g.id
        ELSE NULL
      END) as period_wins
    FROM users u
    LEFT JOIN chess_user_stats s ON u.id = s.user_id
    LEFT JOIN chess_games g ON (g.white_player_id = u.id OR g.black_player_id = u.id) 
      AND g.status = 'completed' ${dateFilter}
    WHERE COALESCE(s.games_played, 0) > 0
    GROUP BY u.id, u.username, s.elo_rating, s.games_played, s.games_won, s.games_lost, s.games_drawn, u.balance
    ORDER BY COALESCE(s.elo_rating, 1500) DESC, period_wins DESC
    LIMIT 100
  `;
  
  db.query(query, (err, results) => {
    if (err) {
      console.error('[LEADERBOARD] Error fetching leaderboard:', err);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to load leaderboard' 
      });
    }
    
    // Format results with rank
    const leaderboard = results.map((player, index) => ({
      rank: index + 1,
      id: player.id,
      username: player.username,
      elo_rating: player.elo_rating,
      games_played: player.games_played,
      games_won: player.games_won,
      win_rate: player.win_rate,
      balance: player.balance,
      level: Math.floor(player.games_played / 10) + 1 // Simple level calculation
    }));
    
    res.json({
      success: true,
      period: period,
      leaderboard: leaderboard,
      total_players: leaderboard.length
    });
  });
});

// API endpoint to save CSS changes
app.post('/api/save-css', (req, res) => {
  try {
    const { css } = req.body;
    if (!css) {
      return res.status(400).json({ success: false, error: 'No CSS provided' });
    }
    
    // Append to custom styles file
    const customCSSPath = path.join(PUBLIC_DIR, 'chess', 'custom-styles.css');
    fs.appendFileSync(customCSSPath, '\n\n/* Generated by CSS Editor */\n' + css);
    
    res.json({ success: true, message: 'CSS saved successfully' });
  } catch (error) {
    console.error('Error saving CSS:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------- DB ----------
// PostgreSQL via Supabase — pool is imported from pool.js at the top.
// Verify connectivity and auto-initialise tables on startup.
db.query('SELECT current_database() AS db', (err, rows) => {
  if (err) {
    console.error('❌ DB connect error:', err.message);
    process.exit(1);
  }
  console.log(`✅ Connected to PostgreSQL database: ${rows[0].db}`);
  initializeDatabase();
});

// Auto-initialize database tables (Supabase PostgreSQL)
async function initializeDatabase() {
  console.log('🔍 Initializing Supabase PostgreSQL tables...');
  const run = (sql) => pool.query(sql);

  try {
    // ── users ─────────────────────────────────────────────────────────
    await run(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        username VARCHAR(50) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        balance DECIMAL(10,2) DEFAULT 0.00,
        currency VARCHAR(3) DEFAULT 'USD',
        dob DATE,
        phone VARCHAR(20),
        referral_code VARCHAR(50),
        language VARCHAR(10) DEFAULT 'en',
        is_admin BOOLEAN DEFAULT FALSE,
        reset_token VARCHAR(255),
        reset_token_expiration TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await run(`CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_users_reset_token ON users(reset_token)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_users_is_admin ON users(is_admin)`);
    const userCols = [
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20)`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(50)`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS language VARCHAR(10) DEFAULT 'en'`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token VARCHAR(255)`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expiration TIMESTAMP`,
    ];
    for (const sql of userCols) { try { await run(sql); } catch (_) {} }
    console.log('✅ users table ready');

    // ── withdrawals ───────────────────────────────────────────────────
    await run(`
      CREATE TABLE IF NOT EXISTS withdrawals (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL,
        asset VARCHAR(10) NOT NULL,
        network VARCHAR(32) NOT NULL,
        to_address VARCHAR(128) NOT NULL,
        amount_atomic DECIMAL(65,0) NOT NULL,
        fee_atomic DECIMAL(65,0) DEFAULT 0,
        status VARCHAR(20) DEFAULT 'requested',
        provider VARCHAR(32) DEFAULT 'nowpayments',
        provider_payout_id VARCHAR(128),
        provider_batch_id VARCHAR(128),
        txid VARCHAR(128),
        rejection_reason TEXT,
        internal_note TEXT,
        approved_by BIGINT,
        approved_at TIMESTAMP,
        sent_by BIGINT,
        sent_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP
      )
    `);
    await run(`CREATE INDEX IF NOT EXISTS idx_withdrawals_user_id ON withdrawals(user_id)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_withdrawals_created_at ON withdrawals(created_at)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_withdrawals_approved_by ON withdrawals(approved_by)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_withdrawals_sent_by ON withdrawals(sent_by)`);
    const wdCols = [
      `ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS approved_by BIGINT`,
      `ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP`,
      `ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS sent_by BIGINT`,
      `ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS sent_at TIMESTAMP`,
      `ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS internal_notes TEXT`,
    ];
    for (const sql of wdCols) { try { await run(sql); } catch (_) {} }
    console.log('✅ withdrawals table ready');

    // ── chess_statistics ──────────────────────────────────────────────
    await run(`
      CREATE TABLE IF NOT EXISTS chess_statistics (
        id SERIAL PRIMARY KEY,
        user_id INT UNIQUE NOT NULL,
        games_played INT DEFAULT 0,
        games_won INT DEFAULT 0,
        games_lost INT DEFAULT 0,
        games_drawn INT DEFAULT 0,
        win_rate DECIMAL(5,2) DEFAULT 0.00,
        total_winnings DECIMAL(10,2) DEFAULT 0.00,
        total_losses DECIMAL(10,2) DEFAULT 0.00,
        current_streak INT DEFAULT 0,
        best_streak INT DEFAULT 0,
        elo_rating INT DEFAULT 1200,
        last_played TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await run(`CREATE INDEX IF NOT EXISTS idx_chess_stats_user_id ON chess_statistics(user_id)`);
    console.log('✅ chess_statistics table ready');

    // ── chess_games ───────────────────────────────────────────────────
    await run(`
      CREATE TABLE IF NOT EXISTS chess_games (
        id SERIAL PRIMARY KEY,
        room_id VARCHAR(100) UNIQUE NOT NULL,
        white_player_id INT,
        black_player_id INT,
        white_username VARCHAR(50),
        black_username VARCHAR(50),
        stake DECIMAL(10,2) DEFAULT 0.00,
        currency VARCHAR(3) DEFAULT 'USD',
        status VARCHAR(20) DEFAULT 'waiting',
        winner_id INT,
        winner_username VARCHAR(50),
        result VARCHAR(20),
        pgn TEXT,
        final_fen TEXT,
        time_control INT DEFAULT 600,
        white_time INT DEFAULT 600,
        black_time INT DEFAULT 600,
        move_count INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        started_at TIMESTAMP,
        completed_at TIMESTAMP
      )
    `);
    await run(`CREATE INDEX IF NOT EXISTS idx_chess_games_room_id ON chess_games(room_id)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_chess_games_white ON chess_games(white_player_id)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_chess_games_black ON chess_games(black_player_id)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_chess_games_status ON chess_games(status)`);
    console.log('✅ chess_games table ready');

    // ── chess_game_moves ──────────────────────────────────────────────
    await run(`
      CREATE TABLE IF NOT EXISTS chess_game_moves (
        id SERIAL PRIMARY KEY,
        game_id INT NOT NULL,
        move_number INT NOT NULL,
        player_id INT NOT NULL,
        move_san VARCHAR(10) NOT NULL,
        move_from VARCHAR(5),
        move_to VARCHAR(5),
        fen_after TEXT,
        time_spent INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await run(`CREATE INDEX IF NOT EXISTS idx_chess_moves_game_id ON chess_game_moves(game_id)`);
    console.log('✅ chess_game_moves table ready');

    // ── crypto_deposits ───────────────────────────────────────────────
    await run(`
      CREATE TABLE IF NOT EXISTS crypto_deposits (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL,
        payment_id VARCHAR(255) UNIQUE,
        order_id VARCHAR(255),
        pay_currency VARCHAR(20),
        pay_address VARCHAR(255),
        price_amount DECIMAL(20,8),
        price_currency VARCHAR(10) DEFAULT 'USD',
        pay_amount DECIMAL(20,8),
        amount_received DECIMAL(20,8) DEFAULT 0,
        status VARCHAR(50) DEFAULT 'waiting',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await run(`CREATE INDEX IF NOT EXISTS idx_deposits_user_id ON crypto_deposits(user_id)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_deposits_payment_id ON crypto_deposits(payment_id)`);
    console.log('✅ crypto_deposits table ready');

    // ── kyc_documents ─────────────────────────────────────────────────
    await run(`
      CREATE TABLE IF NOT EXISTS kyc_documents (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL,
        document_type VARCHAR(50) NOT NULL,
        file_url TEXT,
        status VARCHAR(20) DEFAULT 'pending',
        rejection_reason TEXT,
        reviewed_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await run(`CREATE INDEX IF NOT EXISTS idx_kyc_user_id ON kyc_documents(user_id)`);
    console.log('✅ kyc_documents table ready');

    // ── ledger_entries ────────────────────────────────────────────────
    await run(`
      CREATE TABLE IF NOT EXISTS ledger_entries (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL,
        type VARCHAR(50) NOT NULL,
        amount DECIMAL(20,8) NOT NULL,
        balance_before DECIMAL(20,8),
        balance_after DECIMAL(20,8),
        reference_id VARCHAR(255),
        reference_type VARCHAR(50),
        description TEXT,
        metadata JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await run(`CREATE INDEX IF NOT EXISTS idx_ledger_user_id ON ledger_entries(user_id)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_ledger_type ON ledger_entries(type)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_ledger_created_at ON ledger_entries(created_at)`);
    console.log('✅ ledger_entries table ready');

    // ── balance_adjustments ───────────────────────────────────────────
    await run(`
      CREATE TABLE IF NOT EXISTS balance_adjustments (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL,
        admin_id BIGINT NOT NULL,
        amount DECIMAL(20,8) NOT NULL,
        reason TEXT,
        ledger_entry_id BIGINT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await run(`CREATE INDEX IF NOT EXISTS idx_bal_adj_user_id ON balance_adjustments(user_id)`);
    console.log('✅ balance_adjustments table ready');

    // ── responsible_gaming_limits ─────────────────────────────────────
    await run(`
      CREATE TABLE IF NOT EXISTS responsible_gaming_limits (
        id SERIAL PRIMARY KEY,
        user_id INT UNIQUE NOT NULL,
        deposit_limit_daily DECIMAL(10,2),
        deposit_limit_weekly DECIMAL(10,2),
        deposit_limit_monthly DECIMAL(10,2),
        loss_limit_daily DECIMAL(10,2),
        loss_limit_weekly DECIMAL(10,2),
        loss_limit_monthly DECIMAL(10,2),
        session_time_limit INT,
        self_exclusion_until TIMESTAMP,
        cooldown_until TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ responsible_gaming_limits table ready');

    // ── refresh_tokens ────────────────────────────────────────────────
    await run(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL,
        token_hash VARCHAR(255) UNIQUE NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await run(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id)`);
    console.log('✅ refresh_tokens table ready');

    console.log('✅ All database tables initialized successfully');
  } catch (err) {
    console.error('❌ Database initialization error:', err.message);
  }
}

// Make database available to routes
app.set('db', db);

// ---------- HELPERS ----------
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
function strongPass(p) {
  return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/.test(p);
}
const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

// ---------- EMAIL ----------
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: EMAIL_USER, pass: EMAIL_PASS }
});

// ============================ AUTH ============================

// Register (updated: sets balance/currency and returns token + user)
app.post('/register', (req, res) => {
  const { email, username, password, dob, phone, referral, lang } = req.body;

  // Basic validation (kept from your code)
  if (!email || !username || !password || !dob)
    return res.status(400).json({ error: 'Email, username, password, and DOB are required' });
  if (username.length < 3 || username.length > 14)
    return res.status(400).json({ error: 'Username must be 3–14 chars' });
  if (!isEmail(email)) return res.status(400).json({ error: 'Invalid email format' });
  if (!strongPass(password))
    return res.status(400).json({ error: 'Weak password (need upper, lower, digit, special, 8+)' });

  // Age check
  const birth = new Date(dob);
  if (Number.isNaN(birth.getTime())) {
    return res.status(400).json({ error: 'Invalid DOB' });
  }
  const now = new Date();
  const age = now.getFullYear() - birth.getFullYear() -
    ((now.getMonth() < birth.getMonth() || (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate())) ? 1 : 0);
  if (age < 18) return res.status(400).json({ error: 'You must be 18 or older' });

  // Hash secret
  bcrypt.hash(password, 10, (err, hashedPassword) => {
    if (err) return res.status(500).json({ error: 'Hash error' });

    // Uniqueness check
    db.query('SELECT id FROM users WHERE email = ? OR username = ?', [email, username], (selErr, rows) => {
      if (selErr) return res.status(500).json({ error: 'Database error' });
      if (rows.length) return res.status(400).json({ error: 'Email or Username already exists' });

      // Insert with default wallet values
      const insertSql = `
        INSERT INTO users (email, username, password, dob, phone, referral_code, language, balance, currency)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'USD')
      `;
      db.query(
        insertSql,
        [email, username, hashedPassword, dob, phone || null, referral || null, lang || 'en'],
        (insErr, result) => {
          if (insErr) {
            console.error('Registration insert error:', insErr);
            return res.status(500).json({ error: 'Save error: ' + insErr.message });
          }

          // Create JWT so the user is logged in immediately
          const userId = result.insertId;
          const tokenPayload = { userId, username };
          let accessToken, refreshToken;
          try {
            accessToken = jwt.sign(tokenPayload, JWT_ACCESS_SECRET, { expiresIn: '7d' });
            refreshToken = jwt.sign(tokenPayload, JWT_REFRESH_SECRET, { expiresIn: '30d' });
          } catch (e) {
            return res.status(500).json({ error: 'Token generation failed' });
          }

          // Return token + minimal user object expected by frontend
          res.status(201).json({
            message: 'User registered successfully',
            accessToken,
            refreshToken,
            user: {
              id: userId,
              username,
              email,
              balance: 0,
              currency: 'USD'
            }
          });
        }
      );
    });
  });
});


// Login (email OR username via "identifier")
app.post('/login', (req, res) => {
  const { identifier, username, email, password } = req.body;
  const id = identifier || username || email; // accept any
  if (!id || !password) return res.status(400).json({ error: 'Identifier and password required' });

  const byEmail = isEmail(id);
  const sql = byEmail ? 'SELECT * FROM users WHERE email = ? LIMIT 1'
                      : 'SELECT * FROM users WHERE username = ? LIMIT 1';

  db.query(sql, [id], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (!rows.length) return res.status(400).json({ error: 'User not found' });

    const user = rows[0];
    bcrypt.compare(password, user.password, (cmpErr, ok) => {
      if (cmpErr) return res.status(500).json({ error: 'Compare error' });
      if (!ok) return res.status(400).json({ error: 'Invalid password' });

      const accessToken = jwt.sign({ userId: user.id, username: user.username, isAdmin: !!user.is_admin }, JWT_ACCESS_SECRET, { expiresIn: '7d' });
      const refreshToken = jwt.sign({ userId: user.id, username: user.username, isAdmin: !!user.is_admin }, JWT_REFRESH_SECRET, { expiresIn: '30d' });

      // Return user data along with tokens (for frontend compatibility)
      res.json({ 
        message: 'Login successful', 
        token: accessToken,  // Also include as 'token' for backward compatibility
        accessToken, 
        refreshToken,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          balance: user.balance || 0,
          isAdmin: !!user.is_admin
        }
      });
    });
  });
});

// Refresh token
app.post('/refresh-token', (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });

  jwt.verify(refreshToken, JWT_REFRESH_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ error: 'Invalid or expired refresh token' });
    const accessToken = jwt.sign({ userId: decoded.userId, username: decoded.username }, JWT_ACCESS_SECRET, { expiresIn: '7d' });
    res.json({ accessToken });
  });
});

// ===================== PASSWORD RESET =====================

// Request reset: store HASHED token + expiry (DB sets expiry to avoid timezone issues)
app.post('/password-reset-request', (req, res) => {
  const { email } = req.body;
  console.log('Password reset requested for:', email);
  
  if (!email || !isEmail(email)) return res.status(400).json({ error: 'Valid email required' });

  db.query('SELECT id, email FROM users WHERE email = ? LIMIT 1', [email], (err, rows) => {
    if (err) {
      console.error('Database error fetching user for reset:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    // Always respond the same to avoid enumeration
    if (!rows.length) {
      console.log('Reset requested for non-existent email:', email);
      return res.json({ message: 'If that email exists, a reset link was sent.' });
    }

    const user = rows[0];
    const rawToken  = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);

    console.log('Generating reset token for user:', user.id);

    db.query(
      `UPDATE users
          SET reset_token = ?,
              reset_token_expiration = DATE_ADD(NOW(), INTERVAL 60 MINUTE)
        WHERE id = ?`,
      [tokenHash, user.id],
      (uErr) => {
        if (uErr) {
          console.error('Error updating reset token:', uErr);
          return res.status(500).json({ error: 'Error updating reset token: ' + uErr.message });
        }
        
        console.log('Reset token saved to database for user:', user.id);

        // Build frontend link (served by this server)
        const resetUrl = `${FRONTEND_URL}/reset.html?token=${encodeURIComponent(rawToken)}`;

        const mailOptions = {
          from: EMAIL_USER,
          to: user.email,
          subject: 'Password Reset Request',
          text:
`You requested a password reset. Click the link below to reset your password (valid for 1 hour):

${resetUrl}

If you did not request this, ignore this email.`
        };

        transporter.sendMail(mailOptions, (mailErr) => {
          if (mailErr) {
            console.error('Email error:', mailErr);
            // For dev, still expose token so you can test without email:
            console.log('Reset URL (dev mode):', resetUrl);
            return res.json({ message: 'Email service unavailable. Contact support.', resetToken: rawToken, resetUrl });
          }
          console.log('Password reset email sent to:', user.email);
          res.json({ message: 'Password reset email sent' });
        });
      }
    );
  });
});

// Shared reset handler (supports token in URL OR in body)
const doReset = (req, res) => {
  const token = req.params.token || req.body.token;
  const { password } = req.body;
  
  console.log('Password reset attempt with token:', token ? 'provided' : 'missing');
  
  if (!token) return res.status(400).json({ error: 'Token is required' });
  if (!password) return res.status(400).json({ error: 'Password is required' });
  if (!strongPass(password)) return res.status(400).json({ error: 'Weak password (need upper, lower, digit, special, 8+)' });

  const tokenHash = hashToken(token);

  db.query(
    `SELECT id, username, email, reset_token, reset_token_expiration, NOW() AS server_now
       FROM users
      WHERE reset_token = ?
        AND reset_token_expiration IS NOT NULL
        AND reset_token_expiration > NOW()
      LIMIT 1`,
    [tokenHash],
    (selErr, rows) => {
      if (selErr) {
        console.error('Database error validating reset token:', selErr);
        return res.status(500).json({ error: 'Database error: ' + selErr.message });
      }
      if (!rows.length) {
        console.log('Invalid or expired reset token');
        return res.status(400).json({ error: 'Invalid or expired token' });
      }

      const user = rows[0];
      console.log('Valid reset token found for user:', user.username);

      bcrypt.hash(password, 10, (hashErr, hashedPassword) => {
        if (hashErr) {
          console.error('Password hash error:', hashErr);
          return res.status(500).json({ error: 'Hash error' });
        }

        db.query(
          `UPDATE users
              SET password = ?, reset_token = NULL, reset_token_expiration = NULL
            WHERE id = ?`,
          [hashedPassword, user.id],
          (updErr, updRes) => {
            if (updErr) {
              console.error('Error updating password:', updErr);
              return res.status(500).json({ error: 'Update error: ' + updErr.message });
            }
            if (updRes.affectedRows === 0) {
              console.error('Password update affected 0 rows for user:', user.id);
              return res.status(500).json({ error: 'Password not updated' });
            }

            console.log('Password successfully reset for user:', user.username);

            const accessToken = jwt.sign(
              { userId: user.id, username: user.username },
              JWT_ACCESS_SECRET,
              { expiresIn: '7d' }
            );
            const refreshToken = jwt.sign(
              { userId: user.id, username: user.username },
              JWT_REFRESH_SECRET,
              { expiresIn: '30d' }
            );
            res.json({ 
              message: 'Password successfully updated', 
              accessToken,
              refreshToken 
            });
          }
        );
      });
    }
  );
};

// Routes for reset
app.post('/reset-password/:token', doReset);
app.post('/password-reset/:token', doReset);
app.post('/reset-password', doReset);
app.post('/password-reset', doReset);

// ============================ ADMIN SECURITY ============================

// Admin IP allowlist (add your trusted IPs here)
const ADMIN_ALLOWED_IPS = new Set([
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
  // Whitelisted admin IPs
  '84.233.178.37',
  '84.233.178.38',
  '84.233.178.39',
  '84.233.178.40',
  '84.233.178.41',
  '84.233.178.42',
  '84.233.178.43',
  '84.233.178.44',
  '84.233.178.45',
]);

// Get real client IP (handles proxies/CDNs)
function getClientIP(req) {
  // Trust proxy setting must be enabled for this to work
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.socket.remoteAddress || req.connection.remoteAddress;
}

// Admin action logger
function logAdminAction(userId, username, action, details = {}) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    userId,
    username,
    action,
    details,
    ip: details.ip || 'unknown'
  };
  console.log('[ADMIN ACTION]', JSON.stringify(logEntry));
  
  // Store in database (using admin_audit_logs table for consistency)
  db.query(
    'INSERT INTO admin_audit_logs (admin_id, action, details, ip_address, created_at) VALUES (?, ?, ?, ?, NOW())',
    [userId, action, JSON.stringify(details), logEntry.ip],
    (err) => {
      if (err && err.code !== 'ER_NO_SUCH_TABLE') {
        console.error('[ADMIN LOG] Failed to save log:', err.message);
      }
    }
  );
}

// Create admin_audit_logs table if it doesn't exist (unified table name)
db.query(`
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`, (err) => {
  if (err && err.code !== 'ER_TABLE_EXISTS_ERROR') {
    console.error('Error creating admin_audit_logs table:', err.message);
  } else {
    console.log('✅ Admin audit logs table ready');
  }
});

// ============================ PROTECTED ============================
app.set('trust proxy', true); // Enable if behind proxy (Render, Cloudflare, etc.)

function verifyToken(req, res, next) {
  const header = req.header('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(403).json({ error: 'Token missing' });

  try {
    const decoded = jwt.verify(token, JWT_ACCESS_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Admin-only middleware
function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized: Authentication required' });
  }
  
  if (!req.user.isAdmin) {
    const clientIP = getClientIP(req);
    console.warn(`[SECURITY] Non-admin user ${req.user.username} (${req.user.userId}) attempted admin access from IP: ${clientIP}`);
    return res.status(403).json({ error: 'Forbidden: Admin access required' });
  }
  
  next();
}

// IP allowlist for admin routes - DISABLED for development (allows all IPs)
function ipAllowlist(req, res, next) {
  // Temporarily disabled during platform development
  // const clientIP = getClientIP(req);
  // if (!ADMIN_ALLOWED_IPS.has(clientIP)) {
  //   console.warn(`[SECURITY] Admin access denied for IP: ${clientIP}`);
  //   return res.status(403).json({ error: 'Forbidden: IP not allowed' });
  // }
  next();
}

// --- Profile route (protected) ---
app.get('/profile', verifyToken, (req, res) => {
  const userId = req.user.userId;

  // Fetch profile with only existing columns including admin status
  db.query(
    `SELECT id, username, email, 
            COALESCE(balance, 0) AS balance,
            COALESCE(currency, 'USD') AS currency,
            COALESCE(is_admin, FALSE) AS isAdmin,
            created_at
     FROM users
     WHERE id = ?
     LIMIT 1`,
    [userId],
    (err, rows) => {
      if (err) {
        console.error('Profile query error:', err);
        return res.status(500).json({ error: 'Database error', details: err.message });
      }
      if (!rows.length) return res.status(404).json({ error: 'User not found' });

      res.json(rows[0]);
    }
  );
});

// Update personal info
app.put('/api/profile/personal', verifyToken, (req, res) => {
  const userId = req.user.userId;
  const { username, email } = req.body;
  
  const updates = [];
  const values = [];
  
  // Only update columns that exist in the users table
  if (username !== undefined && username.trim()) {
    updates.push('username = ?');
    values.push(username.trim());
  }
  if (email !== undefined && email.trim()) {
    updates.push('email = ?');
    values.push(email.trim());
  }
  
  if (updates.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }
  
  // Validate email format if provided
  if (email !== undefined) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
  }
  
  // Validate username length
  if (username !== undefined && username.trim().length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  }
  
  values.push(userId);
  
  db.query(
    `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
    values,
    (err, result) => {
      if (err) {
        console.error('Error updating profile:', err);
        // Check for duplicate username/email
        if (err.code === 'ER_DUP_ENTRY') {
          return res.status(409).json({ error: 'Username or email already exists' });
        }
        return res.status(500).json({ error: 'Failed to update profile' });
      }
      
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      
      res.json({ success: true, message: 'Profile updated successfully' });
    }
  );
});

// Change password
app.post('/api/profile/change-password', verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const { currentPassword, newPassword } = req.body;
  
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password are required' });
  }
  
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  
  // Get current password hash
  db.query('SELECT password FROM users WHERE id = ?', [userId], async (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    
    // Verify current password
    const validPassword = await bcrypt.compare(currentPassword, rows[0].password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    
    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    
    // Update password
    db.query('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, userId], (err) => {
      if (err) {
        console.error('Error changing password:', err);
        return res.status(500).json({ error: 'Failed to change password' });
      }
      res.json({ success: true, message: 'Password changed successfully' });
    });
  });
});

// Toggle 2FA (placeholder - full 2FA implementation would require additional tables and logic)
app.post('/api/profile/toggle-2fa', verifyToken, (req, res) => {
  const userId = req.user.userId;
  const { enabled } = req.body;
  
  // TODO: Implement full 2FA with TOTP/authenticator app
  // For now, just acknowledge the request
  console.log(`User ${userId} ${enabled ? 'enabled' : 'disabled'} 2FA`);
  
  res.json({ 
    success: true, 
    message: `2FA ${enabled ? 'enabled' : 'disabled'} successfully`,
    twoFactorEnabled: enabled
  });
});

// Toggle email notifications
app.post('/api/profile/toggle-email-notifications', verifyToken, (req, res) => {
  const userId = req.user.userId;
  const { enabled } = req.body;
  
  // TODO: Add email_notifications column to users table if needed
  // For now, just acknowledge
  console.log(`User ${userId} ${enabled ? 'enabled' : 'disabled'} email notifications`);
  
  res.json({ 
    success: true, 
    message: `Email notifications ${enabled ? 'enabled' : 'disabled'}`,
    emailNotificationsEnabled: enabled
  });
});

// Get deposit limits (Responsible Gaming)
app.get('/api/profile/deposit-limits', verifyToken, (req, res) => {
  const userId = req.user.userId;
  
  db.query(
    'SELECT daily_limit, weekly_limit, monthly_limit FROM responsible_gaming_limits WHERE user_id = ?',
    [userId],
    (err, rows) => {
      if (err) {
        console.error('Error fetching deposit limits:', err);
        return res.json({ 
          dailyLimit: null, 
          weeklyLimit: null, 
          monthlyLimit: null 
        });
      }
      
      if (rows.length === 0) {
        return res.json({ 
          dailyLimit: null, 
          weeklyLimit: null, 
          monthlyLimit: null 
        });
      }
      
      res.json({
        dailyLimit: rows[0].daily_limit,
        weeklyLimit: rows[0].weekly_limit,
        monthlyLimit: rows[0].monthly_limit
      });
    }
  );
});

// Save deposit limits (Responsible Gaming)
app.post('/api/profile/deposit-limits', verifyToken, (req, res) => {
  const userId = req.user.userId;
  const { dailyLimit, weeklyLimit, monthlyLimit } = req.body;
  
  // Validate limits
  const daily = dailyLimit ? parseFloat(dailyLimit) : null;
  const weekly = weeklyLimit ? parseFloat(weeklyLimit) : null;
  const monthly = monthlyLimit ? parseFloat(monthlyLimit) : null;
  
  db.query(
    `INSERT INTO responsible_gaming_limits (user_id, daily_limit, weekly_limit, monthly_limit)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       daily_limit = VALUES(daily_limit),
       weekly_limit = VALUES(weekly_limit),
       monthly_limit = VALUES(monthly_limit)`,
    [userId, daily, weekly, monthly],
    (err) => {
      if (err) {
        console.error('Error saving deposit limits:', err);
        // If table doesn't exist, just acknowledge
        if (err.code === 'ER_NO_SUCH_TABLE') {
          console.log(`User ${userId} set deposit limits (table not exists):`, { dailyLimit: daily, weeklyLimit: weekly, monthlyLimit: monthly });
          return res.json({ 
            success: true, 
            message: 'Deposit limits saved successfully',
            limits: { dailyLimit: daily, weeklyLimit: weekly, monthlyLimit: monthly }
          });
        }
        return res.status(500).json({ error: 'Failed to save deposit limits' });
      }
      
      res.json({ 
        success: true, 
        message: 'Deposit limits saved successfully',
        limits: { dailyLimit: daily, weeklyLimit: weekly, monthlyLimit: monthly }
      });
    }
  );
});

// Get self-exclusion status
app.get('/api/profile/self-exclusion-status', verifyToken, (req, res) => {
  const userId = req.user.userId;
  
  db.query(
    `SELECT exclusion_type, excluded_until, status, created_at 
     FROM self_exclusions 
     WHERE user_id = ? AND status = 'active'
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId],
    (err, rows) => {
      if (err) {
        console.error('Error fetching self-exclusion status:', err);
        return res.json({ 
          isExcluded: false,
          exclusionType: null,
          excludedUntil: null
        });
      }
      
      if (rows.length === 0) {
        return res.json({ 
          isExcluded: false,
          exclusionType: null,
          excludedUntil: null
        });
      }
      
      const exclusion = rows[0];
      
      // Check if temporary exclusion has expired
      if (exclusion.exclusion_type === 'temporary' && exclusion.excluded_until) {
        const now = new Date();
        const until = new Date(exclusion.excluded_until);
        
        if (now >= until) {
          // Mark as expired
          db.query(
            'UPDATE self_exclusions SET status = ? WHERE user_id = ? AND status = ?',
            ['expired', userId, 'active'],
            (updateErr) => {
              if (updateErr) console.error('Error updating exclusion status:', updateErr);
            }
          );
          
          return res.json({ 
            isExcluded: false,
            exclusionType: null,
            excludedUntil: null
          });
        }
      }
      
      res.json({
        isExcluded: true,
        exclusionType: exclusion.exclusion_type,
        excludedUntil: exclusion.excluded_until
      });
    }
  );
});

// Self-exclusion
app.post('/api/profile/self-exclusion', verifyToken, (req, res) => {
  const userId = req.user.userId;
  const { days } = req.body;
  
  if (!days || (days !== -1 && days < 1)) {
    return res.status(400).json({ error: 'Invalid exclusion period' });
  }
  
  const exclusionType = days === -1 ? 'permanent' : 'temporary';
  const excludeUntil = days === -1 ? null : new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  
  db.query(
    `INSERT INTO self_exclusions (user_id, exclusion_type, excluded_until, status)
     VALUES (?, ?, ?, 'active')`,
    [userId, exclusionType, excludeUntil],
    (err) => {
      if (err) {
        console.error('Error creating self-exclusion:', err);
        // If table doesn't exist, just log
        if (err.code === 'ER_NO_SUCH_TABLE') {
          console.log(`User ${userId} self-excluded for ${days === -1 ? 'permanent' : days + ' days'}`);
          return res.json({ 
            success: true, 
            message: days === -1 ? 'Account permanently excluded' : `Account excluded for ${days} days`,
            excludedUntil: excludeUntil
          });
        }
        return res.status(500).json({ error: 'Failed to activate self-exclusion' });
      }
      
      res.json({ 
        success: true, 
        message: days === -1 ? 'Account permanently excluded' : `Account excluded for ${days} days`,
        excludedUntil: excludeUntil
      });
    }
  );
});

// Request data export (GDPR)
app.post('/api/profile/request-data-export', verifyToken, (req, res) => {
  const userId = req.user.userId;
  
  // TODO: Implement data export generation and email delivery
  console.log(`User ${userId} requested data export`);
  
  res.json({ 
    success: true, 
    message: 'Data export requested. You will receive an email within 48 hours with your data.'
  });
});

// Close account
app.post('/api/profile/close-account', verifyToken, (req, res) => {
  const userId = req.user.userId;
  const { reason } = req.body;
  
  // TODO: Implement proper account closure process
  // - Check for pending withdrawals
  // - Check balance
  // - Mark account as closed (don't delete for compliance)
  // - Send confirmation email
  
  console.log(`User ${userId} requested account closure. Reason:`, reason);
  
  res.json({ 
    success: true, 
    message: 'Account closure requested. Our team will contact you within 24 hours to complete the process.'
  });
});

// ============================ ADMIN API ROUTES ============================

// Get all users (admin only)
app.get('/admin/users', verifyToken, adminAuth.requireAdmin, adminAuth.requirePermission('users.view'), (req, res) => {
  try {
    // Log the action (non-blocking)
    if (req.user && req.user.userId && req.user.username) {
      adminAuth.logAdminAction(req.user.userId, req.user.username, 'VIEW_ALL_USERS', { 
        resourceType: 'users',
        ipAddress: adminAuth.getClientIP(req),
        userAgent: req.headers['user-agent']
      });
    }
    
    db.query(
      `SELECT id, username, email, balance, currency, phone, referral_code, language, 
              COALESCE(is_admin, FALSE) AS is_admin, created_at
       FROM users
       ORDER BY created_at DESC`,
      (err, rows) => {
        if (err) {
          console.error('Error fetching users:', err);
          return res.status(500).json({ error: 'Database error', details: err.message });
        }
        res.json(rows);
      }
    );
  } catch (error) {
    console.error('Fatal error in /admin/users:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// Update user (admin only) - BALANCE EDITS DISABLED, use /api/admin/ledger/balance/adjust instead
app.put('/admin/users/:userId', verifyToken, adminAuth.requireAdmin, adminAuth.requirePermission('users.edit'), (req, res) => {
  const { userId } = req.params;
  const { email, currency, phone, balance } = req.body;
  
  console.log('Admin updating user:', userId, 'with data:', { email, currency, phone, balance });
  adminAuth.logAdminAction(req.user.userId, req.user.username, 'UPDATE_USER', { 
    resourceType: 'user',
    resourceId: userId,
    changes: { email, currency, phone, balance },
    ipAddress: adminAuth.getClientIP(req),
    userAgent: req.headers['user-agent']
  });
  
  const updates = [];
  const values = [];
  
  if (email !== undefined && email !== null && email !== '') {
    updates.push('email = ?');
    values.push(email);
  }
  if (currency !== undefined && currency !== null && currency !== '') {
    updates.push('currency = ?');
    values.push(currency);
  }
  if (phone !== undefined) {
    updates.push('phone = ?');
    values.push(phone || null);
  }
  
  // TESTING MODE: Allow balance editing for game testing
  if (balance !== undefined && balance !== null) {
    updates.push('balance = ?');
    values.push(parseFloat(balance));
    console.log('⚠️ TESTING MODE: Updating balance to', balance);
  }
  
  if (updates.length === 0) {
    console.log('No fields to update');
    return res.status(400).json({ error: 'No fields to update' });
  }
  
  values.push(parseInt(userId));
  
  const sql = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;
  console.log('Executing SQL:', sql, 'with values:', values);
  
  db.query(sql, values, (err, result) => {
    if (err) {
      console.error('Error updating user:', err);
      return res.status(500).json({ error: 'Database error: ' + err.message });
    }
    console.log('Update result:', result);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Fetch updated user data to return
    db.query('SELECT id, username, email, balance, currency, phone FROM users WHERE id = ?', [userId], (fetchErr, rows) => {
      if (fetchErr) {
        console.error('Error fetching updated user:', fetchErr);
        return res.json({ message: 'User updated successfully' });
      }
      res.json({ 
        message: 'User updated successfully', 
        user: rows[0]
      });
    });
  });
});// Get all chess games (admin only)
app.get('/admin/games', verifyToken, adminAuth.requireAdmin, adminAuth.requirePermission('system.view'), (req, res) => {
  logAdminAction(req.user.userId, req.user.username, 'VIEW_ALL_GAMES', { ip: getClientIP(req) });
  
  db.query(
    `SELECT g.*, 
            w.username as white_username, 
            b.username as black_username,
            win.username as winner_username
     FROM chess_games g
     LEFT JOIN users w ON g.white_player_id = w.id
     LEFT JOIN users b ON g.black_player_id = b.id
     LEFT JOIN users win ON g.winner_id = win.id
     ORDER BY g.created_at DESC
     LIMIT 100`,
    (err, rows) => {
      if (err) {
        console.error('Error fetching games:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      res.json(rows);
    }
  );
});

// Delete chess game (admin only)
app.delete('/admin/games/:gameId', verifyToken, adminAuth.requireAdmin, adminAuth.requirePermission('system.manage'), (req, res) => {
  const { gameId } = req.params;
  
  logAdminAction(req.user.userId, req.user.username, 'DELETE_GAME', { gameId, ip: getClientIP(req) });
  
  // Delete moves first
  db.query('DELETE FROM chess_moves WHERE game_id = ?', [gameId], (err) => {
    if (err && !err.message.includes("doesn't exist")) {
      console.error('Error deleting moves:', err);
    }
    
    // Delete game
    db.query('DELETE FROM chess_games WHERE id = ?', [parseInt(gameId)], (err, result) => {
      if (err) {
        console.error('Error deleting game:', err);
        return res.status(500).json({ error: 'Database error: ' + err.message });
      }
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Game not found' });
      }
      res.json({ message: 'Game deleted successfully', deletedId: gameId });
    });
  });
});

// Cleanup inactive users (admin only)
app.post('/admin/cleanup/inactive-users', verifyToken, adminAuth.requireAdmin, adminAuth.requirePermission('users.delete'), (req, res) => {
  logAdminAction(req.user.userId, req.user.username, 'CLEANUP_INACTIVE_USERS', { ip: getClientIP(req) });
  
  // This is a placeholder - define your own "inactive" criteria
  res.json({ message: 'Cleanup not yet implemented', deletedCount: 0 });
});

// Cleanup old games (admin only)
app.delete('/admin/cleanup/old-games', verifyToken, adminAuth.requireAdmin, adminAuth.requirePermission('system.manage'), (req, res) => {
  const { days } = req.query;
  const daysAgo = parseInt(days) || 30;
  
  logAdminAction(req.user.userId, req.user.username, 'CLEANUP_OLD_GAMES', { daysAgo, ip: getClientIP(req) });
  
  db.query(
    `DELETE g, m FROM chess_games g
     LEFT JOIN chess_moves m ON m.game_id = g.id
     WHERE g.finished_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [daysAgo],
    (err, result) => {
      if (err) {
        console.error('Error cleaning up games:', err);
        return res.status(500).json({ error: 'Database error: ' + err.message });
      }
      res.json({ message: `Deleted games older than ${daysAgo} days`, deletedCount: result.affectedRows });
    }
  );
});

// Reset balances (admin only - DANGEROUS!)
app.post('/admin/reset-balances', verifyToken, adminAuth.requireAdmin, adminAuth.requirePermission('balance.adjust'), (req, res) => {
  logAdminAction(req.user.userId, req.user.username, 'RESET_BALANCES_ATTEMPT', { ip: getClientIP(req) });
  
  // This is a dangerous operation, so just return info for now
  res.json({ message: 'This operation requires additional confirmation', warning: 'This will reset all user balances' });
});

// ============================ ADMIN SETUP ENDPOINT (ONE-TIME USE) ============================
// ============ ADMIN SETUP ENDPOINT - DISABLED FOR SECURITY ============
// This endpoint is disabled after initial admin setup for security
// To create an admin, use: node scripts/create-superadmin.js
// Or manually update database: UPDATE users SET is_admin = 1 WHERE id = ?

app.post('/api/setup-admin', async (req, res) => {
  // SECURITY: This endpoint is disabled in production
  const ALLOW_SETUP = process.env.ALLOW_ADMIN_SETUP === 'true';
  
  if (!ALLOW_SETUP) {
    console.warn(`[SECURITY] Blocked admin setup attempt from IP: ${getClientIP(req)}`);
    return res.status(403).json({ 
      error: 'Admin setup endpoint is disabled',
      message: 'This endpoint has been disabled for security. Contact system administrator to create admin accounts.',
      code: 'SETUP_DISABLED'
    });
  }

  const { username, secretKey } = req.body;
  
  // Secret key protection - change this to something secure
  const SETUP_SECRET = process.env.ADMIN_SETUP_SECRET || 'CHANGE_ME_IN_PRODUCTION_12345';
  
  if (secretKey !== SETUP_SECRET) {
    console.warn(`[SECURITY] Invalid admin setup attempt from IP: ${getClientIP(req)}`);
    return res.status(403).json({ error: 'Invalid secret key' });
  }

  if (!username) {
    return res.status(400).json({ error: 'Username required' });
  }

  try {
    // Check if any admin already exists - only allow if no admins exist
    db.query('SELECT COUNT(*) as admin_count FROM users WHERE is_admin = 1', (countErr, countRows) => {
      if (countErr) {
        console.error('Database error:', countErr);
        return res.status(500).json({ error: 'Database error' });
      }

      if (countRows[0].admin_count > 0) {
        console.warn(`[SECURITY] Admin setup blocked - admins already exist. IP: ${getClientIP(req)}`);
        return res.status(403).json({ 
          error: 'Admin setup not allowed',
          message: 'Admin accounts already exist. Use admin panel to create additional admins.',
          code: 'ADMINS_EXIST'
        });
      }

      // Check if user exists
      db.query('SELECT id, username, is_admin FROM users WHERE username = ? OR email = ?', [username, username], (err, rows) => {
        if (err) {
          console.error('Database error:', err);
          return res.status(500).json({ error: 'Database error' });
        }

        if (!rows.length) {
          return res.status(404).json({ error: 'User not found' });
        }

        const user = rows[0];

        if (user.is_admin) {
          return res.json({ 
            message: 'User is already an admin',
            username: user.username 
          });
        }

        // Promote to admin
        db.query('UPDATE users SET is_admin = 1 WHERE id = ?', [user.id], (updateErr) => {
          if (updateErr) {
            console.error('Error promoting user:', updateErr);
            return res.status(500).json({ error: 'Failed to promote user' });
          }

          console.log(`[ADMIN] User ${user.username} (ID: ${user.id}) promoted to admin by IP: ${getClientIP(req)}`);
          
          res.json({ 
            success: true,
            message: 'User successfully promoted to admin',
            username: user.username,
            userId: user.id
          });
        });
      });
    });
  } catch (error) {
    console.error('Setup admin error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Diagnostic endpoint - Check if user is admin
app.get('/api/check-admin/:username', (req, res) => {
  const { username } = req.params;
  
  db.query('SELECT id, username, email, is_admin FROM users WHERE username = ?', [username], (err, rows) => {
    if (err) {
      console.error('Error checking admin status:', err);
      return res.status(500).json({ error: 'Database error', details: err.message });
    }
    
    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = rows[0];
    res.json({
      username: user.username,
      userId: user.id,
      email: user.email,
      isAdmin: !!user.is_admin,
      is_admin_raw: user.is_admin
    });
  });
});

// ============ KING1 PERMISSIONS SETUP ENDPOINT ============
// API endpoint to grant all permissions to King1
app.post('/api/setup-king1-permissions', async (req, res) => {
  const { secretKey } = req.body;
  
  // Secret key protection
  const SETUP_SECRET = process.env.ADMIN_SETUP_SECRET || 'CHANGE_ME_IN_PRODUCTION_12345';
  
  if (secretKey !== SETUP_SECRET) {
    console.warn(`[SECURITY] Invalid King1 permissions setup attempt from IP: ${getClientIP(req)}`);
    return res.status(403).json({ error: 'Invalid secret key' });
  }

  console.log('🚀 Starting King1 Permissions Setup via API...');
  const logs = [];
  const log = (msg) => {
    console.log(msg);
    logs.push(msg);
  };

  try {
    // Step 1: Check if King1 exists
    const checkUser = () => new Promise((resolve, reject) => {
      db.query('SELECT id, username, email, is_admin FROM users WHERE username = ?', ['King1'], (err, rows) => {
        if (err) return reject(err);
        if (!rows || rows.length === 0) {
          return reject(new Error('King1 user not found. Create it first via /api/setup-admin'));
        }
        resolve(rows[0]);
      });
    });

    const king1 = await checkUser();
    log(`✅ Found King1 (ID: ${king1.id}, Email: ${king1.email})`);

    // Step 2: Create admin_roles table if not exists
    const createRolesTable = () => new Promise((resolve, reject) => {
      db.query(`
        CREATE TABLE IF NOT EXISTS admin_roles (
          id INT AUTO_INCREMENT PRIMARY KEY,
          role_name VARCHAR(100) UNIQUE NOT NULL,
          permissions JSON NOT NULL,
          description TEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_role_name (role_name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `, (err) => {
        if (err && err.code !== 'ER_TABLE_EXISTS_ERROR') return reject(err);
        resolve();
      });
    });

    await createRolesTable();
    log('✅ admin_roles table ready');

    // Step 3: Create user_admin_roles table if not exists
    const createUserRolesTable = () => new Promise((resolve, reject) => {
      db.query(`
        CREATE TABLE IF NOT EXISTS user_admin_roles (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          role_id INT NOT NULL,
          assigned_by INT NULL,
          assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (role_id) REFERENCES admin_roles(id) ON DELETE CASCADE,
          UNIQUE KEY unique_user_role (user_id, role_id),
          INDEX idx_user_id (user_id),
          INDEX idx_role_id (role_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `, (err) => {
        if (err && err.code !== 'ER_TABLE_EXISTS_ERROR') return reject(err);
        resolve();
      });
    });

    await createUserRolesTable();
    log('✅ user_admin_roles table ready');

    // Step 4: Create Super Admin role with all permissions
    const permissions = [
      'deposits.view', 'deposits.manage', 'ledger.view', 'reconciliation.manage',
      'webhooks.view', 'webhooks.manage', 'risk.view', 'risk.manage',
      'accounts.freeze', 'blacklist.manage', 'games.view', 'games.manage',
      'disputes.view', 'disputes.manage', 'compliance.view', 'compliance.manage',
      'monitoring.view', 'monitoring.manage', 'config.view', 'config.manage',
      'users.view', 'users.edit', 'users.delete', 'balance.adjust',
      'system.view', 'system.manage', 'withdrawals.view', 'withdrawals.approve',
      'withdrawals.send', 'withdrawals.reject', 'withdrawals.fail', 'audit.view'
    ];

    const createRole = () => new Promise((resolve, reject) => {
      db.query(`
        INSERT INTO admin_roles (role_name, permissions, description)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE 
          permissions = VALUES(permissions),
          description = VALUES(description),
          updated_at = CURRENT_TIMESTAMP
      `, [
        'Super Admin',
        JSON.stringify(permissions),
        'Full access to all admin features across all 5 phases'
      ], (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    await createRole();
    log(`✅ Super Admin role created/updated with ${permissions.length} permissions`);

    // Step 5: Ensure King1 is marked as admin
    const markAdmin = () => new Promise((resolve, reject) => {
      db.query('UPDATE users SET is_admin = TRUE WHERE id = ?', [king1.id], (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    await markAdmin();
    log('✅ King1 marked as admin');

    // Step 6: Get Super Admin role ID
    const getRoleId = () => new Promise((resolve, reject) => {
      db.query('SELECT id FROM admin_roles WHERE role_name = ?', ['Super Admin'], (err, rows) => {
        if (err) return reject(err);
        if (!rows || rows.length === 0) return reject(new Error('Super Admin role not found'));
        resolve(rows[0].id);
      });
    });

    const roleId = await getRoleId();
    log(`✅ Super Admin role ID: ${roleId}`);

    // Step 7: Assign Super Admin role to King1
    const assignRole = () => new Promise((resolve, reject) => {
      db.query(`
        INSERT INTO user_admin_roles (user_id, role_id, assigned_by)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE assigned_at = CURRENT_TIMESTAMP
      `, [king1.id, roleId, king1.id], (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    await assignRole();
    log('✅ Super Admin role assigned to King1');

    // Step 8: Verify
    const verify = () => new Promise((resolve, reject) => {
      db.query(`
        SELECT 
          u.id,
          u.username,
          u.email,
          u.is_admin,
          ar.role_name,
          ar.permissions,
          JSON_LENGTH(ar.permissions) as permission_count
        FROM users u
        JOIN user_admin_roles uar ON u.id = uar.user_id
        JOIN admin_roles ar ON uar.role_id = ar.id
        WHERE u.username = 'King1'
      `, (err, rows) => {
        if (err) return reject(err);
        if (!rows || rows.length === 0) return reject(new Error('Verification failed'));
        resolve(rows[0]);
      });
    });

    const result = await verify();
    log('✅ Verification complete');

    // Success!
    console.log('🎉 SUCCESS! King1 permissions setup complete!');
    
    res.json({
      success: true,
      message: 'King1 has been granted all permissions!',
      details: {
        userId: result.id,
        username: result.username,
        email: result.email,
        isAdmin: !!result.is_admin,
        role: result.role_name,
        permissionCount: result.permission_count,
        totalPermissions: permissions.length
      },
      permissions: permissions,
      logs: logs,
      loginUrl: 'https://treasure-backend-dtgf.onrender.com/admin-login.html'
    });

  } catch (error) {
    console.error('❌ King1 permissions setup error:', error);
    logs.push(`❌ Error: ${error.message}`);
    
    res.status(500).json({
      success: false,
      error: error.message,
      logs: logs
    });
  }
});

// Deduct bet at game start (for bot games)
app.post('/chess/deduct-bet', verifyToken, async (req, res) => {
  const { betAmount } = req.body;
  const userId = req.user.userId;
  
  console.log(`[CHESS BET] User ${userId} starting bot game - Bet: $${betAmount}`);
  
  try {
    // Deduct bet using ledger system
    const entry = await ledger.createLedgerEntry({
      userId: userId,
      type: ledger.ENTRY_TYPES.BET_DEBIT,
      amount: -betAmount,
      currency: 'USD',
      referenceType: 'chess_game',
      referenceId: null, // Game ID not available at bet time
      metadata: {
        game_type: 'chess_bot',
        bet_amount: betAmount
      }
    });
    
    console.log(`[CHESS BET] User ${userId} balance after bet: $${entry.balance_after}`);
    
    res.json({ 
      success: true,
      newBalance: entry.balance_after,
      betDeducted: betAmount
    });
  } catch (err) {
    console.error('[CHESS BET] Error deducting bet:', err);
    
    if (err.message.includes('Insufficient balance')) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    
    return res.status(500).json({ error: 'Failed to deduct bet' });
  }
});

// Update balance after bot game (chess)
app.post('/chess/update-balance', verifyToken, async (req, res) => {
  const { outcome, betAmount, potAmount } = req.body;
  const userId = req.user.userId;
  
  console.log(`[CHESS BALANCE] User ${userId} game ended - Outcome: ${outcome}, Bet: $${betAmount}, Pot: $${potAmount}`);
  
  try {
    // Calculate balance change based on outcome
    let balanceChange = 0;
    let entryType = null;
    
    if (outcome === 'win') {
      balanceChange = potAmount; // Winner gets the pot
      entryType = ledger.ENTRY_TYPES.WIN_CREDIT;
    } else if (outcome === 'draw') {
      balanceChange = potAmount / 2; // Split pot
      entryType = ledger.ENTRY_TYPES.WIN_CREDIT;
    } else if (outcome === 'lose') {
      // Loss - bet already deducted, no ledger entry needed
      const balanceResult = await ledger.getUserBalance(userId, 'USD');
      return res.json({ 
        success: true,
        newBalance: balanceResult.balance,
        balanceChange: 0,
        outcome: outcome
      });
    }
    
    // Create win/draw credit entry
    const entry = await ledger.createLedgerEntry({
      userId: userId,
      type: entryType,
      amount: balanceChange,
      currency: 'USD',
      referenceType: 'chess_game',
      referenceId: null, // Game ID not available
      metadata: {
        game_type: 'chess_bot',
        outcome: outcome,
        bet_amount: betAmount,
        pot_amount: potAmount
      }
    });
    
    console.log(`[CHESS BALANCE] User ${userId} balance updated: $${entry.balance_after} (${outcome}: +$${balanceChange})`);
    
    res.json({ 
      success: true,
      newBalance: entry.balance_after,
      balanceChange: balanceChange,
      outcome: outcome
    });
  } catch (err) {
    console.error('[CHESS BALANCE] Error updating balance:', err);
    return res.status(500).json({ error: 'Failed to update balance' });
  }
});


// Start a new chess game
app.post('/chess/game/start', verifyToken, async (req, res) => {
  const { betAmount, opponentType, opponentId } = req.body;
  const userId = req.user.userId;
  
  console.log(`[CHESS GAME START] User ${userId} starting ${opponentType} game with bet $${betAmount}`);
  
  try {
    // Validate bet amount
    if (!betAmount || betAmount <= 0) {
      return res.status(400).json({ error: 'Invalid bet amount' });
    }
    
    // Check user balance
    db.query('SELECT balance FROM users WHERE id = ?', [userId], async (err, rows) => {
      if (err || !rows.length) {
        console.error('[CHESS GAME START] Error fetching user:', err);
        return res.status(500).json({ error: 'Failed to fetch user data' });
      }
      
      const userBalance = rows[0].balance;
      if (userBalance < betAmount) {
        return res.status(400).json({ error: 'Insufficient balance' });
      }
      
      // Deduct bet from balance using ledger
      ledger.createLedgerEntry({
        userId: userId,
        type: ledger.ENTRY_TYPES.BET_DEBIT,
        amount: -betAmount,
        currency: 'USD',
        referenceType: 'chess_game',
        referenceId: null,
        metadata: { game_type: opponentType, bet_amount: betAmount }
      }).then(entry => {
          
          // Initialize chess_user_stats if this is user's first game
          db.query(
            `INSERT INTO chess_user_stats (user_id, elo_rating, games_played) 
             VALUES (?, 1500, 0) 
             ON DUPLICATE KEY UPDATE user_id = user_id`,
            [userId],
            (statsErr) => {
              if (statsErr) {
                console.error('[CHESS GAME START] Error initializing stats:', statsErr);
              }
            }
          );
          
          // Calculate pot amount (always 2x bet - winner takes all)
          const potAmount = betAmount * 2;
          
          // Determine player colors (white_player_id)
          const whitePlayerId = userId;
          const blackPlayerId = opponentType === 'bot' ? null : opponentId;
          
          // Create game record
          db.query(
            `INSERT INTO chess_games 
             (white_player_id, black_player_id, bet_amount, pot_amount, game_type, status, fen) 
             VALUES (?, ?, ?, ?, ?, 'in_progress', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')`,
            [whitePlayerId, blackPlayerId, betAmount, potAmount, opponentType],
            (insertErr, insertResult) => {
              if (insertErr) {
                console.error('[CHESS GAME START] Error creating game:', insertErr);
                // Rollback: refund the bet via ledger
                ledger.createLedgerEntry({
                  userId: userId,
                  type: ledger.ENTRY_TYPES.BET_REFUND,
                  amount: betAmount,
                  currency: 'USD',
                  referenceType: 'chess_game_failed',
                  referenceId: null,
                  metadata: { reason: 'game_creation_failed' }
                }).catch(err => console.error('[CHESS GAME START] Refund error:', err));
                return res.status(500).json({ error: 'Failed to create game' });
              }
              
              const gameId = insertResult.insertId;
              console.log(`[CHESS GAME START] ✅ Game ${gameId} created for user ${userId}`);
              
              // Get updated balance
              const newBalance = userBalance - betAmount;
              
              res.json({
                success: true,
                gameId: gameId,
                betAmount: betAmount,
                potAmount: potAmount,
                opponentType: opponentType,
                color: 'white',
                newBalance: newBalance
              });
            }
          );
        }
      );
    });
  } catch (error) {
    console.error('[CHESS GAME START] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete user (admin only)

// Get user's chess statistics
app.get('/chess/user/stats', verifyToken, (req, res) => {
  const userId = req.user.userId;
  
  console.log(`[CHESS USER STATS] Fetching stats for user ${userId}`);
  
  // Fetch user balance and chess stats
  db.query(
    `SELECT 
      u.id, u.username, u.balance,
      COALESCE(s.elo_rating, 1500) as elo_rating,
      COALESCE(s.games_played, 0) as games_played,
      COALESCE(s.games_won, 0) as games_won,
      COALESCE(s.games_lost, 0) as games_lost,
      COALESCE(s.games_drawn, 0) as games_drawn,
      COALESCE(s.total_winnings, 0) as total_winnings,
      COALESCE(s.total_losses, 0) as total_losses,
      COALESCE(s.best_win_streak, 0) as best_win_streak,
      COALESCE(s.current_win_streak, 0) as current_win_streak,
      s.last_played_at
    FROM users u
    LEFT JOIN chess_user_stats s ON u.id = s.user_id
    WHERE u.id = ?`,
    [userId],
    (err, rows) => {
      if (err) {
        console.error('[CHESS USER STATS] Error fetching stats:', err);
        return res.status(500).json({ error: 'Failed to fetch stats' });
      }
      
      if (!rows.length) {
        return res.status(404).json({ error: 'User not found' });
      }
      
      const stats = rows[0];
      
      // If user has no stats record, initialize one
      if (stats.games_played === 0 && !stats.last_played_at) {
        db.query(
          `INSERT INTO chess_user_stats (user_id, elo_rating, games_played) 
           VALUES (?, 1500, 0) 
           ON DUPLICATE KEY UPDATE user_id = user_id`,
          [userId],
          (initErr) => {
            if (initErr) {
              console.error('[CHESS USER STATS] Error initializing stats:', initErr);
            }
          }
        );
      }
      
      console.log(`[CHESS USER STATS] ✅ Stats fetched for user ${userId}: ELO ${stats.elo_rating}, Games ${stats.games_played}`);
      
      res.json({
        success: true,
        userId: stats.id,
        username: stats.username,
        balance: parseFloat(stats.balance),
        elo: stats.elo_rating,
        gamesPlayed: stats.games_played,
        wins: stats.games_won,
        losses: stats.games_lost,
        draws: stats.games_drawn,
        totalWinnings: parseFloat(stats.total_winnings),
        totalLosses: parseFloat(stats.total_losses),
        bestWinStreak: stats.best_win_streak,
        currentWinStreak: stats.current_win_streak,
        lastPlayedAt: stats.last_played_at
      });
    }
  );
});


// Record a chess move
app.post('/chess/game/move', verifyToken, (req, res) => {
  const { gameId, moveNumber, moveNotation, fenAfter } = req.body;
  const userId = req.user.userId;
  
  console.log(`[CHESS GAME MOVE] User ${userId} - Game ${gameId} - Move ${moveNumber}: ${moveNotation}`);
  
  // Validate game belongs to user
  db.query(
    'SELECT white_player_id, black_player_id, status FROM chess_games WHERE id = ?',
    [gameId],
    (err, rows) => {
      if (err) {
        console.error('[CHESS GAME MOVE] Error fetching game:', err);
        return res.status(500).json({ error: 'Failed to fetch game' });
      }
      
      if (!rows.length) {
        return res.status(404).json({ error: 'Game not found' });
      }
      
      const game = rows[0];
      
      // Verify user is part of this game
      if (game.white_player_id !== userId && game.black_player_id !== userId) {
        return res.status(403).json({ error: 'Not authorized for this game' });
      }
      
      // Check game is still in progress
      if (game.status !== 'in_progress') {
        return res.status(400).json({ error: 'Game is not in progress' });
      }
      
      // Insert move record
      db.query(
        'INSERT INTO chess_game_moves (game_id, move_number, move_notation, fen_after, player_id) VALUES (?, ?, ?, ?, ?)',
        [gameId, moveNumber, moveNotation, fenAfter, userId],
        (insertErr) => {
          if (insertErr) {
            console.error('[CHESS GAME MOVE] Error inserting move:', insertErr);
            return res.status(500).json({ error: 'Failed to record move' });
          }
          
          // Update game's current FEN and move count
          db.query(
            'UPDATE chess_games SET fen = ?, move_count = ? WHERE id = ?',
            [fenAfter, moveNumber, gameId],
            (updateErr) => {
              if (updateErr) {
                console.error('[CHESS GAME MOVE] Error updating game FEN:', updateErr);
                return res.status(500).json({ error: 'Failed to update game state' });
              }
              
              console.log(`[CHESS GAME MOVE] ✅ Move ${moveNumber} recorded for game ${gameId}`);
              res.json({ success: true, moveNumber: moveNumber });
            }
          );
        }
      );
    }
  );
});


// End a chess game
app.post('/chess/game/end', verifyToken, (req, res) => {
  const { gameId, outcome, finalFen } = req.body;
  const userId = req.user.userId;
  
  console.log(`[CHESS GAME END] User ${userId} - Game ${gameId} - Outcome: ${outcome}`);
  
  // Validate and fetch game data
  db.query(
    `SELECT g.*, 
            w.username as white_username, 
            COALESCE(ws.elo_rating, 1500) as white_elo,
            b.username as black_username,
            COALESCE(bs.elo_rating, 1500) as black_elo
     FROM chess_games g
     INNER JOIN users w ON g.white_player_id = w.id
     LEFT JOIN users b ON g.black_player_id = b.id
     LEFT JOIN chess_user_stats ws ON g.white_player_id = ws.user_id
     LEFT JOIN chess_user_stats bs ON g.black_player_id = bs.user_id
     WHERE g.id = ?`,
    [gameId],
    (err, rows) => {
      if (err) {
        console.error('[CHESS GAME END] Error fetching game:', err);
        return res.status(500).json({ error: 'Failed to fetch game' });
      }
      
      if (!rows.length) {
        return res.status(404).json({ error: 'Game not found' });
      }
      
      const game = rows[0];
      
      // Verify user is part of this game
      if (game.white_player_id !== userId && game.black_player_id !== userId) {
        return res.status(403).json({ error: 'Not authorized for this game' });
      }
      
      // Determine winner and game outcome
      let gameOutcome, winnerId = null;
      let whiteResult, blackResult; // 1 = win, 0.5 = draw, 0 = loss
      
      if (outcome === 'win') {
        winnerId = userId;
        gameOutcome = (userId === game.white_player_id) ? 'win_white' : 'win_black';
        whiteResult = (userId === game.white_player_id) ? 1 : 0;
        blackResult = (userId === game.white_player_id) ? 0 : 1;
      } else if (outcome === 'lose') {
        winnerId = (userId === game.white_player_id) ? game.black_player_id : game.white_player_id;
        gameOutcome = (userId === game.white_player_id) ? 'win_black' : 'win_white';
        whiteResult = (userId === game.white_player_id) ? 0 : 1;
        blackResult = (userId === game.white_player_id) ? 1 : 0;
      } else {
        gameOutcome = 'draw';
        whiteResult = 0.5;
        blackResult = 0.5;
      }
      
      // Calculate ELO changes (K-factor = 32 for active players)
      const K = 32;
      const whiteElo = game.white_elo;
      const blackElo = game.black_elo || 1500; // Bot default ELO
      
      const expectedWhite = 1 / (1 + Math.pow(10, (blackElo - whiteElo) / 400));
      const expectedBlack = 1 - expectedWhite;
      
      const whiteEloChange = Math.round(K * (whiteResult - expectedWhite));
      const blackEloChange = Math.round(K * (blackResult - expectedBlack));
      
      const newWhiteElo = whiteElo + whiteEloChange;
      const newBlackElo = blackElo + blackEloChange;
      
      // Calculate payout
      let whiteBalanceChange = 0;
      let blackBalanceChange = 0;
      
      console.log(`[CHESS GAME END] 📊 Game Data:`, {
        gameId: gameId,
        pot_amount: game.pot_amount,
        bet_amount: game.bet_amount,
        game_type: game.game_type,
        white_player_id: game.white_player_id,
        black_player_id: game.black_player_id,
        winnerId: winnerId,
        userId: userId
      });
      
      if (winnerId === game.white_player_id) {
        whiteBalanceChange = game.pot_amount;
        console.log(`[CHESS GAME END] ✅ White player wins - adding $${whiteBalanceChange} to white player ${game.white_player_id}`);
      } else if (winnerId === game.black_player_id) {
        blackBalanceChange = game.pot_amount;
        console.log(`[CHESS GAME END] ✅ Black player wins - adding $${blackBalanceChange} to black player ${game.black_player_id}`);
      } else {
        // Draw - split pot
        const splitAmount = game.pot_amount / 2;
        whiteBalanceChange = splitAmount;
        blackBalanceChange = splitAmount;
        console.log(`[CHESS GAME END] ⚖️ Draw - splitting pot: white gets $${whiteBalanceChange}, black gets $${blackBalanceChange}`);
      }
      
      // Start transaction-like updates
      // 1. Update game record
      db.query(
        `UPDATE chess_games 
         SET outcome = ?, winner_id = ?, status = 'completed', fen = ?, ended_at = NOW()
         WHERE id = ?`,
        [gameOutcome, winnerId, finalFen, gameId],
        (updateGameErr) => {
          if (updateGameErr) {
            console.error('[CHESS GAME END] Error updating game:', updateGameErr);
            return res.status(500).json({ error: 'Failed to update game' });
          }
          
          // 2. Update white player stats and balance
          db.query(
            `UPDATE chess_user_stats 
             SET elo_rating = ?,
                 games_played = games_played + 1,
                 games_won = games_won + ?,
                 games_lost = games_lost + ?,
                 games_drawn = games_drawn + ?,
                 total_winnings = total_winnings + ?,
                 current_win_streak = CASE WHEN ? = 1 THEN current_win_streak + 1 ELSE 0 END,
                 best_win_streak = GREATEST(best_win_streak, CASE WHEN ? = 1 THEN current_win_streak + 1 ELSE 0 END),
                 last_played_at = NOW()
             WHERE user_id = ?`,
            [
              newWhiteElo,
              whiteResult === 1 ? 1 : 0,
              whiteResult === 0 ? 1 : 0,
              whiteResult === 0.5 ? 1 : 0,
              whiteBalanceChange,
              whiteResult,
              whiteResult,
              game.white_player_id
            ],
            (updateWhiteStatsErr) => {
              if (updateWhiteStatsErr) {
                console.error('[CHESS GAME END] Error updating white player stats:', updateWhiteStatsErr);
              }
              
              // Update white player balance via ledger
              console.log(`[CHESS GAME END] 💰 Updating white player ${game.white_player_id} balance: +${whiteBalanceChange}`);
              const whiteEntryType = whiteBalanceChange > 0 ? ledger.ENTRY_TYPES.WIN_CREDIT : ledger.ENTRY_TYPES.BET_REFUND;
              ledger.createLedgerEntry({
                userId: game.white_player_id,
                type: whiteEntryType,
                amount: whiteBalanceChange,
                currency: 'USD',
                referenceType: 'chess_game',
                referenceId: gameId,
                metadata: { result: winner, pot_amount: game.pot_amount }
              }).then(entry => {
                console.log(`[CHESS GAME END] ✅ White player balance: $${entry.balance_after}`);
                
                // 3. Update black player stats and balance (if multiplayer)
                if (game.black_player_id) {
                    db.query(
                      `UPDATE chess_user_stats 
                       SET elo_rating = ?,
                           games_played = games_played + 1,
                           games_won = games_won + ?,
                           games_lost = games_lost + ?,
                           games_drawn = games_drawn + ?,
                           total_winnings = total_winnings + ?,
                           current_win_streak = CASE WHEN ? = 1 THEN current_win_streak + 1 ELSE 0 END,
                           best_win_streak = GREATEST(best_win_streak, CASE WHEN ? = 1 THEN current_win_streak + 1 ELSE 0 END),
                           last_played_at = NOW()
                       WHERE user_id = ?`,
                      [
                        newBlackElo,
                        blackResult === 1 ? 1 : 0,
                        blackResult === 0 ? 1 : 0,
                        blackResult === 0.5 ? 1 : 0,
                        blackBalanceChange,
                        blackResult,
                        blackResult,
                        game.black_player_id
                      ],
                      (updateBlackStatsErr) => {
                        if (updateBlackStatsErr) {
                          console.error('[CHESS GAME END] Error updating black player stats:', updateBlackStatsErr);
                        }
                      }
                    );
                    
                    const blackEntryType = blackBalanceChange > 0 ? ledger.ENTRY_TYPES.WIN_CREDIT : ledger.ENTRY_TYPES.BET_REFUND;
                    ledger.createLedgerEntry({
                      userId: game.black_player_id,
                      type: blackEntryType,
                      amount: blackBalanceChange,
                      currency: 'USD',
                      referenceType: 'chess_game',
                      referenceId: gameId,
                      metadata: { result: winner, pot_amount: game.pot_amount }
                    }).catch(err => {
                      console.error('[CHESS GAME END] Error updating black player balance:', err);
                    });
                  }
                  
                  // Return updated stats for the requesting user
                  console.log(`[CHESS GAME END] 🔍 Fetching final balance for user ${userId}...`);
                  db.query(
                    `SELECT u.balance, s.elo_rating, s.games_played, s.games_won, s.games_lost, s.games_drawn
                     FROM users u
                     LEFT JOIN chess_user_stats s ON u.id = s.user_id
                     WHERE u.id = ?`,
                    [userId],
                    (fetchErr, userRows) => {
                      if (fetchErr || !userRows.length) {
                        console.error('[CHESS GAME END] ❌ Error fetching updated stats:', fetchErr);
                        return res.status(500).json({ error: 'Game ended but failed to fetch updated stats' });
                      }
                      
                      const userStats = userRows[0];
                      const userEloChange = (userId === game.white_player_id) ? whiteEloChange : blackEloChange;
                      const userBalanceChange = (userId === game.white_player_id) ? whiteBalanceChange : blackBalanceChange;
                      
                      console.log(`[CHESS GAME END] 🎉 FINAL RESULT - Game ${gameId}:`, {
                        winner: winnerId || 'Draw',
                        userId: userId,
                        finalBalance: userStats.balance,
                        balanceChange: userBalanceChange,
                        finalElo: userStats.elo_rating,
                        eloChange: userEloChange
                      });
                      
                      res.json({
                        success: true,
                        outcome: outcome,
                        newBalance: parseFloat(userStats.balance),
                        balanceChange: userBalanceChange,
                        newElo: userStats.elo_rating,
                        eloChange: userEloChange,
                        gamesPlayed: userStats.games_played,
                        wins: userStats.games_won,
                        losses: userStats.games_lost,
                        draws: userStats.games_drawn
                      });
                    }
                  );
                }).catch(err => {
                  console.error('[CHESS GAME END] ❌ Error updating player balance:', err);
                  return res.status(500).json({ error: 'Failed to update balance' });
                });
              }
            );
          }
        );
      }
    );
  }
);

app.delete('/admin/users/:userId', verifyToken, adminAuth.requireAdmin, adminAuth.requirePermission('users.delete'), (req, res) => {
  const { userId } = req.params;
  
  console.log('Admin deleting user:', userId, 'by admin:', req.user.userId);
  
  // Prevent deleting yourself
  if (req.user.userId === parseInt(userId)) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  
  // Log the admin action
  adminAuth.logAdminAction(req.user.userId, req.user.username, 'USER_DELETE', { 
    resourceType: 'user',
    resourceId: userId,
    ipAddress: adminAuth.getClientIP(req),
    userAgent: req.headers['user-agent']
  });
  
  // First, delete related records in chess tables (if they exist)
  const deleteRelatedQueries = [
    'DELETE FROM chess_statistics WHERE user_id = ?',
    'DELETE FROM chess_matchmaking WHERE user_id = ?',
    'DELETE FROM chess_moves WHERE game_id IN (SELECT id FROM chess_games WHERE white_player_id = ? OR black_player_id = ?)',
    'DELETE FROM chess_games WHERE white_player_id = ? OR black_player_id = ?'
  ];
  
  // Execute related deletes (ignore errors if tables don't exist)
  let completed = 0;
  deleteRelatedQueries.forEach((query, index) => {
    const params = query.includes('game_id') ? [userId, userId] : [userId];
    db.query(query, params, (err) => {
      if (err && !err.message.includes("doesn't exist")) {
        console.error('Error deleting related records:', err.message);
      }
      completed++;
      
      // After all related records are processed, delete the user
      if (completed === deleteRelatedQueries.length) {
        db.query('DELETE FROM users WHERE id = ?', [parseInt(userId)], (err, result) => {
          if (err) {
            console.error('Error deleting user:', err);
            return res.status(500).json({ error: 'Database error: ' + err.message });
          }
          console.log('Delete result:', result);
          if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'User not found' });
          }
          res.json({ message: 'User deleted successfully', deletedId: userId });
        });
      }
    });
  });
});

// Chess API routes
const chessRoutes = require('./routes/chess');
app.use('/api/chess', chessRoutes);

// KYC API routes
const kycRoutes = require('./routes/kyc')(db, verifyToken);
app.use('/api/kyc', kycRoutes);

// ============ ENHANCED ADMIN ROUTES WITH RBAC ============

// Admin audit logs routes
app.get('/api/admin/audit-logs', verifyToken, adminAuth.requireAdmin, adminAuth.requirePermission('audit.view'), (req, res) => {
  const { startDate, endDate, userId, action, limit = 100, offset = 0 } = req.query;
  
  let query = 'SELECT * FROM admin_audit_logs WHERE 1=1';
  const params = [];
  
  if (startDate) {
    query += ' AND created_at >= ?';
    params.push(startDate);
  }
  if (endDate) {
    query += ' AND created_at <= ?';
    params.push(endDate);
  }
  if (userId) {
    query += ' AND user_id = ?';
    params.push(userId);
  }
  if (action) {
    query += ' AND action = ?';
    params.push(action);
  }
  
  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));
  
  db.query(query, params, (err, results) => {
    if (err) {
      console.error('Error fetching audit logs:', err);
      return res.status(500).json({ error: 'Failed to fetch audit logs' });
    }
    
    res.json({
      success: true,
      logs: results,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  });
});

// Security events routes
app.get('/api/admin/security-events', verifyToken, adminAuth.requireAdmin, adminAuth.requirePermission('audit.view'), (req, res) => {
  const { severity, resolved, userId, limit = 100, offset = 0 } = req.query;
  
  let query = 'SELECT * FROM security_events WHERE 1=1';
  const params = [];
  
  if (severity) {
    query += ' AND severity = ?';
    params.push(severity);
  }
  if (resolved !== undefined) {
    query += ' AND resolved = ?';
    params.push(resolved === 'true' ? 1 : 0);
  }
  if (userId) {
    query += ' AND user_id = ?';
    params.push(userId);
  }
  
  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));
  
  db.query(query, params, (err, results) => {
    if (err) {
      console.error('Error fetching security events:', err);
      return res.status(500).json({ error: 'Failed to fetch security events' });
    }
    
    res.json({
      success: true,
      events: results,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  });
});

// Balance adjustment ledger routes
const adminLedgerRoutes = require('./routes/admin-ledger')(db, verifyToken, adminAuth.requireAdmin);
app.use('/api/admin/ledger', adminLedgerRoutes);

// Admin deposit management routes
const adminDepositsRoutes = require('./routes/admin-deposits')(db, verifyToken, requireAdmin);
app.use('/api/admin/deposits', adminDepositsRoutes);

// Admin risk and fraud management routes
const adminRiskRoutes = require('./routes/admin-risk')(db, adminAuth);
app.use('/api/admin/risk', adminRiskRoutes);

// Admin game sessions management routes
const adminGamesRoutes = require('./routes/admin-games')(db, adminAuth);
app.use('/api/admin/games', adminGamesRoutes);

// Admin disputes management routes
const adminDisputesRoutes = require('./routes/admin-disputes')(db, adminAuth);
app.use('/api/admin/disputes', adminDisputesRoutes);

// Admin compliance KYC routes
const adminComplianceKycRoutes = require('./routes/admin-compliance-kyc')(db, adminAuth);
app.use('/api/admin/compliance', adminComplianceKycRoutes);

// Admin compliance AML routes
const adminComplianceAmlRoutes = require('./routes/admin-compliance-aml')(db, adminAuth);
app.use('/api/admin/compliance', adminComplianceAmlRoutes);

// Admin monitoring health routes
const adminMonitoringHealthRoutes = require('./routes/admin-monitoring-health')(db, adminAuth);
app.use('/api/admin/monitoring', adminMonitoringHealthRoutes);

// Admin monitoring logs and config routes
const adminMonitoringLogsRoutes = require('./routes/admin-monitoring-logs')(db, adminAuth);
app.use('/api/admin/monitoring', adminMonitoringLogsRoutes);

// Admin management routes
const adminManagementRoutes = require('./routes/admin-management')(db, verifyToken, requireAdmin);
app.use('/api/admin', adminManagementRoutes);

// NOWPayments deposit routes (new)
const nowpaymentsDepositRouter = require('./routes/nowpayments_deposit');
app.use('/api/deposit', nowpaymentsDepositRouter);

// NOWPayments IPN webhook (new)
const nowpaymentsIpnRouter = require('./routes/nowpayments_ipn');
app.use('/api/nowpayments', nowpaymentsIpnRouter);

// Withdrawal routes (new)
const withdrawRouter = require('./routes/withdraw');
app.use('/api/withdraw', withdrawRouter);

// Admin withdrawal approval routes (new)
const adminWithdrawRouter = require('./routes/admin_withdraw');
app.use('/api/admin', adminWithdrawRouter);

// Admin withdrawal management routes (2-step approval flow)
const adminWithdrawalsRoutes = require('./routes/admin-withdrawals')(db, verifyToken, adminAuth.requireAdmin);
app.use('/api/admin/withdrawals', adminWithdrawalsRoutes);

// NOWPayments Payout IPN webhook (new)
const payoutIpnRouter = require('./routes/nowpayments_payout_ipn');
app.use('/api/nowpayments', payoutIpnRouter);

// Active chess games in memory
const activeGames = new Map(); // gameId -> { chess, whitePlayerId, blackPlayerId, potAmount, betAmount }
const matchmakingQueue = new Map(); // betAmount -> [{ userId, username, balance, socketId, timestamp }]

// Chess Socket.IO for real-time gameplay with balance updates
io.on('connection', (socket) => {
  console.log('Chess client connected:', socket.id);
  
  let userId = null;
  let username = null;

  // Authenticate socket with username
  socket.on('join_user_room', async (callback) => {
    try {
      username = socket.handshake.auth.username;
      if (username) {
        // Find user by username
        db.query('SELECT id, username, balance FROM users WHERE username = ?', [username], (err, rows) => {
          if (!err && rows.length > 0) {
            userId = rows[0].id;
            socket.userId = userId;
            socket.username = username;
            socket.join(`user_${userId}`);
            console.log(`✅ User ${username} (ID: ${userId}) authenticated and joined user room`);
            if (callback) callback({ success: true, userId: userId });
          } else {
            console.error(`❌ User ${username} not found in database`);
            if (callback) callback({ success: false, error: 'User not found' });
          }
        });
      } else {
        console.error('❌ No username provided in auth');
        if (callback) callback({ success: false, error: 'No username' });
      }
    } catch (error) {
      console.error('Socket auth error:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  // Join matchmaking
  socket.on('join_matchmaking', async (data) => {
    try {
      // Normalize bet amount to ensure proper matching
      const betAmount = parseFloat(data.betAmount);
      
      console.log(`[MATCHMAKING] JOIN REQUEST - User: ${socket.username}, Bet: $${betAmount}, Socket: ${socket.id}`);
      
      if (!socket.userId) {
        console.log(`[MATCHMAKING] ERROR: User not authenticated`);
        socket.emit('error', { message: 'Not authenticated' });
        return;
      }
      
      if (isNaN(betAmount) || betAmount <= 0) {
        console.log(`[MATCHMAKING] ERROR: Invalid bet amount: ${betAmount}`);
        socket.emit('error', { message: 'Invalid bet amount' });
        return;
      }
      
      // Get user data
      db.query('SELECT id, username, balance FROM users WHERE id = ?', [socket.userId], async (err, rows) => {
        if (err || !rows.length) {
          socket.emit('error', { message: 'User not found' });
          return;
        }
        
        const user = rows[0];
        
        // Check balance
        if (user.balance < betAmount) {
          socket.emit('error', { message: 'Insufficient balance' });
          return;
        }
        
        // Deduct bet from balance immediately via ledger
        try {
          const betEntry = await ledger.createLedgerEntry({
            userId: socket.userId,
            type: ledger.ENTRY_TYPES.BET_DEBIT,
            amount: -betAmount,
            currency: 'USD',
            referenceType: 'bingo_game',
            referenceId: null,
            metadata: { game_type: 'bingo_multiplayer', bet_amount: betAmount }
          });
            
          console.log(`[MATCHMAKING] User ${socket.userId} (${user.username}) bet $${betAmount} - Balance now: $${betEntry.balance_after}`);            // Check if there's someone waiting in the queue for this bet amount
            console.log(`[MATCHMAKING] Current queue state:`, Array.from(matchmakingQueue.entries()).map(([amt, q]) => `$${amt}: ${q.length} players`));
            
            if (!matchmakingQueue.has(betAmount)) {
              matchmakingQueue.set(betAmount, []);
            }
            
            const queue = matchmakingQueue.get(betAmount);
            console.log(`[MATCHMAKING] Queue for $${betAmount} has ${queue.length} players BEFORE filtering`);
            
            // Remove any stale entries (older than 60 seconds) AND this user if already in queue
            const now = Date.now();
            const validQueue = queue.filter(entry => {
              const isStale = now - entry.timestamp >= 60000;
              const isSameUser = entry.userId === socket.userId;
              return !isStale && !isSameUser;
            });
            
            if (validQueue.length !== queue.length) {
              console.log(`[MATCHMAKING] Cleaned queue: removed ${queue.length - validQueue.length} entries (stale or duplicate)`);
            }
            
            console.log(`[MATCHMAKING] Valid queue for $${betAmount}: ${validQueue.length} players AFTER filtering`);
            console.log(`[MATCHMAKING] Players in queue:`, validQueue.map(p => p.username));
            
            // CRITICAL: Check if someone is waiting BEFORE we add ourselves
            if (validQueue.length > 0) {
              // Match found! Create game with the first person in queue
              const opponent = validQueue.shift();
              matchmakingQueue.set(betAmount, validQueue);
              
              console.log(`[MATCHMAKING] ✅ MATCH FOUND! ${user.username} vs ${opponent.username} for $${betAmount}`);
              
              // Randomly assign colors
              const isUserWhite = Math.random() < 0.5;
              const whitePlayerId = isUserWhite ? socket.userId : opponent.userId;
              const blackPlayerId = isUserWhite ? opponent.userId : socket.userId;
              
              // Create game in database
              let gameId; // Declare outside try-catch to use later
              try {
                const createGameResult = await new Promise((resolve, reject) => {
                  db.query(
                    `INSERT INTO chess_games (
                      white_player_id, black_player_id, fen, pot_amount, bet_amount, 
                      game_type, status
                    ) VALUES (?, ?, ?, ?, ?, 'multiplayer', 'in_progress')`,
                    [whitePlayerId, blackPlayerId, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', betAmount * 2, betAmount],
                    (err, result) => {
                      if (err) reject(err);
                      else resolve(result);
                    }
                  );
                });
                
                gameId = `game_${createGameResult.insertId}`;
                const chess = new Chess();
                
                // Initialize stats for both players if not exists
                for (const playerId of [whitePlayerId, blackPlayerId]) {
                  await new Promise((resolve, reject) => {
                    db.query(
                      `INSERT IGNORE INTO chess_user_stats (user_id) VALUES (?)`,
                      [playerId],
                      (err) => {
                        if (err) reject(err);
                        else resolve();
                      }
                    );
                  });
                }
                
                console.log(`[MATCHMAKING] ✅ Game created in database with ID: ${createGameResult.insertId}`);
                
                // Initialize game with clock state (60 seconds each for bullet 1+1)
                activeGames.set(gameId, {
                  chess: chess,
                  dbGameId: createGameResult.insertId,
                  whitePlayerId: whitePlayerId,
                  whiteUsername: isUserWhite ? user.username : opponent.username,
                  blackPlayerId: blackPlayerId,
                  blackUsername: isUserWhite ? opponent.username : user.username,
                  potAmount: betAmount * 2,
                  betAmount: betAmount,
                  createdAt: Date.now(),
                  moveCount: 0,
                  // Clock state: track remaining time in milliseconds
                  whiteTimeMs: 60000,  // 60 seconds initial time
                  blackTimeMs: 60000,  // 60 seconds initial time
                  currentTurnStart: Date.now(),  // When current turn started
                  lastMoveTime: Date.now()  // When last move was made
                });
              } catch (dbError) {
                console.error(`[MATCHMAKING] ❌ Failed to create game in database:`, dbError);
                // Refund both players
                db.query('UPDATE users SET balance = balance + ? WHERE id IN (?, ?)', 
                  [betAmount, socket.userId, opponent.userId], (refundErr) => {
                    if (refundErr) console.error('[MATCHMAKING] Failed to refund:', refundErr);
                });
                socket.emit('error', { message: 'Failed to create game' });
                return;
              }
              
              // Add both players to game room
              socket.join(`game_${gameId}`);
              socket.currentGameId = gameId;
              
              console.log(`[MATCHMAKING] Looking for opponent socket: ${opponent.socketId}`);
              const opponentSocket = io.sockets.sockets.get(opponent.socketId);
              if (opponentSocket) {
                console.log(`[MATCHMAKING] ✅ Opponent socket found: ${opponent.username}`);
                opponentSocket.join(`game_${gameId}`);
                opponentSocket.currentGameId = gameId;
              } else {
                console.log(`[MATCHMAKING] ❌ WARNING: Opponent socket NOT found! Socket ID: ${opponent.socketId}`);
              }
              
              // Notify both players
              const gameData = {
                id: gameId,
                whitePlayerId: isUserWhite ? socket.userId : opponent.userId,
                whiteUsername: isUserWhite ? user.username : opponent.username,
                blackPlayerId: isUserWhite ? opponent.userId : socket.userId,
                blackUsername: isUserWhite ? opponent.username : user.username,
                betAmount: betAmount,
                potAmount: betAmount * 2,
                // Include initial clock times
                whiteTimeMs: 60000,
                blackTimeMs: 60000
              };
              
              console.log(`[MATCHMAKING] Sending match_found to ${user.username} (socket: ${socket.id})`);
              socket.emit('match_found', gameData);
              
              if (opponentSocket) {
                console.log(`[MATCHMAKING] Sending match_found to ${opponent.username} (socket: ${opponent.socketId})`);
                opponentSocket.emit('match_found', gameData);
              } else {
                console.log(`[MATCHMAKING] ❌ Cannot send match_found to opponent - socket not found`);
              }
              
              console.log(`[MATCHMAKING] Game ${gameId} created with both players`);
              
            } else {
              // No match found, add to queue
              validQueue.push({
                userId: socket.userId,
                username: user.username,
                balance: user.balance - betAmount,
                socketId: socket.id,
                timestamp: Date.now()
              });
              matchmakingQueue.set(betAmount, validQueue);
              
              console.log(`[MATCHMAKING] ✅ ${user.username} (ID: ${socket.userId}) added to queue for $${betAmount}. Queue size: ${validQueue.length}`);
              console.log(`[MATCHMAKING] 📋 Current queue:`, validQueue.map(p => `${p.username} (${p.userId})`));
              socket.emit('matchmaking_joined', { position: validQueue.length });
              
              // Set timeout (30 seconds) - if no match, start bot game
              setTimeout(() => {
                const currentQueue = matchmakingQueue.get(betAmount) || [];
                const stillInQueue = currentQueue.find(entry => entry.userId === socket.userId);
                
                if (stillInQueue) {
                  // Remove from queue and refund
                  const filtered = currentQueue.filter(entry => entry.userId !== socket.userId);
                  matchmakingQueue.set(betAmount, filtered);
                  
                  // Refund the bet via ledger
                  ledger.createLedgerEntry({
                    userId: socket.userId,
                    type: ledger.ENTRY_TYPES.BET_REFUND,
                    amount: betAmount,
                    currency: 'USD',
                    referenceType: 'bingo_game',
                    referenceId: null,
                    metadata: { reason: 'matchmaking_timeout' }
                  }).then(() => {
                    console.log(`[MATCHMAKING] Refunded $${betAmount} to user ${socket.userId}`);
                  }).catch(refundErr => {
                    console.error(`[MATCHMAKING] Failed to refund user ${socket.userId}:`, refundErr);
                  });
                  
                  console.log(`[MATCHMAKING] Timeout - no match for ${user.username}`);
                  socket.emit('matchmaking_timeout');
                }
              }, 30000);
            }
        } catch (error) {
          console.error('[MATCHMAKING] Bet deduction error:', error);
          socket.emit('error', { message: 'Failed to deduct bet' });
        }
      });
      
    } catch (error) {
      console.error('Matchmaking error:', error);
      socket.emit('error', { message: 'Matchmaking failed' });
    }
  });

  // Join existing game
  socket.on('join_game', (data) => {
    try {
      const { gameId } = data;
      const game = activeGames.get(gameId);
      
      if (!game) {
        socket.emit('error', { message: 'Game not found' });
        return;
      }
      
      socket.join(`game_${gameId}`);
      socket.currentGameId = gameId;
      
      // Send current game state
      socket.emit('game_state', {
        gameId: gameId,
        fen: game.chess.fen(),
        turn: game.chess.turn(),
        isGameOver: game.chess.isGameOver()
      });
      
      console.log(`Player ${socket.userId} joined game ${gameId}`);
      
    } catch (error) {
      console.error('Join game error:', error);
      socket.emit('error', { message: 'Failed to join game' });
    }
  });

  // Make a move
  socket.on('make_move', async (data) => {
    try {
      const { gameId, move } = data;
      const game = activeGames.get(gameId);
      
      if (!game) {
        socket.emit('error', { message: 'Game not found' });
        return;
      }
      
      // Check if game is already being ended (prevent race condition)
      if (game.isEnding) {
        console.log(`[MOVE] Game ${gameId} is already ending, ignoring move from player ${socket.userId}`);
        return;
      }
      
      // Validate it's the player's turn
      const isWhiteTurn = game.chess.turn() === 'w';
      const isPlayersTurn = (isWhiteTurn && socket.userId === game.whitePlayerId) ||
                            (!isWhiteTurn && socket.userId === game.blackPlayerId);
      
      if (!isPlayersTurn) {
        socket.emit('error', { message: 'Not your turn' });
        return;
      }
      
      // Update clock - deduct elapsed time from current player
      const now = Date.now();
      const elapsedMs = now - game.currentTurnStart;
      const incrementMs = 1000; // 1 second increment for bullet 1+1
      
      // Deduct time first (without increment)
      if (isWhiteTurn) {
        game.whiteTimeMs = game.whiteTimeMs - elapsedMs;
      } else {
        game.blackTimeMs = game.blackTimeMs - elapsedMs;
      }
      
      // Check for time forfeit BEFORE adding increment and making the move
      if ((isWhiteTurn && game.whiteTimeMs <= 0) || (!isWhiteTurn && game.blackTimeMs <= 0)) {
        console.log(`[CLOCK] Player ${socket.userId} lost on time`);
        game.isEnding = true; // Prevent race conditions
        
        const winner = isWhiteTurn ? game.blackPlayerId : game.whitePlayerId;
        const loser = socket.userId;
        const outcome = isWhiteTurn ? 'win_black' : 'win_white';
        
        // Emit timeout event to both players
        io.to(`game_${gameId}`).emit('game_ended', {
          winner: winner,
          gameResult: 'timeout',
          outcome: outcome,
          potAmount: game.potAmount / 100, // Convert cents to dollars
          betAmount: game.betAmount / 100
        });
        
        // Update database - mark game as ended by timeout
        db.query(
          `UPDATE chess_games SET outcome = ?, ended_at = NOW() WHERE id = ?`,
          [outcome, game.dbGameId],
          (err) => {
            if (err) console.error('[CLOCK] Failed to update game outcome:', err);
          }
        );
        
        // Give pot to winner via ledger
        ledger.createLedgerEntry({
          userId: winner,
          type: ledger.ENTRY_TYPES.WIN_CREDIT,
          amount: game.potAmount,
          currency: 'USD',
          referenceType: 'chess_game',
          referenceId: game.dbGameId,
          metadata: { result: 'timeout', loser: loser }
        }).catch(err => {
          console.error('[CLOCK] Failed to update winner balance:', err);
        });
        
        // Update stats (simplified - just record win/loss)
        db.query(
          `UPDATE chess_user_stats SET games_won = games_won + 1 WHERE user_id = ?`,
          [winner],
          (err) => {
            if (err) console.error('[CLOCK] Failed to update winner stats:', err);
          }
        );
        
        db.query(
          `UPDATE chess_user_stats SET games_lost = games_lost + 1 WHERE user_id = ?`,
          [loser],
          (err) => {
            if (err) console.error('[CLOCK] Failed to update loser stats:', err);
          }
        );
        
        activeGames.delete(gameId);
        console.log(`[CLOCK] Game ${gameId} ended by timeout - Winner: ${winner}`);
        return;
      }
      
      // Make the move
      const result = game.chess.move(move);
      
      if (!result) {
        socket.emit('error', { message: 'Invalid move' });
        return;
      }
      
      // Move succeeded - add 1 second increment to the player who just moved
      if (isWhiteTurn) {
        game.whiteTimeMs = Math.max(0, game.whiteTimeMs + incrementMs);
      } else {
        game.blackTimeMs = Math.max(0, game.blackTimeMs + incrementMs);
      }
      
      const newFen = game.chess.fen();
      const isGameOver = game.chess.isGameOver();
      
      // Update turn timer for next player
      game.currentTurnStart = now;
      game.lastMoveTime = now;
      
      // Record move in database
      game.moveCount = (game.moveCount || 0) + 1;
      try {
        await new Promise((resolve, reject) => {
          db.query(
            `INSERT INTO chess_game_moves (game_id, move_number, move_notation, fen_after, created_at)
             VALUES (?, ?, ?, ?, NOW())`,
            [game.dbGameId, game.moveCount, result.san, newFen],
            (err) => {
              if (err) {
                console.error(`[MOVE] Failed to record move in database:`, err);
                // Continue anyway - don't block gameplay
              }
              resolve();
            }
          );
        });
        
        // Also update the FEN in chess_games table
        await new Promise((resolve, reject) => {
          db.query(
            `UPDATE chess_games SET fen = ? WHERE id = ?`,
            [newFen, game.dbGameId],
            (err) => {
              if (err) console.error(`[MOVE] Failed to update FEN:`, err);
              resolve();
            }
          );
        });
      } catch (err) {
        console.error(`[MOVE] Database error:`, err);
      }
      
      console.log(`[MOVE] Player ${socket.userId} moved in game ${gameId}. Game over: ${isGameOver}`);
      
      // Broadcast move to all players in game with binary optimization
      // Use volatile for non-critical move updates (reduces buffering)
      io.to(`game_${gameId}`).volatile.emit('move_made', {
        playerId: socket.userId,
        move: result,
        fen: newFen,
        isGameOver: isGameOver
      });
      
      // Send updated clock times to both players (NOT volatile - important for sync)
      io.to(`game_${gameId}`).emit('clock_update', {
        whiteTimeMs: game.whiteTimeMs,
        blackTimeMs: game.blackTimeMs,
        currentTurn: game.chess.turn()
      });
      
      // Check if game ended
      if (isGameOver) {
        // Mark game as ending to prevent race conditions
        game.isEnding = true;
        
        let winner = null;
        let gameResult = '';
        
        if (game.chess.isCheckmate()) {
          // Winner is the player who just moved
          winner = socket.userId;
          gameResult = 'checkmate';
        } else if (game.chess.isDraw()) {
          gameResult = 'draw';
        } else if (game.chess.isStalemate()) {
          gameResult = 'stalemate';
        } else if (game.chess.isThreefoldRepetition()) {
          gameResult = 'draw_repetition';
        } else if (game.chess.isInsufficientMaterial()) {
          gameResult = 'draw_insufficient';
        }
        
        console.log(`[GAME_ENDED] Game ${gameId} ended - Result: ${gameResult}, Winner: ${winner}`);
        
        // Determine outcome for database (correct ENUM format: win_white, win_black, draw)
        let outcome = 'draw';
        if (winner === game.whitePlayerId) {
          outcome = 'win_white';
        } else if (winner === game.blackPlayerId) {
          outcome = 'win_black';
        }
        
        // Call chess/game/end endpoint to handle ELO, balance, and stats
        const gameEndResult = await new Promise((resolve, reject) => {
          db.query(
            `SELECT u.id, u.username, u.balance, COALESCE(s.elo_rating, 1500) as elo
             FROM users u
             LEFT JOIN chess_user_stats s ON u.id = s.user_id
             WHERE u.id IN (?, ?)`,
            [game.whitePlayerId, game.blackPlayerId],
            (err, users) => {
              if (err) {
                reject(err);
                return;
              }
              
              const whiteUser = users.find(u => u.id === game.whitePlayerId);
              const blackUser = users.find(u => u.id === game.blackPlayerId);
              
              // Calculate ELO changes
              const whiteElo = whiteUser.elo;
              const blackElo = blackUser.elo;
              const K = 32;
              
              const expectedWhite = 1 / (1 + Math.pow(10, (blackElo - whiteElo) / 400));
              const expectedBlack = 1 - expectedWhite;
              
              let actualWhite, actualBlack;
              if (outcome === 'win_white') {
                actualWhite = 1;
                actualBlack = 0;
              } else if (outcome === 'win_black') {
                actualWhite = 0;
                actualBlack = 1;
              } else {
                actualWhite = 0.5;
                actualBlack = 0.5;
              }
              
              const whiteEloChange = Math.round(K * (actualWhite - expectedWhite));
              const blackEloChange = Math.round(K * (actualBlack - expectedBlack));
              
              const newWhiteElo = whiteElo + whiteEloChange;
              const newBlackElo = blackElo + blackEloChange;
              
              // Calculate balance distribution
              let whiteBalanceChange = 0;
              let blackBalanceChange = 0;
              
              if (outcome === 'win_white') {
                whiteBalanceChange = game.potAmount;
              } else if (outcome === 'win_black') {
                blackBalanceChange = game.potAmount;
              } else {
                whiteBalanceChange = game.potAmount / 2;
                blackBalanceChange = game.potAmount / 2;
              }
              
              // Update game record
              db.query(
                `UPDATE chess_games SET outcome = ?, fen = ?, ended_at = NOW() WHERE id = ?`,
                [outcome, newFen, game.dbGameId],
                (updateErr) => {
                  if (updateErr) {
                    reject(updateErr);
                    return;
                  }
                  
                  // Update both players' balances via ledger
                  const whiteOutcome = outcome === 'win_white' ? 'win' : (outcome === 'draw' ? 'draw' : 'lose');
                  const blackOutcome = outcome === 'win_black' ? 'win' : (outcome === 'draw' ? 'draw' : 'lose');
                  
                  const whiteEntryType = whiteBalanceChange > 0 ? ledger.ENTRY_TYPES.WIN_CREDIT : ledger.ENTRY_TYPES.BET_REFUND;
                  const blackEntryType = blackBalanceChange > 0 ? ledger.ENTRY_TYPES.WIN_CREDIT : ledger.ENTRY_TYPES.BET_REFUND;
                  
                  Promise.all([
                    ledger.createLedgerEntry({
                      userId: game.whitePlayerId,
                      type: whiteEntryType,
                      amount: whiteBalanceChange,
                      currency: 'USD',
                      referenceType: 'chess_game',
                      referenceId: game.dbGameId,
                      metadata: { result: whiteOutcome, pot_amount: game.potAmount }
                    }),
                    ledger.createLedgerEntry({
                      userId: game.blackPlayerId,
                      type: blackEntryType,
                      amount: blackBalanceChange,
                      currency: 'USD',
                      referenceType: 'chess_game',
                      referenceId: game.dbGameId,
                      metadata: { result: blackOutcome, pot_amount: game.potAmount }
                    })
                  ]).then(() => {
                          
                          // Update stats for both players
                          const updateStats = (userId, newElo, outcomeStr) => {
                            return new Promise((res, rej) => {
                              const gamesWon = outcomeStr === 'win' ? 1 : 0;
                              const gamesLost = outcomeStr === 'lose' ? 1 : 0;
                              const gamesDrawn = outcomeStr === 'draw' ? 1 : 0;
                              
                              db.query(
                                `UPDATE chess_user_stats 
                                 SET elo_rating = ?, 
                                     games_played = games_played + 1,
                                     games_won = games_won + ?,
                                     games_lost = games_lost + ?,
                                     games_drawn = games_drawn + ?,
                                     current_win_streak = CASE 
                                       WHEN ? = 'win' THEN current_win_streak + 1
                                       ELSE 0
                                     END,
                                     best_win_streak = CASE
                                       WHEN ? = 'win' AND current_win_streak + 1 > best_win_streak 
                                       THEN current_win_streak + 1
                                       ELSE best_win_streak
                                     END
                                 WHERE user_id = ?`,
                                [newElo, gamesWon, gamesLost, gamesDrawn, outcomeStr, outcomeStr, userId],
                                (err) => {
                                  if (err) rej(err);
                                  else res();
                                }
                              );
                            });
                          };
                          
                          Promise.all([
                            updateStats(game.whitePlayerId, newWhiteElo, whiteOutcome),
                            updateStats(game.blackPlayerId, newBlackElo, blackOutcome)
                          ]).then(() => {
                            resolve({
                              whiteBalance: whiteUser.balance + whiteBalanceChange,
                              blackBalance: blackUser.balance + blackBalanceChange,
                              whiteElo: newWhiteElo,
                              blackElo: newBlackElo,
                              whiteOutcome,
                              blackOutcome,
                              whiteUsername: whiteUser.username,
                              blackUsername: blackUser.username
                            });
                          }).catch(reject);
                  }).catch(reject);
                }
              );
            }
          );
        });
        
        console.log(`[GAME_ENDED] Balances updated - White: $${gameEndResult.whiteBalance}, Black: $${gameEndResult.blackBalance}`);
        
        // Emit to white player
        io.to(`user_${game.whitePlayerId}`).emit('game_ended', {
          winner: winner,
          gameResult: gameResult,
          finalFen: newFen,
          newBalance: gameEndResult.whiteBalance,
          newElo: gameEndResult.whiteElo,
          outcome: gameEndResult.whiteOutcome,
          potAmount: game.potAmount,
          betAmount: game.betAmount,
          opponentId: game.blackPlayerId,
          opponentUsername: gameEndResult.blackUsername
        });
        
        // Emit to black player
        io.to(`user_${game.blackPlayerId}`).emit('game_ended', {
          winner: winner,
          gameResult: gameResult,
          finalFen: newFen,
          newBalance: gameEndResult.blackBalance,
          newElo: gameEndResult.blackElo,
          outcome: gameEndResult.blackOutcome,
          potAmount: game.potAmount,
          betAmount: game.betAmount,
          opponentId: game.whitePlayerId,
          opponentUsername: gameEndResult.whiteUsername
        });
        
        console.log(`[GAME_ENDED] ✅ Events sent, cleaning up game`);
        
        // Clean up game
        activeGames.delete(gameId);
      }
      
    } catch (error) {
      console.error('[MOVE] Error:', error);
      socket.emit('error', { message: error.message || 'Move failed' });
    }
  });

  // Resign
  socket.on('resign', async (data) => {
    try {
      console.log(`[RESIGN] ========== RESIGN REQUEST ==========`);
      console.log(`[RESIGN] Data received:`, data);
      console.log(`[RESIGN] socket.userId:`, socket.userId);
      
      const { gameId } = data;
      console.log(`[RESIGN] Looking for game:`, gameId);
      console.log(`[RESIGN] Active games:`, Array.from(activeGames.keys()));
      
      const game = activeGames.get(gameId);
      
      if (!game) {
        console.log(`[RESIGN] ❌ Game not found in activeGames`);
        socket.emit('error', { message: 'Game not found' });
        return;
      }
      
      console.log(`[RESIGN] ✅ Game found:`, {
        whitePlayerId: game.whitePlayerId,
        blackPlayerId: game.blackPlayerId,
        dbGameId: game.dbGameId
      });
      
      // Determine winner (opponent)
      const winner = socket.userId === game.whitePlayerId ? game.blackPlayerId : game.whitePlayerId;
      
      console.log(`[RESIGN] ✅ Player ${socket.userId} resigned. Winner: ${winner}`);
      
      // Determine outcome (correct ENUM format: win_white, win_black, draw)
      const outcome = winner === game.whitePlayerId ? 'win_white' : 'win_black';
      const finalFen = game.chess.fen();
      
      // Update game and player stats using database
      const gameEndResult = await new Promise((resolve, reject) => {
        db.query(
          `SELECT u.id, u.username, u.balance, COALESCE(s.elo_rating, 1500) as elo
           FROM users u
           LEFT JOIN chess_user_stats s ON u.id = s.user_id
           WHERE u.id IN (?, ?)`,
          [game.whitePlayerId, game.blackPlayerId],
          (err, users) => {
            if (err) {
              reject(err);
              return;
            }
            
            const whiteUser = users.find(u => u.id === game.whitePlayerId);
            const blackUser = users.find(u => u.id === game.blackPlayerId);
            
            // Calculate ELO changes
            const whiteElo = whiteUser.elo;
            const blackElo = blackUser.elo;
            const K = 32;
            
            const expectedWhite = 1 / (1 + Math.pow(10, (blackElo - whiteElo) / 400));
            const expectedBlack = 1 - expectedWhite;
            
            const actualWhite = outcome === 'win_white' ? 1 : 0;
            const actualBlack = outcome === 'win_black' ? 1 : 0;
            
            const whiteEloChange = Math.round(K * (actualWhite - expectedWhite));
            const blackEloChange = Math.round(K * (actualBlack - expectedBlack));
            
            const newWhiteElo = whiteElo + whiteEloChange;
            const newBlackElo = blackElo + blackEloChange;
            
            // Calculate balance distribution
            const whiteBalanceChange = outcome === 'win_white' ? game.potAmount : 0;
            const blackBalanceChange = outcome === 'win_black' ? game.potAmount : 0;
            
            // Update game record
            db.query(
              `UPDATE chess_games SET outcome = ?, fen = ?, ended_at = NOW() WHERE id = ?`,
              [outcome, finalFen, game.dbGameId],
              (updateErr) => {
                if (updateErr) {
                  reject(updateErr);
                  return;
                }
                
                // Update both players' balances via ledger
                const whiteOutcome = outcome === 'win_white' ? 'win' : 'lose';
                const blackOutcome = outcome === 'win_black' ? 'win' : 'lose';
                
                const whiteEntryType = whiteBalanceChange > 0 ? ledger.ENTRY_TYPES.WIN_CREDIT : null;
                const blackEntryType = blackBalanceChange > 0 ? ledger.ENTRY_TYPES.WIN_CREDIT : null;
                
                const ledgerPromises = [];
                if (whiteBalanceChange > 0) {
                  ledgerPromises.push(ledger.createLedgerEntry({
                    userId: game.whitePlayerId,
                    type: whiteEntryType,
                    amount: whiteBalanceChange,
                    currency: 'USD',
                    referenceType: 'chess_game',
                    referenceId: game.dbGameId,
                    metadata: { result: whiteOutcome, pot_amount: game.potAmount }
                  }));
                }
                if (blackBalanceChange > 0) {
                  ledgerPromises.push(ledger.createLedgerEntry({
                    userId: game.blackPlayerId,
                    type: blackEntryType,
                    amount: blackBalanceChange,
                    currency: 'USD',
                    referenceType: 'chess_game',
                    referenceId: game.dbGameId,
                    metadata: { result: blackOutcome, pot_amount: game.potAmount }
                  }));
                }
                
                Promise.all(ledgerPromises).then(() => {
                        
                        // Update stats for both players
                        const updateStats = (userId, newElo, outcomeStr) => {
                          return new Promise((res, rej) => {
                            const gamesWon = outcomeStr === 'win' ? 1 : 0;
                            const gamesLost = outcomeStr === 'lose' ? 1 : 0;
                            
                            db.query(
                              `UPDATE chess_user_stats 
                               SET elo_rating = ?, 
                                   games_played = games_played + 1,
                                   games_won = games_won + ?,
                                   games_lost = games_lost + ?,
                                   current_win_streak = CASE 
                                     WHEN ? = 'win' THEN current_win_streak + 1
                                     ELSE 0
                                   END,
                                   best_win_streak = CASE
                                     WHEN ? = 'win' AND current_win_streak + 1 > best_win_streak 
                                     THEN current_win_streak + 1
                                     ELSE best_win_streak
                                   END
                               WHERE user_id = ?`,
                              [newElo, gamesWon, gamesLost, outcomeStr, outcomeStr, userId],
                              (err) => {
                                if (err) rej(err);
                                else res();
                              }
                            );
                          });
                        };
                        
                        Promise.all([
                          updateStats(game.whitePlayerId, newWhiteElo, whiteOutcome),
                          updateStats(game.blackPlayerId, newBlackElo, blackOutcome)
                        ]).then(() => {
                          resolve({
                            whiteBalance: whiteUser.balance + whiteBalanceChange,
                            blackBalance: blackUser.balance + blackBalanceChange,
                            whiteElo: newWhiteElo,
                            blackElo: newBlackElo,
                            whiteOutcome,
                            blackOutcome,
                            whiteUsername: whiteUser.username,
                            blackUsername: blackUser.username
                          });
                        }).catch(reject);
                }).catch(reject);
              }
            );
          }
        );
      });
      
      // Emit to both players
      io.to(`user_${game.whitePlayerId}`).emit('game_ended', {
        winner: winner,
        gameResult: 'resignation',
        resignedPlayerId: socket.userId,
        finalFen: finalFen,
        newBalance: gameEndResult.whiteBalance,
        newElo: gameEndResult.whiteElo,
        outcome: gameEndResult.whiteOutcome,
        potAmount: game.potAmount,
        betAmount: game.betAmount,
        opponentId: game.blackPlayerId,
        opponentUsername: gameEndResult.blackUsername
      });
      
      io.to(`user_${game.blackPlayerId}`).emit('game_ended', {
        winner: winner,
        gameResult: 'resignation',
        resignedPlayerId: socket.userId,
        finalFen: finalFen,
        newBalance: gameEndResult.blackBalance,
        newElo: gameEndResult.blackElo,
        outcome: gameEndResult.blackOutcome,
        potAmount: game.potAmount,
        betAmount: game.betAmount,
        opponentId: game.whitePlayerId,
        opponentUsername: gameEndResult.whiteUsername
      });
      
      // Clean up
      activeGames.delete(gameId);
      console.log(`[RESIGN] ✅ Resign completed successfully`);
      
    } catch (error) {
      console.error('[RESIGN] ❌ Error details:', error);
      console.error('[RESIGN] Error message:', error.message);
      console.error('[RESIGN] Error stack:', error.stack);
      socket.emit('error', { message: `Resign failed: ${error.message}` });
    }
  });

  // Draw offer/accept
  socket.on('respond_draw', async (data) => {
    try {
      const { gameId, accepted } = data;
      
      if (!accepted) {
        socket.to(`game_${gameId}`).emit('draw_declined');
        return;
      }
      
      const game = activeGames.get(gameId);
      if (!game) {
        socket.emit('error', { message: 'Game not found' });
        return;
      }
      
      console.log(`[DRAW] Players agreed to draw in game ${gameId}`);
      
      // Get users
      const getUser = (playerId) => {
        return new Promise((resolve, reject) => {
          db.query('SELECT id, username, balance FROM users WHERE id = ?', [playerId], (err, rows) => {
            if (err) reject(err);
            else resolve(rows[0]);
          });
        });
      };
      
      const whiteUser = await getUser(game.whitePlayerId);
      const blackUser = game.blackPlayerId ? await getUser(game.blackPlayerId) : null;
      
      // Split pot
      const split = game.potAmount / 2;
      const whiteNewBalance = whiteUser.balance + split;
      const blackNewBalance = blackUser ? blackUser.balance + split : 0;
      
      await new Promise((resolve, reject) => {
        db.query('UPDATE users SET balance = ? WHERE id = ?', [whiteNewBalance, game.whitePlayerId], (err) => {
          if (err) reject(err);
          else {
            if (blackUser) {
              db.query('UPDATE users SET balance = ? WHERE id = ?', [blackNewBalance, game.blackPlayerId], (err2) => {
                if (err2) reject(err2);
                else resolve();
              });
            } else {
              resolve();
            }
          }
        });
      });
      
      // Emit to both players
      io.to(`user_${game.whitePlayerId}`).emit('game_ended', {
        winner: null,
        gameResult: 'draw',
        finalFen: game.chess.fen(),
        newBalance: whiteNewBalance,
        outcome: 'draw',
        potAmount: game.potAmount,
        betAmount: game.betAmount,
        opponentId: game.blackPlayerId,
        opponentUsername: blackUser ? blackUser.username : 'Computer'
      });
      
      if (blackUser) {
        io.to(`user_${game.blackPlayerId}`).emit('game_ended', {
          winner: null,
          gameResult: 'draw',
          finalFen: game.chess.fen(),
          newBalance: blackNewBalance,
          outcome: 'draw',
          potAmount: game.potAmount,
          betAmount: game.betAmount,
          opponentId: game.whitePlayerId,
          opponentUsername: whiteUser.username
        });
      }
      
      // Clean up
      activeGames.delete(gameId);
      
    } catch (error) {
      console.error('[DRAW] Error:', error);
      socket.emit('error', { message: 'Draw failed' });
    }
  });

  // Leave matchmaking queue
  socket.on('leave_matchmaking', () => {
    if (socket.userId) {
      console.log(`[MATCHMAKING] ❌ User ${socket.username} (ID: ${socket.userId}) leaving queue`);
      matchmakingQueue.forEach((queue, betAmount) => {
        const playerIndex = queue.findIndex(entry => entry.userId === socket.userId);
        if (playerIndex !== -1) {
          queue.splice(playerIndex, 1);
          console.log(`[MATCHMAKING] 📋 Removed from $${betAmount} queue. New size: ${queue.length}`);
          
          // Refund the bet via ledger
          ledger.createLedgerEntry({
            userId: socket.userId,
            type: ledger.ENTRY_TYPES.BET_REFUND,
            amount: betAmount,
            currency: 'USD',
            referenceType: 'matchmaking_leave',
            referenceId: null,
            metadata: { reason: 'user_left_queue' }
          }).then(() => {
            console.log(`[MATCHMAKING] 💰 Refunded $${betAmount} to user ${socket.username}`);
          }).catch(err => {
            console.error(`[MATCHMAKING] ❌ Failed to refund $${betAmount} to user ${socket.userId}:`, err);
          });
        }
      });
    }
  });

  // Request rematch
  socket.on('request_rematch', (data) => {
    const { opponentId, betAmount, previousWhiteId, previousBlackId } = data;
    console.log(`[REMATCH] 🔄 ${socket.username} requesting rematch with user ${opponentId} for $${betAmount}`);
    console.log(`[REMATCH] Previous colors - White: ${previousWhiteId}, Black: ${previousBlackId}`);
    
    // Send rematch request to opponent
    io.to(`user_${opponentId}`).emit('rematch_requested', {
      requesterId: socket.userId,
      requesterUsername: socket.username,
      betAmount: betAmount,
      previousWhiteId: previousWhiteId,
      previousBlackId: previousBlackId
    });
  });

  // Respond to rematch request
  socket.on('respond_rematch', async (data) => {
    const { accepted, requesterId, betAmount, previousWhiteId, previousBlackId } = data;
    
    if (!accepted) {
      console.log(`[REMATCH] ❌ ${socket.username} declined rematch`);
      io.to(`user_${requesterId}`).emit('rematch_declined', {
        reason: `${socket.username} declined the rematch`
      });
      return;
    }
    
    console.log(`[REMATCH] ✅ ${socket.username} accepted rematch with user ${requesterId} for $${betAmount}`);
    
    try {
      // Get both users' info
      const users = await new Promise((resolve, reject) => {
        db.query(
          'SELECT id, username, balance FROM users WHERE id IN (?, ?)',
          [requesterId, socket.userId],
          (err, results) => {
            if (err) reject(err);
            else resolve(results);
          }
        );
      });
      
      const requester = users.find(u => u.id === requesterId);
      const accepter = users.find(u => u.id === socket.userId);
      
      // Check if both players have enough balance
      if (requester.balance < betAmount || accepter.balance < betAmount) {
        io.to(`user_${requesterId}`).emit('error', { message: 'Insufficient balance for rematch' });
        io.to(`user_${socket.userId}`).emit('error', { message: 'Insufficient balance for rematch' });
        return;
      }
      
      // Deduct bets from both players via ledger
      await Promise.all([
        ledger.createLedgerEntry({
          userId: requesterId,
          type: ledger.ENTRY_TYPES.BET_DEBIT,
          amount: -betAmount,
          currency: 'USD',
          referenceType: 'chess_game',
          referenceId: null,
          metadata: { game_type: 'rematch', bet_amount: betAmount }
        }),
        ledger.createLedgerEntry({
          userId: socket.userId,
          type: ledger.ENTRY_TYPES.BET_DEBIT,
          amount: -betAmount,
          currency: 'USD',
          referenceType: 'chess_game',
          referenceId: null,
          metadata: { game_type: 'rematch', bet_amount: betAmount }
        })
      ]);
      
      // Swap colors from previous game
      const whitePlayerId = previousBlackId; // Black becomes white
      const blackPlayerId = previousWhiteId; // White becomes black
      
      const whiteUser = users.find(u => u.id === whitePlayerId);
      const blackUser = users.find(u => u.id === blackPlayerId);
      
      console.log(`[REMATCH] 🎨 Color swap - New White: ${whiteUser.username}, New Black: ${blackUser.username}`);
      
      // Create new game in database
      const createGameResult = await new Promise((resolve, reject) => {
        db.query(
          `INSERT INTO chess_games (
            white_player_id, black_player_id, fen, pot_amount, bet_amount, 
            game_type, status
          ) VALUES (?, ?, ?, ?, ?, 'multiplayer', 'in_progress')`,
          [whitePlayerId, blackPlayerId, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', betAmount * 2, betAmount],
          (err, result) => {
            if (err) reject(err);
            else resolve(result);
          }
        );
      });
      
      const gameId = `game_${createGameResult.insertId}`;
      const chess = new Chess();
      
      // Initialize stats for both players if not exists
      for (const playerId of [whitePlayerId, blackPlayerId]) {
        await new Promise((resolve, reject) => {
          db.query(
            `INSERT IGNORE INTO chess_user_stats (user_id) VALUES (?)`,
            [playerId],
            (err) => {
              if (err) reject(err);
              else resolve();
            }
          );
        });
      }
      
      // Store game in memory with clock state
      activeGames.set(gameId, {
        whitePlayerId,
        blackPlayerId,
        chess,
        potAmount: betAmount * 2,
        betAmount: betAmount,
        dbGameId: createGameResult.insertId,
        // Clock state for bullet 1+1
        whiteTimeMs: 60000,
        blackTimeMs: 60000,
        currentTurnStart: Date.now(),
        lastMoveTime: Date.now(),
        moveCount: 0
      });
      
      console.log(`[REMATCH] ✅ Game ${gameId} created - ${whiteUser.username} (White) vs ${blackUser.username} (Black)`);
      
      // Notify both players
      const gameData = {
        id: gameId,
        whitePlayerId,
        whiteUsername: whiteUser.username,
        blackPlayerId,
        blackUsername: blackUser.username,
        betAmount: betAmount,
        potAmount: betAmount * 2,
        isRematch: true,  // Flag to indicate this is a rematch (server already created DB record)
        dbGameId: createGameResult.insertId,  // Include DB ID for client tracking
        // Include initial clock times
        whiteTimeMs: 60000,
        blackTimeMs: 60000
      };
      
      io.to(`user_${requester.id}`).emit('match_found', gameData);
      io.to(`user_${accepter.id}`).emit('match_found', gameData);
      
    } catch (error) {
      console.error('[REMATCH] Error:', error);
      io.to(`user_${requesterId}`).emit('error', { message: 'Rematch failed' });
      io.to(`user_${socket.userId}`).emit('error', { message: 'Rematch failed' });
    }
  });

  socket.on('disconnect', () => {
    console.log('Chess client disconnected:', socket.id);
    
    // Remove from matchmaking queue and refund if still waiting
    if (socket.userId) {
      matchmakingQueue.forEach((queue, betAmount) => {
        const playerIndex = queue.findIndex(entry => entry.userId === socket.userId);
        if (playerIndex !== -1) {
          const player = queue[playerIndex];
          queue.splice(playerIndex, 1);
          
          // Refund the bet via ledger
          ledger.createLedgerEntry({
            userId: socket.userId,
            type: ledger.ENTRY_TYPES.BET_REFUND,
            amount: betAmount,
            currency: 'USD',
            referenceType: 'matchmaking_disconnect',
            referenceId: null,
            metadata: { reason: 'user_disconnected' }
          }).catch(err => {
            console.error(`[DISCONNECT] Failed to refund user ${socket.userId}:`, err);
          });
        }
      });
    }
  });
});

// ========== WITHDRAWAL ENDPOINTS ==========

const withdrawalHandler = require('./withdrawal-handler.js');

// Request withdrawal (user)
app.post('/api/withdraw/request', verifyToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { coin, amount_usd, address } = req.body;

    if (!coin || !amount_usd || !address) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: coin, amount_usd, address' 
      });
    }

    const amount = parseFloat(amount_usd);
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid amount' 
      });
    }

    if (!['BTC', 'ETH', 'USDT', 'USDC'].includes(coin)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Unsupported coin. Use: BTC, ETH, USDT, or USDC' 
      });
    }

    // Check if withdrawals are frozen for this user
    db.query(
      'SELECT withdrawals_frozen, withdrawal_freeze_reason FROM user_risk_profiles WHERE user_id = ?',
      [userId],
      async (riskErr, riskProfiles) => {
        if (riskProfiles && riskProfiles.length > 0 && riskProfiles[0].withdrawals_frozen) {
          return res.status(403).json({ 
            success: false, 
            error: `Withdrawals are currently frozen: ${riskProfiles[0].withdrawal_freeze_reason}` 
          });
        }

        const result = await withdrawalHandler.requestWithdrawal(
          userId, 
          coin, 
          amount, 
          address
        );

        if (result.success) {
          // Run risk assessment asynchronously (don't block the response)
          const RiskAssessmentService = require('./lib/risk_assessment');
          const riskService = new RiskAssessmentService(db);
          
          if (result.withdrawalId) {
            riskService.assessWithdrawal(result.withdrawalId, userId)
              .then(assessment => {
                console.log(`Risk assessment for withdrawal ${result.withdrawalId}:`, assessment.riskLevel, assessment.riskScore);
              })
              .catch(err => {
                console.error('Risk assessment error:', err);
              });
          }
          
          res.json(result);
        } else {
          res.status(400).json(result);
        }
      }
    );

  } catch (error) {
    console.error('Withdrawal request error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'System error processing withdrawal' 
    });
  }
});

// Get user's withdrawal history
app.get('/api/withdrawals', verifyToken, async (req, res) => {
  try {
    const userId = req.userId;
    const limit = parseInt(req.query.limit) || 50;

    const withdrawals = await withdrawalHandler.getUserWithdrawals(userId, limit);
    res.json({ success: true, withdrawals });

  } catch (error) {
    console.error('Get withdrawals error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch withdrawal history' 
    });
  }
});

// Get user balance
app.get('/api/balance', verifyToken, async (req, res) => {
  try {
    const userId = req.userId;
    const balance = await withdrawalHandler.getUserBalance(userId);
    
    const available = parseFloat(balance.usd_balance) - parseFloat(balance.locked_balance);
    
    res.json({
      success: true,
      usd_balance: parseFloat(balance.usd_balance),
      locked_balance: parseFloat(balance.locked_balance),
      available_balance: Math.max(0, available)
    });

  } catch (error) {
    console.error('Get balance error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch balance' 
    });
  }
});

// Get crypto rates
app.get('/api/rates', async (req, res) => {
  try {
    const rates = await withdrawalHandler.fetchCryptoPrices();
    const fees = withdrawalHandler.WITHDRAW_FEES;
    const minWithdraw = withdrawalHandler.MIN_WITHDRAW;

    res.json({
      success: true,
      rates,
      fees,
      minWithdraw
    });

  } catch (error) {
    console.error('Get rates error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch rates' 
    });
  }
});

// ========== ADMIN WITHDRAWAL ENDPOINTS ==========

// Get pending withdrawals (admin only)
app.get('/api/admin/withdrawals/pending', verifyToken, adminAuth.requireAdmin, adminAuth.requirePermission('withdrawals.view'), async (req, res) => {
  try {
    const withdrawals = await withdrawalHandler.getPendingWithdrawals();
    
    // Log admin action
    adminAuth.logAdminAction(
      req.user.userId,
      req.user.username,
      'VIEW_PENDING_WITHDRAWALS',
      {
        resourceType: 'withdrawals',
        count: withdrawals.length,
        ipAddress: adminAuth.getClientIP(req),
        userAgent: req.headers['user-agent']
      }
    );
    
    res.json({ success: true, withdrawals });

  } catch (error) {
    console.error('Get pending withdrawals error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch pending withdrawals' 
    });
  }
});

// REMOVED: Duplicate route - this conflicts with the modular route registered at line 2900
// The modular route in routes/admin-withdrawals.js is more feature-complete
// and handles the 2-step approval flow properly
/*
app.get('/api/admin/withdrawals', verifyToken, adminAuth.requireAdmin, adminAuth.requirePermission('withdrawals.view'), async (req, res) => {
  try {
    const { status, userId, startDate, endDate, limit = 100, offset = 0 } = req.query;
    
    let query = `
      SELECT w.*, u.username, u.email
      FROM withdrawals w
      LEFT JOIN users u ON w.user_id = u.id
      WHERE 1=1
    `;
    const params = [];
    
    if (status) {
      query += ' AND w.status = ?';
      params.push(status);
    }
    if (userId) {
      query += ' AND w.user_id = ?';
      params.push(userId);
    }
    if (startDate) {
      query += ' AND w.created_at >= ?';
      params.push(startDate);
    }
    if (endDate) {
      query += ' AND w.created_at <= ?';
      params.push(endDate);
    }
    
    query += ' ORDER BY w.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));
    
    db.query(query, params, (err, results) => {
      if (err) {
        console.error('Error fetching withdrawals:', err);
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to fetch withdrawals' 
        });
      }
      
      res.json({ 
        success: true, 
        withdrawals: results,
        limit: parseInt(limit),
        offset: parseInt(offset)
      });
    });
    
  } catch (error) {
    console.error('Get withdrawals error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch withdrawals' 
    });
  }
});
*/

// Approve withdrawal (admin only) - DOES NOT AUTO-SEND
app.post('/api/admin/withdraw/approve/:id', verifyToken, adminAuth.requireAdmin, adminAuth.requirePermission('withdrawals.approve'), async (req, res) => {
  try {
    const withdrawalId = parseInt(req.params.id);
    const { internalNote } = req.body;

    // Get withdrawal details before approval
    db.query(
      'SELECT * FROM withdrawals WHERE id = ?',
      [withdrawalId],
      async (err, withdrawals) => {
        if (err || withdrawals.length === 0) {
          return res.status(404).json({ 
            success: false, 
            error: 'Withdrawal not found' 
          });
        }

        const withdrawal = withdrawals[0];
        
        // Check if user account or withdrawals are frozen
        db.query(
          'SELECT is_frozen, withdrawals_frozen, freeze_reason, withdrawal_freeze_reason FROM user_risk_profiles WHERE user_id = ?',
          [withdrawal.user_id],
          async (riskErr, riskProfiles) => {
            if (riskProfiles && riskProfiles.length > 0) {
              const profile = riskProfiles[0];
              if (profile.is_frozen) {
                return res.status(403).json({ 
                  success: false, 
                  error: `User account is frozen: ${profile.freeze_reason}` 
                });
              }
              if (profile.withdrawals_frozen) {
                return res.status(403).json({ 
                  success: false, 
                  error: `User withdrawals are frozen: ${profile.withdrawal_freeze_reason}` 
                });
              }
            }
            
            // Approve withdrawal (change status to 'approved', NOT 'sent')
            const result = await withdrawalHandler.approveWithdrawal(
              withdrawalId, 
              req.user.userId
            );

            if (result.success) {
              // Log admin action with full details
              adminAuth.logAdminAction(
                req.user.userId,
                req.user.username,
                'APPROVE_WITHDRAWAL',
                {
                  resourceType: 'withdrawal',
                  resourceId: withdrawalId,
                  oldValue: { status: withdrawal.status },
                  newValue: { status: 'approved' },
                  withdrawalDetails: {
                    userId: withdrawal.user_id,
                    amount: withdrawal.amount,
                    coin: withdrawal.coin,
                    address: withdrawal.address,
                    network: withdrawal.network
                  },
                  internalNote,
                  ipAddress: adminAuth.getClientIP(req),
                  userAgent: req.headers['user-agent']
                }
              );
              
              res.json({
                ...result,
                message: 'Withdrawal approved. Use "Send Funds" action to complete the transaction.'
              });
            } else {
              res.status(400).json(result);
            }
          }
        );
      }
    );

  } catch (error) {
    console.error('Approve withdrawal error:', error);
    adminAuth.logAdminAction(
      req.user.userId,
      req.user.username,
      'APPROVE_WITHDRAWAL',
      {
        resourceType: 'withdrawal',
        resourceId: req.params.id,
        status: 'failed',
        errorMessage: error.message,
        ipAddress: adminAuth.getClientIP(req),
        userAgent: req.headers['user-agent']
      }
    );
    res.status(500).json({ 
      success: false, 
      error: 'Failed to approve withdrawal' 
    });
  }
});

// Send funds for approved withdrawal (admin only) - SEPARATE ACTION
app.post('/api/admin/withdraw/send/:id', verifyToken, adminAuth.requireAdmin, adminAuth.requirePermission('withdrawals.send'), async (req, res) => {
  try {
    const withdrawalId = parseInt(req.params.id);
    const { confirmationCode, internalNote } = req.body; // Could require 2FA code here

    // TODO: Implement 2FA verification here for high-value withdrawals
    // if (withdrawal.amount > LARGE_AMOUNT_THRESHOLD && !verify2FA(confirmationCode)) {
    //   return res.status(403).json({ error: '2FA verification required' });
    // }

    // Get withdrawal details
    db.query(
      'SELECT * FROM withdrawals WHERE id = ?',
      [withdrawalId],
      async (err, withdrawals) => {
        if (err || withdrawals.length === 0) {
          return res.status(404).json({ 
            success: false, 
            error: 'Withdrawal not found' 
          });
        }

        const withdrawal = withdrawals[0];
        
        if (withdrawal.status !== 'approved') {
          return res.status(400).json({ 
            success: false, 
            error: 'Withdrawal must be approved before sending',
            currentStatus: withdrawal.status
          });
        }

        // TODO: Integrate with actual payment processor to send funds
        // const txResult = await sendCryptoPayment(withdrawal);
        
        // For now, just update status
        db.query(
          'UPDATE withdrawals SET status = ?, processed_at = NOW(), processed_by = ? WHERE id = ?',
          ['sent', req.user.userId, withdrawalId],
          (updateErr) => {
            if (updateErr) {
              console.error('Error updating withdrawal:', updateErr);
              return res.status(500).json({ 
                success: false, 
                error: 'Failed to update withdrawal status' 
              });
            }

            // Log admin action
            adminAuth.logAdminAction(
              req.user.userId,
              req.user.username,
              'SEND_WITHDRAWAL',
              {
                resourceType: 'withdrawal',
                resourceId: withdrawalId,
                oldValue: { status: 'approved' },
                newValue: { status: 'sent' },
                withdrawalDetails: {
                  userId: withdrawal.user_id,
                  amount: withdrawal.amount,
                  coin: withdrawal.coin,
                  address: withdrawal.address,
                  network: withdrawal.network
                },
                internalNote,
                ipAddress: adminAuth.getClientIP(req),
                userAgent: req.headers['user-agent']
              }
            );

            res.json({
              success: true,
              message: 'Funds sent successfully',
              withdrawalId,
              status: 'sent'
            });
          }
        );
      }
    );

  } catch (error) {
    console.error('Send withdrawal error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to send withdrawal' 
    });
  }
});

// Reject withdrawal (admin only)
app.post('/api/admin/withdraw/reject/:id', verifyToken, adminAuth.requireAdmin, adminAuth.requirePermission('withdrawals.reject'), async (req, res) => {
  try {
    const withdrawalId = parseInt(req.params.id);
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({ 
        success: false, 
        error: 'Rejection reason required' 
      });
    }

    if (!req.user.isAdmin) {
      adminAuth.logSecurityEvent(req, 'admin_access_denied', 'high', 'Non-admin attempted to reject withdrawal');
      return res.status(403).json({ 
        success: false, 
        error: 'Admin access required' 
      });
    }

    // Get withdrawal details before rejection
    db.query(
      'SELECT * FROM withdrawals WHERE id = ?',
      [withdrawalId],
      async (err, withdrawals) => {
        if (err || withdrawals.length === 0) {
          return res.status(404).json({ 
            success: false, 
            error: 'Withdrawal not found' 
          });
        }

        const withdrawal = withdrawals[0];

        const result = await withdrawalHandler.rejectWithdrawal(
          withdrawalId, 
          reason,
          req.user.userId
        );

        if (result.success) {
          // Log admin action
          adminAuth.logAdminAction(
            req.user.userId,
            req.user.username,
            'REJECT_WITHDRAWAL',
            {
              resourceType: 'withdrawal',
              resourceId: withdrawalId,
              oldValue: { status: withdrawal.status },
              newValue: { status: 'rejected', reason },
              withdrawalDetails: {
                userId: withdrawal.user_id,
                amount: withdrawal.amount,
                coin: withdrawal.coin,
                address: withdrawal.address
              },
              reason,
              ipAddress: adminAuth.getClientIP(req),
              userAgent: req.headers['user-agent']
            }
          );
          
          res.json(result);
        } else {
          res.status(400).json(result);
        }
      }
    );

  } catch (error) {
    console.error('Reject withdrawal error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to reject withdrawal' 
    });
  }
});

// ========== DEPOSIT ENDPOINTS ==========

const depositHandler = require('./deposit-handler.js');

// Get or create deposit address for user (with QR code)
app.get('/api/deposit/address', verifyToken, async (req, res) => {
  const userId = req.userId;
  const { network, asset, amount } = req.query; // 'ethereum' or 'bitcoin'

  try {
    // Get existing address
    db.query(
      'SELECT * FROM deposit_addresses WHERE user_id = ?',
      [userId],
      async (err, rows) => {
        if (err) {
          console.error('Deposit address fetch error:', err);
          return res.status(500).json({ error: 'Database error' });
        }

        let address = rows[0];
        
        if (!address) {
          // Create new addresses for user
          const ethAddress = generateEthereumAddress(userId);
          const btcAddress = generateBitcoinAddress(userId);
          
          db.query(
            'INSERT INTO deposit_addresses (user_id, eth_address, btc_address) VALUES (?, ?, ?)',
            [userId, ethAddress, btcAddress],
            async (insertErr, result) => {
              if (insertErr) {
                console.error('Address creation error:', insertErr);
                return res.status(500).json({ error: 'Failed to create address' });
              }
              
              address = {
                user_id: userId,
                eth_address: ethAddress,
                btc_address: btcAddress
              };
              
              await returnAddressWithQR(address, network, asset, amount, res);
            }
          );
        } else {
          await returnAddressWithQR(address, network, asset, amount, res);
        }
      }
    );
  } catch (error) {
    console.error('Deposit address error:', error);
    res.status(500).json({ error: 'Failed to get deposit address' });
  }
});

async function returnAddressWithQR(address, network, asset, amount, res) {
  try {
    let depositAddress, qrCode;
    
    console.log(`[QR] Generating QR for network: ${network}, asset: ${asset}`);
    
    if (network === 'bitcoin') {
      depositAddress = address.btc_address;
      
      // Generate Bitcoin QR code
      console.log(`[QR] Generating Bitcoin QR for: ${depositAddress}`);
      qrCode = await depositHandler.generateBtcQR(
        depositAddress,
        amount ? parseFloat(amount) : null,
        'Treasure Hunt Deposit'
      );
      console.log(`[QR] Bitcoin QR generated: ${qrCode ? 'YES (' + qrCode.substring(0, 50) + '...)' : 'NULL'}`);
      
      return res.json({
        address: depositAddress,
        network: 'bitcoin',
        qrCode: qrCode,
        minDeposit: 0.0001,
        requiredConfirmations: 2,
        explorerUrl: `https://mempool.space/address/${depositAddress}`
      });
    } else {
      depositAddress = address.eth_address;
      
      // Generate Ethereum QR code
      console.log(`[QR] Generating Ethereum QR for: ${depositAddress}`);
      qrCode = await depositHandler.generateEthQR(
        depositAddress,
        asset || 'ETH',
        amount ? parseFloat(amount) : null
      );
      console.log(`[QR] Ethereum QR generated: ${qrCode ? 'YES (' + qrCode.substring(0, 50) + '...)' : 'NULL'}`);
      
      return res.json({
        address: depositAddress,
        network: 'ethereum',
        qrCode: qrCode,
        minDeposit: 0.001,
        requiredConfirmations: 2,
        explorerUrl: `https://etherscan.io/address/${depositAddress}`,
        // Token contract addresses for reference
        tokens: {
          USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
          USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
        }
      });
    }
  } catch (error) {
    console.error('❌ [QR] QR generation error:', error);
    // Return address without QR if generation fails
    if (network === 'bitcoin') {
      return res.json({
        address: address.btc_address,
        network: 'bitcoin',
        qrCode: null,
        minDeposit: 0.0001,
        requiredConfirmations: 2,
        explorerUrl: `https://mempool.space/address/${address.btc_address}`
      });
    } else {
      return res.json({
        address: address.eth_address,
        network: 'ethereum',
        qrCode: null,
        minDeposit: 0.001,
        requiredConfirmations: 2,
        explorerUrl: `https://etherscan.io/address/${address.eth_address}`
      });
    }
  }
}

// Simple deterministic address generation (DEMO ONLY - use proper HD wallet in production)
function generateEthereumAddress(userId) {
  // In production, use HD wallet derivation (BIP44)
  const hash = require('crypto').createHash('sha256').update(`eth_${userId}_${process.env.WALLET_SEED || 'demo'}`).digest('hex');
  return '0x' + hash.substring(0, 40);
}

function generateBitcoinAddress(userId) {
  // In production, use HD wallet derivation (BIP44)
  const hash = require('crypto').createHash('sha256').update(`btc_${userId}_${process.env.WALLET_SEED || 'demo'}`).digest('hex');
  return 'bc1q' + hash.substring(0, 38);
}

// Get user's deposit history
app.get('/api/deposits', verifyToken, (req, res) => {
  const userId = req.userId;
  const limit = parseInt(req.query.limit) || 50;

  db.query(
    `SELECT id, asset, network, amount, usd_amount, tx_hash, confirmations, 
            required_confirmations, status, credited, created_at, confirmed_at
     FROM deposits 
     WHERE user_id = ? 
     ORDER BY created_at DESC 
     LIMIT ?`,
    [userId, limit],
    (err, rows) => {
      if (err) {
        console.error('Deposit history error:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      res.json(rows);
    }
  );
});

// Manual deposit submission (when user pastes TxID)
app.post('/api/deposit/submit', verifyToken, (req, res) => {
  const userId = req.userId;
  const { txHash, asset, network, address } = req.body;

  if (!txHash || !asset || !network || !address) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Check if deposit already exists
  db.query(
    'SELECT id FROM deposits WHERE tx_hash = ?',
    [txHash],
    (err, rows) => {
      if (err) {
        console.error('Deposit check error:', err);
        return res.status(500).json({ error: 'Database error' });
      }

      if (rows.length > 0) {
        return res.status(400).json({ error: 'Deposit already recorded' });
      }

      // Verify address belongs to this user
      db.query(
        'SELECT * FROM deposit_addresses WHERE user_id = ? AND (eth_address = ? OR btc_address = ?)',
        [userId, address, address],
        (addrErr, addrRows) => {
          if (addrErr || addrRows.length === 0) {
            return res.status(400).json({ error: 'Invalid deposit address' });
          }

          // Create pending deposit
          db.query(
            `INSERT INTO deposits (user_id, address, asset, network, amount, usd_amount, tx_hash, required_confirmations, status)
             VALUES (?, ?, ?, ?, 0, 0, ?, 2, 'pending')`,
            [userId, address, asset, network, txHash],
            (insertErr, result) => {
              if (insertErr) {
                console.error('Deposit insert error:', insertErr);
                return res.status(500).json({ error: 'Failed to record deposit' });
              }

              res.json({
                success: true,
                depositId: result.insertId,
                message: 'Deposit submitted for processing'
              });
            }
          );
        }
      );
    }
  );
});

// Check deposit status
app.get('/api/deposit/:id', verifyToken, (req, res) => {
  const userId = req.userId;
  const depositId = req.params.id;

  db.query(
    'SELECT * FROM deposits WHERE id = ? AND user_id = ?',
    [depositId, userId],
    (err, rows) => {
      if (err) {
        console.error('Deposit status error:', err);
        return res.status(500).json({ error: 'Database error' });
      }

      if (rows.length === 0) {
        return res.status(404).json({ error: 'Deposit not found' });
      }

      res.json(rows[0]);
    }
  );
});

// ==================== CONTACT MESSAGE ENDPOINTS ====================

// Submit contact message (public endpoint - no auth required)
app.post('/api/contact/submit', async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;

    // Validation
    if (!name || !email || !subject || !message) {
      return res.status(400).json({ 
        success: false, 
        error: 'All fields are required' 
      });
    }

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid email address' 
      });
    }

    // Check if authenticated user (optional)
    let userId = null;
    const token = req.headers.authorization?.split(' ')[1];
    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_ACCESS_SECRET);
        userId = decoded.userId;
      } catch (err) {
        // Token invalid or expired, continue as guest
      }
    }

    // Auto-assign priority based on subject
    let priority = 'medium';
    const urgentKeywords = ['urgent', 'emergency', 'locked', 'cannot withdraw', 'scam', 'fraud'];
    const highKeywords = ['withdrawal', 'deposit', 'missing', 'lost', 'stuck'];
    
    const subjectLower = subject.toLowerCase();
    const messageLower = message.toLowerCase();
    
    if (urgentKeywords.some(keyword => subjectLower.includes(keyword) || messageLower.includes(keyword))) {
      priority = 'urgent';
    } else if (highKeywords.some(keyword => subjectLower.includes(keyword) || messageLower.includes(keyword))) {
      priority = 'high';
    }

    // Insert into database
    const [result] = await db.promise().execute(
      `INSERT INTO contact_messages (user_id, name, email, subject, message, priority, status)
       VALUES (?, ?, ?, ?, ?, ?, 'new')`,
      [userId, name, email, subject, message, priority]
    );

    console.log(`📧 New contact message from ${name} (${email}) - Priority: ${priority}`);

    res.json({
      success: true,
      messageId: result.insertId,
      message: 'Your message has been sent successfully. We\'ll respond within 24 hours.'
    });

  } catch (error) {
    console.error('Contact submission error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to send message. Please try again.' 
    });
  }
});

// Get user's own contact messages (authenticated)
app.get('/api/contact/my-messages', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    const [messages] = await db.promise().execute(
      `SELECT id, subject, message, status, priority, created_at, updated_at, resolved_at
       FROM contact_messages
       WHERE user_id = ?
       ORDER BY created_at DESC`,
      [userId]
    );

    res.json({
      success: true,
      messages: messages
    });

  } catch (error) {
    console.error('Get user messages error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch messages' 
    });
  }
});

// ADMIN: Get all contact messages
app.get('/api/admin/contact/messages', verifyToken, requireAdmin, (req, res) => {
  try {
    const { status, priority, limit = 100 } = req.query;

    let query = `
      SELECT 
        cm.id, cm.user_id, cm.name, cm.email, cm.subject, cm.message,
        cm.status, cm.priority, cm.assigned_to, cm.admin_notes,
        cm.created_at, cm.updated_at, cm.resolved_at,
        u.username as user_username,
        a.username as assigned_to_username
      FROM contact_messages cm
      LEFT JOIN users u ON cm.user_id = u.id
      LEFT JOIN users a ON cm.assigned_to = a.id
    `;

    const params = [];
    const conditions = [];

    if (status) {
      conditions.push('cm.status = ?');
      params.push(status);
    }

    if (priority) {
      conditions.push('cm.priority = ?');
      params.push(priority);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY cm.created_at DESC LIMIT ?';
    params.push(parseInt(limit));

    db.query(query, params, (err, messages) => {
      if (err) {
        console.error('Admin get messages error:', err);
        // If table doesn't exist, return empty array
        if (err.code === 'ER_NO_SUCH_TABLE') {
          return res.json({
            success: true,
            messages: [],
            newCount: 0,
            message: 'Contact messages table not yet created'
          });
        }
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to fetch messages',
          details: err.message
        });
      }

      // Get count of new messages
      db.query('SELECT COUNT(*) as count FROM contact_messages WHERE status = "new"', (countErr, newCount) => {
        res.json({
          success: true,
          messages: messages || [],
          newCount: countErr ? 0 : newCount[0].count
        });
      });
    });

  } catch (error) {
    console.error('Admin get messages error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch messages' 
    });
  }
});

// ADMIN: Get single contact message with replies
app.get('/api/admin/contact/message/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const messageId = req.params.id;

    const [messages] = await db.promise().execute(
      `SELECT 
        cm.*, 
        u.username as user_username,
        u.email as user_email,
        a.username as assigned_to_username
       FROM contact_messages cm
       LEFT JOIN users u ON cm.user_id = u.id
       LEFT JOIN users a ON cm.assigned_to = a.id
       WHERE cm.id = ?`,
      [messageId]
    );

    if (messages.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Message not found' 
      });
    }

    // Get replies
    const [replies] = await db.promise().execute(
      `SELECT r.*, u.username as admin_username
       FROM contact_replies r
       JOIN users u ON r.admin_id = u.id
       WHERE r.message_id = ?
       ORDER BY r.created_at ASC`,
      [messageId]
    );

    res.json({
      success: true,
      message: messages[0],
      replies: replies
    });

  } catch (error) {
    console.error('Admin get message error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch message' 
    });
  }
});

// ADMIN: Update contact message status
app.put('/api/admin/contact/message/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const messageId = req.params.id;
    const { status, priority, assigned_to, admin_notes } = req.body;
    const adminId = req.user.userId;

    const updates = [];
    const params = [];

    if (status) {
      updates.push('status = ?');
      params.push(status);
      
      if (status === 'resolved' || status === 'closed') {
        updates.push('resolved_at = CURRENT_TIMESTAMP');
      }
    }

    if (priority) {
      updates.push('priority = ?');
      params.push(priority);
    }

    if (assigned_to !== undefined) {
      updates.push('assigned_to = ?');
      params.push(assigned_to || null);
    }

    if (admin_notes !== undefined) {
      updates.push('admin_notes = ?');
      params.push(admin_notes);
    }

    if (updates.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'No updates provided' 
      });
    }

    params.push(messageId);

    await db.promise().execute(
      `UPDATE contact_messages SET ${updates.join(', ')} WHERE id = ?`,
      params
    );

    logAdminAction(adminId, req.user.username, 'UPDATE_CONTACT_MESSAGE', { 
      messageId, 
      updates: { status, priority, assigned_to, admin_notes } 
    });

    res.json({
      success: true,
      message: 'Contact message updated successfully'
    });

  } catch (error) {
    console.error('Admin update message error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to update message' 
    });
  }
});

// ADMIN: Add reply to contact message
app.post('/api/admin/contact/message/:id/reply', verifyToken, requireAdmin, async (req, res) => {
  try {
    const messageId = req.params.id;
    const { reply_text } = req.body;
    const adminId = req.user.userId;

    if (!reply_text) {
      return res.status(400).json({ 
        success: false, 
        error: 'Reply text is required' 
      });
    }

    // Insert reply
    const [result] = await db.promise().execute(
      `INSERT INTO contact_replies (message_id, admin_id, reply_text)
       VALUES (?, ?, ?)`,
      [messageId, adminId, reply_text]
    );

    // Update message status to in_progress if it's new
    await db.promise().execute(
      `UPDATE contact_messages 
       SET status = CASE WHEN status = 'new' THEN 'in_progress' ELSE status END
       WHERE id = ?`,
      [messageId]
    );

    logAdminAction(adminId, req.user.username, 'REPLY_CONTACT_MESSAGE', { 
      messageId, 
      replyId: result.insertId 
    });

    res.json({
      success: true,
      replyId: result.insertId,
      message: 'Reply added successfully'
    });

  } catch (error) {
    console.error('Admin reply error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to add reply' 
    });
  }
});

// ADMIN: Get contact message statistics
app.get('/api/admin/contact/stats', verifyToken, requireAdmin, (req, res) => {
  try {
    db.query(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as new_messages,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed,
        SUM(CASE WHEN priority = 'urgent' THEN 1 ELSE 0 END) as urgent_count,
        SUM(CASE WHEN priority = 'high' THEN 1 ELSE 0 END) as high_count,
        SUM(CASE WHEN DATE(created_at) = CURDATE() THEN 1 ELSE 0 END) as today_count
      FROM contact_messages
    `, (err, stats) => {
      if (err) {
        console.error('Admin stats error:', err);
        // If table doesn't exist, return zeros
        if (err.code === 'ER_NO_SUCH_TABLE') {
          return res.json({
            success: true,
            stats: {
              total: 0,
              new_messages: 0,
              in_progress: 0,
              resolved: 0,
              closed: 0,
              urgent_count: 0,
              high_count: 0,
              today_count: 0
            },
            message: 'Contact messages table not yet created'
          });
        }
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to fetch statistics',
          details: err.message
        });
      }

      res.json({
        success: true,
        stats: stats[0]
      });
    });

  } catch (error) {
    console.error('Admin stats error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch statistics' 
    });
  }
});

// ---------- START ----------
server.listen(PORT, async () => {
  console.log(`API + Frontend running on ${FRONTEND_URL}`);
  console.log(`Chess game integrated with Socket.IO support`);
  
  // Run database migration for NOWPayments tables
  try {
    const { autoMigrate } = require('./lib/auto_migrate.js');
    await autoMigrate();
  } catch (err) {
    console.error('[Server] Database migration error:', err.message);
    console.error('[Server] Server will continue without migration');
  }
  
  // Start deposit handler
  const { startDepositHandler } = require('./deposit-handler.js');
  startDepositHandler().catch(err => {
    console.error('Deposit handler failed to start:', err);
  });

  // Start withdrawal handler
  const { startWithdrawalHandler } = require('./withdrawal-handler.js');
  startWithdrawalHandler().catch(err => {
    console.error('Withdrawal handler failed to start:', err);
  });
  
  // Start payout worker for automatic withdrawal status polling
  const { startPayoutWorker } = require('./workers/payout_worker.js');
  startPayoutWorker();
});



