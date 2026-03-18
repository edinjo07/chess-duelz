// backend/watchers/eth.js
// Ethereum watcher for ETH, USDT, USDC deposits (CommonJS)
const { ethers } = require('ethers');
const { db } = require('../lib/db_mysql');

// ERC20 token contracts on Ethereum mainnet
const USDT_CONTRACT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const USDC_CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

// ERC20 Transfer event signature
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

let provider;
let isRunning = false;
let lastProcessedBlock = 0;

async function runEthWatcher({ rpcUrl, confirmationsRequired = 12, pollInterval = 15000 }) {
  if (!rpcUrl) {
    console.error('❌ ETH_RPC_URL not set. Cannot start ETH watcher.');
    console.error('Get a free RPC URL from https://www.alchemy.com or https://www.infura.io');
    return;
  }

  console.log('🔷 Starting Ethereum watcher...');
  console.log(`RPC: ${rpcUrl.substring(0, 50)}...`);
  console.log(`Confirmations required: ${confirmationsRequired}`);

  provider = new ethers.JsonRpcProvider(rpcUrl);
  isRunning = true;

  // Get current block
  try {
    const currentBlock = await provider.getBlockNumber();
    lastProcessedBlock = currentBlock - 100; // Start from 100 blocks ago
    console.log(`✅ Connected to Ethereum. Current block: ${currentBlock}`);
    console.log(`Starting scan from block: ${lastProcessedBlock}`);
  } catch (error) {
    console.error('❌ Failed to connect to Ethereum RPC:', error.message);
    return;
  }

  // Main loop
  while (isRunning) {
    try {
      await scanNewBlocks(confirmationsRequired);
    } catch (error) {
      console.error('ETH watcher error:', error.message);
    }

    await sleep(pollInterval);
  }
}

async function scanNewBlocks(confirmationsRequired) {
  const currentBlock = await provider.getBlockNumber();
  const confirmedBlock = currentBlock - confirmationsRequired;

  if (lastProcessedBlock >= confirmedBlock) {
    // Nothing new to process
    return;
  }

  // Get all deposit addresses
  const addresses = await db.listDepositAddressesByNetwork('ethereum');
  if (addresses.length === 0) {
    console.log('No Ethereum deposit addresses yet');
    return;
  }

  const addressMap = new Map();
  addresses.forEach(a => addressMap.set(a.address.toLowerCase(), a.userId));

  console.log(`Scanning blocks ${lastProcessedBlock + 1} to ${confirmedBlock} for ${addresses.length} addresses...`);

  // Scan ETH transfers
  await scanETHTransfers(lastProcessedBlock + 1, confirmedBlock, addressMap, currentBlock);

  // Scan USDT transfers
  await scanERC20Transfers(lastProcessedBlock + 1, confirmedBlock, addressMap, currentBlock, 'USDT', USDT_CONTRACT);

  // Scan USDC transfers
  await scanERC20Transfers(lastProcessedBlock + 1, confirmedBlock, addressMap, currentBlock, 'USDC', USDC_CONTRACT);

  lastProcessedBlock = confirmedBlock;
}

async function scanETHTransfers(fromBlock, toBlock, addressMap, currentBlock) {
  const addressList = Array.from(addressMap.keys());

  // Fetch blocks in batches
  const batchSize = 10;
  for (let i = fromBlock; i <= toBlock; i += batchSize) {
    const endBlock = Math.min(i + batchSize - 1, toBlock);

    try {
      // Get all transactions in this range
      for (let blockNum = i; blockNum <= endBlock; blockNum++) {
        const block = await provider.getBlock(blockNum, true);
        if (!block || !block.transactions) continue;

        for (const tx of block.transactions) {
          if (!tx.to) continue;
          const toAddress = tx.to.toLowerCase();

          if (addressMap.has(toAddress) && tx.value > 0n) {
            const userId = addressMap.get(toAddress);
            const amountWei = tx.value.toString();
            const confirmations = currentBlock - blockNum;

            console.log(`💰 ETH deposit detected: ${ethers.formatEther(amountWei)} ETH to user ${userId} (tx: ${tx.hash})`);

            // Insert/update deposit
            await db.upsertDepositSeen({
              userId,
              network: 'ethereum',
              asset: 'ETH',
              address: toAddress,
              txHash: tx.hash,
              amountAtomic: amountWei,
              decimals: 18,
              blockNumber: blockNum
            });

            // Update confirmations
            const status = confirmations >= 12 ? 'confirmed' : 'pending';
            await db.updateDepositConfirmations({
              network: 'ethereum',
              txHash: tx.hash,
              confirmations,
              blockNumber: blockNum,
              status
            });

            // Credit if confirmed
            if (status === 'confirmed') {
              const deposit = await db.getDepositByTx({ network: 'ethereum', asset: 'ETH', txHash: tx.hash });
              if (deposit && deposit.status !== 'credited') {
                await db.creditDepositAtomic({
                  depositId: deposit.id,
                  userId: deposit.user_id,
                  asset: 'ETH',
                  amountAtomic: deposit.amount_atomic
                });
              }
            }
          }
        }
      }
    } catch (error) {
      console.error(`Error scanning ETH blocks ${i}-${endBlock}:`, error.message);
    }
  }
}

async function scanERC20Transfers(fromBlock, toBlock, addressMap, currentBlock, asset, contractAddress) {
  const addressList = Array.from(addressMap.keys());

  try {
    // Get logs for Transfer events to our addresses
    const logs = await provider.getLogs({
      address: contractAddress,
      fromBlock,
      toBlock,
      topics: [
        TRANSFER_TOPIC,
        null, // from (any)
        addressList.map(addr => ethers.zeroPadValue(addr, 32)) // to (our addresses)
      ]
    });

    for (const log of logs) {
      const toAddress = ethers.getAddress('0x' + log.topics[2].slice(26)).toLowerCase();
      if (!addressMap.has(toAddress)) continue;

      const userId = addressMap.get(toAddress);
      const amount = BigInt(log.data);
      const decimals = asset === 'USDT' || asset === 'USDC' ? 6 : 18;
      const confirmations = currentBlock - log.blockNumber;

      console.log(`💰 ${asset} deposit detected: ${amount / BigInt(10 ** decimals)} ${asset} to user ${userId} (tx: ${log.transactionHash})`);

      // Insert/update deposit
      await db.upsertDepositSeen({
        userId,
        network: 'ethereum',
        asset,
        address: toAddress,
        txHash: log.transactionHash,
        amountAtomic: amount.toString(),
        decimals,
        blockNumber: log.blockNumber
      });

      // Update confirmations
      const status = confirmations >= 12 ? 'confirmed' : 'pending';
      await db.updateDepositConfirmations({
        network: 'ethereum',
        txHash: log.transactionHash,
        confirmations,
        blockNumber: log.blockNumber,
        status
      });

      // Credit if confirmed
      if (status === 'confirmed') {
        const deposit = await db.getDepositByTx({ network: 'ethereum', asset, txHash: log.transactionHash });
        if (deposit && deposit.status !== 'credited') {
          await db.creditDepositAtomic({
            depositId: deposit.id,
            userId: deposit.user_id,
            asset,
            amountAtomic: deposit.amount_atomic
          });
        }
      }
    }
  } catch (error) {
    console.error(`Error scanning ${asset} transfers:`, error.message);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function stopEthWatcher() {
  console.log('Stopping Ethereum watcher...');
  isRunning = false;
}

module.exports = { runEthWatcher, stopEthWatcher };
