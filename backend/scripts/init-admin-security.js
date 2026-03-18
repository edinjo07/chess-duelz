// backend/scripts/init-admin-security.js
// Run this script to initialize the admin security system
// Usage: node scripts/init-admin-security.js

const db = require('../db.js');
const fs = require('fs');
const path = require('path');

console.log('🔒 Initializing Admin Security System...\n');

const schemaPath = path.join(__dirname, '../database/admin_system_schema.sql');

if (!fs.existsSync(schemaPath)) {
  console.error('❌ Schema file not found:', schemaPath);
  process.exit(1);
}

console.log('📋 Reading schema file...');
const sql = fs.readFileSync(schemaPath, 'utf8');

console.log('🔨 Creating tables and roles...\n');

// Split SQL into individual statements
const statements = sql
  .split(';')
  .map(stmt => stmt.trim())
  .filter(stmt => stmt.length > 0);

let completed = 0;
let errors = 0;

statements.forEach((statement, index) => {
  db.query(statement, (err) => {
    completed++;
    
    if (err) {
      // Ignore "already exists" errors
      if (err.code === 'ER_TABLE_EXISTS_ERROR' || 
          err.message.includes('already exists') ||
          err.code === 'ER_DUP_ENTRY') {
        console.log(`ℹ️  Statement ${completed}/${statements.length}: Already exists (skipped)`);
      } else {
        console.error(`❌ Statement ${completed}/${statements.length} failed:`, err.message);
        errors++;
      }
    } else {
      console.log(`✅ Statement ${completed}/${statements.length}: Success`);
    }
    
    // When all statements are done
    if (completed === statements.length) {
      console.log('\n' + '='.repeat(50));
      
      if (errors === 0) {
        console.log('✅ Admin security system initialized successfully!');
        console.log('\nNext steps:');
        console.log('1. Create your first admin:');
        console.log('   node scripts/create-superadmin.js your_username');
        console.log('\n2. Disable admin setup endpoint in .env:');
        console.log('   ALLOW_ADMIN_SETUP=false');
        console.log('\n3. Update frontend pages (see FRONTEND_TOKEN_FIXES.md)');
      } else {
        console.log(`⚠️  Initialization completed with ${errors} error(s)`);
        console.log('Review errors above and fix issues.');
      }
      
      console.log('='.repeat(50));
      
      // Verify tables were created
      console.log('\n🔍 Verifying tables...');
      db.query('SHOW TABLES LIKE "admin_%"', (err, results) => {
        if (err) {
          console.error('Error checking tables:', err);
        } else {
          console.log(`Found ${results.length} admin tables:`);
          results.forEach(row => {
            const tableName = Object.values(row)[0];
            console.log(`  - ${tableName}`);
          });
        }
        
        // Check if roles were inserted
        db.query('SELECT role_name FROM admin_roles', (err, roles) => {
          if (err) {
            console.log('\n⚠️  Admin roles table exists but may need data');
          } else {
            console.log(`\n✅ Found ${roles.length} default roles:`);
            roles.forEach(role => {
              console.log(`  - ${role.role_name}`);
            });
          }
          
          console.log('\n✅ Initialization complete!');
          process.exit(errors > 0 ? 1 : 0);
        });
      });
    }
  });
});
