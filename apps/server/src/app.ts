import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import Fastify, { type FastifyReply } from "fastify";
import { createRoomSchema, errorReportSchema, joinRoomSchema } from "@texas-poker/shared";
import type { AppConfig } from "./config";
import {
  RoomApi,
  RoomRuntimeError,
  setGuestCookie,
  startTexasRoomRuntime,
  tokenFromRequest,
} from "./shared-runtime";

export interface BuildAppOptions {
  config: AppConfig;
}

function sendRoomError(reply: FastifyReply, error: unknown) {
  const mapped = RoomApi.error(error);
  return reply.code(mapped.status).send(mapped.body);
}

export async function buildApp(options: BuildAppOptions) {
  const origins = Array.isArray(options.config.clientOrigin) ? options.config.clientOrigin : [options.config.clientOrigin];
  if (!options.config.redisUrl) throw new Error("Room Redis is required");
  const app = Fastify({
    logger: { redact: ["req.headers.cookie", "res.headers.set-cookie"] },
  });
  await app.register(cookie);
  await app.register(cors, { origin: origins, credentials: true });
  const roomService = await startTexasRoomRuntime(app, options.config.redisUrl, origins);

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async (_request, reply) => {
    try {
      await roomService.runtime.ready();
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  app.post("/api/v1/rooms", async (request, reply) => {
    const parsed = createRoomSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_COMMAND", message: parsed.error.issues[0]?.message ?? "请求不正确" } });
    try {
      const result = await roomService.api.create(tokenFromRequest(request), { nickname: parsed.data.nickname, settings: parsed.data.config });
      if (result.guestToken) setGuestCookie(reply, result.guestToken);
      return reply.code(result.status).send(result.body);
    } catch (error) {
      return sendRoomError(reply, error);
    }
  });

  app.post("/api/v1/rooms/join", async (request, reply) => {
    const parsed = joinRoomSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_COMMAND", message: parsed.error.issues[0]?.message ?? "请求不正确" } });
    try {
      const result = await roomService.api.join(tokenFromRequest(request), parsed.data);
      if (result.guestToken) setGuestCookie(reply, result.guestToken);
      return reply.code(result.status).send(result.body);
    } catch (error) {
      return sendRoomError(reply, error);
    }
  });

  app.get("/api/v1/session/active-room", async (request, reply) => {
    try {
      const result = await roomService.api.activeRoom(tokenFromRequest(request));
      return reply.code(result.status).send(result.body);
    } catch (error) {
      return sendRoomError(reply, error);
    }
  });

  app.post<{ Params: { roomId: string } }>("/api/v1/rooms/:roomId/leave", async (request, reply) => {
    try {
      if (request.headers.origin !== undefined && !origins.includes(request.headers.origin)) throw new RoomRuntimeError("FORBIDDEN", "Origin 不允许");
      await roomService.api.leave(tokenFromRequest(request), request.params.roomId);
      await roomService.broadcast(request.params.roomId);
      return reply.code(204).send();
    } catch (error) {
      return sendRoomError(reply, error);
    }
  });

  app.post("/api/v1/reports/errors", async (request, reply) => {
    const parsed = errorReportSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid error report" });
    try {
      await roomService.runtime.resolveGuest(tokenFromRequest(request));
      app.log.warn({ clientReport: parsed.data }, "client error report");
      return reply.code(202).send({ accepted: true });
    } catch (error) {
      return sendRoomError(reply, error);
    }
  });

  app.addHook("onClose", async () => {
    await roomService.close();
  });

  return { app, roomService };
}
