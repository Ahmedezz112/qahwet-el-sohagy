"use strict";
// One-off integration test: spins up the real server, connects two fake
// clients via socket.io-client, and plays moves until a round ends.
const { spawn } = require("child_process");
const { io } = require("socket.io-client");

const PORT = 3911;
const server = spawn("node", ["server.js"], {
  cwd: __dirname,
  env: Object.assign({}, process.env, { PORT: String(PORT) }),
  stdio: ["ignore", "pipe", "pipe"]
});

let serverReady = false;
server.stdout.on("data", (d) => {
  if (d.toString().includes("listening")) serverReady = true;
});
server.stderr.on("data", (d) => console.error("[server]", d.toString()));

function fail(msg) {
  console.error("TEST FAILED:", msg);
  server.kill();
  process.exit(1);
}

function waitFor(cond, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (cond()) { clearInterval(iv); resolve(); }
      else if (Date.now() - start > timeoutMs) { clearInterval(iv); reject(new Error("Timeout waiting for: " + label)); }
    }, 50);
  });
}

async function main() {
  await waitFor(() => serverReady, 5000, "server start");

  const url = `http://localhost:${PORT}`;
  const a = io(url, { transports: ["websocket"] });
  const b = io(url, { transports: ["websocket"] });

  let stateA = null, stateB = null;
  a.on("state", (s) => { stateA = s; });
  b.on("state", (s) => { stateB = s; });
  a.on("action_error", (m) => console.log("[A action_error]", m));
  b.on("action_error", (m) => console.log("[B action_error]", m));

  await new Promise((res) => a.on("connect", res));
  await new Promise((res) => b.on("connect", res));

  // --- Create + join ---
  const createRes = await new Promise((res) => a.emit("create_room", { name: "Alice" }, res));
  if (!createRes.ok) fail("create_room failed: " + createRes.error);
  const code = createRes.code;
  console.log("Room created:", code);

  const joinRes = await new Promise((res) => b.emit("join_room", { code, name: "Bob" }, res));
  if (!joinRes.ok) fail("join_room failed: " + joinRes.error);
  console.log("Bob joined.");

  await waitFor(() => stateA && stateA.players.length === 2, 2000, "both players visible to A");
  if (stateA.phase !== "lobby") fail("expected lobby phase");
  console.log("Lobby OK. Players:", stateA.players.map((p) => p.name));

  // --- Start game (host = Alice) ---
  a.emit("start_game");
  await waitFor(() => stateA && stateA.phase === "playing", 2000, "game start");
  console.log("Game started. Round", stateA.round, "Boneyard:", stateA.boneyardCount);

  const handCountA = stateA.players.find((p) => p.id === createRes.playerId).hand.length;
  const handCountB = stateB.players.find((p) => p.id === joinRes.playerId).hand.length;
  console.log("Hand sizes — A:", handCountA, "B:", handCountB);
  if (handCountA !== 7 || handCountB !== 7) fail("expected 7 tiles each for 2-player game");

  // Confirm hidden hands: A's view of B should NOT include B's hand
  const bAsSeenByA = stateA.players.find((p) => p.id === joinRes.playerId);
  if (bAsSeenByA.hand !== undefined) fail("SECURITY BUG: A can see B's hand!");
  console.log("Hand secrecy verified — A cannot see B's tiles.");

  // --- Play through the round automatically until it ends ---
  let rounds = 0;
  while (stateA.phase === "playing" && rounds < 400) {
    rounds++;
    const turnSocket = (stateA.currentIdx === 0) ? a : b;
    const turnState = (stateA.currentIdx === 0) ? stateA : stateB;
    const myIdx = stateA.currentIdx;
    const me = turnState.players[myIdx];
    const hand = me.hand;

    function playable(t) {
      if (turnState.board.length === 0) return true;
      return t.a === turnState.leftEnd || t.b === turnState.leftEnd || t.a === turnState.rightEnd || t.b === turnState.rightEnd;
    }

    const forced = turnState.forcedTileId;
    let toPlay = forced ? hand.find((t) => t.id === forced) : hand.find(playable);

    if (toPlay) {
      let side = "right";
      if (turnState.board.length > 0) {
        const leftOk = toPlay.a === turnState.leftEnd || toPlay.b === turnState.leftEnd;
        side = leftOk ? "left" : "right";
      }
      turnSocket.emit("play_tile", { tileId: toPlay.id, side });
    } else {
      turnSocket.emit("draw_or_pass");
    }

    const prevIdx = stateA.currentIdx;
    const prevPhase = stateA.phase;
    await waitFor(() => stateA && (stateA.currentIdx !== prevIdx || stateA.phase !== prevPhase || stateA.forcedTileId), 2000, "turn to progress");
  }

  if (stateA.phase !== "roundend") fail("round never ended after " + rounds + " actions");
  console.log("Round ended after", rounds, "actions. Result:", stateA.lastResult);
  console.log("Final scores:", stateA.players.map((p) => p.name + ":" + p.score));

  console.log("\nALL TESTS PASSED");
  a.close(); b.close();
  server.kill();
  process.exit(0);
}

main().catch((e) => fail(e.message));
