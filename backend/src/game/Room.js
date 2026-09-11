/**
 * Room — the in-memory state of one poker table (Model of the realtime side).
 *
 * A Room mirrors a `tables` DB row (code, name, blinds, host) plus all the
 * live hand state the WebSocket layer mutates: seated players, the deck, hole
 * and community cards, the pot, the dealer button, blinds, whose turn it is,
 * per-street and per-hand contributions, all-in status, etc.
 *
 * The Room only holds state and pushes it to sockets (`state`, `send`,
 * `broadcast`). The rules that *change* that state live in `engine.js`, so
 * gameplay logic stays testable and separate from transport.
 *
 * Blinds mapping: the table's min_bet/max_bet are presented in the lobby as
 * "Blinds min / max", so smallBlind = min_bet and bigBlind = max_bet.
 */

import { WebSocket } from 'ws';

export class Room {
  constructor(table) {
    this.roomCode = table.room_code;
    this.roomId = table.id;
    this.name = table.name;
    this.minBet = table.min_bet;
    this.maxBet = table.max_bet;
    this.smallBlind = table.min_bet;
    this.bigBlind = table.max_bet;
    this.maxPlayer = table.max_seats;
    this.host = table.host_id;
    this.currentPlayers = new Map();
    this.status = 'OPEN';

    // --- per-hand state (reset by engine.startGame) ---
    this.communityCards = [];
    this.holeCards = new Map();
    this.deck = [];
    this.pot = 0;
    this.phase = 'WAITING';
    this.button = null;                // clientId of the dealer button
    this.folded = new Set();
    this.allIn = new Set();
    this.committed = new Map();         // clientId -> chips put in this HAND (for side pots)

    // --- per-street betting state (reset each street) ---
    this.contributions = new Map();    // clientId -> chips put in this STREET (for call/raise)
    this.currentBet = 0;               // highest street contribution to match
    this.lastRaiseSize = 0;            // size of the last raise increment (min-raise floor)
    this.acted = new Set();            // who has voluntarily acted since the last aggressive action

    // --- turn + result ---
    this.currentTurn = null;
    this.turnDeadline = null;
    this.turnTimer = null;
    this.lastAction = null;
    this.winner = null;
    this.winnerName = null;
    this.winningHand = null;
    this.winners = [];                 // [{ client_id, username, amount, hand }] (supports split/side pots)
    this.readyVotes = new Set();       // clientIds who voted to start the next hand (SHOWDOWN/WAITING)
  }

  /** Snapshot broadcast to clients. Hole cards are per-player; everything else
   *  is table-wide. Kept as a plain object so it JSON-serializes directly. */
  state() {
    return {
      room_code: this.roomCode,
      room_name: this.name,
      player_count: this.currentPlayers.size,
      max_players: this.maxPlayer,
      status: this.status,
      phase: this.phase,
      host_id: String(this.host),
      dealer_button: this.button != null ? String(this.button) : null,
      small_blind: this.smallBlind,
      big_blind: this.bigBlind,
      current_turn: this.currentTurn,
      current_turn_name: this.currentTurn ? this.currentPlayers.get(this.currentTurn)?.username || this.currentTurn : null,
      turn_deadline: this.turnDeadline,
      pot: this.pot,
      current_bet: this.currentBet,
      // Smallest legal "raise to" amount, so the client can pre-fill the raise box.
      min_raise: this.currentBet > 0 ? this.currentBet + (this.lastRaiseSize || this.bigBlind) : this.bigBlind,
      winner: this.winner,
      winner_name: this.winnerName,
      winning_hand: this.winningHand,
      winners: this.winners,
      ready_votes: [...this.readyVotes].map(String),
      ready_needed: [...this.currentPlayers.values()].filter((p) => (p.chips || 0) > 0).length,
      last_action: this.lastAction,
      community_cards: this.communityCards,
      players: [...this.currentPlayers.values()].map((player, seat) => {
        const streetBet = this.contributions.get(player.clientId) || 0;
        return {
          client_id: player.clientId,
          seat,
          username: player.username || player.clientId,
          chips: player.chips ?? null,
          avatar_id: player.avatarId ?? null,
          ready: this.readyVotes.has(String(player.clientId)),
          hole_cards: this.holeCards.get(player.clientId) || [],
          bet: streetBet,                                   // chips in this street
          committed: this.committed.get(player.clientId) || 0, // chips in this hand
          to_call: Math.max(0, this.currentBet - streetBet),
          all_in: this.allIn.has(player.clientId),
          is_dealer: String(this.button) === String(player.clientId),
          status: this.folded.has(player.clientId)
            ? 'FOLDED'
            : this.allIn.has(player.clientId)
              ? 'ALL-IN'
              : (String(this.currentTurn) === String(player.clientId) ? 'YOUR TURN' : 'IN'),
        };
      }),
    };
  }

  send(socket, type, params = this.state()) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type, params }));
    }
  }

  broadcast(type = 'TABLE_STATE', params = this.state()) {
    for (const player of this.currentPlayers.values()) this.send(player.ws, type, params);
  }
}
