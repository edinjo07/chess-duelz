// backend/middleware/admin-auth.js
// Enhanced admin authentication and RBAC middleware

const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || process.env.JWT_ACCESS_SECRET;
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET;
if (!JWT_SECRET || !ADMIN_JWT_SECRET) {
  console.error('[FATAL] JWT secrets must be set in environment');
  process.exit(1);
}

/**
 * Enhanced admin authentication middleware
 * Checks token validity and admin status
 */
function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ 
      error: 'Unauthorized: Authentication required',
      code: 'AUTH_REQUIRED'
    });
  }
  
  // Debug logging
  console.log(`[ADMIN CHECK] User: ${req.user.username}, isAdmin in token: ${req.user.isAdmin}, userId: ${req.user.userId}`);
  
  if (!req.user.isAdmin) {
    const clientIP = getClientIP(req);
    console.warn(`[SECURITY] Non-admin user ${req.user.username} (${req.user.userId}) attempted admin access from IP: ${clientIP}`);
    console.warn(`[SECURITY] Token payload:`, JSON.stringify(req.user));
    
    // Log security event (non-blocking, wrapped in setImmediate to prevent crashes)
    setImmediate(() => {
      try {
        logSecurityEvent(req, 'admin_access_denied', 'high', 
          `Non-admin user attempted to access admin endpoint: ${req.path}`);
      } catch (e) {
        console.error('Error logging security event:', e);
      }
    });
    
    return res.status(403).json({ 
      error: 'Forbidden: Admin access required',
      code: 'ADMIN_REQUIRED',
      debug: {
        username: req.user.username,
        hasAdminFlag: !!req.user.isAdmin,
        message: 'Your JWT token does not have admin privileges. Please logout and login again.'
      }
    });
  }
  
  next();
}

/**
 * Role-based access control middleware
 * @param {string|string[]} requiredPermissions - Required permission(s) to access the route
 */
function requirePermission(...requiredPermissions) {
  return async (req, res, next) => {
    if (!req.user || !req.user.isAdmin) {
      return res.status(403).json({ 
        error: 'Forbidden: Admin access required',
        code: 'ADMIN_REQUIRED'
      });
    }

    // Super admins bypass permission checks
    if (req.user.isSuperAdmin) {
      return next();
    }

    try {
      const userPermissions = await getUserPermissions(req.user.userId);
      
      // Admins with no roles assigned get NO access — assign roles first
      if (userPermissions.length === 0) {
        console.warn(`[RBAC] Admin ${req.user.username} has no roles assigned — access denied`);
        return res.status(403).json({ error: 'No permissions assigned. Contact a super admin.' });
      }
      
      // Check if user has at least one of the required permissions
      const hasPermission = requiredPermissions.some(perm => 
        userPermissions.includes(perm)
      );

      if (!hasPermission) {
        console.warn(`[RBAC] User ${req.user.username} lacks permission: ${requiredPermissions.join(' or ')}`);
        
        logSecurityEvent(req, 'admin_access_denied', 'medium',
          `User lacks required permission: ${requiredPermissions.join(', ')}`);
        
        return res.status(403).json({ 
          error: 'Forbidden: Insufficient permissions',
          code: 'INSUFFICIENT_PERMISSIONS',
          required: requiredPermissions
        });
      }

      next();
    } catch (error) {
      console.error('[RBAC] Permission check error:', error);
      return res.status(500).json({ 
        error: 'Permission verification failed',
        code: 'PERMISSION_CHECK_ERROR'
      });
    }
  };
}

/**
 * Get user permissions from database
 */
async function getUserPermissions(userId) {
  try {
    const { pool } = require('../lib/mysql_pool');
    
    if (!pool || !pool.query) {
      console.error('[RBAC] Database connection not available');
      return []; // Graceful fallback
    }
    
    const [results] = await pool.query(`
      SELECT DISTINCT ar.permissions
      FROM user_admin_roles uar
      JOIN admin_roles ar ON uar.role_id = ar.id
      WHERE uar.user_id = ?
    `, [userId]);

    if (!results || results.length === 0) {
      console.log(`[RBAC] User ${userId} has no roles assigned - granting temporary access`);
      return [];
    }

    // Merge all permissions from all roles
    const allPermissions = new Set();
    results.forEach(row => {
      try {
        // MySQL may return JSON as string or already parsed object
        let perms = row.permissions;
        if (typeof perms === 'string') {
          perms = JSON.parse(perms);
        }
        
        if (Array.isArray(perms)) {
          perms.forEach(p => allPermissions.add(p));
        }
      } catch (e) {
        console.error('[RBAC] Error parsing permissions:', e, 'Raw value:', row.permissions);
      }
    });

    console.log(`[RBAC] User ${userId} has ${allPermissions.size} permissions:`, Array.from(allPermissions));
    return Array.from(allPermissions);
  } catch (error) {
    // If tables don't exist, treat as no roles/permissions (graceful fallback)
    if (error.code === 'ER_NO_SUCH_TABLE' || error.code === 'ER_BAD_TABLE_ERROR') {
      console.warn('[RBAC] Role tables not yet created, returning empty permissions');
      return [];
    }
    console.error('[RBAC] Error fetching user permissions:', error);
    // Don't reject - return empty array to allow temporary access
    return [];
  }
}

/**
 * Verify token is a valid admin token (signed with ADMIN_JWT_SECRET, isAdminToken: true)
 * Used by all admin API routes in route files (risk, disputes, games, compliance, monitoring)
 */
function verifyAdminToken(req, res, next) {
  const header = req.header('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(403).json({ error: 'Admin token missing', code: 'TOKEN_MISSING' });
  }

  try {
    const decoded = jwt.verify(token, ADMIN_JWT_SECRET);
    if (!decoded.isAdminToken) {
      return res.status(403).json({ error: 'Forbidden: Not a valid admin token', code: 'INVALID_ADMIN_TOKEN' });
    }
    // Set req.user so requireAdmin / requirePermission still work
    req.user = { userId: decoded.adminId, username: decoded.username, isAdmin: true, isSuperAdmin: true };
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired admin token', code: 'TOKEN_INVALID' });
  }
}

/**
 * Verify admin session is still valid
 */
async function verifyAdminSession(token, userId, callback) {
  const { pool } = require('../lib/mysql_pool');
  
  try {
    const [results] = await pool.query(`
      SELECT id, is_active, expires_at, requires_2fa, two_fa_verified
      FROM admin_sessions
      WHERE session_token = ? AND user_id = ? AND is_active = TRUE
    `, [token, userId]);
    
    if (!results || results.length === 0) return callback(null, false);
    
    const session = results[0];
    
    // Check if expired
    if (new Date(session.expires_at) < new Date()) {
      return callback(null, false);
    }
    
    // Check if 2FA is required but not verified
    if (session.requires_2fa && !session.two_fa_verified) {
      return callback(null, false);
    }
    
    callback(null, true);
  } catch (err) {
    callback(err, false);
  }
}

/**
 * Update session last activity timestamp
 */
async function updateSessionActivity(token) {
  const { pool } = require('../lib/mysql_pool');
  try {
    await pool.query(
      'UPDATE admin_sessions SET last_activity = NOW() WHERE session_token = ?',
      [token]
    );
  } catch (err) {
    console.error('Error updating session activity:', err);
  }
}

/**
 * Log security events
 */
function logSecurityEvent(req, eventType, severity, description) {
  try {
    // Import mysql_pool instead of the stub db.js
    const { pool } = require('../lib/mysql_pool');
    
    const userId = req.user ? req.user.userId : null;
    const username = req.user ? req.user.username : null;
    const ipAddress = getClientIP(req);
    const userAgent = req.headers['user-agent'] || null;
    
    const metadata = {
      path: req.path,
      method: req.method,
      query: req.query,
      params: req.params
    };
    
    // Use async/await with pool since it's a promise-based pool
    (async () => {
      try {
        await pool.query(`
          INSERT INTO security_events 
          (event_type, user_id, username, severity, description, ip_address, user_agent, metadata)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [eventType, userId, username, severity, description, ipAddress, userAgent, JSON.stringify(metadata)]);
      } catch (err) {
        if (err.code !== 'ER_NO_SUCH_TABLE') {
          console.error('Error logging security event:', err);
        }
      }
    })();
  } catch (error) {
    console.error('Fatal error in logSecurityEvent:', error);
    // Don't throw - just log and continue
  }
}

/**
 * Get client IP address
 */
function getClientIP(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.socket.remoteAddress || req.connection.remoteAddress || 'unknown';
}

/**
 * Enhanced admin action logger with full audit trail
 */
function logAdminAction(userId, username, action, details = {}) {
  try {
    const { pool } = require('../lib/mysql_pool');
    
    const {
      resourceType,
      resourceId,
      oldValue,
      newValue,
      ipAddress,
      userAgent,
      status = 'success',
      errorMessage
    } = details;
    
    (async () => {
      try {
        await pool.query(`
          INSERT INTO admin_audit_logs 
          (user_id, username, action, resource_type, resource_id, old_value, new_value, 
           details, ip_address, user_agent, status, error_message)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          userId, 
          username, 
          action, 
          resourceType || null, 
          resourceId || null,
          oldValue ? JSON.stringify(oldValue) : null,
          newValue ? JSON.stringify(newValue) : null,
          JSON.stringify(details), 
          ipAddress || 'unknown',
          userAgent || null,
          status,
          errorMessage || null
        ]);
      } catch (err) {
        if (err.code !== 'ER_NO_SUCH_TABLE') {
          console.error('Error logging admin action:', err.message);
        }
      }
    })();
  } catch (error) {
    console.error('Fatal error in logAdminAction:', error);
    // Don't throw - just log and continue
  }
}

/**
 * Revoke admin session
 */
async function revokeAdminSession(token, callback) {
  const { pool } = require('../lib/mysql_pool');
  try {
    await pool.query(
      'UPDATE admin_sessions SET is_active = FALSE WHERE session_token = ?',
      [token]
    );
    if (callback) callback(null);
  } catch (err) {
    if (callback) callback(err);
  }
}

/**
 * Revoke all admin sessions for a user
 */
async function revokeAllUserSessions(userId, callback) {
  const { pool } = require('../lib/mysql_pool');
  try {
    await pool.query(
      'UPDATE admin_sessions SET is_active = FALSE WHERE user_id = ?',
      [userId]
    );
    if (callback) callback(null);
  } catch (err) {
    if (callback) callback(err);
  }
}

module.exports = {
  requireAdmin,
  requirePermission,
  verifyAdminToken,
  logAdminAction,
  logSecurityEvent,
  revokeAdminSession,
  revokeAllUserSessions,
  getUserPermissions,
  getClientIP
};
