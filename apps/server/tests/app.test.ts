import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, GuestSession, HandResult, RoomConfig } from "@texas-poker/shared";
import { buildApp } from "../src/app";
import { normalizeClientOrigins, readConfig } from "../src/config";
import { createSignedToken } from "../src/lib/tokens";
import { MemoryCacheAdapter } from "../src/repositories/cache";
import type { PersistedChatMessage, PersistedRoomRecord, PersistenceAdapter } from "../src/repositories/persistence";

const TEST_CONFIG = {
  host: "127.0.0.1",
  port: 0,
  clientOrigin: "http://127.0.0.1:4173",
  tokenSecret: "test-secret",
};

const FAST_CONFIG: RoomConfig = {
  maxPlayers: 2,
  startingStack: 1000,
  smallBlind: 10,
  bigBlind: 20,
  actionTimeSeconds: 1,
  rebuyCooldownHands: 1,
};

class InMemoryPersistenceAdapter implements PersistenceAdapter {
  private readonly sessions = new Map<string, GuestSession>();
  private readonly rooms = new Map<string, PersistedRoomRecord>();
  private readonly chatMessages = new Map<string, ChatMessage[]>();
  private readonly handResults = new Map<string, HandResult[]>();

  async createGuestSession(session: GuestSession): Promise<void> {
    this.sessions.set(session.sessionId, { ...session });
  }

  async getGuestSession(sessionId: string): Promise<GuestSession | null> {
    const session = this.sessions.get(sessionId);
    return session ? { ...session } : null;
  }

  async updateGuestSessionNickname(sessionId: string, nickname: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Session not found");
    }
    this.sessions.set(sessionId, {
      ...session,
      nickname,
    });
  }

  async createRoom(roomCode: string, hostSessionId: string, config: RoomConfig): Promise<void> {
    this.rooms.set(roomCode, {
      roomCode,
      hostSessionId,
      config: { ...config },
      createdAt: this.rooms.get(roomCode)?.createdAt ?? new Date().toISOString(),
    });
  }

  async getRoom(roomCode: string): Promise<PersistedRoomRecord | null> {
    const room = this.rooms.get(roomCode);
    return room ? { ...room, config: { ...room.config } } : null;
  }

  async saveChatMessage(roomCode: string, message: PersistedChatMessage): Promise<void> {
    const existing = this.chatMessages.get(roomCode) ?? [];
    this.chatMessages.set(roomCode, [...existing, { ...message }]);
  }

  async saveHandResult(roomCode: string, handResult: HandResult): Promise<void> {
    const existing = this.handResults.get(roomCode) ?? [];
    this.handResults.set(roomCode, [...existing, handResult]);
  }

  async close(): Promise<void> {}
}

class FailingNicknamePersistenceAdapter extends InMemoryPersistenceAdapter {
  async updateGuestSessionNickname(): Promise<void> {
    throw new Error("nickname write failed");
  }
}

describe("server integration", () => {
  let instance: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    instance = await buildApp({ config: TEST_CONFIG });
  });

  afterEach(async () => {
    await instance.close();
  });

  it("creates guest sessions and room metadata over HTTP", async () => {
    const guestResponse = await instance.app.inject({
      method: "POST",
      url: "/api/v1/guest/sessions",
      payload: { nickname: "小杨" },
    });
    const guest = guestResponse.json();

    const roomResponse = await instance.app.inject({
      method: "POST",
      url: "/api/v1/rooms",
      payload: {
        sessionId: guest.sessionId,
        resumeToken: guest.resumeToken,
        config: {
          maxPlayers: 6,
          startingStack: 1000,
          smallBlind: 10,
          bigBlind: 20,
          actionTimeSeconds: 15,
          rebuyCooldownHands: 2,
        },
      },
    });
    const room = roomResponse.json();

    const joinResponse = await instance.app.inject({
      method: "POST",
      url: `/api/v1/rooms/${room.roomCode}/join`,
      payload: { sessionId: guest.sessionId, resumeToken: guest.resumeToken },
    });
    const joinPayload = joinResponse.json();

    expect(guest.sessionId).toBeTypeOf("string");
    expect(room.roomCode).toHaveLength(6);
    expect(joinPayload.wsToken).toBeTypeOf("string");
    expect(joinPayload.snapshot.roomCode).toBe(room.roomCode);
    expect(joinPayload.snapshot.config.maxPlayers).toBe(9);
  });

  it("requires a valid resume token before creating or joining rooms over HTTP", async () => {
    const guest = await instance.roomService.createGuestSession("小杨");

    const createRoomResponse = await instance.app.inject({
      method: "POST",
      url: "/api/v1/rooms",
      payload: {
        sessionId: guest.sessionId,
        resumeToken: "invalid-token",
        config: FAST_CONFIG,
      },
    });

    expect(createRoomResponse.statusCode).toBe(400);
    expect(createRoomResponse.json()).toMatchObject({
      error: "Resume token is invalid",
    });

    const room = await instance.roomService.createRoom(guest.sessionId, guest.resumeToken, FAST_CONFIG);
    const joinRoomResponse = await instance.app.inject({
      method: "POST",
      url: `/api/v1/rooms/${room.roomCode}/join`,
      payload: {
        sessionId: guest.sessionId,
        resumeToken: "invalid-token",
      },
    });

    expect(joinRoomResponse.statusCode).toBe(400);
    expect(joinRoomResponse.json()).toMatchObject({
      error: "Resume token is invalid",
    });
  });

  it("requires an authenticated session for client error reports", async () => {
    const guest = await instance.roomService.createGuestSession("小杨");

    const rejectedResponse = await instance.app.inject({
      method: "POST",
      url: "/api/v1/reports/errors",
      payload: {
        sessionId: guest.sessionId,
        resumeToken: "invalid-token",
        roomCode: "ABC123",
        message: "boom",
      },
    });

    expect(rejectedResponse.statusCode).toBe(401);
    expect(rejectedResponse.json()).toMatchObject({
      error: "Resume token is invalid",
    });
    expect(instance.roomService.getMetrics().emittedErrors).toBe(0);

    const acceptedResponse = await instance.app.inject({
      method: "POST",
      url: "/api/v1/reports/errors",
      payload: {
        sessionId: guest.sessionId,
        resumeToken: guest.resumeToken,
        roomCode: "ABC123",
        message: "boom",
      },
    });

    expect(acceptedResponse.statusCode).toBe(202);
    expect(acceptedResponse.json()).toEqual({ accepted: true });
    expect(instance.roomService.getMetrics().emittedErrors).toBe(1);
  });

  it("updates lobby nicknames without rewriting already seated players", async () => {
    const guest = await instance.roomService.createGuestSession("旧昵称");
    const room = await instance.roomService.createRoom(guest.sessionId, guest.resumeToken, FAST_CONFIG);
    await instance.roomService.takeSeat(room.roomCode, guest.sessionId, 0);

    const renameResponse = await instance.app.inject({
      method: "PATCH",
      url: `/api/v1/guest/sessions/${guest.sessionId}`,
      payload: {
        nickname: "新昵称",
        resumeToken: guest.resumeToken,
      },
    });

    expect(renameResponse.statusCode).toBe(200);
    expect(renameResponse.json().nickname).toBe("新昵称");
    expect(instance.roomService.buildSnapshot(room.roomCode, guest.sessionId).seats[0]?.player?.nickname).toBe("旧昵称");

    await instance.roomService.leaveSeat(room.roomCode, guest.sessionId);
    await instance.roomService.takeSeat(room.roomCode, guest.sessionId, 0);

    expect(instance.roomService.buildSnapshot(room.roomCode, guest.sessionId).seats[0]?.player?.nickname).toBe("新昵称");
  });

  it("keeps the old in-memory nickname when nickname persistence fails", async () => {
    await instance.close();

    const persistence = new FailingNicknamePersistenceAdapter();
    const cache = new MemoryCacheAdapter();
    instance = await buildApp({ config: TEST_CONFIG, persistence, cache });

    const guest = await instance.roomService.createGuestSession("旧昵称");

    await expect(
      instance.roomService.updateGuestSessionNickname(guest.sessionId, guest.resumeToken, "新昵称"),
    ).rejects.toThrow("nickname write failed");

    const room = await instance.roomService.createRoom(guest.sessionId, guest.resumeToken, FAST_CONFIG);
    await instance.roomService.takeSeat(room.roomCode, guest.sessionId, 0);

    expect(instance.roomService.buildSnapshot(room.roomCode, guest.sessionId).seats[0]?.player?.nickname).toBe("旧昵称");
  });

  it("parses multiple client origins and returns CORS headers for each allowed origin", async () => {
    expect(readConfig({
      CLIENT_ORIGIN: "http://127.0.0.1:4173, https://poker.example.com",
      TOKEN_SECRET: "test-secret",
    }).clientOrigin).toEqual(["http://127.0.0.1:4173", "https://poker.example.com"]);
    expect(normalizeClientOrigins(["http://127.0.0.1:4173", "https://poker.example.com"])).toEqual([
      "http://127.0.0.1:4173",
      "https://poker.example.com",
    ]);

    const corsInstance = await buildApp({
      config: {
        ...TEST_CONFIG,
        clientOrigin: ["http://127.0.0.1:4173", "https://poker.example.com"],
      },
    });

    try {
      const response = await corsInstance.app.inject({
        method: "OPTIONS",
        url: "/healthz",
        headers: {
          origin: "https://poker.example.com",
          "access-control-request-method": "GET",
        },
      });

      expect(response.headers["access-control-allow-origin"]).toBe("https://poker.example.com");
    } finally {
      await corsInstance.close();
    }
  });

  it("requires TOKEN_SECRET when loading runtime config", () => {
    expect(() => readConfig({})).toThrow("TOKEN_SECRET is required");
  });

  it("rejects out-of-turn actions and prevents a third player from taking an occupied seat", async () => {
    const [host, guest, third] = await Promise.all([
      instance.roomService.createGuestSession("房主"),
      instance.roomService.createGuestSession("跟注手"),
      instance.roomService.createGuestSession("第三人"),
    ]);
    const room = await instance.roomService.createRoom(host.sessionId, host.resumeToken, FAST_CONFIG);

    await instance.roomService.takeSeat(room.roomCode, host.sessionId, 0);
    await instance.roomService.takeSeat(room.roomCode, guest.sessionId, 1);
    await instance.roomService.toggleReady(room.roomCode, host.sessionId, true);
    await instance.roomService.toggleReady(room.roomCode, guest.sessionId, true);
    await instance.roomService.startHand(room.roomCode, host.sessionId);

    await expect(instance.roomService.submitAction(room.roomCode, guest.sessionId, { type: "check" })).rejects.toThrow(
      "It is not this player's turn",
    );
    await expect(instance.roomService.takeSeat(room.roomCode, third.sessionId, 0)).rejects.toThrow("Seat is already occupied");
  });

  it("requires every seated player to be ready before the host can start a hand", async () => {
    const [host, guest, latePlayer] = await Promise.all([
      instance.roomService.createGuestSession("房主"),
      instance.roomService.createGuestSession("玩家二"),
      instance.roomService.createGuestSession("玩家三"),
    ]);
    const room = await instance.roomService.createRoom(host.sessionId, host.resumeToken, FAST_CONFIG);

    await instance.roomService.takeSeat(room.roomCode, host.sessionId, 0);
    await instance.roomService.takeSeat(room.roomCode, guest.sessionId, 1);
    await instance.roomService.takeSeat(room.roomCode, latePlayer.sessionId, 2);
    await instance.roomService.toggleReady(room.roomCode, host.sessionId, true);
    await instance.roomService.toggleReady(room.roomCode, guest.sessionId, true);

    await expect(instance.roomService.startHand(room.roomCode, host.sessionId)).rejects.toThrow(
      "All seated players must be connected and ready, with at least two players",
    );

    await instance.roomService.toggleReady(room.roomCode, latePlayer.sessionId, true);
    await expect(instance.roomService.startHand(room.roomCode, host.sessionId)).resolves.toMatchObject({
      roomCode: room.roomCode,
      handNumber: 1,
    });
  });

  it("includes each player's latest action in room snapshots", async () => {
    const [host, guest] = await Promise.all([
      instance.roomService.createGuestSession("房主"),
      instance.roomService.createGuestSession("玩家二"),
    ]);
    const room = await instance.roomService.createRoom(host.sessionId, host.resumeToken, FAST_CONFIG);

    await instance.roomService.takeSeat(room.roomCode, host.sessionId, 0);
    await instance.roomService.takeSeat(room.roomCode, guest.sessionId, 1);
    await instance.roomService.toggleReady(room.roomCode, host.sessionId, true);
    await instance.roomService.toggleReady(room.roomCode, guest.sessionId, true);
    await instance.roomService.startHand(room.roomCode, host.sessionId);
    await instance.roomService.submitAction(room.roomCode, host.sessionId, { type: "call" });

    const snapshot = instance.roomService.buildSnapshot(room.roomCode, guest.sessionId);
    expect(snapshot.seats[0]?.player?.lastAction).toEqual({
      label: "跟注 10",
      tone: "safe",
    });
    expect(snapshot.seats[0]?.player).not.toHaveProperty("sessionId");
    expect(snapshot).not.toHaveProperty("yourSessionId");
  });

  it("formats raise actions as additive chip amounts", async () => {
    const [host, guest, third] = await Promise.all([
      instance.roomService.createGuestSession("房主"),
      instance.roomService.createGuestSession("玩家二"),
      instance.roomService.createGuestSession("玩家三"),
    ]);
    const room = await instance.roomService.createRoom(host.sessionId, host.resumeToken, {
      ...FAST_CONFIG,
      maxPlayers: 3,
    });

    await instance.roomService.takeSeat(room.roomCode, host.sessionId, 0);
    await instance.roomService.takeSeat(room.roomCode, guest.sessionId, 1);
    await instance.roomService.takeSeat(room.roomCode, third.sessionId, 2);
    await instance.roomService.toggleReady(room.roomCode, host.sessionId, true);
    await instance.roomService.toggleReady(room.roomCode, guest.sessionId, true);
    await instance.roomService.toggleReady(room.roomCode, third.sessionId, true);
    await instance.roomService.startHand(room.roomCode, host.sessionId);
    await instance.roomService.submitAction(room.roomCode, host.sessionId, { type: "raise", amount: 60 });

    const snapshot = instance.roomService.buildSnapshot(room.roomCode, guest.sessionId);
    expect(snapshot.seats[0]?.player?.lastAction).toEqual({
      label: "加注 60",
      tone: "aggressive",
    });
  });

  it("auto-folds on timeout and lets a disconnected player resume the same seat", async () => {
    const [host, guest] = await Promise.all([
      instance.roomService.createGuestSession("房主"),
      instance.roomService.createGuestSession("断线玩家"),
    ]);
    const room = await instance.roomService.createRoom(host.sessionId, host.resumeToken, FAST_CONFIG);

    await instance.roomService.takeSeat(room.roomCode, host.sessionId, 0);
    await instance.roomService.takeSeat(room.roomCode, guest.sessionId, 1);
    await instance.roomService.toggleReady(room.roomCode, host.sessionId, true);
    await instance.roomService.toggleReady(room.roomCode, guest.sessionId, true);
    await instance.roomService.startHand(room.roomCode, host.sessionId);

    await new Promise((resolve) => setTimeout(resolve, 1_150));
    const timedOutSnapshot = instance.roomService.buildSnapshot(room.roomCode, host.sessionId);
    expect(timedOutSnapshot.stage).toBe("showdown");

    await instance.roomService.markDisconnected(guest.sessionId);
    const resumed = await instance.roomService.resumeSession(room.roomCode, guest.sessionId, guest.resumeToken);
    expect(resumed.yourSeatIndex).toBe(1);
    expect(resumed.seats[1]?.player?.presence).toBe("connected");
  });

  it("does not attach room access when session resume fails", async () => {
    const host = await instance.roomService.createGuestSession("房主");
    const room = await instance.roomService.createRoom(host.sessionId, host.resumeToken, FAST_CONFIG);
    await instance.roomService.takeSeat(room.roomCode, host.sessionId, 0);

    const handlers = new Map<string, (...args: any[]) => unknown>();
    const fakeSocket = {
      data: {} as Record<string, unknown>,
      emit: vi.fn(),
      id: "socket-1",
      join: vi.fn(),
      leave: vi.fn(async () => undefined),
      on: vi.fn((event: string, handler: (...args: any[]) => unknown) => {
        handlers.set(event, handler);
      }),
    };

    const connectionHandler = instance.io.of("/").listeners("connection")[0] as ((socket: typeof fakeSocket) => void) | undefined;
    expect(connectionHandler).toBeTypeOf("function");
    connectionHandler?.(fakeSocket);

    let resumeResponse: { ok: boolean; error?: string } | undefined;
    await handlers.get("session.resume")?.(
      {
        roomCode: room.roomCode,
        sessionId: host.sessionId,
        resumeToken: "invalid-token",
      },
      (payload: { ok: boolean; error?: string }) => {
        resumeResponse = payload;
      },
    );

    expect(resumeResponse).toEqual({
      ok: false,
      error: "Resume token is invalid",
    });
    expect(fakeSocket.join).not.toHaveBeenCalled();
    expect(instance.roomService.getMetrics().activeConnections).toBe(0);

    let readyResponse: { ok: boolean; error?: string } | undefined;
    await handlers.get("player.ready")?.({}, (payload: { ok: boolean; error?: string }) => {
      readyResponse = payload;
    });

    expect(readyResponse?.ok).toBe(false);
    expect(instance.roomService.buildSnapshot(room.roomCode, host.sessionId).seats[0]?.player?.ready).toBe(false);
  });

  it("does not auto-start the next hand after showdown", async () => {
    vi.useFakeTimers();
    try {
      const [host, guest] = await Promise.all([
        instance.roomService.createGuestSession("房主"),
        instance.roomService.createGuestSession("玩家二"),
      ]);
      const room = await instance.roomService.createRoom(host.sessionId, host.resumeToken, FAST_CONFIG);

      await instance.roomService.takeSeat(room.roomCode, host.sessionId, 0);
      await instance.roomService.takeSeat(room.roomCode, guest.sessionId, 1);
      await instance.roomService.toggleReady(room.roomCode, host.sessionId, true);
      await instance.roomService.toggleReady(room.roomCode, guest.sessionId, true);
      await instance.roomService.startHand(room.roomCode, host.sessionId);
      await instance.roomService.submitAction(room.roomCode, host.sessionId, { type: "fold" });

      vi.advanceTimersByTime(6_000);

      const snapshot = instance.roomService.buildSnapshot(room.roomCode, host.sessionId);
      expect(snapshot.stage).toBe("showdown");
      expect(snapshot.handNumber).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows a busted player to rebuy after the configured cooldown", async () => {
    const [host, guest, third] = await Promise.all([
      instance.roomService.createGuestSession("房主"),
      instance.roomService.createGuestSession("玩家二"),
      instance.roomService.createGuestSession("玩家三"),
    ]);
    const room = await instance.roomService.createRoom(host.sessionId, host.resumeToken, {
      ...FAST_CONFIG,
      maxPlayers: 3,
    });

    await instance.roomService.takeSeat(room.roomCode, host.sessionId, 0);
    await instance.roomService.takeSeat(room.roomCode, guest.sessionId, 1);
    await instance.roomService.takeSeat(room.roomCode, third.sessionId, 2);
    await instance.roomService.toggleReady(room.roomCode, host.sessionId, true);
    await instance.roomService.toggleReady(room.roomCode, guest.sessionId, true);
    await instance.roomService.toggleReady(room.roomCode, third.sessionId, true);
    await instance.roomService.startHand(room.roomCode, host.sessionId);

    const roomRuntime = (instance.roomService as unknown as { rooms: Map<string, { engine: { seats: Array<any>; deck: Array<any> } }> }).rooms.get(room.roomCode)!;
    roomRuntime.engine.seats[0].stack = 20;
    roomRuntime.engine.seats[0].currentBet = 10;
    roomRuntime.engine.seats[1].currentBet = 20;
    roomRuntime.engine.seats[2].stack = 20;
    roomRuntime.engine.seats[2].currentBet = 0;
    roomRuntime.engine.seats[0].holeCards = [{ suit: "clubs", rank: 2 }, { suit: "diamonds", rank: 7 }];
    roomRuntime.engine.seats[1].holeCards = [{ suit: "spades", rank: 14 }, { suit: "hearts", rank: 14 }];
    roomRuntime.engine.seats[2].holeCards = [{ suit: "clubs", rank: 9 }, { suit: "spades", rank: 9 }];
    roomRuntime.engine.deck = [
      { suit: "hearts", rank: 10 },
      { suit: "spades", rank: 11 },
      { suit: "diamonds", rank: 12 },
      { suit: "clubs", rank: 13 },
      { suit: "hearts", rank: 3 },
    ];

    await instance.roomService.submitAction(room.roomCode, host.sessionId, { type: "all_in" });
    await instance.roomService.submitAction(room.roomCode, guest.sessionId, { type: "call" });
    await instance.roomService.submitAction(room.roomCode, third.sessionId, { type: "all_in" });

    let snapshot = instance.roomService.buildSnapshot(room.roomCode, host.sessionId);
    expect(snapshot.seats[0]?.player?.status).toBe("out");
    expect(snapshot.seats[0]?.player?.rebuyRemainingHands).toBe(1);

    await instance.roomService.toggleReady(room.roomCode, guest.sessionId, true);
    await instance.roomService.toggleReady(room.roomCode, third.sessionId, true);
    await instance.roomService.startHand(room.roomCode, host.sessionId);
    await instance.roomService.submitAction(room.roomCode, guest.sessionId, { type: "fold" });

    snapshot = instance.roomService.buildSnapshot(room.roomCode, host.sessionId);
    expect(snapshot.seats[0]?.player?.canRebuy).toBe(true);

    const rebought = await instance.roomService.rebuyPlayer(room.roomCode, host.sessionId);
    expect(rebought.seats[0]?.player?.stack).toBe(1000);
    expect(rebought.seats[0]?.player?.ready).toBe(false);
  });

  it("throttles chat messages and transfers the host role when the host leaves", async () => {
    const [host, guest] = await Promise.all([
      instance.roomService.createGuestSession("房主"),
      instance.roomService.createGuestSession("接手玩家"),
    ]);
    const room = await instance.roomService.createRoom(host.sessionId, host.resumeToken, FAST_CONFIG);

    await instance.roomService.takeSeat(room.roomCode, host.sessionId, 0);
    await instance.roomService.takeSeat(room.roomCode, guest.sessionId, 1);
    await instance.roomService.sendChat(room.roomCode, host.sessionId, "hello");
    await expect(instance.roomService.sendChat(room.roomCode, host.sessionId, "again")).rejects.toThrow(
      "Messages are being sent too quickly",
    );
    expect(instance.roomService.buildSnapshot(room.roomCode, guest.sessionId).messages[0]).not.toHaveProperty("senderSessionId");

    await instance.roomService.leaveSeat(room.roomCode, host.sessionId);
    const roomAfterTransfer = instance.roomService.buildSnapshot(room.roomCode, guest.sessionId);
    expect(roomAfterTransfer.seats[1]?.player?.isHost).toBe(true);
  });

  it("reassigns the host when the original host leaves an otherwise empty room", async () => {
    const [host, newHost, guest] = await Promise.all([
      instance.roomService.createGuestSession("房主"),
      instance.roomService.createGuestSession("新房主"),
      instance.roomService.createGuestSession("跟注手"),
    ]);
    const room = await instance.roomService.createRoom(host.sessionId, host.resumeToken, FAST_CONFIG);

    await instance.roomService.takeSeat(room.roomCode, host.sessionId, 0);
    await instance.roomService.leaveSeat(room.roomCode, host.sessionId);

    const hostlessSnapshot = instance.roomService.buildSnapshot(room.roomCode, newHost.sessionId);
    await instance.roomService.takeSeat(room.roomCode, newHost.sessionId, 0);
    await instance.roomService.takeSeat(room.roomCode, guest.sessionId, 1);
    await instance.roomService.toggleReady(room.roomCode, newHost.sessionId, true);
    await instance.roomService.toggleReady(room.roomCode, guest.sessionId, true);

    const reassignedSnapshot = instance.roomService.buildSnapshot(room.roomCode, newHost.sessionId);
    expect(reassignedSnapshot.seats[0]?.player?.isHost).toBe(true);

    await expect(instance.roomService.startHand(room.roomCode, newHost.sessionId)).resolves.toMatchObject({
      roomCode: room.roomCode,
      handNumber: 1,
      yourSeatIndex: 0,
    });
  });

  it("restores the persisted host when reloading a room without cached state", async () => {
    await instance.close();

    const persistence = new InMemoryPersistenceAdapter();
    instance = await buildApp({ config: TEST_CONFIG, persistence, cache: new MemoryCacheAdapter() });

    const [host, guest] = await Promise.all([
      instance.roomService.createGuestSession("房主"),
      instance.roomService.createGuestSession("玩家二"),
    ]);
    const room = await instance.roomService.createRoom(host.sessionId, host.resumeToken, FAST_CONFIG);

    await instance.close();
    instance = await buildApp({ config: TEST_CONFIG, persistence, cache: new MemoryCacheAdapter() });

    await instance.roomService.takeSeat(room.roomCode, guest.sessionId, 0);
    await expect(instance.roomService.startHand(room.roomCode, guest.sessionId)).rejects.toThrow(
      "Only the host can start the first hand",
    );

    await instance.roomService.takeSeat(room.roomCode, host.sessionId, 1);
    const snapshot = instance.roomService.buildSnapshot(room.roomCode, host.sessionId);
    expect(snapshot.seats[0]?.player?.isHost).toBe(false);
    expect(snapshot.seats[1]?.player?.isHost).toBe(true);
  });

  it("cleans up the old room and session when a socket re-authenticates", async () => {
    const [host, guest] = await Promise.all([
      instance.roomService.createGuestSession("房主"),
      instance.roomService.createGuestSession("玩家二"),
    ]);
    const roomA = await instance.roomService.createRoom(host.sessionId, host.resumeToken, FAST_CONFIG);
    const roomB = await instance.roomService.createRoom(guest.sessionId, guest.resumeToken, FAST_CONFIG);
    await instance.roomService.takeSeat(roomA.roomCode, host.sessionId, 0);

    const handlers = new Map<string, (...args: any[]) => unknown>();
    const fakeSocket = {
      data: {} as Record<string, unknown>,
      emit: vi.fn(),
      id: "socket-1",
      join: vi.fn(),
      leave: vi.fn(async () => undefined),
      on: vi.fn((event: string, handler: (...args: any[]) => unknown) => {
        handlers.set(event, handler);
      }),
    };

    const connectionHandler = instance.io.of("/").listeners("connection")[0] as ((socket: typeof fakeSocket) => void) | undefined;
    expect(connectionHandler).toBeTypeOf("function");
    connectionHandler?.(fakeSocket);

    let firstJoinResponse: { ok: boolean; error?: string } | undefined;
    await handlers.get("room.join")?.(
      {
        roomCode: roomA.roomCode,
        sessionId: host.sessionId,
        token: createSignedToken({ roomCode: roomA.roomCode, sessionId: host.sessionId, type: "room" }, TEST_CONFIG.tokenSecret),
      },
      (payload: { ok: boolean; error?: string }) => {
        firstJoinResponse = payload;
      },
    );

    expect(firstJoinResponse?.ok).toBe(true);
    expect(instance.roomService.getMetrics().activeConnections).toBe(1);

    let secondJoinResponse: { ok: boolean; error?: string } | undefined;
    await handlers.get("room.join")?.(
      {
        roomCode: roomB.roomCode,
        sessionId: guest.sessionId,
        token: createSignedToken({ roomCode: roomB.roomCode, sessionId: guest.sessionId, type: "room" }, TEST_CONFIG.tokenSecret),
      },
      (payload: { ok: boolean; error?: string }) => {
        secondJoinResponse = payload;
      },
    );

    expect(secondJoinResponse?.ok).toBe(true);
    expect(fakeSocket.leave).toHaveBeenCalledWith(roomA.roomCode);
    expect(instance.roomService.getMetrics().activeConnections).toBe(1);
    expect(instance.roomService.buildSnapshot(roomA.roomCode, host.sessionId).seats[0]?.player?.presence).toBe("disconnected");
  });

  it("restores room state and guest sessions after a service restart", async () => {
    await instance.close();

    const persistence = new InMemoryPersistenceAdapter();
    const cache = new MemoryCacheAdapter();
    instance = await buildApp({ config: TEST_CONFIG, persistence, cache });

    const [host, guest] = await Promise.all([
      instance.roomService.createGuestSession("房主"),
      instance.roomService.createGuestSession("断线玩家"),
    ]);
    const room = await instance.roomService.createRoom(host.sessionId, host.resumeToken, FAST_CONFIG);

    await instance.roomService.takeSeat(room.roomCode, host.sessionId, 0);
    await instance.roomService.takeSeat(room.roomCode, guest.sessionId, 1);
    await instance.roomService.markDisconnected(guest.sessionId);
    await instance.close();

    instance = await buildApp({ config: TEST_CONFIG, persistence, cache });

    const summary = await instance.roomService.getRoomSummary(room.roomCode);
    expect(summary.seatedPlayers).toBe(2);
    expect(summary.connectedPlayers).toBe(1);

    const joined = await instance.roomService.joinRoom(room.roomCode, host.sessionId, host.resumeToken);
    expect(joined.snapshot.seats[0]?.player?.nickname).toBe("房主");

    const resumed = await instance.roomService.resumeSession(room.roomCode, guest.sessionId, guest.resumeToken);
    expect(resumed.yourSeatIndex).toBe(1);
    expect(resumed.seats[1]?.player?.presence).toBe("connected");
  });
});
