// backend/routes/admin-risk.js
// Admin routes for risk and fraud management

const express = require('express');
const router = express.Router();
const RiskAssessmentService = require('../lib/risk_assessment');

module.exports = (db, adminAuth) => {
  const riskService = new RiskAssessmentService(db);

  // ============================================
  // GET /api/admin/risk/users
  // List high-risk users
  // ============================================
  router.get('/users', adminAuth.verifyAdminToken, adminAuth.requireAdmin, adminAuth.requirePermission('risk.view'), async (req, res) => {
    try {
      const { riskLevel, frozen, limit = 50, offset = 0 } = req.query;

      let query = `
        SELECT 
          u.id, u.username, u.email, u.created_at,
          urp.risk_score, urp.risk_level, urp.is_frozen, urp.withdrawals_frozen,
          urp.deposit_withdraw_ratio, urp.rapid_inout_flags, urp.linked_account_flags,
          urp.total_deposits, urp.total_withdrawals, urp.last_calculated_at
        FROM users u
        LEFT JOIN user_risk_profiles urp ON u.id = urp.user_id
        WHERE 1=1
      `;
      const params = [];

      if (riskLevel) {
        query += ' AND urp.risk_level = ?';
        params.push(riskLevel);
      }

      if (frozen === 'true') {
        query += ' AND (urp.is_frozen = TRUE OR urp.withdrawals_frozen = TRUE)';
      }

      query += ' ORDER BY urp.risk_score DESC, u.id DESC LIMIT ? OFFSET ?';
      params.push(parseInt(limit), parseInt(offset));

      db.query(query, params, (err, users) => {
        if (err) {
          console.error('Error fetching risk users:', err);
          return res.status(500).json({ success: false, error: 'Database error' });
        }

        adminAuth.logAdminAction(
          req.user.userId,
          req.user.username,
          'VIEW_RISK_USERS',
          {
            resourceType: 'risk_users',
            count: users.length,
            filters: { riskLevel, frozen },
            ipAddress: adminAuth.getClientIP(req),
            userAgent: req.headers['user-agent']
          }
        );

        res.json({ success: true, users });
      });
    } catch (error) {
      console.error('Get risk users error:', error);
      res.status(500).json({ success: false, error: 'Server error' });
    }
  });

  // ============================================
  // GET /api/admin/risk/users/:userId
  // Get detailed risk profile for user
  // ============================================
  router.get('/users/:userId', adminAuth.verifyAdminToken, adminAuth.requireAdmin, adminAuth.requirePermission('risk.view'), (req, res) => {
    const userId = parseInt(req.params.userId);

    db.query(
      `SELECT 
        u.*,
        urp.*
      FROM users u
      LEFT JOIN user_risk_profiles urp ON u.id = urp.user_id
      WHERE u.id = ?`,
      [userId],
      (err, profiles) => {
        if (err) {
          console.error('Error fetching user risk profile:', err);
          return res.status(500).json({ success: false, error: 'Database error' });
        }

        if (profiles.length === 0) {
          return res.status(404).json({ success: false, error: 'User not found' });
        }

        // Get linked accounts
        db.query(
          `SELECT 
            la.*,
            u.username as linked_username,
            u.email as linked_email
          FROM linked_accounts la
          JOIN users u ON la.linked_user_id = u.id
          WHERE la.user_id = ?
          ORDER BY la.confidence_score DESC`,
          [userId],
          (linkErr, linkedAccounts) => {
            if (linkErr) {
              console.error('Error fetching linked accounts:', linkErr);
            }

            // Get recent access logs
            db.query(
              `SELECT * FROM user_access_logs 
               WHERE user_id = ? 
               ORDER BY created_at DESC 
               LIMIT 20`,
              [userId],
              (logErr, accessLogs) => {
                if (logErr) {
                  console.error('Error fetching access logs:', logErr);
                }

                res.json({
                  success: true,
                  profile: profiles[0],
                  linkedAccounts: linkedAccounts || [],
                  accessLogs: accessLogs || []
                });
              }
            );
          }
        );
      }
    );
  });

  // ============================================
  // POST /api/admin/risk/users/:userId/freeze
  // Freeze user account or withdrawals
  // ============================================
  router.post('/users/:userId/freeze', adminAuth.verifyAdminToken, adminAuth.requireAdmin, adminAuth.requirePermission('risk.freeze'), async (req, res) => {
    const userId = parseInt(req.params.userId);
    const { freezeType, reason } = req.body; // freezeType: 'account' or 'withdrawals'

    if (!freezeType || !reason) {
      return res.status(400).json({ success: false, error: 'Missing freezeType or reason' });
    }

    try {
      let updateQuery;
      if (freezeType === 'account') {
        updateQuery = `
          INSERT INTO user_risk_profiles (user_id, is_frozen, freeze_reason, frozen_at, frozen_by)
          VALUES (?, TRUE, ?, NOW(), ?)
          ON CONFLICT (user_id) DO UPDATE SET
            is_frozen = TRUE,
            freeze_reason = EXCLUDED.freeze_reason,
            frozen_at = NOW(),
            frozen_by = EXCLUDED.frozen_by
        `;
      } else if (freezeType === 'withdrawals') {
        updateQuery = `
          INSERT INTO user_risk_profiles (user_id, withdrawals_frozen, withdrawal_freeze_reason, frozen_at, frozen_by)
          VALUES (?, TRUE, ?, NOW(), ?)
          ON CONFLICT (user_id) DO UPDATE SET
            withdrawals_frozen = TRUE,
            withdrawal_freeze_reason = EXCLUDED.withdrawal_freeze_reason,
            frozen_at = NOW(),
            frozen_by = EXCLUDED.frozen_by
        `;
      } else {
        return res.status(400).json({ success: false, error: 'Invalid freezeType' });
      }

      db.query(updateQuery, [userId, reason, req.user.userId], (err) => {
        if (err) {
          console.error('Error freezing user:', err);
          return res.status(500).json({ success: false, error: 'Database error' });
        }

        adminAuth.logAdminAction(
          req.user.userId,
          req.user.username,
          'FREEZE_USER',
          {
            resourceType: 'user',
            resourceId: userId,
            freezeType,
            reason,
            ipAddress: adminAuth.getClientIP(req),
            userAgent: req.headers['user-agent']
          }
        );

        res.json({ success: true, message: `User ${freezeType} frozen successfully` });
      });
    } catch (error) {
      console.error('Freeze user error:', error);
      res.status(500).json({ success: false, error: 'Server error' });
    }
  });

  // ============================================
  // POST /api/admin/risk/users/:userId/unfreeze
  // Unfreeze user account or withdrawals
  // ============================================
  router.post('/users/:userId/unfreeze', adminAuth.verifyAdminToken, adminAuth.requireAdmin, adminAuth.requirePermission('risk.freeze'), (req, res) => {
    const userId = parseInt(req.params.userId);
    const { freezeType } = req.body;

    let updateQuery;
    if (freezeType === 'account') {
      updateQuery = 'UPDATE user_risk_profiles SET is_frozen = FALSE, freeze_reason = NULL WHERE user_id = ?';
    } else if (freezeType === 'withdrawals') {
      updateQuery = 'UPDATE user_risk_profiles SET withdrawals_frozen = FALSE, withdrawal_freeze_reason = NULL WHERE user_id = ?';
    } else {
      return res.status(400).json({ success: false, error: 'Invalid freezeType' });
    }

    db.query(updateQuery, [userId], (err) => {
      if (err) {
        console.error('Error unfreezing user:', err);
        return res.status(500).json({ success: false, error: 'Database error' });
      }

      adminAuth.logAdminAction(
        req.user.userId,
        req.user.username,
        'UNFREEZE_USER',
        {
          resourceType: 'user',
          resourceId: userId,
          freezeType,
          ipAddress: adminAuth.getClientIP(req),
          userAgent: req.headers['user-agent']
        }
      );

      res.json({ success: true, message: `User ${freezeType} unfrozen successfully` });
    });
  });

  // ============================================
  // POST /api/admin/risk/users/:userId/recalculate
  // Recalculate user risk profile
  // ============================================
  router.post('/users/:userId/recalculate', adminAuth.verifyAdminToken, adminAuth.requireAdmin, adminAuth.requirePermission('risk.view'), async (req, res) => {
    const userId = parseInt(req.params.userId);

    try {
      await riskService.updateUserRiskProfile(userId);

      adminAuth.logAdminAction(
        req.user.userId,
        req.user.username,
        'RECALCULATE_RISK',
        {
          resourceType: 'user_risk_profile',
          resourceId: userId,
          ipAddress: adminAuth.getClientIP(req),
          userAgent: req.headers['user-agent']
        }
      );

      res.json({ success: true, message: 'Risk profile recalculated' });
    } catch (error) {
      console.error('Recalculate risk error:', error);
      res.status(500).json({ success: false, error: 'Server error' });
    }
  });

  // ============================================
  // GET /api/admin/risk/withdrawals/:withdrawalId
  // Get risk assessment for withdrawal
  // ============================================
  router.get('/withdrawals/:withdrawalId', adminAuth.verifyAdminToken, adminAuth.requireAdmin, adminAuth.requirePermission('withdrawals.view'), (req, res) => {
    const withdrawalId = parseInt(req.params.withdrawalId);

    db.query(
      'SELECT * FROM withdrawal_risk_assessments WHERE withdrawal_id = ?',
      [withdrawalId],
      (err, assessments) => {
        if (err) {
          console.error('Error fetching risk assessment:', err);
          return res.status(500).json({ success: false, error: 'Database error' });
        }

        if (assessments.length === 0) {
          return res.status(404).json({ success: false, error: 'Assessment not found' });
        }

        const assessment = assessments[0];
        
        // Parse risk_factors JSON
        if (assessment.risk_factors) {
          try {
            assessment.risk_factors = JSON.parse(assessment.risk_factors);
          } catch (e) {
            console.error('Error parsing risk factors:', e);
          }
        }

        res.json({ success: true, assessment });
      }
    );
  });

  // ============================================
  // POST /api/admin/risk/withdrawals/:withdrawalId/assess
  // Run risk assessment for withdrawal
  // ============================================
  router.post('/withdrawals/:withdrawalId/assess', adminAuth.verifyAdminToken, adminAuth.requireAdmin, adminAuth.requirePermission('withdrawals.view'), async (req, res) => {
    const withdrawalId = parseInt(req.params.withdrawalId);

    try {
      // Get withdrawal user_id
      db.query('SELECT user_id FROM withdrawals WHERE id = ?', [withdrawalId], async (err, withdrawals) => {
        if (err || withdrawals.length === 0) {
          return res.status(404).json({ success: false, error: 'Withdrawal not found' });
        }

        const userId = withdrawals[0].user_id;

        // Run assessment
        const assessment = await riskService.assessWithdrawal(withdrawalId, userId);

        adminAuth.logAdminAction(
          req.user.userId,
          req.user.username,
          'ASSESS_WITHDRAWAL_RISK',
          {
            resourceType: 'withdrawal',
            resourceId: withdrawalId,
            riskScore: assessment.riskScore,
            riskLevel: assessment.riskLevel,
            ipAddress: adminAuth.getClientIP(req),
            userAgent: req.headers['user-agent']
          }
        );

        res.json({ success: true, assessment });
      });
    } catch (error) {
      console.error('Assess withdrawal error:', error);
      res.status(500).json({ success: false, error: 'Server error' });
    }
  });

  // ============================================
  // GET /api/admin/risk/rules
  // Get all risk rules
  // ============================================
  router.get('/rules', adminAuth.verifyAdminToken, adminAuth.requireAdmin, adminAuth.requirePermission('risk.manage'), (req, res) => {
    db.query(
      'SELECT * FROM risk_rules ORDER BY category, rule_name',
      (err, rules) => {
        if (err) {
          console.error('Error fetching risk rules:', err);
          return res.status(500).json({ success: false, error: 'Database error' });
        }

        // Group by category
        const grouped = rules.reduce((acc, rule) => {
          if (!acc[rule.category]) acc[rule.category] = [];
          acc[rule.category].push(rule);
          return acc;
        }, {});

        res.json({ success: true, rules: grouped });
      }
    );
  });

  // ============================================
  // PUT /api/admin/risk/rules/:id
  // Update risk rule
  // ============================================
  router.put('/rules/:id', adminAuth.verifyAdminToken, adminAuth.requireAdmin, adminAuth.requirePermission('risk.manage'), (req, res) => {
    const ruleId = parseInt(req.params.id);
    const { rule_value, is_enabled } = req.body;

    db.query(
      'SELECT * FROM risk_rules WHERE id = ?',
      [ruleId],
      (err, rules) => {
        if (err || rules.length === 0) {
          return res.status(404).json({ success: false, error: 'Rule not found' });
        }

        const oldRule = rules[0];

        db.query(
          'UPDATE risk_rules SET rule_value = ?, is_enabled = ?, updated_by = ?, updated_at = NOW() WHERE id = ?',
          [rule_value, is_enabled, req.user.userId, ruleId],
          (updateErr) => {
            if (updateErr) {
              console.error('Error updating risk rule:', updateErr);
              return res.status(500).json({ success: false, error: 'Database error' });
            }

            adminAuth.logAdminAction(
              req.user.userId,
              req.user.username,
              'UPDATE_RISK_RULE',
              {
                resourceType: 'risk_rule',
                resourceId: ruleId,
                oldValue: { rule_value: oldRule.rule_value, is_enabled: oldRule.is_enabled },
                newValue: { rule_value, is_enabled },
                ruleKey: oldRule.rule_key,
                ipAddress: adminAuth.getClientIP(req),
                userAgent: req.headers['user-agent']
              }
            );

            res.json({ success: true, message: 'Risk rule updated' });
          }
        );
      }
    );
  });

  // ============================================
  // GET /api/admin/risk/linked-accounts/:userId
  // Get linked accounts for user
  // ============================================
  router.get('/linked-accounts/:userId', adminAuth.verifyAdminToken, adminAuth.requireAdmin, adminAuth.requirePermission('risk.view'), (req, res) => {
    const userId = parseInt(req.params.userId);

    db.query(
      `SELECT 
        la.*,
        u1.username as user_username,
        u1.email as user_email,
        u2.username as linked_username,
        u2.email as linked_email
      FROM linked_accounts la
      JOIN users u1 ON la.user_id = u1.id
      JOIN users u2 ON la.linked_user_id = u2.id
      WHERE la.user_id = ?
      ORDER BY la.confidence_score DESC, la.last_seen_at DESC`,
      [userId],
      (err, links) => {
        if (err) {
          console.error('Error fetching linked accounts:', err);
          return res.status(500).json({ success: false, error: 'Database error' });
        }

        res.json({ success: true, linkedAccounts: links });
      }
    );
  });

  // ============================================
  // GET /api/admin/risk/blacklist
  // Get wallet blacklist
  // ============================================
  router.get('/blacklist', adminAuth.verifyAdminToken, adminAuth.requireAdmin, adminAuth.requirePermission('risk.manage'), (req, res) => {
    const { network, is_active = 'true' } = req.query;

    let query = 'SELECT wb.*, u.username as added_by_username FROM wallet_blacklist wb JOIN users u ON wb.added_by = u.id WHERE 1=1';
    const params = [];

    if (network) {
      query += ' AND wb.network = ?';
      params.push(network);
    }

    if (is_active) {
      query += ' AND wb.is_active = ?';
      params.push(is_active === 'true');
    }

    query += ' ORDER BY wb.added_at DESC';

    db.query(query, params, (err, blacklist) => {
      if (err) {
        console.error('Error fetching blacklist:', err);
        return res.status(500).json({ success: false, error: 'Database error' });
      }

      res.json({ success: true, blacklist });
    });
  });

  // ============================================
  // POST /api/admin/risk/blacklist
  // Add wallet to blacklist
  // ============================================
  router.post('/blacklist', adminAuth.verifyAdminToken, adminAuth.requireAdmin, adminAuth.requirePermission('risk.manage'), (req, res) => {
    const { wallet_address, network, reason, risk_category, notes } = req.body;

    if (!wallet_address || !network || !reason || !risk_category) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    db.query(
      'INSERT INTO wallet_blacklist (wallet_address, network, reason, risk_category, added_by, notes) VALUES (?, ?, ?, ?, ?, ?)',
      [wallet_address, network, reason, risk_category, req.user.userId, notes || null],
      (err, result) => {
        if (err) {
          if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ success: false, error: 'Address already blacklisted' });
          }
          console.error('Error adding to blacklist:', err);
          return res.status(500).json({ success: false, error: 'Database error' });
        }

        adminAuth.logAdminAction(
          req.user.userId,
          req.user.username,
          'BLACKLIST_WALLET',
          {
            resourceType: 'wallet_blacklist',
            resourceId: result.insertId,
            wallet_address,
            network,
            reason,
            risk_category,
            ipAddress: adminAuth.getClientIP(req),
            userAgent: req.headers['user-agent']
          }
        );

        res.json({ success: true, message: 'Wallet added to blacklist', id: result.insertId });
      }
    );
  });

  // ============================================
  // DELETE /api/admin/risk/blacklist/:id
  // Remove wallet from blacklist
  // ============================================
  router.delete('/blacklist/:id', adminAuth.verifyAdminToken, adminAuth.requireAdmin, adminAuth.requirePermission('risk.manage'), (req, res) => {
    const blacklistId = parseInt(req.params.id);

    db.query(
      'UPDATE wallet_blacklist SET is_active = FALSE WHERE id = ?',
      [blacklistId],
      (err) => {
        if (err) {
          console.error('Error removing from blacklist:', err);
          return res.status(500).json({ success: false, error: 'Database error' });
        }

        adminAuth.logAdminAction(
          req.user.userId,
          req.user.username,
          'UNBLACKLIST_WALLET',
          {
            resourceType: 'wallet_blacklist',
            resourceId: blacklistId,
            ipAddress: adminAuth.getClientIP(req),
            userAgent: req.headers['user-agent']
          }
        );

        res.json({ success: true, message: 'Wallet removed from blacklist' });
      }
    );
  });

  return router;
};
