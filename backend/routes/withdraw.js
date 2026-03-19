// backend/routes/withdraw.js
// Withdrawal request endpoints (CommonJS)

const express = require('express');
const { pool, formatAtomic, decimalsFor, atomicToDecimal } = require('../lib/mysql_pool');
const { validateAddress, getWithdrawalFee } = require('../lib/nowpayments_payouts');

const withdrawRouter = express.Router();

// Network mappings for NOWPayments
const NETWORK_CURRENCY = {
  'bitcoin': 'btc',
  'ethereum': 'eth',
  'usdt-erc20': 'usdterc20',
  'usdt-trc20': 'usdttrc20',
  'usdc-ethereum': 'usdcerc20',
  'usdc-polygon': 'usdcmatic',
};

const ASSET_NETWORKS = {
  'BTC': ['bitcoin'],
  'ETH': ['ethereum'],
  'USDT': ['usdt-erc20', 'usdt-trc20'],
  'USDC': ['usdc-ethereum', 'usdc-polygon'],
};

// Minimum withdrawal amounts (USD equivalent)
const MIN_WITHDRAWAL = {
  'BTC': 20,
  'ETH': 20,
  'USDT': 20,
  'USDC': 20,
};

/**
 * Middleware: Extract user from JWT token
 */
function withdrawAuth(req, res, next) {
  const jwt = require('jsonwebtoken');
  const JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
  if (!JWT_ACCESS_SECRET) {
    console.error('[SECURITY] JWT_ACCESS_SECRET not set — refusing to authenticate');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }
  
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_ACCESS_SECRET);
    req.user = { id: decoded.id || decoded.userId };
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * POST /api/withdraw/request
 * Request a withdrawal (locks funds)
 */
withdrawRouter.post('/request', withdrawAuth, async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    const { asset, network, amount, to_address } = req.body;
    
    // Validation
    if (!asset || !network || !amount || !to_address) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    if (!['BTC', 'ETH', 'USDT', 'USDC'].includes(asset)) {
      return res.status(400).json({ error: 'Invalid asset' });
    }
    
    if (!ASSET_NETWORKS[asset].includes(network)) {
      return res.status(400).json({ 
        error: 'Invalid network for asset',
        validNetworks: ASSET_NETWORKS[asset]
      });
    }
    
    const amountNum = parseFloat(amount);
    if (amountNum <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    
    // Check minimum
    const minAmount = MIN_WITHDRAWAL[asset] || 20;
    if (amountNum < minAmount) {
      return res.status(400).json({ 
        error: `Minimum withdrawal is $${minAmount}`,
        minimum: minAmount
      });
    }
    
    // Validate address with NOWPayments
    const currency = NETWORK_CURRENCY[network] || asset.toLowerCase();
    const addressValidation = await validateAddress(currency, to_address);
    if (!addressValidation.valid) {
      return res.status(400).json({ 
        error: 'Invalid address',
        message: addressValidation.message
      });
    }
    
    // Get estimated fee
    const feeInfo = await getWithdrawalFee(currency, amountNum);
    
    // Convert to atomic
    const decimals = decimalsFor(asset);
    const amountAtomic = BigInt(Math.floor(amountNum * Math.pow(10, decimals)));
    const feeAtomic = BigInt(Math.floor(feeInfo.fee * Math.pow(10, decimals)));
    const totalAtomic = amountAtomic + feeAtomic;
    
    await connection.beginTransaction();
    
    // Lock funds atomically
    const [lockResult] = await connection.query(
      `UPDATE balances 
       SET available_atomic = available_atomic - ?,
           locked_atomic = locked_atomic + ?
       WHERE user_id = ? AND asset = ? AND available_atomic >= ?
       LIMIT 1`,
      [totalAtomic.toString(), totalAtomic.toString(), req.user.id, asset, totalAtomic.toString()]
    );
    
    if (lockResult.affectedRows === 0) {
      await connection.rollback();
      return res.status(400).json({ 
        error: 'Insufficient balance',
        required: atomicToDecimal(totalAtomic.toString(), decimals),
        fee: feeInfo.fee
      });
    }
    
    // Create withdrawal record
    const [insertResult] = await connection.query(
      `INSERT INTO withdrawals 
        (user_id, asset, network, to_address, amount_atomic, fee_atomic, status)
       VALUES (?, ?, ?, ?, ?, ?, 'requested')`,
      [req.user.id, asset, network, to_address, amountAtomic.toString(), feeAtomic.toString()]
    );
    
    await connection.commit();
    
    console.log(`[Withdraw] Request created: id=${insertResult.insertId}, user=${req.user.id}, amount=${amountNum} ${asset}`);
    
    res.json({
      withdrawalId: insertResult.insertId,
      asset,
      network,
      amount: amountNum,
      fee: feeInfo.fee,
      total: atomicToDecimal(totalAtomic.toString(), decimals),
      to_address,
      status: 'requested',
      message: 'Withdrawal request submitted. Awaiting admin approval.'
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('[Withdraw] Request error:', error);
    res.status(500).json({ 
      error: 'Failed to create withdrawal request',
      message: error.message 
    });
  } finally {
    connection.release();
  }
});

/**
 * GET /api/withdraw/history
 * Get user's withdrawal history
 */
withdrawRouter.get('/history', withdrawAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, asset, network, to_address, 
              amount_atomic, fee_atomic, status,
              provider_payout_id, rejection_reason,
              created_at, updated_at, completed_at
       FROM withdrawals
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    
    const withdrawals = rows.map(row => ({
      id: row.id,
      asset: row.asset,
      network: row.network,
      to_address: row.to_address,
      amount: atomicToDecimal(row.amount_atomic, decimalsFor(row.asset)),
      fee: atomicToDecimal(row.fee_atomic, decimalsFor(row.asset)),
      status: row.status,
      payoutId: row.provider_payout_id,
      rejectionReason: row.rejection_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    }));
    
    res.json({ withdrawals });
    
  } catch (error) {
    console.error('[Withdraw] History error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch withdrawal history',
      message: error.message 
    });
  }
});

/**
 * GET /api/withdraw/config
 * Get withdrawal configuration
 */
withdrawRouter.get('/config', async (req, res) => {
  try {
    res.json({
      minimums: MIN_WITHDRAWAL,
      networks: ASSET_NETWORKS,
      assets: Object.keys(ASSET_NETWORKS),
    });
  } catch (error) {
    console.error('[Withdraw] Config error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch config',
      message: error.message 
    });
  }
});

module.exports = withdrawRouter;
