import { useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import {
  ACTION_TIME_PRESETS,
  BLIND_PRESETS,
  STARTING_STACK_PRESETS,
  type GuestSession,
  type RoomConfig,
  type RoomSnapshot,
} from "@texas-poker/shared";
import { createGuestSession, createRoom, getRoomSummary, joinRoom, reportClientError } from "./lib/api";
import { ActionPanel } from "./components/ActionPanel";
import { ChatPanel } from "./components/ChatPanel";
import { CommunityBoard } from "./components/CommunityBoard";
import { SeatRing } from "./components/SeatRing";

const STORAGE_KEYS = {
  session: "texas-poker.session",
  roomCode: "texas-poker.roomCode",
};

const DEFAULT_CONFIG: RoomConfig = {
  maxPlayers: 6,
  startingStack: STARTING_STACK_PRESETS[1],
  smallBlind: BLIND_PRESETS[0].smallBlind,
  bigBlind: BLIND_PRESETS[0].bigBlind,
  actionTimeSeconds: ACTION_TIME_PRESETS[0],
};

export default function App() {
  const [session, setSession] = useState<GuestSession | null>(() => {
    const raw = localStorage.getItem(STORAGE_KEYS.session);
    return raw ? (JSON.parse(raw) as GuestSession) : null;
  });
  const [nicknameDraft, setNicknameDraft] = useState("");
  const [roomCodeDraft, setRoomCodeDraft] = useState(() => localStorage.getItem(STORAGE_KEYS.roomCode) ?? "");
  const [config, setConfig] = useState<RoomConfig>(DEFAULT_CONFIG);
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [status, setStatus] = useState("输入昵称，创建一个好友房。");
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
      void reportClientError({
        sessionId: session?.sessionId,
        roomCode: snapshot?.roomCode,
        message: event.message,
        stack: event.error instanceof Error ? event.error.stack : undefined,
      }).catch(() => undefined);
    };

    window.addEventListener("error", handleError);
    return () => window.removeEventListener("error", handleError);
  }, [session?.sessionId, snapshot?.roomCode]);

  const roomSummary = useMemo(() => {
    if (!snapshot) {
      return null;
    }
    return `房号 ${snapshot.roomCode} · ${snapshot.config.smallBlind}/${snapshot.config.bigBlind} · ${snapshot.config.maxPlayers}人桌`;
  }, [snapshot]);

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
      const joinResponse = await joinRoom(roomCode, activeSession.sessionId);
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

      socket.on("chat.message", () => {
        setTick((value) => value + 1);
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

  async function handleCreateRoom() {
    try {
      const activeSession = await ensureSession();
      const response = await createRoom(activeSession.sessionId, config);
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

  function renderLobby() {
    return (
      <main className="landing-shell">
        <section className="hero-card">
          <div className="hero-copy">
            <span className="eyebrow">Texas Hold'em MVP</span>
            <h1>好友房德州扑克</h1>
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
                value={session?.nickname ?? nicknameDraft}
                disabled={Boolean(session)}
                onChange={(event) => setNicknameDraft(event.target.value)}
              />
            </label>
            {session && <p className="muted-copy">当前身份：{session.nickname}</p>}
          </div>
        </section>

        <section className="lobby-grid">
          <article className="lobby-card">
            <h2>创建好友房</h2>
            <label>
              人数上限
              <select value={config.maxPlayers} onChange={(event) => setConfig((current) => ({ ...current, maxPlayers: Number(event.target.value) }))}>
                {Array.from({ length: 8 }, (_, index) => index + 2).map((value) => (
                  <option key={value} value={value}>
                    {value} 人桌
                  </option>
                ))}
              </select>
            </label>
            <label>
              起始筹码
              <select
                value={config.startingStack}
                onChange={(event) => setConfig((current) => ({ ...current, startingStack: Number(event.target.value) }))}
              >
                {STARTING_STACK_PRESETS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label>
              盲注
              <select
                value={`${config.smallBlind}/${config.bigBlind}`}
                onChange={(event) => {
                  const [smallBlindValue, bigBlindValue] = event.target.value.split("/");
                  const smallBlind = Number(smallBlindValue);
                  const bigBlind = Number(bigBlindValue);
                  setConfig((current) => ({ ...current, smallBlind, bigBlind }));
                }}
              >
                {BLIND_PRESETS.map((preset) => (
                  <option key={`${preset.smallBlind}/${preset.bigBlind}`} value={`${preset.smallBlind}/${preset.bigBlind}`}>
                    {preset.smallBlind}/{preset.bigBlind}
                  </option>
                ))}
              </select>
            </label>
            <label>
              行动时限
              <select
                value={config.actionTimeSeconds}
                onChange={(event) => setConfig((current) => ({ ...current, actionTimeSeconds: Number(event.target.value) }))}
              >
                {ACTION_TIME_PRESETS.map((value) => (
                  <option key={value} value={value}>
                    {value} 秒
                  </option>
                ))}
              </select>
            </label>
            <button id="create-room-btn" type="button" className="primary-btn" disabled={isConnecting} onClick={handleCreateRoom}>
              创建房间
            </button>
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
            <span className="eyebrow">好友房</span>
            <h1>{roomSummary}</h1>
          </div>
          <div className="top-actions">
            <button type="button" className="ghost-btn" onClick={() => setChatDrawerOpen((value) => !value)}>
              {chatDrawerOpen ? "收起聊天" : "打开聊天"}
            </button>
          </div>
        </header>

        <div className="table-layout">
          <aside className="side-stack">
            <ActionPanel
              snapshot={snapshot}
              onAction={(action) => handleSeatAction("action.submit", action)}
              onToggleReady={(ready) => handleSeatAction(ready ? "player.ready" : "player.unready")}
              onStartHand={() => handleSeatAction("hand.start")}
              onLeaveSeat={() => handleSeatAction("seat.leave")}
            />
          </aside>

          <section className="table-stage">
            <CommunityBoard board={snapshot.board} pots={snapshot.pots} stage={snapshot.stage} handNumber={snapshot.handNumber} />
            <SeatRing snapshot={snapshot} onTakeSeat={(seatIndex) => handleSeatAction("seat.take", { seatIndex })} currentTime={currentTime} />
            <div className="hero-status">
              <span>{status}</span>
              {snapshot.yourHoleCards && snapshot.yourHoleCards.length > 0 && (
                <span>你的底牌：{snapshot.yourHoleCards.map(cardToText).join(" · ")}</span>
              )}
            </div>
          </section>

          <aside className={`chat-stack ${chatDrawerOpen ? "is-open" : ""}`}>
            <ChatPanel
              messages={snapshot.messages}
              onSendChat={(content) => handleSeatAction("chat.send", { content })}
              onSendEmoji={(content) => handleSeatAction("emoji.send", { content })}
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
  if (explicitOrigin) {
    return explicitOrigin;
  }

  const url = new URL(browserOrigin);
  url.port = "3001";
  return url.origin;
}

function cardToText(card: { rank: number; suit: string }) {
  const rank = card.rank <= 10 ? String(card.rank) : ({ 11: "J", 12: "Q", 13: "K", 14: "A" }[card.rank] ?? "?");
  const suit = {
    clubs: "♣",
    diamonds: "♦",
    hearts: "♥",
    spades: "♠",
  }[card.suit as "clubs" | "diamonds" | "hearts" | "spades"];
  return `${rank}${suit}`;
}

declare global {
  interface Window {
    render_game_to_text: () => string;
    __POKER_DEBUG__: {
      advance: (milliseconds: number) => void;
    };
  }
}
