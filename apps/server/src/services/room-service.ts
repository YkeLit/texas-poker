import { randomBytes, randomUUID } from "node:crypto";
import {
  CHAT_THROTTLE_MS,
  EMOJI_THROTTLE_MS,
  MAX_TABLE_PLAYERS,
  type ChatMessage,
  type CreateRoomResponse,
  type GuestSession,
  type JoinRoomResponse,
  type PlayerActionCommand,
  type RecentActionTone,
  type RecentPlayerAction,
  type RoomConfig,
  type RoomSnapshot,
  type RoomSummary,
} from "@texas-poker/shared";
import { getPlayerLabel } from "@texas-poker/shared";
import {
  applyPlayerAction,
  canRebuyChips,
  canStartHand,
  createPokerEngine,
  getAvailableActions,
  getSeatBySession,
  isHandActive,
  rebuyChips,
  removePlayerFromSeat,
  seatPlayer,
  setPlayerPresence,
  setPlayerReady,
  startHand,
  type EnginePlayer,
  type PokerEngineState,
} from "@texas-poker/poker-engine";
import type { CacheAdapter, CachedRoomState } from "../repositories/cache";
import type { PersistenceAdapter } from "../repositories/persistence";
import type { MetricsTracker } from "../lib/metrics";

export interface RoomServiceHooks {
  onRoomEvent?: (roomCode: string, event: string, payload: unknown) => void | Promise<void>;
  onSnapshotRequested?: (roomCode: string) => void | Promise<void>;
}

interface GuestSessionRecord extends GuestSession {
  currentRoomCode?: string;
}

interface RoomRuntime {
  roomCode: string;
  hostSessionId: string;
  engine: PokerEngineState;
  messages: ChatMessage[];
  createdAt: string;
  seatOrder: string[];
  turnTimer?: ReturnType<typeof setTimeout>;
}

export class RoomService {
  private readonly sessions = new Map<string, GuestSessionRecord>();
  private readonly rooms = new Map<string, RoomRuntime>();
  private readonly throttleTimestamps = new Map<string, number>();

  constructor(
    private readonly persistence: PersistenceAdapter,
    private readonly cache: CacheAdapter,
    private readonly metrics: MetricsTracker,
    private readonly hooks: RoomServiceHooks = {},
  ) {}

  async createGuestSession(nickname: string): Promise<GuestSession> {
    const session: GuestSessionRecord = {
      sessionId: randomUUID(),
      nickname,
      resumeToken: randomBytes(24).toString("base64url"),
      createdAt: new Date().toISOString(),
    };

    this.sessions.set(session.sessionId, session);
    await this.persistence.createGuestSession(session);
    await this.cache.saveResumeToken(session.sessionId, session.currentRoomCode ?? "", session.resumeToken);
    return session;
  }

  async createRoom(sessionId: string, config: RoomConfig): Promise<CreateRoomResponse> {
    const session = await this.ensureSessionLoaded(sessionId);
    const normalizedConfig: RoomConfig = {
      ...config,
      maxPlayers: MAX_TABLE_PLAYERS,
    };
    if (normalizedConfig.bigBlind < normalizedConfig.smallBlind) {
      throw new Error("Big blind must be greater than or equal to small blind");
    }
    if (normalizedConfig.rebuyCooldownHands < 0) {
      throw new Error("Rebuy cooldown hands must be zero or greater");
    }

    const roomCode = this.generateRoomCode();
    const room: RoomRuntime = {
      roomCode,
      hostSessionId: sessionId,
      engine: createPokerEngine(normalizedConfig),
      messages: [],
      createdAt: new Date().toISOString(),
      seatOrder: [],
    };

    this.rooms.set(roomCode, room);
    session.currentRoomCode = roomCode;
    this.metrics.setActiveRooms(this.rooms.size);
    await this.persistence.createRoom(roomCode, sessionId, normalizedConfig);
    await this.syncCache(roomCode);
    return {
      roomCode,
      snapshot: this.buildSnapshot(roomCode, sessionId),
    };
  }

  async getRoomSummary(roomCode: string): Promise<RoomSummary> {
    const room = await this.ensureRoomLoaded(roomCode);
    const connectedPlayers = room.engine.seats.filter((player) => player?.presence === "connected").length;
    const seatedPlayers = room.engine.seats.filter(Boolean).length;
    return {
      roomCode,
      config: room.engine.config,
      stage: room.engine.stage,
      connectedPlayers,
      seatedPlayers,
      hasStarted: room.engine.handNumber > 0,
    };
  }

  async joinRoom(roomCode: string, sessionId: string): Promise<JoinRoomResponse> {
    await this.ensureRoomLoaded(roomCode);
    const session = await this.ensureSessionLoaded(sessionId);
    session.currentRoomCode = roomCode;
    await this.cache.saveResumeToken(sessionId, roomCode, session.resumeToken);
    return {
      roomCode,
      wsToken: JSON.stringify({ sessionId, roomCode }),
      snapshot: this.buildSnapshot(roomCode, sessionId),
    };
  }

  buildSnapshot(roomCode: string, viewerSessionId?: string): RoomSnapshot {
    const room = this.requireRoom(roomCode);
    const viewerSeatIndex = viewerSessionId ? getSeatBySession(room.engine, viewerSessionId) : null;
    const yourAvailableActions = viewerSeatIndex !== null ? getAvailableActions(room.engine, viewerSeatIndex) : [];
    const yourHoleCards =
      viewerSeatIndex !== null ? [...(room.engine.seats[viewerSeatIndex]?.holeCards ?? [])] : [];

    return {
      roomCode,
      config: room.engine.config,
      hostSessionId: room.hostSessionId,
      handNumber: room.engine.handNumber,
      stage: room.engine.stage,
      dealerSeatIndex: room.engine.dealerSeatIndex,
      smallBlindSeatIndex: room.engine.smallBlindSeatIndex,
      bigBlindSeatIndex: room.engine.bigBlindSeatIndex,
      actingSeatIndex: room.engine.actingSeatIndex,
      actionDeadlineAt: room.engine.actionDeadlineAt,
      minRaiseTo: room.engine.minRaiseTo,
      currentBet: room.engine.currentBet,
      board: [...room.engine.board],
      pots: room.engine.stage === "showdown" ? [...(room.engine.lastResult?.pots ?? [])] : [...room.engine.pots],
      messages: [...room.messages],
      seats: room.engine.seats.map((player, seatIndex) => ({
        seatIndex,
        occupied: Boolean(player),
        player: player ? this.toPublicPlayer(room.engine, player) : undefined,
      })),
      yourSessionId: viewerSessionId,
      yourSeatIndex: viewerSeatIndex,
      yourHoleCards,
      yourAvailableActions,
      lastResult: room.engine.lastResult,
      startedAt: room.engine.startedAt,
    };
  }

  async handleRoomJoin(roomCode: string, sessionId: string): Promise<RoomSnapshot> {
    await this.ensureRoomLoaded(roomCode);
    const session = await this.ensureSessionLoaded(sessionId);
    session.currentRoomCode = roomCode;
    return this.buildSnapshot(roomCode, sessionId);
  }

  async updateGuestSessionNickname(sessionId: string, resumeToken: string, nickname: string): Promise<GuestSession> {
    const session = await this.ensureSessionLoaded(sessionId);
    if (session.resumeToken !== resumeToken) {
      throw new Error("Resume token is invalid");
    }

    await this.persistence.updateGuestSessionNickname(sessionId, nickname);
    session.nickname = nickname;

    return {
      sessionId: session.sessionId,
      nickname: session.nickname,
      resumeToken: session.resumeToken,
      createdAt: session.createdAt,
    };
  }

  async resumeSession(roomCode: string, sessionId: string, resumeToken: string): Promise<RoomSnapshot> {
    const session = await this.ensureSessionLoaded(sessionId);
    const room = await this.ensureRoomLoaded(roomCode);
    const tokenValid =
      (await this.cache.verifyResumeToken(sessionId, roomCode, resumeToken)) || session.resumeToken === resumeToken;
    if (!tokenValid) {
      throw new Error("Resume token is invalid");
    }

    session.currentRoomCode = roomCode;
    const seatIndex = getSeatBySession(room.engine, sessionId);
    if (seatIndex !== null) {
      setPlayerPresence(room.engine, seatIndex, "connected");
      await this.emitEvent(roomCode, "session.resumed", { seatIndex, sessionId });
      await this.afterMutation(roomCode);
    }
    this.metrics.incrementReconnects();
    return this.buildSnapshot(roomCode, sessionId);
  }

  async takeSeat(roomCode: string, sessionId: string, seatIndex: number): Promise<RoomSnapshot> {
    const room = await this.ensureRoomLoaded(roomCode);
    const session = await this.ensureSessionLoaded(sessionId);
    const currentSeatIndex = getSeatBySession(room.engine, sessionId);
    if (currentSeatIndex !== null && currentSeatIndex !== seatIndex) {
      throw new Error("Player is already seated");
    }

    if (!room.hostSessionId) {
      room.hostSessionId = sessionId;
    }
    session.currentRoomCode = roomCode;

    const player = seatPlayer(room.engine, {
      sessionId,
      nickname: session.nickname,
      seatIndex,
      isHost: room.hostSessionId === sessionId,
    });
    player.presence = "connected";
    player.lastAction = makeRecentAction("已入座", "neutral");
    addSeatOrder(room, sessionId);
    await this.emitEvent(roomCode, "player.presence", { seatIndex, sessionId, presence: "connected" });
    await this.afterMutation(roomCode);
    return this.buildSnapshot(roomCode, sessionId);
  }

  async leaveSeat(roomCode: string, sessionId: string): Promise<RoomSnapshot> {
    const room = await this.ensureRoomLoaded(roomCode);
    const seatIndex = this.requireSeat(room.engine, sessionId);
    removePlayerFromSeat(room.engine, seatIndex);
    room.seatOrder = room.seatOrder.filter((value) => value !== sessionId);
    if (room.hostSessionId === sessionId) {
      this.transferHost(room);
    }
    await this.emitEvent(roomCode, "player.presence", { seatIndex, sessionId, presence: "left" });
    await this.afterMutation(roomCode);
    return this.buildSnapshot(roomCode, sessionId);
  }

  async toggleReady(roomCode: string, sessionId: string, ready: boolean): Promise<RoomSnapshot> {
    const room = await this.ensureRoomLoaded(roomCode);
    const seatIndex = this.requireSeat(room.engine, sessionId);
    setPlayerReady(room.engine, seatIndex, ready);
    room.engine.seats[seatIndex]!.lastAction = makeRecentAction(ready ? "已准备" : "取消准备", ready ? "safe" : "neutral");
    await this.afterMutation(roomCode);
    return this.buildSnapshot(roomCode, sessionId);
  }

  async startHand(roomCode: string, sessionId: string): Promise<RoomSnapshot> {
    const room = await this.ensureRoomLoaded(roomCode);
    if (room.hostSessionId !== sessionId) {
      throw new Error("Only the host can start the first hand");
    }

    clearRecentActions(room.engine);
    startHand(room.engine, new Date());
    await this.emitEvent(roomCode, "action.applied", { type: "hand.start", seatIndex: this.requireSeat(room.engine, sessionId) });
    this.scheduleTurn(roomCode);
    await this.afterMutation(roomCode);
    return this.buildSnapshot(roomCode, sessionId);
  }

  async rebuyPlayer(roomCode: string, sessionId: string): Promise<RoomSnapshot> {
    const room = await this.ensureRoomLoaded(roomCode);
    const seatIndex = this.requireSeat(room.engine, sessionId);
    rebuyChips(room.engine, seatIndex);
    room.engine.seats[seatIndex]!.lastAction = makeRecentAction("已补充筹码", "safe");
    await this.afterMutation(roomCode);
    return this.buildSnapshot(roomCode, sessionId);
  }

  async submitAction(roomCode: string, sessionId: string, action: PlayerActionCommand): Promise<RoomSnapshot> {
    const room = await this.ensureRoomLoaded(roomCode);
    const seatIndex = this.requireSeat(room.engine, sessionId);
    const player = room.engine.seats[seatIndex]!;
    const beforeStage = room.engine.stage;
    const currentBetBefore = player.currentBet;
    const toCall = Math.max(0, room.engine.currentBet - player.currentBet);
    const stackBeforeAction = player.stack;

    applyPlayerAction(room.engine, seatIndex, action, new Date());
    player.lastAction = formatRecentAction(action, { currentBetBefore, toCall, stackBeforeAction });
    await this.emitEvent(roomCode, "action.applied", { seatIndex, action });
    await this.emitEvent(roomCode, "pot.updated", { pots: room.engine.pots, currentBet: room.engine.currentBet });

    if (room.engine.actingSeatIndex !== null && room.engine.stage !== "showdown") {
      await this.emitEvent(roomCode, "turn.started", {
        actingSeatIndex: room.engine.actingSeatIndex,
        deadlineAt: room.engine.actionDeadlineAt,
      });
    }

    if (room.engine.stage === "showdown" && beforeStage !== "showdown" && room.engine.lastResult) {
      await this.persistence.saveHandResult(roomCode, room.engine.lastResult);
      await this.emitEvent(roomCode, "hand.result", room.engine.lastResult);
    }
    this.scheduleTurn(roomCode);
    await this.afterMutation(roomCode);
    return this.buildSnapshot(roomCode, sessionId);
  }

  async sendChat(roomCode: string, sessionId: string, content: string): Promise<RoomSnapshot> {
    return this.appendMessage(roomCode, sessionId, "chat", content);
  }

  async sendEmoji(roomCode: string, sessionId: string, content: string): Promise<RoomSnapshot> {
    return this.appendMessage(roomCode, sessionId, "emoji", content);
  }

  async markDisconnected(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session?.currentRoomCode) {
      return;
    }

    const room = this.rooms.get(session.currentRoomCode);
    if (!room) {
      return;
    }

    const seatIndex = getSeatBySession(room.engine, sessionId);
    if (seatIndex === null) {
      return;
    }

    setPlayerPresence(room.engine, seatIndex, "disconnected");
    await this.emitEvent(room.roomCode, "player.disconnected", { seatIndex, sessionId });
    await this.afterMutation(room.roomCode);
  }

  async reportClientError(payload: {
    sessionId?: string;
    roomCode?: string;
    message: string;
    stack?: string;
    metadata?: Record<string, string | number | boolean | null>;
  }): Promise<void> {
    this.metrics.incrementErrors();
    if (payload.roomCode) {
      await this.emitEvent(payload.roomCode, "client.error", payload);
    }
  }

  getMetrics() {
    return this.metrics.getSnapshot();
  }

  async close(): Promise<void> {
    for (const room of this.rooms.values()) {
      if (room.turnTimer) {
        clearTimeout(room.turnTimer);
      }
    }
    await this.cache.close();
    await this.persistence.close();
  }

  private async appendMessage(
    roomCode: string,
    sessionId: string,
    type: "chat" | "emoji",
    content: string,
  ): Promise<RoomSnapshot> {
    const room = await this.ensureRoomLoaded(roomCode);
    const seatIndex = this.requireSeat(room.engine, sessionId);
    const player = room.engine.seats[seatIndex]!;
    const throttleKey = `${sessionId}:${type}`;
    const now = Date.now();
    const lastSentAt = this.throttleTimestamps.get(throttleKey) ?? 0;
    const threshold = type === "chat" ? CHAT_THROTTLE_MS : EMOJI_THROTTLE_MS;
    if (now - lastSentAt < threshold) {
      throw new Error("Messages are being sent too quickly");
    }

    this.throttleTimestamps.set(throttleKey, now);
    const message: ChatMessage = {
      id: randomUUID(),
      type,
      content,
      createdAt: new Date(now).toISOString(),
      senderSessionId: sessionId,
      senderNickname: player.nickname,
    };
    room.messages = [...room.messages.slice(-49), message];
    await this.persistence.saveChatMessage(roomCode, message);
    await this.emitEvent(roomCode, "chat.message", message);
    await this.afterMutation(roomCode);
    return this.buildSnapshot(roomCode, sessionId);
  }

  private async afterMutation(roomCode: string): Promise<void> {
    const room = this.requireRoom(roomCode);
    this.scheduleTurn(roomCode);
    await this.syncCache(roomCode);
    await this.requestSnapshot(roomCode);
  }

  private async syncCache(roomCode: string): Promise<void> {
    const room = this.requireRoom(roomCode);
    await this.cache.saveRoomSnapshot(roomCode, this.buildSnapshot(roomCode));
    await this.cache.saveRoomState(roomCode, this.toCachedRoomState(room));
  }

  private async requestSnapshot(roomCode: string): Promise<void> {
    await this.hooks.onSnapshotRequested?.(roomCode);
  }

  private async emitEvent(roomCode: string, event: string, payload: unknown): Promise<void> {
    await this.hooks.onRoomEvent?.(roomCode, event, payload);
  }

  private scheduleTurn(roomCode: string): void {
    const room = this.requireRoom(roomCode);
    if (room.turnTimer) {
      clearTimeout(room.turnTimer);
      room.turnTimer = undefined;
    }

    if (!isHandActive(room.engine.stage) || room.engine.actingSeatIndex === null) {
      room.engine.actionDeadlineAt = null;
      return;
    }

    const deadlineAt = new Date(Date.now() + room.engine.config.actionTimeSeconds * 1_000);
    room.engine.actionDeadlineAt = deadlineAt.toISOString();
    void this.emitEvent(roomCode, "turn.started", {
      actingSeatIndex: room.engine.actingSeatIndex,
      deadlineAt: room.engine.actionDeadlineAt,
    });

    room.turnTimer = setTimeout(() => {
      void this.handleTurnTimeout(roomCode);
    }, room.engine.config.actionTimeSeconds * 1_000);
  }

  private async handleTurnTimeout(roomCode: string): Promise<void> {
    const room = this.requireRoom(roomCode);
    const actingSeatIndex = room.engine.actingSeatIndex;
    if (actingSeatIndex === null) {
      return;
    }

    const availableActions = getAvailableActions(room.engine, actingSeatIndex);
    const timeoutAction: PlayerActionCommand = availableActions.some((action) => action.type === "check")
      ? { type: "check" }
      : { type: "fold" };

    this.metrics.incrementTimeoutAutoActions();
    await this.submitAction(roomCode, this.requirePlayerSession(room.engine, actingSeatIndex), timeoutAction);
  }

  private transferHost(room: RoomRuntime): void {
    const nextSessionId =
      room.seatOrder.find((sessionId) => {
        const seatIndex = getSeatBySession(room.engine, sessionId);
        if (seatIndex === null) {
          return false;
        }
        return room.engine.seats[seatIndex]?.presence === "connected";
      }) ??
      room.seatOrder.find((sessionId) => getSeatBySession(room.engine, sessionId) !== null);

    if (!nextSessionId) {
      room.hostSessionId = "";
      return;
    }

    room.hostSessionId = nextSessionId;
    for (const player of room.engine.seats) {
      if (player) {
        player.isHost = player.sessionId === nextSessionId;
      }
    }
    const seatIndex = getSeatBySession(room.engine, nextSessionId);
    if (seatIndex !== null) {
      void this.emitEvent(room.roomCode, "chat.message", {
        id: randomUUID(),
        type: "system",
        content: `${getPlayerLabel(room.engine.seats[seatIndex] ?? undefined)} 成为新的房主`,
        createdAt: new Date().toISOString(),
      } satisfies ChatMessage);
    }
  }

  private async ensureSessionLoaded(sessionId: string): Promise<GuestSessionRecord> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }

    const persisted = await this.persistence.getGuestSession(sessionId);
    if (!persisted) {
      throw new Error("Session not found");
    }

    const session: GuestSessionRecord = { ...persisted };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  private async ensureRoomLoaded(roomCode: string): Promise<RoomRuntime> {
    const existing = this.rooms.get(roomCode);
    if (existing) {
      return existing;
    }

    const cachedRoom = await this.cache.getRoomState(roomCode);
    if (cachedRoom) {
      const room = this.fromCachedRoomState(cachedRoom);
      this.rooms.set(roomCode, room);
      this.metrics.setActiveRooms(this.rooms.size);
      this.restoreRoomTimers(roomCode);
      return room;
    }

    const persistedRoom = await this.persistence.getRoom(roomCode);
    if (!persistedRoom) {
      throw new Error("Room not found");
    }

    const room: RoomRuntime = {
      roomCode,
      hostSessionId: "",
      engine: createPokerEngine(persistedRoom.config),
      messages: [],
      createdAt: persistedRoom.createdAt,
      seatOrder: [],
    };
    this.rooms.set(roomCode, room);
    this.metrics.setActiveRooms(this.rooms.size);
    await this.syncCache(roomCode);
    return room;
  }

  private restoreRoomTimers(roomCode: string): void {
    const room = this.requireRoom(roomCode);
    if (isHandActive(room.engine.stage) && room.engine.actingSeatIndex !== null) {
      if (!room.engine.actionDeadlineAt) {
        this.scheduleTurn(roomCode);
        return;
      }
      const timeoutMs = Math.max(0, new Date(room.engine.actionDeadlineAt).getTime() - Date.now());
      room.turnTimer = setTimeout(() => {
        void this.handleTurnTimeout(roomCode);
      }, timeoutMs);
      return;
    }

  }

  private toCachedRoomState(room: RoomRuntime): CachedRoomState {
    return {
      roomCode: room.roomCode,
      hostSessionId: room.hostSessionId,
      engine: room.engine,
      messages: room.messages,
      createdAt: room.createdAt,
      seatOrder: room.seatOrder,
    };
  }

  private fromCachedRoomState(state: CachedRoomState): RoomRuntime {
    return {
      roomCode: state.roomCode,
      hostSessionId: state.hostSessionId,
      engine: state.engine,
      messages: state.messages,
      createdAt: state.createdAt,
      seatOrder: state.seatOrder,
    };
  }

  private generateRoomCode(): string {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    while (true) {
      let code = "";
      for (let index = 0; index < 6; index += 1) {
        code += alphabet[Math.floor(Math.random() * alphabet.length)];
      }
      if (!this.rooms.has(code)) {
        return code;
      }
    }
  }

  private toPublicPlayer(engine: PokerEngineState, player: EnginePlayer) {
    return {
      sessionId: player.sessionId,
      nickname: player.nickname,
      seatIndex: player.seatIndex,
      stack: player.stack,
      currentBet: player.currentBet,
      totalCommitted: player.totalCommitted,
      ready: player.ready,
      isHost: player.isHost,
      status: player.status,
      presence: player.presence,
      canAct: player.status === "active",
      holeCardCount: player.holeCards.length,
      revealedCards: player.revealedCards,
      missedHands: player.missedHands,
      lastAction: player.lastAction,
      rebuyRemainingHands: player.rebuyHandsRemaining,
      canRebuy: canRebuyChips(engine, player.seatIndex),
    };
  }

  private requireSession(sessionId: string): GuestSessionRecord {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Session not found");
    }
    return session;
  }

  private requireRoom(roomCode: string): RoomRuntime {
    const room = this.rooms.get(roomCode);
    if (!room) {
      throw new Error("Room not found");
    }
    return room;
  }

  private requireSeat(engine: PokerEngineState, sessionId: string): number {
    const seatIndex = getSeatBySession(engine, sessionId);
    if (seatIndex === null) {
      throw new Error("Player is not seated");
    }
    return seatIndex;
  }

  private requirePlayerSession(engine: PokerEngineState, seatIndex: number): string {
    const player = engine.seats[seatIndex];
    if (!player) {
      throw new Error("Seat is empty");
    }
    return player.sessionId;
  }
}

function addSeatOrder(room: RoomRuntime, sessionId: string): void {
  if (!room.seatOrder.includes(sessionId)) {
    room.seatOrder.push(sessionId);
  }
}

function clearRecentActions(engine: PokerEngineState): void {
  for (const player of engine.seats) {
    if (player) {
      player.lastAction = undefined;
    }
  }
}

function makeRecentAction(label: string, tone: RecentActionTone): RecentPlayerAction {
  return { label, tone };
}

function formatRecentAction(
  action: PlayerActionCommand,
  meta: { currentBetBefore: number; toCall: number; stackBeforeAction: number },
): RecentPlayerAction {
  switch (action.type) {
    case "check":
      return makeRecentAction("过牌", "safe");
    case "call":
      return makeRecentAction(`跟注 ${Math.min(meta.toCall, meta.stackBeforeAction)}`, "safe");
    case "bet":
      return makeRecentAction(`下注 ${Math.max(0, (action.amount ?? meta.currentBetBefore) - meta.currentBetBefore)}`, "aggressive");
    case "raise":
      return makeRecentAction(`加注 ${Math.max(0, (action.amount ?? meta.currentBetBefore) - meta.currentBetBefore)}`, "aggressive");
    case "all_in":
      return makeRecentAction(`全下 ${meta.stackBeforeAction}`, "aggressive");
    case "fold":
    default:
      return makeRecentAction("弃牌", "neutral");
  }
}
