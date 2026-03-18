// backend/lib/db_mysql.js
// Production-safe MySQL connection pool with SSL for Aiven
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

// Create connection pool
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || process.env.DB_HOST,
  port: Number(process.env.MYSQL_PORT || process.env.DB_PORT || 3306),
  user: process.env.MYSQL_USER || process.env.DB_USER,
  password: process.env.MYSQL_PASSWORD || process.env.DB_PASSWORD || process.env.DB_PASS,
  database: process.env.MYSQL_DATABASE || process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  // SSL configuration for Aiven
  ssl: (process.env.MYSQL_HOST || process.env.DB_HOST)?.includes('aivencloud.com') ? {
    // Option A: CA cert from env variable (recommended for Render)
    ca: process.env.MYSQL_CA_CERT || undefined,
    // Option B: CA cert from file (if you uploaded ca-certificate.pem)
    // Uncomment below if using file:
    // ca: fs.existsSync(path.join(__dirname, '../ca-certificate.pem')) 
    //   ? fs.readFileSync(path.join(__dirname, '../ca-certificate.pem'), 'utf8') 
    //   : undefined,
    rejectUnauthorized: true
  } : undefined
});

// Helper: Format atomic amounts to display strings
function formatAtomic(amountAtomic, decimals, asset) {
  const s = String(amountAtomic);
  if (decimals === 0) return `${s} ${asset}`;
  
  const neg = s.startsWith('-');
  const n = neg ? s.slice(1) : s;
  const pad = n.padStart(decimals + 1, '0');
  const whole = pad.slice(0, -decimals) || '0';
  const frac = pad.slice(-decimals).replace(/0+$/, '');
  
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''} ${asset}`;
}

// Database interface
const db = {
  // Test connection
  async testConnection() {
    try {
      const [rows] = await pool.query('SELECT 1 AS test');
      return rows[0].test === 1;
    } catch (error) {
      console.error('Database connection test failed:', error.message);
      return false;
    }
  },

  // List all deposit addresses by network (for watchers)
  async listDepositAddressesByNetwork(network) {
    const col = network === 'bitcoin' ? 'btc_address' : 'evm_address';
    const [rows] = await pool.query(
      `SELECT user_id AS userId, ${col} AS address FROM deposit_addresses`
    );
    return rows;
  },

  // Get deposit address for specific user
  async getDepositAddressForUser(userId) {
    const [rows] = await pool.query(
      `SELECT btc_address AS btcAddress, evm_address AS evmAddress
       FROM deposit_addresses WHERE user_id = ?`,
      [userId]
    );
    return rows[0] || null;
  },

  // Create deposit addresses for new user
  async createDepositAddresses(userId, btcAddress, evmAddress) {
    await pool.query(
      `INSERT INTO deposit_addresses (user_id, btc_address, evm_address)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE user_id=user_id`,
      [userId, btcAddress, evmAddress]
    );
  },

  // Get deposit rules for asset
  async getRules(network, asset) {
    const [rows] = await pool.query(
      `SELECT min_display AS minDisplay, min_atomic AS minAtomic, 
              decimals, required_confirmations AS requiredConfirmations
       FROM deposit_rules WHERE network = ? AND asset = ?`,
      [network, asset]
    );
    if (!rows[0]) throw new Error(`Missing deposit rule for ${network}/${asset}`);
    return rows[0];
  },

  // Insert or update deposit transaction
  async upsertDepositSeen({ userId, network, asset, address, txHash, amountAtomic, decimals, blockNumber }) {
    const rules = await this.getRules(network, asset);

    await pool.query(
      `INSERT INTO deposits
       (user_id, network, asset, address, tx_hash, amount_atomic, decimals, block_number,
        confirmations, required_confirmations, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'pending')
       ON DUPLICATE KEY UPDATE
         block_number = VALUES(block_number),
         updated_at = CURRENT_TIMESTAMP`,
      [
        userId, network, asset, address, txHash,
        String(amountAtomic), decimals, blockNumber,
        rules.requiredConfirmations
      ]
    );

    const [rows] = await pool.query(
      `SELECT * FROM deposits WHERE network=? AND asset=? AND tx_hash=? AND address=?`,
      [network, asset, txHash, address]
    );
    return rows[0];
  },

  // Update deposit confirmations and status
  async updateDepositConfirmations({ network, txHash, confirmations, blockNumber, status }) {
    await pool.query(
      `UPDATE deposits
       SET confirmations=?, block_number=COALESCE(?, block_number),
           status=CASE
             WHEN status='credited' THEN status
             ELSE ?
           END,
           updated_at=CURRENT_TIMESTAMP
       WHERE network=? AND tx_hash=?`,
      [confirmations, blockNumber, status, network, txHash]
    );
  },

  // Get deposit by transaction hash
  async getDepositByTx({ network, asset, txHash }) {
    const [rows] = await pool.query(
      `SELECT * FROM deposits WHERE network=? AND asset=? AND tx_hash=?`,
      [network, asset, txHash]
    );
    return rows[0] || null;
  },

  // Get deposit by ID
  async getDepositById(depositId) {
    const [rows] = await pool.query(
      `SELECT * FROM deposits WHERE id=?`,
      [depositId]
    );
    return rows[0] || null;
  },

  // List recent deposits for user
  async listRecentDeposits(userId, limit = 10) {
    const [rows] = await pool.query(
      `SELECT id, asset, network, tx_hash AS txHash, status,
              confirmations, required_confirmations AS required,
              amount_atomic AS amountAtomic, decimals,
              created_at AS createdAt, updated_at AS updatedAt
       FROM deposits
       WHERE user_id=?
       ORDER BY created_at DESC
       LIMIT ?`,
      [userId, limit]
    );

    return rows.map(r => ({
      ...r,
      amountDisplay: formatAtomic(r.amountAtomic, r.decimals, r.asset)
    }));
  },

  // ATOMIC CREDIT: Prevents double-crediting with transaction + row locking
  async creditDepositAtomic({ depositId, userId, asset, amountAtomic }) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Lock deposit row for update
      const [deps] = await conn.query(
        `SELECT id, status FROM deposits WHERE id=? FOR UPDATE`,
        [depositId]
      );
      
      if (!deps[0]) {
        await conn.rollback();
        throw new Error('Deposit not found');
      }
      
      if (deps[0].status === 'credited') {
        await conn.rollback();
        console.log(`Deposit ${depositId} already credited, skipping`);
        return { ok: true, already: true };
      }

      // Ensure balance row exists
      await conn.query(
        `INSERT INTO balances (user_id, asset, available_atomic, locked_atomic)
         VALUES (?, ?, 0, 0)
         ON DUPLICATE KEY UPDATE user_id=user_id`,
        [userId, asset]
      );

      // Credit balance
      await conn.query(
        `UPDATE balances
         SET available_atomic = available_atomic + ?
         WHERE user_id=? AND asset=?`,
        [String(amountAtomic), userId, asset]
      );

      // Mark deposit as credited
      await conn.query(
        `UPDATE deposits SET status='credited', updated_at=CURRENT_TIMESTAMP WHERE id=?`,
        [depositId]
      );

      await conn.commit();
      console.log(`✅ Credited ${amountAtomic} ${asset} to user ${userId} (deposit #${depositId})`);
      return { ok: true, already: false };
      
    } catch (error) {
      await conn.rollback();
      console.error('Credit deposit error:', error);
      throw error;
    } finally {
      conn.release();
    }
  },

  // Get user balance
  async getUserBalance(userId, asset) {
    const [rows] = await pool.query(
      `SELECT available_atomic AS availableAtomic, locked_atomic AS lockedAtomic
       FROM balances WHERE user_id=? AND asset=?`,
      [userId, asset]
    );
    return rows[0] || { availableAtomic: 0, lockedAtomic: 0 };
  },

  // Get all balances for user
  async getAllUserBalances(userId) {
    const [rows] = await pool.query(
      `SELECT asset, available_atomic AS availableAtomic, locked_atomic AS lockedAtomic
       FROM balances WHERE user_id=?`,
      [userId]
    );
    return rows;
  },

  // Close pool (for graceful shutdown)
  async close() {
    await pool.end();
  }
};

module.exports = { db, pool, formatAtomic };
