// routes/deposit.js - Production-safe deposit API endpoints
import express from "express";
import { db } from "../db.js";

export const depositRouter = express.Router();

// TODO: replace with your auth middleware
function auth(req, res, next) {
  // req.user = { id: "..." }
  // In production: verify JWT and load user id
  const token = req.headers['authorization']?.replace('Bearer ', '');
  
  if (!token) {
    // For development, allow demo user
    req.user = { id: req.headers["x-demo-user"] || "demo-user" };
    return next();
  }
  
  // TODO: Verify JWT token and extract user ID
  // For now, use demo user
  req.user = { id: "demo-user" };
  next();
}

depositRouter.get("/config", auth, async (req, res) => {
  try {
    const { network, asset } = req.query;
    if (!network || !asset) return res.status(400).json({ error: "network and asset required" });

    const rules = await db.getRules(network, asset);

    // explorer templates can be server-driven
    const explorer = network === "bitcoin"
      ? { 
          address: (a) => `https://mempool.space/address/${a}`, 
          tx: (h) => `https://mempool.space/tx/${h}` 
        }
      : { 
          address: (a) => `https://etherscan.io/address/${a}`, 
          tx: (h) => `https://etherscan.io/tx/${h}` 
        };

    res.json({
      network, 
      asset,
      minDisplay: rules.minDisplay,
      requiredConfirmations: rules.requiredConfirmations,
      decimals: rules.decimals,
      explorer
    });
  } catch (error) {
    console.error('Config error:', error);
    res.status(500).json({ error: error.message });
  }
});

depositRouter.get("/address", auth, async (req, res) => {
  try {
    const { network, asset } = req.query;
    if (!network || !asset) return res.status(400).json({ error: "network and asset required" });

    // Backend validates combos
    if (network === "bitcoin" && asset !== "BTC") {
      return res.status(400).json({ error: "BTC only on bitcoin" });
    }
    if (network === "ethereum" && asset === "BTC") {
      return res.status(400).json({ error: "BTC not on ethereum" });
    }

    const row = await db.getDepositAddressForUser(req.user.id);
    if (!row) return res.status(404).json({ error: "No deposit address" });

    const address = network === "bitcoin" ? row.btcAddress : row.evmAddress;

    // Optional: return a data-uri QR generated server-side.
    // If you don't have QR generation server-side yet, just omit.
    res.json({ address });
  } catch (error) {
    console.error('Address error:', error);
    res.status(500).json({ error: error.message });
  }
});

depositRouter.get("/status", auth, async (req, res) => {
  try {
    const { network, asset, txHash } = req.query;
    if (!network || !asset || !txHash) {
      return res.status(400).json({ error: "network, asset, txHash required" });
    }

    const dep = await db.getDepositByTx({ network, asset, txHash });
    if (!dep || dep.userId !== req.user.id) {
      return res.status(404).json({ error: "Not found" });
    }

    res.json({
      status: dep.status,               // pending|confirmed|credited
      confirmations: dep.confirmations || 0,
      required: dep.requiredConfirmations
    });
  } catch (error) {
    console.error('Status error:', error);
    res.status(500).json({ error: error.message });
  }
});

depositRouter.get("/recent", auth, async (req, res) => {
  try {
    const rows = await db.listRecentDeposits(req.user.id, 10);
    res.json({ items: rows });
  } catch (error) {
    console.error('Recent deposits error:', error);
    res.status(500).json({ error: error.message });
  }
});
