/**
 * Table model — SQL for the `tables` lobby table. Live seat counts come from
 * Redis (handled in the service), not from here.
 */
import { pool } from '../config/db.js';

/** Insert a table row; returns the new id. May throw ER_DUP_ENTRY on a
 *  room_code collision, which the service retries with a fresh code. */
export async function insertTable({ roomCode, name, hostId, minBet, maxBet, maxSeats }, db = pool) {
  const [result] = await db.query(
    `INSERT INTO tables (room_code, name, host_id, min_bet, max_bet, max_seats, status)
     VALUES (:roomCode, :name, :hostId, :minBet, :maxBet, :maxSeats, 'OPEN')`,
    { roomCode, name, hostId, minBet, maxBet, maxSeats }
  );
  return result.insertId;
}

export async function findById(id, db = pool) {
  const [rows] = await db.query(`SELECT * FROM tables WHERE id = :id LIMIT 1`, { id });
  return rows[0] || null;
}

export async function findByRoomCode(code, db = pool) {
  const [rows] = await db.query(`SELECT * FROM tables WHERE room_code = :code LIMIT 1`, { code });
  return rows[0] || null;
}

export async function listOpen(db = pool) {
  const [rows] = await db.query(
    `SELECT * FROM tables WHERE status = 'OPEN' ORDER BY created_at DESC`
  );
  return rows;
}
