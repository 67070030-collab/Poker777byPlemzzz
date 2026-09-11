/**
 * Wallet Service — topup, transactions, internal adjust.
 *
 * Owns the chip-economy rules (limits, idempotency, non-negative balance) and
 * the transaction boundaries. All SQL is delegated to wallet.model, which
 * writes the `wallets` balance and the `transactions` ledger together.
 */
import { withTransaction } from '../config/db.js';
import { env } from '../config/env.js';
import { ApiError } from '../middleware/errors.js';
import * as wallet from '../models/wallet.model.js';

/**
 * POST /wallet/topup — เติมชิป
 * Atomic: UPDATE wallets + INSERT transactions ใน DB transaction เดียว
 */
export async function topUp(userId, amount) {
  // Validate
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new ApiError('INVALID_AMOUNT', 'Amount must be a positive integer');
  }
  if (amount < env.economy.topupMin) {
    throw new ApiError('AMOUNT_TOO_LOW', `Minimum topup is ${env.economy.topupMin}`);
  }
  if (amount > env.economy.topupMax) {
    throw new ApiError('AMOUNT_TOO_HIGH', `Maximum topup is ${env.economy.topupMax}`);
  }

  const refId = `topup:${userId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

  return withTransaction(async (conn) => {
    // Lock wallet row and read current balance
    const walletRow = await wallet.lockWallet(userId, conn);
    if (!walletRow) {
      throw new ApiError('WALLET_NOT_FOUND', 'Wallet not found', 404);
    }

    const balanceAfter = walletRow.balance + amount;

    await wallet.updateBalance({ userId, balanceAfter }, conn);
    await wallet.insertTransaction(
      { userId, amount, type: 'TOPUP', refId, balanceAfter, note: `Topup ${amount} chips` },
      conn
    );

    return { balance: balanceAfter, amount, type: 'TOPUP' };
  });
}

/**
 * GET /wallet/transactions — pagination, newest first
 */
export async function getTransactions(userId, page = 1, limit = 20) {
  page = Math.max(1, parseInt(page, 10) || 1);
  limit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const offset = (page - 1) * limit;

  const rows = await wallet.listTransactions(userId, { limit, offset });
  const total = await wallet.countTransactions(userId);

  return {
    transactions: rows,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/**
 * POST /internal/wallet/adjust — สำหรับ WS team
 * Idempotent: ถ้า ref_id ซ้ำ → return 200 เดิม ไม่ปรับยอดซ้ำ
 */
export async function adjustWallet(userId, amount, refId, note = '') {
  if (!Number.isInteger(amount) || amount === 0) {
    throw new ApiError('INVALID_AMOUNT', 'Amount must be a non-zero integer');
  }

  return withTransaction(async (conn) => {
    const txType = amount > 0 ? 'WIN' : 'LOSS';

    // 1. Lock wallet row first — prevents race on balance
    const walletRow = await wallet.lockWallet(userId, conn);
    if (!walletRow) {
      throw new ApiError('WALLET_NOT_FOUND', 'Wallet not found', 404);
    }

    // 2. Check idempotency AFTER acquiring wallet lock
    //    This ensures that two parallel requests with the same ref_id
    //    serialize through the wallet lock — the second one sees the
    //    transaction already committed by the first.
    const existing = await wallet.findTransactionByRef(refId, conn);
    if (existing) {
      return {
        balance: existing.balance_after,
        amount: existing.amount,
        type: 'SETTLE',
        idempotent: true,
      };
    }

    const balanceAfter = walletRow.balance + amount;
    if (balanceAfter < 0) {
      throw new ApiError('INSUFFICIENT_BALANCE', 'Insufficient balance');
    }

    // 3. Update wallet + 4. append ledger row
    await wallet.updateBalance({ userId, balanceAfter }, conn);
    await wallet.insertTransaction(
      {
        userId,
        amount,
        type: txType,
        refId,
        balanceAfter,
        note: note || `Adjust ${amount} chips (hand: ${refId})`,
      },
      conn
    );

    return { balance: balanceAfter, amount, type: txType, idempotent: false };
  });
}
