import { describe, expect, it } from "vitest";
import type { Card, RoomConfig } from "@texas-poker/shared";
import { applyPlayerAction, canRebuyChips, canStartHand, createPokerEngine, getAvailableActions, rebuyChips, seatPlayer, setPlayerReady, startHand } from "../src/engine";
import { evaluateSevenCards } from "../src/hand-evaluator";

const config: RoomConfig = {
  maxPlayers: 9,
  startingStack: 1000,
  smallBlind: 10,
  bigBlind: 20,
  actionTimeSeconds: 15,
  rebuyCooldownHands: 1,
};

function setupTable(playerCount = 3) {
  const state = createPokerEngine({ ...config, maxPlayers: Math.max(playerCount, 2) });
  for (let index = 0; index < playerCount; index += 1) {
    seatPlayer(state, {
      sessionId: `session-${index}`,
      nickname: `玩家${index + 1}`,
      seatIndex: index,
      isHost: index === 0,
    });
    setPlayerReady(state, index, true);
  }
  startHand(state, new Date("2026-03-18T12:00:00.000Z"));
  return state;
}

describe("hand evaluator", () => {
  it("prefers straight flush over full house", () => {
    const straightFlush = evaluateSevenCards([
      asCard("hearts", 10),
      asCard("hearts", 11),
      asCard("hearts", 12),
      asCard("hearts", 13),
      asCard("hearts", 14),
      asCard("spades", 2),
      asCard("clubs", 2),
    ]);
    const fullHouse = evaluateSevenCards([
      asCard("clubs", 14),
      asCard("diamonds", 14),
      asCard("hearts", 14),
      asCard("spades", 13),
      asCard("clubs", 13),
      asCard("spades", 5),
      asCard("clubs", 6),
    ]);

    expect(straightFlush.category).toBeGreaterThan(fullHouse.category);
  });

  it("uses kickers to break a pair tie", () => {
    const stronger = evaluateSevenCards([
      asCard("hearts", 14),
      asCard("spades", 14),
      asCard("clubs", 13),
      asCard("diamonds", 9),
      asCard("clubs", 8),
      asCard("spades", 4),
      asCard("clubs", 2),
    ]);
    const weaker = evaluateSevenCards([
      asCard("hearts", 14),
      asCard("spades", 14),
      asCard("clubs", 12),
      asCard("diamonds", 9),
      asCard("clubs", 8),
      asCard("spades", 4),
      asCard("clubs", 2),
    ]);

    expect(stronger.kickers[1]).toBeGreaterThan(weaker.kickers[1]);
  });
});

describe("poker engine", () => {
  it("rejects seat indexes outside the table size", () => {
    const state = createPokerEngine({ ...config, maxPlayers: 2 });

    expect(() =>
      seatPlayer(state, {
        sessionId: "session-out-of-range",
        nickname: "越界玩家",
        seatIndex: 8,
      })
    ).toThrow("Seat index is out of range");
  });

  it("uses dealer as the small blind in heads-up play", () => {
    const state = setupTable(2);
    expect(state.dealerSeatIndex).toBe(0);
    expect(state.smallBlindSeatIndex).toBe(0);
    expect(state.bigBlindSeatIndex).toBe(1);
    expect(state.actingSeatIndex).toBe(0);
  });

  it("requires every seated player to be ready before a hand can start", () => {
    const state = createPokerEngine(config);

    for (let index = 0; index < 3; index += 1) {
      seatPlayer(state, {
        sessionId: `session-${index}`,
        nickname: `玩家${index + 1}`,
        seatIndex: index,
        isHost: index === 0,
      });
    }

    setPlayerReady(state, 0, true);
    setPlayerReady(state, 1, true);
    expect(canStartHand(state)).toBe(false);
    expect(() => startHand(state, new Date("2026-03-18T12:00:00.000Z"))).toThrow(
      "All seated players must be connected and ready, with at least two players",
    );

    setPlayerReady(state, 2, true);
    expect(canStartHand(state)).toBe(true);
  });

  it("keeps the big blind's raise option open when action returns unopened", () => {
    const state = setupTable(3);

    const openingActions = getAvailableActions(state, 0);
    const openingRaise = openingActions.find((action) => action.type === "raise");
    expect(openingRaise?.minAmount).toBe(40);

    applyPlayerAction(state, 0, { type: "call" }, new Date("2026-03-18T12:00:01.000Z"));
    applyPlayerAction(state, 1, { type: "call" }, new Date("2026-03-18T12:00:02.000Z"));

    expect(state.actingSeatIndex).toBe(2);
    const blindActions = getAvailableActions(state, 2);
    expect(blindActions.some((action) => action.type === "raise")).toBe(true);
  });

  it("builds side pots and awards them correctly", () => {
    const state = setupTable(3);
    const seat0 = state.seats[0]!;
    const seat1 = state.seats[1]!;
    const seat2 = state.seats[2]!;

    seat1.stack = 30;
    seat1.currentBet = 10;
    seat2.stack = 980;
    seat2.currentBet = 20;

    seat0.holeCards = [asCard("clubs", 14), asCard("clubs", 12)];
    seat1.holeCards = [asCard("spades", 14), asCard("diamonds", 14)];
    seat2.holeCards = [asCard("hearts", 13), asCard("hearts", 12)];
    state.deck = [
      asCard("hearts", 14),
      asCard("diamonds", 13),
      asCard("clubs", 7),
      asCard("spades", 2),
      asCard("diamonds", 3),
    ];

    applyPlayerAction(state, 0, { type: "all_in" }, new Date("2026-03-18T12:00:01.000Z"));
    applyPlayerAction(state, 1, { type: "all_in" }, new Date("2026-03-18T12:00:02.000Z"));
    applyPlayerAction(state, 2, { type: "call" }, new Date("2026-03-18T12:00:03.000Z"));

    expect(state.stage).toBe("showdown");
    expect(state.lastResult?.pots.map((pot) => pot.amount)).toEqual([120, 1920]);
    expect(state.seats[0]?.stack).toBe(1920);
    expect(state.seats[1]?.stack).toBe(120);
    expect(state.seats[2]?.stack).toBe(0);
  });

  it("splits the pot evenly when the board plays", () => {
    const state = setupTable(2);
    const seat0 = state.seats[0]!;
    const seat1 = state.seats[1]!;

    seat0.stack = 990;
    seat0.currentBet = 10;
    seat1.stack = 980;
    seat1.currentBet = 20;
    seat0.holeCards = [asCard("clubs", 2), asCard("diamonds", 7)];
    seat1.holeCards = [asCard("spades", 3), asCard("hearts", 8)];
    state.deck = [
      asCard("hearts", 10),
      asCard("spades", 11),
      asCard("diamonds", 12),
      asCard("clubs", 13),
      asCard("hearts", 14),
    ];

    applyPlayerAction(state, 0, { type: "all_in" }, new Date("2026-03-18T12:00:01.000Z"));
    applyPlayerAction(state, 1, { type: "call" }, new Date("2026-03-18T12:00:02.000Z"));

    expect(state.lastResult?.winners).toHaveLength(2);
    expect(state.seats[0]?.stack).toBe(1000);
    expect(state.seats[1]?.stack).toBe(1000);
  });

  it("resets the table for the next hand", () => {
    const state = setupTable(2);
    applyPlayerAction(state, 0, { type: "fold" }, new Date("2026-03-18T12:00:01.000Z"));

    expect(state.stage).toBe("showdown");
    const completedHandNumber = state.handNumber;

    startHand(state, new Date("2026-03-18T12:00:10.000Z"));
    expect(state.handNumber).toBe(completedHandNumber + 1);
    expect(state.stage).toBe("preflop");
    expect(state.board).toHaveLength(0);
    expect(state.seats[0]?.holeCards).toHaveLength(2);
    expect(state.seats[1]?.holeCards).toHaveLength(2);
  });

  it("requires waiting hands before busted players can rebuy", () => {
    const state = setupTable(3);
    const seat0 = state.seats[0]!;
    const seat1 = state.seats[1]!;
    const seat2 = state.seats[2]!;

    seat0.stack = 20;
    seat0.currentBet = 10;
    seat1.stack = 2000;
    seat1.currentBet = 20;
    seat2.stack = 20;
    seat2.currentBet = 0;

    seat0.holeCards = [asCard("clubs", 2), asCard("diamonds", 7)];
    seat1.holeCards = [asCard("spades", 14), asCard("hearts", 14)];
    seat2.holeCards = [asCard("clubs", 9), asCard("spades", 9)];
    state.deck = [
      asCard("hearts", 10),
      asCard("spades", 11),
      asCard("diamonds", 12),
      asCard("clubs", 13),
      asCard("hearts", 3),
    ];

    applyPlayerAction(state, 0, { type: "all_in" }, new Date("2026-03-18T12:00:01.000Z"));
    applyPlayerAction(state, 1, { type: "call" }, new Date("2026-03-18T12:00:02.000Z"));
    applyPlayerAction(state, 2, { type: "all_in" }, new Date("2026-03-18T12:00:03.000Z"));

    expect(state.seats[0]?.status).toBe("out");
    expect(state.seats[0]?.stack).toBe(0);
    expect(state.seats[0]?.rebuyHandsRemaining).toBe(1);
    expect(canRebuyChips(state, 0)).toBe(false);

    startHand(state, new Date("2026-03-18T12:00:10.000Z"));
    applyPlayerAction(state, 1, { type: "fold" }, new Date("2026-03-18T12:00:11.000Z"));

    expect(state.seats[0]?.rebuyHandsRemaining).toBe(0);
    expect(canRebuyChips(state, 0)).toBe(true);

    rebuyChips(state, 0);
    expect(state.seats[0]?.stack).toBe(1000);
    expect(state.seats[0]?.status).toBe("waiting");
    expect(state.seats[0]?.ready).toBe(false);
  });
});

function asCard(suit: Card["suit"], rank: number): Card {
  return { suit, rank };
}
