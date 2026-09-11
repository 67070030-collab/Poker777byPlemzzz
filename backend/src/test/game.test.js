/**
 * Game engine unit tests — pure logic, NO database or WebSocket required.
 * Run standalone with: node --test src/test/game.test.js
 *
 * Covers the Texas Hold'em rules in src/game/*: deck, hand ranking, blinds +
 * button + action order, betting-round re-opening on a raise, action
 * validation, all-in side pots, and split pots.
 */
import { test } from 'node:test';
import assert from 'node:assert';

import { shuffledDeck, SUITS, RANKS } from '../game/deck.js';
import { handScore, compareScores, handName } from '../game/handEvaluator.js';
import { Room } from '../game/Room.js';
import { startGame, performAction, finishGame, validateAction, activePlayers } from '../game/engine.js';

const card = (rank, suit) => ({ rank, suit });

function makeRoom({ min = 5, max = 10, maxSeats = 6 } = {}) {
  return new Room({ room_code: 'TEST', id: 1, name: 'T', min_bet: min, max_bet: max, max_seats: maxSeats, host_id: 'a' });
}
function seat(room, id, chips) {
  room.currentPlayers.set(id, { clientId: id, username: id, chips, avatarId: null, ws: { readyState: 1, send() {} } });
}
function stop(room) { if (room.turnTimer) clearTimeout(room.turnTimer); }

// --- pure functions ---------------------------------------------------------

test('shuffledDeck returns 52 unique cards', () => {
  const deck = shuffledDeck();
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck.map((c) => `${c.rank}${c.suit}`)).size, 52);
  assert.equal(SUITS.length, 4);
  assert.equal(RANKS.length, 13);
});

test('handScore ranks categories; flush > two pair > pair', () => {
  const pair = handScore([card('A', 'S'), card('A', 'H'), card('2', 'D'), card('7', 'C'), card('9', 'S')]);
  const twoPair = handScore([card('A', 'S'), card('A', 'H'), card('7', 'D'), card('7', 'C'), card('9', 'S')]);
  const flush = handScore([card('2', 'S'), card('5', 'S'), card('7', 'S'), card('9', 'S'), card('J', 'S')]);
  assert.equal(pair[0], 1);
  assert.equal(twoPair[0], 2);
  assert.equal(flush[0], 5);
  assert.ok(compareScores(flush, twoPair) > 0 && compareScores(twoPair, pair) > 0);
});

test('handScore detects the wheel straight A-2-3-4-5', () => {
  assert.equal(handScore([card('A', 'S'), card('2', 'H'), card('3', 'D'), card('4', 'C'), card('5', 'S')])[0], 4);
});

test('handName maps category to label', () => {
  assert.equal(handName(0), 'High card');
  assert.equal(handName(8), 'Straight flush');
});

// --- blinds / button / order ------------------------------------------------

test('3-handed: button, blinds, and UTG-first action are set correctly', () => {
  const room = makeRoom({ min: 5, max: 10 });
  seat(room, 'a', 1000); seat(room, 'b', 1000); seat(room, 'c', 1000);
  startGame(room);
  assert.equal(room.button, 'a', 'first hand button on first seat');
  assert.equal(room.contributions.get('b'), 5, 'b posts small blind');
  assert.equal(room.contributions.get('c'), 10, 'c posts big blind');
  assert.equal(room.currentBet, 10);
  assert.equal(room.pot, 15);
  assert.equal(room.currentTurn, 'a', 'UTG (left of BB) acts first');
  assert.equal(room.currentPlayers.get('c').chips, 990);
  stop(room);
});

test('heads-up: button posts small blind and acts first preflop', () => {
  const room = makeRoom({ min: 5, max: 10 });
  seat(room, 'a', 1000); seat(room, 'b', 1000);
  startGame(room);
  assert.equal(room.button, 'a');
  assert.equal(room.contributions.get('a'), 5, 'button = small blind heads-up');
  assert.equal(room.contributions.get('b'), 10);
  assert.equal(room.currentTurn, 'a', 'button acts first preflop heads-up');
  stop(room);
});

// --- validation -------------------------------------------------------------

test('validateAction enforces poker legality', () => {
  const room = makeRoom({ min: 5, max: 10 });
  seat(room, 'a', 1000); seat(room, 'b', 1000); seat(room, 'c', 1000);
  startGame(room); // currentTurn a, currentBet 10, lastRaiseSize 10
  assert.match(validateAction(room, 'a', 'CHECK', 0), /Cannot check/);
  assert.equal(validateAction(room, 'a', 'CALL', 0), null);
  assert.match(validateAction(room, 'a', 'RAISE', 15), /Minimum raise is to 20/);
  assert.equal(validateAction(room, 'a', 'RAISE', 20), null);
  assert.match(validateAction(room, 'b', 'CALL', 0), /not your turn/);
  stop(room);
});

// --- betting round re-opening ----------------------------------------------

test('a raise re-opens the round: action returns to earlier callers', () => {
  const room = makeRoom({ min: 5, max: 10 });
  seat(room, 'a', 1000); seat(room, 'b', 1000); seat(room, 'c', 1000);
  startGame(room); // a to act, BB=10
  performAction(room, 'a', 'CALL', 0);   // a calls 10 -> b
  performAction(room, 'b', 'CALL', 0);   // b (SB) completes to 10 -> c (BB option)
  performAction(room, 'c', 'RAISE', 20); // c raises to 20 -> re-opens
  assert.equal(room.phase, 'PREFLOP', 'still preflop, not advanced');
  assert.equal(room.currentBet, 20);
  assert.equal(room.currentTurn, 'a', 'action back to a after the raise');
  stop(room);
});

test('all call and BB checks option -> flop is dealt, SB acts first', () => {
  const room = makeRoom({ min: 5, max: 10 });
  seat(room, 'a', 1000); seat(room, 'b', 1000); seat(room, 'c', 1000);
  startGame(room);
  performAction(room, 'a', 'CALL', 0);
  performAction(room, 'b', 'CALL', 0);
  performAction(room, 'c', 'CHECK', 0); // BB checks option
  assert.equal(room.phase, 'FLOP');
  assert.equal(room.communityCards.length, 3);
  assert.equal(room.currentBet, 0);
  assert.equal(room.currentTurn, 'b', 'postflop first active left of button');
  stop(room);
});

test('everyone folds to one player -> uncontested win', () => {
  const room = makeRoom({ min: 5, max: 10 });
  seat(room, 'a', 1000); seat(room, 'b', 1000); seat(room, 'c', 1000);
  startGame(room); // pot 15, c posted BB
  performAction(room, 'a', 'FOLD', 0);
  performAction(room, 'b', 'FOLD', 0);
  assert.equal(room.phase, 'SHOWDOWN');
  assert.equal(room.winner, 'c');
  assert.equal(activePlayers(room).length, 1);
  assert.equal(room.currentPlayers.get('c').chips, 1005, 'c wins the 15 pot: 990 + 15');
  assert.equal(room.pot, 0);
  stop(room);
});

test('a new hand can be dealt after SHOWDOWN (no hang) and ready votes reset', () => {
  const room = makeRoom({ min: 5, max: 10 });
  seat(room, 'a', 1000); seat(room, 'b', 1000);
  startGame(room);
  performAction(room, 'a', 'FOLD', 0); // heads-up: button/SB folds, b wins
  assert.equal(room.phase, 'SHOWDOWN');
  room.readyVotes.add('a'); room.readyVotes.add('b'); // simulate both voting next
  const ok = startGame(room);
  assert.equal(ok, true, 'startGame works again from SHOWDOWN');
  assert.equal(room.phase, 'PREFLOP');
  assert.equal(room.readyVotes.size, 0, 'ready votes cleared for the new hand');
  stop(room);
});

// --- settlement (deterministic, bypasses RNG) -------------------------------

// Build a hand at showdown by setting committed / hole cards / board directly.
function showdown(room, { committed, holes, board, folded = [] }) {
  room.handSeats = [...room.currentPlayers.keys()];
  room.phase = 'RIVER';
  room.communityCards = board;
  room.pot = [...Object.values(committed)].reduce((a, b) => a + b, 0);
  for (const [id, amt] of Object.entries(committed)) room.committed.set(id, amt);
  for (const [id, cards] of Object.entries(holes)) room.holeCards.set(id, cards);
  for (const id of folded) room.folded.add(id);
  finishGame(room);
}

test('split pot on a tie (both play the board)', () => {
  const room = makeRoom();
  seat(room, 'a', 900); seat(room, 'b', 900);
  showdown(room, {
    committed: { a: 100, b: 100 },
    holes: { a: [card('2', 'C'), card('3', 'D')], b: [card('2', 'S'), card('3', 'H')] },
    board: [card('A', 'S'), card('K', 'D'), card('Q', 'C'), card('J', 'H'), card('10', 'S')], // A-high straight on board
  });
  assert.equal(room.currentPlayers.get('a').chips, 1000, 'a gets half of 200');
  assert.equal(room.currentPlayers.get('b').chips, 1000, 'b gets half of 200');
  assert.equal(room.winners.length, 2, 'two winners recorded');
  assert.equal(room.pot, 0);
});

test('side pots: short all-in cannot win more than the main pot', () => {
  const room = makeRoom();
  seat(room, 'a', 0); seat(room, 'b', 0); seat(room, 'c', 0); // stacks already committed below
  showdown(room, {
    committed: { a: 100, b: 300, c: 300 }, // a all-in short; b,c match a bigger bet
    holes: {
      a: [card('A', 'S'), card('A', 'D')], // pair of aces (best)
      b: [card('K', 'S'), card('K', 'D')], // pair of kings
      c: [card('Q', 'S'), card('Q', 'D')], // pair of queens (worst)
    },
    board: [card('2', 'C'), card('5', 'D'), card('7', 'S'), card('9', 'H'), card('J', 'C')],
  });
  // main pot = 100*3 = 300 -> a (best). side pot = 200*2 = 400 -> b (best of b,c).
  assert.equal(room.currentPlayers.get('a').chips, 300, 'a wins only the main pot');
  assert.equal(room.currentPlayers.get('b').chips, 400, 'b wins the side pot');
  assert.equal(room.currentPlayers.get('c').chips, 0, 'c wins nothing');
  assert.equal(room.pot, 0);
});

test('folded players forfeit but their chips stay in the pot', () => {
  const room = makeRoom();
  seat(room, 'a', 0); seat(room, 'b', 0); seat(room, 'c', 0);
  showdown(room, {
    committed: { a: 100, b: 100, c: 100 }, // c contributed then folded
    holes: {
      a: [card('A', 'S'), card('A', 'D')],
      b: [card('K', 'S'), card('K', 'D')],
      c: [card('2', 'S'), card('2', 'D')],
    },
    board: [card('5', 'C'), card('8', 'D'), card('9', 'S'), card('J', 'H'), card('Q', 'C')],
    folded: ['c'],
  });
  assert.equal(room.currentPlayers.get('a').chips, 300, 'a wins the whole 300 incl. folded c\'s chips');
  assert.equal(room.currentPlayers.get('b').chips, 0);
  assert.equal(room.winner, 'a');
});
