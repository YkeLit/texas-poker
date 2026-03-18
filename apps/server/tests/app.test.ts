import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RoomConfig } from "@texas-poker/shared";
import { buildApp } from "../src/app";

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
});
