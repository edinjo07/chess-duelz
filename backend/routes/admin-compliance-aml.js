const express = require('express');
const moment = require('moment');

module.exports = (db, adminAuth) => {
  const router = express.Router();
  const { requireAdmin, requirePermission, logAdminAction, verifyAdminToken } = adminAuth;

  // All routes require a valid admin token
  router.use(verifyAdminToken);

  // ============================================
  // AML MONITORING ENDPOINTS
  // ============================================

  /**
   * GET /api/admin/compliance/aml/alerts
   * List all AML alerts with filters
   * Permission: compliance.view
   */
  router.get('/aml/alerts', requireAdmin, requirePermission('compliance.view'), async (req, res) => {
    try {
      const { 
        status,           // new, investigating, escalated, resolved, false_positive
        severity,         // low, medium, high, critical
        alertType,
        userId,
        username,
        assignedTo,
        dateFrom,
        dateTo,
        sortBy = 'detected_at',
        sortOrder = 'desc',
        page = 1,
        limit = 50
      } = req.query;

      const offset = (parseInt(page) - 1) * parseInt(limit);
      
      let query = `
        SELECT 
          aa.*,
          uks.current_tier,
          uks.is_pep,
          uks.is_sanctioned,
          TIMESTAMPDIFF(HOUR, aa.detected_at, NOW()) AS hours_open
        FROM aml_alerts aa
        LEFT JOIN user_kyc_status uks ON aa.user_id = uks.user_id
        WHERE 1=1
      `;
      
      const params = [];

      if (status) {
        query += ` AND aa.status = ?`;
        params.push(status);
      }

      if (severity) {
        query += ` AND aa.severity = ?`;
        params.push(severity);
      }

      if (alertType) {
        query += ` AND aa.alert_type = ?`;
        params.push(alertType);
      }

      if (userId) {
        query += ` AND aa.user_id = ?`;
        params.push(userId);
      }

      if (username) {
        query += ` AND aa.username LIKE ?`;
        params.push(`%${username}%`);
      }

      if (assignedTo) {
        query += ` AND aa.assigned_to = ?`;
        params.push(assignedTo);
      }

      if (dateFrom) {
        query += ` AND aa.detected_at >= ?`;
        params.push(dateFrom);
      }

      if (dateTo) {
        query += ` AND aa.detected_at <= ?`;
        params.push(dateTo);
      }

      // Count total
      const countQuery = query.replace(/SELECT.*FROM/, 'SELECT COUNT(*) as total FROM');
      const [countResult] = await db.query(countQuery, params);
      const total = countResult[0].total;

      // Add sorting and pagination
      const validSortFields = ['detected_at', 'severity', 'status', 'risk_score', 'hours_open'];
      const sortField = validSortFields.includes(sortBy) ? sortBy : 'detected_at';
      const order = sortOrder.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
      
      // Priority sort for active alerts
      if (status && ['new', 'investigating', 'escalated'].includes(status)) {
        query += ` ORDER BY 
          CASE aa.severity
            WHEN 'critical' THEN 1
            WHEN 'high' THEN 2
            WHEN 'medium' THEN 3
            WHEN 'low' THEN 4
          END,
          ${sortField} ${order}
        `;
      } else {
        query += ` ORDER BY ${sortField} ${order}`;
      }
      
      query += ` LIMIT ? OFFSET ?`;
      params.push(parseInt(limit), offset);

      const [alerts] = await db.query(query, params);

      res.json({
        success: true,
        alerts,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / parseInt(limit))
        }
      });
    } catch (error) {
      console.error('Get AML alerts error:', error);
      res.status(500).json({ success: false, message: 'Failed to get AML alerts' });
    }
  });


  /**
   * GET /api/admin/compliance/aml/alerts/:alertId
   * Get detailed AML alert information
   * Permission: compliance.view
   */
  router.get('/aml/alerts/:alertId', requireAdmin, requirePermission('compliance.view'), async (req, res) => {
    try {
      const { alertId } = req.params;

      // Get alert details
      const [alerts] = await db.query(`
        SELECT 
          aa.*,
          uks.current_tier,
          uks.is_pep,
          uks.is_sanctioned,
          uks.risk_score as user_risk_score,
          TIMESTAMPDIFF(HOUR, aa.detected_at, NOW()) AS hours_open
        FROM aml_alerts aa
        LEFT JOIN user_kyc_status uks ON aa.user_id = uks.user_id
        WHERE aa.id = ?
      `, [alertId]);

      if (alerts.length === 0) {
        return res.status(404).json({ success: false, message: 'AML alert not found' });
      }

      const alert = alerts[0];

      // Get related transactions if available
      let relatedTransactions = [];
      if (alert.related_transaction_ids) {
        try {
          const txIds = JSON.parse(alert.related_transaction_ids);
          if (txIds && txIds.length > 0) {
            const placeholders = txIds.map(() => '?').join(',');
            const [txs] = await db.query(`
              SELECT * FROM ledger_entries
              WHERE id IN (${placeholders})
              ORDER BY created_at DESC
            `, txIds);
            relatedTransactions = txs;
          }
        } catch (e) {
          console.error('Failed to parse transaction IDs:', e);
        }
      }

      // Get user's compliance history
      const [complianceActions] = await db.query(`
        SELECT *
        FROM compliance_actions
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT 20
      `, [alert.user_id]);

      // Get user's other alerts
      const [otherAlerts] = await db.query(`
        SELECT *
        FROM aml_alerts
        WHERE user_id = ? AND id != ?
        ORDER BY detected_at DESC
        LIMIT 10
      `, [alert.user_id, alertId]);

      res.json({
        success: true,
        alert,
        relatedTransactions,
        complianceHistory: complianceActions,
        otherAlerts
      });
    } catch (error) {
      console.error('Get AML alert details error:', error);
      res.status(500).json({ success: false, message: 'Failed to get AML alert details' });
    }
  });


  /**
   * POST /api/admin/compliance/aml/alerts/:alertId/assign
   * Assign AML alert to a compliance officer
   * Permission: compliance.manage
   */
  router.post('/aml/alerts/:alertId/assign', requireAdmin, requirePermission('compliance.manage'), async (req, res) => {
    try {
      const { alertId } = req.params;
      const { assigneeId } = req.body; // If null, assign to self

      const targetAssigneeId = assigneeId || req.user.id;

      // Verify assignee is admin
      const [assignee] = await db.query(`
        SELECT id, username FROM users WHERE id = ? AND is_admin = TRUE
      `, [targetAssigneeId]);

      if (assignee.length === 0) {
        return res.status(400).json({ success: false, message: 'Invalid assignee' });
      }

      // Update alert
      await db.query(`
        UPDATE aml_alerts
        SET 
          assigned_to = ?,
          assigned_to_username = ?,
          assigned_at = NOW(),
          status = CASE WHEN status = 'new' THEN 'investigating' ELSE status END
        WHERE id = ?
      `, [targetAssigneeId, assignee[0].username, alertId]);

      // Log admin action
      await logAdminAction(db, {
        adminId: req.user.id,
        adminUsername: req.user.username,
        action: 'aml_alert_assigned',
        targetType: 'aml_alert',
        targetId: alertId,
        details: { assignedTo: targetAssigneeId, assignedToUsername: assignee[0].username },
        ipAddress: req.ip
      });

      res.json({ success: true, message: 'AML alert assigned successfully' });
    } catch (error) {
      console.error('Assign AML alert error:', error);
      res.status(500).json({ success: false, message: 'Failed to assign AML alert' });
    }
  });


  /**
   * POST /api/admin/compliance/aml/alerts/:alertId/investigate
   * Add investigation notes to AML alert
   * Permission: compliance.manage
   */
  router.post('/aml/alerts/:alertId/investigate', requireAdmin, requirePermission('compliance.manage'), async (req, res) => {
    try {
      const { alertId } = req.params;
      const { notes, actionsTaken } = req.body;

      if (!notes) {
        return res.status(400).json({ success: false, message: 'Investigation notes are required' });
      }

      // Get current alert
      const [current] = await db.query(`SELECT * FROM aml_alerts WHERE id = ?`, [alertId]);
      
      if (current.length === 0) {
        return res.status(404).json({ success: false, message: 'AML alert not found' });
      }

      // Append notes (preserve existing)
      const existingNotes = current[0].investigation_notes || '';
      const timestamp = moment().format('YYYY-MM-DD HH:mm:ss');
      const newNotes = `${existingNotes}\n\n[${timestamp}] ${req.user.username}:\n${notes}`.trim();

      // Update actions taken
      let updatedActions = [];
      if (current[0].actions_taken) {
        try {
          updatedActions = JSON.parse(current[0].actions_taken);
        } catch (e) {
          updatedActions = [];
        }
      }
      
      if (actionsTaken && Array.isArray(actionsTaken)) {
        updatedActions = [...updatedActions, ...actionsTaken.map(a => ({
          action: a,
          timestamp,
          officer: req.user.username
        }))];
      }

      await db.query(`
        UPDATE aml_alerts
        SET 
          investigation_notes = ?,
          actions_taken = ?,
          status = CASE WHEN status = 'new' THEN 'investigating' ELSE status END
        WHERE id = ?
      `, [newNotes, JSON.stringify(updatedActions), alertId]);

      // Log admin action
      await logAdminAction(db, {
        adminId: req.user.id,
        adminUsername: req.user.username,
        action: 'aml_alert_investigated',
        targetType: 'aml_alert',
        targetId: alertId,
        details: { notes, actionsTaken },
        ipAddress: req.ip
      });

      res.json({ success: true, message: 'Investigation notes added successfully' });
    } catch (error) {
      console.error('Add investigation notes error:', error);
      res.status(500).json({ success: false, message: 'Failed to add investigation notes' });
    }
  });


  /**
   * POST /api/admin/compliance/aml/alerts/:alertId/resolve
   * Resolve an AML alert
   * Permission: compliance.manage
   */
  router.post('/aml/alerts/:alertId/resolve', requireAdmin, requirePermission('compliance.manage'), async (req, res) => {
    const connection = await db.getConnection();
    
    try {
      const { alertId } = req.params;
      const { resolution, isFalsePositive, actionsTaken } = req.body;

      if (!resolution) {
        return res.status(400).json({ success: false, message: 'Resolution is required' });
      }

      await connection.beginTransaction();

      // Get alert
      const [alerts] = await connection.query(`
        SELECT * FROM aml_alerts WHERE id = ? FOR UPDATE
      `, [alertId]);

      if (alerts.length === 0) {
        await connection.rollback();
        return res.status(404).json({ success: false, message: 'AML alert not found' });
      }

      const alert = alerts[0];

      // Update alert status
      const newStatus = isFalsePositive ? 'false_positive' : 'resolved';
      
      await connection.query(`
        UPDATE aml_alerts
        SET 
          status = ?,
          resolution = ?,
          resolved_at = NOW(),
          actions_taken = ?
        WHERE id = ?
      `, [newStatus, resolution, JSON.stringify(actionsTaken || []), alertId]);

      // Log compliance action
      await connection.query(`
        INSERT INTO compliance_actions (user_id, username, action_type, reason, officer_id, officer_username, details, related_alert_id)
        VALUES (?, ?, 'aml_alert_created', ?, ?, ?, ?, ?)
      `, [
        alert.user_id,
        alert.username,
        `AML alert resolved: ${resolution}`,
        req.user.id,
        req.user.username,
        JSON.stringify({ alertType: alert.alert_type, resolution, isFalsePositive }),
        alertId
      ]);

      await connection.commit();

      // Log admin action
      await logAdminAction(db, {
        adminId: req.user.id,
        adminUsername: req.user.username,
        action: 'aml_alert_resolved',
        targetType: 'aml_alert',
        targetId: alertId,
        details: { resolution, isFalsePositive, actionsTaken },
        ipAddress: req.ip
      });

      res.json({ success: true, message: 'AML alert resolved successfully' });
    } catch (error) {
      await connection.rollback();
      console.error('Resolve AML alert error:', error);
      res.status(500).json({ success: false, message: 'Failed to resolve AML alert' });
    } finally {
      connection.release();
    }
  });


  /**
   * POST /api/admin/compliance/aml/alerts/:alertId/escalate
   * Escalate an AML alert
   * Permission: compliance.manage
   */
  router.post('/aml/alerts/:alertId/escalate', requireAdmin, requirePermission('compliance.manage'), async (req, res) => {
    try {
      const { alertId } = req.params;
      const { reason } = req.body;

      await db.query(`
        UPDATE aml_alerts
        SET 
          status = 'escalated',
          severity = CASE 
            WHEN severity = 'low' THEN 'medium'
            WHEN severity = 'medium' THEN 'high'
            WHEN severity = 'high' THEN 'critical'
            ELSE severity
          END,
          investigation_notes = CONCAT(
            COALESCE(investigation_notes, ''), 
            '\n\n[', NOW(), '] Escalated by ', ?, ':\n', ?
          )
        WHERE id = ?
      `, [req.user.username, reason || 'Alert escalated for further review', alertId]);

      // Log admin action
      await logAdminAction(db, {
        adminId: req.user.id,
        adminUsername: req.user.username,
        action: 'aml_alert_escalated',
        targetType: 'aml_alert',
        targetId: alertId,
        details: { reason },
        ipAddress: req.ip
      });

      res.json({ success: true, message: 'AML alert escalated successfully' });
    } catch (error) {
      console.error('Escalate AML alert error:', error);
      res.status(500).json({ success: false, message: 'Failed to escalate AML alert' });
    }
  });


  /**
   * POST /api/admin/compliance/aml/alerts/:alertId/sar
   * File a Suspicious Activity Report (SAR)
   * Permission: compliance.manage
   */
  router.post('/aml/alerts/:alertId/sar', requireAdmin, requirePermission('compliance.manage'), async (req, res) => {
    const connection = await db.getConnection();
    
    try {
      const { alertId } = req.params;
      const { sarNumber, filedTo, notes } = req.body;

      if (!sarNumber) {
        return res.status(400).json({ success: false, message: 'SAR number is required' });
      }

      await connection.beginTransaction();

      // Get alert
      const [alerts] = await connection.query(`
        SELECT * FROM aml_alerts WHERE id = ? FOR UPDATE
      `, [alertId]);

      if (alerts.length === 0) {
        await connection.rollback();
        return res.status(404).json({ success: false, message: 'AML alert not found' });
      }

      const alert = alerts[0];

      // Update alert with SAR info
      await connection.query(`
        UPDATE aml_alerts
        SET 
          sar_filed = TRUE,
          sar_number = ?,
          sar_filed_at = NOW(),
          sar_filed_by = ?,
          investigation_notes = CONCAT(
            COALESCE(investigation_notes, ''), 
            '\n\n[', NOW(), '] SAR Filed by ', ?, ':\nSAR Number: ', ?, '\nFiled To: ', ?, '\n', ?
          )
        WHERE id = ?
      `, [sarNumber, req.user.id, req.user.username, sarNumber, filedTo || 'FinCEN', notes || '', alertId]);

      // Log compliance action
      await connection.query(`
        INSERT INTO compliance_actions (user_id, username, action_type, reason, officer_id, officer_username, details, related_alert_id)
        VALUES (?, ?, 'sar_filed', ?, ?, ?, ?, ?)
      `, [
        alert.user_id,
        alert.username,
        `SAR filed: ${sarNumber}`,
        req.user.id,
        req.user.username,
        JSON.stringify({ sarNumber, filedTo, alertType: alert.alert_type }),
        alertId
      ]);

      await connection.commit();

      // Log admin action
      await logAdminAction(db, {
        adminId: req.user.id,
        adminUsername: req.user.username,
        action: 'sar_filed',
        targetType: 'aml_alert',
        targetId: alertId,
        details: { sarNumber, filedTo, notes },
        ipAddress: req.ip
      });

      res.json({ success: true, message: 'SAR filed successfully' });
    } catch (error) {
      await connection.rollback();
      console.error('File SAR error:', error);
      res.status(500).json({ success: false, message: 'Failed to file SAR' });
    } finally {
      connection.release();
    }
  });


  /**
   * GET /api/admin/compliance/aml/rules
   * Get all AML monitoring rules
   * Permission: compliance.view
   */
  router.get('/aml/rules', requireAdmin, requirePermission('compliance.view'), async (req, res) => {
    try {
      const [rules] = await db.query(`
        SELECT * FROM aml_rules ORDER BY is_active DESC, rule_type ASC
      `);

      res.json({
        success: true,
        rules
      });
    } catch (error) {
      console.error('Get AML rules error:', error);
      res.status(500).json({ success: false, message: 'Failed to get AML rules' });
    }
  });


  /**
   * POST /api/admin/compliance/aml/rules
   * Create a new AML monitoring rule
   * Permission: compliance.manage
   */
  router.post('/aml/rules', requireAdmin, requirePermission('compliance.manage'), async (req, res) => {
    try {
      const { 
        ruleName, 
        ruleType, 
        thresholdValue, 
        timeWindowHours, 
        transactionCount,
        conditions, 
        alertSeverity, 
        autoBlock, 
        autoFlag, 
        description 
      } = req.body;

      if (!ruleName || !ruleType || !conditions || !alertSeverity) {
        return res.status(400).json({ success: false, message: 'Missing required fields' });
      }

      const [result] = await db.query(`
        INSERT INTO aml_rules (
          rule_name, rule_type, threshold_value, time_window_hours, transaction_count,
          conditions, alert_severity, auto_block, auto_flag, description, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        ruleName, ruleType, thresholdValue || null, timeWindowHours || null, transactionCount || null,
        JSON.stringify(conditions), alertSeverity, autoBlock || false, autoFlag || true, 
        description || null, req.user.id
      ]);

      // Log admin action
      await logAdminAction(db, {
        adminId: req.user.id,
        adminUsername: req.user.username,
        action: 'aml_rule_created',
        targetType: 'aml_rule',
        targetId: result.insertId,
        details: { ruleName, ruleType, conditions },
        ipAddress: req.ip
      });

      res.json({ 
        success: true, 
        message: 'AML rule created successfully',
        ruleId: result.insertId
      });
    } catch (error) {
      console.error('Create AML rule error:', error);
      res.status(500).json({ success: false, message: 'Failed to create AML rule' });
    }
  });


  /**
   * PATCH /api/admin/compliance/aml/rules/:ruleId
   * Update an AML monitoring rule
   * Permission: compliance.manage
   */
  router.patch('/aml/rules/:ruleId', requireAdmin, requirePermission('compliance.manage'), async (req, res) => {
    try {
      const { ruleId } = req.params;
      const { isActive, alertSeverity, autoBlock, autoFlag } = req.body;

      const updates = [];
      const params = [];

      if (typeof isActive === 'boolean') {
        updates.push('is_active = ?');
        params.push(isActive);
      }

      if (alertSeverity) {
        updates.push('alert_severity = ?');
        params.push(alertSeverity);
      }

      if (typeof autoBlock === 'boolean') {
        updates.push('auto_block = ?');
        params.push(autoBlock);
      }

      if (typeof autoFlag === 'boolean') {
        updates.push('auto_flag = ?');
        params.push(autoFlag);
      }

      if (updates.length === 0) {
        return res.status(400).json({ success: false, message: 'No updates provided' });
      }

      params.push(ruleId);

      await db.query(`
        UPDATE aml_rules
        SET ${updates.join(', ')}
        WHERE id = ?
      `, params);

      // Log admin action
      await logAdminAction(db, {
        adminId: req.user.id,
        adminUsername: req.user.username,
        action: 'aml_rule_updated',
        targetType: 'aml_rule',
        targetId: ruleId,
        details: { isActive, alertSeverity, autoBlock, autoFlag },
        ipAddress: req.ip
      });

      res.json({ success: true, message: 'AML rule updated successfully' });
    } catch (error) {
      console.error('Update AML rule error:', error);
      res.status(500).json({ success: false, message: 'Failed to update AML rule' });
    }
  });


  /**
   * GET /api/admin/compliance/aml/statistics
   * Get AML monitoring statistics
   * Permission: compliance.view
   */
  router.get('/aml/statistics', requireAdmin, requirePermission('compliance.view'), async (req, res) => {
    try {
      // Get compliance stats view
      const [stats] = await db.query(`SELECT * FROM v_compliance_stats`);

      // Active alerts by severity
      const [bySeverity] = await db.query(`
        SELECT severity, COUNT(*) as count
        FROM aml_alerts
        WHERE status IN ('new', 'investigating', 'escalated')
        GROUP BY severity
      `);

      // Alerts by type (last 30 days)
      const [byType] = await db.query(`
        SELECT alert_type, COUNT(*) as count
        FROM aml_alerts
        WHERE detected_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
        GROUP BY alert_type
        ORDER BY count DESC
      `);

      // Resolution rate
      const [resolution] = await db.query(`
        SELECT 
          COUNT(CASE WHEN status = 'resolved' THEN 1 END) as resolved,
          COUNT(CASE WHEN status = 'false_positive' THEN 1 END) as false_positives,
          COUNT(*) as total
        FROM aml_alerts
        WHERE detected_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      `);

      // Average resolution time
      const [avgTime] = await db.query(`
        SELECT AVG(TIMESTAMPDIFF(HOUR, detected_at, resolved_at)) as avg_hours
        FROM aml_alerts
        WHERE status IN ('resolved', 'false_positive') 
        AND resolved_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      `);

      res.json({
        success: true,
        statistics: {
          compliance: stats[0],
          alertsBySeverity: bySeverity,
          alertsByType: byType,
          resolutionStats: resolution[0],
          averageResolutionHours: Math.round(avgTime[0].avg_hours || 0)
        }
      });
    } catch (error) {
      console.error('Get AML statistics error:', error);
      res.status(500).json({ success: false, message: 'Failed to get AML statistics' });
    }
  });


  /**
   * GET /api/admin/compliance/aml/users/:userId/risk-profile
   * Get user's AML risk profile
   * Permission: compliance.view
   */
  router.get('/aml/users/:userId/risk-profile', requireAdmin, requirePermission('compliance.view'), async (req, res) => {
    try {
      const { userId } = req.params;

      // Get user info
      const [users] = await db.query(`
        SELECT u.id, u.username, u.email, uks.*
        FROM users u
        LEFT JOIN user_kyc_status uks ON u.id = uks.user_id
        WHERE u.id = ?
      `, [userId]);

      if (users.length === 0) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      // Get AML alerts
      const [alerts] = await db.query(`
        SELECT * FROM aml_alerts
        WHERE user_id = ?
        ORDER BY detected_at DESC
      `, [userId]);

      // Get recent transactions
      const [transactions] = await db.query(`
        SELECT * FROM ledger_entries
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT 100
      `, [userId]);

      // Calculate risk metrics
      const activeAlerts = alerts.filter(a => ['new', 'investigating', 'escalated'].includes(a.status)).length;
      const criticalAlerts = alerts.filter(a => a.severity === 'critical').length;
      const sarsFiled = alerts.filter(a => a.sar_filed).length;

      const totalDeposits = transactions
        .filter(t => t.type === 'deposit')
        .reduce((sum, t) => sum + parseFloat(t.amount), 0);
      
      const totalWithdrawals = transactions
        .filter(t => t.type === 'withdrawal')
        .reduce((sum, t) => sum + parseFloat(t.amount), 0);

      res.json({
        success: true,
        user: users[0],
        alerts,
        recentTransactions: transactions.slice(0, 20),
        riskMetrics: {
          activeAlerts,
          criticalAlerts,
          totalAlerts: alerts.length,
          sarsFiled,
          totalDeposits,
          totalWithdrawals,
          transactionCount: transactions.length
        }
      });
    } catch (error) {
      console.error('Get AML risk profile error:', error);
      res.status(500).json({ success: false, message: 'Failed to get AML risk profile' });
    }
  });


  return router;
};
