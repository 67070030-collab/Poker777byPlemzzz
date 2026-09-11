/**
 * WebSocket gateway — the transport/"controller" for the realtime game.
 *
 * Responsibilities:
 *  - authenticate the upgrade handshake via the `?token=` JWT (handleTableUpgrade)
 *  - own the WebSocketServer and route inbound messages (join / leave /
 *    start / action) to the rules engine
 *  - keep the ROOMS/CLIENTS registry in sync as sockets connect and drop
 *
 * It leans on the same services the HTTP API uses (joinTable, getUserProfile)
 * so seat/wallet rules stay in one place, and delegates all gameplay to
 * engine.js. No poker rules live here.
 */

import { WebSocket, WebSocketServer } from 'ws';
import { URL } from 'node:url';
import { env } from '../config/env.js';
import { jwt } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { joinTableSchema } from '../validators/game.js';
import { joinTable, getTableSummary } from '../services/tables.js';
import { getUserProfile } from '../services/auth.js';
import { startGame, performAction, validateAction } from './engine.js';
import { ROOMS, CLIENTS, Client, getRoom, registerRoom, clientBySocket } from './registry.js';

const wss = new WebSocketServer({ noServer: true });

async function joinRoom(params, ws) {
  const data = validate(joinTableSchema, params);
  if (String(ws.userId) !== String(data.clientId)) {
    return ws.send(JSON.stringify({ type: 'error', error: 'Client identity does not match token' }));
  }
  // Rooms live in memory; after a server restart (or when a player opens a
  // table link directly) the room may exist in the DB but not in ROOMS.
  // Rebuild it from the DB row so people can (re)join instead of hitting a
  // dead "Room not found".
  let room = getRoom(data.roomCode);
  if (!room) {
    try {
      const table = await getTableSummary(data.roomCode);
      room = registerRoom({
        id: table.id, room_code: table.room_code, name: table.name, host_id: table.host_id,
        min_bet: table.min_bet, max_bet: table.max_bet, max_seats: table.max_seats,
      });
    } catch {
      return ws.send(JSON.stringify({ type: 'error', error: 'Room not found' }));
    }
  }

  let client = CLIENTS.get(data.clientId);
  if (!client) {
    client = new Client(data.clientId, ws);
    CLIENTS.set(data.clientId, client);
  }
  if (client.joinedRoom && client.joinedRoom !== room) {
    return ws.send(JSON.stringify({ type: 'error', error: 'Client already joined a room' }));
  }
  if (!room.currentPlayers.has(data.clientId) && room.currentPlayers.size >= room.maxPlayer) {
    return ws.send(JSON.stringify({ type: 'error', error: 'Table is full' }));
  }

  try {
    await joinTable(data.clientId, data.roomCode, { buy_in: data.buyIn });
  } catch (error) {
    const messages = {
      ROOM_IN_PROGRESS: 'Table is already in progress',
      ROOM_CLOSED: 'Table is closed',
      ROOM_FULL: 'Table is full',
      BUY_IN_TOO_LOW: 'Buy-in is too low',
      BUY_IN_TOO_HIGH: 'Buy-in is too high',
      INSUFFICIENT_BALANCE: 'Insufficient balance',
    };
    return ws.send(JSON.stringify({ type: 'error', error: messages[error.code] || error.message }));
  }

  const profile = await getUserProfile(data.clientId);
  client.ws = ws;
  client.username = profile.display_name || profile.username;
  client.chips = Number(profile.balance || 0);
  client.avatarId = profile.avatar_id ?? null;
  client.joinedRoom = room;
  room.currentPlayers.set(data.clientId, client);
  room.status = room.currentPlayers.size >= room.maxPlayer ? 'IN_PROGRESS' : 'OPEN';
  room.broadcast();
}

function leaveRoom(ws) {
  for (const room of ROOMS.values()) {
    for (const [clientId, client] of room.currentPlayers) {
      if (client.ws !== ws) continue;
      room.currentPlayers.delete(clientId);
      client.joinedRoom = null;
      if (String(room.host) === String(clientId)) {
        room.host = room.currentPlayers.keys().next().value || room.host;
      }
      room.lastAction = { client_id: clientId, action: 'LEAVE', amount: 0, timed_out: false };
      room.status = 'OPEN';
      room.phase = 'WAITING';
      room.currentTurn = null;
      room.communityCards = [];
      room.contributions.clear();
      room.currentBet = 0;
      room.holeCards.clear();
      room.readyVotes.delete(clientId);
      if (room.turnTimer) {
        clearTimeout(room.turnTimer);
        room.turnTimer = null;
      }
      room.broadcast();
    }
  }
}

function leaveRoomByClient(client) {
  if (!client?.joinedRoom) return false;
  const room = client.joinedRoom;
  const socket = client.ws;
  leaveRoom(socket);
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'LEFT_ROOM', params: { room_code: room.roomCode } }));
    socket.close(1000, 'Left room');
  }
  return true;
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'connection', message: 'WebSocket connection established' }));
  ws.on('message', async (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === 'join') await joinRoom(message.params || {}, ws);
      else if (message.type === 'LEAVE_ROOM') {
        const client = clientBySocket(ws);
        if (!leaveRoomByClient(client)) ws.send(JSON.stringify({ type: 'error', error: 'You are not in a room' }));
      }
      else if (message.type === 'START_GAME') {
        // Any seated player may start the first hand — the original host may not
        // even be at the table (rooms can be rebuilt from the DB), so requiring
        // the host would deadlock the table.
        const client = clientBySocket(ws);
        if (!client?.joinedRoom) {
          return ws.send(JSON.stringify({ type: 'error', error: 'You are not in a room' }));
        }
        if (!startGame(client.joinedRoom)) {
          return ws.send(JSON.stringify({ type: 'error', error: 'At least 2 players are required to start' }));
        }
      }
      else if (message.type === 'VOTE_NEXT') {
        // Vote to deal the next hand. When every funded player has readied up
        // (and there are at least 2), the next hand starts automatically.
        const client = clientBySocket(ws);
        const room = client?.joinedRoom;
        if (!room) return;
        if (room.phase !== 'SHOWDOWN' && room.phase !== 'WAITING') {
          return ws.send(JSON.stringify({ type: 'error', error: 'A round is already in progress' }));
        }
        room.readyVotes.add(String(client.clientId));
        const eligible = [...room.currentPlayers.values()].filter((p) => (p.chips || 0) > 0).map((p) => String(p.clientId));
        if (eligible.length >= 2 && eligible.every((id) => room.readyVotes.has(id))) {
          startGame(room); // clears readyVotes and deals the next hand
        } else {
          room.broadcast('TABLE_STATE');
        }
      }
      else if (message.type === 'GAME_ACTION') {
        const client = clientBySocket(ws);
        const room = client?.joinedRoom;
        if (!room) return;
        const action = String(message.params?.action || '').toUpperCase();
        if (!['FOLD', 'CHECK', 'CALL', 'BET', 'RAISE'].includes(action)) {
          return ws.send(JSON.stringify({ type: 'error', error: 'Invalid game action' }));
        }
        const amount = Math.max(0, Number(message.params?.amount || 0));
        // Enforce real poker legality (turn, check-facing-bet, min-raise, chips…).
        const problem = validateAction(room, client.clientId, action, amount);
        if (problem) return ws.send(JSON.stringify({ type: 'error', error: problem }));
        performAction(room, client.clientId, action, amount);
      }
    } catch (error) {
      ws.send(JSON.stringify({ type: 'error', error: error.message || 'Invalid message' }));
    }
  });
  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => leaveRoom(ws));
});

/**
 * Authenticate and complete a WebSocket upgrade for `/ws`. The JWT arrives as
 * `?token=` on the handshake URL (browsers can't set headers on a WS upgrade);
 * an invalid/missing token drops the socket before it ever joins a room.
 */
export function handleTableUpgrade(request, socket, head) {
  try {
    const url = new URL(request.url, 'http://localhost');
    const token = url.searchParams.get('token');
    const claims = jwt.verify(token, env.jwt.secret, { issuer: env.jwt.issuer });
    request.userId = String(claims.sub);
  } catch (_) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.userId = request.userId;
    wss.emit('connection', ws, request);
  });
}
