/**
 * Professional Withdrawal Handler for Crypto Casino
 * Handles: BTC, ETH, USDT, USDC withdrawals
 * Features: Balance validation, admin approval, auto-sending, status tracking
 */

const mysql = require('mysql2/promise');
const axios = require('axios');
const { Web3 } = require('web3');

// Web3 setup for Ethereum/USDT/USDC
const web3 = new Web3(process.env.ETHEREUM_RPC || 'https://eth-mainnet.g.alchemy.com/v2/demo');

// ERC20 Token Contracts
const USDT_CONTRACT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const USDC_CONTRACT = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

// ERC20 ABI (minimal - transfer function)
const ERC20_ABI = [
  {
    constant: false,
    inputs: [
      { name: '_to', type: 'address' },
      { name: '_value', type: 'uint256' }
    ],
    name: 'transfer',
    outputs: [{ name: '', type: 'bool' }],
    type: 'function'
  }
];

// Minimum withdrawal amounts (USD)
const MIN_WITHDRAW = {
  BTC: 10,
  ETH: 10,
  USDT: 20,
  USDC: 20
};

// Withdrawal fees (percentage)
const WITHDRAW_FEES = {
  BTC: 0.0005,  // 0.0005 BTC
  ETH: 0.002,   // 0.002 ETH
  USDT: 1,      // $1 flat fee
  USDC: 1       // $1 flat fee
};

let db;
let cryptoPrices = { BTC: 0, ETH: 0, USDT: 1, USDC: 1 };
let lastPriceUpdate = 0;

/**
 * Initialize database connection and create tables
 */
async function initDatabase() {
  db = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'treasure_hunt'
  });

  console.log('✅ Withdrawal Handler: Database connected');

  // Create withdrawals table
  await db.execute(`
    CREATE TABLE IF NOT EXISTS withdrawals (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      coin VARCHAR(10) NOT NULL,
      amount_usd DECIMAL(20, 2) NOT NULL,
      amount_crypto DECIMAL(20, 8) NOT NULL,
      address VARCHAR(100) NOT NULL,
      status ENUM('pending', 'approved', 'sending', 'sent', 'failed', 'rejected') DEFAULT 'pending',
      txid VARCHAR(100) DEFAULT NULL,
      fee_usd DECIMAL(20, 2) DEFAULT 0,
      fee_crypto DECIMAL(20, 8) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      approved_at TIMESTAMP NULL,
      sent_at TIMESTAMP NULL,
      rejected_reason TEXT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX idx_user (user_id),
      INDEX idx_status (status),
      INDEX idx_created (created_at)
    )
  `);

  // Create balances table if not exists
  await db.execute(`
    CREATE TABLE IF NOT EXISTS balances (
      user_id INT PRIMARY KEY,
      usd_balance DECIMAL(20, 2) DEFAULT 0.00,
      locked_balance DECIMAL(20, 2) DEFAULT 0.00,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  console.log('✅ Withdrawal Handler: Tables initialized');
}

/**
 * Fetch current crypto prices from Coinbase
 */
async function fetchCryptoPrices() {
  const now = Date.now();
  
  // Cache prices for 5 minutes
  if (now - lastPriceUpdate < 300000 && cryptoPrices.BTC > 0) {
    return cryptoPrices;
  }

  try {
    const coins = ['BTC', 'ETH'];
    const prices = {};

    for (const coin of coins) {
      const response = await axios.get(
        `https://api.coinbase.com/v2/exchange-rates?currency=${coin}`,
        { timeout: 5000 }
      );
      prices[coin] = parseFloat(response.data.data.rates.USD);
    }

    prices.USDT = 1.00;
    prices.USDC = 1.00;

    cryptoPrices = prices;
    lastPriceUpdate = now;

    console.log('💰 Prices updated:', prices);
    return prices;

  } catch (error) {
    console.error('❌ Price fetch error:', error.message);
    return cryptoPrices; // Return cached prices
  }
}

/**
 * Validate blockchain address format
 */
function isValidAddress(coin, address) {
  if (!address) return false;

  switch (coin) {
    case 'BTC':
      // Bitcoin: starts with 1, 3, or bc1
      return /^(1|3|bc1)[a-zA-HJ-NP-Z0-9]{25,62}$/.test(address);
    
    case 'ETH':
    case 'USDT':
    case 'USDC':
      // Ethereum: 0x followed by 40 hex characters
      return /^0x[a-fA-F0-9]{40}$/.test(address);
    
    default:
      return false;
  }
}

/**
 * Get user balance
 */
async function getUserBalance(userId) {
  const [rows] = await db.execute(
    'SELECT usd_balance, locked_balance FROM balances WHERE user_id = ?',
    [userId]
  );

  if (rows.length === 0) {
    // Create balance record if doesn't exist
    await db.execute(
      'INSERT INTO balances (user_id, usd_balance, locked_balance) VALUES (?, 0, 0)',
      [userId]
    );
    return { usd_balance: 0, locked_balance: 0 };
  }

  return rows[0];
}

/**
 * Request withdrawal (user-initiated)
 */
async function requestWithdrawal(userId, coin, amountUsd, address) {
  try {
    // 1. Validate minimum withdrawal
    if (amountUsd < MIN_WITHDRAW[coin]) {
      return {
        success: false,
        error: `Minimum withdrawal for ${coin} is $${MIN_WITHDRAW[coin]}`
      };
    }

    // 2. Validate address
    if (!isValidAddress(coin, address)) {
      return {
        success: false,
        error: 'Invalid blockchain address format'
      };
    }

    // 3. Check balance
    const balance = await getUserBalance(userId);
    const availableBalance = parseFloat(balance.usd_balance) - parseFloat(balance.locked_balance);

    if (availableBalance < amountUsd) {
      return {
        success: false,
        error: `Insufficient balance. Available: $${availableBalance.toFixed(2)}`
      };
    }

    // 4. Get crypto rates
    const rates = await fetchCryptoPrices();
    const rate = rates[coin];

    if (!rate || rate === 0) {
      return {
        success: false,
        error: 'Unable to fetch current exchange rate. Please try again.'
      };
    }

    // 5. Calculate crypto amount and fees
    let feeUsd, feeCrypto;
    if (coin === 'USDT' || coin === 'USDC') {
      feeUsd = WITHDRAW_FEES[coin];
      feeCrypto = feeUsd; // Stablecoins
    } else {
      feeCrypto = WITHDRAW_FEES[coin];
      feeUsd = feeCrypto * rate;
    }

    const totalUsd = amountUsd + feeUsd;
    
    if (availableBalance < totalUsd) {
      return {
        success: false,
        error: `Insufficient balance including fee. Total required: $${totalUsd.toFixed(2)} (amount: $${amountUsd}, fee: $${feeUsd.toFixed(2)})`
      };
    }

    const amountCrypto = amountUsd / rate;

    // 6. Lock balance (deduct from available)
    await db.execute(
      'UPDATE balances SET locked_balance = locked_balance + ? WHERE user_id = ?',
      [totalUsd, userId]
    );

    // 7. Create withdrawal record
    const [result] = await db.execute(
      `INSERT INTO withdrawals 
       (user_id, coin, amount_usd, amount_crypto, address, status, fee_usd, fee_crypto)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [userId, coin, amountUsd, amountCrypto, address, feeUsd, feeCrypto]
    );

    console.log(`✅ Withdrawal requested: ID ${result.insertId}, User ${userId}, ${amountCrypto} ${coin} ($${amountUsd})`);

    return {
      success: true,
      withdrawalId: result.insertId,
      amountCrypto,
      feeUsd,
      feeCrypto,
      totalUsd,
      rate
    };

  } catch (error) {
    console.error('❌ Request withdrawal error:', error);
    return {
      success: false,
      error: 'System error processing withdrawal request'
    };
  }
}

/**
 * Approve withdrawal (admin)
 */
async function approveWithdrawal(withdrawalId, adminId) {
  try {
    const [rows] = await db.execute(
      'SELECT * FROM withdrawals WHERE id = ?',
      [withdrawalId]
    );

    if (rows.length === 0) {
      return { success: false, error: 'Withdrawal not found' };
    }

    const withdrawal = rows[0];

    if (withdrawal.status !== 'pending') {
      return { success: false, error: `Cannot approve: status is ${withdrawal.status}` };
    }

    await db.execute(
      'UPDATE withdrawals SET status = ?, approved_at = NOW() WHERE id = ?',
      ['approved', withdrawalId]
    );

    console.log(`✅ Withdrawal ${withdrawalId} approved by admin ${adminId}`);

    return { success: true };

  } catch (error) {
    console.error('❌ Approve withdrawal error:', error);
    return { success: false, error: 'System error' };
  }
}

/**
 * Reject withdrawal (admin)
 */
async function rejectWithdrawal(withdrawalId, reason, adminId) {
  try {
    const [rows] = await db.execute(
      'SELECT * FROM withdrawals WHERE id = ?',
      [withdrawalId]
    );

    if (rows.length === 0) {
      return { success: false, error: 'Withdrawal not found' };
    }

    const withdrawal = rows[0];

    if (withdrawal.status !== 'pending') {
      return { success: false, error: `Cannot reject: status is ${withdrawal.status}` };
    }

    // Unlock balance
    const totalUsd = parseFloat(withdrawal.amount_usd) + parseFloat(withdrawal.fee_usd);
    await db.execute(
      'UPDATE balances SET locked_balance = locked_balance - ? WHERE user_id = ?',
      [totalUsd, withdrawal.user_id]
    );

    // Update withdrawal
    await db.execute(
      'UPDATE withdrawals SET status = ?, rejected_reason = ? WHERE id = ?',
      ['rejected', reason, withdrawalId]
    );

    console.log(`❌ Withdrawal ${withdrawalId} rejected by admin ${adminId}: ${reason}`);

    return { success: true };

  } catch (error) {
    console.error('❌ Reject withdrawal error:', error);
    return { success: false, error: 'System error' };
  }
}

/**
 * Send ETH withdrawal
 */
async function sendETHWithdrawal(withdrawal) {
  const senderAddress = process.env.MAIN_WALLET_ADDRESS;
  const privateKey = process.env.MAIN_WALLET_PK;

  if (!senderAddress || !privateKey) {
    throw new Error('Wallet credentials not configured');
  }

  const amountWei = web3.utils.toWei(withdrawal.amount_crypto.toString(), 'ether');

  const tx = {
    from: senderAddress,
    to: withdrawal.address,
    value: amountWei,
    gas: 21000,
    gasPrice: await web3.eth.getGasPrice()
  };

  const signed = await web3.eth.accounts.signTransaction(tx, privateKey);
  const receipt = await web3.eth.sendSignedTransaction(signed.rawTransaction);

  return receipt.transactionHash;
}

/**
 * Send USDT withdrawal
 */
async function sendUSDTWithdrawal(withdrawal) {
  const senderAddress = process.env.MAIN_WALLET_ADDRESS;
  const privateKey = process.env.MAIN_WALLET_PK;

  if (!senderAddress || !privateKey) {
    throw new Error('Wallet credentials not configured');
  }

  const contract = new web3.eth.Contract(ERC20_ABI, USDT_CONTRACT);
  const amount = Math.floor(withdrawal.amount_crypto * 1e6); // USDT has 6 decimals

  const data = contract.methods.transfer(withdrawal.address, amount).encodeABI();

  const tx = {
    from: senderAddress,
    to: USDT_CONTRACT,
    gas: 120000,
    gasPrice: await web3.eth.getGasPrice(),
    data
  };

  const signed = await web3.eth.accounts.signTransaction(tx, privateKey);
  const receipt = await web3.eth.sendSignedTransaction(signed.rawTransaction);

  return receipt.transactionHash;
}

/**
 * Send USDC withdrawal
 */
async function sendUSDCWithdrawal(withdrawal) {
  const senderAddress = process.env.MAIN_WALLET_ADDRESS;
  const privateKey = process.env.MAIN_WALLET_PK;

  if (!senderAddress || !privateKey) {
    throw new Error('Wallet credentials not configured');
  }

  const contract = new web3.eth.Contract(ERC20_ABI, USDC_CONTRACT);
  const amount = Math.floor(withdrawal.amount_crypto * 1e6); // USDC has 6 decimals

  const data = contract.methods.transfer(withdrawal.address, amount).encodeABI();

  const tx = {
    from: senderAddress,
    to: USDC_CONTRACT,
    gas: 120000,
    gasPrice: await web3.eth.getGasPrice(),
    data
  };

  const signed = await web3.eth.accounts.signTransaction(tx, privateKey);
  const receipt = await web3.eth.sendSignedTransaction(signed.rawTransaction);

  return receipt.transactionHash;
}

/**
 * Send BTC withdrawal (manual for now - requires Bitcoin wallet integration)
 */
async function sendBTCWithdrawal(withdrawal) {
  // Bitcoin sending requires additional setup (bitcoinjs-lib or similar)
  // For now, return manual flow
  throw new Error('BTC auto-sending not configured. Please process manually.');
}

/**
 * Process approved withdrawals (auto-send)
 */
async function processWithdrawals() {
  try {
    const [pending] = await db.execute(
      'SELECT * FROM withdrawals WHERE status = ? ORDER BY approved_at ASC LIMIT 10',
      ['approved']
    );

    for (const withdrawal of pending) {
      console.log(`📤 Processing withdrawal ${withdrawal.id}: ${withdrawal.amount_crypto} ${withdrawal.coin}`);

      try {
        // Mark as sending
        await db.execute(
          'UPDATE withdrawals SET status = ? WHERE id = ?',
          ['sending', withdrawal.id]
        );

        let txid;

        // Send based on coin type
        switch (withdrawal.coin) {
          case 'ETH':
            txid = await sendETHWithdrawal(withdrawal);
            break;
          case 'USDT':
            txid = await sendUSDTWithdrawal(withdrawal);
            break;
          case 'USDC':
            txid = await sendUSDCWithdrawal(withdrawal);
            break;
          case 'BTC':
            txid = await sendBTCWithdrawal(withdrawal);
            break;
          default:
            throw new Error(`Unsupported coin: ${withdrawal.coin}`);
        }

        // Mark as sent
        await db.execute(
          'UPDATE withdrawals SET status = ?, txid = ?, sent_at = NOW() WHERE id = ?',
          ['sent', txid, withdrawal.id]
        );

        // Deduct from locked balance and update main balance
        const totalUsd = parseFloat(withdrawal.amount_usd) + parseFloat(withdrawal.fee_usd);
        await db.execute(
          'UPDATE balances SET usd_balance = usd_balance - ?, locked_balance = locked_balance - ? WHERE user_id = ?',
          [totalUsd, totalUsd, withdrawal.user_id]
        );

        console.log(`✅ Withdrawal ${withdrawal.id} sent! TxID: ${txid}`);

      } catch (error) {
        console.error(`❌ Failed to send withdrawal ${withdrawal.id}:`, error.message);

        // Mark as failed
        await db.execute(
          'UPDATE withdrawals SET status = ? WHERE id = ?',
          ['failed', withdrawal.id]
        );

        // Optional: Unlock balance if you want to allow retry
        // For now, keep locked and require admin intervention
      }
    }

  } catch (error) {
    console.error('❌ Process withdrawals error:', error);
  }
}

/**
 * Get user withdrawal history
 */
async function getUserWithdrawals(userId, limit = 50) {
  const [rows] = await db.execute(
    `SELECT id, coin, amount_usd, amount_crypto, address, status, txid, 
            fee_usd, fee_crypto, created_at, approved_at, sent_at, rejected_reason
     FROM withdrawals 
     WHERE user_id = ? 
     ORDER BY created_at DESC 
     LIMIT ?`,
    [userId, limit]
  );

  return rows;
}

/**
 * Get pending withdrawals for admin
 */
async function getPendingWithdrawals() {
  const [rows] = await db.execute(
    `SELECT w.*, u.username, u.email 
     FROM withdrawals w 
     JOIN users u ON w.user_id = u.id 
     WHERE w.status = 'pending' 
     ORDER BY w.created_at ASC`
  );

  return rows;
}

/**
 * Start withdrawal handler
 */
async function startWithdrawalHandler() {
  console.log('🚀 Starting Withdrawal Handler...');

  await initDatabase();
  await fetchCryptoPrices();

  // Process approved withdrawals every 30 seconds
  setInterval(async () => {
    await processWithdrawals();
  }, 30000);

  // Update prices every 5 minutes
  setInterval(async () => {
    await fetchCryptoPrices();
  }, 300000);

  console.log('✅ Withdrawal Handler: All systems operational');
}

module.exports = {
  startWithdrawalHandler,
  requestWithdrawal,
  approveWithdrawal,
  rejectWithdrawal,
  getUserWithdrawals,
  getPendingWithdrawals,
  getUserBalance,
  fetchCryptoPrices,
  isValidAddress,
  MIN_WITHDRAW,
  WITHDRAW_FEES
};
