import type { Card, PotState } from "@texas-poker/shared";

export function CommunityBoard(props: {
  board: Card[];
  pots: PotState[];
  stage: string;
  handNumber: number;
}) {
  const totalPot = props.pots.reduce((sum, pot) => sum + pot.amount, 0);

  return (
    <section className="board-panel">
      <div className="board-header">
        <span>第 {props.handNumber || 0} 手</span>
        <span>{stageLabel(props.stage)}</span>
      </div>
      <div className="board-cards" aria-label="公共牌">
        {Array.from({ length: 5 }, (_, index) => {
          const card = props.board[index];
          return (
            <div key={index} className={`card-tile ${card ? "" : "is-empty"}`}>
              {card ? cardLabel(card) : "?"}
            </div>
          );
        })}
      </div>
      <div className="pot-strip">
        <span className="pot-total">底池 {totalPot}</span>
        {props.pots.length > 1 && <span className="pot-side">边池 {props.pots.length - 1}</span>}
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

function cardLabel(card: Card) {
  const rank = card.rank <= 10 ? String(card.rank) : ({ 11: "J", 12: "Q", 13: "K", 14: "A" }[card.rank] ?? "?");
  const suit = {
    clubs: "♣",
    diamonds: "♦",
    hearts: "♥",
    spades: "♠",
  }[card.suit];
  return `${rank}${suit}`;
}
