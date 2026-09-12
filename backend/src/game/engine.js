/**
 * Texas Hold'em rules engine — the functions that drive a Room through a hand.
 *
 * Implements real no-limit Hold'em flow:
 *   - dealer button rotation + small/big blinds (heads-up rules included)
 *   - position-based action order (UTG preflop, SB-first postflop)
 *   - a betting round that RE-OPENS when someone bets/raises (everyone must
 *     act again), with min-raise enforcement
 *   - CHECK / CALL / BET / RAISE / FOLD with validation
 *   - all-in handling + side pots, and split pots on ties
 *
 * State lives on the Room; the rules live here; transport is in gateway.js.
 * The functions are mutually recursive (performAction → advanceStreet →
 * armTurn → performAction on timeout) so they share one module.
 */

import { shuffledDeck } from './deck.js';
import { handScore, compareScores, handName } from './handEvaluator.js';

/** How long a player has to act before they are auto-checked/folded. */
export const TURN_MS = 15000;

// --- seating / ordering helpers --------------------------------------------

/** Client ids dealt into the current hand, in seat order (fixed for the hand). */
function seatOrder(room) {
  return room.handSeats && room.handSeats.length ? room.handSeats : [...room.currentPlayers.keys()];
}

function seatAfter(room, id) {
  const o = seatOrder(room);
  if (!o.length) return null;
  const i = o.indexOf(id);
  return o[(i + 1) % o.length];
}

/** True if this player still has a decision to make (in the hand, not all-in). */
function canPlayerAct(room, id) {
  const p = room.currentPlayers.get(id);
  return !!p && !room.folded.has(id) && !room.allIn.has(id) && p.chips > 0;
}

/** First actable player starting AT `id` and walking seat order (inclusive). */
function firstActiveFrom(room, id) {
  const o = seatOrder(room);
  const n = o.length;
  if (!n) return null;
  const start = Math.max(0, o.indexOf(id));
  for (let k = 0; k < n; k += 1) {
    const c = o[(start + k) % n];
    if (canPlayerAct(room, c)) return c;
  }
  return null;
}

/** Next actable player strictly AFTER `id`. */
function nextActive(room, id) {
  const after = seatAfter(room, id);
  return after == null ? null : firstActiveFrom(room, after);
}

/** Client ids still in the hand (not folded), all-in included. */
export function activePlayers(room) {
  return seatOrder(room).filter((id) => !room.folded.has(id));
}

/** Client ids who can still make a betting decision (not folded, not all-in). */
function playersWhoCanAct(room) {
  return seatOrder(room).filter((id) => canPlayerAct(room, id));
}

// --- chips ------------------------------------------------------------------

/** Move up to `amount` chips from a player into the pot (capped at their stack
 *  → all-in). Updates street + hand contributions. Returns chips actually put. */
function commit(room, id, amount) {
  const p = room.currentPlayers.get(id);
  const wager = Math.min(Math.max(0, amount), p.chips);
  p.chips -= wager;
  room.contributions.set(id, (room.contributions.get(id) || 0) + wager);
  room.committed.set(id, (room.committed.get(id) || 0) + wager);
  room.pot += wager;
  if (p.chips === 0) room.allIn.add(id);
  return wager;
}

function rotateButton(room) {
  const o = seatOrder(room);
  if (!o.length) { room.button = null; return; }
  const i = o.indexOf(room.button);
  room.button = i === -1 ? o[0] : o[(i + 1) % o.length];
}

// --- hand lifecycle ---------------------------------------------------------

/**
 * Deal a new hand: pick who's in (chips > 0), rotate the button, post blinds,
 * deal hole cards, and set the first player to act. Requires >= 2 funded
 * players and an idle table (WAITING or just-finished SHOWDOWN).
 */
export function startGame(room) {
  if (!['WAITING', 'SHOWDOWN'].includes(room.phase)) return false;
  const funded = [...room.currentPlayers.keys()].filter((id) => (room.currentPlayers.get(id).chips || 0) > 0);
  if (funded.length < 2) return false;

  room.handSeats = funded;
  room.deck = shuffledDeck();
  room.communityCards = [];
  room.holeCards.clear();
  room.pot = 0;
  room.phase = 'PREFLOP';
  room.status = 'IN_PROGRESS';
  room.folded.clear();
  room.allIn.clear();
  room.committed.clear();
  room.contributions.clear();
  room.acted.clear();
  room.currentBet = 0;
  room.lastRaiseSize = room.bigBlind;
  room.winner = null; room.winnerName = null; room.winningHand = null; room.winners = [];
  room.readyVotes.clear();
  room.lastActions.clear();

  rotateButton(room);
  const n = funded.length;
  const sb = n === 2 ? room.button : seatAfter(room, room.button);
  const bb = seatAfter(room, sb);
  commit(room, sb, room.smallBlind);
  commit(room, bb, room.bigBlind);
  room.currentBet = room.bigBlind;

  funded.forEach((id) => room.holeCards.set(id, [room.deck.pop(), room.deck.pop()]));

  // First to act: heads-up the button acts first preflop; otherwise UTG (left of BB).
  const firstSeat = n === 2 ? room.button : seatAfter(room, bb);
  room.currentTurn = firstActiveFrom(room, firstSeat);
  room.broadcast('GAME_STARTED');

  // Blinds may have put everyone all-in already.
  if (room.currentTurn == null || (playersWhoCanAct(room).length <= 1 && isRoundComplete(room))) {
    return runoutAndFinish(room), true;
  }
  armTurn(room);
  return true;
}

/** (Re)start the turn clock. On timeout: check for free, otherwise fold. */
export function armTurn(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
  if (room.currentTurn == null) return;
  const id = room.currentTurn;
  room.turnDeadline = Date.now() + TURN_MS;
  room.turnTimer = setTimeout(() => {
    const toCall = room.currentBet - (room.contributions.get(id) || 0);
    performAction(room, id, toCall === 0 ? 'CHECK' : 'FOLD', 0, true);
  }, TURN_MS);
  room.broadcast('TABLE_STATE');
}

/** A betting round is complete when every non-folded player is all-in, or has
 *  voluntarily acted AND matched the current bet. (Blinds don't count as
 *  "acted", which is what gives the big blind their preflop option.) */
function isRoundComplete(room) {
  return activePlayers(room).every(
    (id) => room.allIn.has(id) || (room.acted.has(id) && (room.contributions.get(id) || 0) === room.currentBet)
  );
}

/**
 * Validate a proposed action. Returns null if legal, or an error string.
 * Used by the gateway to reject illegal moves before they mutate state.
 */
export function validateAction(room, id, action, amount) {
  if (room.phase === 'WAITING' || room.phase === 'SHOWDOWN') return 'No hand in progress';
  if (String(room.currentTurn) !== String(id)) return 'It is not your turn';
  const p = room.currentPlayers.get(id);
  if (!p || room.folded.has(id) || room.allIn.has(id)) return 'You cannot act right now';

  const contributed = room.contributions.get(id) || 0;
  const toCall = room.currentBet - contributed;
  const maxTarget = contributed + p.chips;
  const target = Math.floor(Number(amount) || 0);

  switch (action) {
    case 'FOLD':
      return null;
    case 'CHECK':
      return toCall === 0 ? null : 'Cannot check while facing a bet';
    case 'CALL':
      return toCall > 0 ? null : 'Nothing to call — check instead';
    case 'BET': {
      if (room.currentBet > 0) return 'There is already a bet — raise instead';
      if (target > maxTarget) return 'Not enough chips';
      if (target < room.bigBlind && target < maxTarget) return `Minimum bet is ${room.bigBlind}`;
      return target > 0 ? null : 'Bet must be greater than 0';
    }
    case 'RAISE': {
      if (room.currentBet === 0) return 'Nothing to raise — bet instead';
      if (target > maxTarget) return 'Not enough chips';
      const minTarget = room.currentBet + (room.lastRaiseSize || room.bigBlind);
      if (target < minTarget && target < maxTarget) return `Minimum raise is to ${minTarget}`;
      return null;
    }
    default:
      return 'Invalid action';
  }
}

/**
 * Apply one (already-validated) action, then decide what happens next:
 * settle if only one player remains, run the board out if everyone left is
 * all-in, advance the street once the round is complete, else pass the turn.
 */
export function performAction(room, id, action, amount, timedOut = false) {
  if (!room.currentPlayers.has(id) || room.folded.has(id) || room.allIn.has(id)) return;
  if (String(room.currentTurn) !== String(id)) return;

  const contributed = room.contributions.get(id) || 0;
  let displayAmount = 0;

  if (action === 'FOLD') {
    room.folded.add(id);
  } else if (action === 'CHECK') {
    // no chips move
  } else if (action === 'CALL') {
    displayAmount = commit(room, id, room.currentBet - contributed);
  } else if (action === 'BET' || action === 'RAISE') {
    const p = room.currentPlayers.get(id);
    const target = Math.min(Math.floor(Number(amount) || 0), contributed + p.chips); // all-in cap
    commit(room, id, target - contributed);
    displayAmount = target;
    if (target > room.currentBet) {
      room.lastRaiseSize = target - room.currentBet;
      room.currentBet = target;
      room.acted.clear();          // an aggressive action re-opens the round
    }
  }

  room.acted.add(id);
  room.lastAction = { client_id: id, action, amount: displayAmount, timed_out: timedOut };
  room.lastActions.set(String(id), { action, amount: displayAmount, timed_out: timedOut });
  room.broadcast('GAME_ACTION', room.lastAction);

  // Everyone else folded → last player standing wins uncontested.
  if (activePlayers(room).length <= 1) return finishGame(room);

  if (isRoundComplete(room)) {
    // Nobody left who can still bet (rest are all-in) → deal it out.
    if (playersWhoCanAct(room).length <= 1) return runoutAndFinish(room);
    return advanceStreet(room);
  }

  const next = nextActive(room, id);
  if (next == null) return advanceStreet(room);
  room.currentTurn = next;
  armTurn(room);
}

/** Reset betting, deal the next street, and set the first player to act. */
export function advanceStreet(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
  room.contributions.clear();
  room.currentBet = 0;
  room.lastRaiseSize = room.bigBlind;
  room.acted.clear();
  room.lastActions.clear(); // per-street action badges reset when a new street opens

  if (room.phase === 'PREFLOP') { room.communityCards.push(...room.deck.splice(0, 3)); room.phase = 'FLOP'; }
  else if (room.phase === 'FLOP') { room.communityCards.push(room.deck.pop()); room.phase = 'TURN'; }
  else if (room.phase === 'TURN') { room.communityCards.push(room.deck.pop()); room.phase = 'RIVER'; }
  else return finishGame(room);

  // Postflop the first active player left of the button acts first.
  room.currentTurn = firstActiveFrom(room, seatAfter(room, room.button));
  if (room.currentTurn == null) return runoutAndFinish(room);
  armTurn(room);
}

/** Deal any remaining community cards (used when all remaining players are
 *  all-in and no more betting can happen) then go to showdown. */
function runoutAndFinish(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
  room.currentTurn = null;
  room.turnDeadline = null;
  while (room.communityCards.length < 5 && room.deck.length) room.communityCards.push(room.deck.pop());
  room.phase = 'RIVER';
  return finishGame(room);
}

/** Settle the hand: award the pot (with side pots + split on ties). */
export function finishGame(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
  room.turnDeadline = null;
  room.currentTurn = null;

  const contenders = activePlayers(room);
  if (contenders.length === 1) {
    const id = contenders[0];
    const amount = room.pot;
    room.currentPlayers.get(id).chips += amount;
    return endHand(room, [{ client_id: id, username: room.currentPlayers.get(id).username, amount, hand: null }]);
  }
  return endHand(room, settlePots(room, contenders));
}

/**
 * Split the pot into main + side pots by contribution level and award each to
 * the best eligible hand (tying hands split, odd chips to earliest seat).
 * Folded players' chips stay in the pot but they can't win any of it.
 */
function settlePots(room, contenders) {
  const committed = new Map();
  for (const [id, amt] of room.committed) if (amt > 0) committed.set(id, amt);

  const board = room.communityCards;
  const scoreOf = new Map();
  for (const id of contenders) scoreOf.set(id, handScore([...(room.holeCards.get(id) || []), ...board]));

  const levels = [...new Set([...committed.values()])].sort((a, b) => a - b);
  const payouts = new Map();
  const handOf = new Map();
  let prev = 0;

  for (const level of levels) {
    const per = level - prev;
    prev = level;
    if (per <= 0) continue;

    let layer = 0;
    for (const amt of committed.values()) if (amt >= level) layer += per;

    const eligible = contenders.filter((id) => (committed.get(id) || 0) >= level);
    if (!eligible.length) continue;

    let best = null;
    for (const id of eligible) if (best === null || compareScores(scoreOf.get(id), scoreOf.get(best)) > 0) best = id;
    const winners = eligible.filter((id) => compareScores(scoreOf.get(id), scoreOf.get(best)) === 0);

    const share = Math.floor(layer / winners.length);
    let odd = layer - share * winners.length; // leftover chips (seat order gets them)
    for (const id of winners) {
      const extra = odd > 0 ? 1 : 0;
      if (odd > 0) odd -= 1;
      payouts.set(id, (payouts.get(id) || 0) + share + extra);
      if (!handOf.has(id)) handOf.set(id, handName(scoreOf.get(id)[0]));
    }
  }

  const results = [];
  for (const [id, amt] of payouts) {
    room.currentPlayers.get(id).chips += amt;
    results.push({ client_id: id, username: room.currentPlayers.get(id).username, amount: amt, hand: handOf.get(id) });
  }
  results.sort((a, b) => b.amount - a.amount);
  return results;
}

function endHand(room, results) {
  room.pot = 0;
  room.phase = 'SHOWDOWN';
  room.status = 'OPEN';
  room.lastAction = null;
  room.winners = results.map((r) => ({ client_id: String(r.client_id), username: r.username, amount: r.amount, hand: r.hand }));
  const top = results[0] || null;
  room.winner = top ? String(top.client_id) : null;
  room.winnerName = top ? top.username : null;
  room.winningHand = top ? top.hand : null;
  room.broadcast('SHOWDOWN');
}
