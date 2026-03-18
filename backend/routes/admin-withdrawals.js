// backend/routes/admin-withdrawals.js
// Admin withdrawal management with 2-step approval flow

const express = require('express');
const router = express.Router();
// const adminAuth = require('../middleware/admin-auth'); // Removed - not used and causes db.js import issues
// const ledger = require('../lib/ledger'); // Removed - causing db import issues

module.exports = (db, verifyToken, requireAdmin) => {
  
  // Debug: Log what was passed to the module
  console.log('[ADMIN WITHDRAWALS] Module initialized');
  console.log('[ADMIN WITHDRAWALS] db type:', typeof db);
  console.log('[ADMIN WITHDRAWALS] db.query type:', typeof db?.query);
  console.log('[ADMIN WITHDRAWALS] verifyToken type:', typeof verifyToken);
  console.log('[ADMIN WITHDRAWALS] requireAdmin type:', typeof requireAdmin);
  
  // Test endpoint to verify routing is working
  router.get('/test', (req, res) => {
    res.json({ success: true, message: 'Admin withdrawals route is working' });
  });
  
  // Debug endpoint to test auth middleware
  router.get('/debug', verifyToken, requireAdmin, (req, res) => {
    res.json({ 
      success: true, 
      message: 'Auth working',
      user: {
        userId: req.user.userId,
        username: req.user.username,
        isAdmin: req.user.isAdmin
      }
    });
  });
  
  // Test db.query directly
  router.get('/test-db', verifyToken, requireAdmin, (req, res) => {
    try {
      console.log('[TEST-DB] Testing db.query...');
      console.log('[TEST-DB] db type:', typeof db);
      console.log('[TEST-DB] db.query type:', typeof db.query);
      
      // Try a simple query
      db.query('SELECT 1 as test', (err, result) => {
        if (err) {
          console.error('[TEST-DB] Query error:', err);
          return res.status(500).json({ 
            error: 'Query failed', 
            details: err.message,
            dbType: typeof db,
            queryType: typeof db.query
          });
        }
        res.json({ 
          success: true, 
          message: 'db.query works!',
          result: result
        });
      });
    } catch (error) {
      console.error('[TEST-DB] Catch error:', error);
      res.status(500).json({ 
        error: 'Exception caught', 
        details: error.message,
        stack: error.stack
      });
    }
  });
  
  /**
   * Get withdrawals list with filters
   */
  router.get('/', verifyToken, requireAdmin, (req, res) => {
    // Wrap everything in try-catch to catch ANY error
    const handleError = (error, source) => {
      console.error(`[ADMIN WITHDRAWALS] ========== ERROR in ${source} ==========`);
      console.error('[ADMIN WITHDRAWALS] Error:', error);
      console.error('[ADMIN WITHDRAWALS] Error name:', error?.name);
      console.error('[ADMIN WITHDRAWALS] Error message:', error?.message);
      console.error('[ADMIN WITHDRAWALS] Error stack:', error?.stack);
      return res.status(500).json({ 
        error: 'Internal server error',
        source: source,
        details: error?.message || 'Unknown error',
        type: error?.name || 'UnknownError'
      });
    };

    try {
      console.log('[ADMIN WITHDRAWALS] ========== START REQUEST ==========');
      console.log('[ADMIN WITHDRAWALS] GET / endpoint called by user:', req.user?.username);
      console.log('[ADMIN WITHDRAWALS] Query params:', req.query);
      console.log('[ADMIN WITHDRAWALS] db exists:', !!db);
      console.log('[ADMIN WITHDRAWALS] db.query type:', typeof db?.query);
      
      // Check if db is properly initialized
      if (!db || typeof db.query !== 'function') {
        console.error('[ADMIN WITHDRAWALS] Database connection not available!');
        console.error('[ADMIN WITHDRAWALS] db type:', typeof db);
        console.error('[ADMIN WITHDRAWALS] db.query type:', typeof db?.query);
        return res.status(500).json({ 
          error: 'Database connection not available',
          details: 'Database pool is not properly initialized. Please contact system administrator.'
        });
      }
      
      // Directly query withdrawals - table should exist
      const {
        status,
        coin,
        network,
        user_id,
        amount_min,
        amount_max,
        date_from,
        date_to,
        risk_high,
        first_withdrawal,
        limit = 50,
        offset = 0
      } = req.query;

      let query = `
        SELECT 
          w.*,
          u.username,
          u.email,
          COALESCE(approved_admin.username, 'N/A') as approved_by_username,
          COALESCE(sent_admin.username, 'N/A') as sent_by_username
        FROM withdrawals w
        LEFT JOIN users u ON w.user_id = u.id
        LEFT JOIN users approved_admin ON w.approved_by = approved_admin.id
        LEFT JOIN users sent_admin ON w.sent_by = sent_admin.id
        WHERE 1=1
      `;
      
      const params = [];

      if (status) {
        query += ` AND w.status = ?`;
        params.push(status);
      }

      if (coin) {
        query += ` AND w.asset = ?`;
        params.push(coin);
      }

      if (network) {
        query += ` AND w.network = ?`;
        params.push(network);
      }

      if (user_id) {
        query += ` AND w.user_id = ?`;
        params.push(user_id);
      }

      if (amount_min) {
        query += ` AND w.amount_atomic >= ?`;
        params.push(amount_min);
      }

      if (amount_max) {
        query += ` AND w.amount_atomic <= ?`;
        params.push(amount_max);
      }

      if (date_from) {
        query += ` AND w.created_at >= ?`;
        params.push(date_from);
      }

      if (date_to) {
        query += ` AND w.created_at <= ?`;
        params.push(date_to);
      }

      query += ` ORDER BY w.created_at DESC LIMIT ? OFFSET ?`;
      params.push(parseInt(limit), parseInt(offset));

      console.log('[ADMIN WITHDRAWALS] Executing query');
      console.log('[ADMIN WITHDRAWALS] With params:', params);

      db.query(query, params, (err, withdrawals) => {
        if (err) {
          console.error('[ADMIN WITHDRAWALS] Error fetching withdrawals:', err);
          console.error('[ADMIN WITHDRAWALS] Error code:', err.code);
          console.error('[ADMIN WITHDRAWALS] Error sqlState:', err.sqlState);
          console.error('[ADMIN WITHDRAWALS] Error message:', err.message);
          
          // If table doesn't exist, return empty array
          if (err.code === 'ER_NO_SUCH_TABLE') {
            console.warn('[ADMIN WITHDRAWALS] Withdrawals table does not exist yet');
            return res.json({
              success: true,
              withdrawals: [],
              total: 0,
              limit: parseInt(limit),
              offset: parseInt(offset),
              message: 'Withdrawals table not yet created'
            });
          }
          
          // Handle connection errors
          if (err.code === 'PROTOCOL_CONNECTION_LOST' || err.code === 'ECONNREFUSED') {
            return res.status(503).json({ 
              error: 'Database connection lost', 
              details: 'Database server is not responding. Please try again.',
              code: err.code
            });
          }
          
          return res.status(500).json({ 
            error: 'Failed to fetch withdrawals', 
            details: err.message,
            code: err.code,
            sqlState: err.sqlState
          });
        }

        console.log('[ADMIN WITHDRAWALS] Found', withdrawals.length, 'withdrawals');

        // Get total count
        let countQuery = `SELECT COUNT(*) as total FROM withdrawals w WHERE 1=1`;
        const countParams = [];
      
        if (status) { countQuery += ` AND w.status = ?`; countParams.push(status); }
        if (coin) { countQuery += ` AND w.asset = ?`; countParams.push(coin); }
        if (network) { countQuery += ` AND w.network = ?`; countParams.push(network); }
        if (user_id) { countQuery += ` AND w.user_id = ?`; countParams.push(user_id); }

        db.query(countQuery, countParams, (countErr, countResult) => {
          if (countErr) {
            console.error('[ADMIN WITHDRAWALS] Error counting withdrawals:', countErr);
          }

          res.json({
            success: true,
            withdrawals: withdrawals || [],
            total: countResult ? countResult[0].total : withdrawals.length,
            limit: parseInt(limit),
            offset: parseInt(offset)
          });
        });
      });
    } catch (error) {
      return handleError(error, 'main try-catch block');
    }
  });

  /**
   * Get single withdrawal details
   */
  router.get('/:id', verifyToken, requireAdmin, (req, res) => {
    const { id } = req.params;

    db.query(`
      SELECT 
        w.*,
        u.username,
        u.email,
        u.balance as user_balance,
        approved_admin.username as approved_by_username,
        sent_admin.username as sent_by_username
      FROM withdrawals w
      LEFT JOIN users u ON w.user_id = u.id
      LEFT JOIN users approved_admin ON w.approved_by = approved_admin.id
      LEFT JOIN users sent_admin ON w.sent_by = sent_admin.id
      WHERE w.id = ?
    `, [id], (err, results) => {
      if (err) {
        console.error('[ADMIN WITHDRAWALS] Error fetching withdrawal:', err);
        return res.status(500).json({ error: 'Failed to fetch withdrawal' });
      }

      if (results.length === 0) {
        return res.status(404).json({ error: 'Withdrawal not found' });
      }

      res.json({
        success: true,
        withdrawal: results[0]
      });
    });
  });

  /**
   * Approve withdrawal (Step 1 - does NOT send funds)
   */
  router.post('/:id/approve', verifyToken, requireAdmin, (req, res) => {
    const { id } = req.params;
    const { internal_note } = req.body;

    if (!internal_note || internal_note.trim().length === 0) {
      return res.status(400).json({ error: 'Internal note is required for approval' });
    }

    // Get withdrawal details
    db.query('SELECT * FROM withdrawals WHERE id = ?', [id], (err, results) => {
      if (err) {
        console.error('[ADMIN WITHDRAWALS] Error fetching withdrawal:', err);
        return res.status(500).json({ error: 'Failed to fetch withdrawal' });
      }

      if (results.length === 0) {
        return res.status(404).json({ error: 'Withdrawal not found' });
      }

      const withdrawal = results[0];

      if (withdrawal.status !== 'requested') {
        return res.status(400).json({ error: `Cannot approve withdrawal with status: ${withdrawal.status}` });
      }

      // Update withdrawal status
      db.query(`
        UPDATE withdrawals 
        SET status = 'approved',
            approved_by = ?,
            approved_at = NOW(),
            internal_notes = ?
        WHERE id = ?
      `, [req.user.userId, internal_note, id], (updateErr) => {
        if (updateErr) {
          console.error('[ADMIN WITHDRAWALS] Error approving withdrawal:', updateErr);
          return res.status(500).json({ error: 'Failed to approve withdrawal' });
        }

        console.log(`[ADMIN] User ${req.user.username} approved withdrawal ${id}`);

        res.json({
          success: true,
          message: 'Withdrawal approved successfully',
          withdrawal_id: id,
          status: 'approved',
          note: 'Funds NOT sent yet. Use /send endpoint to actually send.'
        });
      });
    });
  });

  /**
   * Send withdrawal funds (Step 2 - actually sends)
   */
  router.post('/:id/send', verifyToken, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { txid } = req.body;

    if (!txid || txid.trim().length === 0) {
      return res.status(400).json({ error: 'Transaction ID (txid) is required' });
    }

    // Get withdrawal details
    db.query('SELECT * FROM withdrawals WHERE id = ?', [id], async (err, results) => {
      if (err) {
        console.error('[ADMIN WITHDRAWALS] Error fetching withdrawal:', err);
        return res.status(500).json({ error: 'Failed to fetch withdrawal' });
      }

      if (results.length === 0) {
        return res.status(404).json({ error: 'Withdrawal not found' });
      }

      const withdrawal = results[0];

      if (withdrawal.status !== 'approved') {
        return res.status(400).json({ error: `Cannot send withdrawal with status: ${withdrawal.status}. Must be approved first.` });
      }

      try {
        // Create withdrawal debit in ledger
        const withdrawalAmount = parseFloat(withdrawal.amount_atomic) / 100; // Convert to dollars
        
        await ledger.createLedgerEntry({
          userId: withdrawal.user_id,
          type: ledger.ENTRY_TYPES.WITHDRAWAL_DEBIT,
          amount: -withdrawalAmount,
          currency: 'USD',
          referenceType: 'withdrawal',
          referenceId: id,
          metadata: {
            asset: withdrawal.asset,
            network: withdrawal.network,
            to_address: withdrawal.to_address,
            txid: txid,
            sent_by: req.user.userId
          },
          createdBy: req.user.userId
        });

        // Update withdrawal status
        db.query(`
          UPDATE withdrawals 
          SET status = 'sent',
              sent_by = ?,
              sent_at = NOW(),
              txid = ?
          WHERE id = ?
        `, [req.user.userId, txid, id], (updateErr) => {
          if (updateErr) {
            console.error('[ADMIN WITHDRAWALS] Error updating withdrawal:', updateErr);
            return res.status(500).json({ error: 'Failed to update withdrawal status' });
          }

          // Log admin action
          console.log(`[ADMIN] User ${req.user.username} sent withdrawal ${id} with txid ${txid}`);

          res.json({
            success: true,
            message: 'Withdrawal sent successfully',
            withdrawal_id: id,
            status: 'sent',
            txid: txid,
            ledger_debited: true
          });
        });
      } catch (ledgerErr) {
        console.error('[ADMIN WITHDRAWALS] Ledger error:', ledgerErr);
        return res.status(500).json({ 
          error: 'Failed to debit ledger', 
          details: ledgerErr.message 
        });
      }
    });
  });

  /**
   * Reject withdrawal
   */
  router.post('/:id/reject', verifyToken, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { reason, internal_note } = req.body;

    if (!reason || reason.trim().length === 0) {
      return res.status(400).json({ error: 'User-visible reason is required' });
    }

    // Get withdrawal details
    db.query('SELECT * FROM withdrawals WHERE id = ?', [id], async (err, results) => {
      if (err) {
        console.error('[ADMIN WITHDRAWALS] Error fetching withdrawal:', err);
        return res.status(500).json({ error: 'Failed to fetch withdrawal' });
      }

      if (results.length === 0) {
        return res.status(404).json({ error: 'Withdrawal not found' });
      }

      const withdrawal = results[0];

      if (withdrawal.status !== 'requested' && withdrawal.status !== 'approved') {
        return res.status(400).json({ error: `Cannot reject withdrawal with status: ${withdrawal.status}` });
      }

      // If withdrawal was already debited, refund it via ledger
      if (withdrawal.status === 'approved' || withdrawal.status === 'sent') {
        try {
          const withdrawalAmount = parseFloat(withdrawal.amount_atomic) / 100;
          
          await ledger.createLedgerEntry({
            userId: withdrawal.user_id,
            type: ledger.ENTRY_TYPES.WITHDRAWAL_REFUND,
            amount: withdrawalAmount,
            currency: 'USD',
            referenceType: 'withdrawal',
            referenceId: id,
            metadata: {
              reason: reason,
              internal_note: internal_note || '',
              rejected_by: req.user.userId
            },
            createdBy: req.user.userId
          });
        } catch (ledgerErr) {
          console.error('[ADMIN WITHDRAWALS] Ledger refund error:', ledgerErr);
          return res.status(500).json({ error: 'Failed to refund ledger' });
        }
      }

      // Update withdrawal status
      db.query(`
        UPDATE withdrawals 
        SET status = 'rejected',
            rejection_reason = ?,
            internal_notes = ?
        WHERE id = ?
      `, [reason, internal_note || '', id], (updateErr) => {
        if (updateErr) {
          console.error('[ADMIN WITHDRAWALS] Error rejecting withdrawal:', updateErr);
          return res.status(500).json({ error: 'Failed to reject withdrawal' });
        }

        console.log(`[ADMIN] User ${req.user.username} rejected withdrawal ${id}: ${reason}`);

        res.json({
          success: true,
          message: 'Withdrawal rejected and user refunded',
          withdrawal_id: id,
          status: 'rejected',
          refunded: withdrawal.status === 'approved' || withdrawal.status === 'sent'
        });
      });
    });
  });

  /**
   * Mark withdrawal as failed (after send attempt)
   */
  router.post('/:id/fail', verifyToken, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason || reason.trim().length === 0) {
      return res.status(400).json({ error: 'Failure reason is required' });
    }

    // Get withdrawal details
    db.query('SELECT * FROM withdrawals WHERE id = ?', [id], async (err, results) => {
      if (err) {
        console.error('[ADMIN WITHDRAWALS] Error fetching withdrawal:', err);
        return res.status(500).json({ error: 'Failed to fetch withdrawal' });
      }

      if (results.length === 0) {
        return res.status(404).json({ error: 'Withdrawal not found' });
      }

      const withdrawal = results[0];

      if (withdrawal.status !== 'sent') {
        return res.status(400).json({ error: `Cannot mark as failed with status: ${withdrawal.status}` });
      }

      try {
        // Refund via ledger
        const withdrawalAmount = parseFloat(withdrawal.amount_atomic) / 100;
        
        await ledger.createLedgerEntry({
          userId: withdrawal.user_id,
          type: ledger.ENTRY_TYPES.WITHDRAWAL_REFUND,
          amount: withdrawalAmount,
          currency: 'USD',
          referenceType: 'withdrawal',
          referenceId: id,
          metadata: {
            reason: reason,
            failed_by: req.user.userId,
            original_txid: withdrawal.txid
          },
          createdBy: req.user.userId
        });

        // Update withdrawal status
        db.query(`
          UPDATE withdrawals 
          SET status = 'failed',
              rejection_reason = ?
          WHERE id = ?
        `, [reason, id], (updateErr) => {
          if (updateErr) {
            console.error('[ADMIN WITHDRAWALS] Error marking failed:', updateErr);
            return res.status(500).json({ error: 'Failed to update withdrawal' });
          }

          console.log(`[ADMIN] User ${req.user.username} marked withdrawal ${id} as failed: ${reason}`);

          res.json({
            success: true,
            message: 'Withdrawal marked as failed and user refunded',
            withdrawal_id: id,
            status: 'failed',
            refunded: true
          });
        });
      } catch (ledgerErr) {
        console.error('[ADMIN WITHDRAWALS] Ledger refund error:', ledgerErr);
        return res.status(500).json({ error: 'Failed to refund ledger' });
      }
    });
  });

  return router;
};
