import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage, GuestSession, HandResult, RoomConfig } from "@texas-poker/shared";
import { buildApp } from "../src/app";
import { normalizeClientOrigins, readConfig } from "../src/config";
import { MemoryCacheAdapter } from "../src/repositories/cache";
import type { PersistedRoomRecord, PersistenceAdapter } from "../src/repositories/persistence";

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

  async saveChatMessage(roomCode: string, message: ChatMessage): Promise<void> {
    const existing = this.chatMessages.get(roomCode) ?? [];
    this.chatMessages.set(roomCode, [...existing, { ...message }]);
  }

  async saveHandResult(roomCode: string, handResult: HandResult): Promise<void> {
    const existing = this.handResults.get(roomCode) ?? [];
    this.handResults.set(roomCode, [...existing, handResult]);
  }

  async close(): Promise<void> {}
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
        config: {
          maxPlayers: 6,
          startingStack: 1000,
          smallBlind: 10,
          bigBlind: 20,
          actionTimeSeconds: 15,
        },
      },
    });
    const room = roomResponse.json();

    const joinResponse = await instance.app.inject({
      method: "POST",
      url: `/api/v1/rooms/${room.roomCode}/join`,
      payload: { sessionId: guest.sessionId },
    });
    const joinPayload = joinResponse.json();

    expect(guest.sessionId).toBeTypeOf("string");
    expect(room.roomCode).toHaveLength(6);
    expect(joinPayload.wsToken).toBeTypeOf("string");
    expect(joinPayload.snapshot.roomCode).toBe(room.roomCode);
  });

  it("parses multiple client origins and returns CORS headers for each allowed origin", async () => {
    expect(readConfig({
      CLIENT_ORIGIN: "http://127.0.0.1:4173, https://poker.example.com",
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

  it("rejects out-of-turn actions and prevents a third player from taking an occupied seat", async () => {
    const [host, guest, third] = await Promise.all([
      instance.roomService.createGuestSession("房主"),
      instance.roomService.createGuestSession("跟注手"),
      instance.roomService.createGuestSession("第三人"),
    ]);
    const room = await instance.roomService.createRoom(host.sessionId, FAST_CONFIG);

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

  it("auto-folds on timeout and lets a disconnected player resume the same seat", async () => {
    const [host, guest] = await Promise.all([
      instance.roomService.createGuestSession("房主"),
      instance.roomService.createGuestSession("断线玩家"),
    ]);
    const room = await instance.roomService.createRoom(host.sessionId, FAST_CONFIG);

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

  it("throttles chat messages and transfers the host role when the host leaves", async () => {
    const [host, guest] = await Promise.all([
      instance.roomService.createGuestSession("房主"),
      instance.roomService.createGuestSession("接手玩家"),
    ]);
    const room = await instance.roomService.createRoom(host.sessionId, FAST_CONFIG);

    await instance.roomService.takeSeat(room.roomCode, host.sessionId, 0);
    await instance.roomService.takeSeat(room.roomCode, guest.sessionId, 1);
    await instance.roomService.sendChat(room.roomCode, host.sessionId, "hello");
    await expect(instance.roomService.sendChat(room.roomCode, host.sessionId, "again")).rejects.toThrow(
      "Messages are being sent too quickly",
    );

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
    const room = await instance.roomService.createRoom(host.sessionId, FAST_CONFIG);

    await instance.roomService.takeSeat(room.roomCode, host.sessionId, 0);
    await instance.roomService.leaveSeat(room.roomCode, host.sessionId);

    const hostlessSnapshot = instance.roomService.buildSnapshot(room.roomCode, newHost.sessionId);
    expect(hostlessSnapshot.hostSessionId).toBe("");

    await instance.roomService.takeSeat(room.roomCode, newHost.sessionId, 0);
    await instance.roomService.takeSeat(room.roomCode, guest.sessionId, 1);
    await instance.roomService.toggleReady(room.roomCode, newHost.sessionId, true);
    await instance.roomService.toggleReady(room.roomCode, guest.sessionId, true);

    const reassignedSnapshot = instance.roomService.buildSnapshot(room.roomCode, newHost.sessionId);
    expect(reassignedSnapshot.hostSessionId).toBe(newHost.sessionId);
    expect(reassignedSnapshot.seats[0]?.player?.isHost).toBe(true);

    await expect(instance.roomService.startHand(room.roomCode, newHost.sessionId)).resolves.toMatchObject({
      roomCode: room.roomCode,
      handNumber: 1,
      yourSeatIndex: 0,
    });
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
    const room = await instance.roomService.createRoom(host.sessionId, FAST_CONFIG);

    await instance.roomService.takeSeat(room.roomCode, host.sessionId, 0);
    await instance.roomService.takeSeat(room.roomCode, guest.sessionId, 1);
    await instance.roomService.markDisconnected(guest.sessionId);
    await instance.close();

    instance = await buildApp({ config: TEST_CONFIG, persistence, cache });

    const summary = await instance.roomService.getRoomSummary(room.roomCode);
    expect(summary.seatedPlayers).toBe(2);
    expect(summary.connectedPlayers).toBe(1);

    const joined = await instance.roomService.joinRoom(room.roomCode, host.sessionId);
    expect(joined.snapshot.seats[0]?.player?.nickname).toBe("房主");

    const resumed = await instance.roomService.resumeSession(room.roomCode, guest.sessionId, guest.resumeToken);
    expect(resumed.yourSeatIndex).toBe(1);
    expect(resumed.seats[1]?.player?.presence).toBe("connected");
  });
});
