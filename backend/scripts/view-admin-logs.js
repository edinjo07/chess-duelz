/**
 * View Admin Logs Script
 * Display recent admin actions for security auditing
 * 
 * Usage: 
 *   node view-admin-logs.js           (shows last 20 logs)
 *   node view-admin-logs.js 50        (shows last 50 logs)
 *   node view-admin-logs.js all       (shows all logs)
 *   node view-admin-logs.js username  (shows logs for specific admin)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');

async function viewLogs() {
  const arg = process.argv[2] || '20';
  
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined
  });

  console.log('✅ Connected to database\n');

  try {
    // Check if admin_logs table exists
    const [tables] = await connection.query(
      "SHOW TABLES LIKE 'admin_logs'"
    );

    if (tables.length === 0) {
      console.log('⚠️  Admin logs table does not exist yet');
      console.log('   Run: node scripts/add-admin-security.js');
      return;
    }

    let query = 'SELECT * FROM admin_logs';
    let params = [];

    // Check if arg is a username
    if (isNaN(arg) && arg !== 'all') {
      query += ' WHERE username = ? ORDER BY created_at DESC';
      params.push(arg);
      console.log(`📋 Admin logs for user: ${arg}\n`);
    } else {
      query += ' ORDER BY created_at DESC';
      if (arg !== 'all') {
        query += ' LIMIT ?';
        params.push(parseInt(arg));
        console.log(`📋 Last ${arg} admin actions:\n`);
      } else {
        console.log('📋 All admin actions:\n');
      }
    }

    const [logs] = await connection.query(query, params);

    if (logs.length === 0) {
      console.log('No admin logs found');
      return;
    }

    console.log('─'.repeat(80));
    logs.forEach((log, index) => {
      const details = log.details ? JSON.parse(log.details) : {};
      const date = new Date(log.created_at).toLocaleString();
      
      console.log(`${index + 1}. [${date}]`);
      console.log(`   Admin: ${log.username} (ID: ${log.user_id})`);
      console.log(`   Action: ${log.action}`);
      console.log(`   IP: ${log.ip_address || 'unknown'}`);
      
      if (Object.keys(details).length > 0) {
        console.log(`   Details: ${JSON.stringify(details, null, 2).replace(/\n/g, '\n            ')}`);
      }
      
      console.log('─'.repeat(80));
    });

    console.log(`\nTotal: ${logs.length} log entries`);

    // Show summary stats
    const [stats] = await connection.query(`
      SELECT 
        COUNT(*) as total_actions,
        COUNT(DISTINCT username) as unique_admins,
        COUNT(DISTINCT DATE(created_at)) as active_days
      FROM admin_logs
    `);

    console.log('\n📊 Summary:');
    console.log(`   Total Actions: ${stats[0].total_actions}`);
    console.log(`   Unique Admins: ${stats[0].unique_admins}`);
    console.log(`   Active Days: ${stats[0].active_days}`);

    // Show top actions
    const [topActions] = await connection.query(`
      SELECT action, COUNT(*) as count 
      FROM admin_logs 
      GROUP BY action 
      ORDER BY count DESC 
      LIMIT 5
    `);

    if (topActions.length > 0) {
      console.log('\n🔥 Most Common Actions:');
      topActions.forEach(action => {
        console.log(`   ${action.action}: ${action.count} times`);
      });
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    throw error;
  } finally {
    await connection.end();
  }
}

viewLogs().catch(console.error);
