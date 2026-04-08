const SUITS = ["S", "H", "D", "C"];
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];

const RANK_VALUES = {
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
  7: 7,
  8: 8,
  9: 9,
  T: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};

function parseCard(card) {
  return {
    code: card,
    rank: RANK_VALUES[card[0]],
    suit: card[1],
  };
}

function compareNumberArrays(left, right) {
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;

    if (leftValue !== rightValue) {
      return leftValue > rightValue ? 1 : -1;
    }
  }

  return 0;
}

function getStraightHigh(ranks) {
  const uniqueRanks = [...new Set(ranks)].sort((left, right) => left - right);

  if (uniqueRanks.includes(14)) {
    uniqueRanks.unshift(1);
  }

  let runLength = 1;
  let bestHigh = null;

  for (let index = 1; index < uniqueRanks.length; index += 1) {
    if (uniqueRanks[index] === uniqueRanks[index - 1] + 1) {
      runLength += 1;

      if (runLength >= 5) {
        bestHigh = uniqueRanks[index];
      }
    } else {
      runLength = 1;
    }
  }

  return bestHigh === 1 ? 5 : bestHigh;
}

function getRankCounts(cards) {
  const counts = new Map();

  for (const card of cards) {
    counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([rank, count]) => ({ rank: Number(rank), count }))
    .sort((left, right) => right.count - left.count || right.rank - left.rank);
}

function pickCardsByRanks(parsedCards, orderedRanks) {
  const remainingCards = [...parsedCards].sort((left, right) => right.rank - left.rank);
  const selected = [];

  for (const targetRank of orderedRanks) {
    const wantedRank = targetRank === 1 ? 14 : targetRank;
    const cardIndex = remainingCards.findIndex((card) => card.rank === wantedRank);

    if (cardIndex >= 0) {
      selected.push(remainingCards.splice(cardIndex, 1)[0].code);
    }
  }

  return selected;
}

function orderBestCards(cards, evaluation) {
  const parsedCards = cards.map(parseCard);
  const groups = getRankCounts(parsedCards);

  switch (evaluation.category) {
    case 8: {
      const straightRanks = [];

      for (let rank = evaluation.tiebreak[0]; rank > evaluation.tiebreak[0] - 5; rank -= 1) {
        straightRanks.push(rank === 1 ? 14 : rank);
      }

      return pickCardsByRanks(parsedCards, straightRanks);
    }
    case 7: {
      const quadRank = groups.find((group) => group.count === 4)?.rank;
      const kicker = groups.find((group) => group.count === 1)?.rank;
      return pickCardsByRanks(parsedCards, [quadRank, quadRank, quadRank, quadRank, kicker]);
    }
    case 6: {
      const tripRank = groups.find((group) => group.count === 3)?.rank;
      const pairRank = groups.find((group) => group.count === 2)?.rank;
      return pickCardsByRanks(parsedCards, [tripRank, tripRank, tripRank, pairRank, pairRank]);
    }
    case 5:
    case 0:
      return [...parsedCards]
        .sort((left, right) => right.rank - left.rank)
        .map((card) => card.code);
    case 4: {
      const straightRanks = [];

      for (let rank = evaluation.tiebreak[0]; rank > evaluation.tiebreak[0] - 5; rank -= 1) {
        straightRanks.push(rank === 1 ? 14 : rank);
      }

      return pickCardsByRanks(parsedCards, straightRanks);
    }
    case 3: {
      const tripRank = groups.find((group) => group.count === 3)?.rank;
      const kickers = groups.filter((group) => group.count === 1).map((group) => group.rank);
      return pickCardsByRanks(parsedCards, [tripRank, tripRank, tripRank, ...kickers]);
    }
    case 2: {
      const pairRanks = groups.filter((group) => group.count === 2).map((group) => group.rank);
      const kicker = groups.find((group) => group.count === 1)?.rank;
      return pickCardsByRanks(parsedCards, [pairRanks[0], pairRanks[0], pairRanks[1], pairRanks[1], kicker]);
    }
    case 1: {
      const pairRank = groups.find((group) => group.count === 2)?.rank;
      const kickers = groups.filter((group) => group.count === 1).map((group) => group.rank);
      return pickCardsByRanks(parsedCards, [pairRank, pairRank, ...kickers]);
    }
    default:
      return cards;
  }
}

function evaluateFiveCardHand(cards) {
  const parsedCards = cards.map(parseCard);
  const ranks = parsedCards.map((card) => card.rank);
  const isFlush = parsedCards.every((card) => card.suit === parsedCards[0].suit);
  const straightHigh = getStraightHigh(ranks);
  const groups = getRankCounts(parsedCards);
  const sortedRanks = [...ranks].sort((left, right) => right - left);

  let category = 0;
  let name = "高牌";
  let tiebreak = sortedRanks;

  if (isFlush && straightHigh) {
    category = 8;
    name = straightHigh === 14 && ranks.includes(10) ? "皇家同花顺" : "同花顺";
    tiebreak = [straightHigh];
  } else if (groups[0].count === 4) {
    category = 7;
    name = "四条";
    tiebreak = [groups[0].rank, groups[1].rank];
  } else if (groups[0].count === 3 && groups[1].count === 2) {
    category = 6;
    name = "葫芦";
    tiebreak = [groups[0].rank, groups[1].rank];
  } else if (isFlush) {
    category = 5;
    name = "同花";
    tiebreak = sortedRanks;
  } else if (straightHigh) {
    category = 4;
    name = "顺子";
    tiebreak = [straightHigh];
  } else if (groups[0].count === 3) {
    category = 3;
    name = "三条";
    tiebreak = [
      groups[0].rank,
      ...groups.filter((group) => group.count === 1).map((group) => group.rank),
    ];
  } else if (groups[0].count === 2 && groups[1].count === 2) {
    category = 2;
    name = "两对";
    tiebreak = [
      ...groups.filter((group) => group.count === 2).map((group) => group.rank),
      groups.find((group) => group.count === 1).rank,
    ];
  } else if (groups[0].count === 2) {
    category = 1;
    name = "一对";
    tiebreak = [
      groups[0].rank,
      ...groups.filter((group) => group.count === 1).map((group) => group.rank),
    ];
  }

  const evaluation = { category, name, tiebreak };

  return {
    ...evaluation,
    bestCards: orderBestCards(cards, evaluation),
  };
}

export function compareHandStrength(left, right) {
  if (left.category !== right.category) {
    return left.category > right.category ? 1 : -1;
  }

  return compareNumberArrays(left.tiebreak, right.tiebreak);
}

export function createDeck() {
  const deck = [];

  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push(`${rank}${suit}`);
    }
  }

  return deck;
}

export function shuffleDeck(deck, randomFn = Math.random) {
  const shuffled = [...deck];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(randomFn() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }

  return shuffled;
}

export function evaluateSevenCardHand(cards) {
  if (cards.length !== 7) {
    throw new Error("比牌时必须提供 7 张牌");
  }

  let bestEvaluation = null;

  for (let first = 0; first < cards.length - 4; first += 1) {
    for (let second = first + 1; second < cards.length - 3; second += 1) {
      for (let third = second + 1; third < cards.length - 2; third += 1) {
        for (let fourth = third + 1; fourth < cards.length - 1; fourth += 1) {
          for (let fifth = fourth + 1; fifth < cards.length; fifth += 1) {
            const combo = [cards[first], cards[second], cards[third], cards[fourth], cards[fifth]];
            const evaluation = evaluateFiveCardHand(combo);

            if (!bestEvaluation || compareHandStrength(evaluation, bestEvaluation) > 0) {
              bestEvaluation = evaluation;
            }
          }
        }
      }
    }
  }

  return bestEvaluation;
}
