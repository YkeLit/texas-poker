import { readFile } from "node:fs/promises";
import { io } from "socket.io-client";

const origin = process.env.TEST_ORIGIN ?? "http://127.0.0.1:3001";
const browserOrigin = process.env.TEST_BROWSER_ORIGIN ?? "http://127.0.0.1:5173";
const state = JSON.parse(await readFile(process.env.TEST_STATE_FILE ?? "/tmp/texas-poker-restart-state.json", "utf8"));
const socket = io(origin, { transports: ["websocket"], extraHeaders: { Cookie: state.cookie, Origin: browserOrigin } });
let latest;
const waitFor = (predicate, timeoutMs = 40_000) => new Promise((resolve, reject) => {
  if (latest && predicate(latest)) return resolve(latest);
  const timer = setTimeout(() => reject(new Error("restart snapshot timeout")), timeoutMs);
  const listener = (snapshot) => {
    latest = snapshot;
    if (!predicate(snapshot)) return;
    clearTimeout(timer);
    socket.off("state.snapshot", listener);
    resolve(snapshot);
  };
  socket.on("state.snapshot", listener);
});
const attached = socket.emitWithAck("room.attach", { roomId: state.roomId });
const restored = await waitFor((snapshot) => snapshot.roomId === state.roomId);
const result = await attached;
if (!result.ok) throw new Error(JSON.stringify(result));
if (restored.roomCode !== state.roomCode || JSON.stringify(restored.yourHoleCards) !== JSON.stringify(state.holeCards)) throw new Error("restored room state changed");
const afterTimer = await waitFor((snapshot) => snapshot.revision > state.revision);
console.log(JSON.stringify({ roomId: restored.roomId, roomCode: restored.roomCode, restoredRevision: restored.revision, timerRevision: afterTimer.revision, privateCardsRestored: restored.yourHoleCards.length }));
socket.disconnect();
