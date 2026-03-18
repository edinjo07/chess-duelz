// backend/routes/admin-management.js
// Admin management API - Create, assign roles, manage sessions

const express = require('express');
const router = express.Router();
const { requirePermission, logAdminAction, logSecurityEvent, getClientIP, revokeAllUserSessions } = require('../middleware/admin-auth');

module.exports = (db, verifyToken, requireAdmin) => {
  
  /**
   * Get current admin user info
   */
  router.get('/me', verifyToken, requireAdmin, (req, res) => {
    res.json({
      success: true,
      userId: req.user.userId,
      username: req.user.username,
      email: req.user.email,
      isAdmin: req.user.isAdmin,
      isSuperAdmin: req.user.isSuperAdmin
    });
  });
  
  /**
   * Promote user to admin
   */
  router.post('/promote', verifyToken, requireAdmin, requirePermission('admin.create'), async (req, res) => {
    const { username } = req.body;

    if (!username) {
      return res.status(400).json({ error: 'Username or email required' });
    }

    try {
      // Check if user exists
      const userResult = await new Promise((resolve, reject) => {
        db.query(
          'SELECT id, username, email, is_admin FROM users WHERE username = ? OR email = ?',
          [username, username],
          (err, results) => {
            if (err) return reject(err);
            resolve(results);
          }
        );
      });

      if (userResult.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const user = userResult[0];

      if (user.is_admin) {
        return res.json({
          success: true,
          message: 'User is already an admin',
          username: user.username,
          userId: user.id
        });
      }

      // Promote to admin
      await new Promise((resolve, reject) => {
        db.query(
          'UPDATE users SET is_admin = 1 WHERE id = ?',
          [user.id],
          (err) => {
            if (err) return reject(err);
            resolve();
          }
        );
      });

      // Log action
      logAdminAction(
        req.user.userId,
        req.user.username,
        'CREATE_ADMIN',
        {
          resourceType: 'admin',
          resourceId: user.id,
          newValue: { username: user.username, isAdmin: true },
          ipAddress: getClientIP(req),
          userAgent: req.headers['user-agent']
        }
      );

      res.json({
        success: true,
        message: 'User promoted to admin successfully',
        username: user.username,
        userId: user.id
      });

    } catch (error) {
      console.error('Error promoting user:', error);
      res.status(500).json({ error: 'Failed to promote user' });
    }
  });

  /**
   * Assign role to admin
   */
  router.post('/assign-role', verifyToken, requireAdmin, requirePermission('admin.manage'), async (req, res) => {
    const { userId, roleId, expiresAt } = req.body;

    if (!userId || !roleId) {
      return res.status(400).json({ error: 'userId and roleId required' });
    }

    try {
      // Check if user exists and is admin
      const userResult = await new Promise((resolve, reject) => {
        db.query(
          'SELECT id, username, is_admin FROM users WHERE id = ?',
          [userId],
          (err, results) => {
            if (err) return reject(err);
            resolve(results);
          }
        );
      });

      if (userResult.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      if (!userResult[0].is_admin) {
        return res.status(400).json({ error: 'User is not an admin' });
      }

      // Check if role exists
      const roleResult = await new Promise((resolve, reject) => {
        db.query(
          'SELECT id, role_name FROM admin_roles WHERE id = ?',
          [roleId],
          (err, results) => {
            if (err) return reject(err);
            resolve(results);
          }
        );
      });

      if (roleResult.length === 0) {
        return res.status(404).json({ error: 'Role not found' });
      }

      // Check if user already has this role
      const existingRole = await new Promise((resolve, reject) => {
        db.query(
          'SELECT id FROM user_admin_roles WHERE user_id = ? AND role_id = ? AND is_active = TRUE',
          [userId, roleId],
          (err, results) => {
            if (err) return reject(err);
            resolve(results);
          }
        );
      });

      if (existingRole.length > 0) {
        return res.status(400).json({ error: 'User already has this role' });
      }

      // Assign role
      await new Promise((resolve, reject) => {
        db.query(
          `INSERT INTO user_admin_roles (user_id, role_id, assigned_by, expires_at, is_active)
           VALUES (?, ?, ?, ?, TRUE)`,
          [userId, roleId, req.user.userId, expiresAt || null],
          (err) => {
            if (err) return reject(err);
            resolve();
          }
        );
      });

      // Log action
      logAdminAction(
        req.user.userId,
        req.user.username,
        'ASSIGN_ROLE',
        {
          resourceType: 'admin_role',
          resourceId: userId,
          newValue: { 
            roleId, 
            roleName: roleResult[0].role_name,
            expiresAt 
          },
          ipAddress: getClientIP(req),
          userAgent: req.headers['user-agent']
        }
      );

      res.json({
        success: true,
        message: 'Role assigned successfully'
      });

    } catch (error) {
      console.error('Error assigning role:', error);
      res.status(500).json({ error: 'Failed to assign role' });
    }
  });

  /**
   * Revoke role from admin
   */
  router.post('/revoke-role', verifyToken, requireAdmin, requirePermission('admin.manage'), async (req, res) => {
    const { userId, roleId } = req.body;

    if (!userId || !roleId) {
      return res.status(400).json({ error: 'userId and roleId required' });
    }

    try {
      await new Promise((resolve, reject) => {
        db.query(
          'UPDATE user_admin_roles SET is_active = FALSE WHERE user_id = ? AND role_id = ?',
          [userId, roleId],
          (err, result) => {
            if (err) return reject(err);
            if (result.affectedRows === 0) return reject(new Error('Role assignment not found'));
            resolve();
          }
        );
      });

      // Log action
      logAdminAction(
        req.user.userId,
        req.user.username,
        'REVOKE_ROLE',
        {
          resourceType: 'admin_role',
          resourceId: userId,
          oldValue: { roleId },
          ipAddress: getClientIP(req),
          userAgent: req.headers['user-agent']
        }
      );

      res.json({
        success: true,
        message: 'Role revoked successfully'
      });

    } catch (error) {
      console.error('Error revoking role:', error);
      res.status(500).json({ error: 'Failed to revoke role' });
    }
  });

  /**
   * Revoke admin access completely
   */
  router.post('/revoke/:userId', verifyToken, requireAdmin, requirePermission('admin.revoke'), async (req, res) => {
    const { userId } = req.params;

    // Prevent self-revocation
    if (parseInt(userId) === req.user.userId) {
      return res.status(400).json({ error: 'Cannot revoke your own admin access' });
    }

    try {
      // Get user info
      const userResult = await new Promise((resolve, reject) => {
        db.query(
          'SELECT id, username FROM users WHERE id = ?',
          [userId],
          (err, results) => {
            if (err) return reject(err);
            resolve(results);
          }
        );
      });

      if (userResult.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const user = userResult[0];

      // Revoke admin status
      await new Promise((resolve, reject) => {
        db.query(
          'UPDATE users SET is_admin = 0 WHERE id = ?',
          [userId],
          (err) => {
            if (err) return reject(err);
            resolve();
          }
        );
      });

      // Deactivate all roles
      await new Promise((resolve, reject) => {
        db.query(
          'UPDATE user_admin_roles SET is_active = FALSE WHERE user_id = ?',
          [userId],
          (err) => {
            if (err) console.error('Error deactivating roles:', err);
            resolve();
          }
        );
      });

      // Revoke all sessions
      revokeAllUserSessions(userId, (err) => {
        if (err) console.error('Error revoking sessions:', err);
      });

      // Log action
      logAdminAction(
        req.user.userId,
        req.user.username,
        'REVOKE_ADMIN',
        {
          resourceType: 'admin',
          resourceId: userId,
          oldValue: { username: user.username, isAdmin: true },
          newValue: { username: user.username, isAdmin: false },
          ipAddress: getClientIP(req),
          userAgent: req.headers['user-agent']
        }
      );

      // Log security event
      logSecurityEvent(
        req,
        'account_locked',
        'high',
        `Admin access revoked for user ${user.username} by ${req.user.username}`
      );

      res.json({
        success: true,
        message: 'Admin access revoked successfully'
      });

    } catch (error) {
      console.error('Error revoking admin:', error);
      res.status(500).json({ error: 'Failed to revoke admin access' });
    }
  });

  /**
   * Get all roles
   */
  router.get('/roles', verifyToken, requireAdmin, (req, res) => {
    db.query(`
      SELECT 
        ar.*,
        COUNT(DISTINCT uar.user_id) as user_count
      FROM admin_roles ar
      LEFT JOIN user_admin_roles uar ON ar.id = uar.role_id AND uar.is_active = TRUE
      GROUP BY ar.id
      ORDER BY ar.role_name
    `, (err, results) => {
      if (err) {
        console.error('Error fetching roles:', err);
        return res.status(500).json({ error: 'Failed to fetch roles' });
      }

      res.json(results);
    });
  });

  /**
   * Get active admin sessions
   */
  router.get('/sessions', verifyToken, requireAdmin, requirePermission('audit.view'), (req, res) => {
    db.query(`
      SELECT 
        s.*,
        u.username
      FROM admin_sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.is_active = TRUE AND s.expires_at > NOW()
      ORDER BY s.last_activity DESC
    `, (err, results) => {
      if (err) {
        console.error('Error fetching sessions:', err);
        return res.status(500).json({ error: 'Failed to fetch sessions' });
      }

      res.json({ sessions: results });
    });
  });

  /**
   * Revoke specific session
   */
  router.post('/session/:sessionId/revoke', verifyToken, requireAdmin, requirePermission('admin.manage'), async (req, res) => {
    const { sessionId } = req.params;

    try {
      const result = await new Promise((resolve, reject) => {
        db.query(
          'UPDATE admin_sessions SET is_active = FALSE WHERE id = ?',
          [sessionId],
          (err, result) => {
            if (err) return reject(err);
            resolve(result);
          }
        );
      });

      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Log action
      logAdminAction(
        req.user.userId,
        req.user.username,
        'REVOKE_SESSION',
        {
          resourceType: 'admin_session',
          resourceId: sessionId,
          ipAddress: getClientIP(req),
          userAgent: req.headers['user-agent']
        }
      );

      res.json({
        success: true,
        message: 'Session revoked successfully'
      });

    } catch (error) {
      console.error('Error revoking session:', error);
      res.status(500).json({ error: 'Failed to revoke session' });
    }
  });

  /**
   * Get admin statistics
   */
  router.get('/stats', verifyToken, requireAdmin, (req, res) => {
    const queries = {
      totalAdmins: 'SELECT COUNT(*) as count FROM users WHERE is_admin = 1',
      activeSessions: 'SELECT COUNT(*) as count FROM admin_sessions WHERE is_active = TRUE AND expires_at > NOW()',
      actionsToday: `SELECT COUNT(*) as count FROM admin_audit_logs WHERE DATE(created_at) = CURDATE()`,
      securityEvents: `SELECT COUNT(*) as count FROM security_events WHERE severity IN ('high', 'critical') AND resolved = FALSE`
    };

    Promise.all(
      Object.entries(queries).map(([key, query]) =>
        new Promise((resolve) => {
          db.query(query, (err, results) => {
            if (err) {
              console.error(`Error in ${key} query:`, err);
              resolve({ [key]: 0 });
            } else {
              resolve({ [key]: results[0].count });
            }
          });
        })
      )
    ).then(results => {
      const stats = Object.assign({}, ...results);
      res.json(stats);
    });
  });

  return router;
};
