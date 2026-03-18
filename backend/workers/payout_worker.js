// backend/workers/payout_worker.js
// Worker to poll NOWPayments payout status and finalize withdrawals (CommonJS)

const { pool, atomicToDecimal, decimalsFor } = require('../lib/mysql_pool');
const { getPayoutStatus } = require('../lib/nowpayments_payouts');

// Poll interval in milliseconds (30 seconds)
const POLL_INTERVAL = 30 * 1000;

let isRunning = false;
let workerInterval = null;

/**
 * Finalize withdrawal (complete or fail)
 */
async function finalizeWithdrawal(withdrawalId, finalStatus) {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const [rows] = await connection.query(
      `SELECT * FROM withdrawals WHERE id = ? FOR UPDATE`,
      [withdrawalId]
    );
    
    if (rows.length === 0) {
      await connection.rollback();
      return;
    }
    
    const withdrawal = rows[0];
    
    // Skip if already finalized
    if (['completed', 'failed', 'rejected', 'canceled'].includes(withdrawal.status)) {
      await connection.rollback();
      return;
    }
    
    const totalAtomic = BigInt(withdrawal.amount_atomic) + BigInt(withdrawal.fee_atomic);
    
    if (finalStatus === 'completed') {
      // Deduct from locked balance
      await connection.query(
        `UPDATE balances 
         SET locked_atomic = locked_atomic - ?
         WHERE user_id = ? AND asset = ?`,
        [totalAtomic.toString(), withdrawal.user_id, withdrawal.asset]
      );
      
      await connection.query(
        `UPDATE withdrawals 
         SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [withdrawalId]
      );
      
      console.log(`[Worker] Withdrawal ${withdrawalId} completed, ${atomicToDecimal(totalAtomic.toString(), decimalsFor(withdrawal.asset))} ${withdrawal.asset} deducted`);
      
    } else if (finalStatus === 'failed') {
      // Unlock funds back to available
      await connection.query(
        `UPDATE balances 
         SET locked_atomic = locked_atomic - ?,
             available_atomic = available_atomic + ?
         WHERE user_id = ? AND asset = ?`,
        [totalAtomic.toString(), totalAtomic.toString(), withdrawal.user_id, withdrawal.asset]
      );
      
      await connection.query(
        `UPDATE withdrawals 
         SET status = 'failed', updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [withdrawalId]
      );
      
      console.log(`[Worker] Withdrawal ${withdrawalId} failed, ${atomicToDecimal(totalAtomic.toString(), decimalsFor(withdrawal.asset))} ${withdrawal.asset} unlocked`);
    }
    
    await connection.commit();
    
  } catch (error) {
    await connection.rollback();
    console.error(`[Worker] Finalize error for withdrawal ${withdrawalId}:`, error);
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Poll payout statuses and update withdrawals
 */
async function payoutWorkerTick() {
  if (isRunning) {
    return; // Prevent concurrent execution
  }
  
  isRunning = true;
  
  try {
    // Get withdrawals in intermediate states
    const [rows] = await pool.query(
      `SELECT id, user_id, asset, amount_atomic, fee_atomic, provider_payout_id, status
       FROM withdrawals
       WHERE status IN ('verifying', 'processing')
         AND provider_payout_id IS NOT NULL
       ORDER BY created_at ASC
       LIMIT 50`
    );
    
    if (rows.length === 0) {
      isRunning = false;
      return;
    }
    
    console.log(`[Worker] Checking ${rows.length} pending withdrawals`);
    
    for (const withdrawal of rows) {
      try {
        // Get payout status from NOWPayments
        const payoutInfo = await getPayoutStatus(withdrawal.provider_payout_id);
        
        console.log(`[Worker] Withdrawal ${withdrawal.id}, payout ${withdrawal.provider_payout_id}: ${payoutInfo.status}`);
        
        // Map NOWPayments statuses to actions
        if (payoutInfo.status === 'finished' || payoutInfo.status === 'success' || payoutInfo.status === 'completed') {
          // Payout successful
          await finalizeWithdrawal(withdrawal.id, 'completed');
          
        } else if (payoutInfo.status === 'failed' || payoutInfo.status === 'rejected' || payoutInfo.status === 'expired' || payoutInfo.status === 'error') {
          // Payout failed
          await finalizeWithdrawal(withdrawal.id, 'failed');
          
        } else if (payoutInfo.status === 'processing' || payoutInfo.status === 'sending' || payoutInfo.status === 'waiting') {
          // Still processing - update status if needed
          if (withdrawal.status !== 'processing') {
            await pool.query(
              `UPDATE withdrawals SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
              [withdrawal.id]
            );
          }
        }
        
        // Add small delay between API calls to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
        
      } catch (error) {
        console.error(`[Worker] Error checking withdrawal ${withdrawal.id}:`, error);
        // Continue with next withdrawal
      }
    }
    
  } catch (error) {
    console.error('[Worker] Payout worker error:', error);
  } finally {
    isRunning = false;
  }
}

/**
 * Start the payout worker
 */
function startPayoutWorker() {
  if (workerInterval) {
    console.log('[Worker] Payout worker already running');
    return;
  }
  
  console.log('[Worker] Starting payout worker...');
  
  // Run immediately
  payoutWorkerTick().catch(err => {
    console.error('[Worker] Initial tick error:', err);
  });
  
  // Then run every POLL_INTERVAL
  workerInterval = setInterval(() => {
    payoutWorkerTick().catch(err => {
      console.error('[Worker] Tick error:', err);
    });
  }, POLL_INTERVAL);
  
  console.log(`[Worker] Payout worker started (polling every ${POLL_INTERVAL / 1000}s)`);
}

/**
 * Stop the payout worker
 */
function stopPayoutWorker() {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
    console.log('[Worker] Payout worker stopped');
  }
}

module.exports = {
  startPayoutWorker,
  stopPayoutWorker,
  payoutWorkerTick, // Export for manual triggering
};
