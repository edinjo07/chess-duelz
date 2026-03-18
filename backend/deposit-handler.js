// backend/deposit-handler.js
// Automated deposit monitoring and crediting system
require('dotenv').config();
const mysql = require('mysql2/promise');
const axios = require('axios');
const QRCode = require('qrcode');
const ledger = require('./lib/ledger');

// ============= CONFIGURATION =============
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || 'YOUR_ETHERSCAN_API_KEY';
const MEMPOOL_SPACE_API = 'https://mempool.space/api';
const COINBASE_API = 'https://api.coinbase.com/v2/exchange-rates';

// Confirmation requirements per network
const CONFIRMATION_REQUIREMENTS = {
  ethereum: 2,  // 2 confirmations for Ethereum
  bitcoin: 2    // 2 confirmations for Bitcoin
};

// Price conversion cache (refresh every 5 minutes)
let priceCache = {
  ETH: { usd: 0, lastUpdate: 0 },
  BTC: { usd: 0, lastUpdate: 0 },
  USDT: { usd: 1, lastUpdate: Date.now() }, // Stablecoin
  USDC: { usd: 1, lastUpdate: Date.now() }  // Stablecoin
};

const PRICE_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// ============= DATABASE CONNECTION =============
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'treasure_hunt'
};

let db;

async function initDatabase() {
  try {
    db = await mysql.createConnection(dbConfig);
    console.log('[DEPOSIT-HANDLER] Database connected');

    // Create deposits table if not exists
    await db.execute(`
      CREATE TABLE IF NOT EXISTS deposits (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        address VARCHAR(255) NOT NULL,
        asset VARCHAR(20) NOT NULL,
        network VARCHAR(50) NOT NULL,
        amount DECIMAL(20, 8) NOT NULL,
        usd_amount DECIMAL(10, 2) NOT NULL,
        tx_hash VARCHAR(255) DEFAULT NULL,
        confirmations INT DEFAULT 0,
        required_confirmations INT DEFAULT 2,
        status ENUM('pending', 'confirming', 'confirmed', 'failed') DEFAULT 'pending',
        credited BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        confirmed_at TIMESTAMP NULL,
        INDEX idx_user_id (user_id),
        INDEX idx_address (address),
        INDEX idx_tx_hash (tx_hash),
        INDEX idx_status (status),
        INDEX idx_created_at (created_at),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    console.log('[DEPOSIT-HANDLER] Deposits table ready');

    // Create deposit_addresses table for user addresses
    await db.execute(`
      CREATE TABLE IF NOT EXISTS deposit_addresses (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL UNIQUE,
        btc_address VARCHAR(255) DEFAULT NULL,
        eth_address VARCHAR(255) DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    console.log('[DEPOSIT-HANDLER] Deposit addresses table ready');

  } catch (error) {
    console.error('[DEPOSIT-HANDLER] Database initialization error:', error);
    throw error;
  }
}

// ============= PRICE FETCHING =============
async function fetchCryptoPrices() {
  try {
    const response = await axios.get(`${COINBASE_API}?currency=USD`);
    const rates = response.data.data.rates;

    // Update price cache
    if (rates.ETH) {
      priceCache.ETH = { usd: 1 / parseFloat(rates.ETH), lastUpdate: Date.now() };
    }
    if (rates.BTC) {
      priceCache.BTC = { usd: 1 / parseFloat(rates.BTC), lastUpdate: Date.now() };
    }

    console.log('[DEPOSIT-HANDLER] Prices updated:', {
      ETH: priceCache.ETH.usd.toFixed(2),
      BTC: priceCache.BTC.usd.toFixed(2)
    });
  } catch (error) {
    console.error('[DEPOSIT-HANDLER] Price fetch error:', error.message);
  }
}

function getUSDPrice(asset) {
  const price = priceCache[asset];
  if (!price || Date.now() - price.lastUpdate > PRICE_CACHE_DURATION) {
    fetchCryptoPrices(); // Refresh in background
  }
  return price ? price.usd : 0;
}

// ============= BLOCKCHAIN MONITORING =============

// Monitor Ethereum transactions
async function checkEthereumTransaction(txHash) {
  try {
    const url = `https://api.etherscan.io/api?module=proxy&action=eth_getTransactionByHash&txhash=${txHash}&apikey=${ETHERSCAN_API_KEY}`;
    const response = await axios.get(url);
    
    if (!response.data.result) {
      return { found: false };
    }

    const tx = response.data.result;
    
    // Get current block number
    const blockUrl = `https://api.etherscan.io/api?module=proxy&action=eth_blockNumber&apikey=${ETHERSCAN_API_KEY}`;
    const blockResponse = await axios.get(blockUrl);
    const currentBlock = parseInt(blockResponse.data.result, 16);
    const txBlock = parseInt(tx.blockNumber, 16);
    
    const confirmations = txBlock > 0 ? currentBlock - txBlock + 1 : 0;

    return {
      found: true,
      confirmations: confirmations,
      blockNumber: txBlock,
      from: tx.from,
      to: tx.to,
      value: parseInt(tx.value, 16) / 1e18, // Convert Wei to ETH
      status: tx.blockNumber ? 'confirmed' : 'pending'
    };
  } catch (error) {
    console.error('[DEPOSIT-HANDLER] Ethereum check error:', error.message);
    return { found: false, error: error.message };
  }
}

// Monitor Bitcoin transactions
async function checkBitcoinTransaction(txHash) {
  try {
    const url = `${MEMPOOL_SPACE_API}/tx/${txHash}`;
    const response = await axios.get(url);
    const tx = response.data;

    // Get confirmation count
    const confirmations = tx.status.confirmed ? 
      (tx.status.block_height ? 1 : 0) : 0;

    // Find our address in outputs
    let receivedAmount = 0;
    let toAddress = null;

    if (tx.vout && tx.vout.length > 0) {
      toAddress = tx.vout[0].scriptpubkey_address;
      receivedAmount = tx.vout[0].value / 1e8; // Convert satoshis to BTC
    }

    return {
      found: true,
      confirmations: confirmations,
      blockHeight: tx.status.block_height || 0,
      to: toAddress,
      value: receivedAmount,
      status: tx.status.confirmed ? 'confirmed' : 'pending'
    };
  } catch (error) {
    console.error('[DEPOSIT-HANDLER] Bitcoin check error:', error.message);
    return { found: false, error: error.message };
  }
}

// ============= DEPOSIT PROCESSING =============

async function processDeposit(deposit) {
  try {
    console.log(`[DEPOSIT-HANDLER] Processing deposit #${deposit.id} - ${deposit.asset} (${deposit.tx_hash})`);

    let txInfo;
    if (deposit.network === 'ethereum') {
      txInfo = await checkEthereumTransaction(deposit.tx_hash);
    } else if (deposit.network === 'bitcoin') {
      txInfo = await checkBitcoinTransaction(deposit.tx_hash);
    } else {
      console.error(`[DEPOSIT-HANDLER] Unknown network: ${deposit.network}`);
      return;
    }

    if (!txInfo.found) {
      console.log(`[DEPOSIT-HANDLER] Transaction not found: ${deposit.tx_hash}`);
      return;
    }

    // Update confirmations
    const confirmations = txInfo.confirmations || 0;
    const requiredConfirmations = deposit.required_confirmations;

    console.log(`[DEPOSIT-HANDLER] Confirmations: ${confirmations}/${requiredConfirmations}`);

    // Update deposit record
    await db.execute(
      `UPDATE deposits 
       SET confirmations = ?, 
           status = ?
       WHERE id = ?`,
      [
        confirmations,
        confirmations >= requiredConfirmations ? 'confirmed' : 'confirming',
        deposit.id
      ]
    );

    // If confirmed and not yet credited, credit the user
    if (confirmations >= requiredConfirmations && !deposit.credited) {
      await creditUserAccount(deposit);
    }

  } catch (error) {
    console.error(`[DEPOSIT-HANDLER] Error processing deposit #${deposit.id}:`, error);
    
    // Mark as failed if error persists
    await db.execute(
      `UPDATE deposits SET status = 'failed' WHERE id = ?`,
      [deposit.id]
    );
  }
}

async function creditUserAccount(deposit) {
  try {
    console.log(`[DEPOSIT-HANDLER] Crediting user #${deposit.user_id} with $${deposit.usd_amount}`);

    // Credit user via ledger system
    const entry = await ledger.createLedgerEntry({
      userId: deposit.user_id,
      type: ledger.ENTRY_TYPES.DEPOSIT_CREDIT,
      amount: deposit.usd_amount,
      currency: 'USD',
      referenceType: 'deposit',
      referenceId: deposit.id,
      metadata: {
        crypto_amount: deposit.crypto_amount,
        crypto_currency: deposit.crypto_currency,
        txid: deposit.txid,
        network: deposit.network,
        confirmations: deposit.confirmations
      }
    });

    // Mark deposit as credited
    await db.execute(
      `UPDATE deposits 
       SET credited = TRUE, 
           confirmed_at = NOW(),
           status = 'confirmed'
       WHERE id = ?`,
      [deposit.id]
    );

    console.log(`[DEPOSIT-HANDLER] ✅ Successfully credited $${deposit.usd_amount} to user #${deposit.user_id} (Balance: $${entry.balance_after})`);


    // Get updated balance
    const [users] = await db.execute(
      `SELECT balance FROM users WHERE id = ?`,
      [deposit.user_id]
    );

    if (users.length > 0) {
      console.log(`[DEPOSIT-HANDLER] New balance for user #${deposit.user_id}: $${users[0].balance}`);
    }

  } catch (error) {
    console.error('[DEPOSIT-HANDLER] Credit error:', error);
    await db.execute('ROLLBACK');
    throw error;
  }
}

// ============= MONITORING LOOP =============

async function monitorPendingDeposits() {
  try {
    // Get all deposits that are pending or confirming
    const [deposits] = await db.execute(
      `SELECT * FROM deposits 
       WHERE status IN ('pending', 'confirming') 
       AND credited = FALSE
       AND tx_hash IS NOT NULL
       ORDER BY created_at ASC
       LIMIT 100`
    );

    if (deposits.length > 0) {
      console.log(`[DEPOSIT-HANDLER] Found ${deposits.length} deposits to process`);
      
      // Process each deposit
      for (const deposit of deposits) {
        await processDeposit(deposit);
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

  } catch (error) {
    console.error('[DEPOSIT-HANDLER] Monitoring error:', error);
  }
}

// ============= ADDRESS MONITORING =============

async function monitorAddresses() {
  try {
    // Get all user addresses
    const [addresses] = await db.execute(
      `SELECT da.*, u.id as user_id, u.username 
       FROM deposit_addresses da
       JOIN users u ON da.user_id = u.id`
    );

    for (const addr of addresses) {
      // Check Ethereum address
      if (addr.eth_address) {
        await checkNewEthereumDeposits(addr);
      }

      // Check Bitcoin address
      if (addr.btc_address) {
        await checkNewBitcoinDeposits(addr);
      }

      // Small delay
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

  } catch (error) {
    console.error('[DEPOSIT-HANDLER] Address monitoring error:', error);
  }
}

async function checkNewEthereumDeposits(userAddress) {
  try {
    // Get latest transactions for this address
    const url = `https://api.etherscan.io/api?module=account&action=txlist&address=${userAddress.eth_address}&startblock=0&endblock=99999999&sort=desc&apikey=${ETHERSCAN_API_KEY}`;
    const response = await axios.get(url);

    if (response.data.status !== '1') return;

    const transactions = response.data.result.slice(0, 10); // Check last 10 transactions

    for (const tx of transactions) {
      // Check if transaction is TO our address
      if (tx.to.toLowerCase() !== userAddress.eth_address.toLowerCase()) continue;

      // Check if we already have this transaction
      const [existing] = await db.execute(
        `SELECT id FROM deposits WHERE tx_hash = ?`,
        [tx.hash]
      );

      if (existing.length > 0) continue;

      // New deposit found!
      const amount = parseInt(tx.value) / 1e18;
      if (amount <= 0) continue;

      const usdPrice = getUSDPrice('ETH');
      const usdAmount = amount * usdPrice;

      console.log(`[DEPOSIT-HANDLER] 🆕 New ETH deposit detected: ${amount} ETH ($${usdAmount.toFixed(2)}) for user #${userAddress.user_id}`);

      // Create deposit record
      await db.execute(
        `INSERT INTO deposits (user_id, address, asset, network, amount, usd_amount, tx_hash, required_confirmations, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userAddress.user_id,
          userAddress.eth_address,
          'ETH',
          'ethereum',
          amount,
          usdAmount,
          tx.hash,
          CONFIRMATION_REQUIREMENTS.ethereum,
          'confirming'
        ]
      );
    }

  } catch (error) {
    console.error('[DEPOSIT-HANDLER] ETH address check error:', error.message);
  }
}

async function checkNewBitcoinDeposits(userAddress) {
  try {
    const url = `${MEMPOOL_SPACE_API}/address/${userAddress.btc_address}/txs`;
    const response = await axios.get(url);
    const transactions = response.data.slice(0, 10); // Check last 10 transactions

    for (const tx of transactions) {
      // Check if transaction is TO our address
      const output = tx.vout.find(v => v.scriptpubkey_address === userAddress.btc_address);
      if (!output) continue;

      // Check if we already have this transaction
      const [existing] = await db.execute(
        `SELECT id FROM deposits WHERE tx_hash = ?`,
        [tx.txid]
      );

      if (existing.length > 0) continue;

      // New deposit found!
      const amount = output.value / 1e8;
      if (amount <= 0) continue;

      const usdPrice = getUSDPrice('BTC');
      const usdAmount = amount * usdPrice;

      console.log(`[DEPOSIT-HANDLER] 🆕 New BTC deposit detected: ${amount} BTC ($${usdAmount.toFixed(2)}) for user #${userAddress.user_id}`);

      // Create deposit record
      await db.execute(
        `INSERT INTO deposits (user_id, address, asset, network, amount, usd_amount, tx_hash, required_confirmations, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userAddress.user_id,
          userAddress.btc_address,
          'BTC',
          'bitcoin',
          amount,
          usdAmount,
          tx.txid,
          CONFIRMATION_REQUIREMENTS.bitcoin,
          'confirming'
        ]
      );
    }

  } catch (error) {
    console.error('[DEPOSIT-HANDLER] BTC address check error:', error.message);
  }
}

// ============= MAIN LOOP =============

async function startDepositHandler() {
  console.log('[DEPOSIT-HANDLER] Starting deposit monitoring service...');

  await initDatabase();
  await fetchCryptoPrices();

  // Price update interval (every 5 minutes)
  setInterval(fetchCryptoPrices, PRICE_CACHE_DURATION);

  // Monitor pending deposits (every 30 seconds)
  setInterval(monitorPendingDeposits, 30 * 1000);

  // Monitor addresses for new deposits (every 2 minutes)
  setInterval(monitorAddresses, 2 * 60 * 1000);

  console.log('[DEPOSIT-HANDLER] ✅ Deposit handler service running');
  console.log('[DEPOSIT-HANDLER] - Checking pending deposits every 30 seconds');
  console.log('[DEPOSIT-HANDLER] - Monitoring addresses every 2 minutes');
  console.log('[DEPOSIT-HANDLER] - Updating prices every 5 minutes');
}

// ============= QR CODE GENERATION =============

/**
 * Generate QR code for Ethereum address (ETH, USDT, USDC)
 */
async function generateEthQR(address, asset = null, amount = null) {
  try {
    let uri = `ethereum:${address}`;
    
    // Optional: Add amount for specific payment request
    if (amount) {
      // For tokens like USDT/USDC, amount is in smallest unit (wei for ETH, 6 decimals for USDT/USDC)
      const params = new URLSearchParams();
      if (asset && asset !== 'ETH') {
        params.append('value', amount.toString());
      } else {
        params.append('value', amount.toString());
      }
      uri += '?' + params.toString();
    }
    
    // Generate QR as base64 data URL
    const qrCode = await QRCode.toDataURL(uri, {
      width: 300,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });
    
    return qrCode;
  } catch (error) {
    console.error('❌ ETH QR generation error:', error);
    return null;
  }
}

/**
 * Generate QR code for Bitcoin address
 */
async function generateBtcQR(address, amount = null, label = null) {
  try {
    let uri = `bitcoin:${address}`;
    const params = new URLSearchParams();
    
    // Optional: Add amount in BTC
    if (amount) {
      params.append('amount', amount.toString());
    }
    
    // Optional: Add label
    if (label) {
      params.append('label', label);
    }
    
    if (params.toString()) {
      uri += '?' + params.toString();
    }
    
    // Generate QR as base64 data URL
    const qrCode = await QRCode.toDataURL(uri, {
      width: 300,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });
    
    return qrCode;
  } catch (error) {
    console.error('❌ BTC QR generation error:', error);
    return null;
  }
}

/**
 * Generate QR code for any address based on network
 */
async function generateDepositQR(address, network, asset = null, amount = null) {
  if (network === 'ethereum' || network === 'eth') {
    return await generateEthQR(address, asset, amount);
  } else if (network === 'bitcoin' || network === 'btc') {
    return await generateBtcQR(address, amount, 'Treasure Hunt Deposit');
  } else {
    console.error('❌ Unsupported network for QR generation:', network);
    return null;
  }
}

// ============= EXPORT =============

module.exports = {
  startDepositHandler,
  processDeposit,
  creditUserAccount,
  getUSDPrice,
  initDatabase,
  generateEthQR,
  generateBtcQR,
  generateDepositQR,
  db: () => db
};

// Run standalone if executed directly
if (require.main === module) {
  startDepositHandler().catch(error => {
    console.error('[DEPOSIT-HANDLER] Fatal error:', error);
    process.exit(1);
  });
}
