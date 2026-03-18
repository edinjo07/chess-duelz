/**
 * Admin Security Migration
 * Adds is_admin column to users table and creates first admin user
 * Run this once to secure your admin panel
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

async function migrate() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined
  });

  console.log('✅ Connected to database');

  try {
    // Check if is_admin column already exists
    const [columns] = await connection.query(
      "SHOW COLUMNS FROM users LIKE 'is_admin'"
    );

    if (columns.length === 0) {
      console.log('Adding is_admin column...');
      await connection.query(
        "ALTER TABLE users ADD COLUMN is_admin BOOLEAN DEFAULT FALSE"
      );
      console.log('✅ Added is_admin column');

      // Add index
      await connection.query(
        "ALTER TABLE users ADD INDEX idx_is_admin (is_admin)"
      );
      console.log('✅ Added is_admin index');
    } else {
      console.log('✅ is_admin column already exists');
    }

    // Create admin_logs table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS admin_logs (
        id INT PRIMARY KEY AUTO_INCREMENT,
        user_id INT NOT NULL,
        username VARCHAR(50) NOT NULL,
        action VARCHAR(100) NOT NULL,
        details TEXT,
        ip_address VARCHAR(45),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_id (user_id),
        INDEX idx_action (action),
        INDEX idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✅ Admin logs table created');

    // Check if we need to create a default admin user
    const [adminUsers] = await connection.query(
      'SELECT COUNT(*) as count FROM users WHERE is_admin = TRUE'
    );

    if (adminUsers[0].count === 0) {
      console.log('\n⚠️  No admin users found. Creating default admin account...');
      
      const defaultAdmin = {
        email: 'admin@treasurehunt.com',
        username: 'admin',
        password: 'Admin@123456', // CHANGE THIS IMMEDIATELY!
      };

      const hashedPassword = await bcrypt.hash(defaultAdmin.password, 10);
      
      try {
        await connection.query(
          'INSERT INTO users (email, username, password, is_admin, balance) VALUES (?, ?, ?, TRUE, 10000.00)',
          [defaultAdmin.email, defaultAdmin.username, hashedPassword]
        );
        
        console.log('\n✅ DEFAULT ADMIN ACCOUNT CREATED:');
        console.log('   Email:', defaultAdmin.email);
        console.log('   Username:', defaultAdmin.username);
        console.log('   Password:', defaultAdmin.password);
        console.log('\n🚨 CRITICAL: Change this password immediately after first login!');
        console.log('   Login at: https://treasure-backend-dtgf.onrender.com/admin\n');
      } catch (insertErr) {
        if (insertErr.code === 'ER_DUP_ENTRY') {
          console.log('Admin user already exists, making them admin...');
          await connection.query(
            'UPDATE users SET is_admin = TRUE WHERE username = ?',
            [defaultAdmin.username]
          );
          console.log('✅ Updated existing user to admin');
        } else {
          throw insertErr;
        }
      }
    } else {
      console.log(`✅ Found ${adminUsers[0].count} admin user(s)`);
      
      // List admin users
      const [admins] = await connection.query(
        'SELECT id, username, email FROM users WHERE is_admin = TRUE'
      );
      console.log('\nCurrent admin users:');
      admins.forEach(admin => {
        console.log(`  - ${admin.username} (${admin.email}) [ID: ${admin.id}]`);
      });
    }

    console.log('\n✅ Migration complete!');
    console.log('\n📋 Next steps:');
    console.log('1. Access admin panel: /admin (not /admin.html)');
    console.log('2. Change default admin password if created');
    console.log('3. Update ADMIN_ALLOWED_IPS in server.js with your IP');
    console.log('4. Enable IP allowlist by uncommenting ipAllowlist checks');
    console.log('5. Push changes to GitHub to deploy to Render');

  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    throw error;
  } finally {
    await connection.end();
  }
}

migrate().catch(console.error);
