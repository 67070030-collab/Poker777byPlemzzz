/**
 * Card deck primitives for Texas Hold'em.
 *
 * A card is a plain object `{ rank, suit }` where rank is one of RANKS and
 * suit one of SUITS. Keeping cards as data (not classes) makes them trivial
 * to serialize over the WebSocket to the client.
 */

export const SUITS = ['S', 'H', 'D', 'C'];
export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

/**
 * A freshly shuffled 52-card deck (Fisher–Yates).
 *
 * Note: uses Math.random — fine for a class project / demo, but a real-money
 * game would need a CSPRNG (crypto.randomInt) so hands can't be predicted.
 */
export function shuffledDeck() {
  const deck = RANKS.flatMap((rank) => SUITS.map((suit) => ({ rank, suit })));
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [deck[index], deck[swap]] = [deck[swap], deck[index]];
  }
  return deck;
}
