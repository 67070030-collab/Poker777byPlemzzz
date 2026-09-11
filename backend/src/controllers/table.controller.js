/**
 * Table controller — HTTP glue for /tables/*. Creating a table also registers
 * an in-memory Room (game registry) so it's immediately joinable over the
 * WebSocket. All lobby rules live in services/tables.js.
 */
import { asyncHandler } from '../middleware/errorHandler.js';
import { createTable, listOpenTables, getTableSummary, joinTable } from '../services/tables.js';
import { registerRoom } from '../game/registry.js';

export const list = asyncHandler(async (req, res) => {
  res.json({ tables: await listOpenTables() });
});

export const create = asyncHandler(async (req, res) => {
  const table = await createTable(req.user.id, req.body);
  registerRoom(table);
  res.status(201).json({ table });
});

export const getByCode = asyncHandler(async (req, res) => {
  res.json({ table: await getTableSummary(req.params.room_code) });
});

export const join = asyncHandler(async (req, res) => {
  res.json({ table: await joinTable(req.user.id, req.params.room_code, req.body) });
});
