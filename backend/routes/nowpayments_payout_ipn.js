// backend/routes/nowpayments_payout_ipn.js
// NOWPayments Payout IPN webhook handler (CommonJS)

const express = require('express');
const { pool, atomicToDecimal, decimalsFor } = require('../lib/mysql_pool');
const { verifyNowPaymentsIPN } = require('../lib/ipn_verify');

const payoutIpnRouter = express.Router();

/**
 * POST /api/nowpayments/payout-ipn
 * Handle NOWPayments payout status updates
 */
payoutIpnRouter.post('/payout-ipn', express.json(), async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    // Verify IPN signature
    const signature = req.headers['x-nowpayments-sig'];
    if (!verifyNowPaymentsIPN(req.body, signature)) {
      console.error('[Payout IPN] Invalid signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }
    
    const payload = req.body;
    console.log('[Payout IPN] Received:', JSON.stringify(payload, null, 2));
    
    // Extract payout info (structure may vary, adapt as needed)
    const payoutId = payload.id || payload.payout_id || payload.withdrawal_id;
    const status = payload.status;
    const withdrawalId = payload.extra_id; // Our internal ID
    
    if (!payoutId) {
      console.error('[Payout IPN] No payout ID in payload');
      return res.status(400).json({ error: 'No payout ID' });
    }
    
    await connection.beginTransaction();
    
    // Find withdrawal by payout ID or our internal ID
    let query = 'SELECT * FROM withdrawals WHERE ';
    let params = [];
    
    if (withdrawalId) {
      query += 'id = ? OR provider_payout_id = ? FOR UPDATE';
      params = [withdrawalId, payoutId];
    } else {
      query += 'provider_payout_id = ? FOR UPDATE';
      params = [payoutId];
    }
    
    const [rows] = await connection.query(query, params);
    
    if (rows.length === 0) {
      await connection.rollback();
      console.error('[Payout IPN] Withdrawal not found:', payoutId);
      // Still return 200 to avoid retries
      return res.json({ received: true, message: 'Withdrawal not found' });
    }
    
    const withdrawal = rows[0];
    
    console.log(`[Payout IPN] Processing withdrawal ${withdrawal.id}, current status: ${withdrawal.status}, new status: ${status}`);
    
    // Handle different statuses
    if (status === 'finished' || status === 'success' || status === 'completed') {
      // Payout successful - deduct from locked balance
      const totalAtomic = BigInt(withdrawal.amount_atomic) + BigInt(withdrawal.fee_atomic);
      
      // Skip if already completed
      if (withdrawal.status === 'completed') {
        await connection.rollback();
        return res.json({ received: true, message: 'Already completed' });
      }
      
      await connection.query(
        `UPDATE balances 
         SET locked_atomic = locked_atomic - ?
         WHERE user_id = ? AND asset = ?`,
        [totalAtomic.toString(), withdrawal.user_id, withdrawal.asset]
      );
      
      await connection.query(
        `UPDATE withdrawals 
         SET status = 'completed',
             updated_at = CURRENT_TIMESTAMP,
             completed_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [withdrawal.id]
      );
      
      console.log(`[Payout IPN] Withdrawal ${withdrawal.id} completed, funds deducted`);
      
    } else if (status === 'failed' || status === 'rejected' || status === 'expired' || status === 'error') {
      // Payout failed - unlock funds
      const totalAtomic = BigInt(withdrawal.amount_atomic) + BigInt(withdrawal.fee_atomic);
      
      // Skip if already failed
      if (withdrawal.status === 'failed') {
        await connection.rollback();
        return res.json({ received: true, message: 'Already failed' });
      }
      
      await connection.query(
        `UPDATE balances 
         SET locked_atomic = locked_atomic - ?,
             available_atomic = available_atomic + ?
         WHERE user_id = ? AND asset = ?`,
        [totalAtomic.toString(), totalAtomic.toString(), withdrawal.user_id, withdrawal.asset]
      );
      
      await connection.query(
        `UPDATE withdrawals 
         SET status = 'failed',
             rejection_reason = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [payload.error || `Payout ${status}`, withdrawal.id]
      );
      
      console.log(`[Payout IPN] Withdrawal ${withdrawal.id} failed, funds unlocked`);
      
    } else {
      // Intermediate status (processing, verifying, sending, etc.)
      const statusMap = {
        'waiting': 'verifying',
        'processing': 'processing',
        'sending': 'processing',
        'verifying': 'verifying',
      };
      
      const newStatus = statusMap[status] || 'processing';
      
      await connection.query(
        `UPDATE withdrawals 
         SET status = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [newStatus, withdrawal.id]
      );
      
      console.log(`[Payout IPN] Withdrawal ${withdrawal.id} status updated: ${status} → ${newStatus}`);
    }
    
    await connection.commit();
    
    res.json({ received: true });
    
  } catch (error) {
    await connection.rollback();
    console.error('[Payout IPN] Error:', error);
    // Return 200 to avoid NOWPayments retrying on our errors
    res.json({ received: true, error: error.message });
  } finally {
    connection.release();
  }
});

/**
 * GET /api/nowpayments/payout-ipn/health
 * Health check for payout IPN endpoint
 */
payoutIpnRouter.get('/payout-ipn/health', (req, res) => {
  res.json({ status: 'ok', endpoint: 'payout-ipn' });
});

module.exports = payoutIpnRouter;
