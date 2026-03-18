// backend/lib/mysql_pool.js
// MySQL connection pool with SSL for Aiven (CommonJS)

const mysql = require('mysql2/promise');

/**
 * MySQL connection pool configuration
 * Uses environment variables for secure credential management
 * Supports both MYSQL_* and DB_* variable names
 */
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || process.env.DB_HOST,
  port: Number(process.env.MYSQL_PORT || process.env.DB_PORT || 3306),
  user: process.env.MYSQL_USER || process.env.DB_USER,
  password: process.env.MYSQL_PASSWORD || process.env.DB_PASSWORD,
  database: process.env.MYSQL_DATABASE || process.env.DB_NAME || 'defaultdb',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  // SSL configuration for Aiven MySQL
  ssl: process.env.MYSQL_CA_CERT ? {
    ca: process.env.MYSQL_CA_CERT,
    rejectUnauthorized: true
  } : false
});

/**
 * Test database connection
 * @returns {Promise<boolean>} True if connection successful
 */
async function testConnection() {
  try {
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    console.log('[MySQL] Connection pool established successfully');
    return true;
  } catch (error) {
    console.error('[MySQL] Connection failed:', error.message);
    return false;
  }
}

/**
 * Get user balance for a specific asset
 * @param {number} userId - User ID
 * @param {string} asset - Asset code (BTC, ETH, USDT, USDC)
 * @returns {Promise<Object>} Balance object with atomic values
 */
async function getUserBalance(userId, asset) {
  const [rows] = await pool.query(
    `SELECT available_atomic, locked_atomic 
     FROM balances 
     WHERE user_id = ? AND asset = ?`,
    [userId, asset]
  );

  if (rows.length === 0) {
    return { available_atomic: '0', locked_atomic: '0' };
  }

  return rows[0];
}

/**
 * Initialize balance row if it doesn't exist
 * @param {number} userId - User ID
 * @param {string} asset - Asset code
 */
async function ensureBalanceExists(userId, asset) {
  await pool.query(
    `INSERT INTO balances (user_id, asset, available_atomic, locked_atomic)
     VALUES (?, ?, 0, 0)
     ON DUPLICATE KEY UPDATE user_id = user_id`,
    [userId, asset]
  );
}

/**
 * Credit user balance atomically (prevents double-credit)
 * @param {Object} params - Credit parameters
 * @param {number} params.paymentId - NOWPayments payment ID
 * @param {number} params.userId - User ID
 * @param {string} params.asset - Asset code
 * @param {string} params.atomicAmount - Amount in atomic units (string to avoid precision loss)
 * @returns {Promise<boolean>} True if credited, false if already credited
 */
async function creditOnce({ paymentId, userId, asset, atomicAmount }) {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();

    // Lock the deposit intent row (FOR UPDATE ensures exclusive access)
    const [rows] = await connection.query(
      `SELECT status FROM deposit_intents
       WHERE provider = 'nowpayments' AND payment_id = ? FOR UPDATE`,
      [paymentId]
    );

    if (!rows[0]) {
      console.warn(`[Credit] Payment ${paymentId} not found`);
      await connection.rollback();
      return false;
    }

    // Already credited → idempotent behavior
    if (rows[0].status === 'credited') {
      console.log(`[Credit] Payment ${paymentId} already credited, skipping`);
      await connection.rollback();
      return false;
    }

    // Ensure balance row exists
    await connection.query(
      `INSERT INTO balances (user_id, asset, available_atomic, locked_atomic)
       VALUES (?, ?, 0, 0)
       ON DUPLICATE KEY UPDATE user_id = user_id`,
      [userId, asset]
    );

    // Credit the balance
    await connection.query(
      `UPDATE balances
       SET available_atomic = available_atomic + ?
       WHERE user_id = ? AND asset = ?`,
      [atomicAmount, userId, asset]
    );

    // Mark as credited (prevents double-credit on webhook replay)
    await connection.query(
      `UPDATE deposit_intents
       SET status = 'credited'
       WHERE provider = 'nowpayments' AND payment_id = ?`,
      [paymentId]
    );

    await connection.commit();
    console.log(`[Credit] Successfully credited ${atomicAmount} ${asset} to user ${userId} (payment ${paymentId})`);
    return true;
    
  } catch (error) {
    await connection.rollback();
    console.error('[Credit] Transaction failed:', error);
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Convert atomic amount to decimal display format
 * @param {string|number} atomic - Atomic amount
 * @param {number} decimals - Number of decimal places
 * @returns {string} Formatted decimal string
 */
function formatAtomic(atomic, decimals) {
  const str = String(atomic).padStart(decimals + 1, '0');
  const intPart = str.slice(0, -decimals) || '0';
  const fracPart = str.slice(-decimals);
  return `${intPart}.${fracPart}`.replace(/\.?0+$/, '');
}

/**
 * Get decimal places for asset
 * @param {string} asset - Asset code
 * @returns {number} Number of decimals
 */
function decimalsFor(asset) {
  const decimals = {
    'BTC': 8,
    'ETH': 18,
    'USDT': 6,
    'USDC': 6
  };
  return decimals[asset] || 0;
}

module.exports = {
  pool,
  testConnection,
  getUserBalance,
  ensureBalanceExists,
  creditOnce,
  formatAtomic,
  decimalsFor
};
