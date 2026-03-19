/* @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestSession, RoomSnapshot } from "@texas-poker/shared";
import App from "./App";

const { mockIo } = vi.hoisted(() => ({
  mockIo: vi.fn(),
}));

vi.mock("socket.io-client", () => ({
  io: mockIo,
}));

const session: GuestSession = {
  sessionId: "session-1",
  nickname: "旧昵称",
  resumeToken: "resume-token",
  createdAt: "2026-03-19T00:00:00.000Z",
};

const roomSnapshot: RoomSnapshot = {
  roomCode: "ABC123",
  config: {
    maxPlayers: 9,
    startingStack: 1000,
    smallBlind: 10,
    bigBlind: 20,
    actionTimeSeconds: 15,
    rebuyCooldownHands: 2,
  },
  hostSessionId: session.sessionId,
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
  pots: [],
  seats: [
    {
      seatIndex: 0,
      occupied: true,
      player: {
        sessionId: session.sessionId,
        nickname: session.nickname,
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
        sessionId: "session-2",
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
  ],
  messages: [],
  yourSessionId: session.sessionId,
  yourSeatIndex: 0,
  yourHoleCards: [
    { rank: 14, suit: "spades" },
    { rank: 13, suit: "spades" },
  ],
  yourAvailableActions: [],
};

describe("App lobby rename flow", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;
  const reactTestGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    localStorage.clear();
    reactTestGlobals.IS_REACT_ACT_ENVIRONMENT = true;
    mockIo.mockReset();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    delete reactTestGlobals.IS_REACT_ACT_ENVIRONMENT;
    localStorage.clear();
  });

  it("allows saving a nickname change from the lobby", async () => {
    localStorage.setItem("texas-poker.session", JSON.stringify(session));
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ...session, nickname: "新昵称" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await act(async () => {
      root.render(<App />);
    });

    const input = container.querySelector("#nickname-input") as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.disabled).toBe(false);
    expect(input.value).toBe("旧昵称");
    expect(container.textContent).not.toContain("保存昵称");

    const setInputValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setInputValue?.call(input, "新昵称");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const saveButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "保存昵称");
    expect(saveButton).toBeDefined();
    expect(saveButton?.hasAttribute("disabled")).toBe(false);

    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/guest/sessions/${session.sessionId}`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ nickname: "新昵称", resumeToken: session.resumeToken }),
      }),
    );
    expect(container.textContent).toContain("当前身份：新昵称");
    expect(container.textContent).not.toContain("保存昵称");
  });

  it("does not render rename controls after auto-rejoining a room", async () => {
    localStorage.setItem("texas-poker.session", JSON.stringify(session));
    localStorage.setItem("texas-poker.roomCode", roomSnapshot.roomCode);

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ roomCode: roomSnapshot.roomCode, wsToken: "token", snapshot: roomSnapshot }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    mockIo.mockReturnValue({
      on: vi.fn(),
      emitWithAck: vi.fn(async (event: string) => {
        if (event === "room.join" || event === "session.resume") {
          return { ok: true, snapshot: roomSnapshot };
        }
        return { ok: true };
      }),
      disconnect: vi.fn(),
    });

    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector("#nickname-input")).toBeNull();
    expect(container.textContent).not.toContain("保存昵称");
    expect(container.textContent).toContain(`房号 ${roomSnapshot.roomCode}`);
  });
});
