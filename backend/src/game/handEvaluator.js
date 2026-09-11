/**
 * Poker hand evaluation — pure functions, no game/room state.
 *
 * `handScore` reduces any set of cards (typically a player's 2 hole cards +
 * up to 5 community cards) to a comparable score array. `compareScores` then
 * orders two such arrays. Keeping this module free of side effects means it
 * can be unit-tested on its own without spinning up a table or a socket.
 */

import { RANKS } from './deck.js';

const HAND_NAMES = [
  'High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight',
  'Flush', 'Full house', 'Four of a kind', 'Straight flush',
];

/**
 * Score a hand as `[category, ...tiebreakers]`, higher = better.
 * category: 0 High card … 8 Straight flush. The trailing numbers break ties
 * within the same category (e.g. pair of Kings beats pair of Queens), so two
 * scores can be compared element-by-element with `compareScores`.
 */
export function handScore(cards) {
  const values = cards.map((card) => ({ ...card, value: RANKS.indexOf(card.rank) + 2 }));

  const counts = new Map();
  values.forEach((card) => counts.set(card.value, (counts.get(card.value) || 0) + 1));
  // Sort groups by size then by rank so groups[0] is the most significant.
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  const suits = new Map();
  values.forEach((card) => suits.set(card.suit, [...(suits.get(card.suit) || []), card.value]));
  const flush = [...suits.values()].find((list) => list.length >= 5);

  const unique = [...new Set(values.map((card) => card.value))].sort((a, b) => b - a);

  // Highest card that completes a 5-card straight in `list`, or null.
  // Ace counts high (14) and low (1) so A-2-3-4-5 is recognised.
  const straightHighFor = (list) => {
    const ordered = [...new Set(list)].sort((a, b) => b - a);
    if (ordered.includes(14)) ordered.push(1);
    for (let index = 0; index <= ordered.length - 5; index += 1) {
      if (ordered[index] - ordered[index + 4] === 4) return ordered[index];
    }
    return null;
  };

  const straightHigh = straightHighFor(unique);
  const straightFlushHigh = [...suits.values()]
    .filter((list) => list.length >= 5)
    .map(straightHighFor)
    .find((high) => high !== null);

  if (straightFlushHigh) return [8, straightFlushHigh];
  if (groups[0]?.[1] === 4) return [7, groups[0][0]];
  if (groups[0]?.[1] === 3 && groups[1]?.[1] >= 2) return [6, groups[0][0], groups[1][0]];
  if (flush) return [5, ...flush.sort((a, b) => b - a).slice(0, 5)];
  if (straightHigh) return [4, straightHigh];
  if (groups[0]?.[1] === 3) return [3, groups[0][0]];
  if (groups[0]?.[1] === 2 && groups[1]?.[1] === 2) return [2, groups[0][0], groups[1][0]];
  if (groups[0]?.[1] === 2) return [1, groups[0][0]];
  return [0, ...unique.slice(0, 5)];
}

/** Compare two `handScore` results. >0 if left wins, <0 if right wins, 0 tie. */
export function compareScores(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

/** Human-readable name for a hand category (the first element of handScore). */
export function handName(category) {
  return HAND_NAMES[category] || 'High card';
}
