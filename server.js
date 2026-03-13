// BasketDudes WebSocket Server
// Handles: auth, stats, ranked matchmaking, AND full game relay (no WebRTC needed)

const WebSocket = require('ws');
const fs  = require('fs');
const path = require('path');

const PORT      = process.env.PORT || 8765;
const DATA_FILE = path.join(__dirname, 'bd_data.json');

// ── Persistent storage ────────────────────────────────────────────────────
function loadData() {
    try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
    catch(e) { return { players: {} }; }
}
function saveData(d) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
}

// ── In-memory state ───────────────────────────────────────────────────────
var db          = loadData();
var clients     = new Map();   // ws → { id, username_lower, roomCode, clientId, role }
var relayRooms  = new Map();   // roomCode → { host: ws, guests: Map<clientId, ws>, signalHandlers: Map }
var rankedQueue = [];          // [{ ws, username, username_lower, rankTier, roomCode, queuedAt }]

var idSeq = 0;
function uid() { return ++idSeq; }

const wss = new WebSocket.Server({ port: PORT });
console.log(`[BD] WebSocket server listening on port ${PORT}`);

wss.on('connection', function(ws) {
    var info = { id: uid(), username_lower: null, roomCode: null, clientId: null, role: null };
    clients.set(ws, info);

    ws.on('message', function(raw) {
        var msg;
        try { msg = JSON.parse(raw); } catch(e) { return; }
        try { handle(ws, info, msg); } catch(e) { console.error('[BD] handler error:', e); }
    });

    ws.on('close', function() {
        // Leave any relay room
        leaveRelayRoom(ws, info);
        // Remove from ranked queue
        rankedQueue = rankedQueue.filter(function(e){ return e.ws !== ws; });
        clients.delete(ws);
    });

    ws.on('error', function(){});
});

function send(ws, obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ── Message router ────────────────────────────────────────────────────────
function handle(ws, info, msg) {
    switch (msg.type) {

    // ── Auth ──────────────────────────────────────────────────────────────
    case 'auth_register': {
        var key = (msg.username||'').toLowerCase();
        if (!key || key.length < 2) { send(ws,{type:'auth_error',msg:'Username too short'}); return; }
        if (db.players[key]) { send(ws,{type:'auth_error',msg:'Username already taken'}); return; }
        db.players[key] = { username: msg.username, password_hash: msg.password_hash,
                             stats: blankStats(), created: Date.now() };
        saveData(db);
        info.username_lower = key;
        send(ws, { type:'auth_ok', username:msg.username, stats:db.players[key].stats });
        break;
    }
    case 'auth_login': {
        var key = (msg.username||'').toLowerCase();
        var p   = db.players[key];
        if (!p) { send(ws,{type:'auth_error',msg:'Account not found'}); return; }
        if (p.password_hash !== msg.password_hash) { send(ws,{type:'auth_error',msg:'Wrong password'}); return; }
        info.username_lower = key;
        send(ws, { type:'auth_ok', username:p.username, stats:p.stats });
        break;
    }

    // ── Stats ─────────────────────────────────────────────────────────────
    case 'stats_save': {
        var key = msg.username_lower;
        if (!key || !db.players[key]) return;
        var s = db.players[key].stats, d = msg.delta||{};
        s.points       = (s.points||0)       + (d.points||0);
        s.rebounds     = (s.rebounds||0)     + (d.rebounds||0);
        s.assists      = (s.assists||0)      + (d.assists||0);
        s.steals       = (s.steals||0)       + (d.steals||0);
        s.blocks       = (s.blocks||0)       + (d.blocks||0);
        s.xp           = (s.xp||0)           + (d.xp||0);
        s.secondsPlayed= (s.secondsPlayed||0)+ (d.secondsPlayed||0);
        s.gamesPlayed  = (s.gamesPlayed||0)  + 1;
        if (msg.won) s.wins = (s.wins||0) + 1;
        s.rankTier     = msg.rankTier  || s.rankTier  || 0;
        s.rankDiv      = msg.rankDiv   || s.rankDiv   || 0;
        s.rankBars     = msg.rankBars  || s.rankBars  || 0;
        s.rankWinStreak= msg.rankWinStreak || s.rankWinStreak || 0;
        saveData(db);
        send(ws, { type:'stats_saved', stats:s });
        break;
    }

    // ── Relay room: join ──────────────────────────────────────────────────
    case 'relay_join': {
        var roomCode = msg.roomCode, clientId = msg.clientId, role = msg.role;
        info.roomCode = roomCode; info.clientId = clientId; info.role = role;
        if (!relayRooms.has(roomCode)) relayRooms.set(roomCode, { host:null, guests:new Map() });
        var room = relayRooms.get(roomCode);
        if (role === 'host') room.host = ws;
        else room.guests.set(clientId, ws);
        send(ws, { type:'relay_joined', roomCode:roomCode, clientId:clientId });
        break;
    }

    // ── Relay room: leave ────────────────────────────────────────────────
    case 'relay_leave': {
        leaveRelayRoom(ws, info);
        break;
    }

    // ── Relay signal: host↔guest handshake (join/full/etc) ───────────────
    case 'relay_signal': {
        var roomCode = msg.roomCode, payload = msg.payload;
        var room = relayRooms.get(roomCode);
        if (!room) return;
        // Determine direction: use info.role, fallback to payload._from prefix
        var senderRole = info.role;
        if (!senderRole && payload && payload._from) {
            senderRole = payload._from.startsWith('host_') ? 'host' : 'guest';
        }
        if (senderRole === 'host') {
            // Host → specific guest or all guests
            var targetId = payload.forGuest;
            if (targetId) {
                var gws = room.guests.get(targetId);
                if (gws) send(gws, { type:'relay_msg', roomCode:roomCode, payload:payload });
            } else {
                room.guests.forEach(function(gws){ send(gws, { type:'relay_msg', roomCode:roomCode, payload:payload }); });
            }
        } else {
            // Guest → host
            if (room.host) send(room.host, { type:'relay_msg', roomCode:roomCode, payload:payload });
        }
        break;
    }

    // ── Relay game data ───────────────────────────────────────────────────
    case 'relay_game': {
        var roomCode = msg.roomCode;
        var room = relayRooms.get(roomCode);
        if (!room) return;
        if (msg.role === 'host') {
            // Host → specific guest or broadcast to all
            if (msg.forGuest) {
                var gws = room.guests.get(msg.forGuest);
                if (gws) send(gws, msg);
            } else {
                room.guests.forEach(function(gws){ send(gws, msg); });
            }
        } else {
            // Guest → host
            if (room.host) send(room.host, msg);
        }
        break;
    }

    // ── Ranked matchmaking ────────────────────────────────────────────────
    case 'ranked_join': {
        // Remove stale entry for this user if any
        rankedQueue = rankedQueue.filter(function(e){ return e.username_lower !== msg.username_lower; });
        rankedQueue.push({ ws:ws, username:msg.username, username_lower:msg.username_lower,
                           rankTier:msg.rankTier||0, roomCode:msg.roomCode, queuedAt:Date.now() });
        send(ws, { type:'ranked_queued' });
        tryMatchRanked();
        break;
    }
    case 'ranked_leave': {
        rankedQueue = rankedQueue.filter(function(e){ return e.username_lower !== msg.username_lower; });
        send(ws, { type:'ranked_left' });
        break;
    }

    } // end switch
}

function leaveRelayRoom(ws, info) {
    if (!info.roomCode) return;
    var room = relayRooms.get(info.roomCode);
    if (room) {
        if (info.role === 'host') room.host = null;
        else if (info.clientId) room.guests.delete(info.clientId);
        // Clean up empty rooms
        if (!room.host && room.guests.size === 0) relayRooms.delete(info.roomCode);
    }
    info.roomCode = null; info.clientId = null; info.role = null;
}

function tryMatchRanked() {
    // Prune stale entries (>90s)
    var cutoff = Date.now() - 90000;
    rankedQueue = rankedQueue.filter(function(e){
        return e.ws.readyState === WebSocket.OPEN && e.queuedAt > cutoff;
    });
    if (rankedQueue.length < 2) return;
    // Match oldest two
    var a = rankedQueue.shift(), b = rankedQueue.shift();
    // First-queued is host
    send(a.ws, { type:'ranked_matched', role:'host', roomCode:a.roomCode, opponentName:b.username });
    send(b.ws, { type:'ranked_matched', role:'guest', roomCode:a.roomCode, opponentName:a.username });
}

function blankStats() {
    return { points:0, rebounds:0, assists:0, steals:0, blocks:0, secondsPlayed:0,
             gamesPlayed:0, wins:0, xp:0, rankTier:0, rankDiv:0, rankBars:0, rankWinStreak:0 };
}

// Prune stale ranked queue entries every 30s
setInterval(function() {
    var before = rankedQueue.length;
    rankedQueue = rankedQueue.filter(function(e){
        return e.ws.readyState === WebSocket.OPEN && Date.now() - e.queuedAt < 90000;
    });
    if (rankedQueue.length !== before) console.log('[BD] Pruned ranked queue:', before, '->', rankedQueue.length);
}, 30000);
