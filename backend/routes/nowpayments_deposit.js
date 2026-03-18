// backend/routes/nowpayments_deposit.js
// Deposit routes using NOWPayments (CommonJS)

const express = require('express');
const jwt = require('jsonwebtoken');
const { pool, getUserBalance, formatAtomic, decimalsFor } = require('../lib/mysql_pool');
const { nowpCreatePayment, nowpGetPayment, nowpGetMinAmount } = require('../lib/nowpayments');

const depositRouter = express.Router();
const JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'your_secret_key';

/**
 * Currency mapping: internal asset codes to NOWPayments currency codes
 * Important: Verify these match your NOWPayments account settings
 * Some accounts may require specific network codes like "usdterc20" or "usdcbep20"
 */
const PAY_CURRENCY = {
  BTC: 'btc',
  ETH: 'eth',
  USDT: 'usdt',     // May need to be 'usdterc20' for ERC20-specific
  USDC: 'usdc',     // May need to be 'usdcbep20' for BEP20-specific
};

/**
 * Authentication middleware - uses JWT tokens
 * Falls back to temporary x-user-id for testing
 */
function depositAuth(req, res, next) {
  // Try JWT first
  const header = req.header('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_ACCESS_SECRET);
      req.user = { id: decoded.userId || decoded.id, username: decoded.username };
      return next();
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  }
  
  // Fallback to x-user-id header for testing (remove in production)
  const tempId = req.headers['x-user-id'];
  if (tempId) {
    const userId = Number(tempId);
    if (Number.isFinite(userId)) {
      console.warn(`[SECURITY] Using temporary auth for user ${userId}`);
      req.user = { id: userId, username: `user_${userId}` };
      return next();
    }
  }
  
  return res.status(401).json({ error: 'Authentication required' });
}

/**
 * GET /api/deposit/address
 * Get deposit address for a specific asset
 * Note: For NOWPayments, addresses are generated per payment, not static
 * This endpoint returns info about how to create a payment instead
 */
depositRouter.get('/address', depositAuth, async (req, res) => {
  try {
    const { network, asset } = req.query;
    
    if (!asset) {
      return res.status(400).json({ error: 'Asset parameter is required' });
    }

    // For NOWPayments, we don't have static addresses
    // Return a message that user needs to create a payment
    res.json({
      message: 'Dynamic address generation',
      info: 'Create a payment to get a unique deposit address',
      asset: asset,
      network: network || 'auto',
      // Provide a placeholder for UI
      address: 'Create a deposit to generate address',
      qrCode: null,
      note: 'Each deposit generates a unique address for security'
    });

  } catch (error) {
    console.error('[Deposit] Address error:', error);
    res.status(500).json({ 
      error: 'Failed to get address',
      message: error.message 
    });
  }
});

/**
 * POST /api/deposit/create
 * Create a new deposit payment with NOWPayments
 * 
 * Body:
 * - asset: string (BTC, ETH, USDT, USDC)
 * - amountUsd: number (amount in USD)
 * 
 * Response:
 * - paymentId: number
 * - asset: string
 * - payCurrency: string
 * - payAddress: string
 * - payAmount: number
 * - status: string
 * - expiresAt: string
 */
depositRouter.post('/create', depositAuth, async (req, res) => {
  try {
    const { asset, amountUsd } = req.body || {};

    // Validate asset
    if (!asset || !PAY_CURRENCY[asset]) {
      return res.status(400).json({ 
        error: 'Invalid asset. Supported: BTC, ETH, USDT, USDC' 
      });
    }

    // Validate amount
    const amt = Number(amountUsd);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ 
        error: 'Invalid amountUsd. Must be positive number' 
      });
    }

    // Construct IPN callback URL
    const publicBaseUrl = process.env.PUBLIC_BASE_URL || 'https://treasure-backend-dtgf.onrender.com';
    const ipnUrl = `${publicBaseUrl}/api/nowpayments/ipn`;

    // Generate unique order ID
    const orderId = `dep_${req.user.id}_${Date.now()}`;

    console.log(`[Deposit] Creating payment: user=${req.user.id}, asset=${asset}, amount=$${amt}`);

    // Create payment with NOWPayments
    const payment = await nowpCreatePayment({
      price_amount: amt,
      price_currency: 'usd',
      pay_currency: PAY_CURRENCY[asset],
      ipn_callback_url: ipnUrl,
      order_id: orderId,
      order_description: `Deposit ${asset} for user ${req.user.id}`,
    });

    // Save deposit intent to database
    await pool.query(
      `INSERT INTO deposit_intents
        (user_id, provider, payment_id, pay_currency, price_amount, price_currency, pay_amount, pay_address, status)
       VALUES (?, 'nowpayments', ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         pay_amount = VALUES(pay_amount),
         pay_address = VALUES(pay_address),
         status = VALUES(status),
         updated_at = CURRENT_TIMESTAMP`,
      [
        req.user.id,
        payment.payment_id,
        payment.pay_currency,
        payment.price_amount,
        payment.price_currency,
        payment.pay_amount || null,
        payment.pay_address || null,
        payment.payment_status || 'created',
      ]
    );

    console.log(`[Deposit] Payment created: paymentId=${payment.payment_id}, address=${payment.pay_address}`);

    res.json({
      paymentId: payment.payment_id,
      asset,
      payCurrency: payment.pay_currency,
      payAddress: payment.pay_address,
      payAmount: payment.pay_amount,
      status: payment.payment_status,
      expiresAt: payment.expiration_estimate_date || null,
    });
    
  } catch (error) {
    console.error('[Deposit] Create payment error:', error);
    res.status(500).json({ 
      error: 'Failed to create payment',
      message: error.message 
    });
  }
});

/**
 * GET /api/deposit/status?paymentId=123
 * Get payment status (polls NOWPayments as fallback)
 * Primary crediting happens via IPN webhook
 */
depositRouter.get('/status', depositAuth, async (req, res) => {
  try {
    const paymentId = Number(req.query.paymentId);
    if (!Number.isFinite(paymentId)) {
      return res.status(400).json({ error: 'Invalid paymentId' });
    }

    // Check if payment belongs to user
    const [rows] = await pool.query(
      `SELECT user_id, status FROM deposit_intents
       WHERE provider = 'nowpayments' AND payment_id = ? AND user_id = ? LIMIT 1`,
      [paymentId, req.user.id]
    );

    if (!rows[0]) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    // Fetch latest status from NOWPayments (fallback polling)
    const payment = await nowpGetPayment(paymentId);

    // Update local cache
    await pool.query(
      `UPDATE deposit_intents
       SET status = ?, 
           pay_amount = COALESCE(?, pay_amount), 
           pay_address = COALESCE(?, pay_address)
       WHERE provider = 'nowpayments' AND payment_id = ?`,
      [payment.payment_status, payment.pay_amount || null, payment.pay_address || null, paymentId]
    );

    res.json({
      paymentId,
      paymentStatus: payment.payment_status,
      payAddress: payment.pay_address || null,
      payAmount: payment.pay_amount || null,
      actuallyPaid: payment.actually_paid || null,
      confirmations: payment.outcome_amount || null,
      outcomeAmount: payment.outcome_amount || null,
    });
    
  } catch (error) {
    console.error('[Deposit] Status check error:', error);
    res.status(500).json({ 
      error: 'Failed to check payment status',
      message: error.message 
    });
  }
});

/**
 * GET /api/deposit/recent
 * Get recent deposits for authenticated user
 */
depositRouter.get('/recent', depositAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT payment_id AS paymentId, 
              pay_currency AS payCurrency, 
              pay_amount AS payAmount,
              pay_address AS payAddress, 
              status, 
              price_amount AS priceAmount,
              created_at AS createdAt
       FROM deposit_intents
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 20`,
      [req.user.id]
    );

    res.json({ items: rows });
    
  } catch (error) {
    console.error('[Deposit] Recent deposits error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch recent deposits',
      message: error.message 
    });
  }
});

/**
 * GET /api/deposit/balances
 * Get all crypto balances for authenticated user
 */
depositRouter.get('/balances', depositAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT asset, available_atomic, locked_atomic
       FROM balances
       WHERE user_id = ?`,
      [req.user.id]
    );

    // Format atomic values to human-readable decimals
    const balances = rows.map(row => ({
      asset: row.asset,
      available: formatAtomic(row.available_atomic, decimalsFor(row.asset)),
      locked: formatAtomic(row.locked_atomic, decimalsFor(row.asset)),
      availableAtomic: row.available_atomic,
      lockedAtomic: row.locked_atomic,
    }));

    res.json({ balances });
    
  } catch (error) {
    console.error('[Deposit] Balances error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch balances',
      message: error.message 
    });
  }
});

/**
 * GET /api/deposit/health
 * Check if database tables exist
 */
depositRouter.get('/health', async (req, res) => {
  try {
    const [tables] = await pool.query('SHOW TABLES');
    const tableNames = tables.map(t => Object.values(t)[0]);
    const hasDepositIntents = tableNames.includes('deposit_intents');
    const hasBalances = tableNames.includes('balances');
    
    res.json({ 
      status: 'ok',
      database: 'connected',
      tables: {
        deposit_intents: hasDepositIntents,
        balances: hasBalances
      },
      allTables: tableNames
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'error',
      error: error.message 
    });
  }
});

/**
 * GET /api/deposit/config
 * Get deposit configuration (minimum amounts, supported currencies)
 */
depositRouter.get('/config', async (req, res) => {
  try {
    const config = {
      supportedAssets: Object.keys(PAY_CURRENCY),
      currencies: PAY_CURRENCY,
      minimums: {
        BTC: 10,
        ETH: 10,
        USDT: 10,
        USDC: 10,
      },
      confirmations: {
        BTC: 2,
        ETH: 12,
        USDT: 12,
        USDC: 12,
      },
    };

    res.json(config);
    
  } catch (error) {
    console.error('[Deposit] Config error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch config',
      message: error.message 
    });
  }
});

/**
 * GET /api/deposit/history
 * Get user's deposit transaction history
 */
depositRouter.get('/history', depositAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 50;

    // Check if deposit_intents table exists
    const [tables] = await pool.query("SHOW TABLES LIKE 'deposit_intents'");
    
    if (tables.length === 0) {
      // Table doesn't exist, return empty array
      return res.json({ 
        success: true,
        deposits: []
      });
    }

    const [deposits] = await pool.execute(
      `SELECT 
        id, 
        pay_currency as asset, 
        pay_amount as amount, 
        price_amount as usd_value,
        status, 
        NULL as tx_hash, 
        pay_currency as network,
        created_at, 
        updated_at
      FROM deposit_intents 
      WHERE user_id = ? AND provider = 'nowpayments'
      ORDER BY created_at DESC 
      LIMIT ?`,
      [userId, limit]
    );

    res.json({ 
      success: true,
      deposits: deposits || []
    });

  } catch (error) {
    console.error('[Deposit] History error:', error);
    // Return empty array instead of error to avoid breaking the UI
    res.json({ 
      success: true,
      deposits: []
    });
  }
});

module.exports = depositRouter;
