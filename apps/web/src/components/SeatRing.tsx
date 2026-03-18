import type { RoomSnapshot, SeatState } from "@texas-poker/shared";

export function SeatRing(props: {
  snapshot: RoomSnapshot;
  onTakeSeat: (seatIndex: number) => void;
  currentTime: number;
}) {
  const visibleSeats = shouldHideEmptySeats(props.snapshot)
    ? props.snapshot.seats.filter((seat) => seat.occupied)
    : props.snapshot.seats;

  return (
    <div className="seat-ring" aria-label="牌桌座位">
      {visibleSeats.map((seat) => (
        <SeatNode
          key={seat.seatIndex}
          seat={seat}
          room={props.snapshot}
          onTakeSeat={props.onTakeSeat}
          currentTime={props.currentTime}
        />
      ))}
    </div>
  );
}

function SeatNode(props: {
  seat: SeatState;
  room: RoomSnapshot;
  onTakeSeat: (seatIndex: number) => void;
  currentTime: number;
}) {
  const player = props.seat.player;
  const isSelf = props.room.yourSeatIndex === props.seat.seatIndex;
  const isActing = props.room.actingSeatIndex === props.seat.seatIndex;
  const countdown = props.room.actionDeadlineAt
    ? Math.max(0, Math.ceil((new Date(props.room.actionDeadlineAt).getTime() - props.currentTime) / 1000))
    : null;

  return (
    <button
      type="button"
      className={`seat-node ${isSelf ? "is-self" : ""} ${isActing ? "is-acting" : ""}`}
      disabled={props.seat.occupied}
      onClick={() => props.onTakeSeat(props.seat.seatIndex)}
    >
      <span className="seat-header-row">
        <span className="seat-index">{props.seat.seatIndex + 1}号位</span>
        {player?.lastAction && <span className={`seat-action-pill is-${player.lastAction.tone}`}>{player.lastAction.label}</span>}
      </span>
      {player ? (
        <>
          <span className="seat-name">
            {player.nickname}
            {player.isHost ? " · 房主" : ""}
          </span>
          <span className="seat-stack">筹码 {player.stack}</span>
          <span className="seat-meta">
            {labelForPlayer(player.status, player.ready, player.presence)}
            {isActing && countdown !== null ? ` · ${countdown}s` : ""}
          </span>
          <span className="seat-bet">{player.currentBet > 0 ? `当前下注 ${player.currentBet}` : "待命"}</span>
        </>
      ) : (
        <>
          <span className="seat-name">点击入座</span>
          <span className="seat-stack">空位</span>
        </>
      )}
    </button>
  );
}

function labelForPlayer(status: string, ready: boolean, presence: string) {
  if (presence === "disconnected") {
    return "离线";
  }
  if (!ready && status === "waiting") {
    return "未准备";
  }
  return {
    waiting: "待开始",
    active: "行动中",
    folded: "已弃牌",
    "all-in": "已全下",
    out: "出局",
    "sit-out": "暂离",
  }[status] ?? status;
}

function shouldHideEmptySeats(snapshot: RoomSnapshot) {
  return snapshot.handNumber > 0 || snapshot.stage !== "waiting";
}
