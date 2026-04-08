// ============================================================
// DOBLADOOO ROYALE — Servidor Multijugador
// Battle Royale real: hasta 100 jugadores por sala
// Cuando hay más de 100, se abre una nueva sala
// Los jugadores pueden unirse aunque la partida ya haya empezado
// Instalar: npm install ws
// Ejecutar: node server.js
// ============================================================

const { WebSocketServer } = require('ws');
const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT        = process.env.PORT || 3000;
const MAX_PER_ROOM = 100;

// ---- HTTP ----
const httpServer = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const filePath = path.join(__dirname, 'DOBLADOOO_ROYALE.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

const wss = new WebSocketServer({ server: httpServer });

let nextPlayerId = 1;
let nextRoomId   = 1;
const rooms = {};

class Room {
  constructor(id) {
    this.id          = id;
    this.players     = {};
    this.gameStarted = false;
  }
  get count() { return Object.keys(this.players).length; }
  isFull()    { return this.count >= MAX_PER_ROOM; }
  broadcast(data, excludeId = null) {
    const msg = JSON.stringify(data);
    for (const [id, p] of Object.entries(this.players)) {
      if (id == excludeId) continue;
      if (p.ws.readyState === 1) p.ws.send(msg);
    }
  }
  sendTo(playerId, data) {
    const p = this.players[playerId];
    if (p && p.ws.readyState === 1) p.ws.send(JSON.stringify(data));
  }
  getLobbyState() {
    return Object.entries(this.players).map(([id, p]) => ({
      id, skinId: p.skinId, ready: p.ready,
      x: p.x, y: p.y, z: p.z
    }));
  }
}

function getOrCreateRoom() {
  // Busca sala con espacio (con o sin partida en curso)
  for (const room of Object.values(rooms)) {
    if (!room.isFull()) return room;
  }
  // Crear sala nueva
  const room = new Room(String(nextRoomId++));
  rooms[room.id] = room;
  console.log(`Nueva sala creada: ${room.id}`);
  return room;
}

function getRoomOf(playerId) {
  for (const room of Object.values(rooms)) {
    if (room.players[playerId]) return room;
  }
  return null;
}

function getSpawnPosition(index, total) {
  const angle  = (index / Math.max(total, 1)) * Math.PI * 2;
  const radius = 40 + Math.min(index * 2, 200);
  return {
    x: Math.cos(angle) * radius,
    y: 5,
    z: Math.sin(angle) * radius
  };
}

function launchGame(room) {
  if (room.gameStarted) return;
  room.gameStarted = true;
  if (room._soloTimeout) { clearTimeout(room._soloTimeout); room._soloTimeout = null; }

  const ids = Object.keys(room.players);
  ids.forEach((pid, i) => {
    const sp = getSpawnPosition(i, ids.length);
    room.players[pid].x = sp.x;
    room.players[pid].y = sp.y;
    room.players[pid].z = sp.z;
  });

  for (const [pid, p] of Object.entries(room.players)) {
    const rivals = Object.entries(room.players)
      .filter(([rid]) => rid !== pid)
      .map(([rid, r]) => ({
        id: rid, skinId: r.skinId,
        x: r.x, y: r.y, z: r.z
      }));
    p.ws.send(JSON.stringify({
      type: 'game_start',
      mySpawn: { x: p.x, y: p.y, z: p.z },
      rivals
    }));
  }
  console.log(`Partida iniciada en sala ${room.id} con ${ids.length} jugadores`);
}

// ---- WebSocket ----
wss.on('connection', (ws) => {
  const id   = String(nextPlayerId++);
  const room = getOrCreateRoom();

  const spawnIdx = room.count;
  const spawn    = getSpawnPosition(spawnIdx, room.count + 1);

  const player = {
    ws, id, roomId: room.id,
    x: spawn.x, y: spawn.y, z: spawn.z,
    rotY: 0,
    hp: 500, shield: 500, alive: true,
    skinId: 0, ready: false
  };

  room.players[id] = player;
  console.log(`J${id} → sala ${room.id} (${room.count}/${MAX_PER_ROOM}) [partida: ${room.gameStarted}]`);

  // Informar al nuevo jugador
  ws.send(JSON.stringify({
    type: 'welcome',
    myId: id,
    roomId: room.id,
    mySpawn: spawn,
    players: room.getLobbyState(),
    playerCount: room.count,
    gameStarted: room.gameStarted
  }));

  // Si la partida ya estaba en curso, mandar game_start inmediatamente con todos los rivales actuales
  if (room.gameStarted) {
    const rivals = Object.entries(room.players)
      .filter(([rid]) => rid !== id)
      .map(([rid, r]) => ({
        id: rid, skinId: r.skinId,
        x: r.x, y: r.y, z: r.z
      }));
    ws.send(JSON.stringify({
      type: 'game_start',
      mySpawn: spawn,
      rivals
    }));
    // Notificar a los demás que llegó un jugador nuevo en mitad de partida
    room.broadcast({ type: 'rival_joined_ingame', id, skinId: 0, spawn }, id);
    console.log(`J${id} se unió a partida en curso en sala ${room.id}`);
  } else {
    // Informar a los demás de la llegada en lobby
    room.broadcast({ type: 'player_joined', id, skinId: 0, spawn }, id);
  }

  // ---- Mensajes ----
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const room = getRoomOf(id);
    if (!room) return;

    switch (msg.type) {

      case 'skin_change':
        player.skinId = msg.skinId;
        room.broadcast({ type: 'skin_change', id, skinId: msg.skinId }, id);
        break;

      case 'ready': {
        player.ready = true;
        room.broadcast({ type: 'player_ready', id }, id);

        if (room.gameStarted) break;

        const readyPlayers = Object.values(room.players).filter(p => p.ready);
        // Mínimo 2 jugadores listos para arrancar
        if (readyPlayers.length >= 2) {
          launchGame(room);
        }
        break;
      }

      case 'move':
        player.x = msg.x; player.y = msg.y; player.z = msg.z; player.rotY = msg.rotY;
        room.broadcast({ type: 'move', id, x: msg.x, y: msg.y, z: msg.z, rotY: msg.rotY }, id);
        break;

      case 'shoot': {
        const target = room.players[msg.targetId];
        if (!target || !target.alive) break;
        let dmg = msg.dmg;
        if (target.shield > 0) {
          const sd = Math.min(target.shield, dmg);
          target.shield -= sd; dmg -= sd;
        }
        target.hp = Math.max(0, target.hp - dmg);
        room.sendTo(msg.targetId, {
          type: 'hit', fromId: id,
          dmg: msg.dmg, isHead: msg.isHead,
          hp: target.hp, shield: target.shield
        });
        if (target.hp <= 0 && target.alive) {
          target.alive = false;
          room.sendTo(msg.targetId, { type: 'you_died', killerId: id });
          room.sendTo(id, { type: 'you_killed', targetId: msg.targetId });
          room.broadcast({ type: 'kill_feed', killerId: id, targetId: msg.targetId });
          console.log(`J${id} eliminó a J${msg.targetId} en sala ${room.id}`);

          const alive = Object.values(room.players).filter(p => p.alive);
          if (alive.length === 1) {
            room.sendTo(alive[0].id, { type: 'you_won' });
            console.log(`J${alive[0].id} ganó en sala ${room.id}`);
          }
        }
        break;
      }

      case 'chat':
        room.broadcast({ type: 'chat', id, text: msg.text }, id);
        break;
    }
  });

  ws.on('close', () => {
    console.log(`J${id} desconectado`);
    const room = getRoomOf(id);
    if (!room) return;
    delete room.players[id];
    room.broadcast({ type: 'player_left', id });

    if (room.count === 0) {
      delete rooms[room.id];
      console.log(`Sala ${room.id} eliminada`);
      return;
    }
    if (room.gameStarted) {
      const alive = Object.values(room.players).filter(p => p.alive);
      if (alive.length === 1) {
        room.sendTo(alive[0].id, { type: 'you_won' });
      }
    }
  });

  ws.on('error', (err) => console.error(`Error J${id}:`, err.message));
});

httpServer.listen(PORT, () => {
  console.log(`\n✅ Dobladooo Royale en http://localhost:${PORT}`);
  console.log(`   Máx ${MAX_PER_ROOM} jugadores/sala — salas ilimitadas\n`);
});
