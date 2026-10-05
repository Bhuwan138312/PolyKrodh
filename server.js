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

// rooms[roomName] = { players: {}, host: 'socketId', password: '', status: 'waiting', nextSeat: 0 }
const rooms = {};

const TEAMS = Object.freeze(['blue', 'red']);
const TEAM_SIZE = 4;
const MAX_NAME_LENGTH = 16;

/** Trims a display name, drops control characters, and caps the length. */
function sanitiseName(value, fallback) {
  const cleaned = String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return cleaned || fallback;
}

/**
 * The authoritative lobby roster, shaped for the team screen.
 *
 * Teams are arrays indexed by slot, so the slot a player is in *is* their index
 * rather than a second field that could disagree with it. Only what the lobby
 * needs is projected - name, team and host - because the full player record also
 * carries positions and health, which the lobby has no business showing.
 *
 * A player whose stored team or slot does not resolve to a real slot is reported
 * as available. `moveToTeam` is the only writer and validates every value it
 * stores, so this is a belt-and-braces fallback rather than a live case.
 */
function lobbyState(roomName) {
  const room = rooms[roomName];
  if (!room) return null;

  const teams = {
    blue: new Array(TEAM_SIZE).fill(null),
    red: new Array(TEAM_SIZE).fill(null),
  };
  const available = [];

  for (const id of Object.keys(room.players)) {
    const player = room.players[id];
    const entry = { id: player.id, name: player.name, isHost: player.id === room.host };
    const slotIsReal =
      TEAMS.includes(player.team) &&
      Number.isInteger(player.slot) &&
      player.slot >= 0 &&
      player.slot < TEAM_SIZE;

    if (slotIsReal && teams[player.team][player.slot] === null) {
      teams[player.team][player.slot] = entry;
    } else {
      available.push(entry);
    }
  }

  return {
    host: room.host,
    status: room.status,
    teamSize: TEAM_SIZE,
    teams,
    available,
  };
}

function broadcastLobbyState(roomName) {
  io.to(roomName).emit('lobbyState', lobbyState(roomName));
}

/** The lowest slot on `team` nobody holds, ignoring one player's own slot. */
function firstFreeSlot(room, team, ignoreSlot = -1) {
  const taken = new Set(
    Object.values(room.players)
      .filter((p) => p.team === team && p.slot !== ignoreSlot)
      .map((p) => p.slot),
  );
  for (let i = 0; i < TEAM_SIZE; i += 1) {
    if (!taken.has(i)) return i;
  }
  return -1;
}

/**
 * Moves a player into a team slot, or back to the available list when `team` is
 * null. Returns `{ ok }` and never throws.
 *
 * This is the only thing that writes team state, which is what makes the server
 * authoritative: a client sends an intent and gets a yes or a no, and the truth
 * comes from the roster everyone re-reads afterwards.
 *
 * Validate-then-mutate with no await anywhere in between is the race defence.
 * Node runs one handler at a time and this never yields, so the check for "is
 * this slot taken" and the write of it cannot be interleaved. Two players racing
 * for the same slot means the second one finds it occupied and is refused, rather
 * than both believing they got it.
 *
 * A player holds at most one (team, slot) pair, so switching teams is a single
 * overwrite - they cannot end up in two slots, because there is only ever one
 * pair of fields to write.
 */
function moveToTeam(roomName, playerId, team, slot) {
  const room = rooms[roomName];
  if (!room) return { ok: false, reason: 'No such room' };
  const player = room.players[playerId];
  if (!player) return { ok: false, reason: 'You are not in this room' };

  // Back to the available list. Nothing to collide with: the only slot a player
  // can hold is the one they are already holding.
  if (team === null) {
    player.team = null;
    player.slot = -1;
    return { ok: true, team: null, slot: -1 };
  }

  if (!TEAMS.includes(team)) return { ok: false, reason: 'Unknown team' };

  let target = slot;
  if (target === undefined || target === null) {
    // No slot named, so take the first free one. Owning the current slot is
    // ignored when looking, so "put me back on my team" is a no-op rather than a
    // full-team refusal.
    target = firstFreeSlot(room, team, player.team === team ? player.slot : -1);
    if (target < 0) return { ok: false, reason: 'That team is full' };
  }

  if (!Number.isInteger(target) || target < 0 || target >= TEAM_SIZE) {
    return { ok: false, reason: 'No such slot' };
  }

  // The collision the race check exists for.
  const occupant = Object.values(room.players).find(
    (p) => p.id !== playerId && p.team === team && p.slot === target,
  );
  if (occupant) return { ok: false, reason: 'That slot was just taken' };

  player.team = team;
  player.slot = target;
  return { ok: true, team, slot: target };
}

// How long a dead player stays down before the server revives them. The timer
// lives here on purpose: if it lived on the client, a pause / alt-tab during the
// death window would cancel the respawn and the player would stay invisible to
// everybody forever.
const RESPAWN_DELAY_MS = 3000;
// How many ms after a player dies their in-flight shots are still honoured.
// 0 = strict first-hit-wins (no kill trading). Raise to ~80-120 to allow
// mutual kills when both shots were genuinely in the air before either died.
const KILL_TRADE_WINDOW_MS = 0;
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
        status: 'waiting',
        nextSeat: 0
      };
    }

    // A seat number that only goes up, so two players in the same room are never
    // both called PLAYER 2 - which happens with a live count once someone leaves
    // and the gap closes behind them.
    rooms[roomName].nextSeat = (rooms[roomName].nextSeat || 0) + 1;

    // Add player to room state
    rooms[roomName].players[socket.id] = {
      id: socket.id,
      name: sanitiseName(data.name, `PLAYER ${rooms[roomName].nextSeat}`),
      // No team until the player picks one, which is what puts them in the
      // available list. These two fields are the whole of team membership.
      team: null,
      slot: -1,
      x: 0, y: 0, z: 0,
      rx: 0, ry: 0,
      health: 100,
      dead: false,
      deathTime: 0,
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

    // The team roster goes to the whole room, newcomer included, so nobody's
    // lobby depends on having caught every earlier event.
    broadcastLobbyState(roomName);

    if (callback) callback({ success: true, room: roomName, isHost: rooms[roomName].host === socket.id });
  });

  /**
   * A player asking to join, leave or switch team.
   *
   * `data.team` is 'blue', 'red', or null for the available list. `data.slot` is
   * optional; omit it and the server takes the first free one. Both are validated
   * against the live roster, never taken on trust.
   */
  socket.on('selectTeam', (data, callback) => {
    const room = currentRoom ? rooms[currentRoom] : null;
    if (!room || !room.players[socket.id]) {
      if (callback) callback({ ok: false, reason: 'You are not in this room' });
      return;
    }

    // Once the match is running the sides are fixed. Letting anyone move now
    // would move the kills that have already been scored between the two totals.
    if (room.status === 'playing') {
      if (callback) callback({ ok: false, reason: 'The match has already started' });
      return;
    }

    const requestedTeam = data && typeof data === 'object' ? data.team : undefined;
    // An absent team is a malformed request, not a request to stand down. Only an
    // explicit null returns somebody to the available list.
    if (requestedTeam !== null && !TEAMS.includes(requestedTeam)) {
      if (callback) callback({ ok: false, reason: 'Unknown team' });
      return;
    }

    const result = moveToTeam(currentRoom, socket.id, requestedTeam, data?.slot);
    if (callback) callback(result);

    if (result.ok) {
      // Everybody re-renders from the same roster, including the player who moved,
      // so a team change appears for all clients in one step.
      broadcastLobbyState(currentRoom);
    } else {
      // Nothing changed for anyone, so only the player who clicked needs to be
      // put back in step with the truth.
      socket.emit('lobbyState', lobbyState(currentRoom));
    }
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
        rooms[currentRoom].players[pid].deathTime = 0;
        clearRespawnTimer(currentRoom, pid);
      }
      io.to(currentRoom).emit('matchStarted', mapName);
      // The whole player record goes out, `team` included, which is what makes the
      // in-game TDM bar a real two-team score instead of you-versus-everyone.
      io.to(currentRoom).emit('updateScores', rooms[currentRoom].players);

      // Teams are frozen from here. Broadcasting the roster with the new status is
      // how every client learns the sides can no longer be changed.
      broadcastLobbyState(currentRoom);
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
      } else {
        // The leaving player's slot is now vacant, so the roster has to go out
        // again or everyone else keeps seeing them in it.
        if (rooms[currentRoom].host === socket.id) {
          // Assign new host if the host leaves
          const nextPlayer = Object.keys(rooms[currentRoom].players)[0];
          rooms[currentRoom].host = nextPlayer;
          io.to(currentRoom).emit('roomStatus', { 
            host: rooms[currentRoom].host, 
            status: rooms[currentRoom].status 
          });
        }
        broadcastLobbyState(currentRoom);
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
    if (!currentRoom || !rooms[currentRoom]) return;
    const shooter = rooms[currentRoom].players[socket.id];
    // Dead players do not fire. Suppresses phantom tracers on other clients.
    if (!shooter || shooter.dead) return;
    socket.to(currentRoom).emit('playerFired', { id: socket.id, ...shotData });
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

    // ── Authoritative first-hit-wins ──────────────────────────────────────
    // A dead attacker cannot deal damage. With KILL_TRADE_WINDOW_MS = 0 this
    // is strict: whoever the server processes first wins and the loser's
    // in-flight bullets are void. With a positive window, shots that were
    // plausibly already in the air (fired before the attacker could have
    // known they were dead) are still honoured, giving a small mutual-kill
    // window that feels fair on high-latency connections.
    if (attacker.dead) {
      if (KILL_TRADE_WINDOW_MS <= 0) return;
      const elapsed = Date.now() - (attacker.deathTime || 0);
      if (elapsed > KILL_TRADE_WINDOW_MS) return;
    }

    // Already down: ignore, so a respawned victim can never be re-killed by a
    // bullet that was fired before they died.
    if (targetPlayer.dead) return;

    // Health only. Hiding the victim is not tied to this branch.
    targetPlayer.health = Math.max(0, targetPlayer.health - damage);

    if (targetPlayer.health <= 0) {
      targetPlayer.health = 0;
      targetPlayer.dead = true;
      targetPlayer.deathTime = Date.now();
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
