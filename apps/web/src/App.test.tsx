import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RoomSnapshot } from "@texas-poker/shared";
import { resolveSocketOrigin } from "./App";
import { ActionPanel } from "./components/ActionPanel";
import { CommunityBoard } from "./components/CommunityBoard";

const snapshot: RoomSnapshot = {
  roomCode: "ABC123",
  config: {
    maxPlayers: 9,
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
  it("resolves the socket origin from the browser host unless explicitly overridden", () => {
    expect(resolveSocketOrigin("http://127.0.0.1:5173")).toBe("http://127.0.0.1:3001");
    expect(resolveSocketOrigin("http://127.0.0.1:5173", "https://poker.example.com")).toBe("https://poker.example.com");
  });

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

  it("only shows the start button when every seated player is ready", () => {
    const waitingSnapshot: RoomSnapshot = {
      ...snapshot,
      stage: "waiting",
      actingSeatIndex: null,
      currentBet: 0,
      minRaiseTo: null,
      yourAvailableActions: [],
      seats: [
        snapshot.seats[0]!,
        snapshot.seats[1]!,
        {
          seatIndex: 2,
          occupied: true,
          player: {
            sessionId: "guest-2",
            nickname: "玩家三",
            seatIndex: 2,
            stack: 1000,
            currentBet: 0,
            totalCommitted: 0,
            ready: false,
            isHost: false,
            status: "waiting",
            presence: "connected",
            canAct: false,
            holeCardCount: 2,
            missedHands: 0,
          },
        },
        ...snapshot.seats.slice(3),
      ],
    };

    const blockedMarkup = renderToStaticMarkup(
      <ActionPanel
        snapshot={waitingSnapshot}
        onAction={() => undefined}
        onToggleReady={() => undefined}
        onStartHand={() => undefined}
        onLeaveSeat={() => undefined}
      />,
    );
    expect(blockedMarkup).not.toContain("开始第一手");

    const readyMarkup = renderToStaticMarkup(
      <ActionPanel
        snapshot={{
          ...waitingSnapshot,
          seats: waitingSnapshot.seats.map((seat) =>
            seat.seatIndex === 2 && seat.player
              ? {
                  ...seat,
                  player: {
                    ...seat.player,
                    ready: true,
                  },
                }
              : seat,
          ),
        }}
        onAction={() => undefined}
        onToggleReady={() => undefined}
        onStartHand={() => undefined}
        onLeaveSeat={() => undefined}
      />,
    );
    expect(readyMarkup).toContain("开始第一手");
  });
});
