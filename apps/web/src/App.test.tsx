import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RoomSnapshot } from "@texas-poker/shared";
import { ActionPanel } from "./components/ActionPanel";
import { CommunityBoard } from "./components/CommunityBoard";

const snapshot: RoomSnapshot = {
  roomCode: "ABC123",
  config: {
    maxPlayers: 6,
    startingStack: 1000,
    smallBlind: 10,
    bigBlind: 20,
    actionTimeSeconds: 15,
  },
  hostSessionId: "host",
  handNumber: 1,
  stage: "preflop",
  dealerSeatIndex: 0,
  actingSeatIndex: 0,
  actionDeadlineAt: null,
  minRaiseTo: 40,
  currentBet: 20,
  board: [],
  pots: [{ amount: 30, eligibleSeatIndexes: [0, 1] }],
  seats: [
    {
      seatIndex: 0,
      occupied: true,
      player: {
        sessionId: "host",
        nickname: "房主",
        seatIndex: 0,
        stack: 990,
        currentBet: 10,
        totalCommitted: 10,
        ready: true,
        isHost: true,
        status: "active",
        presence: "connected",
        canAct: true,
        holeCardCount: 2,
        missedHands: 0,
      },
    },
    {
      seatIndex: 1,
      occupied: true,
      player: {
        sessionId: "guest",
        nickname: "玩家二",
        seatIndex: 1,
        stack: 980,
        currentBet: 20,
        totalCommitted: 20,
        ready: true,
        isHost: false,
        status: "active",
        presence: "connected",
        canAct: false,
        holeCardCount: 2,
        missedHands: 0,
      },
    },
    { seatIndex: 2, occupied: false },
    { seatIndex: 3, occupied: false },
    { seatIndex: 4, occupied: false },
    { seatIndex: 5, occupied: false },
  ],
  messages: [],
  yourSessionId: "host",
  yourSeatIndex: 0,
  yourHoleCards: [
    { rank: 14, suit: "spades" },
    { rank: 13, suit: "spades" },
  ],
  yourAvailableActions: [
    { type: "fold" },
    { type: "call", minAmount: 10, maxAmount: 10 },
    { type: "raise", minAmount: 40, maxAmount: 1000 },
  ],
};

describe("web components", () => {
  it("renders board and pot information", () => {
    const markup = renderToStaticMarkup(<CommunityBoard board={snapshot.board} pots={snapshot.pots} stage={snapshot.stage} handNumber={snapshot.handNumber} />);
    expect(markup).toContain("底池 30");
    expect(markup).toContain("翻牌前");
  });

  it("renders action buttons for the acting player", () => {
    const markup = renderToStaticMarkup(
      <ActionPanel
        snapshot={snapshot}
        onAction={() => undefined}
        onToggleReady={() => undefined}
        onStartHand={() => undefined}
        onLeaveSeat={() => undefined}
      />,
    );

    expect(markup).toContain("弃牌");
    expect(markup).toContain("跟注 10");
    expect(markup).toContain("加注 40-1000");
  });
});
