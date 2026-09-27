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
      }
      io.to(currentRoom).emit('matchStarted', mapName);
      io.to(currentRoom).emit('updateScores', rooms[currentRoom].players);
    }
  });

  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    if (currentRoom && rooms[currentRoom]) {
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
    
    const targetId = hitData.targetId;
    const damage = hitData.damage;
    const headshot = hitData.headshot;
    const targetPlayer = rooms[currentRoom].players[targetId];
    
    if (targetPlayer && !targetPlayer.dead) {
      targetPlayer.health -= damage;
      
      if (targetPlayer.health <= 0) {
        targetPlayer.health = 0;
        targetPlayer.dead = true;
        targetPlayer.deaths = (targetPlayer.deaths || 0) + 1;
        
        let matchFinished = false;
        let winnerId = null;
        
        const killerPlayer = rooms[currentRoom].players[socket.id];
        if (killerPlayer) {
          killerPlayer.kills = (killerPlayer.kills || 0) + 1;
          if (killerPlayer.kills >= rooms[currentRoom].targetScore) {
            matchFinished = true;
            winnerId = socket.id;
            rooms[currentRoom].status = 'waiting';
          }
        }
        
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
          attackerId: socket.id 
        });
      }
    }
  });
  
  socket.on('respawn', (spawnPoint) => {
    if (currentRoom && rooms[currentRoom] && rooms[currentRoom].players[socket.id]) {
      const player = rooms[currentRoom].players[socket.id];
      player.health = 100;
      player.dead = false;
      player.x = spawnPoint.x;
      player.y = spawnPoint.y;
      player.z = spawnPoint.z;
      io.to(currentRoom).emit('playerRespawned', player);
    }
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`✅ Game Server running on port ${PORT} with Room support`);
});
