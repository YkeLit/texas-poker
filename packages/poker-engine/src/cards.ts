import { randomInt } from "node:crypto";
import type { Card, Suit } from "@texas-poker/shared";

const SUITS: Suit[] = ["clubs", "diamonds", "hearts", "spades"];
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] as const;

export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

export function shuffleDeck(sourceDeck = createDeck()): Card[] {
  const deck = [...sourceDeck];
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    const current = deck[index];
    deck[index] = deck[swapIndex]!;
    deck[swapIndex] = current!;
  }
  return deck;
}

export function cardToString(card: Card): string {
  const rankLabel = card.rank <= 10 ? String(card.rank) : ({ 11: "J", 12: "Q", 13: "K", 14: "A" }[card.rank] ?? "?");
  const suitLabel = {
    clubs: "♣",
    diamonds: "♦",
    hearts: "♥",
    spades: "♠",
  }[card.suit];
  return `${rankLabel}${suitLabel}`;
}
