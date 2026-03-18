// backend/lib/ledger.js
// Ledger system - Single source of truth for all balance changes

const db = require('../db');

/**
 * Entry types for ledger
 */
const ENTRY_TYPES = {
  // Deposits
  DEPOSIT_CREDIT: 'deposit_credit',
  
  // Withdrawals
  WITHDRAWAL_DEBIT: 'withdrawal_debit',
  WITHDRAWAL_REFUND: 'withdrawal_refund',
  
  // Games/Betting
  BET_DEBIT: 'bet_debit',
  WIN_CREDIT: 'win_credit',
  BET_REFUND: 'bet_refund',
  
  // Admin
  ADMIN_CREDIT: 'admin_credit',
  ADMIN_DEBIT: 'admin_debit',
  
  // Fees
  FEE_DEBIT: 'fee_debit',
  
  // Other
  BONUS_CREDIT: 'bonus_credit',
  ADJUSTMENT: 'adjustment'
};

/**
 * Create a ledger entry and update user balance
 * This is the ONLY way to change user balances
 * 
 * @param {Object} params
 * @param {number} params.userId - User ID
 * @param {string} params.type - Entry type (use ENTRY_TYPES constants)
 * @param {number} params.amount - Amount (positive for credit, negative for debit)
 * @param {string} params.currency - Currency code (default: 'USD')
 * @param {string} params.referenceType - Reference type (deposit, withdrawal, game, etc.)
 * @param {number} params.referenceId - Reference ID
 * @param {Object} params.metadata - Additional data (JSON)
 * @param {number} params.createdBy - Admin user ID (for admin adjustments)
 * @returns {Promise<Object>} Created entry with new balance
 */
async function createLedgerEntry(params) {
  const {
    userId,
    type,
    amount,
    currency = 'USD',
    referenceType = null,
    referenceId = null,
    metadata = {},
    createdBy = null
  } = params;

  // Validation
  if (!userId) throw new Error('userId is required');
  if (!type) throw new Error('type is required');
  if (amount === undefined || amount === null) throw new Error('amount is required');
  if (!Object.values(ENTRY_TYPES).includes(type)) {
    throw new Error(`Invalid entry type: ${type}. Must be one of: ${Object.values(ENTRY_TYPES).join(', ')}`);
  }

  return new Promise((resolve, reject) => {
    db.getConnection((err, connection) => {
      if (err) return reject(err);

      // Start transaction
      connection.beginTransaction(async (txErr) => {
        if (txErr) {
          connection.release();
          return reject(txErr);
        }

        try {
          // 1. Get current balance (with row lock)
          const [balanceRows] = await new Promise((res, rej) => {
            connection.query(
              'SELECT balance FROM users WHERE id = ? FOR UPDATE',
              [userId],
              (err, rows) => err ? rej(err) : res([rows])
            );
          });

          if (!balanceRows || balanceRows.length === 0) {
            throw new Error(`User ${userId} not found`);
          }

          const balanceBefore = parseFloat(balanceRows[0].balance) || 0;
          const balanceAfter = balanceBefore + amount;

          // Check for negative balance (optional - can be enabled)
          // if (balanceAfter < 0) {
          //   throw new Error(`Insufficient balance. Current: ${balanceBefore}, Requested: ${amount}`);
          // }

          // 2. Create ledger entry
          const entryResult = await new Promise((res, rej) => {
            connection.query(
              `INSERT INTO ledger_entries 
               (user_id, type, amount, currency, balance_before, balance_after, 
                reference_type, reference_id, metadata, created_by, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
              [
                userId,
                type,
                amount,
                currency,
                balanceBefore,
                balanceAfter,
                referenceType,
                referenceId,
                JSON.stringify(metadata),
                createdBy
              ],
              (err, result) => err ? rej(err) : res(result)
            );
          });

          // 3. Update user balance
          await new Promise((res, rej) => {
            connection.query(
              'UPDATE users SET balance = ? WHERE id = ?',
              [balanceAfter, userId],
              (err, result) => err ? rej(err) : res(result)
            );
          });

          // Commit transaction
          connection.commit((commitErr) => {
            if (commitErr) {
              return connection.rollback(() => {
                connection.release();
                reject(commitErr);
              });
            }

            connection.release();

            // Return created entry
            resolve({
              id: entryResult.insertId,
              userId,
              type,
              amount,
              currency,
              balanceBefore,
              balanceAfter,
              referenceType,
              referenceId,
              metadata,
              createdBy
            });
          });

        } catch (error) {
          connection.rollback(() => {
            connection.release();
            reject(error);
          });
        }
      });
    });
  });
}

/**
 * Get user balance from ledger (computed)
 * @param {number} userId
 * @param {string} currency
 * @returns {Promise<number>}
 */
async function getUserBalance(userId, currency = 'USD') {
  return new Promise((resolve, reject) => {
    db.query(
      'SELECT COALESCE(SUM(amount), 0) as balance FROM ledger_entries WHERE user_id = ? AND currency = ?',
      [userId, currency],
      (err, rows) => {
        if (err) return reject(err);
        resolve(parseFloat(rows[0].balance) || 0);
      }
    );
  });
}

/**
 * Get user ledger entries
 * @param {number} userId
 * @param {Object} options - { limit, offset, type, dateFrom, dateTo }
 * @returns {Promise<Array>}
 */
async function getUserLedgerEntries(userId, options = {}) {
  const { limit = 50, offset = 0, type = null, dateFrom = null, dateTo = null } = options;

  let query = 'SELECT * FROM ledger_entries WHERE user_id = ?';
  const params = [userId];

  if (type) {
    query += ' AND type = ?';
    params.push(type);
  }

  if (dateFrom) {
    query += ' AND created_at >= ?';
    params.push(dateFrom);
  }

  if (dateTo) {
    query += ' AND created_at <= ?';
    params.push(dateTo);
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return new Promise((resolve, reject) => {
    db.query(query, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

/**
 * Reconcile user balance - check if cached balance matches ledger
 * @param {number} userId
 * @returns {Promise<Object>}
 */
async function reconcileUserBalance(userId) {
  return new Promise((resolve, reject) => {
    const query = `
      SELECT 
        u.id,
        u.username,
        u.balance as cached_balance,
        COALESCE(SUM(l.amount), 0) as ledger_balance,
        (u.balance - COALESCE(SUM(l.amount), 0)) as difference
      FROM users u
      LEFT JOIN ledger_entries l ON u.id = l.user_id
      WHERE u.id = ?
      GROUP BY u.id
    `;

    db.query(query, [userId], (err, rows) => {
      if (err) return reject(err);
      if (!rows || rows.length === 0) {
        return reject(new Error(`User ${userId} not found`));
      }

      const result = rows[0];
      resolve({
        userId: result.id,
        username: result.username,
        cachedBalance: parseFloat(result.cached_balance) || 0,
        ledgerBalance: parseFloat(result.ledger_balance) || 0,
        difference: parseFloat(result.difference) || 0,
        isMatch: Math.abs(parseFloat(result.difference)) < 0.01 // Allow 1 cent rounding
      });
    });
  });
}

/**
 * Reconcile all users - find mismatches
 * @returns {Promise<Array>}
 */
async function reconcileAllUsers() {
  return new Promise((resolve, reject) => {
    const query = `
      SELECT 
        u.id,
        u.username,
        u.balance as cached_balance,
        COALESCE(SUM(l.amount), 0) as ledger_balance,
        (u.balance - COALESCE(SUM(l.amount), 0)) as difference
      FROM users u
      LEFT JOIN ledger_entries l ON u.id = l.user_id
      GROUP BY u.id
      HAVING ABS(difference) >= 0.01
      ORDER BY ABS(difference) DESC
    `;

    db.query(query, (err, rows) => {
      if (err) return reject(err);
      resolve(rows.map(row => ({
        userId: row.id,
        username: row.username,
        cachedBalance: parseFloat(row.cached_balance) || 0,
        ledgerBalance: parseFloat(row.ledger_balance) || 0,
        difference: parseFloat(row.difference) || 0
      })));
    });
  });
}

module.exports = {
  ENTRY_TYPES,
  createLedgerEntry,
  getUserBalance,
  getUserLedgerEntries,
  reconcileUserBalance,
  reconcileAllUsers
};
