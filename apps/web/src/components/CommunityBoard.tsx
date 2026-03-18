import type { Card, PotState, SeatState } from "@texas-poker/shared";
import { PlayingCard } from "./PlayingCard";

export function CommunityBoard(props: {
  board: Card[];
  yourHoleCards?: Card[];
  pots: PotState[];
  seats: SeatState[];
  yourSeatIndex?: number | null;
  stage: string;
  handNumber: number;
}) {
  const totalPot = props.pots.reduce((sum, pot) => sum + pot.amount, 0);
  const opponentBets = props.seats
    .filter((seat) => seat.player && seat.seatIndex !== props.yourSeatIndex && seat.player.currentBet > 0)
    .map((seat) => ({
      seatIndex: seat.seatIndex,
      nickname: seat.player!.nickname,
      currentBet: seat.player!.currentBet,
    }));

  return (
    <section className="board-panel">
      <div className="board-header">
        <span>第 {props.handNumber || 0} 手</span>
        <span>{stageLabel(props.stage)}</span>
      </div>
      <div className="merged-card-row" aria-label="牌面">
        {props.yourHoleCards && props.yourHoleCards.length > 0 && (
          <>
            <div className="merged-card-group merged-card-group-hero" aria-label="你的底牌">
              {props.yourHoleCards.map((card, index) => (
                <PlayingCard key={`${card.rank}-${card.suit}-${index}`} card={card} compact variant="hero" />
              ))}
            </div>
            <span className="merged-card-separator" aria-hidden="true" />
          </>
        )}
        <div className="merged-card-group merged-card-group-board" aria-label="公共牌">
          {Array.from({ length: 5 }, (_, index) => {
            const card = props.board[index];
            return <PlayingCard key={index} card={card} />;
          })}
        </div>
      </div>
      <div className="pot-strip">
        <span className="pot-total">底池 {totalPot}</span>
        {props.pots.length > 1 && <span className="pot-side">边池 {props.pots.length - 1}</span>}
      </div>
      <div className="bet-focus-row">
        <span className="bet-focus-label">对手下注</span>
        {opponentBets.length > 0 ? (
          <div className="bet-focus-list">
            {opponentBets.map((bet) => (
              <span key={`${bet.seatIndex}-${bet.currentBet}`} className="bet-focus-pill">
                {bet.nickname} {bet.currentBet}
              </span>
            ))}
          </div>
        ) : (
          <span className="bet-focus-empty">暂无</span>
        )}
      </div>
    </section>
  );
}

function stageLabel(stage: string) {
  return {
    waiting: "等待开局",
    preflop: "翻牌前",
    flop: "翻牌",
    turn: "转牌",
    river: "河牌",
    showdown: "摊牌",
  }[stage] ?? stage;
}
