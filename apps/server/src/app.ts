import Fastify from "fastify";
import cors from "@fastify/cors";
import { Server as SocketIOServer } from "socket.io";
import {
  chatMessageSchema,
  createGuestSessionSchema,
  createRoomSchema,
  emojiMessageSchema,
  joinRoomSchema,
  playerActionSchema,
  reconnectSchema,
  seatActionSchema,
} from "@texas-poker/shared";
import { normalizeClientOrigins, readConfig, type AppConfig } from "./config";
import { createPrismaClient } from "./db/prisma";
import { createRedisClient } from "./db/redis";
import { log } from "./lib/logger";
import { MetricsTracker } from "./lib/metrics";
import { createSignedToken, verifySignedToken } from "./lib/tokens";
import { MemoryCacheAdapter, RedisCacheAdapter, type CacheAdapter } from "./repositories/cache";
import { NoopPersistenceAdapter, PrismaPersistenceAdapter, type PersistenceAdapter } from "./repositories/persistence";
import { RoomService } from "./services/room-service";

interface BuildAppOptions {
  config?: AppConfig;
  persistence?: PersistenceAdapter;
  cache?: CacheAdapter;
}

export async function buildApp(options: BuildAppOptions = {}) {
  const config = options.config ?? readConfig();
  const clientOrigins = normalizeClientOrigins(config.clientOrigin);
  const corsOrigin = clientOrigins.length === 1 ? clientOrigins[0]! : clientOrigins;
  const prisma = await createPrismaClient(config.databaseUrl);
  const redis = createRedisClient(config.redisUrl);
  const persistence = options.persistence ?? (prisma ? new PrismaPersistenceAdapter(prisma) : new NoopPersistenceAdapter());
  let cache: CacheAdapter = options.cache ?? new MemoryCacheAdapter();

  if (!options.cache && redis) {
    try {
      await redis.connect();
      cache = new RedisCacheAdapter(redis);
    } catch (error) {
      log("warn", "Redis connection failed, falling back to memory cache", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const metrics = new MetricsTracker();
  const app = Fastify({
    logger: false,
  });

  await app.register(cors, {
    origin: corsOrigin,
    credentials: true,
  });

  const io = new SocketIOServer(app.server, {
    cors: {
      origin: corsOrigin,
      credentials: true,
    },
  });

  const sessionConnections = new Map<string, Set<string>>();
  const roomService = new RoomService(persistence, cache, metrics, {
    onRoomEvent: async (roomCode, event, payload) => {
      io.to(roomCode).emit(event, payload);
    },
    onSnapshotRequested: async (roomCode) => {
      const sockets = await io.in(roomCode).fetchSockets();
      for (const socket of sockets) {
        const sessionId = socket.data.sessionId as string | undefined;
        socket.emit("room.snapshot", roomService.buildSnapshot(roomCode, sessionId));
      }
    },
  });

  app.get("/healthz", async () => ({
    ok: true,
    rooms: roomService.getMetrics().activeRooms,
    connections: roomService.getMetrics().activeConnections,
  }));

  app.get("/api/v1/ops/metrics", async () => roomService.getMetrics());

  app.post("/api/v1/guest/sessions", async (request, reply) => {
    const parsed = createGuestSessionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const session = await roomService.createGuestSession(parsed.data.nickname);
    return reply.code(201).send(session);
  });

  app.post("/api/v1/rooms", async (request, reply) => {
    const parsed = createRoomSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      const response = await roomService.createRoom(parsed.data.sessionId, parsed.data.config);
      return reply.code(201).send(response);
    } catch (error) {
      return reply.code(400).send({ error: toErrorMessage(error) });
    }
  });

  app.get("/api/v1/rooms/:roomCode", async (request, reply) => {
    const roomCode = (request.params as { roomCode: string }).roomCode;
    try {
      return reply.send(await roomService.getRoomSummary(roomCode));
    } catch (error) {
      return reply.code(404).send({ error: toErrorMessage(error) });
    }
  });

  app.post("/api/v1/rooms/:roomCode/join", async (request, reply) => {
    const roomCode = (request.params as { roomCode: string }).roomCode;
    const parsed = joinRoomSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      const response = await roomService.joinRoom(roomCode, parsed.data.sessionId);
      response.wsToken = createSignedToken(
        {
          roomCode,
          sessionId: parsed.data.sessionId,
          type: "room",
        },
        config.tokenSecret,
      );
      return reply.send(response);
    } catch (error) {
      return reply.code(400).send({ error: toErrorMessage(error) });
    }
  });

  app.post("/api/v1/reports/errors", async (request, reply) => {
    const payload = request.body as {
      sessionId?: string;
      roomCode?: string;
      message?: string;
      stack?: string;
      metadata?: Record<string, string | number | boolean | null>;
    };

    if (!payload?.message) {
      return reply.code(400).send({ error: "message is required" });
    }

    await roomService.reportClientError({
      sessionId: payload.sessionId,
      roomCode: payload.roomCode,
      message: payload.message,
      stack: payload.stack,
      metadata: payload.metadata,
    });
    return reply.code(202).send({ accepted: true });
  });

  io.on("connection", (socket) => {
    socket.on("room.join", async (payload, ack) => {
      try {
        const tokenPayload = verifySignedToken<{ roomCode: string; sessionId: string; type: string }>(payload.token, config.tokenSecret);
        if (tokenPayload.roomCode !== payload.roomCode || tokenPayload.sessionId !== payload.sessionId || tokenPayload.type !== "room") {
          throw new Error("Socket token does not match room join payload");
        }

        socket.data.sessionId = payload.sessionId;
        socket.data.roomCode = payload.roomCode;
        socket.join(payload.roomCode);
        registerSessionConnection(sessionConnections, metrics, payload.sessionId, socket.id);

        const snapshot = await roomService.handleRoomJoin(payload.roomCode, payload.sessionId);
        socket.emit("room.snapshot", snapshot);
        ack?.({ ok: true, snapshot });
      } catch (error) {
        ack?.({ ok: false, error: toErrorMessage(error) });
      }
    });

    socket.on("session.resume", async (payload, ack) => {
      const parsed = reconnectSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ ok: false, error: parsed.error.flatten() });
        return;
      }

      try {
        socket.data.sessionId = parsed.data.sessionId;
        socket.data.roomCode = parsed.data.roomCode;
        socket.join(parsed.data.roomCode);
        registerSessionConnection(sessionConnections, metrics, parsed.data.sessionId, socket.id);
        const snapshot = await roomService.resumeSession(parsed.data.roomCode, parsed.data.sessionId, parsed.data.resumeToken);
        socket.emit("room.snapshot", snapshot);
        ack?.({ ok: true, snapshot });
      } catch (error) {
        ack?.({ ok: false, error: toErrorMessage(error) });
      }
    });

    socket.on("seat.take", async (payload, ack) => {
      const parsed = seatActionSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ ok: false, error: parsed.error.flatten() });
        return;
      }
      await runSocketMutation(socket, ack, async () => roomService.takeSeat(requireRoomCode(socket), requireSessionId(socket), parsed.data.seatIndex));
    });

    socket.on("seat.leave", async (_payload, ack) => {
      await runSocketMutation(socket, ack, async () => roomService.leaveSeat(requireRoomCode(socket), requireSessionId(socket)));
    });

    socket.on("player.ready", async (_payload, ack) => {
      await runSocketMutation(socket, ack, async () => roomService.toggleReady(requireRoomCode(socket), requireSessionId(socket), true));
    });

    socket.on("player.unready", async (_payload, ack) => {
      await runSocketMutation(socket, ack, async () => roomService.toggleReady(requireRoomCode(socket), requireSessionId(socket), false));
    });

    socket.on("hand.start", async (_payload, ack) => {
      await runSocketMutation(socket, ack, async () => roomService.startHand(requireRoomCode(socket), requireSessionId(socket)));
    });

    socket.on("player.rebuy", async (_payload, ack) => {
      await runSocketMutation(socket, ack, async () => roomService.rebuyPlayer(requireRoomCode(socket), requireSessionId(socket)));
    });

    socket.on("action.submit", async (payload, ack) => {
      const parsed = playerActionSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ ok: false, error: parsed.error.flatten() });
        return;
      }
      await runSocketMutation(socket, ack, async () => roomService.submitAction(requireRoomCode(socket), requireSessionId(socket), parsed.data));
    });

    socket.on("chat.send", async (payload, ack) => {
      const parsed = chatMessageSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ ok: false, error: parsed.error.flatten() });
        return;
      }
      await runSocketMutation(socket, ack, async () => roomService.sendChat(requireRoomCode(socket), requireSessionId(socket), parsed.data.content));
    });

    socket.on("emoji.send", async (payload, ack) => {
      const parsed = emojiMessageSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ ok: false, error: parsed.error.flatten() });
        return;
      }
      await runSocketMutation(socket, ack, async () => roomService.sendEmoji(requireRoomCode(socket), requireSessionId(socket), parsed.data.content));
    });

    socket.on("disconnect", async () => {
      const sessionId = socket.data.sessionId as string | undefined;
      if (!sessionId) {
        return;
      }

      const stillConnected = unregisterSessionConnection(sessionConnections, metrics, sessionId, socket.id);
      if (!stillConnected) {
        await roomService.markDisconnected(sessionId);
      }
    });
  });

  async function close() {
    io.removeAllListeners();
    await roomService.close();
    await app.close();
    if (redis && redis.status !== "end") {
      await redis.quit();
    }
  }

  return {
    app,
    io,
    roomService,
    close,
  };
}

async function runSocketMutation(
  socket: { emit: (event: string, payload: unknown) => void },
  ack: ((payload: unknown) => void) | undefined,
  callback: () => Promise<unknown>,
) {
  try {
    const snapshot = await callback();
    socket.emit("room.snapshot", snapshot);
    ack?.({ ok: true, snapshot });
  } catch (error) {
    ack?.({ ok: false, error: toErrorMessage(error) });
  }
}

function requireSessionId(socket: { data: Record<string, unknown> }): string {
  const sessionId = socket.data.sessionId;
  if (typeof sessionId !== "string") {
    throw new Error("Socket session is missing");
  }
  return sessionId;
}

function requireRoomCode(socket: { data: Record<string, unknown> }): string {
  const roomCode = socket.data.roomCode;
  if (typeof roomCode !== "string") {
    throw new Error("Socket room is missing");
  }
  return roomCode;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function registerSessionConnection(
  sessionConnections: Map<string, Set<string>>,
  metrics: MetricsTracker,
  sessionId: string,
  socketId: string,
): void {
  const existing = sessionConnections.get(sessionId) ?? new Set<string>();
  existing.add(socketId);
  sessionConnections.set(sessionId, existing);
  metrics.setActiveConnections([...sessionConnections.values()].reduce((sum, ids) => sum + ids.size, 0));
}

function unregisterSessionConnection(
  sessionConnections: Map<string, Set<string>>,
  metrics: MetricsTracker,
  sessionId: string,
  socketId: string,
): boolean {
  const existing = sessionConnections.get(sessionId);
  if (!existing) {
    return false;
  }
  existing.delete(socketId);
  if (existing.size === 0) {
    sessionConnections.delete(sessionId);
  }
  metrics.setActiveConnections([...sessionConnections.values()].reduce((sum, ids) => sum + ids.size, 0));
  return existing.size > 0;
}
