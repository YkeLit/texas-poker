import { useMemo, useState } from "react";
import type { AvailableAction, RoomSnapshot } from "@texas-poker/shared";

export function ActionPanel(props: {
  snapshot: RoomSnapshot;
  onAction: (action: { type: string; amount?: number }) => void;
  onToggleReady: (ready: boolean) => void;
  onStartHand: () => void;
  onLeaveSeat: () => void;
}) {
  const [amount, setAmount] = useState<number | "">("");
  const availableActions = useMemo(() => props.snapshot.yourAvailableActions, [props.snapshot.yourAvailableActions]);
  const seated = props.snapshot.yourSeatIndex !== null && props.snapshot.yourSeatIndex !== undefined;
  const selfSeat = seated ? props.snapshot.seats[props.snapshot.yourSeatIndex!] : undefined;
  const selfPlayer = selfSeat?.player;
  const isHost = selfPlayer?.isHost ?? false;
  const canStart = isHost && props.snapshot.stage === "waiting" && props.snapshot.seats.filter((seat) => seat.player?.ready).length >= 2;

  return (
    <section className="action-panel">
      <div className="action-header">
        <span>{seated ? "你的操作" : "先入座开始"}</span>
        {seated && (
          <button type="button" className="ghost-btn" onClick={props.onLeaveSeat}>
            离座
          </button>
        )}
      </div>

      {!seated && <p className="muted-copy">点击任意空位入座，然后准备开局。</p>}

      {seated && props.snapshot.stage === "waiting" && (
        <div className="ready-row">
          <button type="button" className="primary-btn" onClick={() => props.onToggleReady(!(selfPlayer?.ready ?? false))}>
            {selfPlayer?.ready ? "取消准备" : "准备"}
          </button>
          {canStart && (
            <button id="start-hand-btn" type="button" className="secondary-btn" onClick={props.onStartHand}>
              开始第一手
            </button>
          )}
        </div>
      )}

      {props.snapshot.lastResult && (
        <div className="result-panel">
          <h3>上一手结果</h3>
          <ul>
            {props.snapshot.lastResult.winners.map((winner) => (
              <li key={`${winner.seatIndex}-${winner.amount}`}>
                {winner.nickname} 获得 {winner.amount} · {winner.rankName}
              </li>
            ))}
          </ul>
        </div>
      )}

      {availableActions.length > 0 && (
        <>
          <label className="range-label">
            下注额
            <input
              id="bet-amount-input"
              type="number"
              min={minAmountForActions(availableActions) ?? 0}
              max={maxAmountForActions(availableActions) ?? 0}
              value={amount}
              onChange={(event) => setAmount(event.target.value ? Number(event.target.value) : "")}
            />
          </label>
          <div className="action-grid">
            {availableActions.map((action) => (
              <button
                key={`${action.type}-${action.minAmount ?? 0}-${action.maxAmount ?? 0}`}
                type="button"
                className={`action-btn ${action.type === "fold" ? "danger-btn" : ""}`}
                onClick={() => props.onAction(createActionPayload(action, amount))}
              >
                {actionLabel(action)}
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function actionLabel(action: AvailableAction) {
  if (action.type === "call" && action.minAmount) {
    return `跟注 ${action.minAmount}`;
  }
  if ((action.type === "bet" || action.type === "raise") && action.minAmount && action.maxAmount) {
    return `${action.type === "bet" ? "下注" : "加注"} ${action.minAmount}-${action.maxAmount}`;
  }
  if (action.type === "all_in" && action.maxAmount) {
    return `全下 ${action.maxAmount}`;
  }
  return {
    fold: "弃牌",
    check: "过牌",
    call: "跟注",
    bet: "下注",
    raise: "加注",
    all_in: "全下",
  }[action.type];
}

function createActionPayload(action: AvailableAction, amount: number | "") {
  if (action.type === "bet" || action.type === "raise") {
    return {
      type: action.type,
      amount: amount || action.minAmount,
    };
  }
  return { type: action.type };
}

function minAmountForActions(actions: AvailableAction[]) {
  return actions
    .map((action) => action.minAmount)
    .filter((value): value is number => typeof value === "number")
    .reduce<number | null>((minValue, value) => (minValue === null ? value : Math.min(minValue, value)), null);
}

function maxAmountForActions(actions: AvailableAction[]) {
  return actions
    .map((action) => action.maxAmount)
    .filter((value): value is number => typeof value === "number")
    .reduce<number | null>((maxValue, value) => (maxValue === null ? value : Math.max(maxValue, value)), null);
}
