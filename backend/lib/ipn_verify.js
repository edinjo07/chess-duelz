// backend/lib/ipn_verify.js
// NOWPayments IPN signature verification (CommonJS)

const crypto = require('crypto');

/**
 * Verifies NOWPayments IPN signature header: x-nowpayments-sig
 * 
 * NOWPayments signs webhook payloads using HMAC-SHA512.
 * The signature is computed over the JSON body with keys sorted alphabetically.
 * 
 * @param {Object} req - Express request object
 * @param {Object} req.headers - Request headers
 * @param {string} req.headers['x-nowpayments-sig'] - HMAC signature from NOWPayments
 * @param {Object} req.body - Parsed JSON body
 * @returns {boolean} True if signature is valid, false otherwise
 */
function verifyNowPaymentsIPN(req) {
  try {
    const sig = req.headers["x-nowpayments-sig"];
    if (!sig) {
      console.warn("[IPN] Missing x-nowpayments-sig header");
      return false;
    }

    const secret = process.env.NOWPAYMENTS_IPN_SECRET;
    if (!secret) {
      console.error("[IPN] NOWPAYMENTS_IPN_SECRET environment variable not set");
      throw new Error("Missing NOWPAYMENTS_IPN_SECRET");
    }

    // NOWPayments requires keys to be sorted alphabetically
    const sortedBody = JSON.stringify(req.body, Object.keys(req.body).sort());

    // Compute HMAC-SHA512
    const hmac = crypto
      .createHmac("sha512", secret)
      .update(sortedBody)
      .digest("hex");

    const isValid = hmac === sig;
    
    if (!isValid) {
      console.warn("[IPN] Signature verification failed");
      console.debug("[IPN] Expected:", hmac);
      console.debug("[IPN] Received:", sig);
    }

    return isValid;
  } catch (error) {
    console.error("[IPN] Verification error:", error);
    return false;
  }
}

/**
 * Validates NOWPayments webhook payload structure
 * @param {Object} body - Webhook payload
 * @returns {boolean} True if payload has required fields
 */
function validateIPNPayload(body) {
  if (!body || typeof body !== 'object') {
    console.warn("[IPN] Invalid payload: not an object");
    return false;
  }

  const required = ['payment_id', 'payment_status', 'pay_currency'];
  const missing = required.filter(field => !body[field]);
  
  if (missing.length > 0) {
    console.warn("[IPN] Missing required fields:", missing);
    return false;
  }

  return true;
}

module.exports = {
  verifyNowPaymentsIPN,
  validateIPNPayload
};
