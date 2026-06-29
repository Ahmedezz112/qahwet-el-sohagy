"use strict";
/**
 * Pure(ish) game logic for Draw Dominoes (double-six set).
 * All functions mutate / read the `room` object passed in — the server
 * owns the canonical room state, this module just implements the rules.
 */

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function genRoomCode() {
  let s = "";
  for (let i = 0; i < 4; i++) {
    s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return s;
}

function buildDeck() {
  const deck = [];
  for (let a = 0; a <= 6; a++) {
    for (let b = a; b <= 6; b++) {
      deck.push({ id: `${a}-${b}`, a, b });
    }
  }
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pipTotal(hand) {
  return hand.reduce((sum, t) => sum + t.a + t.b, 0);
}

function tilePlayability(room, tile) {
  if (room.board.length === 0) return { left: true, right: false, any: true };
  const leftOk = tile.a === room.leftEnd || tile.b === room.leftEnd;
  const rightOk = tile.a === room.rightEnd || tile.b === room.rightEnd;
  return { left: leftOk, right: rightOk, any: leftOk || rightOk };
}

function handHasPlayable(room, hand) {
  return hand.some((t) => tilePlayability(room, t).any);
}

function findStartingPlayer(players) {
  for (let d = 6; d >= 0; d--) {
    for (let p = 0; p < players.length; p++) {
      const hand = players[p].hand;
      for (let i = 0; i < hand.length; i++) {
        if (hand[i].a === d && hand[i].b === d) return p;
      }
    }
  }
  return 0;
}

function dealAndStart(room) {
  const deck = shuffle(buildDeck());
  const tilesEach = room.players.length === 2 ? 7 : 5;
  room.players.forEach((p) => {
    p.hand = deck.splice(0, tilesEach);
  });
  room.boneyard = deck;
  room.board = [];
  room.leftEnd = null;
  room.rightEnd = null;
  room.passesInRow = 0;
  room.forcedTileId = null;
  room.lastResult = null;
  room.currentIdx = findStartingPlayer(room.players);
  room.phase = "playing";
}

function placeTileInternal(room, tile, side) {
  if (room.board.length === 0) {
    room.board.push({ id: tile.id, left: tile.a, right: tile.b });
    room.leftEnd = tile.a;
    room.rightEnd = tile.b;
    return;
  }
  if (side === "right") {
    const matchVal = tile.a === room.rightEnd ? tile.a : tile.b;
    const otherVal = matchVal === tile.a ? tile.b : tile.a;
    room.board.push({ id: tile.id, left: matchVal, right: otherVal });
    room.rightEnd = otherVal;
  } else {
    const matchVal = tile.a === room.leftEnd ? tile.a : tile.b;
    const otherVal = matchVal === tile.a ? tile.b : tile.a;
    room.board.unshift({ id: tile.id, left: otherVal, right: matchVal });
    room.leftEnd = otherVal;
  }
}

function endRoundByDomino(room, winnerIdx) {
  const winner = room.players[winnerIdx];
  const others = room.players.filter((p) => p !== winner);
  const pts = others.reduce((s, p) => s + pipTotal(p.hand), 0);
  winner.score += pts;
  room.phase = "roundend";
  room.lastResult = {
    title: `${winner.name} went out!`,
    reason: `${winner.name} played their last tile and scores the pips left in everyone else's hand.`,
    winnerName: winner.name
  };
}

function endRoundByBlock(room) {
  const totals = room.players.map((p) => pipTotal(p.hand));
  const minVal = Math.min(...totals);
  const lowest = room.players.filter((p, i) => totals[i] === minVal);
  room.phase = "roundend";
  if (lowest.length > 1) {
    room.lastResult = {
      title: "Blocked — it's a tie",
      reason: "No one can play and the lowest hand pip-count is tied, so no points are awarded this round.",
      winnerName: null
    };
    return;
  }
  const winner = lowest[0];
  const others = room.players.filter((p) => p !== winner);
  let pts = others.reduce((s, p) => s + pipTotal(p.hand), 0) - minVal;
  pts = Math.max(0, pts);
  winner.score += pts;
  room.lastResult = {
    title: `Blocked — ${winner.name} wins the round`,
    reason: `No one could play. ${winner.name} held the lowest pip count and scores the difference.`,
    winnerName: winner.name
  };
}

/** Returns { error } on failure, or { ok:true } on success (mutates room). */
function playTile(room, idx, tileId, side) {
  const hand = room.players[idx].hand;
  const tIndex = hand.findIndex((t) => t.id === tileId);
  if (tIndex === -1) return { error: "That tile isn't in your hand." };
  const tile = hand[tIndex];

  if (room.forcedTileId && room.forcedTileId !== tileId) {
    return { error: "You must play the tile you just drew." };
  }

  const playability = tilePlayability(room, tile);
  if (room.board.length > 0) {
    if (!playability.any) return { error: "That tile doesn't match either end." };
    if (side === "left" && !playability.left) return { error: "That tile can't go on the left end." };
    if (side === "right" && !playability.right) return { error: "That tile can't go on the right end." };
  }

  placeTileInternal(room, tile, room.board.length === 0 ? "right" : side);
  hand.splice(tIndex, 1);
  room.passesInRow = 0;
  room.forcedTileId = null;

  if (hand.length === 0) {
    endRoundByDomino(room, idx);
  } else {
    room.currentIdx = (room.currentIdx + 1) % room.players.length;
  }
  return { ok: true };
}

/** Draw-game rule: keep drawing until a playable tile turns up, or the boneyard runs out. */
function drawOrPass(room, idx) {
  const hand = room.players[idx].hand;

  if (room.boneyard.length === 0) {
    room.passesInRow++;
    if (room.passesInRow >= room.players.length) endRoundByBlock(room);
    else room.currentIdx = (room.currentIdx + 1) % room.players.length;
    return;
  }

  while (room.boneyard.length > 0) {
    const tile = room.boneyard.pop();
    hand.push(tile);
    if (tilePlayability(room, tile).any) {
      room.forcedTileId = tile.id;
      return;
    }
  }

  room.passesInRow++;
  if (room.passesInRow >= room.players.length) endRoundByBlock(room);
  else room.currentIdx = (room.currentIdx + 1) % room.players.length;
}

module.exports = {
  genRoomCode,
  buildDeck,
  shuffle,
  pipTotal,
  tilePlayability,
  handHasPlayable,
  findStartingPlayer,
  dealAndStart,
  playTile,
  drawOrPass
};
