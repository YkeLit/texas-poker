import type { CSSProperties } from "react";
import type { RoomSnapshot, SeatState } from "@texas-poker/shared";
import { PlayingCard } from "./PlayingCard";

export function SeatRing(props: {
  snapshot: RoomSnapshot;
  onTakeSeat: (seatIndex: number) => void;
  currentTime: number;
}) {
  const visibleSeats = shouldHideEmptySeats(props.snapshot)
    ? props.snapshot.seats.filter((seat) => seat.occupied)
    : props.snapshot.seats;

  return (
    <div className={`seat-ring ${props.snapshot.yourSeatIndex !== null && props.snapshot.yourSeatIndex !== undefined ? "has-self" : ""}`.trim()} aria-label="牌桌座位">
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
  const roleBadges = getSeatRoleBadges(props.room, props.seat.seatIndex);
  const positionLabel = getSeatPositionLabel(props.room, props.seat.seatIndex);
  const countdown = props.room.actionDeadlineAt
    ? Math.max(0, Math.ceil((new Date(props.room.actionDeadlineAt).getTime() - props.currentTime) / 1000))
    : null;
  const seatPositionStyle = getSeatPositionStyle(props.room, props.seat.seatIndex);
  const seatCards = resolveSeatCards(props.room, props.seat.seatIndex, isSelf);
  const nicknameClass = player ? nicknameLengthClass(player.nickname) : "";
  const visibleLastAction = player?.lastAction && shouldDisplaySeatAction(player.lastAction.label) ? player.lastAction : null;

  return (
    <button
      type="button"
      className={`seat-node ${isSelf ? "is-self" : ""} ${isActing ? "is-acting" : ""} ${player ? "is-occupied" : "is-empty"}`.trim()}
      disabled={props.seat.occupied}
      onClick={() => props.onTakeSeat(props.seat.seatIndex)}
      style={seatPositionStyle}
    >
      {(player?.currentBet ?? 0) > 0 || (isActing && countdown !== null) ? (
        <span className="seat-chip-row">
          {player && player.currentBet > 0 && <span className="seat-chip">{player.currentBet}</span>}
          {isActing && countdown !== null && <span className="seat-countdown">{countdown}s</span>}
        </span>
      ) : null}
      {player ? (
        <>
          <span className="seat-top-row">
            <span className="seat-index">{positionLabel}</span>
            <span className="seat-top-markers">
              {player.isHost && <HostIcon />}
              <span
                className={`seat-status-dot ${statusIndicatorClass(player.status, player.ready, player.presence)}`}
                title={labelForPlayer(player.status, player.ready, player.presence, player.rebuyRemainingHands)}
                aria-label={labelForPlayer(player.status, player.ready, player.presence, player.rebuyRemainingHands)}
              />
            </span>
          </span>
          <span className="seat-header-row">
            <span className={`seat-name ${nicknameClass}`.trim()}>{player.nickname}</span>
            {visibleLastAction && <span className={`seat-action-pill is-${visibleLastAction.tone}`}>{visibleLastAction.label}</span>}
          </span>
          <span className="seat-stack">筹码 {player.stack}</span>
          {seatCards.length > 0 && (
            <span className="seat-card-row" aria-label={`${player.nickname} 底牌`}>
              {seatCards.map((seatCard, index) =>
                seatCard.type === "face-up" ? (
                  <PlayingCard
                    key={`${props.seat.seatIndex}-${seatCard.card.rank}-${seatCard.card.suit}-${index}`}
                    card={seatCard.card}
                    compact
                  />
                ) : (
                  <PlayingCard key={`${props.seat.seatIndex}-facedown-${index}`} compact faceDown />
                ),
              )}
            </span>
          )}
        </>
      ) : (
        <>
          <span className="seat-top-row">
            <span className="seat-index">{props.seat.seatIndex + 1}号位</span>
          </span>
          <span className="seat-name">+ 入座</span>
          <span className="seat-stack">空位</span>
        </>
      )}
    </button>
  );
}

function labelForPlayer(status: string, ready: boolean, presence: string, rebuyRemainingHands: number) {
  if (presence === "disconnected") {
    return "离线";
  }
  if (status === "out") {
    return rebuyRemainingHands > 0 ? `待补充 ${rebuyRemainingHands}局` : "可补充筹码";
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
  const viewerSeated = snapshot.yourSeatIndex !== null && snapshot.yourSeatIndex !== undefined;
  const handActive = snapshot.stage !== "waiting" && snapshot.stage !== "showdown";

  if (handActive) {
    return true;
  }

  return viewerSeated;
}

function getSeatRoleBadges(room: RoomSnapshot, seatIndex: number) {
  const badges: string[] = [];
  if (room.dealerSeatIndex === seatIndex) {
    badges.push("庄");
  }
  if (room.smallBlindSeatIndex === seatIndex) {
    badges.push("小盲");
  }
  if (room.bigBlindSeatIndex === seatIndex) {
    badges.push("大盲");
  }
  return badges;
}

function getSeatPositionLabel(room: RoomSnapshot, seatIndex: number) {
  if (room.dealerSeatIndex === null) {
    return `${seatIndex + 1}号位`;
  }
  const labels: string[] = [];
  if (room.dealerSeatIndex === seatIndex) labels.push("庄");
  if (room.smallBlindSeatIndex === seatIndex) labels.push("小盲");
  if (room.bigBlindSeatIndex === seatIndex) labels.push("大盲");
  return labels.length > 0 ? labels.join("/") : `${seatIndex + 1}号位`;
}

function resolveSeatCards(room: RoomSnapshot, seatIndex: number, isSelf: boolean) {
  const player = room.seats[seatIndex]?.player;
  if (!player) {
    return [];
  }

  if (isSelf) {
    const visibleCards = room.yourHoleCards ?? [];
    return visibleCards.map((card) => ({ type: "face-up" as const, card }));
  }

  if (room.stage === "showdown" && player.revealedCards?.length) {
    return player.revealedCards.map((card) => ({ type: "face-up" as const, card }));
  }

  if (player.holeCardCount > 0) {
    return Array.from({ length: Math.min(2, player.holeCardCount) }, () => ({ type: "face-down" as const }));
  }

  return [];
}

function nicknameLengthClass(nickname: string) {
  if (nickname.length >= 16) {
    return "is-xlong";
  }
  if (nickname.length >= 11) {
    return "is-long";
  }
  return "";
}

function shouldDisplaySeatAction(label: string) {
  return !["已入座", "已准备", "取消准备"].includes(label);
}

function statusIndicatorClass(status: string, ready: boolean, presence: string) {
  if (presence === "disconnected") {
    return "is-muted";
  }
  if (status === "waiting") {
    return ready ? "is-ready" : "is-muted";
  }
  if (status === "active") {
    return "is-ready";
  }
  return "is-muted";
}

function HostIcon() {
  return (
    <span className="seat-host-icon" aria-label="房主" title="房主">
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M2.5 12.5h11l-1-5-2.75 1.75L8 4.5 6.25 9.25 3.5 7.5z" />
      </svg>
    </span>
  );
}

function getSeatPositionStyle(room: RoomSnapshot, seatIndex: number): CSSProperties {
  const desktopPositions = [
    { x: 50, y: 88 },
    { x: 20, y: 80 },
    { x: 6, y: 50 },
    { x: 12, y: 24 },
    { x: 33, y: 6 },
    { x: 67, y: 6 },
    { x: 88, y: 24 },
    { x: 94, y: 50 },
    { x: 80, y: 80 },
  ];
  const mobilePositions = [
    { x: 50, y: 86 },
    { x: 18, y: 76 },
    { x: 6, y: 48 },
    { x: 10, y: 24 },
    { x: 30, y: 8 },
    { x: 70, y: 8 },
    { x: 90, y: 24 },
    { x: 94, y: 48 },
    { x: 82, y: 76 },
  ];
  const offset = room.yourSeatIndex ?? 0;
  const normalizedIndex = ((seatIndex - offset) % desktopPositions.length + desktopPositions.length) % desktopPositions.length;
  const position = desktopPositions[normalizedIndex] ?? desktopPositions[0]!;
  const mobilePosition = mobilePositions[normalizedIndex] ?? mobilePositions[0]!;

  return {
    "--seat-x": `${position.x}%`,
    "--seat-y": `${position.y}%`,
    "--seat-mobile-x": `${mobilePosition.x}%`,
    "--seat-mobile-y": `${mobilePosition.y}%`,
  } as CSSProperties;
}
