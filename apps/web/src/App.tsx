import { useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import {
  type ChatMessage,
  MAX_TABLE_PLAYERS,
  type GuestSession,
  type RoomConfig,
  type RoomSnapshot,
} from "@texas-poker/shared";
import { createGuestSession, createRoom, getRoomSummary, joinRoom, reportClientError, updateGuestSessionNickname } from "./lib/api";
import { ActionPanel } from "./components/ActionPanel";
import { ChatPanel } from "./components/ChatPanel";
import { CommunityBoard } from "./components/CommunityBoard";
import { SeatRing } from "./components/SeatRing";

const STORAGE_KEYS = {
  session: "texas-poker.session",
  roomCode: "texas-poker.roomCode",
};

interface RoomConfigDraft {
  startingStack: string;
  smallBlind: string;
  bigBlind: string;
  actionTimeSeconds: string;
  rebuyCooldownHands: string;
}

const DEFAULT_CONFIG: RoomConfig = {
  maxPlayers: MAX_TABLE_PLAYERS,
  startingStack: 2000,
  smallBlind: 10,
  bigBlind: 20,
  actionTimeSeconds: 20,
  rebuyCooldownHands: 2,
};

export default function App() {
  const [session, setSession] = useState<GuestSession | null>(() => {
    const raw = localStorage.getItem(STORAGE_KEYS.session);
    return raw ? (JSON.parse(raw) as GuestSession) : null;
  });
  const [nicknameDraft, setNicknameDraft] = useState("");
  const [roomCodeDraft, setRoomCodeDraft] = useState(() => localStorage.getItem(STORAGE_KEYS.roomCode) ?? "");
  const [configDraft, setConfigDraft] = useState<RoomConfigDraft>(() => roomConfigToDraft(DEFAULT_CONFIG));
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [status, setStatus] = useState("输入昵称，创建房间。");
  const [error, setError] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [chatDrawerOpen, setChatDrawerOpen] = useState(false);
  const [clockOffset, setClockOffset] = useState(0);
  const [tick, setTick] = useState(0);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const interval = window.setInterval(() => setTick((value) => value + 1), 500);
    return () => window.clearInterval(interval);
  }, []);

  const currentTime = Date.now() + clockOffset + tick * 0;

  useEffect(() => {
    if (!session) {
      return;
    }
    localStorage.setItem(STORAGE_KEYS.session, JSON.stringify(session));
  }, [session]);

  useEffect(() => {
    if (!session) {
      return;
    }
    setNicknameDraft(session.nickname);
  }, [session?.nickname, session?.sessionId]);

  useEffect(() => {
    if (snapshot?.roomCode) {
      localStorage.setItem(STORAGE_KEYS.roomCode, snapshot.roomCode);
      setRoomCodeDraft(snapshot.roomCode);
    }
  }, [snapshot?.roomCode]);

  useEffect(() => {
    window.render_game_to_text = () =>
      JSON.stringify({
        mode: snapshot?.stage ?? "lobby",
        roomCode: snapshot?.roomCode ?? null,
        currentBet: snapshot?.currentBet ?? 0,
        board: snapshot?.board ?? [],
        yourSeatIndex: snapshot?.yourSeatIndex ?? null,
        smallBlindSeatIndex: snapshot?.smallBlindSeatIndex ?? null,
        bigBlindSeatIndex: snapshot?.bigBlindSeatIndex ?? null,
        actingSeatIndex: snapshot?.actingSeatIndex ?? null,
        yourActions: snapshot?.yourAvailableActions.map((action) => action.type) ?? [],
        players:
          snapshot?.seats.map((seat) => ({
            seatIndex: seat.seatIndex,
            occupied: seat.occupied,
            nickname: seat.player?.nickname ?? null,
            stack: seat.player?.stack ?? 0,
            status: seat.player?.status ?? null,
            presence: seat.player?.presence ?? null,
            currentBet: seat.player?.currentBet ?? 0,
            lastAction: seat.player?.lastAction?.label ?? null,
          })) ?? [],
      });

    window.__POKER_DEBUG__ = {
      advance: (milliseconds: number) => {
        setClockOffset((value) => value + milliseconds);
      },
    };
  }, [snapshot]);

  useEffect(() => {
    if (!session) {
      return;
    }

    const lastRoomCode = localStorage.getItem(STORAGE_KEYS.roomCode);
    if (!lastRoomCode || snapshot) {
      return;
    }

    void connectToRoom(lastRoomCode, session, true);
  }, [session, snapshot]);

  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      if (!session?.sessionId || !session.resumeToken) {
        return;
      }
      void reportClientError({
        sessionId: session.sessionId,
        resumeToken: session.resumeToken,
        roomCode: snapshot?.roomCode,
        message: event.message,
        stack: event.error instanceof Error ? event.error.stack : undefined,
      }).catch(() => undefined);
    };

    window.addEventListener("error", handleError);
    return () => window.removeEventListener("error", handleError);
  }, [session?.resumeToken, session?.sessionId, snapshot?.roomCode]);

  const roomSummary = useMemo(() => {
    if (!snapshot) {
      return null;
    }
    return `房号 ${snapshot.roomCode} · ${snapshot.config.smallBlind}/${snapshot.config.bigBlind}`;
  }, [snapshot]);
  const parsedConfig = useMemo(() => parseRoomConfigDraft(configDraft), [configDraft]);
  const stackConfigured = useMemo(() => parseConfigNumber(configDraft.startingStack, 100) !== null, [configDraft.startingStack]);

  async function ensureSession() {
    if (session) {
      return session;
    }

    const nickname = nicknameDraft.trim();
    if (!nickname) {
      throw new Error("请先输入昵称");
    }
    const created = await createGuestSession(nickname);
    setSession(created);
    setStatus(`欢迎，${created.nickname}。可以创建房间，也可以输入房号加入。`);
    return created;
  }

  async function connectToRoom(roomCode: string, activeSession: GuestSession, shouldResume = false) {
    setIsConnecting(true);
    setError(null);
    setStatus(`正在连接房间 ${roomCode}...`);

    try {
      const joinResponse = await joinRoom(roomCode, activeSession.sessionId, activeSession.resumeToken);
      const socket = io(resolveSocketOrigin(window.location.origin, import.meta.env.VITE_SOCKET_ORIGIN), {
        autoConnect: true,
        transports: ["websocket"],
      });

      socketRef.current?.disconnect();
      socketRef.current = socket;

      socket.on("room.snapshot", (nextSnapshot: RoomSnapshot) => {
        setSnapshot(nextSnapshot);
        setStatus(`已进入房间 ${nextSnapshot.roomCode}`);
      });

      socket.on("chat.message", (message: ChatMessage) => {
        setSnapshot((current) => mergeChatMessage(current, message));
      });

      socket.on("connect_error", (event) => {
        setError(event.message);
      });

      await emitWithAck(socket, "room.join", {
        roomCode,
        sessionId: activeSession.sessionId,
        token: joinResponse.wsToken,
      });

      if (shouldResume) {
        await emitWithAck(socket, "session.resume", {
          roomCode,
          sessionId: activeSession.sessionId,
          resumeToken: activeSession.resumeToken,
        });
      }

      setSnapshot(joinResponse.snapshot);
      setStatus(`已连接到 ${roomCode}`);
      localStorage.setItem(STORAGE_KEYS.roomCode, roomCode);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      setIsConnecting(false);
    }
  }

  async function handleSaveNickname() {
    if (!session) {
      return;
    }

    const nickname = nicknameDraft.trim();
    if (!nickname) {
      setError("请先输入昵称");
      return;
    }
    if (nickname === session.nickname) {
      return;
    }

    try {
      setError(null);
      setStatus("正在保存昵称...");
      const updated = await updateGuestSessionNickname(session.sessionId, nickname, session.resumeToken);
      setNicknameDraft(updated.nickname);
      setSession(updated);
      setStatus(`昵称已更新为 ${updated.nickname}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function handleCreateRoom() {
    try {
      const activeSession = await ensureSession();
      const resolvedConfig = parsedConfig;
      if (!resolvedConfig) {
        throw new Error("请先填写有效的房间配置");
      }
      const response = await createRoom(activeSession.sessionId, activeSession.resumeToken, {
        ...resolvedConfig,
      });
      await connectToRoom(response.roomCode, activeSession);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function handleJoinRoom() {
    try {
      const activeSession = await ensureSession();
      await getRoomSummary(roomCodeDraft.trim().toUpperCase());
      await connectToRoom(roomCodeDraft.trim().toUpperCase(), activeSession);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function handleSeatAction(event: string, payload?: unknown) {
    const socket = socketRef.current;
    if (!socket) {
      setError("Socket 尚未连接");
      return;
    }

    try {
      await emitWithAck(socket, event, payload ?? {});
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function handleExitRoom() {
    const activeSnapshot = snapshot;
    const socket = socketRef.current;

    setError(null);
    setChatDrawerOpen(false);

    if (socket && activeSnapshot?.yourSeatIndex !== null && activeSnapshot?.yourSeatIndex !== undefined && activeSnapshot.stage === "waiting") {
      try {
        await emitWithAck(socket, "seat.leave", {});
      } catch {
        // Best effort only. Leaving the room view should still work even if the seat cannot be released.
      }
    }

    socket?.disconnect();
    socketRef.current = null;
    localStorage.removeItem(STORAGE_KEYS.roomCode);
    setRoomCodeDraft("");
    setSnapshot(null);
    setStatus("已退出房间。");
  }

  function renderLobby() {
    const trimmedNickname = nicknameDraft.trim();
    const canSaveNickname = Boolean(session) && Boolean(trimmedNickname) && trimmedNickname !== session?.nickname;

    return (
      <main className="landing-shell">
        <section className="hero-card">
          <div className="hero-copy">
            <h1>德州扑克</h1>
            <p>
              先输入昵称，然后创建房间或输入房号加入。服务端负责发牌、比牌和筹码结算，前端只负责操作和展示。
            </p>
          </div>

          <div className="identity-card">
            <label>
              昵称
              <input
                id="nickname-input"
                type="text"
                placeholder="例如：扑克小杨"
                value={nicknameDraft}
                onChange={(event) => setNicknameDraft(event.target.value)}
              />
            </label>
            {session && <p className="muted-copy">当前身份：{session.nickname}</p>}
            {canSaveNickname && (
              <button
                type="button"
                className="secondary-btn"
                disabled={isConnecting}
                onClick={handleSaveNickname}
              >
                保存昵称
              </button>
            )}
          </div>
        </section>

        <section className="lobby-grid">
          <article className="lobby-card">
            <h2>创建房间</h2>
            <label>
              起始筹码
              <input
                type="number"
                min={100}
                step={100}
                value={configDraft.startingStack}
                onChange={(event) =>
                  setConfigDraft((current) => ({
                    ...current,
                    startingStack: event.target.value,
                  }))
                }
              />
            </label>
            <div className="blind-input-row">
              <label>
                小盲
                <input
                  type="number"
                  min={1}
                  value={configDraft.smallBlind}
                  onChange={(event) =>
                    setConfigDraft((current) => ({
                      ...current,
                      smallBlind: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                大盲
                <input
                  type="number"
                  min={Math.max(1, parseConfigNumber(configDraft.smallBlind, 1) ?? 1)}
                  value={configDraft.bigBlind}
                  onChange={(event) =>
                    setConfigDraft((current) => ({
                      ...current,
                      bigBlind: event.target.value,
                    }))
                  }
                />
              </label>
            </div>
            <label>
              行动时限
              <input
                type="number"
                min={5}
                value={configDraft.actionTimeSeconds}
                onChange={(event) =>
                  setConfigDraft((current) => ({
                    ...current,
                    actionTimeSeconds: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              补充筹码等待局数
              <input
                type="number"
                min={0}
                value={configDraft.rebuyCooldownHands}
                onChange={(event) =>
                  setConfigDraft((current) => ({
                    ...current,
                    rebuyCooldownHands: event.target.value,
                  }))
                }
              />
            </label>
            <button
              id="create-room-btn"
              type="button"
              className="primary-btn"
              disabled={isConnecting || !parsedConfig}
              onClick={handleCreateRoom}
            >
              创建房间
            </button>
            {!stackConfigured && <p className="error-copy">请先填写有效的起始筹码。</p>}
            {stackConfigured && !parsedConfig && <p className="error-copy">请检查盲注、行动时间和补充筹码局数设置。</p>}
          </article>

          <article className="lobby-card">
            <h2>加入房间</h2>
            <label>
              房号
              <input
                id="room-code-input"
                type="text"
                value={roomCodeDraft}
                onChange={(event) => setRoomCodeDraft(event.target.value.toUpperCase())}
                placeholder="例如：AB12CD"
              />
            </label>
            <button id="join-room-btn" type="button" className="secondary-btn" disabled={isConnecting} onClick={handleJoinRoom}>
              加入牌桌
            </button>
            <p className="muted-copy">断线后刷新页面会自动尝试重连到最近的房间。</p>
          </article>
        </section>
      </main>
    );
  }

  function renderTable() {
    if (!snapshot) {
      return null;
    }

    return (
      <main className="table-shell">
        <header className="top-bar">
          <div>
            <h1>{roomSummary}</h1>
          </div>
          <div className="top-actions">
            <button type="button" className="ghost-btn" onClick={handleExitRoom}>
              退出房间
            </button>
          </div>
        </header>

        <div className="table-layout">
          <div className="table-main">
            <ActionPanel
              snapshot={snapshot}
              onAction={(action) => handleSeatAction(action.type === "rebuy" ? "player.rebuy" : "action.submit", action.type === "rebuy" ? {} : action)}
              onToggleReady={(ready) => handleSeatAction(ready ? "player.ready" : "player.unready")}
              onStartHand={() => handleSeatAction("hand.start")}
              onLeaveSeat={() => handleSeatAction("seat.leave")}
            />

            <section className="table-stage">
              <CommunityBoard
                board={snapshot.board}
                yourHoleCards={snapshot.yourHoleCards}
                pots={snapshot.pots}
                seats={snapshot.seats}
                yourSeatIndex={snapshot.yourSeatIndex}
                stage={snapshot.stage}
                handNumber={snapshot.handNumber}
              />
            </section>

            <section className="seat-panel">
              <div className="seat-panel-header">
                <span>座位与最近操作</span>
                <span className="muted-copy">入座在下方，当前动作与最近操作会直接显示在座位卡片里。</span>
              </div>
              <SeatRing snapshot={snapshot} onTakeSeat={(seatIndex) => handleSeatAction("seat.take", { seatIndex })} currentTime={currentTime} />
            </section>
          </div>

          <button type="button" className={`chat-fab ${chatDrawerOpen ? "is-open" : ""}`} onClick={() => setChatDrawerOpen((value) => !value)}>
            {chatDrawerOpen ? "收起聊天" : "聊天"}
          </button>
          <aside className={`chat-floating ${chatDrawerOpen ? "is-open" : ""}`}>
            <ChatPanel
              messages={snapshot.messages}
              onSendChat={(content) => handleSeatAction("chat.send", { content })}
              canSend={snapshot.yourSeatIndex !== null && snapshot.yourSeatIndex !== undefined}
            />
          </aside>
        </div>
      </main>
    );
  }

  return (
    <div className="app-shell">
      {snapshot ? renderTable() : renderLobby()}
      <footer className="status-bar">
        <span>{status}</span>
        {error && <span className="error-copy">{error}</span>}
      </footer>
    </div>
  );
}

async function emitWithAck(socket: Socket, event: string, payload: unknown) {
  const response = await socket.emitWithAck(event, payload) as { ok: boolean; error?: string; snapshot?: RoomSnapshot };
  if (!response.ok) {
    throw new Error(response.error ?? `Event ${event} failed`);
  }
  return response.snapshot;
}

export function resolveSocketOrigin(browserOrigin: string, explicitOrigin?: string) {
  const url = new URL(browserOrigin);
  if (!isLocalBrowserHost(url.hostname)) {
    return url.origin;
  }

  if (explicitOrigin) {
    return explicitOrigin;
  }

  url.port = "3001";
  return url.origin;
}

function mergeChatMessage(snapshot: RoomSnapshot | null, message: ChatMessage) {
  if (!snapshot) {
    return snapshot;
  }

  if (snapshot.messages.some((current) => current.id === message.id)) {
    return snapshot;
  }

  return {
    ...snapshot,
    messages: [...snapshot.messages.slice(-49), message],
  };
}

declare global {
  interface Window {
    render_game_to_text: () => string;
    __POKER_DEBUG__: {
      advance: (milliseconds: number) => void;
    };
  }
}

function isLocalBrowserHost(hostname: string) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

export function roomConfigToDraft(config: RoomConfig): RoomConfigDraft {
  return {
    startingStack: String(config.startingStack),
    smallBlind: String(config.smallBlind),
    bigBlind: String(config.bigBlind),
    actionTimeSeconds: String(config.actionTimeSeconds),
    rebuyCooldownHands: String(config.rebuyCooldownHands),
  };
}

export function parseRoomConfigDraft(draft: RoomConfigDraft): RoomConfig | null {
  const startingStack = parseConfigNumber(draft.startingStack, 100);
  const smallBlind = parseConfigNumber(draft.smallBlind, 1);
  const bigBlind = parseConfigNumber(draft.bigBlind, 1);
  const actionTimeSeconds = parseConfigNumber(draft.actionTimeSeconds, 5);
  const rebuyCooldownHands = parseConfigNumber(draft.rebuyCooldownHands, 0);

  if (
    startingStack === null ||
    smallBlind === null ||
    bigBlind === null ||
    actionTimeSeconds === null ||
    rebuyCooldownHands === null
  ) {
    return null;
  }

  if (bigBlind < smallBlind) {
    return null;
  }

  return {
    maxPlayers: MAX_TABLE_PLAYERS,
    startingStack,
    smallBlind,
    bigBlind,
    actionTimeSeconds,
    rebuyCooldownHands,
  };
}

function parseConfigNumber(value: string, min: number) {
  if (!value.trim()) {
    return null;
  }

  if (!/^\d+$/.test(value.trim())) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    return null;
  }

  return parsed;
}
