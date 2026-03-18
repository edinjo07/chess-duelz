// Add OAuth columns to users table
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
  
  // Add google_id column
  db.query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(255) UNIQUE NULL AFTER email`,
    (err) => {
      if (err && !err.message.includes('Duplicate column')) {
        console.error('❌ Error adding google_id column:', err);
      } else {
        console.log('✅ Added google_id column');
      }
      
      // Add facebook_id column
      db.query(
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS facebook_id VARCHAR(255) UNIQUE NULL AFTER google_id`,
        (err2) => {
          if (err2 && !err2.message.includes('Duplicate column')) {
            console.error('❌ Error adding facebook_id column:', err2);
          } else {
            console.log('✅ Added facebook_id column');
          }
          
          console.log('\n🎉 OAuth columns migration complete!');
          db.end();
        }
      );
    }
  );
});
