// backend/worker.js
// Background worker for BTC + ETH deposit watchers
// Run this as a separate Render Background Worker service
require('dotenv').config();

const { runEthWatcher } = require('./watchers/eth');
const { runBtcWatcher } = require('./watchers/btc');
const { db } = require('./lib/db_mysql');

console.log('🚀 Starting Deposit Watchers...');

// Test database connection
db.testConnection()
  .then(connected => {
    if (!connected) {
      console.error('❌ Database connection failed. Exiting...');
      process.exit(1);
    }
    console.log('✅ Database connected');
    startWatchers();
  })
  .catch(error => {
    console.error('Database error:', error);
    process.exit(1);
  });

function startWatchers() {
  // Start Ethereum watcher
  if (process.env.ETH_RPC_URL) {
    runEthWatcher({
      rpcUrl: process.env.ETH_RPC_URL,
      confirmationsRequired: Number(process.env.ETH_CONFIRMATIONS || 12),
      pollInterval: Number(process.env.ETH_POLL_INTERVAL || 15000)
    }).catch(error => {
      console.error('ETH watcher crashed:', error);
    });
  } else {
    console.warn('⚠️  ETH_RPC_URL not set - Ethereum watcher disabled');
    console.warn('   Get free RPC from https://www.alchemy.com or https://www.infura.io');
  }

  // Start Bitcoin watcher
  runBtcWatcher({
    apiBase: process.env.BTC_API_BASE || 'https://mempool.space/api',
    confirmationsRequired: Number(process.env.BTC_CONFIRMATIONS || 2),
    pollInterval: Number(process.env.BTC_POLL_INTERVAL || 30000)
  }).catch(error => {
    console.error('BTC watcher crashed:', error);
  });
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down watchers...');
  await db.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down watchers...');
  await db.close();
  process.exit(0);
});
