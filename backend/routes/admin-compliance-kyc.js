const express = require('express');
const moment = require('moment');

module.exports = (db, adminAuth) => {
  const router = express.Router();
  const { requireAdmin, requirePermission, logAdminAction, verifyAdminToken } = adminAuth;

  // All routes require a valid admin token
  router.use(verifyAdminToken);

  // ============================================
  // KYC TIER MANAGEMENT ENDPOINTS
  // ============================================

  /**
   * GET /api/admin/compliance/kyc/applications
   * List all KYC applications with filters
   * Permission: compliance.view
   */
  router.get('/kyc/applications', requireAdmin, requirePermission('compliance.view'), async (req, res) => {
    try {
      const { 
        status,           // pending, under_review, approved, rejected
        tier,             // 0, 1, 2, 3
        userId,
        username,
        sortBy = 'applied_at',
        sortOrder = 'desc',
        page = 1,
        limit = 50
      } = req.query;

      const offset = (parseInt(page) - 1) * parseInt(limit);
      
      let query = `
        SELECT 
          uks.*,
          kt.tier_name AS applied_tier_name,
          kt.documents_required,
          TIMESTAMPDIFF(HOUR, uks.applied_at, NOW()) AS hours_pending
        FROM user_kyc_status uks
        LEFT JOIN kyc_tiers kt ON uks.applied_for_tier = kt.tier_level
        WHERE 1=1
      `;
      
      const params = [];

      if (status) {
        query += ` AND uks.application_status = ?`;
        params.push(status);
      }

      if (tier) {
        query += ` AND uks.applied_for_tier = ?`;
        params.push(tier);
      }

      if (userId) {
        query += ` AND uks.user_id = ?`;
        params.push(userId);
      }

      if (username) {
        query += ` AND uks.username LIKE ?`;
        params.push(`%${username}%`);
      }

      // Count total
      const countQuery = query.replace(/SELECT.*FROM/, 'SELECT COUNT(*) as total FROM');
      const [countResult] = await db.query(countQuery, params);
      const total = countResult[0].total;

      // Add sorting and pagination
      const validSortFields = ['applied_at', 'applied_for_tier', 'application_status', 'hours_pending'];
      const sortField = validSortFields.includes(sortBy) ? sortBy : 'applied_at';
      const order = sortOrder.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
      
      query += ` ORDER BY ${sortField} ${order} LIMIT ? OFFSET ?`;
      params.push(parseInt(limit), offset);

      const [applications] = await db.query(query, params);

      res.json({
        success: true,
        applications,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / parseInt(limit))
        }
      });
    } catch (error) {
      console.error('Get KYC applications error:', error);
      res.status(500).json({ success: false, message: 'Failed to get KYC applications' });
    }
  });


  /**
   * GET /api/admin/compliance/kyc/applications/:userId
   * Get detailed KYC application for a user
   * Permission: compliance.view
   */
  router.get('/kyc/applications/:userId', requireAdmin, requirePermission('compliance.view'), async (req, res) => {
    try {
      const { userId } = req.params;

      // Get user KYC status
      const [kycStatus] = await db.query(`
        SELECT 
          uks.*,
          kt_current.tier_name AS current_tier_name,
          kt_applied.tier_name AS applied_tier_name,
          kt_applied.documents_required
        FROM user_kyc_status uks
        JOIN kyc_tiers kt_current ON uks.current_tier = kt_current.tier_level
        LEFT JOIN kyc_tiers kt_applied ON uks.applied_for_tier = kt_applied.tier_level
        WHERE uks.user_id = ?
      `, [userId]);

      if (kycStatus.length === 0) {
        return res.status(404).json({ success: false, message: 'KYC status not found for user' });
      }

      // Get compliance actions history
      const [actions] = await db.query(`
        SELECT *
        FROM compliance_actions
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT 20
      `, [userId]);

      // Get AML alerts
      const [amlAlerts] = await db.query(`
        SELECT *
        FROM aml_alerts
        WHERE user_id = ?
        ORDER BY detected_at DESC
        LIMIT 10
      `, [userId]);

      // Get source of funds
      const [sof] = await db.query(`
        SELECT *
        FROM source_of_funds
        WHERE user_id = ?
        ORDER BY submitted_at DESC
        LIMIT 5
      `, [userId]);

      res.json({
        success: true,
        kyc: kycStatus[0],
        complianceHistory: actions,
        amlAlerts,
        sourceOfFunds: sof
      });
    } catch (error) {
      console.error('Get KYC application details error:', error);
      res.status(500).json({ success: false, message: 'Failed to get KYC application details' });
    }
  });


  /**
   * POST /api/admin/compliance/kyc/applications/:userId/review
   * Approve or reject a KYC application
   * Permission: compliance.manage
   */
  router.post('/kyc/applications/:userId/review', requireAdmin, requirePermission('compliance.manage'), async (req, res) => {
    const connection = await db.getConnection();
    
    try {
      const { userId } = req.params;
      const { action, notes, documentsStatus } = req.body; // action: 'approve', 'reject', 'request_more_info'

      if (!['approve', 'reject', 'request_more_info'].includes(action)) {
        return res.status(400).json({ success: false, message: 'Invalid action' });
      }

      await connection.beginTransaction();

      // Get current application
      const [current] = await connection.query(`
        SELECT * FROM user_kyc_status WHERE user_id = ? FOR UPDATE
      `, [userId]);

      if (current.length === 0) {
        await connection.rollback();
        return res.status(404).json({ success: false, message: 'KYC application not found' });
      }

      const app = current[0];

      if (action === 'approve') {
        // Upgrade user tier
        await connection.query(`
          UPDATE user_kyc_status
          SET 
            current_tier = applied_for_tier,
            previous_tier = current_tier,
            tier_upgraded_at = NOW(),
            application_status = 'approved',
            verified_by = ?,
            verified_by_username = ?,
            verified_at = NOW(),
            verification_notes = ?,
            documents_status = ?
          WHERE user_id = ?
        `, [req.user.id, req.user.username, notes || 'KYC approved', JSON.stringify(documentsStatus || {}), userId]);

        // Log compliance action
        await connection.query(`
          INSERT INTO compliance_actions (user_id, username, action_type, reason, officer_id, officer_username, details)
          VALUES (?, ?, 'kyc_upgraded', ?, ?, ?, ?)
        `, [
          userId,
          app.username,
          `KYC upgraded from Tier ${app.current_tier} to Tier ${app.applied_for_tier}`,
          req.user.id,
          req.user.username,
          JSON.stringify({ notes, documentsStatus })
        ]);

      } else if (action === 'reject') {
        // Reject application
        await connection.query(`
          UPDATE user_kyc_status
          SET 
            application_status = 'rejected',
            applied_for_tier = NULL,
            rejection_reason = ?,
            rejected_at = NOW(),
            can_reapply_at = DATE_ADD(NOW(), INTERVAL 7 DAY),
            documents_status = ?
          WHERE user_id = ?
        `, [notes || 'KYC application rejected', JSON.stringify(documentsStatus || {}), userId]);

        // Log compliance action
        await connection.query(`
          INSERT INTO compliance_actions (user_id, username, action_type, reason, officer_id, officer_username, details)
          VALUES (?, ?, 'kyc_downgraded', ?, ?, ?, ?)
        `, [
          userId,
          app.username,
          `KYC application rejected for Tier ${app.applied_for_tier}`,
          req.user.id,
          req.user.username,
          JSON.stringify({ notes, documentsStatus })
        ]);

      } else if (action === 'request_more_info') {
        // Request additional information
        await connection.query(`
          UPDATE user_kyc_status
          SET 
            application_status = 'under_review',
            verification_notes = ?,
            documents_status = ?
          WHERE user_id = ?
        `, [notes || 'Additional information required', JSON.stringify(documentsStatus || {}), userId]);
      }

      await connection.commit();

      // Log admin action
      await logAdminAction(db, {
        adminId: req.user.id,
        adminUsername: req.user.username,
        action: `kyc_review_${action}`,
        targetType: 'user',
        targetId: userId,
        details: { action, notes, documentsStatus },
        ipAddress: req.ip
      });

      res.json({ success: true, message: `KYC application ${action}d successfully` });
    } catch (error) {
      await connection.rollback();
      console.error('Review KYC application error:', error);
      res.status(500).json({ success: false, message: 'Failed to review KYC application' });
    } finally {
      connection.release();
    }
  });


  /**
   * POST /api/admin/compliance/kyc/users/:userId/tier
   * Manually adjust user tier (admin override)
   * Permission: compliance.manage
   */
  router.post('/kyc/users/:userId/tier', requireAdmin, requirePermission('compliance.manage'), async (req, res) => {
    const connection = await db.getConnection();
    
    try {
      const { userId } = req.params;
      const { newTier, reason } = req.body;

      if (![0, 1, 2, 3].includes(parseInt(newTier))) {
        return res.status(400).json({ success: false, message: 'Invalid tier' });
      }

      if (!reason) {
        return res.status(400).json({ success: false, message: 'Reason is required' });
      }

      await connection.beginTransaction();

      // Get current tier
      const [current] = await connection.query(`
        SELECT current_tier, username FROM user_kyc_status WHERE user_id = ? FOR UPDATE
      `, [userId]);

      if (current.length === 0) {
        await connection.rollback();
        return res.status(404).json({ success: false, message: 'User KYC status not found' });
      }

      const currentTier = current[0].current_tier;
      const username = current[0].username;

      // Update tier
      await connection.query(`
        UPDATE user_kyc_status
        SET 
          current_tier = ?,
          previous_tier = ?,
          tier_upgraded_at = NOW(),
          verified_by = ?,
          verified_by_username = ?,
          verification_notes = ?
        WHERE user_id = ?
      `, [newTier, currentTier, req.user.id, req.user.username, reason, userId]);

      // Log compliance action
      const actionType = newTier > currentTier ? 'kyc_upgraded' : 'kyc_downgraded';
      await connection.query(`
        INSERT INTO compliance_actions (user_id, username, action_type, reason, officer_id, officer_username, details)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        userId,
        username,
        actionType,
        reason,
        req.user.id,
        req.user.username,
        JSON.stringify({ previousTier: currentTier, newTier })
      ]);

      await connection.commit();

      // Log admin action
      await logAdminAction(db, {
        adminId: req.user.id,
        adminUsername: req.user.username,
        action: 'manual_tier_adjustment',
        targetType: 'user',
        targetId: userId,
        details: { previousTier: currentTier, newTier, reason },
        ipAddress: req.ip
      });

      res.json({ 
        success: true, 
        message: `User tier ${actionType === 'kyc_upgraded' ? 'upgraded' : 'downgraded'} successfully`,
        previousTier: currentTier,
        newTier
      });
    } catch (error) {
      await connection.rollback();
      console.error('Manual tier adjustment error:', error);
      res.status(500).json({ success: false, message: 'Failed to adjust user tier' });
    } finally {
      connection.release();
    }
  });


  /**
   * GET /api/admin/compliance/kyc/tiers
   * Get all KYC tiers configuration
   * Permission: compliance.view
   */
  router.get('/kyc/tiers', requireAdmin, requirePermission('compliance.view'), async (req, res) => {
    try {
      const [tiers] = await db.query(`
        SELECT * FROM kyc_tiers ORDER BY tier_level ASC
      `);

      // Get user distribution
      const [distribution] = await db.query(`
        SELECT * FROM v_kyc_tier_distribution
      `);

      res.json({
        success: true,
        tiers,
        distribution
      });
    } catch (error) {
      console.error('Get KYC tiers error:', error);
      res.status(500).json({ success: false, message: 'Failed to get KYC tiers' });
    }
  });


  /**
   * POST /api/admin/compliance/kyc/users/:userId/flags
   * Update compliance flags for a user
   * Permission: compliance.manage
   */
  router.post('/kyc/users/:userId/flags', requireAdmin, requirePermission('compliance.manage'), async (req, res) => {
    try {
      const { userId } = req.params;
      const { isPep, isSanctioned, sanctionsList, requiresEnhancedDD, amlFlagged, reason } = req.body;

      const updates = [];
      const params = [];

      if (typeof isPep === 'boolean') {
        updates.push('is_pep = ?');
        params.push(isPep);
      }

      if (typeof isSanctioned === 'boolean') {
        updates.push('is_sanctioned = ?');
        params.push(isSanctioned);
      }

      if (sanctionsList !== undefined) {
        updates.push('sanctions_list = ?');
        params.push(sanctionsList);
      }

      if (typeof requiresEnhancedDD === 'boolean') {
        updates.push('requires_enhanced_dd = ?');
        params.push(requiresEnhancedDD);
      }

      if (typeof amlFlagged === 'boolean') {
        updates.push('aml_flagged = ?');
        params.push(amlFlagged);
      }

      if (updates.length === 0) {
        return res.status(400).json({ success: false, message: 'No flags provided' });
      }

      params.push(userId);

      await db.query(`
        UPDATE user_kyc_status
        SET ${updates.join(', ')}
        WHERE user_id = ?
      `, params);

      // Log compliance action
      const [user] = await db.query(`SELECT username FROM users WHERE id = ?`, [userId]);
      
      await db.query(`
        INSERT INTO compliance_actions (user_id, username, action_type, reason, officer_id, officer_username, details)
        VALUES (?, ?, 'enhanced_dd_required', ?, ?, ?, ?)
      `, [
        userId,
        user[0]?.username || 'unknown',
        reason || 'Compliance flags updated',
        req.user.id,
        req.user.username,
        JSON.stringify({ isPep, isSanctioned, sanctionsList, requiresEnhancedDD, amlFlagged })
      ]);

      // Log admin action
      await logAdminAction(db, {
        adminId: req.user.id,
        adminUsername: req.user.username,
        action: 'update_compliance_flags',
        targetType: 'user',
        targetId: userId,
        details: { isPep, isSanctioned, sanctionsList, requiresEnhancedDD, amlFlagged, reason },
        ipAddress: req.ip
      });

      res.json({ success: true, message: 'Compliance flags updated successfully' });
    } catch (error) {
      console.error('Update compliance flags error:', error);
      res.status(500).json({ success: false, message: 'Failed to update compliance flags' });
    }
  });


  /**
   * GET /api/admin/compliance/kyc/statistics
   * Get KYC overview statistics
   * Permission: compliance.view
   */
  router.get('/kyc/statistics', requireAdmin, requirePermission('compliance.view'), async (req, res) => {
    try {
      // Tier distribution
      const [tierDist] = await db.query(`SELECT * FROM v_kyc_tier_distribution`);

      // Pending applications
      const [pending] = await db.query(`
        SELECT COUNT(*) as count FROM user_kyc_status WHERE application_status = 'pending'
      `);

      // Under review
      const [underReview] = await db.query(`
        SELECT COUNT(*) as count FROM user_kyc_status WHERE application_status = 'under_review'
      `);

      // Approved this month
      const [approvedMonth] = await db.query(`
        SELECT COUNT(*) as count FROM user_kyc_status 
        WHERE application_status = 'approved' AND verified_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      `);

      // Rejected this month
      const [rejectedMonth] = await db.query(`
        SELECT COUNT(*) as count FROM user_kyc_status 
        WHERE application_status = 'rejected' AND rejected_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      `);

      // Average processing time
      const [avgTime] = await db.query(`
        SELECT AVG(TIMESTAMPDIFF(HOUR, applied_at, verified_at)) as avg_hours
        FROM user_kyc_status
        WHERE application_status = 'approved' AND verified_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      `);

      res.json({
        success: true,
        statistics: {
          tierDistribution: tierDist,
          pendingApplications: pending[0].count,
          underReview: underReview[0].count,
          approvedThisMonth: approvedMonth[0].count,
          rejectedThisMonth: rejectedMonth[0].count,
          averageProcessingHours: Math.round(avgTime[0].avg_hours || 0)
        }
      });
    } catch (error) {
      console.error('Get KYC statistics error:', error);
      res.status(500).json({ success: false, message: 'Failed to get KYC statistics' });
    }
  });


  return router;
};
