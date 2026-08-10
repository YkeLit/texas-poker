import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import Redis from "ioredis";
import { Server, type Socket } from "socket.io";
import {
  PROTOCOL_VERSION,
  RedisLockProvider,
  RedisRoomStore,
  RoomApi,
  RoomRuntime,
  RoomRuntimeError,
  continueWhileMissing,
  guestCookieName,
  guestCookieOptions,
  type CommandEnvelope,
  type CommandResponse,
  type GameAdapter,
  type GuestSession,
  type RoomSnapshot as RuntimeSnapshot,
  type StoredRoom,
} from "@ykelit/games-room-runtime";
import {
  applyPlayerAction,
  canRebuyChips,
  createPokerEngine,
  getAvailableActions,
  getSeatBySession,
  isHandActive,
  rebuyChips,
  removePlayerFromSeat,
  seatPlayer,
  setPlayerReady,
  startHand,
  type PokerEngineState,
} from "@texas-poker/poker-engine";
import {
  CHAT_THROTTLE_MS,
  EMOJI_THROTTLE_MS,
  MAX_TABLE_PLAYERS,
  type ChatMessage,
  type PlayerActionCommand,
  type RoomConfig,
  type RoomSnapshot,
} from "@texas-poker/shared";

export const GAME_ID = "texas-poker";
export const COOKIE_NAME = guestCookieName(GAME_ID);

export interface TexasState {
  engine: PokerEngineState;
  messages: ChatMessage[];
  throttle: Record<string, number>;
}

export interface TexasView {
  engine: PokerEngineState;
  messages: ChatMessage[];
  holeCardCounts: Record<string, number>;
}

export type TexasCommand = Record<string, unknown>;

const DEFAULT_ROOM_CONFIG: RoomConfig = {
  maxPlayers: MAX_TABLE_PLAYERS,
  startingStack: 2_000,
  smallBlind: 10,
  bigBlind: 20,
  actionTimeSeconds: 20,
  rebuyCooldownHands: 2,
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function seededRandom(seed: string): () => number {
  let value = 2166136261;
  for (const character of seed) {
    value ^= character.codePointAt(0) ?? 0;
    value = Math.imul(value, 16777619);
  }
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 0x1_0000_0000;
  };
}

function asSeatIndex(value: unknown): number {
  const seatIndex = Number(value);
  if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex >= MAX_TABLE_PLAYERS) {
    throw new RoomRuntimeError("INVALID_COMMAND", "座位编号不正确");
  }
  return seatIndex;
}

function syncPresence(state: PokerEngineState, room: Readonly<StoredRoom<TexasState>>): void {
  const participants = new Map(room.participants.map((participant) => [participant.id, participant]));
  for (const player of state.seats) {
    if (!player) continue;
    const nextPresence = participants.get(player.sessionId)?.presence === "online" ? "connected" : "disconnected";
    if (player.presence !== nextPresence) {
      player.presence = nextPresence;
      if (nextPresence === "connected") {
        player.missedHands = 0;
        if (player.status === "sit-out" && player.ready) player.status = "waiting";
      }
    }
    player.isHost = room.hostParticipantId === player.sessionId;
  }
}

function refreshDeadline(engine: PokerEngineState, now: number): void {
  engine.actionDeadlineAt = isHandActive(engine.stage) && engine.actingSeatIndex !== null
    ? new Date(now + engine.config.actionTimeSeconds * 1_000).toISOString()
    : null;
}

function appendMessage(state: TexasState, actorId: string, nickname: string, command: CommandEnvelope<TexasCommand>, now: number): void {
  const payload = command.payload ?? {};
  const content = String(payload.content ?? "").trim();
  const isEmoji = command.type === "emoji.send";
  const maxLength = isEmoji ? 8 : 160;
  if (!content || content.length > maxLength) throw new RoomRuntimeError("INVALID_COMMAND", "消息内容不正确");
  const throttleKey = `${actorId}:${command.type}`;
  const wait = isEmoji ? EMOJI_THROTTLE_MS : CHAT_THROTTLE_MS;
  if (now - (state.throttle[throttleKey] ?? 0) < wait) throw new RoomRuntimeError("INVALID_COMMAND", "发送得太快了");
  state.throttle[throttleKey] = now;
  state.messages = [...state.messages.slice(-49), {
    id: command.requestId,
    type: isEmoji ? "emoji" : "chat",
    content,
    createdAt: new Date(now).toISOString(),
    senderSessionId: actorId,
    senderNickname: nickname,
  }];
}

export function createTexasAdapter(onRestore?: (roomId: string) => void): GameAdapter<TexasState, TexasCommand, TexasView> {
  return {
    gameId: GAME_ID,
    roomOptions: {
      maxPlayers: MAX_TABLE_PLAYERS,
      minPlayers: 2,
      reconnectWindowMs: 2 * 60 * 60_000,
      activeEmptyTtlMs: 2 * 60 * 60_000,
      completedTtlMs: 2 * 60 * 60_000,
      capabilities: ["multi-connection", "continue-on-disconnect", "auto-check-fold", "sit-out-after-two-hands", "deterministic-deal", "timer-restore"],
    },
    createState: ({ settings }) => ({
      engine: createPokerEngine((settings as RoomConfig | undefined) ?? DEFAULT_ROOM_CONFIG),
      messages: [],
      throttle: {},
    }),
    applyCommand: ({ room, state, actor, command, now }) => {
      const next = clone(state);
      syncPresence(next.engine, room);
      const payload = command.payload ?? {};
      const seatIndex = getSeatBySession(next.engine, actor.id);
      switch (command.type) {
        case "state.resync":
          return { state: next };
        case "seat.take":
          if (isHandActive(next.engine.stage)) throw new RoomRuntimeError("PHASE_MISMATCH", "牌局进行中不能入座");
          if (seatIndex !== null && seatIndex !== asSeatIndex(payload.seatIndex)) removePlayerFromSeat(next.engine, seatIndex);
          seatPlayer(next.engine, { sessionId: actor.id, nickname: actor.nickname, seatIndex: asSeatIndex(payload.seatIndex), isHost: room.hostParticipantId === actor.id });
          return { state: next };
        case "seat.leave":
          if (seatIndex === null) throw new RoomRuntimeError("PHASE_MISMATCH", "你尚未入座");
          removePlayerFromSeat(next.engine, seatIndex);
          return { state: next };
        case "player.ready":
        case "player.unready":
          if (seatIndex === null) throw new RoomRuntimeError("PHASE_MISMATCH", "请先入座");
          setPlayerReady(next.engine, seatIndex, command.type === "player.ready");
          return { state: next };
        case "player.rebuy":
          if (seatIndex === null || !canRebuyChips(next.engine, seatIndex)) throw new RoomRuntimeError("PHASE_MISMATCH", "当前不能补充筹码");
          rebuyChips(next.engine, seatIndex);
          return { state: next };
        case "hand.start":
          if (room.hostParticipantId !== actor.id) throw new RoomRuntimeError("FORBIDDEN", "只有房主可以开始牌局");
          startHand(next.engine, new Date(now), seededRandom(`${room.id}:${command.requestId}:${next.engine.handNumber + 1}`));
          refreshDeadline(next.engine, now);
          return { state: next, status: "playing" };
        case "action.submit":
          if (seatIndex === null) throw new RoomRuntimeError("PHASE_MISMATCH", "请先入座");
          applyPlayerAction(next.engine, seatIndex, payload as unknown as PlayerActionCommand, new Date(now));
          refreshDeadline(next.engine, now);
          return { state: next, status: "playing" };
        case "timer.action": {
          if (seatIndex === null || next.engine.actingSeatIndex !== seatIndex) throw new RoomRuntimeError("PHASE_MISMATCH", "计时器已经过期");
          if (String(payload.deadlineAt ?? "") !== next.engine.actionDeadlineAt) throw new RoomRuntimeError("PHASE_MISMATCH", "计时器已经更新");
          const actions = getAvailableActions(next.engine, seatIndex);
          const action: PlayerActionCommand = actions.some((candidate) => candidate.type === "check") ? { type: "check" } : { type: "fold" };
          applyPlayerAction(next.engine, seatIndex, action, new Date(now));
          refreshDeadline(next.engine, now);
          return { state: next, status: "playing" };
        }
        case "chat.send":
        case "emoji.send":
          if (seatIndex === null) throw new RoomRuntimeError("FORBIDDEN", "请先入座");
          appendMessage(next, actor.id, actor.nickname, command, now);
          return { state: next };
        default:
          throw new RoomRuntimeError("INVALID_COMMAND", `未知命令：${command.type}`);
      }
    },
    projectForViewer: (state, viewer) => {
      const engine = clone(state.engine);
      const holeCardCounts = Object.fromEntries(engine.seats.filter((player) => player !== null).map((player) => [player!.sessionId, player!.holeCards.length]));
      engine.deck = [];
      for (const player of engine.seats) {
        if (player && player.sessionId !== viewer.id) player.holeCards = [];
      }
      return { engine, messages: clone(state.messages), holeCardCounts };
    },
    serialize: clone,
    restore: (value) => clone(value as TexasState),
    rebuildTimers: ({ room }) => onRestore?.(room.id),
    onParticipantExpired: ({ state, participant }) => {
      const next = clone(state);
      const seatIndex = getSeatBySession(next.engine, participant.id);
      if (seatIndex !== null && !isHandActive(next.engine.stage)) removePlayerFromSeat(next.engine, seatIndex);
      return next;
    },
  };
}

export type TexasRuntimeSnapshot = RuntimeSnapshot<TexasView>;

export function toRoomSnapshot(snapshot: TexasRuntimeSnapshot): RoomSnapshot {
  const engine = snapshot.game.engine;
  const participants = new Map(snapshot.room.participants.map((participant) => [participant.id, participant]));
  const yourSeatIndex = getSeatBySession(engine, snapshot.viewer.participantId);
  return {
    protocolVersion: 1,
    capabilities: snapshot.capabilities,
    roomId: snapshot.room.id,
    roomCode: snapshot.room.code,
    revision: snapshot.room.revision,
    status: snapshot.room.status,
    participantId: snapshot.viewer.participantId,
    config: engine.config,
    handNumber: engine.handNumber,
    stage: engine.stage,
    dealerSeatIndex: engine.dealerSeatIndex,
    smallBlindSeatIndex: engine.smallBlindSeatIndex,
    bigBlindSeatIndex: engine.bigBlindSeatIndex,
    actingSeatIndex: engine.actingSeatIndex,
    actionDeadlineAt: engine.actionDeadlineAt,
    minRaiseTo: engine.minRaiseTo,
    currentBet: engine.currentBet,
    board: engine.board,
    pots: engine.pots,
    seats: engine.seats.map((player, seatIndex) => player ? {
      seatIndex,
      occupied: true,
      player: {
        nickname: player.nickname,
        seatIndex,
        stack: player.stack,
        currentBet: player.currentBet,
        totalCommitted: player.totalCommitted,
        ready: player.ready,
        isHost: snapshot.room.hostParticipantId === player.sessionId,
        status: player.status,
        presence: participants.get(player.sessionId)?.presence === "online" ? "connected" : "disconnected",
        canAct: engine.actingSeatIndex === seatIndex,
        holeCardCount: snapshot.game.holeCardCounts[player.sessionId] ?? 0,
        ...(player.revealedCards ? { revealedCards: player.revealedCards } : {}),
        missedHands: player.missedHands,
        ...(player.lastAction ? { lastAction: player.lastAction } : {}),
        rebuyRemainingHands: player.rebuyHandsRemaining,
        canRebuy: !isHandActive(engine.stage) && player.stack <= 0 && player.status === "out" && player.rebuyHandsRemaining <= 0,
      },
    } : { seatIndex, occupied: false }),
    messages: snapshot.game.messages,
    yourSeatIndex,
    yourHoleCards: yourSeatIndex === null ? [] : engine.seats[yourSeatIndex]?.holeCards ?? [],
    yourAvailableActions: yourSeatIndex === null ? [] : getAvailableActions(engine, yourSeatIndex),
    ...(engine.lastResult ? { lastResult: engine.lastResult } : {}),
    ...(engine.startedAt ? { startedAt: engine.startedAt } : {}),
  };
}

function parseCookies(header = ""): Record<string, string> {
  return Object.fromEntries(header.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return index < 0 ? [part, ""] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
  }));
}

export function tokenFromRequest(request: FastifyRequest): string | undefined {
  return parseCookies(request.headers.cookie)[COOKIE_NAME];
}

export function setGuestCookie(reply: FastifyReply, token: string): void {
  const options = guestCookieOptions();
  reply.setCookie(COOKIE_NAME, token, { httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: options.maxAge });
}

export interface TexasRoomService {
  runtime: RoomRuntime<TexasState, TexasCommand, TexasView>;
  api: RoomApi<TexasState, TexasCommand, TexasView>;
  io: Server;
  broadcast(roomId: string): Promise<void>;
  close(): Promise<void>;
}

export async function startTexasRoomRuntime(app: FastifyInstance, redisUrl: string, origins: string[]): Promise<TexasRoomService> {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 2, enableReadyCheck: true });
  redis.on("error", (error) => app.log.error({ err: error }, "room redis error"));
  let scheduleRoom: (roomId: string) => Promise<void> = async () => undefined;
  const runtime = new RoomRuntime(createTexasAdapter((roomId) => void scheduleRoom(roomId)), {
    store: new RedisRoomStore(redis, { keyPrefix: `room:v1:${GAME_ID}:` }),
    disconnectPolicy: continueWhileMissing({ reconnectWindowMs: 2 * 60 * 60_000 }),
  });
  const api = new RoomApi(runtime);
  const locks = new RedisLockProvider(redis, `room:v1:${GAME_ID}:`);
  const timers = new Map<string, NodeJS.Timeout>();
  const io = new Server(app.server, {
    cors: { origin: origins, credentials: true },
    maxHttpBufferSize: 32 * 1024,
    allowRequest: (request, callback) => callback(null, typeof request.headers.origin === "string" && origins.includes(request.headers.origin)),
  });

  const broadcast = async (roomId: string): Promise<void> => {
    const room = await runtime.loadRoom(roomId);
    if (!room) {
      io.to(roomId).emit("room.expired", { roomId });
      return;
    }
    io.to(roomId).emit("presence.changed", {
      roomId,
      participants: room.participants.map((participant) => ({ participantId: participant.id, presence: participant.presence, connectionCount: Object.keys(participant.connections).length })),
    });
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.roomId !== roomId) continue;
      const participant = room.participants.find((candidate) => candidate.id === socket.data.participantId);
      if (participant) socket.emit("state.snapshot", toRoomSnapshot(runtime.snapshot(room, participant)));
    }
  };

  scheduleRoom = async (roomId) => {
    const previous = timers.get(roomId);
    if (previous) clearTimeout(previous);
    timers.delete(roomId);
    const room = await runtime.loadRoom(roomId);
    const engine = room?.state.engine;
    if (!room || room.status === "paused" || !engine || !isHandActive(engine.stage) || engine.actingSeatIndex === null || !engine.actionDeadlineAt) return;
    const actor = engine.seats[engine.actingSeatIndex];
    if (!actor) return;
    const deadlineAt = engine.actionDeadlineAt;
    const delay = Math.max(0, new Date(deadlineAt).getTime() - Date.now());
    const timer = setTimeout(async () => {
      timers.delete(roomId);
      try {
        const latest = await runtime.loadRoom(roomId);
        if (!latest || latest.state.engine.actionDeadlineAt !== deadlineAt || latest.state.engine.actingSeatIndex === null) return;
        const latestActor = latest.state.engine.seats[latest.state.engine.actingSeatIndex];
        if (!latestActor) return;
        const requestId = `timer:${latest.state.engine.handNumber}:${deadlineAt}:${latest.state.engine.actingSeatIndex}`;
        await runtime.executeForParticipant(latestActor.sessionId, {
          protocolVersion: PROTOCOL_VERSION,
          requestId,
          roomId,
          expectedRevision: latest.revision,
          type: "timer.action",
          payload: { deadlineAt },
        });
        await broadcast(roomId);
        await scheduleRoom(roomId);
      } catch (error) {
        app.log.warn({ err: error, roomId }, "automatic poker action failed");
      }
    }, delay);
    timer.unref();
    timers.set(roomId, timer);
  };

  io.use(async (socket, next) => {
    try {
      socket.data.guest = await runtime.resolveGuest(parseCookies(socket.handshake.headers.cookie)[COOKIE_NAME]);
      next();
    } catch (error) {
      next(new Error(error instanceof RoomRuntimeError ? error.code : "SESSION_EXPIRED"));
    }
  });
  io.on("connection", (socket: Socket) => {
    socket.on("room.attach", async ({ roomId }: { roomId?: string } = {}, acknowledge?: (result: unknown) => void) => {
      try {
        const room = roomId ? await runtime.loadRoom(roomId) : await runtime.getActiveRoom(socket.data.guest as GuestSession);
        if (!room) throw new RoomRuntimeError("ROOM_NOT_FOUND", "没有可恢复的房间");
        const attached = await runtime.attach(socket.data.guest as GuestSession, room.id, socket.id);
        socket.data.roomId = room.id;
        socket.data.participantId = attached.participant.id;
        await socket.join(room.id);
        acknowledge?.({ ok: true, roomId: room.id });
        await broadcast(room.id);
        await scheduleRoom(room.id);
      } catch (error) {
        const mapped = RoomApi.error(error);
        acknowledge?.({ ok: false, ...mapped.body });
      }
    });
    socket.on("command", async (envelope: CommandEnvelope<TexasCommand>, acknowledge?: (result: CommandResponse) => void) => {
      try {
        const result = await runtime.execute(socket.data.guest as GuestSession, envelope);
        acknowledge?.(result);
        socket.emit("command.result", result);
        await broadcast(envelope.roomId);
        await scheduleRoom(envelope.roomId);
      } catch (error) {
        const mapped = RoomApi.error(error).body.error;
        const result: CommandResponse = {
          protocolVersion: PROTOCOL_VERSION,
          requestId: typeof envelope?.requestId === "string" ? envelope.requestId : randomUUID(),
          roomId: typeof envelope?.roomId === "string" ? envelope.roomId : "",
          ok: false,
          revision: Number(mapped.details?.currentRevision ?? envelope?.expectedRevision ?? 0),
          error: mapped as CommandResponse["error"],
        };
        acknowledge?.(result);
        socket.emit("command.result", result);
        if (mapped.code === "STALE_REVISION" && socket.data.roomId) await broadcast(socket.data.roomId);
      }
    });
    socket.on("disconnect", async () => {
      if (!socket.data.roomId) return;
      try {
        await runtime.detach(socket.data.guest as GuestSession, socket.data.roomId, socket.id);
        await broadcast(socket.data.roomId);
      } catch { /* room already expired */ }
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.roomId) void runtime.heartbeat(socket.data.guest as GuestSession, socket.data.roomId, socket.id).catch(() => undefined);
    }
  }, 20_000);
  const sweep = setInterval(async () => {
    const lock = await locks.acquire("sweep", 15_000).catch(() => null);
    if (!lock) return;
    try {
      const result = await runtime.sweep();
      if (result.updated || result.deleted) {
        const roomIds = new Set([...io.sockets.sockets.values()].map((socket) => socket.data.roomId).filter((value): value is string => typeof value === "string"));
        for (const roomId of roomIds) await broadcast(roomId);
      }
    } finally {
      await lock.release();
    }
  }, 1_000);
  heartbeat.unref();
  sweep.unref();
  await runtime.ready();
  return {
    runtime,
    api,
    io,
    broadcast,
    close: async () => {
      clearInterval(heartbeat);
      clearInterval(sweep);
      for (const timer of timers.values()) clearTimeout(timer);
      io.close();
      redis.disconnect(false);
    },
  };
}

export { RoomApi, RoomRuntimeError, PROTOCOL_VERSION };
export type { CommandEnvelope };
