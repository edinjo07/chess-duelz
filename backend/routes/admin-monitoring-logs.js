const express = require('express');
const moment = require('moment');

module.exports = (db, adminAuth) => {
  const router = express.Router();
  const { requireAdmin, requirePermission, logAdminAction } = adminAuth;

  // ============================================
  // ERROR LOGS ENDPOINTS
  // ============================================

  /**
   * GET /api/admin/monitoring/errors
   * List error logs with filters
   * Permission: monitoring.view
   */
  router.get('/errors', requireAdmin, requirePermission('monitoring.view'), async (req, res) => {
    try {
      const {
        level,        // debug, info, warning, error, critical, fatal
        errorType,
        endpoint,
        userId,
        status,       // new, investigating, resolved, ignored
        dateFrom,
        dateTo,
        page = 1,
        limit = 50
      } = req.query;

      const offset = (parseInt(page) - 1) * parseInt(limit);
      
      let query = `
        SELECT *
        FROM system_error_logs
        WHERE 1=1
      `;
      
      const params = [];

      if (level) {
        query += ` AND error_level = ?`;
        params.push(level);
      }

      if (errorType) {
        query += ` AND error_type = ?`;
        params.push(errorType);
      }

      if (endpoint) {
        query += ` AND endpoint LIKE ?`;
        params.push(`%${endpoint}%`);
      }

      if (userId) {
        query += ` AND user_id = ?`;
        params.push(userId);
      }

      if (status) {
        query += ` AND status = ?`;
        params.push(status);
      }

      if (dateFrom) {
        query += ` AND created_at >= ?`;
        params.push(dateFrom);
      }

      if (dateTo) {
        query += ` AND created_at <= ?`;
        params.push(dateTo);
      }

      // Count total
      const countQuery = query.replace(/SELECT.*FROM/, 'SELECT COUNT(*) as total FROM');
      const [countResult] = await db.query(countQuery, params);
      const total = countResult[0].total;

      // Add sorting and pagination
      query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
      params.push(parseInt(limit), offset);

      const [errors] = await db.query(query, params);

      res.json({
        success: true,
        errors,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / parseInt(limit))
        }
      });
    } catch (error) {
      console.error('Get error logs error:', error);
      res.status(500).json({ success: false, message: 'Failed to get error logs' });
    }
  });


  /**
   * GET /api/admin/monitoring/errors/:errorId
   * Get detailed error log
   * Permission: monitoring.view
   */
  router.get('/errors/:errorId', requireAdmin, requirePermission('monitoring.view'), async (req, res) => {
    try {
      const { errorId } = req.params;

      const [errors] = await db.query(`
        SELECT * FROM system_error_logs WHERE id = ?
      `, [errorId]);

      if (errors.length === 0) {
        return res.status(404).json({ success: false, message: 'Error log not found' });
      }

      // Get similar errors (same endpoint + error_type)
      const error = errors[0];
      const [similarErrors] = await db.query(`
        SELECT id, error_level, error_message, created_at
        FROM system_error_logs
        WHERE endpoint = ? AND error_type = ? AND id != ?
        ORDER BY created_at DESC
        LIMIT 10
      `, [error.endpoint, error.error_type, errorId]);

      res.json({
        success: true,
        error,
        similarErrors
      });
    } catch (error) {
      console.error('Get error log details error:', error);
      res.status(500).json({ success: false, message: 'Failed to get error log details' });
    }
  });


  /**
   * PATCH /api/admin/monitoring/errors/:errorId
   * Update error status
   * Permission: monitoring.manage
   */
  router.patch('/errors/:errorId', requireAdmin, requirePermission('monitoring.manage'), async (req, res) => {
    try {
      const { errorId } = req.params;
      const { status, notes } = req.body;

      if (!['new', 'investigating', 'resolved', 'ignored'].includes(status)) {
        return res.status(400).json({ success: false, message: 'Invalid status' });
      }

      const updates = ['status = ?'];
      const params = [status];

      if (status === 'resolved') {
        updates.push('resolved_by = ?', 'resolved_at = NOW()');
        params.push(req.user.id);
      }

      if (notes) {
        updates.push('resolution_notes = ?');
        params.push(notes);
      }

      params.push(errorId);

      await db.query(`
        UPDATE system_error_logs
        SET ${updates.join(', ')}
        WHERE id = ?
      `, params);

      await logAdminAction(db, {
        adminId: req.user.id,
        adminUsername: req.user.username,
        action: 'error_status_updated',
        targetType: 'error_log',
        targetId: errorId,
        details: { status, notes },
        ipAddress: req.ip
      });

      res.json({ success: true, message: 'Error status updated successfully' });
    } catch (error) {
      console.error('Update error status error:', error);
      res.status(500).json({ success: false, message: 'Failed to update error status' });
    }
  });


  /**
   * POST /api/admin/monitoring/errors/bulk-resolve
   * Bulk resolve errors (e.g., resolve all errors of a type)
   * Permission: monitoring.manage
   */
  router.post('/errors/bulk-resolve', requireAdmin, requirePermission('monitoring.manage'), async (req, res) => {
    try {
      const { errorType, endpoint, notes } = req.body;

      if (!errorType && !endpoint) {
        return res.status(400).json({ success: false, message: 'errorType or endpoint required' });
      }

      let query = `
        UPDATE system_error_logs
        SET status = 'resolved', resolved_by = ?, resolved_at = NOW(), resolution_notes = ?
        WHERE status = 'new'
      `;
      
      const params = [req.user.id, notes || 'Bulk resolved'];

      if (errorType) {
        query += ` AND error_type = ?`;
        params.push(errorType);
      }

      if (endpoint) {
        query += ` AND endpoint = ?`;
        params.push(endpoint);
      }

      const [result] = await db.query(query, params);

      await logAdminAction(db, {
        adminId: req.user.id,
        adminUsername: req.user.username,
        action: 'errors_bulk_resolved',
        targetType: 'error_logs',
        targetId: null,
        details: { errorType, endpoint, notes, count: result.affectedRows },
        ipAddress: req.ip
      });

      res.json({ 
        success: true, 
        message: `${result.affectedRows} errors resolved successfully`,
        count: result.affectedRows
      });
    } catch (error) {
      console.error('Bulk resolve errors error:', error);
      res.status(500).json({ success: false, message: 'Failed to bulk resolve errors' });
    }
  });


  /**
   * GET /api/admin/monitoring/errors/statistics
   * Get error statistics
   * Permission: monitoring.view
   */
  router.get('/errors/statistics', requireAdmin, requirePermission('monitoring.view'), async (req, res) => {
    try {
      const { timeRange = '24h' } = req.query;

      // Convert timeRange to hours
      const timeRangeMap = {
        '1h': 1,
        '6h': 6,
        '24h': 24,
        '7d': 168,
        '30d': 720
      };
      const hours = timeRangeMap[timeRange] || 24;

      // Errors by level
      const [byLevel] = await db.query(`
        SELECT error_level, COUNT(*) as count
        FROM system_error_logs
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
        GROUP BY error_level
        ORDER BY FIELD(error_level, 'fatal', 'critical', 'error', 'warning', 'info', 'debug')
      `, [hours]);

      // Errors by type
      const [byType] = await db.query(`
        SELECT error_type, COUNT(*) as count
        FROM system_error_logs
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
        GROUP BY error_type
        ORDER BY count DESC
        LIMIT 10
      `, [hours]);

      // Errors by endpoint
      const [byEndpoint] = await db.query(`
        SELECT endpoint, COUNT(*) as count
        FROM system_error_logs
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR) AND endpoint IS NOT NULL
        GROUP BY endpoint
        ORDER BY count DESC
        LIMIT 10
      `, [hours]);

      // Error trends (hourly)
      const [trends] = await db.query(`
        SELECT 
          DATE_FORMAT(created_at, '%Y-%m-%d %H:00:00') AS hour,
          COUNT(*) as count
        FROM system_error_logs
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
        GROUP BY hour
        ORDER BY hour ASC
      `, [hours]);

      res.json({
        success: true,
        statistics: {
          byLevel,
          byType,
          byEndpoint,
          trends
        },
        timeRange
      });
    } catch (error) {
      console.error('Get error statistics error:', error);
      res.status(500).json({ success: false, message: 'Failed to get error statistics' });
    }
  });


  // ============================================
  // SYSTEM CONFIGURATION ENDPOINTS
  // ============================================

  /**
   * GET /api/admin/monitoring/config
   * Get all system configuration
   * Permission: config.view
   */
  router.get('/config', requireAdmin, requirePermission('config.view'), async (req, res) => {
    try {
      const { category, subcategory } = req.query;

      let query = `SELECT * FROM system_config WHERE 1=1`;
      const params = [];

      if (category) {
        query += ` AND category = ?`;
        params.push(category);
      }

      if (subcategory) {
        query += ` AND subcategory = ?`;
        params.push(subcategory);
      }

      query += ` ORDER BY category, subcategory, config_key`;

      const [configs] = await db.query(query, params);

      // Group by category
      const grouped = configs.reduce((acc, config) => {
        if (!acc[config.category]) {
          acc[config.category] = [];
        }
        
        // Mask sensitive values
        if (config.is_sensitive) {
          config.config_value = '***HIDDEN***';
        }
        
        acc[config.category].push(config);
        return acc;
      }, {});

      res.json({
        success: true,
        configs: grouped,
        rawConfigs: configs
      });
    } catch (error) {
      console.error('Get system config error:', error);
      res.status(500).json({ success: false, message: 'Failed to get system config' });
    }
  });


  /**
   * GET /api/admin/monitoring/config/:key
   * Get specific config value
   * Permission: config.view
   */
  router.get('/config/:key', requireAdmin, requirePermission('config.view'), async (req, res) => {
    try {
      const { key } = req.params;

      const [configs] = await db.query(`
        SELECT * FROM system_config WHERE config_key = ?
      `, [key]);

      if (configs.length === 0) {
        return res.status(404).json({ success: false, message: 'Configuration not found' });
      }

      const config = configs[0];

      // Mask sensitive values
      if (config.is_sensitive) {
        config.config_value = '***HIDDEN***';
      }

      res.json({
        success: true,
        config
      });
    } catch (error) {
      console.error('Get config value error:', error);
      res.status(500).json({ success: false, message: 'Failed to get config value' });
    }
  });


  /**
   * PUT /api/admin/monitoring/config/:key
   * Update system configuration
   * Permission: config.manage
   */
  router.put('/config/:key', requireAdmin, requirePermission('config.manage'), async (req, res) => {
    try {
      const { key } = req.params;
      const { value } = req.body;

      if (value === undefined) {
        return res.status(400).json({ success: false, message: 'Value is required' });
      }

      // Get current config
      const [configs] = await db.query(`
        SELECT * FROM system_config WHERE config_key = ?
      `, [key]);

      if (configs.length === 0) {
        return res.status(404).json({ success: false, message: 'Configuration not found' });
      }

      const config = configs[0];

      if (!config.is_editable) {
        return res.status(403).json({ success: false, message: 'This configuration is not editable' });
      }

      // Validate value type
      let validatedValue = value;
      
      if (config.value_type === 'number') {
        validatedValue = parseFloat(value);
        if (isNaN(validatedValue)) {
          return res.status(400).json({ success: false, message: 'Value must be a number' });
        }
        
        if (config.min_value !== null && validatedValue < config.min_value) {
          return res.status(400).json({ success: false, message: `Value must be >= ${config.min_value}` });
        }
        
        if (config.max_value !== null && validatedValue > config.max_value) {
          return res.status(400).json({ success: false, message: `Value must be <= ${config.max_value}` });
        }
        
        validatedValue = validatedValue.toString();
      } else if (config.value_type === 'boolean') {
        if (value !== 'true' && value !== 'false' && value !== true && value !== false) {
          return res.status(400).json({ success: false, message: 'Value must be true or false' });
        }
        validatedValue = (value === true || value === 'true') ? 'true' : 'false';
      } else if (config.value_type === 'json') {
        try {
          JSON.parse(value);
          validatedValue = value;
        } catch (e) {
          return res.status(400).json({ success: false, message: 'Value must be valid JSON' });
        }
      }

      // Update config
      await db.query(`
        UPDATE system_config
        SET 
          config_value = ?,
          updated_by = ?,
          updated_by_username = ?,
          updated_at = NOW()
        WHERE config_key = ?
      `, [validatedValue, req.user.id, req.user.username, key]);

      // Log admin action
      await logAdminAction(db, {
        adminId: req.user.id,
        adminUsername: req.user.username,
        action: 'config_updated',
        targetType: 'system_config',
        targetId: config.id,
        details: { 
          configKey: key, 
          oldValue: config.is_sensitive ? '***HIDDEN***' : config.config_value, 
          newValue: config.is_sensitive ? '***HIDDEN***' : validatedValue 
        },
        ipAddress: req.ip
      });

      res.json({ 
        success: true, 
        message: 'Configuration updated successfully',
        requiresRestart: config.requires_restart
      });
    } catch (error) {
      console.error('Update config error:', error);
      res.status(500).json({ success: false, message: 'Failed to update configuration' });
    }
  });


  /**
   * POST /api/admin/monitoring/config
   * Create new system configuration
   * Permission: config.manage
   */
  router.post('/config', requireAdmin, requirePermission('config.manage'), async (req, res) => {
    try {
      const {
        configKey,
        configValue,
        valueType,
        category,
        subcategory,
        description,
        defaultValue,
        isSensitive,
        requiresRestart,
        isEditable
      } = req.body;

      if (!configKey || !configValue || !valueType || !category) {
        return res.status(400).json({ success: false, message: 'Missing required fields' });
      }

      // Check if key exists
      const [existing] = await db.query(`
        SELECT id FROM system_config WHERE config_key = ?
      `, [configKey]);

      if (existing.length > 0) {
        return res.status(400).json({ success: false, message: 'Configuration key already exists' });
      }

      await db.query(`
        INSERT INTO system_config (
          config_key, config_value, value_type, category, subcategory,
          description, default_value, is_sensitive, requires_restart, is_editable
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        configKey, configValue, valueType, category, subcategory || null,
        description || null, defaultValue || configValue, isSensitive || false,
        requiresRestart || false, isEditable !== false
      ]);

      await logAdminAction(db, {
        adminId: req.user.id,
        adminUsername: req.user.username,
        action: 'config_created',
        targetType: 'system_config',
        targetId: null,
        details: { configKey, category },
        ipAddress: req.ip
      });

      res.json({ success: true, message: 'Configuration created successfully' });
    } catch (error) {
      console.error('Create config error:', error);
      res.status(500).json({ success: false, message: 'Failed to create configuration' });
    }
  });


  /**
   * DELETE /api/admin/monitoring/config/:key
   * Delete system configuration (custom configs only)
   * Permission: config.manage
   */
  router.delete('/config/:key', requireAdmin, requirePermission('config.manage'), async (req, res) => {
    try {
      const { key } = req.params;

      // Get config
      const [configs] = await db.query(`
        SELECT * FROM system_config WHERE config_key = ?
      `, [key]);

      if (configs.length === 0) {
        return res.status(404).json({ success: false, message: 'Configuration not found' });
      }

      const config = configs[0];

      if (!config.is_editable) {
        return res.status(403).json({ success: false, message: 'This configuration cannot be deleted' });
      }

      await db.query(`DELETE FROM system_config WHERE config_key = ?`, [key]);

      await logAdminAction(db, {
        adminId: req.user.id,
        adminUsername: req.user.username,
        action: 'config_deleted',
        targetType: 'system_config',
        targetId: config.id,
        details: { configKey: key, category: config.category },
        ipAddress: req.ip
      });

      res.json({ success: true, message: 'Configuration deleted successfully' });
    } catch (error) {
      console.error('Delete config error:', error);
      res.status(500).json({ success: false, message: 'Failed to delete configuration' });
    }
  });


  /**
   * POST /api/admin/monitoring/config/reset/:key
   * Reset configuration to default value
   * Permission: config.manage
   */
  router.post('/config/reset/:key', requireAdmin, requirePermission('config.manage'), async (req, res) => {
    try {
      const { key } = req.params;

      const [configs] = await db.query(`
        SELECT * FROM system_config WHERE config_key = ?
      `, [key]);

      if (configs.length === 0) {
        return res.status(404).json({ success: false, message: 'Configuration not found' });
      }

      const config = configs[0];

      if (!config.default_value) {
        return res.status(400).json({ success: false, message: 'No default value defined' });
      }

      await db.query(`
        UPDATE system_config
        SET 
          config_value = default_value,
          updated_by = ?,
          updated_by_username = ?,
          updated_at = NOW()
        WHERE config_key = ?
      `, [req.user.id, req.user.username, key]);

      await logAdminAction(db, {
        adminId: req.user.id,
        adminUsername: req.user.username,
        action: 'config_reset',
        targetType: 'system_config',
        targetId: config.id,
        details: { configKey: key },
        ipAddress: req.ip
      });

      res.json({ success: true, message: 'Configuration reset to default value' });
    } catch (error) {
      console.error('Reset config error:', error);
      res.status(500).json({ success: false, message: 'Failed to reset configuration' });
    }
  });


  return router;
};
