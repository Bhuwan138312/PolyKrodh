import express from 'express';
import { Server } from 'socket.io';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);

// Simple REST endpoint to get active public waiting rooms
app.get('/rooms', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  
  const roomList = Object.keys(rooms)
    .filter(roomName => rooms[roomName].status === 'waiting')
    .map(roomName => ({
      name: roomName,
      playerCount: Object.keys(rooms[roomName].players).length,
      isPrivate: !!rooms[roomName].password
    }));
  
  res.json(roomList);
});

// Serve static files from the 'dist' directory
app.use(express.static(path.join(__dirname, 'dist')));

// Send index.html for all other requests (SPA behavior)
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// rooms[roomName] = { players: {}, host: 'socketId', password: '', status: 'waiting' }
const rooms = {};

// How long a dead player stays down before the server revives them. The timer
// lives here on purpose: if it lived on the client, a pause / alt-tab during the
// death window would cancel the respawn and the player would stay invisible to
// everybody forever.
const RESPAWN_DELAY_MS = 3000;
const respawnTimers = new Map(); // `${roomName}:${playerId}` -> timeout

function clearRespawnTimer(roomName, playerId) {
  const key = `${roomName}:${playerId}`;
  const timer = respawnTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    respawnTimers.delete(key);
  }
}

/** The authoritative liveness verdict, derived once and broadcast to everyone. */
function playerState(player) {
  return {
    id: player.id,
    health: player.health,
    dead: player.dead,
    isAlive: !player.dead && player.health > 0,
  };
}

/** Revives a player and tells the whole room. Safe to call more than once. */
function revivePlayer(roomName, playerId, spawnPoint = null) {
  clearRespawnTimer(roomName, playerId);
  const room = rooms[roomName];
  if (!room) return null;
  const player = room.players[playerId];
  if (!player) return null;
  player.health = 100;
  player.dead = false;
  if (spawnPoint && Number.isFinite(spawnPoint.x)) {
    player.x = spawnPoint.x;
    player.y = spawnPoint.y;
    player.z = spawnPoint.z;
  }
  io.to(roomName).emit('playerRespawned', player);
  io.to(roomName).emit('playerState', playerState(player));
  return player;
}

function scheduleRespawn(roomName, playerId) {
  clearRespawnTimer(roomName, playerId);
  const timer = setTimeout(() => {
    respawnTimers.delete(`${roomName}:${playerId}`);
    revivePlayer(roomName, playerId);
  }, RESPAWN_DELAY_MS);
  respawnTimers.set(`${roomName}:${playerId}`, timer);
}

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);
  let currentRoom = null;

  socket.on('joinRoom', (data, callback) => {
    const roomName = data.roomName;
    const password = data.password || '';

    // If room exists and has a password, check it
    if (rooms[roomName] && rooms[roomName].password && rooms[roomName].password !== password) {
      if (callback) callback({ success: false, reason: 'Invalid password' });
      return;
    }

    // Leave previous room if any
    if (currentRoom) {
      socket.leave(currentRoom);
      if (rooms[currentRoom] && rooms[currentRoom].players[socket.id]) {
        clearRespawnTimer(currentRoom, socket.id);
        delete rooms[currentRoom].players[socket.id];
        socket.to(currentRoom).emit('playerDisconnected', socket.id);
        
        // Clean up empty rooms
        if (Object.keys(rooms[currentRoom].players).length === 0) {
          delete rooms[currentRoom];
        }
      }
    }

    currentRoom = roomName;
    socket.join(roomName);

    // Create room if it doesn't exist
    if (!rooms[roomName]) {
      rooms[roomName] = { 
        players: {}, 
        host: socket.id, 
        password: password, 
        status: 'waiting' 
      };
    }

    // Add player to room state
    rooms[roomName].players[socket.id] = {
      id: socket.id,
      x: 0, y: 0, z: 0,
      rx: 0, ry: 0,
      health: 100,
      dead: false,
      weaponIndex: 0,
      kills: 0,
      deaths: 0
    };

    console.log(`Player ${socket.id} joined room ${roomName} (Host: ${rooms[roomName].host === socket.id})`);

    // Send all existing players in the room to the new player
    socket.emit('currentPlayers', rooms[roomName].players);
    socket.emit('roomStatus', { 
      host: rooms[roomName].host, 
      status: rooms[roomName].status,
      map: rooms[roomName].map 
    });

    // Broadcast to all OTHER players in the room that a new player joined
    socket.to(roomName).emit('newPlayer', rooms[roomName].players[socket.id]);
    
    if (callback) callback({ success: true, room: roomName, isHost: rooms[roomName].host === socket.id });
  });

  socket.on('startGame', (mapName) => {
    if (currentRoom && rooms[currentRoom] && rooms[currentRoom].host === socket.id) {
      rooms[currentRoom].status = 'playing';
      rooms[currentRoom].map = mapName;
      
      const playerCount = Object.keys(rooms[currentRoom].players).length;
      rooms[currentRoom].targetScore = playerCount <= 2 ? 10 : playerCount * 10;
      
      // Reset kills and deaths on start
      for (const pid in rooms[currentRoom].players) {
        rooms[currentRoom].players[pid].kills = 0;
        rooms[currentRoom].players[pid].deaths = 0;
        rooms[currentRoom].players[pid].health = 100;
        rooms[currentRoom].players[pid].dead = false;
        clearRespawnTimer(currentRoom, pid);
      }
      io.to(currentRoom).emit('matchStarted', mapName);
      io.to(currentRoom).emit('updateScores', rooms[currentRoom].players);
    }
  });

  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    if (currentRoom && rooms[currentRoom]) {
      clearRespawnTimer(currentRoom, socket.id);
      delete rooms[currentRoom].players[socket.id];
      socket.to(currentRoom).emit('playerDisconnected', socket.id);
      
      if (Object.keys(rooms[currentRoom].players).length === 0) {
        delete rooms[currentRoom];
      } else if (rooms[currentRoom].host === socket.id) {
        // Assign new host if the host leaves
        const nextPlayer = Object.keys(rooms[currentRoom].players)[0];
        rooms[currentRoom].host = nextPlayer;
        io.to(currentRoom).emit('roomStatus', { 
          host: rooms[currentRoom].host, 
          status: rooms[currentRoom].status 
        });
      }
    }
  });

  socket.on('playerMovement', (movementData) => {
    if (currentRoom && rooms[currentRoom] && rooms[currentRoom].players[socket.id]) {
      const player = rooms[currentRoom].players[socket.id];
      player.x = movementData.x;
      player.y = movementData.y;
      player.z = movementData.z;
      player.rx = movementData.rx;
      player.ry = movementData.ry;
      
      socket.to(currentRoom).emit('playerMoved', player);
    }
  });
  
  socket.on('weaponChanged', (weaponIndex) => {
    if (currentRoom && rooms[currentRoom] && rooms[currentRoom].players[socket.id]) {
      rooms[currentRoom].players[socket.id].weaponIndex = weaponIndex;
      socket.to(currentRoom).emit('playerWeaponChanged', { id: socket.id, weaponIndex });
    }
  });

  socket.on('playerShot', (shotData) => {
    if (currentRoom) {
      socket.to(currentRoom).emit('playerFired', { id: socket.id, ...shotData });
    }
  });
  
  socket.on('playerHit', (hitData) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    if (!hitData || typeof hitData.targetId !== 'string') return;

    // Damage is a number or it is nothing. A junk value used to poison the
    // victim's health with NaN, which made the liveness checks below
    // permanently false and desynced the two clients.
    const damage = Number(hitData.damage);
    if (!Number.isFinite(damage) || damage <= 0) return;

    const targetId = hitData.targetId;
    const headshot = Boolean(hitData.headshot);
    const targetPlayer = rooms[currentRoom].players[targetId];
    if (!targetPlayer) return;

    const attacker = rooms[currentRoom].players[socket.id];
    // Self hits and hits from outside the room are not damage events.
    if (!attacker || targetId === socket.id) return;

    // Already down: ignore, so a respawned victim can never be re-killed by a
    // bullet that was fired before they died.
    if (targetPlayer.dead) return;

    // Health only. Hiding the victim is not tied to this branch.
    targetPlayer.health = Math.max(0, targetPlayer.health - damage);

    if (targetPlayer.health <= 0) {
      targetPlayer.health = 0;
      targetPlayer.dead = true;
      targetPlayer.deaths = (targetPlayer.deaths || 0) + 1;

      let matchFinished = false;
      let winnerId = null;

      attacker.kills = (attacker.kills || 0) + 1;
      if (attacker.kills >= rooms[currentRoom].targetScore) {
        matchFinished = true;
        winnerId = socket.id;
        rooms[currentRoom].status = 'waiting';
      }

      scheduleRespawn(currentRoom, targetId);

      io.to(currentRoom).emit('playerDied', {
        victimId: targetId,
        killerId: socket.id,
        headshot: headshot
      });
      io.to(currentRoom).emit('updateScores', rooms[currentRoom].players);

      if (matchFinished) {
        io.to(currentRoom).emit('matchFinished', { winner: winnerId, stats: rooms[currentRoom].players });
      }
    } else {
      io.to(targetId).emit('takeDamage', {
        damage: damage,
        attackerId: socket.id,
        // The victim adopts the server's number instead of guessing its own,
        // so both clients agree on how much health is left.
        health: targetPlayer.health
      });
    }

    // Everyone re-reads liveness from the same authoritative snapshot.
    io.to(currentRoom).emit('playerState', playerState(targetPlayer));
  });

  socket.on('respawn', (spawnPoint) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    if (!rooms[currentRoom].players[socket.id]) return;
    revivePlayer(currentRoom, socket.id, spawnPoint);
  });

  // A client that suspects it drifted can pull the authoritative snapshot back
  // in. This is what makes the two views converge instead of staying stuck.
  socket.on('requestPlayerState', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    for (const pid in rooms[currentRoom].players) {
      socket.emit('playerState', playerState(rooms[currentRoom].players[pid]));
    }
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`✅ Game Server running on port ${PORT} with Room support`);
});
