/**
 * Process-wide registry of live rooms and connected clients.
 *
 * This is deliberately module-level singleton state: on a single App Server
 * instance every socket shares these maps. NOTE for scaling — if we ever run
 * more than one App Server behind the load balancer, this in-memory map is
 * exactly what has to move to Redis pub/sub (see docs architecture review),
 * because two instances would otherwise each hold half the players of a table
 * and never see each other's broadcasts. Keeping it isolated here is what
 * makes that swap possible later without touching the rules engine.
 */

import { Room } from './Room.js';

/** A connected socket + which room it's seated in. */
export class Client {
  constructor(clientId, ws) {
    this.clientId = clientId;
    this.ws = ws;
    this.currentMoney = 0;
    this.joinedRoom = null;
  }
}

/** roomCode -> Room */
export const ROOMS = new Map();
/** clientId -> Client */
export const CLIENTS = new Map();

/** Create and register a Room from a freshly created `tables` row. Called by
 *  the HTTP table controller so newly created rooms are immediately joinable
 *  over the WebSocket without the HTTP layer reaching into gateway internals. */
export function registerRoom(table) {
  const room = new Room(table);
  ROOMS.set(room.roomCode, room);
  return room;
}

export function getRoom(roomCode) {
  return ROOMS.get(roomCode);
}

/** Find the Client that owns a given socket (used by inbound message handlers,
 *  where all we have is the `ws` the message arrived on). */
export function clientBySocket(ws) {
  return [...CLIENTS.values()].find((client) => client.ws === ws);
}
