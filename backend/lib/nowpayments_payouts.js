// backend/lib/nowpayments_payouts.js
// NOWPayments Mass Payouts API client with 2FA verification (CommonJS)

const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY;
const NOWPAYMENTS_BASE_URL = process.env.NOWPAYMENTS_MASS_BASE_URL || 'https://api.nowpayments.io/v1';
const NOWPAYMENTS_2FA_SECRET = process.env.NOWPAYMENTS_2FA_SECRET;

/**
 * Generate TOTP code for 2FA verification
 * @returns {string} 6-digit TOTP code
 */
function generateTOTP() {
  if (!NOWPAYMENTS_2FA_SECRET) {
    throw new Error('NOWPAYMENTS_2FA_SECRET not configured');
  }
  
  const crypto = require('crypto');
  const base32 = require('base32.js');
  
  // Decode base32 secret
  const decoder = new base32.Decoder({ type: 'rfc4648' });
  const key = Buffer.from(decoder.write(NOWPAYMENTS_2FA_SECRET).finalize());
  
  // Get current time step (30 seconds)
  const epoch = Math.floor(Date.now() / 1000);
  const timeStep = Math.floor(epoch / 30);
  
  // Create HMAC
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeBigUInt64BE(BigInt(timeStep));
  const hmac = crypto.createHmac('sha1', key).update(buffer).digest();
  
  // Extract dynamic binary code
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = (
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  ) % 1000000;
  
  return String(code).padStart(6, '0');
}

/**
 * Validate a cryptocurrency address
 * @param {string} currency - Currency code (btc, eth, usdterc20, etc.)
 * @param {string} address - Address to validate
 * @returns {Promise<{valid: boolean, message?: string}>}
 */
async function validateAddress(currency, address) {
  try {
    const response = await fetch(
      `${NOWPAYMENTS_BASE_URL}/payout/validate-address`,
      {
        method: 'POST',
        headers: {
          'x-api-key': NOWPAYMENTS_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          currency: currency.toLowerCase(),
          address,
        }),
      }
    );

    const data = await response.json();
    
    if (!response.ok) {
      return { valid: false, message: data.message || 'Invalid address' };
    }

    return { valid: true };
  } catch (error) {
    console.error('[Payout] Address validation error:', error);
    return { valid: false, message: error.message };
  }
}

/**
 * Get estimated withdrawal fee
 * @param {string} currency - Currency code
 * @param {number} amount - Amount to withdraw
 * @returns {Promise<{fee: number, total: number}>}
 */
async function getWithdrawalFee(currency, amount) {
  try {
    const response = await fetch(
      `${NOWPAYMENTS_BASE_URL}/payout/fee?currency=${currency.toLowerCase()}&amount=${amount}`,
      {
        method: 'GET',
        headers: {
          'x-api-key': NOWPAYMENTS_API_KEY,
        },
      }
    );

    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.message || 'Failed to get fee');
    }

    return {
      fee: parseFloat(data.fee || 0),
      total: parseFloat(data.total || amount),
    };
  } catch (error) {
    console.error('[Payout] Fee estimation error:', error);
    // Return default fee if API fails
    return { fee: 0, total: amount };
  }
}

/**
 * Create a payout (withdrawal) via NOWPayments Mass Payouts
 * @param {Object} params - Payout parameters
 * @param {Array} params.withdrawals - Array of withdrawal objects
 * @param {string} params.withdrawals[].address - Recipient address
 * @param {string} params.withdrawals[].currency - Currency code (btc, eth, usdterc20, etc.)
 * @param {string} params.withdrawals[].amount - Amount as decimal string
 * @param {string} params.withdrawals[].extraId - Internal tracking ID
 * @returns {Promise<Object>} Payout response with id
 */
async function createPayout(params) {
  const { withdrawals } = params;

  try {
    const response = await fetch(`${NOWPAYMENTS_BASE_URL}/payout`, {
      method: 'POST',
      headers: {
        'x-api-key': NOWPAYMENTS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        withdrawals: withdrawals.map(w => ({
          address: w.address,
          currency: w.currency.toLowerCase(),
          amount: w.amount,
          extra_id: w.extraId || w.withdrawalId,
        })),
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || `NOWPayments API error: ${response.status}`);
    }

    console.log('[Payout] Created:', data);
    return data; // Returns { id, batch_withdrawal_id, withdrawals: [...] }
  } catch (error) {
    console.error('[Payout] Create error:', error);
    throw error;
  }
}

/**
 * Verify payout with 2FA code
 * @param {Object} params - Verification parameters
 * @param {string} params.id - Payout ID to verify
 * @param {string} params.code - 2FA code (optional, auto-generated if not provided)
 * @returns {Promise<Object>} Verification response
 */
async function verifyPayout(params) {
  const { id, code } = params;
  
  try {
    // Generate TOTP code if not provided
    const verificationCode = code || generateTOTP();
    
    const response = await fetch(`${NOWPAYMENTS_BASE_URL}/payout/verify`, {
      method: 'POST',
      headers: {
        'x-api-key': NOWPAYMENTS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        id,
        code: verificationCode,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || `Verification failed: ${response.status}`);
    }

    console.log('[Payout] Verified:', data);
    return data;
  } catch (error) {
    console.error('[Payout] Verify error:', error);
    throw error;
  }
}

/**
 * Get payout status
 * @param {string} payoutId - NOWPayments payout ID
 * @returns {Promise<Object>} Payout status
 */
async function getPayoutStatus(payoutId) {
  try {
    const response = await fetch(
      `${NOWPAYMENTS_BASE_URL}/payout/${payoutId}`,
      {
        method: 'GET',
        headers: {
          'x-api-key': NOWPAYMENTS_API_KEY,
        },
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || 'Failed to get payout status');
    }

    return data;
  } catch (error) {
    console.error('[Payout] Status check error:', error);
    throw error;
  }
}

module.exports = {
  validateAddress,
  getWithdrawalFee,
  createPayout,
  verifyPayout,
  getPayoutStatus,
  generateTOTP,
};
