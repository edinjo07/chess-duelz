// db.js - re-exports the PostgreSQL pool from pool.js
// Any module that does require('../db') or require('./db') gets the same pool interface.
const { db, pool } = require('./pool');
module.exports = db;
module.exports.db = db;
module.exports.pool = pool;
