import { describe, expect, it } from "vitest";
import { MemoryRoomStore, RoomRuntime, continueWhileMissing, type CommandEnvelope, type GuestSession } from "@ykelit/games-room-runtime";
import { runAdapterContract } from "@ykelit/games-room-runtime/testkit";
import { createTexasAdapter, toRoomSnapshot, type TexasCommand, type TexasState, type TexasView } from "../src/shared-runtime";

const config = { maxPlayers: 9, startingStack: 1000, smallBlind: 10, bigBlind: 20, actionTimeSeconds: 15, rebuyCooldownHands: 2 };

function command(roomId: string, revision: number, requestId: string, type: string, payload: TexasCommand = {}): CommandEnvelope<TexasCommand> {
  return { protocolVersion: 1, requestId, roomId, expectedRevision: revision, type, payload };
}

async function setup(clock?: { now(): number }) {
  const runtime = new RoomRuntime<TexasState, TexasCommand, TexasView>(createTexasAdapter(), { store: new MemoryRoomStore<TexasState>(), disconnectPolicy: continueWhileMissing(), ...(clock ? { clock } : {}) });
  const guests: GuestSession[] = [(await runtime.createGuest()).session, (await runtime.createGuest()).session];
  let room = await runtime.createRoom({ guest: guests[0]!, nickname: "房主", settings: config });
  room = await runtime.joinRoom({ guest: guests[1]!, roomCode: room.code, nickname: "玩家二" });
  await runtime.attach(guests[0]!, room.id, "host-tab");
  await runtime.attach(guests[1]!, room.id, "guest-tab");
  room = (await runtime.loadRoom(room.id))!;
  for (let index = 0; index < 2; index += 1) {
    room = (await runtime.loadRoom(room.id))!;
    await runtime.execute(guests[index]!, command(room.id, room.revision, `seat-${index}`, "seat.take", { seatIndex: index }));
    room = (await runtime.loadRoom(room.id))!;
    await runtime.execute(guests[index]!, command(room.id, room.revision, `ready-${index}`, "player.ready"));
  }
  return { runtime, guests, roomId: room.id };
}

describe("texas poker shared room adapter", () => {
  it("passes the public adapter contract", async () => {
    const result = await runAdapterContract(createTexasAdapter(), (roomId, revision) => command(roomId, revision, "seat", "seat.take", { seatIndex: 0 }));
    expect(result.checks).toContain("codec-round-trip");
  });

  it("fixes the shuffled deal for a replay and never projects another player's hole cards", async () => {
    const game = await setup();
    let room = (await game.runtime.loadRoom(game.roomId))!;
    const start = command(room.id, room.revision, "start-once", "hand.start");
    const first = await game.runtime.execute(game.guests[0]!, start);
    const replay = await game.runtime.execute(game.guests[0]!, start);
    expect(replay).toEqual(first);
    room = (await game.runtime.loadRoom(room.id))!;
    const host = room.participants.find((participant) => participant.guestId === game.guests[0]!.id)!;
    const guest = room.participants.find((participant) => participant.guestId === game.guests[1]!.id)!;
    const hostSnapshot = toRoomSnapshot(game.runtime.snapshot(room, host));
    const guestSnapshot = toRoomSnapshot(game.runtime.snapshot(room, guest));
    expect(hostSnapshot.yourHoleCards).toHaveLength(2);
    expect(guestSnapshot.yourHoleCards).toHaveLength(2);
    expect(hostSnapshot.yourHoleCards).not.toEqual(guestSnapshot.yourHoleCards);
    expect(hostSnapshot.seats[1]?.player?.holeCardCount).toBe(2);
    expect(game.runtime.snapshot(room, host).game.engine.seats[1]?.holeCards).toEqual([]);
  });

  it("keeps a seat online until its last connection disconnects", async () => {
    const game = await setup();
    await game.runtime.attach(game.guests[0]!, game.roomId, "host-tab-2");
    await game.runtime.detach(game.guests[0]!, game.roomId, "host-tab");
    let room = (await game.runtime.loadRoom(game.roomId))!;
    expect(room.participants.find((participant) => participant.guestId === game.guests[0]!.id)?.presence).toBe("online");
    await game.runtime.detach(game.guests[0]!, game.roomId, "host-tab-2");
    room = (await game.runtime.loadRoom(game.roomId))!;
    expect(room.participants.find((participant) => participant.guestId === game.guests[0]!.id)?.presence).toBe("reconnecting");
  });
});


describe("permanent room exit keeps poker deadlines", () => {
  it("lets a remaining member issue only the due deterministic auto-fold, then clears the departed seat", async () => {
    let now = 1_000_000;
    const game = await setup({ now: () => now });
    let room = (await game.runtime.loadRoom(game.roomId))!;
    await game.runtime.execute(game.guests[0]!, command(room.id, room.revision, "start-exit", "hand.start"));
    room = (await game.runtime.loadRoom(room.id))!;
    const target = room.state.engine.actingSeatIndex!;
    const departed = game.guests[target]!;
    const issuer = game.guests[1 - target]!;
    const deadlineAt = room.state.engine.actionDeadlineAt!;
    await game.runtime.leaveRoom(departed, room.id);
    room = (await game.runtime.loadRoom(room.id))!;
    expect(room.state.engine.actionDeadlineAt).toBe(deadlineAt);
    expect(room.state.engine.seats[target]).not.toBeNull();
    await expect(game.runtime.execute(issuer, command(room.id, room.revision, "early", "timer.action", { deadlineAt }))).rejects.toMatchObject({ code: "PHASE_MISMATCH" });
    now = Date.parse(deadlineAt);
    await expect(game.runtime.execute(issuer, command(room.id, room.revision, "wrong-deadline", "timer.action", { deadlineAt: "invalid" }))).rejects.toMatchObject({ code: "PHASE_MISMATCH" });
    const due = command(room.id, room.revision, "due", "timer.action", { deadlineAt, seatIndex: 1 - target, type: "all_in" });
    const first = await game.runtime.execute(issuer, due);
    expect(await game.runtime.execute(issuer, due)).toEqual(first);
    room = (await game.runtime.loadRoom(room.id))!;
    expect(room.state.engine.stage).toBe("showdown");
    expect(room.state.engine.seats[target]).toBeNull();
    expect(room.state.engine.lastResult).toBeDefined();
    const result = structuredClone(room.state.engine.lastResult);
    await game.runtime.leaveRoom(issuer, room.id);
    expect((await game.runtime.loadRoom(room.id))!.state.engine.lastResult).toEqual(result);
  });

  it("keeps an ordinary disconnected member's seat after automatic settlement", async () => {
    let now = 2_000_000;
    const game = await setup({ now: () => now });
    let room = (await game.runtime.loadRoom(game.roomId))!;
    await game.runtime.execute(game.guests[0]!, command(room.id, room.revision, "start-disconnect", "hand.start"));
    room = (await game.runtime.loadRoom(room.id))!;
    const target = room.state.engine.actingSeatIndex!;
    const participant = room.participants.find(p => p.guestId === game.guests[target]!.id)!;
    await game.runtime.detach(game.guests[target]!, room.id, target === 0 ? "host-tab" : "guest-tab");
    room = (await game.runtime.loadRoom(room.id))!;
    now = Date.parse(room.state.engine.actionDeadlineAt!);
    await game.runtime.executeForParticipant(participant.id, command(room.id, room.revision, "disconnect-due", "timer.action", { deadlineAt: room.state.engine.actionDeadlineAt }));
    room = (await game.runtime.loadRoom(room.id))!;
    expect(room.state.engine.stage).toBe("showdown");
    expect(room.participants).toHaveLength(2);
    expect(room.state.engine.seats[target]).not.toBeNull();
  });

  it("preserves a departed all-in player's contribution until the natural showdown", async () => {
    const game = await setup();
    let room = (await game.runtime.loadRoom(game.roomId))!;
    await game.runtime.execute(game.guests[0]!, command(room.id, room.revision, "start-allin", "hand.start"));
    room = (await game.runtime.loadRoom(room.id))!;
    const target = room.state.engine.actingSeatIndex!;
    await game.runtime.execute(game.guests[target]!, command(room.id, room.revision, "allin", "action.submit", { type: "all_in" }));
    await game.runtime.leaveRoom(game.guests[target]!, room.id);
    room = (await game.runtime.loadRoom(room.id))!;
    expect(room.state.engine.seats[target]?.totalCommitted).toBe(1000);
    expect(room.state.engine.seats[target]?.status).toBe("all-in");
    await game.runtime.execute(game.guests[1 - target]!, command(room.id, room.revision, "call-allin", "action.submit", { type: "call" }));
    room = (await game.runtime.loadRoom(room.id))!;
    expect(room.state.engine.stage).toBe("showdown");
    expect(room.state.engine.board).toHaveLength(5);
    expect(room.state.engine.lastResult?.pots.reduce((sum, pot) => sum + pot.amount, 0)).toBe(2000);
    expect(room.state.engine.seats[target]).toBeNull();
  });
});
