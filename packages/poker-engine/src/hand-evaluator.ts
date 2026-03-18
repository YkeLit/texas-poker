import type { Card } from "@texas-poker/shared";

export interface HandStrength {
  category: number;
  kickers: number[];
  name: string;
  cards: Card[];
}

const CATEGORY_NAMES = [
  "高牌",
  "一对",
  "两对",
  "三条",
  "顺子",
  "同花",
  "葫芦",
  "四条",
  "同花顺",
] as const;

function getUniqueRanks(cards: Card[]): number[] {
  return [...new Set(cards.map((card) => card.rank))].sort((left, right) => right - left);
}

function detectStraight(cards: Card[]): number | null {
  const uniqueRanks = getUniqueRanks(cards);
  const straightRanks = uniqueRanks.includes(14) ? [...uniqueRanks, 1] : uniqueRanks;

  let streak = 1;
  for (let index = 1; index < straightRanks.length; index += 1) {
    const previousRank = straightRanks[index - 1]!;
    const currentRank = straightRanks[index]!;
    if (previousRank - currentRank === 1) {
      streak += 1;
      if (streak >= 5) {
        return previousRank + 1 === 5 ? 5 : previousRank + 1;
      }
    } else {
      streak = 1;
    }
  }

  return null;
}

function compareValues(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    if (leftValue !== rightValue) {
      return leftValue - rightValue;
    }
  }
  return 0;
}

function evaluateFiveCards(cards: Card[]): HandStrength {
  const sortedCards = [...cards].sort((left, right) => right.rank - left.rank);
  const rankCounts = new Map<number, number>();
  for (const card of sortedCards) {
    rankCounts.set(card.rank, (rankCounts.get(card.rank) ?? 0) + 1);
  }

  const groups = [...rankCounts.entries()]
    .map(([rank, count]) => ({ rank, count }))
    .sort((left, right) => {
      if (left.count !== right.count) {
        return right.count - left.count;
      }
      return right.rank - left.rank;
    });

  const isFlush = sortedCards.every((card) => card.suit === sortedCards[0]!.suit);
  const straightHigh = detectStraight(sortedCards);

  if (isFlush && straightHigh !== null) {
    return { category: 8, kickers: [straightHigh], name: CATEGORY_NAMES[8], cards: sortedCards };
  }

  if (groups[0]?.count === 4) {
    const kicker = groups.find((group) => group.count === 1)?.rank ?? 0;
    return { category: 7, kickers: [groups[0].rank, kicker], name: CATEGORY_NAMES[7], cards: sortedCards };
  }

  if (groups[0]?.count === 3 && groups[1]?.count === 2) {
    return { category: 6, kickers: [groups[0].rank, groups[1].rank], name: CATEGORY_NAMES[6], cards: sortedCards };
  }

  if (isFlush) {
    return { category: 5, kickers: sortedCards.map((card) => card.rank), name: CATEGORY_NAMES[5], cards: sortedCards };
  }

  if (straightHigh !== null) {
    return { category: 4, kickers: [straightHigh], name: CATEGORY_NAMES[4], cards: sortedCards };
  }

  if (groups[0]?.count === 3) {
    const kickers = groups.filter((group) => group.count === 1).map((group) => group.rank);
    return { category: 3, kickers: [groups[0].rank, ...kickers], name: CATEGORY_NAMES[3], cards: sortedCards };
  }

  if (groups[0]?.count === 2 && groups[1]?.count === 2) {
    const remaining = groups.find((group) => group.count === 1)?.rank ?? 0;
    const pairRanks = groups.filter((group) => group.count === 2).map((group) => group.rank);
    return { category: 2, kickers: [...pairRanks, remaining], name: CATEGORY_NAMES[2], cards: sortedCards };
  }

  if (groups[0]?.count === 2) {
    const kickers = groups.filter((group) => group.count === 1).map((group) => group.rank);
    return { category: 1, kickers: [groups[0].rank, ...kickers], name: CATEGORY_NAMES[1], cards: sortedCards };
  }

  return { category: 0, kickers: sortedCards.map((card) => card.rank), name: CATEGORY_NAMES[0], cards: sortedCards };
}

function combinations(cards: Card[], size: number): Card[][] {
  if (size === 0) {
    return [[]];
  }
  if (cards.length < size) {
    return [];
  }

  const result: Card[][] = [];
  for (let index = 0; index <= cards.length - size; index += 1) {
    const current = cards[index]!;
    const tail = combinations(cards.slice(index + 1), size - 1);
    for (const item of tail) {
      result.push([current, ...item]);
    }
  }
  return result;
}

export function compareHandStrength(left: HandStrength, right: HandStrength): number {
  if (left.category !== right.category) {
    return left.category - right.category;
  }
  return compareValues(left.kickers, right.kickers);
}

export function evaluateSevenCards(cards: Card[]): HandStrength {
  if (cards.length < 5 || cards.length > 7) {
    throw new Error("Seven-card evaluator expects between 5 and 7 cards");
  }

  let best = evaluateFiveCards(cards.slice(0, 5));
  for (const combo of combinations(cards, 5)) {
    const candidate = evaluateFiveCards(combo);
    if (compareHandStrength(candidate, best) > 0) {
      best = candidate;
    }
  }
  return best;
}
