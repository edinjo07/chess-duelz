/**
 * Auto-migration for NOWPayments database tables
 * This runs automatically when the server starts
 */

async function autoMigrate() {
  console.log('[Migration] Checking database tables...');
  
  let pool;
  try {
    // Dynamically require pool to avoid initialization issues
    pool = require('./mysql_pool');
    
    // Test connection first
    await pool.query('SELECT 1');
    console.log('[Migration] ✅ Database connected');
    
    // Check if tables exist
    const [tables] = await pool.query('SHOW TABLES');
    const tableNames = tables.map(t => Object.values(t)[0]);
    
    console.log('[Migration] Existing tables:', tableNames.join(', ') || 'none');
    
    const hasDepositIntents = tableNames.includes('deposit_intents');
    const hasBalances = tableNames.includes('balances');
    const hasWithdrawals = tableNames.includes('withdrawals');
    
    if (hasDepositIntents && hasBalances && hasWithdrawals) {
      console.log('[Migration] ✅ All tables exist');
      return;
    }
    
    console.log('[Migration] Creating missing tables...');
    
    // Create deposit_intents table
    if (!hasDepositIntents) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS deposit_intents (
          id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
          user_id BIGINT NOT NULL,
          provider VARCHAR(32) NOT NULL DEFAULT 'nowpayments',
          payment_id BIGINT NOT NULL,
          pay_currency VARCHAR(32) NOT NULL,
          price_amount DECIMAL(18,8) NOT NULL,
          price_currency VARCHAR(16) NOT NULL,
          pay_amount DECIMAL(36,18) NULL,
          pay_address VARCHAR(128) NULL,
          status VARCHAR(32) NOT NULL DEFAULT 'created',
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uniq_payment (provider, payment_id),
          KEY idx_user (user_id),
          KEY idx_status (status),
          KEY idx_created (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      console.log('[Migration] ✅ Created deposit_intents table');
    }
    
    // Create balances table
    if (!hasBalances) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS balances (
          user_id BIGINT NOT NULL,
          asset ENUM('BTC','ETH','USDT','USDC') NOT NULL,
          available_atomic DECIMAL(65,0) NOT NULL DEFAULT 0,
          locked_atomic DECIMAL(65,0) NOT NULL DEFAULT 0,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (user_id, asset),
          KEY idx_available (available_atomic)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      console.log('[Migration] ✅ Created balances table');
      
      // Create index
      try {
        await pool.query('CREATE INDEX idx_user_asset ON balances(user_id, asset)');
        console.log('[Migration] ✅ Created index idx_user_asset');
      } catch (err) {
        // Index might already exist, ignore error
        if (err.errno !== 1061) {
          console.log('[Migration] ⚠️ Index creation warning:', err.message);
        }
      }
    }
    
    // Create withdrawals table
    if (!hasWithdrawals) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS withdrawals (
          id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
          user_id BIGINT NOT NULL,
          asset ENUM('BTC','ETH','USDT','USDC') NOT NULL,
          network VARCHAR(32) NOT NULL,
          to_address VARCHAR(128) NOT NULL,
          amount_atomic DECIMAL(65,0) NOT NULL,
          fee_atomic DECIMAL(65,0) NOT NULL DEFAULT 0,
          status ENUM('requested','approved','creating','verifying','processing','completed','rejected','failed','canceled') NOT NULL DEFAULT 'requested',
          provider VARCHAR(32) NOT NULL DEFAULT 'nowpayments',
          provider_payout_id VARCHAR(128) NULL,
          provider_batch_id VARCHAR(128) NULL,
          rejection_reason TEXT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          completed_at TIMESTAMP NULL,
          KEY idx_user (user_id),
          KEY idx_status (status),
          KEY idx_provider (provider, provider_payout_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      console.log('[Migration] ✅ Created withdrawals table');
    }
    
    console.log('[Migration] ✅ Migration complete');
    
  } catch (error) {
    console.error('[Migration] ❌ Migration failed:', error.message);
    console.error('[Migration] Full error:', error);
    console.error('[Migration] Stack:', error.stack);
    
    // Log environment variables (without sensitive data)
    console.error('[Migration] MySQL Config:', {
      host: process.env.MYSQL_HOST || process.env.DB_HOST || 'NOT_SET',
      port: process.env.MYSQL_PORT || process.env.DB_PORT || 'NOT_SET',
      user: process.env.MYSQL_USER || process.env.DB_USER || 'NOT_SET',
      database: process.env.MYSQL_DATABASE || process.env.DB_NAME || 'NOT_SET',
      hasPassword: !!(process.env.MYSQL_PASSWORD || process.env.DB_PASSWORD)
    });
    
    // Don't throw - let server continue even if migration fails
    return;
  }
}

module.exports = { autoMigrate };
