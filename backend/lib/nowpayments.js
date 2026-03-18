// backend/lib/nowpayments.js
// NOWPayments API integration (CommonJS)

const BASE = process.env.NOWPAYMENTS_BASE_URL || "https://api.nowpayments.io";

/**
 * Create a new payment with NOWPayments
 * @param {Object} body - Payment parameters
 * @param {number} body.price_amount - Amount in fiat (USD)
 * @param {string} body.price_currency - Fiat currency (e.g., "usd")
 * @param {string} body.pay_currency - Crypto currency (e.g., "btc", "eth", "usdt")
 * @param {string} body.ipn_callback_url - Webhook URL for payment notifications
 * @param {string} body.order_id - Unique order identifier
 * @param {string} body.order_description - Payment description
 * @returns {Promise<Object>} Payment object from NOWPayments
 */
async function nowpCreatePayment(body) {
  const apiKey = process.env.NOWPAYMENTS_API_KEY;
  if (!apiKey) {
    throw new Error("NOWPAYMENTS_API_KEY environment variable not set");
  }

  const response = await fetch(`${BASE}/v1/payment`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = await response.json().catch(() => ({}));
  
  if (!response.ok) {
    console.error("[NOWPayments] Create payment failed:", response.status, json);
    throw new Error(`NOWPayments create payment failed: ${response.status} ${JSON.stringify(json)}`);
  }
  
  return json;
}

/**
 * Get payment status from NOWPayments
 * @param {number|string} paymentId - NOWPayments payment ID
 * @returns {Promise<Object>} Payment status object
 */
async function nowpGetPayment(paymentId) {
  const apiKey = process.env.NOWPAYMENTS_API_KEY;
  if (!apiKey) {
    throw new Error("NOWPAYMENTS_API_KEY environment variable not set");
  }

  const response = await fetch(`${BASE}/v1/payment/${paymentId}`, {
    headers: { 
      "x-api-key": apiKey,
      "Content-Type": "application/json"
    },
  });

  const json = await response.json().catch(() => ({}));
  
  if (!response.ok) {
    console.error("[NOWPayments] Get payment failed:", response.status, json);
    throw new Error(`NOWPayments get payment failed: ${response.status} ${JSON.stringify(json)}`);
  }
  
  return json;
}

/**
 * Get minimum payment amount for a currency
 * @param {string} currency - Crypto currency code (e.g., "btc", "eth")
 * @returns {Promise<Object>} Minimum amount info
 */
async function nowpGetMinAmount(currency) {
  const apiKey = process.env.NOWPAYMENTS_API_KEY;
  if (!apiKey) {
    throw new Error("NOWPAYMENTS_API_KEY environment variable not set");
  }

  const response = await fetch(`${BASE}/v1/min-amount?currency_from=${currency}&currency_to=usd`, {
    headers: { "x-api-key": apiKey },
  });

  const json = await response.json().catch(() => ({}));
  
  if (!response.ok) {
    console.error("[NOWPayments] Get min amount failed:", response.status, json);
    return { min_amount: 0 };
  }
  
  return json;
}

/**
 * Get list of available currencies
 * @returns {Promise<Object>} Available currencies
 */
async function nowpGetCurrencies() {
  const apiKey = process.env.NOWPAYMENTS_API_KEY;
  if (!apiKey) {
    throw new Error("NOWPAYMENTS_API_KEY environment variable not set");
  }

  const response = await fetch(`${BASE}/v1/currencies`, {
    headers: { "x-api-key": apiKey },
  });

  const json = await response.json().catch(() => ({}));
  
  if (!response.ok) {
    console.error("[NOWPayments] Get currencies failed:", response.status, json);
    return { currencies: [] };
  }
  
  return json;
}

module.exports = {
  nowpCreatePayment,
  nowpGetPayment,
  nowpGetMinAmount,
  nowpGetCurrencies
};
