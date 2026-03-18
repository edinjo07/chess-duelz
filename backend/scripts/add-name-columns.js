// Add first_name and last_name columns to users table for OAuth
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mysql = require('mysql2');

const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined
});

db.connect((err) => {
  if (err) {
    console.error('❌ Database connection failed:', err);
    process.exit(1);
  }
  
  console.log('✅ Connected to database');
  
  // Add first_name column
  db.query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name VARCHAR(100) NULL AFTER username`,
    (err) => {
      if (err && !err.message.includes('Duplicate column')) {
        console.error('❌ Error adding first_name column:', err);
      } else {
        console.log('✅ Added first_name column');
      }
      
      // Add last_name column
      db.query(
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name VARCHAR(100) NULL AFTER first_name`,
        (err2) => {
          if (err2 && !err2.message.includes('Duplicate column')) {
            console.error('❌ Error adding last_name column:', err2);
          } else {
            console.log('✅ Added last_name column');
          }
          
          console.log('\n🎉 Name columns migration complete!');
          console.log('Users table now supports:');
          console.log('  - first_name (from OAuth providers)');
          console.log('  - last_name (from OAuth providers)');
          console.log('  - dob (date of birth - already exists)');
          console.log('  - phone (phone number - already exists)');
          db.end();
        }
      );
    }
  );
});
