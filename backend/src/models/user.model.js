/**
 * User model — all SQL that touches the `users` table.
 *
 * Every function takes an optional `db` executor (defaults to the shared
 * pool). Pass a transaction connection instead when the caller needs the
 * statement to run inside an open transaction — that keeps transaction
 * boundaries in the service layer while all raw SQL lives here.
 */
import { pool } from '../config/db.js';

/** Pre-insert check for a nicer 409. Returns the clashing row ({username}) or null. */
export async function findLoginConflict({ username, email }, db = pool) {
  const [rows] = await db.query(
    `SELECT username FROM users WHERE username = :username OR email = :email LIMIT 1`,
    { username, email }
  );
  return rows[0] || null;
}

/** Insert a user; returns the new id as a string. */
export async function insertUser({ username, email, passwordHash }, db = pool) {
  const [result] = await db.query(
    `INSERT INTO users (username, email, password_hash)
     VALUES (:username, :email, :passwordHash)`,
    { username, email, passwordHash }
  );
  return String(result.insertId);
}

/** Login lookup by username OR email. Returns the row (with password_hash) or null. */
export async function findByIdentifier(identifier, db = pool) {
  const [rows] = await db.query(
    `SELECT id, username, email, password_hash
       FROM users
      WHERE username = :identifier OR email = :identifier
      LIMIT 1`,
    { identifier }
  );
  return rows[0] || null;
}

/** Profile row joined with wallet balance (balance may be null if no wallet). */
export async function findProfileById(userId, db = pool) {
  const [rows] = await db.query(
    `SELECT u.id, u.username, u.email, u.display_name, u.avatar_id, u.created_at,
            w.balance
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
      WHERE u.id = :userId
      LIMIT 1`,
    { userId }
  );
  return rows[0] || null;
}

/** Patch avatar_id / display_name (COALESCE keeps existing when arg is null).
 *  Returns affectedRows so the caller can 404 on a missing user. */
export async function updateProfile({ userId, avatar_id, display_name }, db = pool) {
  const [result] = await db.query(
    `UPDATE users SET
        avatar_id    = COALESCE(:avatar_id, avatar_id),
        display_name = COALESCE(:display_name, display_name)
      WHERE id = :userId`,
    { avatar_id: avatar_id ?? null, display_name: display_name ?? null, userId }
  );
  return result.affectedRows;
}
