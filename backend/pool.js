'use strict';
// pool.js - PostgreSQL (Supabase) connection pool with mysql2 callback compatibility
// Allows existing db.query(sql, params, callback) code to work unchanged.

const { Pool } = require('pg');

// Strip sslmode from the URL - newer pg versions parse sslmode=require as verify-full
// which rejects Supabase's certificate chain. We handle SSL via the explicit ssl option.
const _rawDbUrl = process.env.DATABASE_URL || '';
const _dbUrl = _rawDbUrl
  .replace(/([?&])sslmode=[^&]*/g, '$1')
  .replace(/[?&]$/, '')
  .replace(/\?&/, '?');

const pool = new Pool({
  connectionString: _dbUrl,
  ssl: { rejectUnauthorized: false },
  max: 50,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  statement_timeout: 15000,        // kill queries running > 15s
  query_timeout: 15000,
});

pool.on('error', (err) => {
  console.error('[DB Pool] Unexpected error:', err.message);
});

// ── SQL translation: MySQL → PostgreSQL ──────────────────────────────────────

function convertPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function mysqlToPg(sql) {
  return sql
    // Date/time functions
    .replace(/\bCURDATE\(\)/gi, 'CURRENT_DATE')
    .replace(/\bUNIX_TIMESTAMP\(\)/gi, "EXTRACT(EPOCH FROM NOW())::BIGINT")
    .replace(/\bYEAR\(([^)]+)\)/gi, (_, e) => `EXTRACT(YEAR FROM ${e})::INT`)
    .replace(/\bMONTH\(([^)]+)\)/gi, (_, e) => `EXTRACT(MONTH FROM ${e})::INT`)
    .replace(/\bDATE\(([^)]+)\)/gi, (_, e) => `(${e})::DATE`)
    // TIMESTAMPDIFF(UNIT, expr1, expr2) → integer difference
    .replace(/TIMESTAMPDIFF\s*\(\s*(\w+)\s*,\s*([^,]+?)\s*,\s*((?:[^)(]|\([^)]*\))+?)\s*\)/gi, (_, unit, e1, e2) => {
      const u = unit.toUpperCase();
      const epoch = `EXTRACT(EPOCH FROM ((${e2.trim()}) - (${e1.trim()})))`;
      if (u === 'SECOND') return `(${epoch})::BIGINT`;
      if (u === 'MINUTE') return `(${epoch} / 60)::BIGINT`;
      if (u === 'HOUR')   return `(${epoch} / 3600)::BIGINT`;
      if (u === 'DAY')    return `(${epoch} / 86400)::BIGINT`;
      return `(${epoch})::BIGINT`;
    })
    // DATE_SUB(expr, INTERVAL n UNIT) → expr - INTERVAL 'n units'
    .replace(/DATE_SUB\s*\(\s*((?:[^)(]|\([^)]*\))+?)\s*,\s*INTERVAL\s+(\d+)\s+(\w+)\s*\)/gi,
      (_, e, n, u) => `((${e.trim()}) - INTERVAL '${n} ${u.toLowerCase()}s')`)
    // DATE_ADD(expr, INTERVAL n UNIT) → expr + INTERVAL 'n units'
    .replace(/DATE_ADD\s*\(\s*((?:[^)(]|\([^)]*\))+?)\s*,\s*INTERVAL\s+(\d+)\s+(\w+)\s*\)/gi,
      (_, e, n, u) => `((${e.trim()}) + INTERVAL '${n} ${u.toLowerCase()}s')`)
    // DATE_FORMAT(expr, 'format') → TO_CHAR(expr, 'pgformat')
    .replace(/DATE_FORMAT\s*\(\s*([^,]+?)\s*,\s*'([^']+)'\s*\)/gi, (_, e, fmt) => {
      const pgFmt = fmt
        .replace(/%Y/g, 'YYYY').replace(/%m/g, 'MM').replace(/%d/g, 'DD')
        .replace(/%H/g, 'HH24').replace(/%i/g, 'MI').replace(/%s/g, 'SS');
      return `TO_CHAR(${e.trim()}, '${pgFmt}')`;
    })
    // SHOW TABLES LIKE 'name' (single or double quotes)
    .replace(/SHOW\s+TABLES\s+LIKE\s+["']([^"']+)["']/gi,
      (_, t) => `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='${t}'`)
    // SHOW TABLES (no filter) → list all user tables
    .replace(/\bSHOW\s+TABLES\b(?!\s+LIKE)/gi,
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public'`)
    // SHOW COLUMNS FROM table LIKE 'col'
    .replace(/SHOW\s+COLUMNS\s+FROM\s+(\w+)\s+LIKE\s+'([^']+)'/gi,
      (_, t, c) => `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='${t}' AND column_name='${c}'`)
    // SHOW COLUMNS FROM table
    .replace(/SHOW\s+COLUMNS\s+FROM\s+(\w+)/gi,
      (_, t) => `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='${t}'`)
    // SELECT DATABASE()
    .replace(/SELECT DATABASE\(\)/gi, "SELECT current_database() AS db")
    // INSERT IGNORE INTO → INSERT INTO ... ON CONFLICT DO NOTHING
    .replace(/INSERT\s+IGNORE\s+INTO\s+/gi, 'INSERT INTO ')
    // ON DUPLICATE KEY UPDATE ... (anything until end of statement) → ON CONFLICT DO NOTHING
    .replace(/\s+ON\s+DUPLICATE\s+KEY\s+UPDATE\s+[^;]*/gi, ' ON CONFLICT DO NOTHING');
}

// ── Result normalisation ─────────────────────────────────────────────────────

function normaliseResult(pgResult, originalSql) {
  const isSelect = /^\s*(SELECT|SHOW|WITH\s)/i.test(originalSql);
  if (isSelect) {
    // mysql2 returns an array of rows for SELECT
    return [pgResult.rows, pgResult.fields || []];
  }
  // mysql2 returns a result object for INSERT/UPDATE/DELETE
  const insertId = pgResult.rows && pgResult.rows[0] ? (pgResult.rows[0].id || null) : null;
  return [{
    affectedRows: pgResult.rowCount || 0,
    changedRows: pgResult.rowCount || 0,
    insertId: insertId,
  }, []];
}

// ── Core query with auto-RETURNING for INSERTs ───────────────────────────────

async function runQuery(sql, params = []) {
  let pgSql = mysqlToPg(sql);
  pgSql = convertPlaceholders(pgSql);

  // Auto-append RETURNING id to INSERT statements so insertId works
  if (/^\s*INSERT\s+/i.test(sql) && !/RETURNING/i.test(sql)) {
    pgSql = pgSql.trimEnd().replace(/;?\s*$/, '') + ' RETURNING id';
  }

  return pool.query(pgSql, params);
}

// ── mysql2-compatible db object ───────────────────────────────────────────────

const db = {
  // db.query(sql, callback)
  // db.query(sql, params, callback)
  query(sql, paramsOrCb, maybeCb) {
    let params, callback;
    if (typeof paramsOrCb === 'function') {
      params = [];
      callback = paramsOrCb;
    } else {
      params = paramsOrCb || [];
      callback = maybeCb;
    }

    runQuery(sql, params)
      .then((result) => {
        const [rows, fields] = normaliseResult(result, sql);
        if (callback) callback(null, rows, fields);
      })
      .catch((err) => {
        if (callback) callback(err);
      });
  },

  // db.getConnection(callback) - for transaction support
  getConnection(callback) {
    pool.connect((err, client, release) => {
      if (err) return callback(err);

      const conn = {
        query(sql, paramsOrCb, maybeCb) {
          db.query.call({ _client: client }, sql, paramsOrCb, maybeCb);
        },
        beginTransaction(cb) { client.query('BEGIN', cb); },
        commit(cb) { client.query('COMMIT', (e) => { release(); cb(e); }); },
        rollback(cb) { client.query('ROLLBACK', (e) => { release(); cb(e); }); },
        release,
      };

      // Override query to use the dedicated client
      conn.query = function(sql, paramsOrCb, maybeCb) {
        let params, callback;
        if (typeof paramsOrCb === 'function') { params = []; callback = paramsOrCb; }
        else { params = paramsOrCb || []; callback = maybeCb; }

        let pgSql = mysqlToPg(sql);
        pgSql = convertPlaceholders(pgSql);
        if (/^\s*INSERT\s+/i.test(sql) && !/RETURNING/i.test(sql)) {
          pgSql = pgSql.trimEnd().replace(/;?\s*$/, '') + ' RETURNING id';
        }
        client.query(pgSql, params, (err, result) => {
          if (err) return callback(err);
          const [rows, fields] = normaliseResult(result, sql);
          if (callback) callback(null, rows, fields);
        });
      };

      callback(null, conn);
    });
  },

  // Expose the pool for advanced use
  _pool: pool,

  on(event, handler) {
    pool.on(event, handler);
  },
};

module.exports = { db, pool };
