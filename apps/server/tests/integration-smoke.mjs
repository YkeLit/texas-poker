import { io } from "socket.io-client";
import { writeFile } from "node:fs/promises";

const origin = process.env.TEST_ORIGIN ?? "http://127.0.0.1:3001";
const browserOrigin = process.env.TEST_BROWSER_ORIGIN ?? "http://127.0.0.1:5173";
const config = { maxPlayers: 9, startingStack: 1000, smallBlind: 10, bigBlind: 20, actionTimeSeconds: Number(process.env.TEST_ACTION_SECONDS ?? (process.env.TEST_RESTART_PREP === "true" ? 120 : 5)), rebuyCooldownHands: 2 };

async function post(path, payload) {
  const response = await fetch(origin + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return { body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
}

function openSocket(cookie) {
  const socket = io(origin, {
    transports: ["websocket"],
    extraHeaders: { Cookie: cookie, Origin: browserOrigin },
  });
  let latest;
  const waiters = [];
  socket.on("state.snapshot", (snapshot) => {
    latest = snapshot;
    for (const waiter of [...waiters]) {
      if (waiter.predicate(snapshot)) {
        clearTimeout(waiter.timer);
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(snapshot);
      }
    }
  });
  const waitFor = (predicate, timeoutMs = 8_000) => {
    if (latest && predicate(latest)) return Promise.resolve(latest);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => reject(new Error("snapshot timeout")), timeoutMs),
      };
      waiters.push(waiter);
    });
  };
  return { socket, waitFor, latest: () => latest };
}

async function attach(client, roomId) {
  const result = await client.socket.emitWithAck("room.attach", { roomId });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return client.waitFor((snapshot) => snapshot.roomId === roomId);
}

async function command(client, type, payload = {}) {
  const snapshot = client.latest();
  const response = await client.socket.emitWithAck("command", {
    protocolVersion: 1,
    requestId: crypto.randomUUID(),
    roomId: snapshot.roomId,
    expectedRevision: snapshot.revision,
    type,
    payload,
  });
  if (!response.ok && response.error?.code === "STALE_REVISION") {
    await client.waitFor((next) => next.revision >= Number(response.error.details?.currentRevision ?? response.revision));
    return command(client, type, payload);
  }
  if (!response.ok) throw new Error(`${type}: ${JSON.stringify(response.error)}`);
  return client.waitFor((next) => next.revision >= response.revision);
}

const hostCreated = await post("/api/v1/rooms", { nickname: "房主", config });
const guestJoined = await post("/api/v1/rooms/join", { nickname: "玩家二", roomCode: hostCreated.body.roomCode });
if (!hostCreated.cookie?.startsWith("__Host-texas-poker_guest=") || !guestJoined.cookie) throw new Error("secure guest cookie missing");

const host = openSocket(hostCreated.cookie);
const guest = openSocket(guestJoined.cookie);
await Promise.all([attach(host, hostCreated.body.roomId), attach(guest, hostCreated.body.roomId)]);
await command(host, "seat.take", { seatIndex: 0 });
await command(guest, "seat.take", { seatIndex: 1 });
await command(host, "player.ready");
await command(guest, "player.ready");
await command(host, "chat.send", { content: "归档验证" });
const started = await command(host, "hand.start");
const guestStarted = await guest.waitFor((snapshot) => snapshot.revision >= started.revision);
if (started.yourHoleCards.length !== 2 || guestStarted.yourHoleCards.length !== 2) throw new Error("private cards missing");
if (JSON.stringify(started.yourHoleCards) === JSON.stringify(guestStarted.yourHoleCards)) throw new Error("viewers received the same private cards");
if (started.seats[1].player.holeCardCount !== 2 || "holeCards" in started.seats[1].player) throw new Error("opponent cards leaked");

const hostSecondTab = openSocket(hostCreated.cookie);
await attach(hostSecondTab, hostCreated.body.roomId);
host.socket.disconnect();
await hostSecondTab.waitFor((snapshot) => snapshot.seats[0].player.presence === "connected");

if (process.env.TEST_RESTART_PREP === "true") {
  const stateFile = process.env.TEST_STATE_FILE ?? "/tmp/texas-poker-restart-state.json";
  await writeFile(stateFile, JSON.stringify({
    roomId: hostCreated.body.roomId,
    roomCode: hostCreated.body.roomCode,
    cookie: hostCreated.cookie,
    revision: hostSecondTab.latest().revision,
    holeCards: hostSecondTab.latest().yourHoleCards,
  }));
  console.log(JSON.stringify({ restartPrepared: true, roomId: hostCreated.body.roomId, stateFile }));
  hostSecondTab.socket.disconnect();
  guest.socket.disconnect();
  process.exit(0);
}

const revisionBeforeTimeout = hostSecondTab.latest().revision;
guest.socket.disconnect();
await hostSecondTab.waitFor((snapshot) => snapshot.seats[1].player.presence === "disconnected");
const afterTimeout = await hostSecondTab.waitFor((snapshot) => snapshot.revision > revisionBeforeTimeout, 10_000);

console.log(JSON.stringify({
  roomId: hostCreated.body.roomId,
  roomCode: hostCreated.body.roomCode,
  revision: afterTimeout.revision,
  stage: afterTimeout.stage,
  actionDeadlineAt: afterTimeout.actionDeadlineAt,
  privateCards: started.yourHoleCards.length,
  opponentPresence: afterTimeout.seats[1].player.presence,
  localIdentityStorage: "cookie-only",
}));

hostSecondTab.socket.disconnect();
