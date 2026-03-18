/**
 * Auto-migration for NOWPayments database tables (PostgreSQL)
 * This runs automatically when the server starts
 */

async function autoMigrate() {
  console.log('[Migration] Checking database tables...');

  let pgPool;
  try {
    pgPool = require('../pool').pool;

    // Test connection
    await pgPool.query('SELECT 1');
    console.log('[Migration] ✅ Database connected');

    // Check existing tables
    const { rows } = await pgPool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('deposit_intents', 'balances', 'withdrawals')`
    );
    const tableNames = rows.map(r => r.table_name);
    console.log('[Migration] Existing tables:', tableNames.join(', ') || 'none');

    const hasDepositIntents = tableNames.includes('deposit_intents');
    const hasBalances       = tableNames.includes('balances');
    const hasWithdrawals    = tableNames.includes('withdrawals');

    if (hasDepositIntents && hasBalances && hasWithdrawals) {
      console.log('[Migration] ✅ All tables exist');
      return;
    }

    console.log('[Migration] Creating missing tables...');

    if (!hasDepositIntents) {
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS deposit_intents (
          id              BIGSERIAL PRIMARY KEY,
          user_id         BIGINT      NOT NULL,
          provider        VARCHAR(32) NOT NULL DEFAULT 'nowpayments',
          payment_id      BIGINT      NOT NULL,
          pay_currency    VARCHAR(32) NOT NULL,
          price_amount    NUMERIC(18,8) NOT NULL,
          price_currency  VARCHAR(16) NOT NULL,
          pay_amount      NUMERIC(36,18),
          pay_address     VARCHAR(128),
          status          VARCHAR(32) NOT NULL DEFAULT 'created',
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (provider, payment_id)
        )
      `);
      await pgPool.query('CREATE INDEX IF NOT EXISTS idx_di_user    ON deposit_intents(user_id)');
      await pgPool.query('CREATE INDEX IF NOT EXISTS idx_di_status  ON deposit_intents(status)');
      await pgPool.query('CREATE INDEX IF NOT EXISTS idx_di_created ON deposit_intents(created_at)');
      console.log('[Migration] ✅ Created deposit_intents table');
    }

    if (!hasBalances) {
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS balances (
          user_id          BIGINT      NOT NULL,
          asset            VARCHAR(16) NOT NULL,
          available_atomic NUMERIC(65,0) NOT NULL DEFAULT 0,
          locked_atomic    NUMERIC(65,0) NOT NULL DEFAULT 0,
          created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (user_id, asset)
        )
      `);
      await pgPool.query('CREATE INDEX IF NOT EXISTS idx_balances_user_asset ON balances(user_id, asset)');
      console.log('[Migration] ✅ Created balances table');
    }

    if (!hasWithdrawals) {
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS withdrawals (
          id                  BIGSERIAL PRIMARY KEY,
          user_id             BIGINT      NOT NULL,
          asset               VARCHAR(16) NOT NULL,
          network             VARCHAR(32) NOT NULL,
          to_address          VARCHAR(128) NOT NULL,
          amount_atomic       NUMERIC(65,0) NOT NULL,
          fee_atomic          NUMERIC(65,0) NOT NULL DEFAULT 0,
          status              VARCHAR(32)  NOT NULL DEFAULT 'requested',
          provider            VARCHAR(32)  NOT NULL DEFAULT 'nowpayments',
          provider_payout_id  VARCHAR(128),
          provider_batch_id   VARCHAR(128),
          rejection_reason    TEXT,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          completed_at        TIMESTAMPTZ
        )
      `);
      await pgPool.query('CREATE INDEX IF NOT EXISTS idx_wd_user     ON withdrawals(user_id)');
      await pgPool.query('CREATE INDEX IF NOT EXISTS idx_wd_status   ON withdrawals(status)');
      await pgPool.query('CREATE INDEX IF NOT EXISTS idx_wd_provider ON withdrawals(provider, provider_payout_id)');
      console.log('[Migration] ✅ Created withdrawals table');
    }

    console.log('[Migration] ✅ Migration complete');

  } catch (error) {
    console.error('[Migration] ❌ Migration failed:', error.message);
    console.error('[Migration] DATABASE_URL set:', !!process.env.DATABASE_URL);
    // Don't throw — let server continue even if migration fails
  }
}

module.exports = { autoMigrate };
