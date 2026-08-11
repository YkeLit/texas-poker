/* @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomSnapshot, RoomSummary } from "@texas-poker/shared";
import App from "./App";

const { mockIo } = vi.hoisted(() => ({ mockIo: vi.fn() }));
vi.mock("socket.io-client", () => ({ io: mockIo }));

const summary: RoomSummary = {
  protocolVersion: 1,
  roomId: "room-1",
  roomCode: "ABC123",
  status: "lobby",
  revision: 0,
  participantId: "participant-1",
};

const snapshot: RoomSnapshot = {
  ...summary,
  capabilities: ["multi-connection"],
  config: { maxPlayers: 9, startingStack: 1000, smallBlind: 10, bigBlind: 20, actionTimeSeconds: 15, rebuyCooldownHands: 2 },
  handNumber: 0,
  stage: "waiting",
  dealerSeatIndex: null,
  smallBlindSeatIndex: null,
  bigBlindSeatIndex: null,
  actingSeatIndex: null,
  actionDeadlineAt: null,
  minRaiseTo: null,
  currentBet: 0,
  board: [],
  pots: [],
  seats: Array.from({ length: 9 }, (_, seatIndex) => ({ seatIndex, occupied: false })),
  messages: [],
  yourSeatIndex: null,
  yourHoleCards: [],
  yourAvailableActions: [],
};

describe("App unified guest flow", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const values = new Map<string, string>();
    const storage: Storage = {
      get length() { return values.size; },
      clear: () => values.clear(),
      getItem: (key) => values.get(key) ?? null,
      key: (index) => [...values.keys()][index] ?? null,
      removeItem: (key) => { values.delete(key); },
      setItem: (key, value) => { values.set(key, String(value)); },
    };
    vi.stubGlobal("localStorage", storage);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    localStorage.clear();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mockIo.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("does not persist a guest token or participant identity in localStorage", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ activeRoom: null }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await act(async () => { root.render(<App />); await Promise.resolve(); });
    expect(container.querySelector("#nickname-input")).not.toBeNull();
    expect(localStorage.getItem("texas-poker.session")).toBeNull();
    expect(localStorage.getItem("texas-poker.roomCode")).toBeNull();
  });

  it("automatically attaches the HttpOnly cookie guest to its active room", async () => {
    const listeners = new Map<string, (payload: unknown) => void>();
    const emitWithAck = vi.fn(async () => ({ ok: true, roomId: summary.roomId }));
    fetchMock.mockResolvedValue(new Response(JSON.stringify(summary), { status: 200, headers: { "Content-Type": "application/json" } }));
    mockIo.mockReturnValue({
      on: vi.fn((event: string, listener: (payload: unknown) => void) => listeners.set(event, listener)),
      emitWithAck,
      disconnect: vi.fn(),
    });
    await act(async () => { root.render(<App />); await Promise.resolve(); await Promise.resolve(); });
    expect(emitWithAck).toHaveBeenCalledWith("room.attach", { roomId: summary.roomId });
    await act(async () => { listeners.get("state.snapshot")?.(snapshot); await Promise.resolve(); });
    expect(container.textContent).toContain(`房号 ${summary.roomCode}`);
    expect(localStorage.getItem("texas-poker.roomCode")).toBe(summary.roomCode);
    expect(localStorage.getItem("texas-poker.session")).toBeNull();
  });
});
