// db.js - Database interface contract
// Replace implementation with real DB (Postgres/Prisma/MySQL).
// These functions MUST be atomic where noted.

// For now, this is a stub that throws errors.
// You'll integrate with your existing crypto-deposit-system.js Database class.

export const db = {
  // Deposit addresses assigned per user
  async listDepositAddressesByNetwork(network) {
    // return [{ userId, address }]
    throw new Error("Implement db.listDepositAddressesByNetwork");
  },

  async getDepositAddressForUser(userId) {
    // return { btcAddress, evmAddress }
    throw new Error("Implement db.getDepositAddressForUser");
  },

  // Deposits table with unique constraint on (network, asset, txHash, address)
  async upsertDepositSeen({ userId, network, asset, address, txHash, amountAtomic, decimals, seenAt, blockNumber }) {
    // insert if not exists, else update confirmations/blockNumber
    // return deposit row { id, status, confirmations, requiredConfirmations, ... }
    throw new Error("Implement db.upsertDepositSeen");
  },

  async updateDepositConfirmations({ network, txHash, confirmations, blockNumber, status }) {
    throw new Error("Implement db.updateDepositConfirmations");
  },

  async getDepositByTx({ network, asset, txHash }) {
    throw new Error("Implement db.getDepositByTx");
  },

  // Atomic: only credit once.
  async creditDepositAtomic({ depositId, userId, asset, amountAtomic }) {
    // In ONE transaction:
    // 1) check deposit.status != 'credited'
    // 2) add amountAtomic to balances
    // 3) set deposit.status='credited'
    throw new Error("Implement db.creditDepositAtomic");
  },

  async listRecentDeposits(userId, limit = 10) {
    throw new Error("Implement db.listRecentDeposits");
  },

  async getRules(network, asset) {
    // return { minAtomic, minDisplay, requiredConfirmations, decimals }
    throw new Error("Implement db.getRules");
  }
};
