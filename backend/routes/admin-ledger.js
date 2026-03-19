// backend/routes/admin-ledger.js
// Balance adjustment ledger system - prevents direct balance manipulation

const express = require('express');
const router = express.Router();
const ledger = require('../lib/ledger');

module.exports = (db, verifyToken, requireAdmin) => {
  
  /**
   * Create balance adjustment (replaces direct balance edit)
   */
  router.post('/balance/adjust', verifyToken, requireAdmin, async (req, res) => {
    const { 
      userId, 
      adjustmentType, 
      amount, 
      reason, 
      ticketReference,
      adminNotes 
    } = req.body;

    // Validation
    if (!userId || !adjustmentType || !amount || !reason) {
      return res.status(400).json({ 
        error: 'Missing required fields: userId, adjustmentType, amount, reason' 
      });
    }

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum === 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const validTypes = ['admin_credit', 'admin_debit', 'correction', 'bonus', 'penalty', 'refund', 'chargeback'];
    if (!validTypes.includes(adjustmentType)) {
      return res.status(400).json({ 
        error: 'Invalid adjustment type',
        validTypes 
      });
    }

    try {
      // Get current user balance
      const userResult = await new Promise((resolve, reject) => {
        db.query(
          'SELECT id, username, balance, currency FROM users WHERE id = ?',
          [userId],
          (err, results) => {
            if (err) return reject(err);
            if (results.length === 0) return reject(new Error('User not found'));
            resolve(results[0]);
          }
        );
      });

      const balanceBefore = parseFloat(userResult.balance);
      const currency = userResult.currency || 'USD';
      
      // Calculate new balance
      let balanceAfter;
      if (adjustmentType === 'admin_debit' || adjustmentType === 'penalty' || adjustmentType === 'chargeback') {
        balanceAfter = balanceBefore - Math.abs(amountNum);
      } else {
        balanceAfter = balanceBefore + Math.abs(amountNum);
      }

      // Prevent negative balance for debits
      if (balanceAfter < 0) {
        return res.status(400).json({ 
          error: 'Insufficient balance',
          currentBalance: balanceBefore,
          requestedDebit: Math.abs(amountNum),
          shortfall: Math.abs(balanceAfter)
        });
      }

      // Start transaction
      db.beginTransaction(async (err) => {
        if (err) {
          console.error('Transaction error:', err);
          return res.status(500).json({ error: 'Failed to start transaction' });
        }

        try {
          // Update user balance
          await new Promise((resolve, reject) => {
            db.query(
              'UPDATE users SET balance = ? WHERE id = ?',
              [balanceAfter, userId],
              (err, result) => {
                if (err) return reject(err);
                if (result.affectedRows === 0) return reject(new Error('User update failed'));
                resolve();
              }
            );
          });

          // Create ledger entry
          const adjustmentId = await new Promise((resolve, reject) => {
            db.query(`
              INSERT INTO balance_adjustments 
              (user_id, admin_id, adjustment_type, amount, currency, balance_before, balance_after, 
               reason, ticket_reference, admin_notes, approval_status, approved_by, approved_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, NOW())
            `, [
              userId, 
              req.user.userId,
              adjustmentType,
              amountNum,
              currency,
              balanceBefore,
              balanceAfter,
              reason,
              ticketReference || null,
              adminNotes || null,
              req.user.userId
            ], (err, result) => {
              if (err) return reject(err);
              resolve(result.insertId);
            });
          });

          // Log admin action
          logAdminAction(
            req.user.userId,
            req.user.username,
            'BALANCE_ADJUSTMENT',
            {
              resourceType: 'user_balance',
              resourceId: userId,
              oldValue: { balance: balanceBefore },
              newValue: { balance: balanceAfter },
              adjustmentId,
              adjustmentType,
              amount: amountNum,
              reason,
              ticketReference,
              ipAddress: getClientIP(req),
              userAgent: req.headers['user-agent']
            }
          );

          // Commit transaction
          db.commit((commitErr) => {
            if (commitErr) {
              return db.rollback(() => {
                console.error('Commit error:', commitErr);
                res.status(500).json({ error: 'Failed to commit transaction' });
              });
            }

            res.json({
              success: true,
              message: 'Balance adjusted successfully',
              adjustment: {
                id: adjustmentId,
                userId,
                username: userResult.username,
                adjustmentType,
                amount: amountNum,
                currency,
                balanceBefore,
                balanceAfter,
                reason,
                ticketReference,
                adminId: req.user.userId,
                adminUsername: req.user.username
              }
            });
          });

        } catch (error) {
          db.rollback(() => {
            console.error('Balance adjustment error:', error);
            res.status(500).json({ 
              error: 'Balance adjustment failed',
              details: error.message 
            });
          });
        }
      });

    } catch (error) {
      console.error('Balance adjustment error:', error);
      res.status(500).json({ 
        error: 'Failed to process balance adjustment',
        details: error.message 
      });
    }
  });

  /**
   * Get balance adjustment history for a user
   */
  router.get('/balance/history/:userId', verifyToken, requireAdmin, (req, res) => {
    const { userId } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    db.query(`
      SELECT 
        ba.*,
        u.username as user_username,
        a.username as admin_username,
        ap.username as approver_username
      FROM balance_adjustments ba
      LEFT JOIN users u ON ba.user_id = u.id
      LEFT JOIN users a ON ba.admin_id = a.id
      LEFT JOIN users ap ON ba.approved_by = ap.id
      WHERE ba.user_id = ?
      ORDER BY ba.created_at DESC
      LIMIT ? OFFSET ?
    `, [userId, parseInt(limit), parseInt(offset)], (err, results) => {
      if (err) {
        console.error('Error fetching balance history:', err);
        return res.status(500).json({ error: 'Failed to fetch balance history' });
      }

      res.json({
        success: true,
        adjustments: results,
        userId,
        limit: parseInt(limit),
        offset: parseInt(offset)
      });
    });
  });

  /**
   * Get all balance adjustments (with filters)
   */
  router.get('/balance/adjustments', verifyToken, requireAdmin, (req, res) => {
    const { 
      adjustmentType, 
      adminId, 
      startDate, 
      endDate, 
      limit = 100, 
      offset = 0 
    } = req.query;

    let query = `
      SELECT 
        ba.*,
        u.username as user_username,
        a.username as admin_username,
        ap.username as approver_username
      FROM balance_adjustments ba
      LEFT JOIN users u ON ba.user_id = u.id
      LEFT JOIN users a ON ba.admin_id = a.id
      LEFT JOIN users ap ON ba.approved_by = ap.id
      WHERE 1=1
    `;
    const params = [];

    if (adjustmentType) {
      query += ' AND ba.adjustment_type = ?';
      params.push(adjustmentType);
    }

    if (adminId) {
      query += ' AND ba.admin_id = ?';
      params.push(adminId);
    }

    if (startDate) {
      query += ' AND ba.created_at >= ?';
      params.push(startDate);
    }

    if (endDate) {
      query += ' AND ba.created_at <= ?';
      params.push(endDate);
    }

    query += ' ORDER BY ba.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    db.query(query, params, (err, results) => {
      if (err) {
        console.error('Error fetching adjustments:', err);
        return res.status(500).json({ error: 'Failed to fetch adjustments' });
      }

      // Get total count
      db.query(
        'SELECT COUNT(*) as total FROM balance_adjustments',
        (countErr, countResults) => {
          res.json({
            success: true,
            adjustments: results,
            total: countErr ? null : countResults[0].total,
            limit: parseInt(limit),
            offset: parseInt(offset)
          });
        }
      );
    });
  });

  /**
   * Get balance adjustment statistics
   */
  router.get('/balance/stats', verifyToken, requireAdmin, (req, res) => {
    const { startDate, endDate } = req.query;

    let dateFilter = '';
    const params = [];

    if (startDate && endDate) {
      dateFilter = 'WHERE created_at BETWEEN ? AND ?';
      params.push(startDate, endDate);
    }

    db.query(`
      SELECT 
        adjustment_type,
        COUNT(*) as count,
        SUM(amount) as total_amount,
        AVG(amount) as avg_amount,
        MIN(amount) as min_amount,
        MAX(amount) as max_amount,
        currency
      FROM balance_adjustments
      ${dateFilter}
      GROUP BY adjustment_type, currency
      ORDER BY adjustment_type
    `, params, (err, results) => {
      if (err) {
        console.error('Error fetching balance stats:', err);
        return res.status(500).json({ error: 'Failed to fetch statistics' });
      }

      res.json({
        success: true,
        statistics: results,
        period: { startDate, endDate }
      });
    });
  });

  // ============================================
  // LEDGER ENTRIES MANAGEMENT
  // ============================================

  /**
   * Get all ledger entries with filters
   */
  router.get('/entries', verifyToken, requireAdmin, async (req, res) => {
    try {
      const {
        userId,
        entryType,
        startDate,
        endDate,
        minAmount,
        maxAmount,
        referenceType,
        referenceId,
        limit = 100,
        offset = 0
      } = req.query;

      let query = `
        SELECT 
          l.*,
          u.username,
          u.email
        FROM ledger_entries l
        JOIN users u ON l.user_id = u.id
        WHERE 1=1
      `;
      const params = [];

      if (userId) {
        query += ' AND l.user_id = ?';
        params.push(userId);
      }
      if (entryType) {
        query += ' AND l.entry_type = ?';
        params.push(entryType);
      }
      if (startDate) {
        query += ' AND l.created_at >= ?';
        params.push(startDate);
      }
      if (endDate) {
        query += ' AND l.created_at <= ?';
        params.push(endDate);
      }
      if (minAmount) {
        query += ' AND l.amount >= ?';
        params.push(minAmount);
      }
      if (maxAmount) {
        query += ' AND l.amount <= ?';
        params.push(maxAmount);
      }
      if (referenceType) {
        query += ' AND l.reference_type = ?';
        params.push(referenceType);
      }
      if (referenceId) {
        query += ' AND l.reference_id = ?';
        params.push(referenceId);
      }

      query += ' ORDER BY l.created_at DESC LIMIT ? OFFSET ?';
      params.push(parseInt(limit), parseInt(offset));

      db.query(query, params, (err, entries) => {
        if (err) {
          console.error('Error fetching ledger entries:', err);
          return res.status(500).json({ success: false, error: 'Database error' });
        }

        res.json({
          success: true,
          entries,
          pagination: {
            limit: parseInt(limit),
            offset: parseInt(offset)
          }
        });
      });

    } catch (error) {
      console.error('Get ledger error:', error);
      res.status(500).json({ success: false, error: 'Server error' });
    }
  });

  /**
   * Get ledger entries for specific user
   */
  router.get('/entries/user/:userId', verifyToken, requireAdmin, (req, res) => {
    const userId = parseInt(req.params.userId);
    const { limit = 100, offset = 0 } = req.query;

    db.query(
      `SELECT * FROM ledger_entries 
       WHERE user_id = ? 
       ORDER BY created_at DESC 
       LIMIT ? OFFSET ?`,
      [userId, parseInt(limit), parseInt(offset)],
      (err, entries) => {
        if (err) {
          console.error('Error fetching user ledger:', err);
          return res.status(500).json({ success: false, error: 'Database error' });
        }

        // Get user's current balance for verification
        db.query(
          'SELECT username, email, balance FROM users WHERE id = ?',
          [userId],
          (userErr, users) => {
            if (userErr || users.length === 0) {
              return res.status(404).json({ success: false, error: 'User not found' });
            }

            // Calculate expected balance from ledger
            const expectedBalance = entries.length > 0 ? entries[0].balance_after : 0;
            const actualBalance = parseFloat(users[0].balance);
            const balanceMismatch = Math.abs(expectedBalance - actualBalance) > 0.01;

            res.json({
              success: true,
              user: users[0],
              entries,
              balanceCheck: {
                actual: actualBalance,
                expected: expectedBalance,
                mismatch: balanceMismatch
              }
            });
          }
        );
      }
    );
  });

  /**
   * Run reconciliation check
   */
  router.post('/reconcile', verifyToken, requireAdmin, async (req, res) => {
    try {
      const { userId } = req.body;

      // Get users to reconcile
      let userQuery = 'SELECT id, username, balance FROM users WHERE 1=1';
      const userParams = [];

      if (userId) {
        userQuery += ' AND id = ?';
        userParams.push(userId);
      }

      db.query(userQuery, userParams, async (userErr, users) => {
        if (userErr) {
          console.error('Error fetching users for reconciliation:', userErr);
          return res.status(500).json({ success: false, error: 'Database error' });
        }

        const mismatches = [];
        let checkedUsers = 0;
        let totalMismatches = 0;

        // Check each user
        for (const user of users) {
          const ledgerQuery = `
            SELECT balance_after, created_at 
            FROM ledger_entries 
            WHERE user_id = ? 
            ORDER BY created_at DESC 
            LIMIT 1
          `;

          await new Promise((resolve) => {
            db.query(ledgerQuery, [user.id], (ledgerErr, ledgerResults) => {
              if (ledgerErr) {
                console.error('Error fetching ledger for user:', user.id, ledgerErr);
                resolve();
                return;
              }

              checkedUsers++;
              const actualBalance = parseFloat(user.balance);
              const expectedBalance = ledgerResults.length > 0 ? parseFloat(ledgerResults[0].balance_after) : 0;
              const difference = actualBalance - expectedBalance;

              if (Math.abs(difference) > 0.01) {
                totalMismatches++;
                mismatches.push({
                  userId: user.id,
                  username: user.username,
                  actualBalance,
                  expectedBalance,
                  difference,
                  lastLedgerEntry: ledgerResults.length > 0 ? ledgerResults[0].created_at : null
                });

                // Log to reconciliation_logs table
                db.query(
                  `INSERT INTO reconciliation_logs 
                   (user_id, check_type, expected_balance, actual_balance, difference, details, checked_by)
                   VALUES (?, 'manual', ?, ?, ?, ?, ?)`,
                  [
                    user.id,
                    expectedBalance,
                    actualBalance,
                    difference,
                    JSON.stringify({ lastLedgerEntry: ledgerResults[0]?.created_at }),
                    req.user.userId
                  ],
                  (logErr) => {
                    if (logErr) console.error('Error logging reconciliation:', logErr);
                    resolve();
                  }
                );
              } else {
                resolve();
              }
            });
          });
        }

        logAdminAction(
          req.user.userId,
          req.user.username,
          'RECONCILE_LEDGER',
          {
            resourceType: 'ledger',
            checkedUsers,
            mismatches: totalMismatches,
            userId,
            ipAddress: getClientIP(req),
            userAgent: req.headers['user-agent']
          }
        );

        res.json({
          success: true,
          summary: {
            usersChecked: checkedUsers,
            mismatchesFound: totalMismatches
          },
          mismatches
        });
      });

    } catch (error) {
      console.error('Reconciliation error:', error);
      res.status(500).json({ success: false, error: 'Server error' });
    }
  });

  /**
   * Export ledger entries to CSV
   */
  router.get('/export', verifyToken, requireAdmin, (req, res) => {
    const { userId, startDate, endDate } = req.query;

    let query = `
      SELECT 
        l.id,
        l.created_at,
        l.user_id,
        u.username,
        l.entry_type,
        l.amount,
        l.currency,
        l.balance_before,
        l.balance_after,
        l.reference_type,
        l.reference_id,
        l.description
      FROM ledger_entries l
      JOIN users u ON l.user_id = u.id
      WHERE 1=1
    `;
    const params = [];

    if (userId) {
      query += ' AND l.user_id = ?';
      params.push(userId);
    }
    if (startDate) {
      query += ' AND l.created_at >= ?';
      params.push(startDate);
    }
    if (endDate) {
      query += ' AND l.created_at <= ?';
      params.push(endDate);
    }

    query += ' ORDER BY l.created_at DESC';

    db.query(query, params, (err, entries) => {
      if (err) {
        console.error('Error exporting ledger:', err);
        return res.status(500).json({ success: false, error: 'Database error' });
      }

      // Convert to CSV
      const headers = [
        'ID', 'Date', 'User ID', 'Username', 'Type', 
        'Amount', 'Currency', 'Balance Before', 'Balance After', 
        'Reference Type', 'Reference ID', 'Description'
      ];

      let csv = headers.join(',') + '\n';

      entries.forEach(entry => {
        const row = [
          entry.id,
          entry.created_at,
          entry.user_id,
          `"${entry.username}"`,
          entry.entry_type,
          entry.amount,
          entry.currency,
          entry.balance_before,
          entry.balance_after,
          entry.reference_type || '',
          entry.reference_id || '',
          `"${entry.description || ''}"`
        ];
        csv += row.join(',') + '\n';
      });

      logAdminAction(
        req.user.userId,
        req.user.username,
        'EXPORT_LEDGER',
        {
          resourceType: 'ledger',
          entryCount: entries.length,
          filters: { userId, startDate, endDate },
          ipAddress: getClientIP(req),
          userAgent: req.headers['user-agent']
        }
      );

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="ledger_export_${Date.now()}.csv"`);
      res.send(csv);
    });
  });

  /**
   * Get ledger statistics
   */
  router.get('/entries/stats/summary', verifyToken, requireAdmin, (req, res) => {
    // Check if ledger_entries table exists first
    db.query("SHOW TABLES LIKE 'ledger_entries'", (checkErr, tables) => {
      if (checkErr || !tables || tables.length === 0) {
        // Table doesn't exist yet, return empty stats
        return res.json({
          success: true,
          stats: [],
          overall: {
            total_entries: 0,
            unique_users: 0,
            total_credits: 0,
            total_debits: 0
          }
        });
      }

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
          entry_type,
          COUNT(*) as count,
          SUM(amount) as total_amount,
          AVG(amount) as avg_amount,
          MIN(amount) as min_amount,
          MAX(amount) as max_amount
        FROM ledger_entries
        WHERE 1=1 ${dateFilter}
        GROUP BY entry_type
        ORDER BY total_amount DESC`,
        params,
        (err, stats) => {
          if (err) {
            console.error('Error fetching ledger stats:', err);
            return res.status(500).json({ success: false, error: 'Database error', details: err.message });
          }

          // Get overall totals
          db.query(
            `SELECT 
              COUNT(*) as total_entries,
              COUNT(DISTINCT user_id) as unique_users,
              SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as total_credits,
              SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) as total_debits
            FROM ledger_entries
            WHERE 1=1 ${dateFilter}`,
            params,
            (overallErr, overall) => {
              if (overallErr) {
                console.error('Error fetching overall stats:', overallErr);
              }

              res.json({
                success: true,
                stats: stats || [],
                overall: overall && overall[0] ? overall[0] : {
                  total_entries: 0,
                  unique_users: 0,
                  total_credits: 0,
                  total_debits: 0
                }
              });
            }
          );
        }
      );
    });
  });

  /**
   * Create balance snapshot for verification
   */
  router.post('/snapshot', verifyToken, requireAdmin, async (req, res) => {
    try {
      // Get all user balances
      db.query(
        'SELECT id, balance FROM users',
        async (err, users) => {
          if (err) {
            console.error('Error fetching users for snapshot:', err);
            return res.status(500).json({ success: false, error: 'Database error' });
          }

          const totalBalance = users.reduce((sum, u) => sum + parseFloat(u.balance), 0);
          const userCount = users.length;

          // Insert snapshot
          db.query(
            `INSERT INTO balance_snapshots 
             (total_balance, user_count, snapshot_data, created_by)
             VALUES (?, ?, ?, ?)`,
            [totalBalance, userCount, JSON.stringify({ users }), req.user.userId],
            (insertErr, result) => {
              if (insertErr) {
                console.error('Error creating snapshot:', insertErr);
                return res.status(500).json({ success: false, error: 'Failed to create snapshot' });
              }

              logAdminAction(
                req.user.userId,
                req.user.username,
                'CREATE_BALANCE_SNAPSHOT',
                {
                  resourceType: 'balance_snapshot',
                  resourceId: result.insertId,
                  totalBalance,
                  userCount,
                  ipAddress: getClientIP(req),
                  userAgent: req.headers['user-agent']
                }
              );

              res.json({
                success: true,
                snapshot: {
                  id: result.insertId,
                  totalBalance,
                  userCount,
                  createdAt: new Date()
                }
              });
            }
          );
        }
      );

    } catch (error) {
      console.error('Snapshot error:', error);
      res.status(500).json({ success: false, error: 'Server error' });
    }
  });

  return router;
};
