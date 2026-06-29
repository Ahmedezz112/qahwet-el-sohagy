# Dominoes — Backend

A real-time, multiplayer Dominoes server (double-six set, draw rules). The
server is authoritative: it deals the tiles, validates every move, and only
ever sends each player their *own* hand — opponents only ever see a tile
count, not the actual tiles. Players can refresh their browser mid-game and
automatically reconnect to their same seat.

## What's inside

```
dominoes-backend/
  server.js            Socket.io server — owns all room/game state in memory
  game.js              Pure game-rule functions (deal, play, draw, scoring)
  public/index.html    The frontend (single file, talks to the server over websockets)
  test_integration.js  Optional: automated 2-player test that plays a full round
  package.json
```

## Running it locally

```
npm install
npm start
```

Then open **http://localhost:3001** in a browser. Open it in a second tab
(or send the room code to a friend on another device on the same network/
internet) to play against someone else.

To run the automated test (spins up the server, simulates two players
through a full round, checks hands stay hidden):

```
npm install socket.io-client --save-dev   # only needed once, for the test
node test_integration.js
```

## How it works

- **Rooms**: `create_room` generates a 4-letter code and makes you the host.
  `join_room` with that code adds you to the lobby (max 4 players). The host
  starts the game once 2–4 people have joined.
- **State**: everything (whose turn it is, the board, the boneyard count,
  scores) lives in memory on the server, keyed by room code. There's no
  database — if you restart the server, all rooms are lost. That's fine for
  casual games; see "Adding persistence" below if you want games to survive
  restarts.
- **Hidden hands**: the server builds a *different* payload for each
  connected player — you get your own tiles, everyone else just gets a tile
  count. This is enforced server-side, not just hidden in the UI, so there's
  no devtools trick to peek at someone else's hand.
- **Reconnecting**: when you create or join a room, the browser stores a
  small `{code, playerId, token}` session in `localStorage`. If your tab
  reloads or drops connection, it automatically tries to "rejoin" with that
  token and gets reattached to the same seat.
- **Rules implemented**: standard draw dominoes — 7 tiles each for 2 players,
  5 tiles each for 3–4 players. If you can't play, you draw from the
  boneyard until you get a playable tile (and must play it) or the boneyard
  runs out (turn passes). Round ends when someone empties their hand (they
  score everyone else's remaining pips) or the table is blocked (lowest hand
  wins the round, scoring the difference).

## Deploying it so people can actually join from anywhere

This is a normal Node.js + WebSocket app, so it runs on most hosts that keep
a server process alive (i.e. **not** static-site hosts, and not classic
serverless functions, which don't support persistent WebSocket connections).

A few solid free/cheap options:

**Render.com** (probably the easiest)
1. Push this folder to a GitHub repo.
2. On Render, "New Web Service" → connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Render gives you a public URL — share that, not `localhost`.

**Railway.app**
1. Push to GitHub, then "New Project" → "Deploy from GitHub repo".
2. Railway auto-detects Node and runs `npm start`. It assigns a public URL.

**Fly.io**
1. `fly launch` in this folder (it'll detect Node and generate a Dockerfile).
2. `fly deploy`.

**Your own VPS**
1. Copy the folder over, `npm install`, then run it with a process manager
   so it survives reboots/crashes, e.g. `pm2 start server.js` or a systemd
   service.
2. Put it behind nginx/Caddy for HTTPS if you want a real domain.

Whichever you pick, the only thing to double check is that the platform
supports long-lived WebSocket connections (Render, Railway, Fly, and a VPS
all do; classic "serverless functions" platforms generally don't).

## Adding persistence later (optional)

Right now everything is in a plain JS object in memory (`rooms` in
`server.js`). If you want rooms to survive a server restart, or to scale to
multiple server instances, the natural next step is swapping that in-memory
object for Redis (cheap, fast, and a natural fit for ephemeral game state
like this). Happy to help with that when you're ready — it's a fairly small
change since all the room-mutation logic is already isolated in `game.js`.
