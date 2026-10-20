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
      timeout: vi.fn().mockReturnThis(),
      disconnect: vi.fn(),
      connect: vi.fn(() => listeners.get("connect")?.(undefined)),
    });
    await act(async () => { root.render(<App />); await Promise.resolve(); await Promise.resolve(); });
    expect(emitWithAck).toHaveBeenCalledWith("room.attach", { roomId: summary.roomId });
    await act(async () => { listeners.get("state.snapshot")?.(snapshot); await Promise.resolve(); });
    expect(container.textContent).toContain(`房号 ${summary.roomCode}`);
    expect(localStorage.getItem("texas-poker.roomCode")).toBe(summary.roomCode);
    expect(localStorage.getItem("texas-poker.session")).toBeNull();
    await act(async () => { listeners.get("connect")?.(undefined); await Promise.resolve(); });
    expect(emitWithAck).toHaveBeenCalledTimes(2);
    expect(emitWithAck).toHaveBeenLastCalledWith("room.attach", { roomId: summary.roomId });
  });

  it("reattaches after the first room attach is interrupted", async () => {
    const listeners = new Map<string, (payload: unknown) => void>();
    const emitWithAck = vi.fn()
      .mockRejectedValueOnce(new Error("socket has been disconnected"))
      .mockResolvedValue({ ok: true, roomId: summary.roomId });
    fetchMock.mockResolvedValue(new Response(JSON.stringify(summary), { status: 200 }));
    mockIo.mockReturnValue({
      on: vi.fn((event: string, listener: (payload: unknown) => void) => listeners.set(event, listener)),
      emitWithAck,
      timeout: vi.fn().mockReturnThis(),
      disconnect: vi.fn(),
      connect: vi.fn(() => listeners.get("connect")?.(undefined)),
    });
    await act(async () => { root.render(<App />); await Promise.resolve(); await Promise.resolve(); });
    expect(emitWithAck).toHaveBeenCalledTimes(1);
    await act(async () => { listeners.get("connect")?.(undefined); await Promise.resolve(); });
    expect(emitWithAck).toHaveBeenCalledTimes(2);
    await act(async () => { listeners.get("state.snapshot")?.(snapshot); });
    expect(container.textContent).toContain(`房号 ${summary.roomCode}`);
    expect(container.textContent).not.toContain("socket has been disconnected");
  });

  for (const failure of ["http", "network"]) {
    it(`keeps the room and connection when leaving fails (${failure}), then allows retry`, async () => {
      const listeners = new Map<string, (payload: unknown) => void>();
      const disconnect = vi.fn();
      const emitWithAck = vi.fn(async () => ({ ok: true, roomId: summary.roomId }));
      fetchMock.mockResolvedValue(new Response(JSON.stringify(summary), { status: 200 }));
      mockIo.mockReturnValue({
        on: vi.fn((event: string, listener: (payload: unknown) => void) => listeners.set(event, listener)),
        emitWithAck,
        timeout: vi.fn().mockReturnThis(),
        disconnect,
        connect: vi.fn(() => listeners.get("connect")?.(undefined)),
      });
      await act(async () => { root.render(<App />); await Promise.resolve(); await Promise.resolve(); });
      await act(async () => { listeners.get("state.snapshot")?.(snapshot); });
      const message = "退出请求失败";
      if (failure === "http") {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message } }), { status: 503 }));
      } else {
        fetchMock.mockRejectedValueOnce(new Error(message));
      }
      const exitButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "退出房间")!;
      await act(async () => { exitButton.click(); await Promise.resolve(); });
      expect(container.textContent).toContain(message);
      expect(container.textContent).toContain(`房号 ${summary.roomCode}`);
      expect(container.textContent).not.toContain("已退出房间。");
      expect(localStorage.getItem("texas-poker.roomCode")).toBe(summary.roomCode);
      expect(disconnect).not.toHaveBeenCalled();
      expect(emitWithAck).toHaveBeenCalledTimes(1);

      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await act(async () => { exitButton.click(); await Promise.resolve(); });
      expect(disconnect).toHaveBeenCalledOnce();
      expect(localStorage.getItem("texas-poker.roomCode")).toBeNull();
      expect(container.textContent).toContain("已退出房间。");
      expect(container.textContent).not.toContain(`房号 ${summary.roomCode}`);
    });
  }

  it("locks one leave request and ignores retired-socket events and a late success after member removal", async () => {
    const listeners = new Map<string, (payload: unknown) => void>();
    const disconnect = vi.fn();
    const emitWithAck = vi.fn(async () => ({ ok: true, roomId: summary.roomId }));
    mockIo.mockReturnValue({
      on: vi.fn((event: string, listener: (payload: unknown) => void) => listeners.set(event, listener)),
      emitWithAck, timeout: vi.fn().mockReturnThis(), disconnect,
      connect: vi.fn(() => listeners.get("connect")?.(undefined)),
    });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(summary), { status: 200 }));
    await act(async () => { root.render(<App />); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { listeners.get("state.snapshot")?.(snapshot); });
    let release!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>(resolve => { release = resolve; }));
    const exit = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "退出房间")!;
    await act(async () => { exit.click(); exit.click(); await Promise.resolve(); });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/leave"))).toHaveLength(1);
    expect(container.querySelector("fieldset")?.disabled).toBe(true);
    expect(exit.disabled).toBe(true);
    await act(async () => { listeners.get("room.expired")?.({ roomId: "other-room", reason: "left" }); });
    expect(container.textContent).toContain(`房号 ${summary.roomCode}`);
    await act(async () => { listeners.get("room.expired")?.({ roomId: summary.roomId, reason: "left" }); });
    expect(container.textContent).toContain("已退出房间。");
    expect(localStorage.getItem("texas-poker.roomCode")).toBeNull();
    await act(async () => {
      listeners.get("state.snapshot")?.(snapshot);
      release(new Response(null, { status: 204 }));
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain(`房号 ${summary.roomCode}`);
    expect(localStorage.getItem("texas-poker.roomCode")).toBeNull();
    expect(disconnect).toHaveBeenCalledOnce();
  });


  it("does not treat an anonymous active-room response as confirmation of a 401 leave", async () => {
    const listeners = new Map<string, (payload: unknown) => void>();
    const disconnect = vi.fn();
    mockIo.mockReturnValue({
      on: vi.fn((event: string, listener: (payload: unknown) => void) => listeners.set(event, listener)),
      emitWithAck: vi.fn(async () => ({ ok: true, roomId: summary.roomId })),
      timeout: vi.fn().mockReturnThis(), disconnect,
      connect: vi.fn(() => listeners.get("connect")?.(undefined)),
    });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(summary), { status: 200 }));
    await act(async () => { root.render(<App />); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { listeners.get("state.snapshot")?.(snapshot); });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Session expired" } }), { status: 401 }));
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ activeRoom: null }), { status: 200 }));
    const exit = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "退出房间")!;
    await act(async () => { exit.click(); await Promise.resolve(); });
    expect(container.textContent).toContain("会话已失效，无法确认退出");
    expect(container.textContent).toContain(`房号 ${summary.roomCode}`);
    expect(container.textContent).not.toContain("已退出房间。");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("replaces the connection on manual recovery and waits for the new snapshot before enabling commands", async () => {
    const sockets: Array<{ listeners: Map<string, (payload: unknown) => void>; disconnect: ReturnType<typeof vi.fn>; emitWithAck: ReturnType<typeof vi.fn> }> = [];
    mockIo.mockImplementation(() => {
      const listeners = new Map<string, (payload: unknown) => void>();
      const socket = {
        listeners, connected: true, disconnect: vi.fn(),
        emitWithAck: vi.fn(async () => ({ ok: true, roomId: summary.roomId })),
        timeout: vi.fn().mockReturnThis(),
        on: vi.fn((event: string, listener: (payload: unknown) => void) => listeners.set(event, listener)),
        connect: vi.fn(() => listeners.get("connect")?.(undefined)),
      };
      sockets.push(socket);
      return socket;
    });
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(summary), { status: 200 }));
    await act(async () => { root.render(<App />); });
    await act(async () => { sockets[0]!.listeners.get("state.snapshot")?.(snapshot); });
    expect(container.querySelector("fieldset")?.disabled).toBe(false);
    await act(async () => { sockets[0]!.listeners.get("disconnect")?.(undefined); });
    expect(container.querySelector("fieldset")?.disabled).toBe(true);
    const retry = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "重新连接")!;
    expect(document.activeElement).toBe(retry);
    let release!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>(resolve => { release = resolve; }));
    await act(async () => { retry.click(); retry.click(); });
    await act(async () => { sockets[0]!.listeners.get("state.snapshot")?.(snapshot); });
    expect(container.querySelector("fieldset")?.disabled).toBe(true);
    expect(sockets[0]!.disconnect).toHaveBeenCalledOnce();
    await act(async () => { release(new Response(JSON.stringify(summary), { status: 200 })); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(2);
    expect(sockets[0]!.disconnect).toHaveBeenCalledOnce();
    expect(sockets[1]!.emitWithAck).toHaveBeenCalledExactlyOnceWith("room.attach", { roomId: summary.roomId });
    expect(container.querySelector("fieldset")?.disabled).toBe(true);
    await act(async () => { sockets[0]!.listeners.get("state.snapshot")?.(snapshot); });
    expect(container.querySelector("fieldset")?.disabled).toBe(true);
    await act(async () => { sockets[1]!.listeners.get("state.snapshot")?.(snapshot); });
    expect(container.querySelector("fieldset")?.disabled).toBe(false);
  });

  it("offers recovery after cold restore fails without creating a new guest or room", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await act(async () => { root.render(<App />); });
    expect(container.textContent).toContain("无法恢复房间");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ activeRoom: null }), { status: 200 }));
    const retry = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "恢复房间")!;
    await act(async () => { retry.click(); });
    expect(container.textContent).toContain("当前没有可恢复的房间");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockIo).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.every(([, options]) => !options?.method || options.method === "GET")).toBe(true);
  });

});
