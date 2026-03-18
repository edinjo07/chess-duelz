// backend/routes/admin-deposits.js
// Admin routes for deposit management
const express = require('express');
const router = express.Router();

module.exports = (db, verifyToken, requireAdmin) => {
  
  // ============================================
  // GET /api/admin/deposits
  // List all deposits with filters
  // ============================================
  router.get('/', verifyToken, requireAdmin, async (req, res) => {
    try {
      const {
        status,
        userId,
        coin,
        network,
        provider,
        startDate,
        endDate,
        reviewed,
        stuck, // deposits older than 24h still pending
        limit = 50,
        offset = 0
      } = req.query;

      let query = `
        SELECT 
          di.id,
          di.payment_id,
          di.user_id,
          di.provider,
          di.pay_currency as coin,
          di.pay_amount as amount,
          di.pay_address as address,
          di.status,
          di.created_at,
          di.updated_at,
          u.username,
          u.email
        FROM deposit_intents di
        JOIN users u ON di.user_id = u.id
        WHERE 1=1
      `;
      const params = [];

      if (status) {
        query += ' AND di.status = ?';
        params.push(status);
      }
      if (userId) {
        query += ' AND di.user_id = ?';
        params.push(userId);
      }
      if (coin) {
        query += ' AND di.pay_currency = ?';
        params.push(coin);
      }
      if (provider) {
        query += ' AND di.provider = ?';
        params.push(provider);
      }
      if (startDate) {
        query += ' AND di.created_at >= ?';
        params.push(startDate);
      }
      if (endDate) {
        query += ' AND di.created_at <= ?';
        params.push(endDate);
      }
      if (stuck === 'true') {
        query += ` AND di.status IN ('created', 'waiting', 'confirming') 
                   AND di.created_at < DATE_SUB(NOW(), INTERVAL 24 HOUR)`;
      }

      query += ' ORDER BY di.created_at DESC LIMIT ? OFFSET ?';
      params.push(parseInt(limit), parseInt(offset));

      db.query(query, params, (err, deposits) => {
        if (err) {
          console.error('Error fetching deposits:', err);
          // If table doesn't exist, return empty array
          if (err.code === 'ER_NO_SUCH_TABLE') {
            return res.json({ success: true, deposits: [], pagination: { total: 0, limit: parseInt(limit), offset: parseInt(offset) } });
          }
          return res.status(500).json({ success: false, error: 'Database error', details: err.message });
        }

        // Get total count for pagination
        let countQuery = `SELECT COUNT(*) as total FROM deposit_intents d WHERE 1=1`;
        const countParams = params.slice(0, -2); // Remove limit and offset
        
        db.query(countQuery, countParams, (countErr, countResult) => {
          if (countErr) {
            console.error('Error counting deposits:', countErr);
          }

          // Admin action logging disabled temporarily
          // logAdminAction disabled

          res.json({
            success: true,
            deposits,
            pagination: {
              total: countResult ? countResult[0].total : deposits.length,
              limit: parseInt(limit),
              offset: parseInt(offset)
            }
          });
        });
      });

    } catch (error) {
      console.error('Get deposits error:', error);
      res.status(500).json({ success: false, error: 'Server error' });
    }
  });

  // ============================================
  // GET /api/admin/deposits/stats/summary
  // Get deposit statistics
  // NOTE: This MUST come before /:id route to avoid matching "stats" as an ID
  // ============================================
  router.get('/stats/summary', verifyToken, requireAdmin, (req, res) => {
    const { startDate, endDate } = req.query;

    let dateFilter = '';
    const params = [];

    if (startDate) {
      dateFilter += ' AND created_at >= ?';
      params.push(startDate);
    }
    if (endDate) {
      dateFilter += ' AND created_at <= ?';
      params.push(endDate);
    }

    db.query(
      `SELECT 
        COUNT(*) as total_deposits,
        SUM(CASE WHEN status = 'finished' THEN 1 ELSE 0 END) as finished,
        SUM(CASE WHEN status IN ('created', 'waiting', 'confirming') THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) as expired,
        SUM(CASE WHEN status = 'finished' AND pay_amount IS NOT NULL THEN CAST(pay_amount AS DECIMAL(20,8)) ELSE 0 END) as total_received,
        SUM(CASE WHEN status = 'finished' AND price_amount IS NOT NULL THEN CAST(price_amount AS DECIMAL(20,8)) ELSE 0 END) as total_usd,
        0 as needs_review
      FROM deposit_intents
      WHERE 1=1 ${dateFilter}`,
      params,
      (err, results) => {
        if (err) {
          console.error('Error fetching deposit stats:', err);
          // If table doesn't exist, return empty stats
          if (err.code === 'ER_NO_SUCH_TABLE') {
            return res.json({ 
              success: true, 
              stats: { 
                total_deposits: 0, finished: 0, pending: 0, failed: 0, 
                expired: 0, total_received: 0, total_usd: 0, needs_review: 0 
              } 
            });
          }
          return res.status(500).json({ success: false, error: 'Database error', details: err.message });
        }

        res.json({ success: true, stats: results[0] || {} });
      }
    );
  });

  // ============================================
  // GET /api/admin/deposits/:id
  // Get single deposit details
  // ============================================
  router.get('/:id', verifyToken, requireAdmin, (req, res) => {
    const depositId = parseInt(req.params.id);

    db.query(
      `SELECT 
        di.*,
        u.username,
        u.email
      FROM deposit_intents di
      JOIN users u ON di.user_id = u.id
      WHERE di.id = ?`,
      [depositId],
      (err, results) => {
        if (err) {
          console.error('Error fetching deposit:', err);
          return res.status(500).json({ success: false, error: 'Database error', details: err.message });
        }

        if (results.length === 0) {
          return res.status(404).json({ success: false, error: 'Deposit not found' });
        }

        res.json({ success: true, deposit: results[0] });
      }
    );
  });

  // ============================================
  // POST /api/admin/deposits/:id/review
  // Mark deposit as reviewed
  // ============================================
  router.post('/:id/review', verifyToken, requireAdmin, (req, res) => {
    const depositId = parseInt(req.params.id);
    const { notes } = req.body;

    db.query(
      'SELECT * FROM deposit_intents WHERE id = ?',
      [depositId],
      (err, deposits) => {
        if (err || deposits.length === 0) {
          return res.status(404).json({ success: false, error: 'Deposit not found' });
        }

        // Review functionality disabled - deposit_intents table doesn't have reviewed_by column
        res.json({ 
          success: true, 
          message: 'Review feature not available for NOWPayments deposits',
          deposit: deposits[0]
        });
      }
    );
  });

  // ============================================
  // POST /api/admin/deposits/:id/reprocess
  // Manually reprocess webhook/credit
  // ============================================
  router.post('/:id/reprocess', verifyToken, requireAdmin, async (req, res) => {
    const depositId = parseInt(req.params.id);

    try {
      db.query(
        'SELECT * FROM deposit_intents WHERE id = ?',
        [depositId],
        async (err, deposits) => {
          if (err || deposits.length === 0) {
            return res.status(404).json({ success: false, error: 'Deposit not found' });
          }

          const deposit = deposits[0];

          // Reprocess functionality disabled - use NOWPayments IPN webhook for crediting
          res.json({
            success: false,
            message: 'Reprocess not available. NOWPayments deposits are automatically credited via IPN webhook.',
            deposit: deposit
          });
        }
      );
    } catch (error) {
      console.error('Reprocess deposit error:', error);
      res.status(500).json({ success: false, error: 'Server error' });
    }
  });

  return router;
};

