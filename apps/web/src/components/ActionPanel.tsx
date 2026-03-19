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
  const wagerAction = useMemo(
    () => availableActions.find((action) => action.type === "bet" || action.type === "raise"),
    [availableActions],
  );
  const otherActions = useMemo(
    () => availableActions.filter((action) => action.type !== "bet" && action.type !== "raise"),
    [availableActions],
  );
  const seated = props.snapshot.yourSeatIndex !== null && props.snapshot.yourSeatIndex !== undefined;
  const selfSeat = seated ? props.snapshot.seats[props.snapshot.yourSeatIndex!] : undefined;
  const selfPlayer = selfSeat?.player;
  const selfCurrentBet = selfPlayer?.currentBet ?? 0;
  const wagerRange = useMemo(() => getWagerRange(wagerAction, selfCurrentBet), [selfCurrentBet, wagerAction]);
  const isHost = selfPlayer?.isHost ?? false;
  const canStart = isHost && canStartFromSnapshot(props.snapshot);
  const canShowStartControls = seated && (props.snapshot.stage === "waiting" || props.snapshot.stage === "showdown");
  const submitAmount = resolveWagerAmount(amount, wagerRange);

  return (
    <section className={`action-panel ${seated ? "" : "is-compact"}`.trim()}>
      <div className="action-header">
        <span>{seated ? "你的操作" : "先入座开始"}</span>
        {seated && (
          <button type="button" className="ghost-btn" onClick={props.onLeaveSeat}>
            离座
          </button>
        )}
      </div>

      {!seated && <p className="muted-copy">点击任意空位入座，然后准备开局。</p>}

      {seated && selfPlayer?.status === "out" && (
        <div className="rebuy-panel">
          <h3>补充筹码</h3>
          {selfPlayer.canRebuy ? (
            <>
              <p className="muted-copy">你已经输光，可以手动补充到 {props.snapshot.config.startingStack} 筹码后重新准备。</p>
              <button type="button" className="primary-btn" onClick={() => props.onAction({ type: "rebuy" })}>
                补充筹码
              </button>
            </>
          ) : (
            <p className="muted-copy">你已经输光，还需等待 {selfPlayer.rebuyRemainingHands} 局后才能补充筹码。</p>
          )}
        </div>
      )}

      {canShowStartControls && (
        <>
          <div className="ready-row">
            <button
              type="button"
              className={selfPlayer?.ready ? "secondary-btn" : "success-btn"}
              disabled={selfPlayer?.status === "out"}
              onClick={() => props.onToggleReady(!(selfPlayer?.ready ?? false))}
            >
              {selfPlayer?.ready ? "取消准备" : "准备"}
            </button>
            {canStart && (
              <button id="start-hand-btn" type="button" className="primary-btn" onClick={props.onStartHand}>
                {props.snapshot.handNumber > 0 ? "开始下一手" : "开始第一手"}
              </button>
            )}
          </div>
          <p className="muted-copy">所有已入座玩家都准备后，房主才可以开始发牌。</p>
        </>
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

      {availableActions.length > 0 && selfPlayer?.status !== "out" && (
        <>
          {wagerAction && (
            <label className="range-label">
              本次追加筹码
              <input
                id="bet-amount-input"
                type="number"
                min={wagerRange.min}
                max={wagerRange.max}
                value={amount}
                placeholder={`最小 ${wagerRange.min}`}
                onChange={(event) => setAmount(event.target.value ? Number(event.target.value) : "")}
              />
              <span className="range-hint">
                最小 {wagerRange.min}，最大 {wagerRange.max}
              </span>
            </label>
          )}
          <div className="action-grid">
            {otherActions.map((action) => (
              <button
                key={`${action.type}-${action.minAmount ?? 0}-${action.maxAmount ?? 0}`}
                type="button"
                className={`action-btn ${actionToneClass(action.type)}`}
                onClick={() => props.onAction(createActionPayload(action, amount, selfCurrentBet))}
              >
                {actionLabel(action, selfCurrentBet)}
              </button>
            ))}
            {wagerAction && (
              <button
                key={`${wagerAction.type}-${wagerAction.minAmount ?? 0}-${wagerAction.maxAmount ?? 0}`}
                type="button"
                className="action-btn is-aggressive"
                onClick={() => props.onAction(createActionPayload(wagerAction, submitAmount, selfCurrentBet))}
              >
                {wagerActionLabel(wagerAction)}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function actionLabel(action: AvailableAction, currentBet: number) {
  if (action.type === "call" && action.minAmount) {
    return `跟注 ${action.minAmount}`;
  }
  if (action.type === "all_in" && action.maxAmount) {
    return `全下 ${Math.max(0, action.maxAmount - currentBet)}`;
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

export function createActionPayload(action: AvailableAction, amount: number | "", currentBet: number) {
  if (action.type === "bet" || action.type === "raise") {
    const resolvedAmount = typeof amount === "number" ? amount : getWagerRange(action, currentBet).min;
    return {
      type: action.type,
      amount: currentBet + resolvedAmount,
    };
  }
  return { type: action.type };
}

function actionToneClass(actionType: AvailableAction["type"]) {
  if (actionType === "call" || actionType === "check") {
    return "is-safe";
  }
  if (actionType === "bet" || actionType === "raise" || actionType === "all_in") {
    return "is-aggressive";
  }
  return "is-neutral";
}

function wagerActionLabel(_action: AvailableAction) {
  return _action.type === "bet" ? "确认下注" : "确认加注";
}

export function getWagerRange(action: AvailableAction | undefined, currentBet: number) {
  if (!action || (action.type !== "bet" && action.type !== "raise")) {
    return { min: 0, max: 0 };
  }

  const min = Math.max(0, (action.minAmount ?? currentBet) - currentBet);
  const max = Math.max(min, (action.maxAmount ?? currentBet) - currentBet);
  return { min, max };
}

export function resolveWagerAmount(draft: number | "", range: { min: number; max: number }) {
  const { min, max } = range;
  if (typeof draft !== "number" || Number.isNaN(draft)) {
    return min;
  }
  return Math.min(Math.max(draft, min), max);
}

function canStartFromSnapshot(snapshot: RoomSnapshot) {
  if (snapshot.stage !== "waiting" && snapshot.stage !== "showdown") {
    return false;
  }

  const seatedPlayers = snapshot.seats
    .map((seat) => seat.player)
    .filter((player): player is NonNullable<RoomSnapshot["seats"][number]["player"]> => player !== undefined)
    .filter((player) => player.stack > 0 && player.status !== "sit-out" && player.status !== "out");

  return seatedPlayers.length >= 2 && seatedPlayers.every((player) => player.ready && player.presence === "connected");
}
