// backend/watchers/btc.js
// Bitcoin watcher using mempool.space API (CommonJS)
const axios = require('axios');
const { db } = require('../lib/db_mysql');

let isRunning = false;
const processedTxs = new Set(); // Track already processed txs

async function runBtcWatcher({ apiBase = 'https://mempool.space/api', confirmationsRequired = 2, pollInterval = 30000 }) {
  console.log('₿  Starting Bitcoin watcher...');
  console.log(`API: ${apiBase}`);
  console.log(`Confirmations required: ${confirmationsRequired}`);

  isRunning = true;

  while (isRunning) {
    try {
      await scanBitcoinDeposits(apiBase, confirmationsRequired);
    } catch (error) {
      console.error('BTC watcher error:', error.message);
    }

    await sleep(pollInterval);
  }
}

async function scanBitcoinDeposits(apiBase, confirmationsRequired) {
  // Get all Bitcoin deposit addresses
  const addresses = await db.listDepositAddressesByNetwork('bitcoin');
  
  if (addresses.length === 0) {
    console.log('No Bitcoin deposit addresses yet');
    return;
  }

  console.log(`Checking ${addresses.length} Bitcoin addresses...`);

  // Get current block height for confirmation calculations
  const blockHeight = await getCurrentBlockHeight(apiBase);

  for (const { userId, address } of addresses) {
    try {
      // Get transactions for this address
      const txs = await getAddressTransactions(apiBase, address);

      for (const tx of txs) {
        // Skip if already processed
        const txKey = `${tx.txid}:${address}`;
        if (processedTxs.has(txKey) && tx.status.confirmed) {
          continue;
        }

        // Find outputs paying to our address
        const matchingOutputs = tx.vout.filter(vout => 
          vout.scriptpubkey_address === address
        );

        for (const output of matchingOutputs) {
          const amountSatoshis = output.value;

          if (amountSatoshis === 0) continue;

          console.log(`₿ BTC deposit detected: ${amountSatoshis / 100000000} BTC to user ${userId} (tx: ${tx.txid})`);

          // Insert/update deposit
          await db.upsertDepositSeen({
            userId,
            network: 'bitcoin',
            asset: 'BTC',
            address,
            txHash: tx.txid,
            amountAtomic: String(amountSatoshis),
            decimals: 8,
            blockNumber: tx.status.block_height || null
          });

          // Calculate confirmations
          const confirmations = tx.status.confirmed 
            ? (blockHeight - tx.status.block_height + 1)
            : 0;

          const status = confirmations >= confirmationsRequired ? 'confirmed' : 'pending';

          // Update confirmations
          await db.updateDepositConfirmations({
            network: 'bitcoin',
            txHash: tx.txid,
            confirmations,
            blockNumber: tx.status.block_height,
            status
          });

          // Credit if confirmed
          if (status === 'confirmed') {
            const deposit = await db.getDepositByTx({ network: 'bitcoin', asset: 'BTC', txHash: tx.txid });
            if (deposit && deposit.status !== 'credited') {
              await db.creditDepositAtomic({
                depositId: deposit.id,
                userId: deposit.user_id,
                asset: 'BTC',
                amountAtomic: deposit.amount_atomic
              });
              
              // Mark as processed
              processedTxs.add(txKey);
            }
          }
        }
      }
    } catch (error) {
      console.error(`Error checking BTC address ${address}:`, error.message);
    }
  }
}

async function getCurrentBlockHeight(apiBase) {
  try {
    const response = await axios.get(`${apiBase}/blocks/tip/height`);
    return response.data;
  } catch (error) {
    console.error('Error getting block height:', error.message);
    return 0;
  }
}

async function getAddressTransactions(apiBase, address) {
  try {
    const response = await axios.get(`${apiBase}/address/${address}/txs`);
    return response.data.slice(0, 50); // Last 50 transactions
  } catch (error) {
    if (error.response?.status === 404) {
      // Address has no transactions yet
      return [];
    }
    throw error;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function stopBtcWatcher() {
  console.log('Stopping Bitcoin watcher...');
  isRunning = false;
}

module.exports = { runBtcWatcher, stopBtcWatcher };


export async function runBtcWatcher({ apiBase, confirmationsRequired }) {
  console.log("[BTC] watcher using", apiBase);

  async function loadAddressMap() {
    const rows = await db.listDepositAddressesByNetwork("bitcoin");
    const map = new Map();
    for (const r of rows) map.set(r.address, r.userId);
    return map;
  }

  let addrMap = await loadAddressMap();
  let lastReload = Date.now();

  while (true) {
    try {
      if (Date.now() - lastReload > 60_000) {
        addrMap = await loadAddressMap();
        lastReload = Date.now();
      }

      // For each address, check recent txs (simple MVP).
      // Scale-up option: run your own node/indexer or batch APIs.
      for (const [address, userId] of addrMap.entries()) {
        const url = `${apiBase}/address/${address}/txs`;
        const txs = await fetchJson(url);

        for (const tx of txs.slice(0, 10)) {
          // Identify outputs paying to this address
          const vouts = tx.vout || [];
          const matchedOuts = vouts.filter(v => v.scriptpubkey_address === address);

          for (const out of matchedOuts) {
            const sats = String(out.value); // mempool uses sats
            await db.upsertDepositSeen({
              userId,
              network: "bitcoin",
              asset: "BTC",
              address,
              txHash: tx.txid,
              amountAtomic: sats,
              decimals: 8,
              seenAt: new Date(),
              blockNumber: tx.status?.block_height || null
            });

            // confirmations calc
            const confs = tx.status?.confirmed
              ? await estimateBtcConfirmations(apiBase, tx.status.block_height)
              : 0;

            const status = confs >= confirmationsRequired ? "confirmed" : "pending";
            await db.updateDepositConfirmations({
              network: "bitcoin",
              txHash: tx.txid,
              confirmations: confs,
              blockNumber: tx.status?.block_height || null,
              status
            });

            if (status === "confirmed") {
              // Credit idempotently
              const dep = await db.getDepositByTx({ network: "bitcoin", asset: "BTC", txHash: tx.txid });
              if (dep && dep.status !== "credited") {
                await db.creditDepositAtomic({ depositId: dep.id, userId, asset: "BTC", amountAtomic: sats });
              }
            }
          }
        }
      }

      await sleep(7000);
    } catch (err) {
      console.error("[BTC] watcher error", err);
      await sleep(10_000);
    }
  }
}

async function estimateBtcConfirmations(apiBase, blockHeight) {
  // confirmations = tipHeight - blockHeight + 1
  const tip = await fetchJson(`${apiBase}/blocks/tip/height`);
  return Math.max(0, Number(tip) - Number(blockHeight) + 1);
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
