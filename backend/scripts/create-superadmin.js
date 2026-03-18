// scripts/create-superadmin.js
// CLI tool to create superadmin accounts
// Usage: node scripts/create-superadmin.js <username_or_email>

const db = require('../db.js');

const usernameOrEmail = process.argv[2];

if (!usernameOrEmail) {
  console.error('❌ Usage: node scripts/create-superadmin.js <username_or_email>');
  process.exit(1);
}

console.log('🔍 Looking for user:', usernameOrEmail);

db.query(
  'SELECT id, username, email, is_admin FROM users WHERE username = ? OR email = ?',
  [usernameOrEmail, usernameOrEmail],
  (err, results) => {
    if (err) {
      console.error('❌ Database error:', err);
      process.exit(1);
    }

    if (results.length === 0) {
      console.error('❌ User not found:', usernameOrEmail);
      console.log('\nUser must exist in the database first. Register the account, then run this script.');
      process.exit(1);
    }

    const user = results[0];

    if (user.is_admin) {
      console.log('ℹ️  User is already an admin');
      console.log('User ID:', user.id);
      console.log('Username:', user.username);
      console.log('Email:', user.email);
      
      // Ensure they have super_admin role
      ensureSuperAdminRole(user);
      return;
    }

    // Promote to admin
    db.query(
      'UPDATE users SET is_admin = 1 WHERE id = ?',
      [user.id],
      (updateErr) => {
        if (updateErr) {
          console.error('❌ Failed to promote user:', updateErr);
          process.exit(1);
        }

        console.log('✅ User promoted to admin successfully!');
        console.log('User ID:', user.id);
        console.log('Username:', user.username);
        console.log('Email:', user.email);
        
        // Assign super_admin role
        ensureSuperAdminRole(user);
      }
    );
  }
);

function ensureSuperAdminRole(user) {
  // Check if admin_roles table exists and super_admin role exists
  db.query(
    'SELECT id FROM admin_roles WHERE role_name = ?',
    ['super_admin'],
    (err, roles) => {
      if (err || roles.length === 0) {
        console.log('\n⚠️  Admin roles table not initialized yet.');
        console.log('Run database migrations to create RBAC tables.');
        db.end();
        return;
      }

      const roleId = roles[0].id;

      // Check if user already has role
      db.query(
        'SELECT id FROM user_admin_roles WHERE user_id = ? AND role_id = ?',
        [user.id, roleId],
        (checkErr, existing) => {
          if (checkErr) {
            console.error('Error checking roles:', checkErr);
            db.end();
            return;
          }

          if (existing.length > 0) {
            console.log('✅ User already has super_admin role');
            db.end();
            return;
          }

          // Assign super_admin role
          db.query(
            'INSERT INTO user_admin_roles (user_id, role_id, is_active) VALUES (?, ?, TRUE)',
            [user.id, roleId],
            (insertErr) => {
              if (insertErr) {
                console.error('❌ Failed to assign super_admin role:', insertErr);
              } else {
                console.log('✅ super_admin role assigned');
              }
              db.end();
            }
          );
        }
      );
    }
  );
}
