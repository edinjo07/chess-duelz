// backend/routes/admin_withdraw.js
// Admin withdrawal approval endpoints (CommonJS)

const express = require('express');
const jwt = require('jsonwebtoken');
const { pool, atomicToDecimal, decimalsFor } = require('../lib/mysql_pool');
const { createPayout, verifyPayout, getPayoutStatus } = require('../lib/nowpayments_payouts');

const adminWithdrawRouter = express.Router();

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'http://localhost:4000';

// Network mappings for NOWPayments
const NETWORK_CURRENCY = {
  'bitcoin': 'btc',
  'ethereum': 'eth',
  'usdt-erc20': 'usdterc20',
  'usdt-trc20': 'usdttrc20',
  'usdc-ethereum': 'usdcerc20',
  'usdc-polygon': 'usdcmatic',
};

/**
 * Middleware: Admin authentication — requires a valid admin token (ADMIN_JWT_SECRET, isAdminToken: true)
 */
function adminAuth(req, res, next) {
  const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'admin_secret_change_me_in_production';
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(403).json({ error: 'Admin token required' });
  }

  try {
    const decoded = jwt.verify(token, ADMIN_JWT_SECRET);
    if (!decoded.isAdminToken) {
      return res.status(403).json({ error: 'Forbidden: Not a valid admin token' });
    }
    req.admin = { id: decoded.adminId, username: decoded.username };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired admin token' });
  }
}

/**
 * GET /api/admin/withdrawals
 * List all withdrawal requests
 */
adminWithdrawRouter.get('/withdrawals', adminAuth, async (req, res) => {
  try {
    const status = req.query.status || null;
    
    let query = `
      SELECT w.id, w.user_id, w.asset, w.network, w.to_address,
             w.amount_atomic, w.fee_atomic, w.status,
             w.provider_payout_id, w.provider_batch_id, w.rejection_reason,
             w.created_at, w.updated_at, w.completed_at,
             u.username, u.email
      FROM withdrawals w
      LEFT JOIN users u ON w.user_id = u.id
    `;
    
    const params = [];
    if (status) {
      query += ' WHERE w.status = ?';
      params.push(status);
    }
    
    query += ' ORDER BY w.created_at DESC LIMIT 100';
    
    const [rows] = await pool.query(query, params);
    
    const withdrawals = rows.map(row => ({
      id: row.id,
      userId: row.user_id,
      username: row.username,
      email: row.email,
      asset: row.asset,
      network: row.network,
      to_address: row.to_address,
      amount: atomicToDecimal(row.amount_atomic, decimalsFor(row.asset)),
      fee: atomicToDecimal(row.fee_atomic, decimalsFor(row.asset)),
      status: row.status,
      payoutId: row.provider_payout_id,
      batchId: row.provider_batch_id,
      rejectionReason: row.rejection_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    }));
    
    res.json({ withdrawals });
    
  } catch (error) {
    console.error('[Admin] List withdrawals error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch withdrawals',
      message: error.message 
    });
  }
});

/**
 * POST /api/admin/withdrawals/:id/approve
 * Approve and process withdrawal with 2FA verification
 */
adminWithdrawRouter.post('/withdrawals/:id/approve', adminAuth, async (req, res) => {
  const withdrawalId = req.params.id;
  const { skip2FA } = req.body; // Option to skip auto-verification for manual dashboard approval
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    // Get withdrawal details
    const [rows] = await connection.query(
      `SELECT * FROM withdrawals WHERE id = ? AND status = 'requested' FOR UPDATE`,
      [withdrawalId]
    );
    
    if (rows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Withdrawal not found or already processed' });
    }
    
    const withdrawal = rows[0];
    const currency = NETWORK_CURRENCY[withdrawal.network] || withdrawal.asset.toLowerCase();
    const amount = atomicToDecimal(withdrawal.amount_atomic, decimalsFor(withdrawal.asset));
    
    console.log(`[Admin] Approving withdrawal ${withdrawalId}: ${amount} ${withdrawal.asset} to ${withdrawal.to_address}`);
    
    // Update to creating status
    await connection.query(
      `UPDATE withdrawals SET status = 'creating', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [withdrawalId]
    );
    
    await connection.commit();
    connection.release();
    
    // Create payout with NOWPayments
    const payoutResult = await createPayout({
      withdrawals: [{
        address: withdrawal.to_address,
        currency,
        amount: amount.toString(),
        extraId: withdrawalId.toString(),
      }]
    });
    
    const payoutId = payoutResult.id || payoutResult.batch_withdrawal_id;
    
    // Update with payout ID and move to verifying
    await pool.query(
      `UPDATE withdrawals 
       SET status = 'verifying',
           provider_payout_id = ?,
           provider_batch_id = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        payoutId,
        payoutResult.batch_withdrawal_id || payoutId,
        withdrawalId
      ]
    );
    
    console.log(`[Admin] Payout created: ${payoutId}`);
    
    // Auto-verify with 2FA (if configured)
    if (!skip2FA && process.env.NOWPAYMENTS_2FA_SECRET) {
      try {
        await verifyPayout({ id: payoutId });
        
        // Update to processing status
        await pool.query(
          `UPDATE withdrawals SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [withdrawalId]
        );
        
        console.log(`[Admin] Payout verified automatically: ${payoutId}`);
        
        res.json({
          success: true,
          withdrawalId,
          status: 'processing',
          payoutId,
          verified: true,
          message: 'Withdrawal approved, payout created and verified with 2FA'
        });
      } catch (verifyError) {
        console.error(`[Admin] 2FA verification failed:`, verifyError);
        res.json({
          success: true,
          withdrawalId,
          status: 'verifying',
          payoutId,
          verified: false,
          message: 'Payout created but 2FA verification failed. Verify manually in NOWPayments dashboard.',
          error: verifyError.message
        });
      }
    } else {
      res.json({
        success: true,
        withdrawalId,
        status: 'verifying',
        payoutId,
        verified: false,
        message: 'Payout created. Please verify with 2FA in NOWPayments dashboard or call /verify endpoint.'
      });
    }
    
  } catch (error) {
    try {
      await connection.rollback();
    } catch {}
    connection.release();
    console.error('[Admin] Approve withdrawal error:', error);
    res.status(500).json({ 
      error: 'Failed to approve withdrawal',
      message: error.message 
    });
  }
});

/**
 * POST /api/admin/withdrawals/:id/reject
 * Reject withdrawal and unlock funds
 */
adminWithdrawRouter.post('/withdrawals/:id/reject', adminAuth, async (req, res) => {
  const withdrawalId = req.params.id;
  const { reason } = req.body;
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    // Get withdrawal details
    const [rows] = await connection.query(
      `SELECT * FROM withdrawals WHERE id = ? AND status = 'requested' FOR UPDATE`,
      [withdrawalId]
    );
    
    if (rows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Withdrawal not found or already processed' });
    }
    
    const withdrawal = rows[0];
    const totalAtomic = BigInt(withdrawal.amount_atomic) + BigInt(withdrawal.fee_atomic);
    
    // Unlock funds
    await connection.query(
      `UPDATE balances 
       SET locked_atomic = locked_atomic - ?,
           available_atomic = available_atomic + ?
       WHERE user_id = ? AND asset = ?`,
      [totalAtomic.toString(), totalAtomic.toString(), withdrawal.user_id, withdrawal.asset]
    );
    
    // Update withdrawal status
    await connection.query(
      `UPDATE withdrawals 
       SET status = 'rejected',
           rejection_reason = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [reason || 'Rejected by admin', withdrawalId]
    );
    
    await connection.commit();
    
    console.log(`[Admin] Withdrawal ${withdrawalId} rejected, funds unlocked`);
    
    res.json({
      success: true,
      withdrawalId,
      status: 'rejected',
      message: 'Withdrawal rejected and funds unlocked'
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('[Admin] Reject withdrawal error:', error);
    res.status(500).json({ 
      error: 'Failed to reject withdrawal',
      message: error.message 
    });
  } finally {
    connection.release();
  }
});

/**
 * POST /api/admin/withdrawals/:id/verify
 * Manually verify payout with 2FA (if auto-verification was skipped)
 */
adminWithdrawRouter.post('/withdrawals/:id/verify', adminAuth, async (req, res) => {
  try {
    const withdrawalId = req.params.id;
    const { code } = req.body; // Optional manual 2FA code
    
    const [rows] = await pool.query(
      `SELECT * FROM withdrawals WHERE id = ? AND status = 'verifying'`,
      [withdrawalId]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Withdrawal not found or not in verifying status' });
    }
    
    const withdrawal = rows[0];
    
    if (!withdrawal.provider_payout_id) {
      return res.status(400).json({ error: 'No payout ID found' });
    }
    
    // Verify with NOWPayments
    await verifyPayout({ 
      id: withdrawal.provider_payout_id,
      code // Will auto-generate TOTP if not provided
    });
    
    // Update to processing
    await pool.query(
      `UPDATE withdrawals SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [withdrawalId]
    );
    
    console.log(`[Admin] Withdrawal ${withdrawalId} verified manually`);
    
    res.json({
      success: true,
      withdrawalId,
      status: 'processing',
      message: 'Payout verified with 2FA'
    });
    
  } catch (error) {
    console.error('[Admin] Verify error:', error);
    res.status(500).json({ 
      error: 'Failed to verify payout',
      message: error.message 
    });
  }
});

/**
 * GET /api/admin/withdrawals/:id/status
 * Check payout status from NOWPayments
 */
adminWithdrawRouter.get('/withdrawals/:id/status', adminAuth, async (req, res) => {
  try {
    const withdrawalId = req.params.id;
    
    const [rows] = await pool.query(
      `SELECT * FROM withdrawals WHERE id = ?`,
      [withdrawalId]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Withdrawal not found' });
    }
    
    const withdrawal = rows[0];
    
    if (!withdrawal.provider_payout_id) {
      return res.json({
        withdrawalId,
        status: withdrawal.status,
        message: 'No payout ID yet'
      });
    }
    
    // Get status from NOWPayments
    const payoutStatus = await getPayoutStatus(withdrawal.provider_payout_id);
    
    res.json({
      withdrawalId,
      internalStatus: withdrawal.status,
      payoutStatus,
    });
    
  } catch (error) {
    console.error('[Admin] Check status error:', error);
    res.status(500).json({ 
      error: 'Failed to check status',
      message: error.message 
    });
  }
});

module.exports = adminWithdrawRouter;
