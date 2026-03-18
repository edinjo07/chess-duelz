// backend/routes/admin-disputes.js
// Admin API for dispute management

const express = require('express');
const router = express.Router();

module.exports = (db, adminAuth) => {
  
  /**
   * GET /api/admin/disputes
   * List all disputes with filters
   */
  router.get('/', adminAuth.verifyAdminToken, adminAuth.requireAdmin, adminAuth.requirePermission('disputes.view'), async (req, res) => {
    try {
      const {
        status,
        priority,
        disputeType,
        userId,
        assignedTo,
        startDate,
        endDate,
        limit = 50,
        offset = 0
      } = req.query;
      
      let query = `
        SELECT 
          d.*,
          gs.game_id,
          gs.bet_amount,
          gs.status AS game_status,
          gs.game_type,
          TIMESTAMPDIFF(HOUR, d.submitted_at, NOW()) AS hours_pending
        FROM disputes d
        JOIN game_sessions gs ON d.game_session_id = gs.id
        WHERE 1=1
      `;
      
      const params = [];
      
      if (status) {
        query += ` AND d.status = ?`;
        params.push(status);
      }
      
      if (priority) {
        query += ` AND d.priority = ?`;
        params.push(priority);
      }
      
      if (disputeType) {
        query += ` AND d.dispute_type = ?`;
        params.push(disputeType);
      }
      
      if (userId) {
        query += ` AND d.user_id = ?`;
        params.push(userId);
      }
      
      if (assignedTo) {
        query += ` AND d.assigned_to = ?`;
        params.push(assignedTo);
      }
      
      if (startDate) {
        query += ` AND d.submitted_at >= ?`;
        params.push(startDate);
      }
      
      if (endDate) {
        query += ` AND d.submitted_at <= ?`;
        params.push(endDate);
      }
      
      query += ` ORDER BY 
        CASE d.priority
          WHEN 'critical' THEN 1
          WHEN 'high' THEN 2
          WHEN 'medium' THEN 3
          WHEN 'low' THEN 4
        END,
        d.submitted_at ASC
        LIMIT ? OFFSET ?`;
      params.push(parseInt(limit), parseInt(offset));
      
      db.query(query, params, (err, disputes) => {
        if (err) {
          console.error('Error fetching disputes:', err);
          return res.status(500).json({ error: 'Failed to fetch disputes', details: err.message });
        }
        
        // Get total count
        let countQuery = `SELECT COUNT(*) as total FROM disputes d JOIN game_sessions gs ON d.game_session_id = gs.id WHERE 1=1`;
        const countParams = params.slice(0, -2);
        
        if (status) countQuery += ` AND d.status = ?`;
        if (priority) countQuery += ` AND d.priority = ?`;
        if (disputeType) countQuery += ` AND d.dispute_type = ?`;
        if (userId) countQuery += ` AND d.user_id = ?`;
        if (assignedTo) countQuery += ` AND d.assigned_to = ?`;
        if (startDate) countQuery += ` AND d.submitted_at >= ?`;
        if (endDate) countQuery += ` AND d.submitted_at <= ?`;
        
        db.query(countQuery, countParams, (countErr, countResult) => {
          res.json({
            success: true,
            disputes: disputes,
            total: countResult ? countResult[0].total : disputes.length,
            limit: parseInt(limit),
            offset: parseInt(offset)
          });
        });
      });
      
    } catch (error) {
      console.error('Error in disputes list:', error);
      res.status(500).json({ error: 'Internal server error', details: error.message });
    }
  });
  
  
  /**
   * GET /api/admin/disputes/:disputeId
   * Get detailed dispute info
   */
  router.get('/:disputeId', adminAuth.verifyAdminToken, adminAuth.requireAdmin, adminAuth.requirePermission('disputes.view'), (req, res) => {
    const { disputeId } = req.params;
    
    db.query(
      `SELECT 
        d.*,
        gs.game_id, gs.game_type, gs.bet_amount, gs.status AS game_status,
        gs.player1_id, gs.player1_username, gs.player2_id, gs.player2_username,
        gs.result, gs.winner_id, gs.pgn, gs.starting_fen, gs.final_fen
       FROM disputes d
       JOIN game_sessions gs ON d.game_session_id = gs.id
       WHERE d.id = ? OR d.dispute_number = ?`,
      [disputeId, disputeId],
      (err, results) => {
        if (err) {
          console.error('Error fetching dispute:', err);
          return res.status(500).json({ error: 'Failed to fetch dispute', details: err.message });
        }
        
        if (!results || results.length === 0) {
          return res.status(404).json({ error: 'Dispute not found' });
        }
        
        res.json({
          success: true,
          dispute: results[0]
        });
      }
    );
  });
  
  
  /**
   * POST /api/admin/disputes/:disputeId/assign
   * Assign dispute to an admin
   */
  router.post('/:disputeId/assign', adminAuth.verifyAdminToken, adminAuth.requireAdmin, adminAuth.requirePermission('disputes.manage'), (req, res) => {
    const { disputeId } = req.params;
    const { assignToUserId } = req.body;
    
    if (!assignToUserId) {
      return res.status(400).json({ error: 'assignToUserId is required' });
    }
    
    // Get admin username
    db.query('SELECT username FROM users WHERE id = ? AND is_admin = 1', [assignToUserId], (userErr, users) => {
      if (userErr || !users || users.length === 0) {
        return res.status(404).json({ error: 'Admin user not found' });
      }
      
      db.query(
        `UPDATE disputes SET 
          assigned_to = ?,
          assigned_to_username = ?,
          assigned_at = NOW(),
          status = CASE WHEN status = 'pending' THEN 'investigating' ELSE status END
        WHERE id = ?`,
        [assignToUserId, users[0].username, disputeId],
        (err, result) => {
          if (err) {
            console.error('Error assigning dispute:', err);
            return res.status(500).json({ error: 'Failed to assign dispute', details: err.message });
          }
          
          if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Dispute not found' });
          }
          
          res.json({
            success: true,
            message: 'Dispute assigned successfully',
            assignedTo: users[0].username
          });
        }
      );
    });
  });
  
  
  /**
   * POST /api/admin/disputes/:disputeId/resolve
   * Resolve a dispute
   */
  router.post('/:disputeId/resolve', adminAuth.verifyAdminToken, adminAuth.requireAdmin, adminAuth.requirePermission('disputes.manage'), (req, res) => {
    const { disputeId } = req.params;
    const { resolution, resolutionType, refundAmount, status = 'resolved' } = req.body;
    
    if (!resolution) {
      return res.status(400).json({ error: 'Resolution text is required' });
    }
    
    if (!resolutionType) {
      return res.status(400).json({ error: 'Resolution type is required' });
    }
    
    if (!['resolved', 'rejected', 'closed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    
    db.query(
      `UPDATE disputes SET 
        status = ?,
        resolution = ?,
        resolution_type = ?,
        refund_amount = ?,
        refund_issued = ?,
        resolved_by = ?,
        resolved_by_username = ?,
        resolved_at = NOW()
      WHERE id = ?`,
      [
        status,
        resolution,
        resolutionType,
        refundAmount || null,
        !!refundAmount,
        req.user.userId,
        req.user.username,
        disputeId
      ],
      (err, result) => {
        if (err) {
          console.error('Error resolving dispute:', err);
          return res.status(500).json({ error: 'Failed to resolve dispute', details: err.message });
        }
        
        if (result.affectedRows === 0) {
          return res.status(404).json({ error: 'Dispute not found' });
        }
        
        res.json({
          success: true,
          message: 'Dispute resolved successfully',
          status: status,
          resolutionType: resolutionType,
          refundIssued: !!refundAmount
        });
      }
    );
  });
  
  
  /**
   * POST /api/admin/disputes/:disputeId/notes
   * Add notes to a dispute
   */
  router.post('/:disputeId/notes', adminAuth.verifyAdminToken, adminAuth.requireAdmin, adminAuth.requirePermission('disputes.manage'), (req, res) => {
    const { disputeId } = req.params;
    const { notes, isInternal = false } = req.body;
    
    if (!notes) {
      return res.status(400).json({ error: 'Notes are required' });
    }
    
    const field = isInternal ? 'internal_notes' : 'admin_notes';
    
    // Append notes with timestamp and username
    const timestamp = new Date().toISOString();
    const noteEntry = `\n\n[${timestamp}] ${req.user.username}:\n${notes}`;
    
    db.query(
      `UPDATE disputes SET 
        ${field} = CONCAT(COALESCE(${field}, ''), ?)
      WHERE id = ?`,
      [noteEntry, disputeId],
      (err, result) => {
        if (err) {
          console.error('Error adding notes:', err);
          return res.status(500).json({ error: 'Failed to add notes', details: err.message });
        }
        
        if (result.affectedRows === 0) {
          return res.status(404).json({ error: 'Dispute not found' });
        }
        
        res.json({
          success: true,
          message: 'Notes added successfully'
        });
      }
    );
  });
  
  
  /**
   * PATCH /api/admin/disputes/:disputeId/priority
   * Update dispute priority
   */
  router.patch('/:disputeId/priority', adminAuth.verifyAdminToken, adminAuth.requireAdmin, adminAuth.requirePermission('disputes.manage'), (req, res) => {
    const { disputeId } = req.params;
    const { priority } = req.body;
    
    if (!['low', 'medium', 'high', 'critical'].includes(priority)) {
      return res.status(400).json({ error: 'Invalid priority' });
    }
    
    db.query(
      'UPDATE disputes SET priority = ? WHERE id = ?',
      [priority, disputeId],
      (err, result) => {
        if (err) {
          console.error('Error updating priority:', err);
          return res.status(500).json({ error: 'Failed to update priority', details: err.message });
        }
        
        if (result.affectedRows === 0) {
          return res.status(404).json({ error: 'Dispute not found' });
        }
        
        res.json({
          success: true,
          message: 'Priority updated successfully',
          priority: priority
        });
      }
    );
  });
  
  
  /**
   * GET /api/admin/disputes/stats/overview
   * Get dispute statistics
   */
  router.get('/statistics/overview', adminAuth.verifyAdminToken, adminAuth.requireAdmin, adminAuth.requirePermission('disputes.view'), (req, res) => {
    const queries = {
      total: 'SELECT COUNT(*) as count FROM disputes',
      pending: 'SELECT COUNT(*) as count FROM disputes WHERE status = "pending"',
      investigating: 'SELECT COUNT(*) as count FROM disputes WHERE status = "investigating"',
      resolved: 'SELECT COUNT(*) as count FROM disputes WHERE status = "resolved"',
      rejected: 'SELECT COUNT(*) as count FROM disputes WHERE status = "rejected"',
      critical: 'SELECT COUNT(*) as count FROM disputes WHERE priority = "critical" AND status IN ("pending", "investigating")',
      avgResolutionTime: `SELECT AVG(TIMESTAMPDIFF(HOUR, submitted_at, resolved_at)) as average 
                          FROM disputes WHERE resolved_at IS NOT NULL`
    };
    
    const stats = {};
    const keys = Object.keys(queries);
    let completed = 0;
    
    keys.forEach(key => {
      db.query(queries[key], (err, result) => {
        if (!err && result && result[0]) {
          stats[key] = result[0].count !== undefined ? result[0].count : result[0].average || 0;
        } else {
          stats[key] = 0;
        }
        
        completed++;
        if (completed === keys.length) {
          res.json({
            success: true,
            stats: stats
          });
        }
      });
    });
  });
  
  
  return router;
};
