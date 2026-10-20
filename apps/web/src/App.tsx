import { useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import {
  type ChatMessage,
  MAX_TABLE_PLAYERS,
  type RoomConfig,
  type RoomSummary,
  type RoomSnapshot,
} from "@texas-poker/shared";
import { createRoom, getActiveRoom, joinRoom, leaveRoom, reportClientError } from "./lib/api";
import { ActionPanel } from "./components/ActionPanel";
import { ChatPanel } from "./components/ChatPanel";
import { CommunityBoard } from "./components/CommunityBoard";
import { SeatRing } from "./components/SeatRing";

const STORAGE_KEYS = {
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
  const [nicknameDraft, setNicknameDraft] = useState("");
  const [roomCodeDraft, setRoomCodeDraft] = useState(() => localStorage.getItem(STORAGE_KEYS.roomCode) ?? "");
  const [configDraft, setConfigDraft] = useState<RoomConfigDraft>(() => roomConfigToDraft(DEFAULT_CONFIG));
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [status, setStatus] = useState("输入昵称，创建房间。");
  const [error, setError] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isRoomReady, setIsRoomReady] = useState(false);
  const roomReadyRef = useRef(false);
  const retryButtonRef = useRef<HTMLButtonElement | null>(null);
  const [chatDrawerOpen, setChatDrawerOpen] = useState(false);
  const [unreadChatCount, setUnreadChatCount] = useState(0);
  const [clockOffset, setClockOffset] = useState(0);
  const [tick, setTick] = useState(0);
  const socketRef = useRef<Socket | null>(null);
  const chatDrawerOpenRef = useRef(chatDrawerOpen);
  const roomRef = useRef<RoomSnapshot | null>(null);
  const epoch = useRef(0);
  const exitingRef = useRef(false);
  const entryRef = useRef<number | null>(null);
  const [isExiting, setIsExiting] = useState(false);

  function clearRoom(message: string) {
    epoch.current += 1;
    const socket = socketRef.current;
    socketRef.current = null;
    socket?.disconnect();
    roomRef.current = null;
    exitingRef.current = false;
    entryRef.current = null;
    setIsExiting(false);
    setIsConnecting(false);
    roomReadyRef.current = false;
    setIsRoomReady(false);
    setChatDrawerOpen(false);
    setUnreadChatCount(0);
    localStorage.removeItem(STORAGE_KEYS.roomCode);
    setRoomCodeDraft("");
    setSnapshot(null);
    setError(null);
    setStatus(message);
  }

  useEffect(() => {
    const interval = window.setInterval(() => setTick((value) => value + 1), 500);
    return () => window.clearInterval(interval);
  }, []);

  const currentTime = Date.now() + clockOffset + tick * 0;

  useEffect(() => {
    chatDrawerOpenRef.current = chatDrawerOpen;
    if (chatDrawerOpen) {
      setUnreadChatCount(0);
    }
  }, [chatDrawerOpen]);

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
    window.advanceTime = (milliseconds: number) => setClockOffset((value) => value + milliseconds);
  }, [snapshot]);

  useEffect(() => {
    let alive = true;
    const generation = epoch.current;
    void getActiveRoom().then((active) => {
      if (!alive || generation !== epoch.current || "activeRoom" in active) return;
      return connectToRoom(active);
    }).catch(() => {
      if (alive && generation === epoch.current) {
        setError("无法恢复房间，请点击恢复房间重试。");
        setStatus("恢复未完成。");
      }
    });
    return () => {
      alive = false;
      epoch.current += 1;
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.disconnect();
    };
  }, []);

  useEffect(() => {
    if (snapshot && !isRoomReady) retryButtonRef.current?.focus();
  }, [isRoomReady, snapshot !== null]);

  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      void reportClientError({
        roomCode: snapshot?.roomCode,
        message: event.message,
        stack: event.error instanceof Error ? event.error.stack : undefined,
      }).catch(() => undefined);
    };

    window.addEventListener("error", handleError);
    return () => window.removeEventListener("error", handleError);
  }, [snapshot?.roomCode]);

  const roomSummary = useMemo(() => {
    if (!snapshot) {
      return null;
    }
    return `房号 ${snapshot.roomCode} · ${snapshot.config.smallBlind}/${snapshot.config.bigBlind}`;
  }, [snapshot]);
  const parsedConfig = useMemo(() => parseRoomConfigDraft(configDraft), [configDraft]);
  const stackConfigured = useMemo(() => parseConfigNumber(configDraft.startingStack, 100) !== null, [configDraft.startingStack]);

  function requireNickname() {
    const nickname = nicknameDraft.trim();
    if (!nickname) throw new Error("请先输入昵称");
    return nickname;
  }

  async function connectToRoom(room: RoomSummary) {
    const generation = ++epoch.current;
    let current = () => false;
    setIsConnecting(true);
    roomReadyRef.current = false;
    setIsRoomReady(false);
    setError(null);
    setStatus(`正在连接房间 ${room.roomCode}...`);

    try {
      const socket = io(resolveSocketOrigin(window.location.origin, import.meta.env.VITE_SOCKET_ORIGIN), {
        autoConnect: false,
        transports: ["websocket"],
        withCredentials: true,
      });

      socketRef.current?.disconnect();
      socketRef.current = socket;
      current = () => socketRef.current === socket;
      let attachAttempt = 0;

      socket.on("state.snapshot", (nextSnapshot: RoomSnapshot) => {
        if (!current() || nextSnapshot.roomId !== room.roomId) return;
        roomRef.current = nextSnapshot;
        roomReadyRef.current = true;
        setIsRoomReady(true);
        setIsConnecting(false);
        localStorage.setItem(STORAGE_KEYS.roomCode, nextSnapshot.roomCode);
        setRoomCodeDraft(nextSnapshot.roomCode);
        setSnapshot(nextSnapshot);
        if (!exitingRef.current) setStatus(`已进入房间 ${nextSnapshot.roomCode}`);
      });
      socket.on("room.expired", (message: { roomId: string; reason?: string }) => {
        if (!current() || message?.roomId !== room.roomId) return;
        if (message.reason === "left") clearRoom("已退出房间。");
        else if (message.reason === undefined) clearRoom("房间已过期，请重新创建或加入。");
      });
      socket.on("disconnect", () => {
        attachAttempt += 1;
        if (current()) {
          roomReadyRef.current = false;
          setIsRoomReady(false);
          if (!exitingRef.current) setStatus("连接已中断，正在尝试重连；也可手动重新连接。");
        }
      });

      socket.on("chat.message", (message: ChatMessage) => {
        if (!current()) return;
        setSnapshot((current) => mergeChatMessage(current, message));
        if (!chatDrawerOpenRef.current && message.senderSessionId !== roomRef.current?.participantId) {
          setUnreadChatCount((current) => Math.min(current + 1, 99));
        }
      });

      const attachRoom = async () => {
        if (!current()) return;
        const attempt = ++attachAttempt;
        const attachEpoch = epoch.current;
        const valid = () => current() && attempt === attachAttempt && attachEpoch === epoch.current;
        try {
          await emitWithAck(socket, "room.attach", { roomId: room.roomId });
        } catch (cause) {
          if (!valid()) return;
          try {
            const active = await getActiveRoom();
            if (!valid()) return;
            if ("activeRoom" in active && active.activeRoom === null) {
              clearRoom("已退出或房间已失效，请重新创建或加入。");
              return;
            }
            if ("roomId" in active && typeof active.roomId === "string" && active.roomId !== room.roomId) {
              await connectToRoom(active);
              return;
            }
          } catch { /* An unconfirmed attach failure keeps the current room. */ }
          if (!valid()) return;
          throw cause;
        }
        if (!valid()) return;
        setError(null);
        localStorage.setItem(STORAGE_KEYS.roomCode, room.roomCode);
      };
      await new Promise<void>((resolve, reject) => {
        socket.on("connect_error", (event) => {
          if (!current() || exitingRef.current) return;
          setIsConnecting(false);
          setError(event.message);
          reject(event);
        });
        socket.on("connect", () => {
          void attachRoom().then(resolve, (cause) => {
            if (current() && !exitingRef.current) setError(cause instanceof Error ? cause.message : String(cause));
            reject(cause);
          });
        });
        socket.connect();
      });
    } catch (cause) {
      if (current() && !exitingRef.current) setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      if (generation === epoch.current && current()) setIsConnecting(false);
    }
  }

  async function handleReconnect() {
    if (exitingRef.current || entryRef.current !== null) return;
    const generation = ++epoch.current;
    entryRef.current = generation;
    const previousSocket = socketRef.current;
    socketRef.current = null;
    previousSocket?.disconnect();
    roomReadyRef.current = false;
    setIsRoomReady(false);
    setIsConnecting(true);
    setError(null);
    setStatus("正在恢复房间…");
    try {
      const active = await getActiveRoom();
      if (generation !== epoch.current) return;
      if ("activeRoom" in active) clearRoom("当前没有可恢复的房间，请重新创建或加入。");
      else await connectToRoom(active);
    } catch (cause) {
      if (entryRef.current === generation) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setStatus("恢复未完成，请重试。");
      }
    } finally {
      if (entryRef.current === generation) { entryRef.current = null; setIsConnecting(false); }
    }
  }

  async function handleCreateRoom() {
    if (exitingRef.current || entryRef.current !== null) return;
    const generation = ++epoch.current;
    entryRef.current = generation;
    setIsConnecting(true);
    try {
      const nickname = requireNickname();
      const resolvedConfig = parsedConfig;
      if (!resolvedConfig) {
        throw new Error("请先填写有效的房间配置");
      }
      const response = await createRoom(nickname, {
        ...resolvedConfig,
      });
      if (generation === epoch.current) await connectToRoom(response);
    } catch (cause) {
      if (entryRef.current === generation) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (entryRef.current === generation) { entryRef.current = null; setIsConnecting(false); }
    }
  }

  async function handleJoinRoom() {
    if (exitingRef.current || entryRef.current !== null) return;
    const generation = ++epoch.current;
    entryRef.current = generation;
    setIsConnecting(true);
    try {
      const response = await joinRoom(roomCodeDraft.trim().toUpperCase(), requireNickname());
      if (generation === epoch.current) await connectToRoom(response);
    } catch (cause) {
      if (entryRef.current === generation) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (entryRef.current === generation) { entryRef.current = null; setIsConnecting(false); }
    }
  }

  async function handleSeatAction(event: string, payload?: unknown) {
    if (exitingRef.current) return;
    const generation = epoch.current;
    const socket = socketRef.current;
    if (!socket || !socket.connected || !roomReadyRef.current) {
      setError("房间连接尚未恢复，请先重新连接。");
      return;
    }

    try {
      if (!snapshot) throw new Error("房间状态尚未就绪");
      await emitWithAck(socket, "command", {
        protocolVersion: 1,
        requestId: crypto.randomUUID(),
        roomId: snapshot.roomId,
        expectedRevision: snapshot.revision,
        type: event,
        payload: payload ?? {},
      });
      if (socketRef.current === socket && generation === epoch.current) setError(null);
    } catch (cause) {
      if (socketRef.current === socket && generation === epoch.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function handleExitRoom() {
    const room = roomRef.current;
    if (!room || exitingRef.current) return;
    if (room.yourSeatIndex !== null && room.yourSeatIndex !== undefined && !["waiting", "showdown"].includes(room.stage)
      && !window.confirm("本手会继续；退出后不能返回原座。未完成的行动按原时限自动过牌或弃牌，已全押筹码仍参与本手结算。确定退出房间？")) return;
    exitingRef.current = true;
    setIsExiting(true);
    setError(null);
    setStatus("正在确认退出，请稍候…");
    const generation = ++epoch.current;
    try {
      await leaveRoom(room.roomId);
      if (generation === epoch.current) clearRoom("已退出房间。");
    } catch (cause) {
      if (generation !== epoch.current) return;
      // An anonymous active-room response cannot confirm a 401 leave.
      const unauthorized = cause instanceof Error && "status" in cause && cause.status === 401;
      if (!unauthorized) try {
        const active = await getActiveRoom();
        if (generation === epoch.current && (("activeRoom" in active && active.activeRoom === null)
          || ("roomId" in active && typeof active.roomId === "string" && active.roomId !== room.roomId))) {
          clearRoom("已退出房间。");
          return;
        }
      } catch { /* Keep the current room if confirmation is unavailable. */ }
      if (generation === epoch.current) {
        const network = cause instanceof TypeError || (cause instanceof Error && ["AbortError", "TimeoutError"].includes(cause.name));
        setError(unauthorized ? "会话已失效，无法确认退出；请刷新后重新创建或加入。" : network ? "网络连接失败或请求超时，请重试。" : cause instanceof Error ? cause.message : "退出房间失败，请重试。");
        setStatus("退出未确认，请重试。");
      }
    } finally {
      if (generation === epoch.current) { exitingRef.current = false; setIsExiting(false); setIsConnecting(false); }
    }
  }

  function handleToggleChatDrawer() {
    setChatDrawerOpen((value) => {
      const nextValue = !value;
      if (nextValue) {
        setUnreadChatCount(0);
      }
      return nextValue;
    });
  }

  function renderLobby() {
    const trimmedNickname = nicknameDraft.trim();
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
            {trimmedNickname && <p className="muted-copy">昵称只用于当前房间。</p>}
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
            <button type="button" className="ghost-btn" disabled={isConnecting} onClick={handleReconnect}>
              {isConnecting ? "正在恢复…" : "恢复房间"}
            </button>
          </article>
        </section>
      </main>
    );
  }

  function renderTable() {
    if (!snapshot) {
      return null;
    }

    const occupiedSeatCount = snapshot.seats.filter((seat) => seat.occupied).length;

    return (
      <main className="table-shell premium-table-shell">
        <header className="top-bar table-topbar">
          <div className="table-brand-block">
            <span className="table-brand-mark">Texas Hold&apos;em</span>
            <h1>{roomSummary}</h1>
          </div>
          <div className="table-meta-strip" aria-label="牌桌信息">
            <span className="table-live-pill">LIVE</span>
            <span className="table-meta-chip">第 {snapshot.handNumber || 0} 手</span>
            <span className="table-meta-chip">
              {occupiedSeatCount} / {snapshot.config.maxPlayers} 玩家
            </span>
            <span className="table-meta-chip">{stageToTableLabel(snapshot.stage)}</span>
          </div>
          <div className="top-actions">
            {!isRoomReady && <button ref={retryButtonRef} type="button" className="secondary-btn" disabled={isExiting || isConnecting} aria-busy={isConnecting} onClick={handleReconnect}>
              {isConnecting ? "正在恢复…" : "重新连接"}
            </button>}
            <button type="button" className="ghost-btn" disabled={isExiting} aria-busy={isExiting} onClick={handleExitRoom}>
              {isExiting ? "正在退出…" : "退出房间"}
            </button>
          </div>
        </header>

        <fieldset className="table-layout room-controls" disabled={isExiting || !isRoomReady} aria-label="牌桌操作">
          <div className="table-main">
            <section className="table-arena">
              <section className="table-stage">
                <div className="table-stage-shell">
                  <div className="table-felt">
                    <div className="felt-logo" aria-hidden="true">
                      <span>TEXAS</span>
                      <span>HOLD&apos;EM</span>
                    </div>
                    <CommunityBoard
                      board={snapshot.board}
                      yourHoleCards={snapshot.yourHoleCards}
                      pots={snapshot.pots}
                      seats={snapshot.seats}
                      yourSeatIndex={snapshot.yourSeatIndex}
                      stage={snapshot.stage}
                      handNumber={snapshot.handNumber}
                    />
                  </div>
                  <SeatRing snapshot={snapshot} onTakeSeat={(seatIndex) => handleSeatAction("seat.take", { seatIndex })} currentTime={currentTime} />
                </div>
              </section>
            </section>

            <ActionPanel
              snapshot={snapshot}
              onAction={(action) => handleSeatAction(action.type === "rebuy" ? "player.rebuy" : "action.submit", action.type === "rebuy" ? {} : action)}
              onToggleReady={(ready) => handleSeatAction(ready ? "player.ready" : "player.unready")}
              onStartHand={() => handleSeatAction("hand.start")}
              onLeaveSeat={() => handleSeatAction("seat.leave")}
            />
          </div>

          <button type="button" className={`chat-fab ${chatDrawerOpen ? "is-open" : ""}`} onClick={handleToggleChatDrawer}>
            <span>{chatDrawerOpen ? "收起聊天" : "聊天"}</span>
            {!chatDrawerOpen && unreadChatCount > 0 && (
              <span className="chat-fab-badge" aria-label={`未读消息 ${formatUnreadChatCount(unreadChatCount)} 条`}>
                {formatUnreadChatCount(unreadChatCount)}
              </span>
            )}
          </button>
          <aside className={`chat-floating ${chatDrawerOpen ? "is-open" : ""}`}>
            <ChatPanel
              messages={snapshot.messages}
              onSendChat={(content) => handleSeatAction("chat.send", { content })}
              canSend={snapshot.yourSeatIndex !== null && snapshot.yourSeatIndex !== undefined}
            />
          </aside>
        </fieldset>
      </main>
    );
  }

  return (
    <div className="app-shell">
      {snapshot ? renderTable() : renderLobby()}
      <footer className="status-bar">
        <span>{status}</span>
        {error && <span className="error-copy" role="alert">{error}</span>}
      </footer>
    </div>
  );
}

type SocketAck = { ok: boolean; error?: string | { message?: string; code?: string }; snapshot?: RoomSnapshot };

function unwrapSocketAck(event: string, response: SocketAck) {
  if (!response.ok) {
    throw new Error(typeof response.error === "string" ? response.error : response.error?.message ?? response.error?.code ?? `Event ${event} failed`);
  }
  return response.snapshot;
}

async function emitWithAck(socket: Socket, event: string, payload: unknown) {
  return unwrapSocketAck(event, await socket.timeout(8000).emitWithAck(event, payload) as SocketAck);
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

function formatUnreadChatCount(count: number) {
  return count > 99 ? "99+" : String(count);
}

function stageToTableLabel(stage: string) {
  return {
    waiting: "等待开局",
    preflop: "翻牌前",
    flop: "翻牌",
    turn: "转牌",
    river: "河牌",
    showdown: "摊牌",
  }[stage] ?? stage;
}

declare global {
  interface Window {
    render_game_to_text: () => string;
    __POKER_DEBUG__: {
      advance: (milliseconds: number) => void;
    };
    advanceTime: (milliseconds: number) => void;
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
