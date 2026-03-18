// backend/routes/deposits.js
// Production-safe deposit API endpoints
const express = require('express');
const { db } = require('../lib/db_mysql');
const { auth } = require('../middleware/auth');

const router = express.Router();

// GET /api/deposit/config?network=ethereum&asset=ETH
// Returns deposit configuration (min amount, confirmations, etc.)
router.get('/config', auth, async (req, res) => {
  try {
    const { network, asset } = req.query;
    
    if (!network || !asset) {
      return res.status(400).json({ error: 'Missing network or asset parameter' });
    }

    const rules = await db.getRules(network, asset);
    
    res.json({
      network,
      asset,
      minDisplay: rules.minDisplay,
      minAtomic: rules.minAtomic,
      decimals: rules.decimals,
      requiredConfirmations: rules.requiredConfirmations
    });
  } catch (error) {
    console.error('Get config error:', error);
    res.status(500).json({ error: error.message || 'Failed to get deposit config' });
  }
});

// GET /api/deposit/address?network=ethereum
// Returns user's deposit address for the specified network
router.get('/address', auth, async (req, res) => {
  try {
    const userId = req.user.id || req.user.userId;
    const { network } = req.query;
    
    if (!network) {
      return res.status(400).json({ error: 'Missing network parameter' });
    }

    let addresses = await db.getDepositAddressForUser(userId);
    
    // If user doesn't have addresses yet, generate them
    if (!addresses) {
      // Generate addresses (placeholder - you'll implement address generation)
      const btcAddress = await generateBTCAddress(userId);
      const evmAddress = await generateEVMAddress(userId);
      
      await db.createDepositAddresses(userId, btcAddress, evmAddress);
      addresses = { btcAddress, evmAddress };
    }

    const address = network === 'bitcoin' ? addresses.btcAddress : addresses.evmAddress;
    
    res.json({
      network,
      address,
      userId
    });
  } catch (error) {
    console.error('Get address error:', error);
    res.status(500).json({ error: error.message || 'Failed to get deposit address' });
  }
});

// GET /api/deposit/status?txHash=0x...&network=ethereum&asset=ETH
// Check status of a specific deposit transaction
router.get('/status', auth, async (req, res) => {
  try {
    const userId = req.user.id || req.user.userId;
    const { txHash, network, asset } = req.query;
    
    if (!txHash || !network || !asset) {
      return res.status(400).json({ error: 'Missing txHash, network, or asset parameter' });
    }

    const deposit = await db.getDepositByTx({ network, asset, txHash });
    
    if (!deposit) {
      return res.json({
        found: false,
        message: 'Transaction not yet detected. Please wait a moment and try again.'
      });
    }

    // Security: Only allow users to see their own deposits
    if (deposit.user_id !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const rules = await db.getRules(network, asset);
    
    res.json({
      found: true,
      txHash: deposit.tx_hash,
      asset: deposit.asset,
      network: deposit.network,
      amount: deposit.amount_atomic,
      decimals: deposit.decimals,
      amountDisplay: require('../lib/db_mysql').formatAtomic(deposit.amount_atomic, deposit.decimals, deposit.asset),
      confirmations: deposit.confirmations,
      required: deposit.required_confirmations,
      status: deposit.status,
      blockNumber: deposit.block_number,
      createdAt: deposit.created_at,
      updatedAt: deposit.updated_at
    });
  } catch (error) {
    console.error('Get status error:', error);
    res.status(500).json({ error: error.message || 'Failed to get deposit status' });
  }
});

// GET /api/deposit/recent?limit=10
// Get recent deposits for the authenticated user
router.get('/recent', auth, async (req, res) => {
  try {
    const userId = req.user.id || req.user.userId;
    const limit = Math.min(parseInt(req.query.limit) || 10, 100);
    
    const deposits = await db.listRecentDeposits(userId, limit);
    
    res.json({
      deposits: deposits.map(d => ({
        id: d.id,
        asset: d.asset,
        network: d.network,
        txHash: d.txHash,
        amount: d.amountDisplay,
        status: d.status,
        confirmations: d.confirmations,
        required: d.required,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt
      }))
    });
  } catch (error) {
    console.error('Get recent deposits error:', error);
    res.status(500).json({ error: error.message || 'Failed to get recent deposits' });
  }
});

// GET /api/deposit/balances
// Get all crypto balances for authenticated user
router.get('/balances', auth, async (req, res) => {
  try {
    const userId = req.user.id || req.user.userId;
    const balances = await db.getAllUserBalances(userId);
    
    // Get rules for each asset to format properly
    const formatted = await Promise.all(balances.map(async (b) => {
      const network = b.asset === 'BTC' ? 'bitcoin' : 'ethereum';
      const rules = await db.getRules(network, b.asset);
      
      return {
        asset: b.asset,
        available: require('../lib/db_mysql').formatAtomic(b.availableAtomic, rules.decimals, b.asset),
        locked: require('../lib/db_mysql').formatAtomic(b.lockedAtomic, rules.decimals, b.asset),
        availableAtomic: b.availableAtomic,
        lockedAtomic: b.lockedAtomic
      };
    }));
    
    // Add zeros for assets user doesn't have
    const allAssets = ['BTC', 'ETH', 'USDT', 'USDC'];
    const result = allAssets.map(asset => {
      const existing = formatted.find(b => b.asset === asset);
      if (existing) return existing;
      
      return {
        asset,
        available: `0 ${asset}`,
        locked: `0 ${asset}`,
        availableAtomic: 0,
        lockedAtomic: 0
      };
    });
    
    res.json({ balances: result });
  } catch (error) {
    console.error('Get balances error:', error);
    res.status(500).json({ error: error.message || 'Failed to get balances' });
  }
});

// ============================================================================
// ADDRESS GENERATION HELPERS (PLACEHOLDER - IMPLEMENT BASED ON YOUR NEEDS)
// ============================================================================

// Placeholder BTC address generation
// TODO: Implement HD wallet derivation or use a custody provider
async function generateBTCAddress(userId) {
  // Option 1: HD wallet derivation from xpub (recommended)
  // Option 2: Use custody API (Coinbase Commerce, BTCPay, etc.)
  // Option 3: Generate random address (NOT RECOMMENDED - requires storing private keys)
  
  // For now, return a placeholder (you MUST replace this)
  console.warn(`⚠️ Generated placeholder BTC address for user ${userId} - IMPLEMENT REAL ADDRESS GENERATION`);
  return `bc1q_placeholder_${userId}_${Date.now()}`;
}

// Placeholder EVM address generation
// TODO: Implement HD wallet derivation or use a custody provider
async function generateEVMAddress(userId) {
  // Option 1: HD wallet derivation from xpub
  // Option 2: Use custody API
  // Option 3: Generate random address (NOT RECOMMENDED - requires storing private keys)
  
  // For now, return a placeholder (you MUST replace this)
  console.warn(`⚠️ Generated placeholder EVM address for user ${userId} - IMPLEMENT REAL ADDRESS GENERATION`);
  return `0x_placeholder_${userId}_${Date.now()}`;
}

module.exports = router;
