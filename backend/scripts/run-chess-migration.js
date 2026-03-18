// Run this script to create chess database tables
// Usage: node backend/scripts/run-chess-migration.js

require('dotenv').config();
const mysql = require('mysql2');
const fs = require('fs');
const path = require('path');

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || process.env.DB_PASS || 'Italy101!@',
  database: process.env.DB_NAME || 'treasure_hunt',
  multipleStatements: true // Allow multiple SQL statements
};

const db = mysql.createConnection(dbConfig);

// Read the SQL file
const sqlPath = path.join(__dirname, 'setup-chess-database.sql');
const sql = fs.readFileSync(sqlPath, 'utf8');

console.log('🚀 Running chess database migration...');
console.log(`📁 Database: ${dbConfig.database}`);
console.log(`🔗 Host: ${dbConfig.host}`);

db.connect((err) => {
  if (err) {
    console.error('❌ Database connection failed:', err.message);
    process.exit(1);
  }

  console.log('✅ Connected to database');

  // Execute the SQL
  db.query(sql, (error, results) => {
    if (error) {
      console.error('❌ Migration failed:', error.message);
      db.end();
      process.exit(1);
    }

    console.log('✅ Migration completed successfully!');
    console.log('📊 Tables created:');
    console.log('   - chess_games');
    console.log('   - chess_game_moves');
    console.log('   - chess_user_stats');
    console.log('   - chess_settings');
    
    // Show the last result (success message from SQL)
    if (results && Array.isArray(results)) {
      const lastResult = results[results.length - 1];
      if (lastResult && lastResult.length > 0) {
        console.log('\n' + lastResult[0].message);
      }
    }

    db.end();
    process.exit(0);
  });
});
