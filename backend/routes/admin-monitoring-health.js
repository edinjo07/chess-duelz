const express = require('express');
const moment = require('moment');
const os = require('os');

module.exports = (db, adminAuth) => {
  const router = express.Router();
  const { requireAdmin, requirePermission, logAdminAction } = adminAuth;

  // ============================================
  // SYSTEM HEALTH MONITORING ENDPOINTS
  // ============================================

  /**
   * GET /api/admin/monitoring/health/dashboard
   * Get overall system health dashboard
   * Permission: monitoring.view
   */
  router.get('/health/dashboard', requireAdmin, requirePermission('monitoring.view'), async (req, res) => {
    try {
      // Get dashboard view
      const [dashboard] = await db.query(`SELECT * FROM v_system_health_dashboard`);

      // Get system metrics
      const memUsage = process.memoryUsage();
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const cpuUsage = os.loadavg()[0]; // 1-minute load average

      // Get recent performance stats
      const [recentPerf] = await db.query(`
        SELECT 
          COUNT(*) AS total_requests,
          AVG(response_time_ms) AS avg_response_time,
          MAX(response_time_ms) AS max_response_time,
          SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) AS server_errors,
          SUM(CASE WHEN status_code >= 400 AND status_code < 500 THEN 1 ELSE 0 END) AS client_errors
        FROM performance_metrics
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
      `);

      // Get active alerts by severity
      const [alertsBySeverity] = await db.query(`
        SELECT severity, COUNT(*) as count
        FROM system_alerts
        WHERE status IN ('active', 'acknowledged')
        GROUP BY severity
      `);

      res.json({
        success: true,
        dashboard: dashboard[0],
        system: {
          uptime: process.uptime(),
          nodeVersion: process.version,
          platform: os.platform(),
          memory: {
            heapUsed: memUsage.heapUsed,
            heapTotal: memUsage.heapTotal,
            rss: memUsage.rss,
            external: memUsage.external,
            totalSystem: totalMem,
            freeSystem: freeMem,
            usagePercent: ((totalMem - freeMem) / totalMem * 100).toFixed(2)
          },
          cpu: {
            loadAverage: cpuUsage,
            cores: os.cpus().length
          }
        },
        performance: recentPerf[0],
        alerts: {
          bySeverity: alertsBySeverity
        }
      });
    } catch (error) {
      console.error('Get health dashboard error:', error);
      res.status(500).json({ success: false, message: 'Failed to get health dashboard' });
    }
  });


  /**
   * GET /api/admin/monitoring/health/alerts
   * List system alerts
   * Permission: monitoring.view
   */
  router.get('/health/alerts', requireAdmin, requirePermission('monitoring.view'), async (req, res) => {
    try {
      const {
        status,      // active, acknowledged, resolved, muted
        severity,    // low, medium, high, critical
        alertType,
        affectedService,
        page = 1,
        limit = 50
      } = req.query;

      const offset = (parseInt(page) - 1) * parseInt(limit);
      
      let query = `
        SELECT 
          sa.*,
          TIMESTAMPDIFF(MINUTE, sa.triggered_at, NOW()) AS minutes_active
        FROM system_alerts sa
        WHERE 1=1
      `;
      
      const params = [];

      if (status) {
        query += ` AND sa.status = ?`;
        params.push(status);
      }

      if (severity) {
        query += ` AND sa.severity = ?`;
        params.push(severity);
      }

      if (alertType) {
        query += ` AND sa.alert_type = ?`;
        params.push(alertType);
      }

      if (affectedService) {
        query += ` AND sa.affected_service = ?`;
        params.push(affectedService);
      }

      // Count total
      const countQuery = query.replace(/SELECT.*FROM/, 'SELECT COUNT(*) as total FROM');
      const [countResult] = await db.query(countQuery, params);
      const total = countResult[0].total;

      // Add sorting (priority by severity for active alerts)
      if (!status || ['active', 'acknowledged'].includes(status)) {
        query += ` ORDER BY 
          CASE sa.severity
            WHEN 'critical' THEN 1
            WHEN 'high' THEN 2
            WHEN 'medium' THEN 3
            WHEN 'low' THEN 4
          END,
          sa.triggered_at DESC
        `;
      } else {
        query += ` ORDER BY sa.triggered_at DESC`;
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
      console.error('Get system alerts error:', error);
      res.status(500).json({ success: false, message: 'Failed to get system alerts' });
    }
  });


  /**
   * POST /api/admin/monitoring/health/alerts/:alertId/acknowledge
   * Acknowledge an alert
   * Permission: monitoring.manage
   */
  router.post('/health/alerts/:alertId/acknowledge', requireAdmin, requirePermission('monitoring.manage'), async (req, res) => {
    try {
      const { alertId } = req.params;
      const { notes } = req.body;

      await db.query(`
        UPDATE system_alerts
        SET 
          status = 'acknowledged',
          acknowledged_by = ?,
          acknowledged_by_username = ?,
          acknowledged_at = NOW(),
          resolution_notes = ?
        WHERE id = ?
      `, [req.user.id, req.user.username, notes || '', alertId]);

      await logAdminAction(db, {
        adminId: req.user.id,
        adminUsername: req.user.username,
        action: 'alert_acknowledged',
        targetType: 'system_alert',
        targetId: alertId,
        details: { notes },
        ipAddress: req.ip
      });

      res.json({ success: true, message: 'Alert acknowledged successfully' });
    } catch (error) {
      console.error('Acknowledge alert error:', error);
      res.status(500).json({ success: false, message: 'Failed to acknowledge alert' });
    }
  });


  /**
   * POST /api/admin/monitoring/health/alerts/:alertId/resolve
   * Resolve an alert
   * Permission: monitoring.manage
   */
  router.post('/health/alerts/:alertId/resolve', requireAdmin, requirePermission('monitoring.manage'), async (req, res) => {
    try {
      const { alertId } = req.params;
      const { resolution } = req.body;

      if (!resolution) {
        return res.status(400).json({ success: false, message: 'Resolution notes required' });
      }

      await db.query(`
        UPDATE system_alerts
        SET 
          status = 'resolved',
          resolved_by = ?,
          resolved_by_username = ?,
          resolved_at = NOW(),
          resolution_notes = ?
        WHERE id = ?
      `, [req.user.id, req.user.username, resolution, alertId]);

      await logAdminAction(db, {
        adminId: req.user.id,
        adminUsername: req.user.username,
        action: 'alert_resolved',
        targetType: 'system_alert',
        targetId: alertId,
        details: { resolution },
        ipAddress: req.ip
      });

      res.json({ success: true, message: 'Alert resolved successfully' });
    } catch (error) {
      console.error('Resolve alert error:', error);
      res.status(500).json({ success: false, message: 'Failed to resolve alert' });
    }
  });


  /**
   * POST /api/admin/monitoring/health/alerts/:alertId/mute
   * Mute an alert
   * Permission: monitoring.manage
   */
  router.post('/health/alerts/:alertId/mute', requireAdmin, requirePermission('monitoring.manage'), async (req, res) => {
    try {
      const { alertId } = req.params;
      const { duration_minutes, reason } = req.body;

      await db.query(`
        UPDATE system_alerts
        SET 
          status = 'muted',
          resolution_notes = CONCAT(
            COALESCE(resolution_notes, ''),
            '\n[', NOW(), '] Muted by ', ?, ' for ', ?, ' minutes: ', ?
          )
        WHERE id = ?
      `, [req.user.username, duration_minutes || 'indefinite', reason || 'No reason provided', alertId]);

      await logAdminAction(db, {
        adminId: req.user.id,
        adminUsername: req.user.username,
        action: 'alert_muted',
        targetType: 'system_alert',
        targetId: alertId,
        details: { duration_minutes, reason },
        ipAddress: req.ip
      });

      res.json({ success: true, message: 'Alert muted successfully' });
    } catch (error) {
      console.error('Mute alert error:', error);
      res.status(500).json({ success: false, message: 'Failed to mute alert' });
    }
  });


  /**
   * GET /api/admin/monitoring/health/metrics
   * Get performance metrics
   * Permission: monitoring.view
   */
  router.get('/health/metrics', requireAdmin, requirePermission('monitoring.view'), async (req, res) => {
    try {
      const {
        endpoint,
        timeRange = '1h', // 1h, 6h, 24h, 7d
        aggregation = '5m' // 1m, 5m, 15m, 1h
      } = req.query;

      // Convert timeRange to hours
      const timeRangeMap = {
        '1h': 1,
        '6h': 6,
        '24h': 24,
        '7d': 168
      };
      const hours = timeRangeMap[timeRange] || 1;

      // Build query
      let query = `
        SELECT 
          endpoint,
          method,
          COUNT(*) AS request_count,
          AVG(response_time_ms) AS avg_response_time,
          MAX(response_time_ms) AS max_response_time,
          MIN(response_time_ms) AS min_response_time,
          SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) AS server_errors,
          SUM(CASE WHEN status_code >= 400 AND status_code < 500 THEN 1 ELSE 0 END) AS client_errors,
          AVG(memory_heap_used) AS avg_memory_used,
          AVG(cpu_usage) AS avg_cpu_usage
        FROM performance_metrics
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
      `;
      
      const params = [hours];

      if (endpoint) {
        query += ` AND endpoint = ?`;
        params.push(endpoint);
      }

      query += ` GROUP BY endpoint, method ORDER BY request_count DESC LIMIT 50`;

      const [metrics] = await db.query(query, params);

      res.json({
        success: true,
        metrics,
        timeRange,
        aggregation
      });
    } catch (error) {
      console.error('Get metrics error:', error);
      res.status(500).json({ success: false, message: 'Failed to get metrics' });
    }
  });


  /**
   * GET /api/admin/monitoring/health/slow-endpoints
   * Get slowest endpoints
   * Permission: monitoring.view
   */
  router.get('/health/slow-endpoints', requireAdmin, requirePermission('monitoring.view'), async (req, res) => {
    try {
      const [slowEndpoints] = await db.query(`SELECT * FROM v_slow_endpoints`);

      res.json({
        success: true,
        slowEndpoints
      });
    } catch (error) {
      console.error('Get slow endpoints error:', error);
      res.status(500).json({ success: false, message: 'Failed to get slow endpoints' });
    }
  });


  /**
   * GET /api/admin/monitoring/health/error-rate
   * Get endpoints with high error rates
   * Permission: monitoring.view
   */
  router.get('/health/error-rate', requireAdmin, requirePermission('monitoring.view'), async (req, res) => {
    try {
      const [errorRate] = await db.query(`SELECT * FROM v_error_rate_by_endpoint`);

      res.json({
        success: true,
        errorRate
      });
    } catch (error) {
      console.error('Get error rate error:', error);
      res.status(500).json({ success: false, message: 'Failed to get error rate' });
    }
  });


  /**
   * GET /api/admin/monitoring/tasks
   * Get scheduled tasks status
   * Permission: monitoring.view
   */
  router.get('/tasks', requireAdmin, requirePermission('monitoring.view'), async (req, res) => {
    try {
      const { status, taskType } = req.query;

      let query = `SELECT * FROM scheduled_tasks WHERE 1=1`;
      const params = [];

      if (status) {
        query += ` AND status = ?`;
        params.push(status);
      }

      if (taskType) {
        query += ` AND task_type = ?`;
        params.push(taskType);
      }

      query += ` ORDER BY 
        CASE status
          WHEN 'failed' THEN 1
          WHEN 'running' THEN 2
          WHEN 'idle' THEN 3
          WHEN 'disabled' THEN 4
        END,
        task_name ASC
      `;

      const [tasks] = await db.query(query, params);

      res.json({
        success: true,
        tasks
      });
    } catch (error) {
      console.error('Get scheduled tasks error:', error);
      res.status(500).json({ success: false, message: 'Failed to get scheduled tasks' });
    }
  });


  /**
   * POST /api/admin/monitoring/tasks/:taskId/run
   * Manually trigger a scheduled task
   * Permission: monitoring.manage
   */
  router.post('/tasks/:taskId/run', requireAdmin, requirePermission('monitoring.manage'), async (req, res) => {
    try {
      const { taskId } = req.params;

      // Get task
      const [tasks] = await db.query(`SELECT * FROM scheduled_tasks WHERE id = ?`, [taskId]);
      
      if (tasks.length === 0) {
        return res.status(404).json({ success: false, message: 'Task not found' });
      }

      const task = tasks[0];

      if (!task.is_enabled) {
        return res.status(400).json({ success: false, message: 'Task is disabled' });
      }

      if (task.status === 'running') {
        return res.status(400).json({ success: false, message: 'Task is already running' });
      }

      // Update status to running
      await db.query(`
        UPDATE scheduled_tasks
        SET status = 'running', last_run_at = NOW()
        WHERE id = ?
      `, [taskId]);

      // Log admin action
      await logAdminAction(db, {
        adminId: req.user.id,
        adminUsername: req.user.username,
        action: 'task_triggered',
        targetType: 'scheduled_task',
        targetId: taskId,
        details: { taskName: task.task_name },
        ipAddress: req.ip
      });

      res.json({ 
        success: true, 
        message: `Task "${task.task_name}" triggered successfully`,
        note: 'Task is running in background. Check status for completion.'
      });

      // Note: Actual task execution would be handled by the worker process
      // This endpoint just marks it as ready to run
    } catch (error) {
      console.error('Trigger task error:', error);
      res.status(500).json({ success: false, message: 'Failed to trigger task' });
    }
  });


  /**
   * PATCH /api/admin/monitoring/tasks/:taskId
   * Update task configuration
   * Permission: monitoring.manage
   */
  router.patch('/tasks/:taskId', requireAdmin, requirePermission('monitoring.manage'), async (req, res) => {
    try {
      const { taskId } = req.params;
      const { isEnabled, scheduleIntervalMinutes } = req.body;

      const updates = [];
      const params = [];

      if (typeof isEnabled === 'boolean') {
        updates.push('is_enabled = ?');
        params.push(isEnabled);
        
        if (!isEnabled) {
          updates.push('status = "disabled"');
        }
      }

      if (scheduleIntervalMinutes) {
        updates.push('schedule_interval_minutes = ?');
        params.push(parseInt(scheduleIntervalMinutes));
      }

      if (updates.length === 0) {
        return res.status(400).json({ success: false, message: 'No updates provided' });
      }

      params.push(taskId);

      await db.query(`
        UPDATE scheduled_tasks
        SET ${updates.join(', ')}
        WHERE id = ?
      `, params);

      await logAdminAction(db, {
        adminId: req.user.id,
        adminUsername: req.user.username,
        action: 'task_updated',
        targetType: 'scheduled_task',
        targetId: taskId,
        details: { isEnabled, scheduleIntervalMinutes },
        ipAddress: req.ip
      });

      res.json({ success: true, message: 'Task updated successfully' });
    } catch (error) {
      console.error('Update task error:', error);
      res.status(500).json({ success: false, message: 'Failed to update task' });
    }
  });


  /**
   * GET /api/admin/monitoring/health/statistics
   * Get monitoring statistics
   * Permission: monitoring.view
   */
  router.get('/health/statistics', requireAdmin, requirePermission('monitoring.view'), async (req, res) => {
    try {
      // Error stats
      const [errorStats] = await db.query(`
        SELECT 
          COUNT(*) AS total_errors,
          SUM(CASE WHEN error_level = 'critical' THEN 1 ELSE 0 END) AS critical_errors,
          SUM(CASE WHEN error_level = 'error' THEN 1 ELSE 0 END) AS errors,
          SUM(CASE WHEN error_level = 'warning' THEN 1 ELSE 0 END) AS warnings
        FROM system_error_logs
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      `);

      // Alert stats
      const [alertStats] = await db.query(`
        SELECT 
          COUNT(*) AS total_alerts,
          SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_alerts,
          SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) AS critical_alerts,
          AVG(TIMESTAMPDIFF(MINUTE, triggered_at, COALESCE(resolved_at, NOW()))) AS avg_resolution_minutes
        FROM system_alerts
        WHERE triggered_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      `);

      // Performance stats
      const [perfStats] = await db.query(`
        SELECT 
          COUNT(*) AS total_requests,
          AVG(response_time_ms) AS avg_response_time,
          MAX(response_time_ms) AS max_response_time,
          SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) AS server_errors,
          SUM(CASE WHEN status_code >= 400 AND status_code < 500 THEN 1 ELSE 0 END) AS client_errors
        FROM performance_metrics
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      `);

      // Task stats
      const [taskStats] = await db.query(`
        SELECT 
          COUNT(*) AS total_tasks,
          SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running_tasks,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_tasks,
          SUM(total_runs) AS total_runs,
          SUM(successful_runs) AS successful_runs
        FROM scheduled_tasks
      `);

      res.json({
        success: true,
        statistics: {
          errors: errorStats[0],
          alerts: alertStats[0],
          performance: perfStats[0],
          tasks: taskStats[0]
        }
      });
    } catch (error) {
      console.error('Get monitoring statistics error:', error);
      res.status(500).json({ success: false, message: 'Failed to get monitoring statistics' });
    }
  });


  return router;
};
