// backend/routes/nowpayments_ipn.js
// NOWPayments IPN webhook handler (CommonJS)

const express = require('express');
const { pool, creditOnce, decimalsFor } = require('../lib/mysql_pool');
const { verifyNowPaymentsIPN, validateIPNPayload } = require('../lib/ipn_verify');

const nowpRouter = express.Router();

/**
 * Map NOWPayments currency code to internal asset code
 * @param {string} payCurrency - NOWPayments currency code (e.g., "btc", "eth", "usdterc20")
 * @returns {string|null} Internal asset code (BTC, ETH, USDT, USDC) or null
 */
function assetFromPayCurrency(payCurrency) {
  const currency = String(payCurrency).toLowerCase();
  
  if (currency === 'btc') return 'BTC';
  if (currency === 'eth') return 'ETH';
  
  // Handle various USDT network variants
  if (currency.startsWith('usdt')) return 'USDT';
  
  // Handle various USDC network variants
  if (currency.startsWith('usdc')) return 'USDC';
  
  return null;
}

/**
 * Convert decimal string to atomic integer string without float precision loss
 * @param {string|number} amountStr - Decimal amount as string
 * @param {number} decimals - Number of decimal places
 * @returns {string} Atomic amount as string
 * 
 * Example: toAtomic("0.00123456", 8) => "123456"
 */
function toAtomic(amountStr, decimals) {
  const str = String(amountStr);
  const [whole = '0', frac = ''] = str.split('.');
  
  // Pad or trim fractional part to exact decimal places
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  
  // Combine and remove leading zeros
  const atomic = (whole.replace(/^0+(?=\d)/, '') || '0') + fracPadded;
  return atomic.replace(/^0+(?=\d)/, '') || '0';
}

/**
 * POST /api/nowpayments/ipn
 * Webhook endpoint for NOWPayments IPN notifications
 * 
 * This endpoint receives payment status updates from NOWPayments.
 * It verifies the signature, validates the payload, and credits user balance
 * when payment reaches 'finished' status.
 * 
 * NOWPayments Payment Statuses:
 * - waiting: Payment created, waiting for customer to send crypto
 * - confirming: Transaction detected, waiting for confirmations
 * - confirmed: Transaction confirmed
 * - sending: NOWPayments is sending funds to your wallet
 * - finished: Payment completed successfully
 * - failed: Payment failed
 * - refunded: Payment was refunded
 * - expired: Payment expired (customer didn't send within time limit)
 * - partially_paid: Customer sent less than required amount
 */
nowpRouter.post('/ipn', express.json(), async (req, res) => {
  try {
    console.log('[IPN] Received webhook:', JSON.stringify(req.body, null, 2));

    // Step 1: Verify HMAC signature
    if (!verifyNowPaymentsIPN(req)) {
      console.error('[IPN] Invalid signature, rejecting webhook');
      return res.status(401).send('invalid signature');
    }

    // Step 2: Validate payload structure
    if (!validateIPNPayload(req.body)) {
      console.error('[IPN] Invalid payload structure');
      return res.status(400).send('invalid payload');
    }

    // Step 3: Extract payment data
    const paymentId = Number(req.body.payment_id);
    if (!Number.isFinite(paymentId)) {
      console.error('[IPN] Invalid payment_id:', req.body.payment_id);
      return res.status(400).send('bad payment_id');
    }

    const payCurrency = req.body.pay_currency;
    const paymentStatus = req.body.payment_status;

    console.log(`[IPN] Processing payment ${paymentId}, status: ${paymentStatus}`);

    // Step 4: Find matching deposit intent
    const [intents] = await pool.query(
      `SELECT user_id AS userId, status
       FROM deposit_intents
       WHERE provider = 'nowpayments' AND payment_id = ? LIMIT 1`,
      [paymentId]
    );

    if (!intents[0]) {
      console.warn(`[IPN] Payment ${paymentId} not found in database`);
      return res.status(200).send('ok'); // Return 200 to avoid webhook retry
    }

    // Step 5: Update cached payment status
    await pool.query(
      `UPDATE deposit_intents
       SET status = ?, 
           pay_address = COALESCE(?, pay_address), 
           pay_amount = COALESCE(?, pay_amount)
       WHERE provider = 'nowpayments' AND payment_id = ?`,
      [
        paymentStatus, 
        req.body.pay_address || null, 
        req.body.pay_amount || null, 
        paymentId
      ]
    );

    console.log(`[IPN] Updated payment ${paymentId} status to ${paymentStatus}`);

    // Step 6: Credit balance only on successful completion
    // In NOWPayments, 'finished' is the final successful state
    if (paymentStatus === 'finished') {
      const asset = assetFromPayCurrency(payCurrency);
      
      if (!asset) {
        console.warn(`[IPN] Unknown currency ${payCurrency}, skipping credit`);
        return res.status(200).send('ok');
      }

      // Use actually_paid if available (actual amount received), otherwise pay_amount (expected amount)
      const amount = req.body.actually_paid || req.body.pay_amount;
      
      if (!amount) {
        console.warn(`[IPN] No amount found for payment ${paymentId}`);
        return res.status(200).send('ok');
      }

      // Convert to atomic units (prevents floating point precision issues)
      const decimals = decimalsFor(asset);
      const atomic = toAtomic(amount, decimals);

      console.log(`[IPN] Crediting ${amount} ${asset} (${atomic} atomic units) to user ${intents[0].userId}`);

      // Atomic credit with idempotency (prevents double-credit)
      const credited = await creditOnce({
        paymentId,
        userId: intents[0].userId,
        asset,
        atomicAmount: atomic
      });

      if (credited) {
        console.log(`[IPN] ✓ Successfully credited payment ${paymentId}`);
      } else {
        console.log(`[IPN] ⊘ Payment ${paymentId} already credited (idempotent)`);
      }
    }

    // Always return 200 OK to NOWPayments (prevents webhook retry)
    res.status(200).send('ok');
    
  } catch (error) {
    console.error('[IPN] Error processing webhook:', error);
    // Still return 200 to prevent webhook retry on our internal errors
    res.status(200).send('error');
  }
});

/**
 * GET /api/nowpayments/health
 * Health check endpoint
 */
nowpRouter.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'nowpayments-ipn',
    timestamp: new Date().toISOString()
  });
});

module.exports = nowpRouter;
