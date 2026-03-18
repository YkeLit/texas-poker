import type { Card, PotState } from "@texas-poker/shared";
import { PlayingCard } from "./PlayingCard";

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
          return <PlayingCard key={index} card={card} />;
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
