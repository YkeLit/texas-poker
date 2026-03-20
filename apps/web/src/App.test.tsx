import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RoomSnapshot } from "@texas-poker/shared";
import { parseRoomConfigDraft, resolveSocketOrigin, roomConfigToDraft } from "./App";
import { ActionPanel, createActionPayload, getWagerRange, resolveWagerAmount } from "./components/ActionPanel";
import { CommunityBoard } from "./components/CommunityBoard";
import { SeatRing } from "./components/SeatRing";

const snapshot: RoomSnapshot = {
  roomCode: "ABC123",
  config: {
    maxPlayers: 9,
    startingStack: 1000,
    smallBlind: 10,
    bigBlind: 20,
    actionTimeSeconds: 15,
    rebuyCooldownHands: 2,
  },
  handNumber: 1,
  stage: "preflop",
  dealerSeatIndex: 0,
  smallBlindSeatIndex: 0,
  bigBlindSeatIndex: 1,
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
        rebuyRemainingHands: 0,
        canRebuy: false,
      },
    },
    {
      seatIndex: 1,
      occupied: true,
      player: {
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
        rebuyRemainingHands: 0,
        canRebuy: false,
      },
    },
    { seatIndex: 2, occupied: false },
    { seatIndex: 3, occupied: false },
    { seatIndex: 4, occupied: false },
    { seatIndex: 5, occupied: false },
  ],
  messages: [],
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
    expect(resolveSocketOrigin("https://poker.games.zyyk.fun", "https://poker.wzdl.zyyk.fun")).toBe("https://poker.games.zyyk.fun");
  });

  it("allows empty config drafts and blocks room creation until stack is filled", () => {
    expect(
      parseRoomConfigDraft({
        ...roomConfigToDraft(snapshot.config),
        startingStack: "",
      }),
    ).toBeNull();
  });

  it("parses a valid custom room config draft", () => {
    expect(
      parseRoomConfigDraft({
        startingStack: "3500",
        smallBlind: "25",
        bigBlind: "50",
        actionTimeSeconds: "18",
        rebuyCooldownHands: "3",
      }),
    ).toEqual({
      maxPlayers: 9,
      startingStack: 3500,
      smallBlind: 25,
      bigBlind: 50,
      actionTimeSeconds: 18,
      rebuyCooldownHands: 3,
    });
  });

  it("renders board and pot information", () => {
    const markup = renderToStaticMarkup(
      <CommunityBoard
        board={snapshot.board}
        yourHoleCards={snapshot.yourHoleCards}
        pots={snapshot.pots}
        seats={snapshot.seats}
        yourSeatIndex={snapshot.yourSeatIndex}
        stage={snapshot.stage}
        handNumber={snapshot.handNumber}
      />,
    );
    expect(markup).toContain("底池 30");
    expect(markup).toContain("翻牌前");
    expect(markup).toContain("对手下注");
    expect(markup).toContain("玩家二 20");
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
    expect(markup).toContain("确认加注");
    expect(markup).toContain("本次追加筹码");
    expect(markup).toContain('placeholder="最小 30"');
  });

  it("shows additive raise controls when action returns to the big blind unopened", () => {
    const markup = renderToStaticMarkup(
      <ActionPanel
        snapshot={{
          ...snapshot,
          actingSeatIndex: 1,
          yourSeatIndex: 1,
          yourHoleCards: [
            { rank: 9, suit: "clubs" },
            { rank: 9, suit: "spades" },
          ],
          yourAvailableActions: [
            { type: "fold" },
            { type: "check" },
            { type: "raise", minAmount: 40, maxAmount: 1000 },
          ],
        }}
        onAction={() => undefined}
        onToggleReady={() => undefined}
        onStartHand={() => undefined}
        onLeaveSeat={() => undefined}
      />,
    );

    expect(markup).toContain("过牌");
    expect(markup).toContain("确认加注");
    expect(markup).toContain('placeholder="最小 20"');
    expect(markup).toContain("最小 20，最大 980");
  });

  it("converts additive wager drafts back into target totals for socket actions", () => {
    const raiseAction = { type: "raise", minAmount: 40, maxAmount: 1000 } as const;
    const range = getWagerRange(raiseAction, 20);
    const resolvedAmount = resolveWagerAmount(35, range);

    expect(range).toEqual({ min: 20, max: 980 });
    expect(createActionPayload(raiseAction, resolvedAmount, 20)).toEqual({
      type: "raise",
      amount: 55,
    });
  });

  it("only shows the start button when every seated player is ready", () => {
    const waitingSnapshot: RoomSnapshot = {
      ...snapshot,
      handNumber: 0,
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
            rebuyRemainingHands: 0,
            canRebuy: false,
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

  it("shows the manual next-hand button after showdown", () => {
    const markup = renderToStaticMarkup(
      <ActionPanel
        snapshot={{
          ...snapshot,
          stage: "showdown",
          yourAvailableActions: [],
          seats: snapshot.seats.map((seat) =>
            seat.player
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

    expect(markup).toContain("开始下一手");
  });

  it("renders the latest player action on seat cards", () => {
    const markup = renderToStaticMarkup(
      <SeatRing
        snapshot={{
          ...snapshot,
          seats: snapshot.seats.map((seat) =>
            seat.seatIndex === 1 && seat.player
              ? {
                  ...seat,
                  player: {
                    ...seat.player,
                    lastAction: {
                      label: "加注 80",
                      tone: "aggressive",
                    },
                  },
                }
              : seat,
          ),
        }}
        onTakeSeat={() => undefined}
        currentTime={Date.now()}
      />,
    );

    expect(markup).toContain("加注 80");
  });

  it("does not render the initial seated action label on seat cards", () => {
    const markup = renderToStaticMarkup(
      <SeatRing
        snapshot={{
          ...snapshot,
          seats: snapshot.seats.map((seat) =>
            seat.seatIndex === 1 && seat.player
              ? {
                  ...seat,
                  player: {
                    ...seat.player,
                    lastAction: {
                      label: "已入座",
                      tone: "neutral",
                    },
                  },
                }
              : seat,
          ),
        }}
        onTakeSeat={() => undefined}
        currentTime={Date.now()}
      />,
    );

    expect(markup).not.toContain("已入座");
  });

  it("renders revealed opponent cards on seat cards at showdown", () => {
    const markup = renderToStaticMarkup(
      <SeatRing
        snapshot={{
          ...snapshot,
          stage: "showdown",
          seats: snapshot.seats.map((seat) =>
            seat.seatIndex === 1 && seat.player
              ? {
                  ...seat,
                  player: {
                    ...seat.player,
                    revealedCards: [
                      { rank: 14, suit: "hearts" },
                      { rank: 14, suit: "diamonds" },
                    ],
                  },
                }
              : seat,
          ),
        }}
        onTakeSeat={() => undefined}
        currentTime={Date.now()}
      />,
    );

    expect(markup).toContain("A♥");
    expect(markup).toContain("A♦");
  });

  it("renders hero cards on the self seat and facedown cards for active opponents", () => {
    const markup = renderToStaticMarkup(
      <SeatRing
        snapshot={{
          ...snapshot,
          stage: "preflop",
          seats: snapshot.seats.map((seat) =>
            seat.seatIndex === 1 && seat.player
              ? {
                  ...seat,
                  player: {
                    ...seat.player,
                    holeCardCount: 2,
                  },
                }
              : seat,
          ),
        }}
        onTakeSeat={() => undefined}
        currentTime={Date.now()}
      />,
    );

    expect(markup).toContain("A♠");
    expect(markup).toContain("K♠");
    expect(markup).toContain("is-facedown");
  });

  it("renders dealer and blind badges on occupied seats, including heads-up dealer small blind", () => {
    const markup = renderToStaticMarkup(
      <SeatRing
        snapshot={{
          ...snapshot,
          dealerSeatIndex: 0,
          smallBlindSeatIndex: 0,
          bigBlindSeatIndex: 1,
        }}
        onTakeSeat={() => undefined}
        currentTime={Date.now()}
      />,
    );

    expect(markup).toContain("庄");
    expect(markup).toContain("小盲");
    expect(markup).toContain("大盲");
  });

  it("hides empty seats after the game has started", () => {
    const markup = renderToStaticMarkup(
      <SeatRing
        snapshot={snapshot}
        onTakeSeat={() => undefined}
        currentTime={Date.now()}
      />,
    );

    expect(markup).not.toContain("3号位");
    expect(markup).not.toContain("点击入座");
  });
});
