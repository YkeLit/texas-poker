import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";

const base = process.env.BASE_URL;
assert(base && ["127.0.0.1", "localhost"].includes(new URL(base).hostname));
const browser = await chromium.launch({ headless: true });
const checks = [];
const pageErrors = [];
const observed = [];

function observe(page) {
  const player = { page, context: page.context(), view: null, connections: new Map(), commands: 0 };
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("websocket", (socket) => {
    socket.on("framesent", (frame) => {
      const raw = String(frame.payload);
      if (!raw.startsWith("42")) return;
      try {
        const [event] = JSON.parse(raw.slice(2));
        if (event === "command") player.commands += 1;
      } catch { /* Ignore non-JSON transport frames. */ }
    });
    socket.on("framereceived", (frame) => {
      const raw = String(frame.payload);
      if (!raw.startsWith("42")) return;
      try {
        const [event, value] = JSON.parse(raw.slice(2));
        if (event === "state.snapshot") {
          player.view = {
            roomId: value.roomId,
            roomCode: value.roomCode,
            participantId: value.participantId,
            yourSeatIndex: value.yourSeatIndex,
            stage: value.stage,
            revision: value.revision,
            actingSeatIndex: value.actingSeatIndex,
            actionDeadlineAt: value.actionDeadlineAt,
            ownCardsHash: createHash("sha256").update(JSON.stringify(value.yourHoleCards ?? [])).digest("hex"),
            lastResultWinners: value.lastResult?.winners?.map(({ seatIndex, amount }) => ({ seatIndex, amount })) ?? [],
            seats: value.seats.map((seat) => ({
              seatIndex: seat.seatIndex,
              occupied: seat.occupied,
              presence: seat.player?.presence ?? null,
              ready: seat.player?.ready ?? false,
              lastAction: seat.player?.lastAction?.type ?? null,
            })),
          };
        } else if (event === "presence.changed" && Array.isArray(value?.participants)) {
          for (const participant of value.participants) {
            player.connections.set(participant.participantId, participant.connectionCount);
          }
        }
      } catch { /* Ignore acknowledgements and non-snapshot messages. */ }
    });
  });
  return player;
}

async function until(predicate, message, timeoutMs = 8_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

function pass(name) { checks.push({ case: name, result: "PASS" }); }
function occupied(view) { return view.seats.filter((seat) => seat.occupied).length; }
async function newPage(context, name, roomCode) {
  const page = await context.newPage();
  const player = observe(page);
  observed.push(player);
  await page.goto(base);
  if (name) {
    await page.locator("#nickname-input").fill(name);
    if (roomCode) {
      await page.locator("#room-code-input").fill(roomCode);
      await page.locator("#join-room-btn").click();
    } else {
      await page.getByLabel("行动时限").fill("20");
      await page.locator("#create-room-btn").click();
    }
  }
  await until(() => player.view, "browser did not attach to a real room");
  return player;
}

const contexts = [];
try {
  const hostContext = await browser.newContext(); contexts.push(hostContext);
  let host = await newPage(hostContext, "本机房主", null);
  await host.page.locator(".seat-node.is-empty").first().click();
  await until(() => host.view?.yourSeatIndex !== null, "host did not take a seat");
  const hostIdentity = { roomId: host.view.roomId, participantId: host.view.participantId, seat: host.view.yourSeatIndex };

  let hostTwin = await newPage(hostContext, null, null);
  await until(() => hostTwin.view?.participantId === hostIdentity.participantId && hostTwin.view?.yourSeatIndex === hostIdentity.seat, "same-cookie tab did not restore same seat");
  await until(() => hostTwin.connections.get(hostIdentity.participantId) === 2, "same-cookie connection count did not reach two");
  assert.equal(occupied(hostTwin.view), 1);
  pass("same-cookie second tab attaches to the existing participant and seat without duplicating membership");

  await host.page.close();
  await until(() => hostTwin.connections.get(hostIdentity.participantId) === 1 && hostTwin.view?.seats[hostIdentity.seat]?.presence === "connected", "closing one tab incorrectly disconnected the shared player");
  pass("closing one tab preserves the other tab's online presence");

  const guestContext = await browser.newContext(); contexts.push(guestContext);
  const guest = await newPage(guestContext, "本机玩家二", hostTwin.view.roomCode);
  await guest.page.locator(".seat-node.is-empty").first().click();
  await until(() => guest.view?.yourSeatIndex !== null, "guest did not take a seat");
  await hostTwin.page.getByRole("button", { name: "准备", exact: true }).click();
  await guest.page.getByRole("button", { name: "准备", exact: true }).click();
  await until(() => hostTwin.view?.seats[hostIdentity.seat]?.ready && guest.view?.seats[guest.view.yourSeatIndex]?.ready, "both seated players did not become ready");
  await hostTwin.page.getByRole("button", { name: "开始第一手", exact: true }).click();
  await until(() => hostTwin.view?.stage === "preflop" && guest.view?.stage === "preflop", "two real UI players did not start a hand");
  assert.equal(occupied(hostTwin.view), 2);
  assert.equal(hostTwin.view.roomId, hostIdentity.roomId);
  pass("two independent cookie players start a real hand while the shared-seat tab remains attached");

  const actorSeat = hostTwin.view.actingSeatIndex;
  const actorIsHost = actorSeat === hostIdentity.seat;
  const actor = actorIsHost ? hostTwin : guest;
  const observer = actorIsHost ? guest : hostTwin;
  const actorIdentity = { roomId: actor.view.roomId, participantId: actor.view.participantId, seat: actor.view.yourSeatIndex };
  const deadline = Date.parse(actor.view.actionDeadlineAt);
  assert(Number.isFinite(deadline));
  if (actorIsHost) await hostTwin.page.close();
  else await guest.page.close();

  await until(() => observer.view?.seats[actorSeat]?.presence === "disconnected", "last actor tab did not become disconnected");
  const disconnectedRevision = observer.view.revision;
  await until(() => observer.view?.revision > disconnectedRevision && observer.view?.stage === "showdown" && observer.view.lastResultWinners.some(({ seatIndex }) => seatIndex === observer.view.yourSeatIndex), "existing missing-player deadline did not fold the disconnected blind and settle", Math.max(30_000, deadline - Date.now() + 5_000));
  assert(Date.now() >= deadline);
  assert.equal(observer.view.seats[actorSeat].occupied, true);
  assert.equal(observer.view.seats[actorSeat].presence, "disconnected");
  assert.equal(observer.view.actionDeadlineAt, null);
  pass("disconnected small blind remains seated while the existing deadline folds it and settles for the opponent without UI input");

  let guestRestore = guest;
  if (guest.page.isClosed()) guestRestore = await newPage(guestContext, null, null);
  await until(() => guestRestore.view?.roomId === actorIdentity.roomId && guestRestore.view.stage === "showdown", "observer did not retain the timed-out settlement");

  const hostCurrent = hostTwin.page.isClosed() ? null : hostTwin;
  if (hostCurrent) await hostCurrent.page.close();
  await until(() => guestRestore.view?.seats[hostIdentity.seat]?.presence === "disconnected", "last host tab did not clear presence while preserving the seat");
  assert.equal(occupied(guestRestore.view), 2);

  let hostRestore = await newPage(hostContext, null, null);
  await until(() => hostRestore.view?.roomId === hostIdentity.roomId && hostRestore.view?.participantId === hostIdentity.participantId && hostRestore.view?.yourSeatIndex === hostIdentity.seat, "same cookie did not restore the original host member and seat");
  assert.equal(occupied(hostRestore.view), 2);
  const actorRestore = actorIsHost ? hostRestore : guestRestore;
  assert.equal(actorRestore.view.participantId, actorIdentity.participantId);
  assert.equal(actorRestore.view.yourSeatIndex, actorIdentity.seat);
  assert.equal(actorRestore.view.ownCardsHash, createHash("sha256").update("[]").digest("hex"));
  assert.equal(actorRestore.commands, 0);
  pass("same-cookie reload after final-tab disconnect restores the original seat and private view without rejoining or replaying a command");

  assert.deepEqual(pageErrors, []);
} catch (error) {
  const diagnostics = await Promise.all(observed.filter(({ page }) => !page.isClosed()).map(async ({ page, view }) => ({
    state: view && { stage: view.stage, seat: view.yourSeatIndex, revision: view.revision, seats: view.seats.map(({ seatIndex, occupied, presence, ready, lastAction }) => ({ seatIndex, occupied, presence, ready, lastAction })) },
    buttons: await page.getByRole("button").allTextContents().catch(() => []),
    alertVisible: await page.getByRole("alert").count().catch(() => 0) > 0,
  })));
  checks.push({ failure: error.stack ?? String(error), diagnostics });
  process.exitCode = 1;
} finally {
  for (const context of contexts) await context.close().catch(() => undefined);
  await browser.close();
  console.log(JSON.stringify({ checks, pageErrors, scope: "local Texas UI; simulated Chromium only; no private cards, cookies, nicknames, or room codes written" }, null, 2));
}
