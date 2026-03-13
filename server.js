/**
 * Basket Dudes — WebSocket Server
 * Replaces Supabase for: signaling (WebRTC), ranked matchmaking, auth, stats
 *
 * Install:  npm install ws
 * Run:      node server.js
 * Default port: 8765  (set env PORT to override)
 *
 * Data is stored in ./bd_data.json  (auto-created, persisted across restarts)
 */

const http = require('http');
const { WebSocketServer } = require('ws');
const fs   = require('fs');
const path = require('path');

const PORT      = process.env.PORT || 8765;
const DATA_FILE = path.join(__dirname, 'bd_data.json');

// ── Persistent data ────────────────────────────────────────────────────────
function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch(_) { return { players: {}, stats: {} }; }
}
function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}
let db = loadData();
// db.players  = { username_lower: { username, password_hash, created } }
// db.stats    = { username_lower: { xp, points, ... rankTier, rankDiv, ... } }

function blankStats() {
  return { xp:0, points:0, rebounds:0, assists:0, steals:0, blocks:0,
           gamesPlayed:0, wins:0, secondsPlayed:0,
           rankTier:0, rankDiv:0, rankBars:0, rankWinStreak:0 };
}
function getStats(key) {
  if (!db.stats[key]) db.stats[key] = blankStats();
  return db.stats[key];
}

// ── In-memory state ────────────────────────────────────────────────────────
// Signal rooms: roomCode → { host: ws, guests: Map<clientId, ws> }
const signalRooms = new Map();

// Ranked queue: username_lower → { username, rankTier, roomCode, queuedAt, ws }
const rankedQueue = new Map();

// ── WebSocket server ───────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Basket Dudes WS Server\n');
});

const wss = new WebSocketServer({ server });

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

wss.on('connection', ws => {
  ws._rooms = new Set(); // rooms this socket is in (for cleanup)
  ws._queueKey = null;   // ranked queue key for cleanup

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch(_) { return; }

    const { type } = msg;

    // ── AUTH ──────────────────────────────────────────────────────────────
    if (type === 'auth_register') {
      const key = (msg.username||'').toLowerCase().trim();
      const user = (msg.username||'').trim();
      const ph   = msg.password_hash;
      if (!key || key.length < 2) return send(ws, { type:'auth_error', msg:'Username must be 2+ chars.' });
      if (!ph)                    return send(ws, { type:'auth_error', msg:'Password required.' });
      if (db.players[key])        return send(ws, { type:'auth_error', msg:'Username already taken.' });
      db.players[key] = { username: user, password_hash: ph, created: Date.now() };
      db.stats[key]   = blankStats();
      saveData();
      send(ws, { type:'auth_ok', username: user, stats: db.stats[key] });
    }

    else if (type === 'auth_login') {
      const key = (msg.username||'').toLowerCase().trim();
      const ph  = msg.password_hash;
      const p   = db.players[key];
      if (!p)             return send(ws, { type:'auth_error', msg:'Account not found.' });
      if (p.password_hash !== ph) return send(ws, { type:'auth_error', msg:'Wrong password.' });
      send(ws, { type:'auth_ok', username: p.username, stats: getStats(key) });
    }

    else if (type === 'stats_save') {
      // msg: { username_lower, delta: {points,rebounds,...,xp}, rankTier, rankDiv, rankBars, rankWinStreak, won }
      const key = (msg.username_lower||'').toLowerCase();
      if (!db.players[key]) return;
      const s = getStats(key);
      const d = msg.delta || {};
      s.points       += d.points||0;
      s.rebounds     += d.rebounds||0;
      s.assists      += d.assists||0;
      s.steals       += d.steals||0;
      s.blocks       += d.blocks||0;
      s.xp           += d.xp||0;
      s.secondsPlayed+= d.secondsPlayed||0;
      s.gamesPlayed  += 1;
      if (msg.won) s.wins = (s.wins||0) + 1;
      // Rank comes authoritative from client (client already computed it)
      s.rankTier       = msg.rankTier      ?? s.rankTier;
      s.rankDiv        = msg.rankDiv       ?? s.rankDiv;
      s.rankBars       = msg.rankBars      ?? s.rankBars;
      s.rankWinStreak  = msg.rankWinStreak ?? s.rankWinStreak;
      db.stats[key] = s;
      saveData();
      send(ws, { type:'stats_saved', stats: s });
    }

    // ── SIGNAL (WebRTC signaling relay) ───────────────────────────────────
    else if (type === 'signal_join') {
      // msg: { roomCode, clientId, role:'host'|'guest' }
      const { roomCode, clientId, role } = msg;
      if (!signalRooms.has(roomCode)) signalRooms.set(roomCode, { host: null, guests: new Map() });
      const room = signalRooms.get(roomCode);
      ws._rooms.add(roomCode);
      ws._clientId = clientId;
      ws._signalRole = role;
      if (role === 'host') {
        room.host = ws;
      } else {
        room.guests.set(clientId, ws);
      }
      send(ws, { type:'signal_ready', roomCode, clientId });
    }

    else if (type === 'signal_send') {
      // msg: { roomCode, payload } — payload is the original sig object
      const room = signalRooms.get(msg.roomCode);
      if (!room) return;
      const payload = msg.payload;
      const sigType = payload && payload.type;

      if (sigType === 'join' || sigType === 'offer' || sigType === 'answer' ||
          sigType === 'ice'  || sigType === 'full') {
        // Route: join/answer/ice-from-guest → host
        //        offer/ice-from-host/full → specific guest
        const toHost = (sigType === 'join') ||
                       (sigType === 'answer') ||
                       (sigType === 'ice' && payload.from === 'guest');
        if (toHost) {
          if (room.host) send(room.host, { type:'signal_msg', payload });
        } else {
          // to specific guest (forGuest field) or broadcast all guests
          const targetId = payload.forGuest;
          if (targetId) {
            const gws = room.guests.get(targetId);
            if (gws) send(gws, { type:'signal_msg', payload });
          } else {
            room.guests.forEach(gws => send(gws, { type:'signal_msg', payload }));
          }
        }
      }
    }

    else if (type === 'signal_leave') {
      cleanupSignal(ws, msg.roomCode);
    }

    // ── RANKED QUEUE ──────────────────────────────────────────────────────
    else if (type === 'ranked_join') {
      // msg: { username, username_lower, rankTier, roomCode }
      const key = msg.username_lower;
      if (!key) return;
      // Remove stale entry if any
      rankedQueue.delete(key);
      ws._queueKey = key;
      rankedQueue.set(key, {
        username:  msg.username,
        rankTier:  msg.rankTier || 0,
        roomCode:  msg.roomCode,
        queuedAt:  Date.now(),
        ws
      });
      send(ws, { type:'ranked_queued' });
      console.log(`[RANKED] ${msg.username} joined queue. Queue size: ${rankedQueue.size}`);
      // Try to match
      tryRankedMatch();
    }

    else if (type === 'ranked_leave') {
      const key = ws._queueKey || msg.username_lower;
      if (key) rankedQueue.delete(key);
      ws._queueKey = null;
      send(ws, { type:'ranked_left' });
    }

  }); // end ws.on message

  ws.on('close', () => {
    // Clean up signal rooms
    ws._rooms && ws._rooms.forEach(roomCode => cleanupSignal(ws, roomCode));
    // Clean up ranked queue
    if (ws._queueKey) rankedQueue.delete(ws._queueKey);
  });
});

function cleanupSignal(ws, roomCode) {
  const room = signalRooms.get(roomCode);
  if (!room) return;
  if (room.host === ws) room.host = null;
  if (ws._clientId) room.guests.delete(ws._clientId);
  if (!room.host && room.guests.size === 0) signalRooms.delete(roomCode);
}

function tryRankedMatch() {
  const now = Date.now();
  // Remove stale entries (> 90 seconds old)
  for (const [k, e] of rankedQueue) {
    if (now - e.queuedAt > 90000) rankedQueue.delete(k);
  }
  if (rankedQueue.size < 2) return;

  // Pick two oldest entries
  const entries = [...rankedQueue.values()].sort((a,b) => a.queuedAt - b.queuedAt);
  const [e1, e2] = entries; // e1 is oldest → becomes host

  rankedQueue.delete(e1.username.toLowerCase());
  rankedQueue.delete(e2.username.toLowerCase());
  if (e1.ws) e1.ws._queueKey = null;
  if (e2.ws) e2.ws._queueKey = null;

  const roomCode = e1.roomCode; // host's pre-generated code

  console.log(`[RANKED] Match: ${e1.username} (host) vs ${e2.username} (guest) room=${roomCode}`);

  send(e1.ws, { type:'ranked_matched', role:'host',  roomCode, opponentName: e2.username });
  send(e2.ws, { type:'ranked_matched', role:'guest', roomCode, opponentName: e1.username });
}

server.listen(PORT, () => console.log(`Basket Dudes WS server listening on ws://localhost:${PORT}`));
