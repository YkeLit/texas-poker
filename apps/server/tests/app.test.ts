import { describe, expect, it } from "vitest";
import { MemoryRoomStore, RoomRuntime, type CommandEnvelope, type GuestSession } from "@ykelit/games-room-runtime";
import { runAdapterContract } from "@ykelit/games-room-runtime/testkit";
import { createTexasAdapter, toRoomSnapshot, type TexasCommand, type TexasState, type TexasView } from "../src/shared-runtime";

const config = { maxPlayers: 9, startingStack: 1000, smallBlind: 10, bigBlind: 20, actionTimeSeconds: 15, rebuyCooldownHands: 2 };

function command(roomId: string, revision: number, requestId: string, type: string, payload: TexasCommand = {}): CommandEnvelope<TexasCommand> {
  return { protocolVersion: 1, requestId, roomId, expectedRevision: revision, type, payload };
}

async function setup() {
  const runtime = new RoomRuntime<TexasState, TexasCommand, TexasView>(createTexasAdapter(), { store: new MemoryRoomStore<TexasState>() });
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
