// backend/routes/admin-games.js
// Admin API for game sessions management, disputes, and interventions

const express = require('express');
const router = express.Router();

module.exports = (db, adminAuth) => {
  
  // ============================================
  // GAME SESSIONS ENDPOINTS
  // ============================================
  
  /**
   * GET /api/admin/games
   * List all game sessions with filters
   */
  router.get('/', adminAuth.verifyAdminToken, adminAuth.requireAdmin, adminAuth.requirePermission('games.view'), async (req, res) => {
    try {
      const {
        status,
        gameType,
        userId,
        startDate,
        endDate,
        minBet,
        maxBet,
        limit = 50,
        offset = 0
      } = req.query;
      
      let query = `
        SELECT 
          gs.*,
          TIMESTAMPDIFF(MINUTE, gs.started_at, gs.ended_at) AS game_duration_minutes,
          CASE 
            WHEN gs.status = 'active' THEN TIMESTAMPDIFF(MINUTE, gs.started_at, NOW())
            ELSE NULL
          END AS active_minutes
        FROM game_sessions gs
        WHERE 1=1
      `;
      
      const params = [];
      
      if (status) {
        query += ` AND gs.status = ?`;
        params.push(status);
      }
      
      if (gameType) {
        query += ` AND gs.game_type = ?`;
        params.push(gameType);
      }
      
      if (userId) {
        query += ` AND (gs.player1_id = ? OR gs.player2_id = ?)`;
        params.push(userId, userId);
      }
      
      if (startDate) {
        query += ` AND gs.created_at >= ?`;
        params.push(startDate);
      }
      
      if (endDate) {
        query += ` AND gs.created_at <= ?`;
        params.push(endDate);
      }
      
      if (minBet) {
        query += ` AND gs.bet_amount >= ?`;
        params.push(minBet);
      }
      
      if (maxBet) {
        query += ` AND gs.bet_amount <= ?`;
        params.push(maxBet);
      }
      
      query += ` ORDER BY gs.created_at DESC LIMIT ? OFFSET ?`;
      params.push(parseInt(limit), parseInt(offset));
      
      db.query(query, params, (err, games) => {
        if (err) {
          console.error('Error fetching games:', err);
          return res.status(500).json({ error: 'Failed to fetch games', details: err.message });
        }
        
        // Get total count
        let countQuery = `SELECT COUNT(*) as total FROM game_sessions gs WHERE 1=1`;
        const countParams = params.slice(0, -2); // Remove limit and offset
        
        if (status) countQuery += ` AND gs.status = ?`;
        if (gameType) countQuery += ` AND gs.game_type = ?`;
        if (userId) countQuery += ` AND (gs.player1_id = ? OR gs.player2_id = ?)`;
        if (startDate) countQuery += ` AND gs.created_at >= ?`;
        if (endDate) countQuery += ` AND gs.created_at <= ?`;
        if (minBet) countQuery += ` AND gs.bet_amount >= ?`;
        if (maxBet) countQuery += ` AND gs.bet_amount <= ?`;
        
        db.query(countQuery, countParams, (countErr, countResult) => {
          if (countErr) {
            console.error('Error counting games:', countErr);
          }
          
          res.json({
            success: true,
            games: games,
            total: countResult ? countResult[0].total : games.length,
            limit: parseInt(limit),
            offset: parseInt(offset)
          });
        });
      });
      
    } catch (error) {
      console.error('Error in games list:', error);
      res.status(500).json({ error: 'Internal server error', details: error.message });
    }
  });
  
  
  /**
   * GET /api/admin/games/:gameId
   * Get detailed game session info
   */
  router.get('/:gameId', adminAuth.verifyAdminToken, adminAuth.requireAdmin, adminAuth.requirePermission('games.view'), (req, res) => {
    const { gameId } = req.params;
    
    db.query(
      `SELECT gs.*, 
              d.id AS dispute_id, d.status AS dispute_status, d.dispute_type
       FROM game_sessions gs
       LEFT JOIN disputes d ON gs.id = d.game_session_id
       WHERE gs.game_id = ? OR gs.id = ?`,
      [gameId, gameId],
      (err, results) => {
        if (err) {
          console.error('Error fetching game:', err);
          return res.status(500).json({ error: 'Failed to fetch game', details: err.message });
        }
        
        if (!results || results.length === 0) {
          return res.status(404).json({ error: 'Game not found' });
        }
        
        // Get interventions for this game
        db.query(
          `SELECT * FROM game_interventions WHERE game_session_id = ? ORDER BY created_at DESC`,
          [results[0].id],
          (intErr, interventions) => {
            if (intErr) {
              console.error('Error fetching interventions:', intErr);
            }
            
            res.json({
              success: true,
              game: results[0],
              interventions: interventions || [],
              hasDispute: !!results[0].dispute_id
            });
          }
        );
      }
    );
  });
  
  
  /**
   * GET /api/admin/games/stuck
   * Get stuck games (active > 1 hour)
   */
  router.get('/status/stuck', adminAuth.verifyAdminToken, adminAuth.requireAdmin, adminAuth.requirePermission('games.view'), (req, res) => {
    db.query(
      `SELECT * FROM v_stuck_games ORDER BY minutes_stuck DESC`,
      (err, stuckGames) => {
        if (err) {
          console.error('Error fetching stuck games:', err);
          return res.status(500).json({ error: 'Failed to fetch stuck games', details: err.message });
        }
        
        res.json({
          success: true,
          stuckGames: stuckGames,
          count: stuckGames.length
        });
      }
    );
  });
  
  
  /**
   * GET /api/admin/games/stats
   * Get game statistics
   */
  router.get('/statistics/overview', adminAuth.verifyAdminToken, adminAuth.requireAdmin, adminAuth.requirePermission('games.view'), (req, res) => {
    const queries = {
      total: 'SELECT COUNT(*) as count FROM game_sessions',
      active: 'SELECT COUNT(*) as count FROM game_sessions WHERE status = "active"',
      completed: 'SELECT COUNT(*) as count FROM game_sessions WHERE status = "completed"',
      disputed: 'SELECT COUNT(*) as count FROM game_sessions WHERE status = "disputed"',
      voided: 'SELECT COUNT(*) as count FROM game_sessions WHERE status = "voided"',
      stuck: 'SELECT COUNT(*) as count FROM v_stuck_games',
      totalVolume: 'SELECT SUM(bet_amount) as total FROM game_sessions WHERE status = "completed"',
      avgBet: 'SELECT AVG(bet_amount) as average FROM game_sessions WHERE status = "completed"'
    };
    
    const stats = {};
    const keys = Object.keys(queries);
    let completed = 0;
    
    keys.forEach(key => {
      db.query(queries[key], (err, result) => {
        if (!err && result && result[0]) {
          stats[key] = result[0].count !== undefined ? result[0].count : 
                       result[0].total !== undefined ? result[0].total :
                       result[0].average || 0;
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
  
  
  // ============================================
  // GAME INTERVENTION ENDPOINTS
  // ============================================
  
  /**
   * POST /api/admin/games/:gameId/force-settle
   * Force settle a stuck or disputed game
   */
  router.post('/:gameId/force-settle', adminAuth.verifyAdminToken, adminAuth.requireAdmin, adminAuth.requirePermission('games.manage'), async (req, res) => {
    const { gameId } = req.params;
    const { winnerId, reason, settlementType } = req.body; // settlementType: 'declare_winner', 'refund_both', 'void'
    
    if (!reason) {
      return res.status(400).json({ error: 'Reason is required' });
    }
    
    if (!['declare_winner', 'refund_both', 'void'].includes(settlementType)) {
      return res.status(400).json({ error: 'Invalid settlement type' });
    }
    
    if (settlementType === 'declare_winner' && !winnerId) {
      return res.status(400).json({ error: 'Winner ID required for declare_winner settlement' });
    }
    
    try {
      // Get game details
      db.query('SELECT * FROM game_sessions WHERE game_id = ? OR id = ?', [gameId, gameId], async (err, games) => {
        if (err || !games || games.length === 0) {
          return res.status(404).json({ error: 'Game not found' });
        }
        
        const game = games[0];
        
        if (game.is_settled) {
          return res.status(400).json({ error: 'Game already settled' });
        }
        
        const ledgerEntries = [];
        let newResult = null;
        let newWinnerId = null;
        let player1Refund = null;
        let player2Refund = null;
        
        // Handle different settlement types
        if (settlementType === 'refund_both') {
          // Refund both players their bet amounts
          player1Refund = game.bet_amount;
          if (game.player2_id) {
            player2Refund = game.bet_amount;
          }
          newResult = 'voided';
          
        } else if (settlementType === 'void') {
          // Just void, no refunds
          newResult = 'voided';
          
        } else if (settlementType === 'declare_winner') {
          // Declare winner and pay out
          newWinnerId = parseInt(winnerId);
          
          if (newWinnerId === game.player1_id) {
            newResult = 'player1_win';
          } else if (newWinnerId === game.player2_id) {
            newResult = 'player2_win';
          } else {
            return res.status(400).json({ error: 'Winner must be one of the players' });
          }
        }
        
        // Update game status
        db.query(
          `UPDATE game_sessions SET 
            status = 'completed',
            result = ?,
            winner_id = ?,
            is_settled = TRUE,
            settled_by = ?,
            settled_at = NOW(),
            settlement_reason = ?,
            ended_at = COALESCE(ended_at, NOW())
          WHERE id = ?`,
          [newResult, newWinnerId, req.user.userId, reason, game.id],
          (updateErr) => {
            if (updateErr) {
              console.error('Error updating game:', updateErr);
              return res.status(500).json({ error: 'Failed to update game' });
            }
            
            // Log intervention
            db.query(
              `INSERT INTO game_interventions 
              (game_session_id, game_id, intervention_type, admin_id, admin_username, reason, 
               player1_refund, player2_refund, manual_payout_user_id, manual_payout_amount,
               old_result, new_result, new_winner_id, ip_address, user_agent)
              VALUES (?, ?, 'force_settle', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                game.id, game.game_id, req.user.userId, req.user.username, reason,
                player1Refund, player2Refund, newWinnerId, 
                newWinnerId ? game.prize_amount : null,
                game.result, newResult, newWinnerId,
                req.ip, req.headers['user-agent']
              ],
              (logErr, logResult) => {
                if (logErr) {
                  console.error('Error logging intervention:', logErr);
                }
                
                res.json({
                  success: true,
                  message: 'Game settled successfully',
                  gameId: game.game_id,
                  settlementType: settlementType,
                  result: newResult,
                  winnerId: newWinnerId,
                  refunds: {
                    player1: player1Refund,
                    player2: player2Refund
                  }
                });
              }
            );
          }
        );
      });
      
    } catch (error) {
      console.error('Error in force settle:', error);
      res.status(500).json({ error: 'Internal server error', details: error.message });
    }
  });
  
  
  /**
   * POST /api/admin/games/:gameId/void
   * Void a game and refund players
   */
  router.post('/:gameId/void', adminAuth.verifyAdminToken, adminAuth.requireAdmin, adminAuth.requirePermission('games.manage'), (req, res) => {
    const { gameId } = req.params;
    const { reason, refundPlayers = true } = req.body;
    
    if (!reason) {
      return res.status(400).json({ error: 'Reason is required' });
    }
    
    // Redirect to force-settle with void settlement type
    req.body.settlementType = refundPlayers ? 'refund_both' : 'void';
    return router.handle(req, res);
  });
  
  
  return router;
};
