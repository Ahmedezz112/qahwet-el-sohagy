"use strict";

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const game = require("./game");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

/** code -> room object (kept entirely in memory — resets if the server restarts) */
const rooms = {};

function randomToken() {
  return crypto.randomBytes(12).toString("hex");
}

function newRoomCode() {
  let code = game.genRoomCode();
  while (rooms[code]) code = game.genRoomCode();
  return code;
}

/** Builds the payload sent to ONE specific player — only they get their own hand. */
function viewForPlayer(room, playerId) {
  return {
    code: room.code,
    phase: room.phase,
    mode: room.mode,
    targetScore: room.targetScore,
    hostId: room.hostId,
    round: room.round,
    board: room.board,
    leftEnd: room.leftEnd,
    rightEnd: room.rightEnd,
    boneyardCount: room.boneyard.length,
    currentIdx: room.currentIdx,
    forcedTileId: room.forcedTileId,
    lastResult: room.lastResult || null,
    matchResult: room.matchResult || null,
    youAre: playerId,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      colorIdx: p.colorIdx,
      score: p.score,
      connected: p.connected,
      handCount: p.hand.length,
      hand: p.id === playerId ? p.hand : undefined
    }))
  };
}

function broadcastRoom(room) {
  room.players.forEach((p) => {
    if (p.socketId) {
      io.to(p.socketId).emit("state", viewForPlayer(room, p.id));
    }
  });
}

function currentRoom(socket) {
  const code = socket.data.code;
  return code ? rooms[code] : null;
}

function currentPlayerIdx(socket, room) {
  return room.players.findIndex((p) => p.id === socket.data.playerId);
}

/** Pairs mode only makes sense with exactly 4 seats — drop back to singles otherwise. */
function enforceModeValidity(room) {
  if (room.mode === "pairs" && room.players.length !== 4) {
    room.mode = "singles";
  }
}

io.on("connection", (socket) => {
  socket.on("create_room", ({ name }, cb) => {
    name = String(name || "").trim().slice(0, 14) || "Player";
    const code = newRoomCode();
    const playerId = crypto.randomUUID();
    const token = randomToken();

    const room = {
      code,
      phase: "lobby",
      mode: "singles",
      targetScore: 101,
      hostId: playerId,
      round: 1,
      players: [
        { id: playerId, name, colorIdx: 0, hand: [], score: 0, connected: true, socketId: socket.id, token }
      ],
      board: [],
      leftEnd: null,
      rightEnd: null,
      boneyard: [],
      currentIdx: 0,
      passesInRow: 0,
      forcedTileId: null,
      lastResult: null,
      matchResult: null
    };
    rooms[code] = room;
    socket.data.code = code;
    socket.data.playerId = playerId;

    cb({ ok: true, code, playerId, token });
    broadcastRoom(room);
  });

  socket.on("join_room", ({ code, name }, cb) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms[code];
    if (!room) return cb({ ok: false, error: "No room found with that code." });
    if (room.phase !== "lobby") return cb({ ok: false, error: "That game has already started." });
    if (room.players.length >= 4) return cb({ ok: false, error: "That room already has 4 players." });

    name = String(name || "").trim().slice(0, 14) || "Player";
    const playerId = crypto.randomUUID();
    const token = randomToken();
    room.players.push({
      id: playerId, name, colorIdx: room.players.length, hand: [], score: 0,
      connected: true, socketId: socket.id, token
    });
    enforceModeValidity(room);
    socket.data.code = code;
    socket.data.playerId = playerId;

    cb({ ok: true, code, playerId, token });
    broadcastRoom(room);
  });

  socket.on("rejoin", ({ code, playerId, token }, cb) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms[code];
    if (!room) return cb({ ok: false, error: "That room no longer exists." });
    const player = room.players.find((p) => p.id === playerId && p.token === token);
    if (!player) return cb({ ok: false, error: "Couldn't verify your seat in that room." });

    player.connected = true;
    player.socketId = socket.id;
    socket.data.code = code;
    socket.data.playerId = playerId;

    cb({ ok: true, code, playerId, token });
    broadcastRoom(room);
  });

  socket.on("set_mode", ({ mode }) => {
    const room = currentRoom(socket);
    if (!room || room.phase !== "lobby") return;
    if (room.hostId !== socket.data.playerId) return;
    if (mode !== "singles" && mode !== "pairs") return;
    if (mode === "pairs" && room.players.length !== 4) {
      io.to(socket.id).emit("action_error", "Pairs mode needs exactly 4 players in the room.");
      return;
    }
    room.mode = mode;
    broadcastRoom(room);
  });

  socket.on("set_target_score", ({ targetScore }) => {
    const room = currentRoom(socket);
    if (!room || room.phase !== "lobby") return;
    if (room.hostId !== socket.data.playerId) return;
    if (!game.VALID_TARGET_SCORES.includes(targetScore)) return;
    room.targetScore = targetScore;
    broadcastRoom(room);
  });

  socket.on("start_game", () => {
    const room = currentRoom(socket);
    if (!room) return;
    if (room.hostId !== socket.data.playerId) return;
    if (room.players.length < 2 || room.players.length > 4) return;
    if (room.mode === "pairs" && room.players.length !== 4) {
      io.to(socket.id).emit("action_error", "Pairs mode needs exactly 4 players in the room.");
      return;
    }
    game.dealAndStart(room);
    broadcastRoom(room);
  });

  socket.on("play_tile", ({ tileId, side }) => {
    const room = currentRoom(socket);
    if (!room || room.phase !== "playing") return;
    const idx = currentPlayerIdx(socket, room);
    if (idx === -1 || idx !== room.currentIdx) return;

    const result = game.playTile(room, idx, tileId, side);
    if (result.error) {
      io.to(socket.id).emit("action_error", result.error);
      return;
    }
    broadcastRoom(room);
  });

  socket.on("draw_or_pass", () => {
    const room = currentRoom(socket);
    if (!room || room.phase !== "playing") return;
    const idx = currentPlayerIdx(socket, room);
    if (idx === -1 || idx !== room.currentIdx) return;
    game.drawOrPass(room, idx);
    broadcastRoom(room);
  });

  socket.on("next_round", () => {
    const room = currentRoom(socket);
    if (!room || room.phase !== "roundend") return;
    if (room.hostId !== socket.data.playerId) return;
    room.round++;
    game.dealAndStart(room);
    broadcastRoom(room);
  });

  socket.on("new_match", () => {
    const room = currentRoom(socket);
    if (!room || room.phase !== "roundend") return;
    if (room.hostId !== socket.data.playerId) return;
    room.players.forEach((p) => (p.score = 0));
    room.round = 1;
    game.dealAndStart(room);
    broadcastRoom(room);
  });

  socket.on("play_again", () => {
    const room = currentRoom(socket);
    if (!room || room.phase !== "matchend") return;
    if (room.hostId !== socket.data.playerId) return;
    room.players.forEach((p) => (p.score = 0));
    room.round = 1;
    room.matchResult = null;
    room.lastResult = null;
    room.phase = "lobby";
    broadcastRoom(room);
  });

  socket.on("leave_room", () => {
    const room = currentRoom(socket);
    if (!room) return;
    const idx = currentPlayerIdx(socket, room);
    if (idx === -1) return;

    if (room.phase === "lobby") {
      room.players.splice(idx, 1);
      if (room.players.length === 0) {
        delete rooms[room.code];
        return;
      }
      if (room.hostId === socket.data.playerId) {
        room.hostId = room.players[0].id;
      }
      enforceModeValidity(room);
      broadcastRoom(room);
    } else {
      room.players[idx].connected = false;
      room.players[idx].socketId = null;
      broadcastRoom(room);
    }
    socket.data.code = null;
    socket.data.playerId = null;
  });

  socket.on("disconnect", () => {
    const room = currentRoom(socket);
    if (!room) return;
    const player = room.players.find((p) => p.socketId === socket.id);
    if (player) {
      player.connected = false;
      player.socketId = null;
      broadcastRoom(room);
    }
  });
});

// Periodic cleanup: drop empty / long-abandoned rooms so memory doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  Object.keys(rooms).forEach((code) => {
    const room = rooms[code];
    const anyoneConnected = room.players.some((p) => p.connected);
    if (!anyoneConnected) {
      room._emptySince = room._emptySince || now;
      if (now - room._emptySince > 30 * 60 * 1000) delete rooms[code];
    } else {
      room._emptySince = null;
    }
  });
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Dominoes server listening on http://localhost:${PORT}`);
});
