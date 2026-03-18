import type {
  AvailableAction,
  BettingRound,
  Card,
  HandResult,
  PlayerActionCommand,
  PlayerPresence,
  PlayerStatus,
  PotState,
  RecentPlayerAction,
  RoomConfig,
  TableStage,
} from "@texas-poker/shared";
import { NEXT_HAND_DELAY_MS, RECONNECT_GRACE_HANDS } from "@texas-poker/shared";
import { createDeck, shuffleDeck } from "./cards";
import { compareHandStrength, evaluateSevenCards } from "./hand-evaluator";

export interface EnginePlayer {
  sessionId: string;
  nickname: string;
  seatIndex: number;
  stack: number;
  currentBet: number;
  totalCommitted: number;
  ready: boolean;
  isHost: boolean;
  status: PlayerStatus;
  presence: PlayerPresence;
  holeCards: Card[];
  revealedCards?: Card[];
  missedHands: number;
  lastAction?: RecentPlayerAction;
  rebuyHandsRemaining: number;
}

export interface PokerEngineState {
  config: RoomConfig;
  seats: Array<EnginePlayer | null>;
  handNumber: number;
  stage: TableStage;
  dealerSeatIndex: number | null;
  actingSeatIndex: number | null;
  actionDeadlineAt: string | null;
  currentBet: number;
  minRaiseTo: number | null;
  board: Card[];
  pots: PotState[];
  deck: Card[];
  lastResult?: HandResult;
  startedAt?: string;
  playersToAct: number[];
  actedSinceLastFullRaise: number[];
  lastFullRaiseSize: number;
  participatingSeatIndexes: number[];
  smallBlindSeatIndex: number | null;
  bigBlindSeatIndex: number | null;
  lastAutoAdvanceAt?: string;
}

export function createPokerEngine(config: RoomConfig): PokerEngineState {
  return {
    config,
    seats: Array.from({ length: config.maxPlayers }, () => null),
    handNumber: 0,
    stage: "waiting",
    dealerSeatIndex: null,
    actingSeatIndex: null,
    actionDeadlineAt: null,
    currentBet: 0,
    minRaiseTo: null,
    board: [],
    pots: [],
    deck: [],
    playersToAct: [],
    actedSinceLastFullRaise: [],
    lastFullRaiseSize: config.bigBlind,
    participatingSeatIndexes: [],
    smallBlindSeatIndex: null,
    bigBlindSeatIndex: null,
  };
}

export function isHandActive(stage: TableStage): boolean {
  return stage !== "waiting" && stage !== "showdown";
}

export function seatPlayer(
  state: PokerEngineState,
  input: { sessionId: string; nickname: string; seatIndex: number; isHost?: boolean },
): EnginePlayer {
  if (input.seatIndex < 0 || input.seatIndex >= state.seats.length) {
    throw new Error("Seat index is out of range");
  }

  const existing = state.seats[input.seatIndex];
  if (existing && existing.sessionId !== input.sessionId) {
    throw new Error("Seat is already occupied");
  }

  const player: EnginePlayer = existing ?? {
    sessionId: input.sessionId,
    nickname: input.nickname,
    seatIndex: input.seatIndex,
    stack: state.config.startingStack,
    currentBet: 0,
    totalCommitted: 0,
    ready: false,
    isHost: Boolean(input.isHost),
    status: "waiting",
    presence: "connected",
    holeCards: [],
    missedHands: 0,
    rebuyHandsRemaining: 0,
  };

  player.nickname = input.nickname;
  player.isHost = Boolean(input.isHost);
  player.presence = "connected";
  player.status = player.status === "sit-out" ? "waiting" : player.status;
  state.seats[input.seatIndex] = player;
  return player;
}

export function removePlayerFromSeat(state: PokerEngineState, seatIndex: number): EnginePlayer | null {
  const player = state.seats[seatIndex];
  if (!player) {
    return null;
  }
  if (isHandActive(state.stage) && state.participatingSeatIndexes.includes(seatIndex)) {
    throw new Error("Cannot leave seat during an active hand");
  }
  state.seats[seatIndex] = null;
  if (state.dealerSeatIndex === seatIndex) {
    state.dealerSeatIndex = null;
  }
  return player;
}

export function setPlayerReady(state: PokerEngineState, seatIndex: number, ready: boolean): void {
  const player = requirePlayer(state, seatIndex);
  if (ready && (player.stack <= 0 || player.status === "out")) {
    throw new Error("Player must rebuy before getting ready");
  }
  player.ready = ready;
  if (ready) {
    player.status = "waiting";
    player.missedHands = 0;
  } else if (!isHandActive(state.stage)) {
    player.status = "waiting";
  }
}

export function setPlayerPresence(state: PokerEngineState, seatIndex: number, presence: PlayerPresence): void {
  const player = requirePlayer(state, seatIndex);
  player.presence = presence;
  if (presence === "connected") {
    player.missedHands = 0;
    if (player.status === "sit-out" && player.ready) {
      player.status = "waiting";
    }
  }
}

export function getSeatBySession(state: PokerEngineState, sessionId: string): number | null {
  const foundIndex = state.seats.findIndex((player) => player?.sessionId === sessionId);
  return foundIndex >= 0 ? foundIndex : null;
}

export function canStartHand(state: PokerEngineState): boolean {
  if (isHandActive(state.stage)) {
    return false;
  }

  const eligiblePlayers = state.seats
    .filter((player): player is EnginePlayer => player !== null)
    .filter((player) => player.stack > 0 && player.status !== "sit-out" && player.status !== "out");
  return eligiblePlayers.length >= 2 && eligiblePlayers.every((player) => player.ready && player.presence === "connected");
}

export function startHand(state: PokerEngineState, now = new Date()): void {
  if (isHandActive(state.stage)) {
    throw new Error("A hand is already in progress");
  }

  if (!canStartHand(state)) {
    throw new Error("All seated players must be connected and ready, with at least two players");
  }

  const eligibleSeatIndexes = getEligibleSeatIndexes(state);

  state.handNumber += 1;
  state.lastResult = undefined;
  state.board = [];
  state.pots = [];
  state.deck = shuffleDeck(createDeck());
  state.stage = "preflop";
  state.startedAt = now.toISOString();
  state.lastAutoAdvanceAt = undefined;
  state.currentBet = 0;
  state.minRaiseTo = null;
  state.playersToAct = [];
  state.actedSinceLastFullRaise = [];
  state.lastFullRaiseSize = state.config.bigBlind;
  state.participatingSeatIndexes = [...eligibleSeatIndexes];

  for (const [seatIndex, maybePlayer] of state.seats.entries()) {
    if (!maybePlayer) {
      continue;
    }
    maybePlayer.currentBet = 0;
    maybePlayer.totalCommitted = 0;
    maybePlayer.holeCards = [];
    maybePlayer.revealedCards = undefined;
    if (eligibleSeatIndexes.includes(seatIndex)) {
      maybePlayer.status = "active";
    } else if (maybePlayer.status !== "sit-out" && maybePlayer.status !== "out") {
      maybePlayer.status = "waiting";
    }
  }

  state.dealerSeatIndex = getNextSeat(eligibleSeatIndexes, state.dealerSeatIndex);
  const blindOrder = getBlindSeats(eligibleSeatIndexes, state.dealerSeatIndex);
  state.smallBlindSeatIndex = blindOrder.smallBlindSeatIndex;
  state.bigBlindSeatIndex = blindOrder.bigBlindSeatIndex;

  dealHoleCards(state);
  postBlind(state, blindOrder.smallBlindSeatIndex, state.config.smallBlind);
  postBlind(state, blindOrder.bigBlindSeatIndex, state.config.bigBlind);

  state.currentBet = Math.max(
    requirePlayer(state, blindOrder.smallBlindSeatIndex).currentBet,
    requirePlayer(state, blindOrder.bigBlindSeatIndex).currentBet,
  );
  state.minRaiseTo = state.currentBet + state.lastFullRaiseSize;
  state.playersToAct = getOrderedActiveSeats(state);
  state.actingSeatIndex = getNextActiveSeat(state, blindOrder.bigBlindSeatIndex);
  updatePots(state);

  if (state.actingSeatIndex === null) {
    progressState(state, now);
  }
}

export function getAvailableActions(state: PokerEngineState, seatIndex: number): AvailableAction[] {
  if (state.actingSeatIndex !== seatIndex) {
    return [];
  }

  const player = requirePlayer(state, seatIndex);
  if (player.status !== "active") {
    return [];
  }

  const toCall = Math.max(0, state.currentBet - player.currentBet);
  const totalChips = player.currentBet + player.stack;
  const actions: AvailableAction[] = [{ type: "fold" }];

  if (toCall === 0) {
    actions.push({ type: "check" });
    if (player.stack > 0) {
      const minBet = Math.min(totalChips, state.config.bigBlind);
      actions.push({ type: "bet", minAmount: minBet, maxAmount: totalChips });
    }
  } else {
    actions.push({ type: "call", minAmount: Math.min(toCall, player.stack), maxAmount: Math.min(toCall, player.stack) });
  }

  const canRaise = !state.actedSinceLastFullRaise.includes(seatIndex);
  if (player.stack > toCall && canRaise) {
    const minRaiseTo = state.currentBet === 0 ? state.config.bigBlind : (state.minRaiseTo ?? state.currentBet + state.lastFullRaiseSize);
    if (totalChips >= minRaiseTo) {
      actions.push({
        type: state.currentBet === 0 ? "bet" : "raise",
        minAmount: minRaiseTo,
        maxAmount: totalChips,
      });
    }
  }

  if (player.stack > 0) {
    actions.push({ type: "all_in", minAmount: totalChips, maxAmount: totalChips });
  }

  return dedupeActions(actions);
}

export function applyPlayerAction(
  state: PokerEngineState,
  seatIndex: number,
  action: PlayerActionCommand,
  now = new Date(),
): void {
  if (state.actingSeatIndex !== seatIndex) {
    throw new Error("It is not this player's turn");
  }

  const player = requirePlayer(state, seatIndex);
  if (player.status !== "active") {
    throw new Error("Player cannot act");
  }

  const previousCurrentBet = state.currentBet;
  const previousPlayersToAct = new Set(state.playersToAct);
  const toCall = Math.max(0, state.currentBet - player.currentBet);

  switch (action.type) {
    case "fold":
      player.status = "folded";
      break;
    case "check":
      if (toCall !== 0) {
        throw new Error("Check is only allowed when there is no bet to call");
      }
      break;
    case "call":
      if (toCall === 0) {
        throw new Error("Call is only available when facing a bet");
      }
      commitToBet(player, player.currentBet + Math.min(player.stack, toCall));
      break;
    case "bet":
      if (state.currentBet !== 0) {
        throw new Error("Use raise when a bet is already open");
      }
      if (!action.amount) {
        throw new Error("Bet amount is required");
      }
      validateWager(action.amount, Math.min(player.currentBet + player.stack, state.config.bigBlind), player.currentBet + player.stack);
      commitToBet(player, action.amount);
      state.currentBet = player.currentBet;
      break;
    case "raise":
      if (state.currentBet === 0) {
        throw new Error("Use bet to open the round");
      }
      if (!action.amount) {
        throw new Error("Raise amount is required");
      }
      validateWager(action.amount, state.minRaiseTo ?? state.currentBet + state.lastFullRaiseSize, player.currentBet + player.stack);
      commitToBet(player, action.amount);
      state.currentBet = player.currentBet;
      break;
    case "all_in":
      if (player.stack <= 0) {
        throw new Error("Player has no chips left");
      }
      commitToBet(player, player.currentBet + player.stack);
      if (player.currentBet > state.currentBet) {
        state.currentBet = player.currentBet;
      }
      break;
    default:
      throw new Error("Unsupported action");
  }

  previousPlayersToAct.delete(seatIndex);

  const currentBetIncreased = player.currentBet > previousCurrentBet;
  const raiseSize = player.currentBet - previousCurrentBet;
  const isFullRaise = currentBetIncreased && raiseSize >= state.lastFullRaiseSize;

  if (action.type !== "fold") {
    addUnique(state.actedSinceLastFullRaise, seatIndex);
  }

  if (currentBetIncreased) {
    if (isFullRaise) {
      state.lastFullRaiseSize = raiseSize;
      state.actedSinceLastFullRaise = [seatIndex];
      state.playersToAct = getOrderedActiveSeats(state).filter((activeSeat) => activeSeat !== seatIndex);
    } else {
      state.playersToAct = getOrderedActiveSeats(state).filter((activeSeat) => activeSeat !== seatIndex && requirePlayer(state, activeSeat).currentBet < state.currentBet);
    }
  } else {
    state.playersToAct = [...previousPlayersToAct];
  }

  if (player.stack === 0 && player.status === "active") {
    player.status = "all-in";
  }

  updatePots(state);
  progressState(state, now, seatIndex);
}

export function buildCurrentPots(state: PokerEngineState): PotState[] {
  return calculatePotStates(state, false);
}

export function getNextHandStartsAt(lastResultAt: Date): string {
  return new Date(lastResultAt.getTime() + NEXT_HAND_DELAY_MS).toISOString();
}

export function canRebuyChips(state: PokerEngineState, seatIndex: number): boolean {
  const player = requirePlayer(state, seatIndex);
  return !isHandActive(state.stage) && player.stack <= 0 && player.status === "out" && player.rebuyHandsRemaining <= 0;
}

export function rebuyChips(state: PokerEngineState, seatIndex: number): void {
  if (!canRebuyChips(state, seatIndex)) {
    throw new Error("Player cannot rebuy yet");
  }

  const player = requirePlayer(state, seatIndex);
  player.stack = state.config.startingStack;
  player.currentBet = 0;
  player.totalCommitted = 0;
  player.ready = false;
  player.status = "waiting";
  player.rebuyHandsRemaining = 0;
}

function progressState(state: PokerEngineState, now: Date, lastActedSeat?: number): void {
  while (true) {
    const contenders = getContendingSeats(state);
    if (contenders.length <= 1) {
      concludeUncontested(state, contenders[0], now);
      return;
    }

    const activeSeats = getOrderedActiveSeats(state);
    if (state.playersToAct.length > 0 && activeSeats.length > 0) {
      const startFrom = lastActedSeat ?? state.bigBlindSeatIndex ?? state.dealerSeatIndex ?? 0;
      state.actingSeatIndex = getNextSeat(state.playersToAct, startFrom);
      state.minRaiseTo = state.currentBet === 0 ? state.config.bigBlind : state.currentBet + state.lastFullRaiseSize;
      return;
    }

    if (state.stage === "river" || activeSeats.length <= 1) {
      while (state.board.length < 5) {
        revealCommunityCards(state, state.board.length === 0 ? 3 : 1);
      }
      concludeShowdown(state, now);
      return;
    }

    advanceRound(state);
    if (state.playersToAct.length === 0 && getOrderedActiveSeats(state).length === 0) {
      continue;
    }
  }
}

function advanceRound(state: PokerEngineState): void {
  const stages: BettingRound[] = ["preflop", "flop", "turn", "river"];
  const currentRound = state.stage as BettingRound;
  const currentIndex = stages.indexOf(currentRound);

  const nextRound = stages[currentIndex + 1];
  if (!nextRound) {
    state.stage = "showdown";
    state.actingSeatIndex = null;
    state.actionDeadlineAt = null;
    return;
  }

  state.stage = nextRound;
  revealCommunityCards(state, nextRound === "flop" ? 3 : 1);
  for (const seatIndex of state.participatingSeatIndexes) {
    const player = requirePlayer(state, seatIndex);
    player.currentBet = 0;
  }
  state.currentBet = 0;
  state.minRaiseTo = state.config.bigBlind;
  state.lastFullRaiseSize = state.config.bigBlind;
  state.actedSinceLastFullRaise = [];
  state.playersToAct = getOrderedActiveSeats(state);
  state.actingSeatIndex = getNextActiveSeat(state, state.dealerSeatIndex ?? 0);
  updatePots(state);
}

function concludeUncontested(state: PokerEngineState, winnerSeatIndex: number | undefined, now: Date): void {
  if (winnerSeatIndex === undefined) {
    throw new Error("Unable to determine uncontested winner");
  }

  const winner = requirePlayer(state, winnerSeatIndex);
  const totalPot = state.participatingSeatIndexes.reduce((sum, seatIndex) => sum + requirePlayer(state, seatIndex).totalCommitted, 0);
  winner.stack += totalPot;

  const result: HandResult = {
    handNumber: state.handNumber,
    board: [...state.board],
    pots: totalPot > 0 ? [{ amount: totalPot, eligibleSeatIndexes: [winnerSeatIndex] }] : [],
    winners: [{
      seatIndex: winnerSeatIndex,
      nickname: winner.nickname,
      amount: totalPot,
      rankName: "未摊牌获胜",
      cards: [...winner.holeCards],
    }],
  };

  finishHand(state, result, now, [winnerSeatIndex]);
}

function concludeShowdown(state: PokerEngineState, now: Date): void {
  const pots = calculatePotStates(state, true);
  const evaluations = new Map<number, ReturnType<typeof evaluateSevenCards>>();
  const contenders = getContendingSeats(state);

  for (const seatIndex of contenders) {
    const player = requirePlayer(state, seatIndex);
    player.revealedCards = [...player.holeCards];
    evaluations.set(seatIndex, evaluateSevenCards([...state.board, ...player.holeCards]));
  }

  const winnings = new Map<number, { amount: number; rankName: string; cards: Card[] }>();

  for (const pot of pots) {
    const eligible = pot.eligibleSeatIndexes.filter((seatIndex) => evaluations.has(seatIndex));
    const ranked = [...eligible].sort((left, right) => compareHandStrength(evaluations.get(right)!, evaluations.get(left)!));
    const best = ranked[0];
    if (best === undefined) {
      continue;
    }

    const bestStrength = evaluations.get(best)!;
    const potWinners = eligible.filter((seatIndex) => compareHandStrength(evaluations.get(seatIndex)!, bestStrength) === 0);
    const splitAmount = Math.floor(pot.amount / potWinners.length);
    let remainder = pot.amount % potWinners.length;
    const payoutOrder = sortSeatsFromDealer(potWinners, state.dealerSeatIndex);

    for (const seatIndex of payoutOrder) {
      const bonus = remainder > 0 ? 1 : 0;
      remainder = Math.max(0, remainder - bonus);
      const payout = splitAmount + bonus;
      const player = requirePlayer(state, seatIndex);
      player.stack += payout;
      const current = winnings.get(seatIndex);
      winnings.set(seatIndex, {
        amount: (current?.amount ?? 0) + payout,
        rankName: bestStrength.name,
        cards: [...player.holeCards],
      });
    }
  }

  const result: HandResult = {
    handNumber: state.handNumber,
    board: [...state.board],
    pots,
    winners: [...winnings.entries()].map(([seatIndex, info]) => ({
      seatIndex,
      nickname: requirePlayer(state, seatIndex).nickname,
      amount: info.amount,
      rankName: info.rankName,
      cards: info.cards,
    })),
  };

  finishHand(state, result, now, contenders);
}

function finishHand(state: PokerEngineState, result: HandResult, now: Date, revealedSeats: number[]): void {
  const bustedSeatIndexes = new Set<number>();
  for (const seatIndex of state.participatingSeatIndexes) {
    const player = requirePlayer(state, seatIndex);
    if (!revealedSeats.includes(seatIndex)) {
      player.revealedCards = undefined;
    }
    player.currentBet = 0;
    player.totalCommitted = 0;
    player.holeCards = [];

    if (player.presence === "connected") {
      player.missedHands = 0;
    } else if (player.ready) {
      player.missedHands += 1;
      if (player.missedHands >= RECONNECT_GRACE_HANDS) {
        player.ready = false;
        player.status = "sit-out";
      }
    }

    if (player.status !== "sit-out") {
      if (player.stack <= 0) {
        player.ready = false;
        player.status = "out";
        player.rebuyHandsRemaining = state.config.rebuyCooldownHands;
        bustedSeatIndexes.add(seatIndex);
      } else {
        player.status = "waiting";
        player.rebuyHandsRemaining = 0;
      }
    }
  }

  for (const [seatIndex, player] of state.seats.entries()) {
    if (!player || bustedSeatIndexes.has(seatIndex)) {
      continue;
    }
    if (player.status === "out" && player.stack <= 0 && player.rebuyHandsRemaining > 0) {
      player.rebuyHandsRemaining -= 1;
    }
  }

  state.stage = "showdown";
  state.lastResult = result;
  state.pots = [];
  state.currentBet = 0;
  state.minRaiseTo = null;
  state.actingSeatIndex = null;
  state.actionDeadlineAt = null;
  state.playersToAct = [];
  state.actedSinceLastFullRaise = [];
  state.lastAutoAdvanceAt = now.toISOString();
}

function updatePots(state: PokerEngineState): void {
  state.pots = calculatePotStates(state, false);
}

function calculatePotStates(state: PokerEngineState, showdownOnly: boolean): PotState[] {
  const contributors = state.participatingSeatIndexes
    .map((seatIndex) => requirePlayer(state, seatIndex))
    .filter((player) => player.totalCommitted > 0);

  const levels = [...new Set(contributors.map((player) => player.totalCommitted))].sort((left, right) => left - right);
  const pots: PotState[] = [];
  let previousLevel = 0;

  for (const level of levels) {
    const involved = contributors.filter((player) => player.totalCommitted >= level);
    const amount = (level - previousLevel) * involved.length;
    const eligibleSeatIndexes = involved
      .filter((player) => player.status !== "folded")
      .map((player) => player.seatIndex);
    previousLevel = level;
    if (amount <= 0) {
      continue;
    }
    if (showdownOnly || eligibleSeatIndexes.length > 0) {
      pots.push({ amount, eligibleSeatIndexes });
    }
  }

  return pots;
}

function getEligibleSeatIndexes(state: PokerEngineState): number[] {
  return state.seats
    .map((player, seatIndex) => ({ player, seatIndex }))
    .filter(({ player }) => player && player.stack > 0 && player.ready && player.status !== "sit-out" && player.status !== "out")
    .map(({ seatIndex }) => seatIndex);
}

function getContendingSeats(state: PokerEngineState): number[] {
  return state.participatingSeatIndexes.filter((seatIndex) => {
    const player = requirePlayer(state, seatIndex);
    return player.status === "active" || player.status === "all-in";
  });
}

function getOrderedActiveSeats(state: PokerEngineState): number[] {
  return state.participatingSeatIndexes.filter((seatIndex) => requirePlayer(state, seatIndex).status === "active");
}

function getNextSeat(seatIndexes: number[], startSeatIndex: number | null): number {
  const sorted = [...seatIndexes].sort((left, right) => left - right);
  if (sorted.length === 0) {
    throw new Error("No seat available");
  }
  if (startSeatIndex === null) {
    return sorted[0]!;
  }
  const candidate = sorted.find((seatIndex) => seatIndex > startSeatIndex);
  return candidate ?? sorted[0]!;
}

function getNextActiveSeat(state: PokerEngineState, fromSeatIndex: number): number | null {
  const activeSeats = getOrderedActiveSeats(state);
  if (activeSeats.length === 0) {
    return null;
  }
  return getNextSeat(activeSeats, fromSeatIndex);
}

function getBlindSeats(seatIndexes: number[], dealerSeatIndex: number): { smallBlindSeatIndex: number; bigBlindSeatIndex: number } {
  if (seatIndexes.length === 2) {
    return {
      smallBlindSeatIndex: dealerSeatIndex,
      bigBlindSeatIndex: getNextSeat(seatIndexes, dealerSeatIndex),
    };
  }

  const smallBlindSeatIndex = getNextSeat(seatIndexes, dealerSeatIndex);
  return {
    smallBlindSeatIndex,
    bigBlindSeatIndex: getNextSeat(seatIndexes, smallBlindSeatIndex),
  };
}

function dealHoleCards(state: PokerEngineState): void {
  const dealOrder = sortSeatsFromDealer(state.participatingSeatIndexes, state.dealerSeatIndex);
  for (let round = 0; round < 2; round += 1) {
    for (const seatIndex of dealOrder) {
      const player = requirePlayer(state, seatIndex);
      const nextCard = state.deck.shift();
      if (!nextCard) {
        throw new Error("Deck ran out of cards");
      }
      player.holeCards.push(nextCard);
    }
  }
}

function postBlind(state: PokerEngineState, seatIndex: number, amount: number): void {
  const player = requirePlayer(state, seatIndex);
  commitToBet(player, player.currentBet + Math.min(player.stack, amount));
  if (player.stack === 0) {
    player.status = "all-in";
  }
}

function commitToBet(player: EnginePlayer, targetAmount: number): void {
  if (targetAmount < player.currentBet) {
    throw new Error("Cannot reduce an existing bet");
  }
  const delta = targetAmount - player.currentBet;
  if (delta > player.stack) {
    throw new Error("Player does not have enough chips");
  }
  player.stack -= delta;
  player.currentBet = targetAmount;
  player.totalCommitted += delta;
}

function revealCommunityCards(state: PokerEngineState, count: number): void {
  for (let index = 0; index < count; index += 1) {
    const card = state.deck.shift();
    if (!card) {
      throw new Error("Deck ran out while dealing community cards");
    }
    state.board.push(card);
  }
}

function validateWager(amount: number, minimum: number, maximum: number): void {
  if (amount < minimum) {
    throw new Error("Bet is below the minimum");
  }
  if (amount > maximum) {
    throw new Error("Bet exceeds available chips");
  }
}

function dedupeActions(actions: AvailableAction[]): AvailableAction[] {
  const map = new Map<string, AvailableAction>();
  for (const action of actions) {
    const key = `${action.type}:${action.minAmount ?? ""}:${action.maxAmount ?? ""}`;
    map.set(key, action);
  }
  return [...map.values()];
}

function addUnique(values: number[], seatIndex: number): void {
  if (!values.includes(seatIndex)) {
    values.push(seatIndex);
  }
}

function sortSeatsFromDealer(seatIndexes: number[], dealerSeatIndex: number | null): number[] {
  const sorted = [...seatIndexes].sort((left, right) => left - right);
  if (sorted.length <= 1 || dealerSeatIndex === null) {
    return sorted;
  }
  const pivot = sorted.findIndex((seatIndex) => seatIndex > dealerSeatIndex);
  if (pivot < 0) {
    return sorted;
  }
  return [...sorted.slice(pivot), ...sorted.slice(0, pivot)];
}

function requirePlayer(state: PokerEngineState, seatIndex: number): EnginePlayer {
  const player = state.seats[seatIndex];
  if (!player) {
    throw new Error("Seat is empty");
  }
  return player;
}
