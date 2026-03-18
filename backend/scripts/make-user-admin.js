/**
 * Make User Admin Script
 * Grants admin privileges to an existing user
 * 
 * Usage: node make-user-admin.js <username or email>
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');

async function makeAdmin() {
  const identifier = process.argv[2];
  
  if (!identifier) {
    console.error('❌ Usage: node make-user-admin.js <username or email>');
    console.error('Example: node make-user-admin.js john_doe');
    process.exit(1);
  }

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
    // Find user by username or email
    const [users] = await connection.query(
      'SELECT id, username, email, is_admin FROM users WHERE username = ? OR email = ?',
      [identifier, identifier]
    );

    if (users.length === 0) {
      console.error(`❌ User not found: ${identifier}`);
      process.exit(1);
    }

    const user = users[0];
    
    if (user.is_admin) {
      console.log(`✅ User "${user.username}" is already an admin`);
    } else {
      // Make user admin
      await connection.query(
        'UPDATE users SET is_admin = TRUE WHERE id = ?',
        [user.id]
      );
      
      console.log(`✅ Successfully granted admin privileges to "${user.username}"`);
      console.log(`   Email: ${user.email}`);
      console.log(`   User ID: ${user.id}`);
      console.log('\n🔐 User must re-login to get new token with admin privileges');
    }

    // Show all current admins
    const [admins] = await connection.query(
      'SELECT id, username, email FROM users WHERE is_admin = TRUE'
    );
    
    console.log(`\n📋 Current admin users (${admins.length}):`);
    admins.forEach(admin => {
      console.log(`   - ${admin.username} (${admin.email}) [ID: ${admin.id}]`);
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
    throw error;
  } finally {
    await connection.end();
  }
}

makeAdmin().catch(console.error);
