/**
 * Wallet & transactions model — SQL for the `wallets` and `transactions`
 * tables. The append-only `transactions` ledger and the `wallets` balance are
 * always written together inside a service transaction, so the mutating
 * helpers here expect a transaction connection as their `db`.
 */
import { pool } from '../config/db.js';

/** Create the wallet row for a new user (called inside the register txn). */
export async function createWallet({ userId, balance }, db = pool) {
  await db.query(
    `INSERT INTO wallets (user_id, balance) VALUES (:userId, :balance)`,
    { userId, balance }
  );
}

/** SELECT ... FOR UPDATE — lock the wallet row so concurrent writers serialize.
 *  Must be called with a transaction connection. Returns the row or null. */
export async function lockWallet(userId, conn) {
  const [rows] = await conn.query(
    `SELECT balance FROM wallets WHERE user_id = :userId FOR UPDATE`,
    { userId }
  );
  return rows[0] || null;
}

/** Non-locking balance read (used for join affordability checks). */
export async function getBalance(userId, db = pool) {
  const [rows] = await db.query(
    `SELECT balance FROM wallets WHERE user_id = :userId LIMIT 1`,
    { userId }
  );
  return rows.length ? rows[0].balance : null;
}

/** Set a new balance and bump the optimistic-lock version. */
export async function updateBalance({ userId, balanceAfter }, db = pool) {
  await db.query(
    `UPDATE wallets SET balance = :balanceAfter, version = version + 1, updated_at = NOW()
      WHERE user_id = :userId`,
    { balanceAfter, userId }
  );
}

/** Append one ledger row. `ref_id` is UNIQUE, giving idempotency for free. */
export async function insertTransaction({ userId, amount, type, refId, balanceAfter, note = null }, db = pool) {
  await db.query(
    `INSERT INTO transactions (user_id, amount, type, ref_id, balance_after, note)
     VALUES (:userId, :amount, :type, :refId, :balanceAfter, :note)`,
    { userId, amount, type, refId, balanceAfter, note }
  );
}

/** Look up an existing ledger row by ref_id (idempotency check). */
export async function findTransactionByRef(refId, db = pool) {
  const [rows] = await db.query(
    `SELECT balance_after, amount FROM transactions WHERE ref_id = :refId LIMIT 1`,
    { refId }
  );
  return rows[0] || null;
}

/** One page of a user's ledger, newest first. */
export async function listTransactions(userId, { limit, offset }, db = pool) {
  const [rows] = await db.query(
    `SELECT id, amount, type, ref_id, balance_after, note, created_at
       FROM transactions
      WHERE user_id = :userId
      ORDER BY created_at DESC, id DESC
      LIMIT :limit OFFSET :offset`,
    { userId, limit, offset }
  );
  return rows;
}

/** Total ledger rows for a user (for pagination totals). */
export async function countTransactions(userId, db = pool) {
  const [rows] = await db.query(
    `SELECT COUNT(*) as total FROM transactions WHERE user_id = :userId`,
    { userId }
  );
  return rows[0].total;
}
