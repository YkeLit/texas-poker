import type { Card } from "@texas-poker/shared";

const SUIT_META = {
  clubs: { symbol: "♣", color: "black" },
  diamonds: { symbol: "♦", color: "red" },
  hearts: { symbol: "♥", color: "red" },
  spades: { symbol: "♠", color: "black" },
} as const;

export function PlayingCard(props: {
  card?: Card;
  compact?: boolean;
  variant?: "default" | "hero";
  faceDown?: boolean;
}) {
  const variantClass = props.variant === "hero" ? "is-hero" : "";

  if (props.faceDown) {
    return (
      <div className={`card-tile ${props.compact ? "is-compact" : ""} ${variantClass} is-facedown`} aria-hidden="true">
        <span className="card-back-mark" />
      </div>
    );
  }

  if (!props.card) {
    return (
      <div className={`card-tile ${props.compact ? "is-compact" : ""} ${variantClass} is-empty`} aria-hidden="true">
        <span className="card-placeholder">?</span>
      </div>
    );
  }

  const suit = SUIT_META[props.card.suit];

  return (
    <div
      className={`card-tile ${props.compact ? "is-compact" : ""} ${variantClass} ${suit.color === "red" ? "is-red" : "is-black"}`}
      aria-label={cardToText(props.card)}
    >
      <span className="card-rank">{rankToText(props.card.rank)}</span>
      <span className="card-suit">{suit.symbol}</span>
    </div>
  );
}

function rankToText(rank: number) {
  return rank <= 10 ? String(rank) : ({ 11: "J", 12: "Q", 13: "K", 14: "A" }[rank] ?? "?");
}

function cardToText(card: Card) {
  const suit = SUIT_META[card.suit];
  return `${rankToText(card.rank)}${suit.symbol}`;
}
