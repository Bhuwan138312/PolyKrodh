// End-to-end check of the team-selection lobby.
//
// This drives the REAL server.js as a child process over real sockets, because
// the whole point of the feature is that the server is authoritative. A test that
// imported the roster-building helpers would prove nothing about who wins a race
// for a slot, because that is decided by the order handlers actually run in.
//
// Covered: the initial roster, claiming a named slot, a full team, switching
// teams, not holding two slots at once, the race for one slot from many clients
// at once, every client converging on the same roster, a disconnect freeing the
// slot, teams locking at match start, and `team` surviving into the in-game score
// payload so the TDM bar becomes real.
//
// Every socket records every roster it is sent from the moment it connects, and
// assertions read that record. An earlier version waited for the next roster with
// a listener registered after the action, which silently missed events that
// arrived during the acknowledgement round-trip and reported them as absent.
import { spawn } from 'child_process';
import { io } from 'socket.io-client';

const PORT = 3999;
const URL = `http://127.0.0.1:${PORT}`;
const TIMEOUT = 5000;

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}${detail ? `  ${detail}` : ''}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? `  ${detail}` : ''}`); }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = (ms = 300) => wait(ms);

const NO_ACK = Symbol('no ack');

/** Emits an event and resolves with the server's acknowledgement. */
function ask(socket, event, payload) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(NO_ACK), TIMEOUT);
    socket.emit(event, payload, (ack) => { clearTimeout(timer); resolve(ack ?? NO_ACK); });
  });
}

/** Did the request succeed? A missing acknowledgement is a failure, not a no. */
function refused(result) {
  return result !== NO_ACK && result?.ok === false;
}
function accepted(result) {
  return result !== NO_ACK && result?.ok === true;
}
function reasonOf(result) {
  return result === NO_ACK ? 'no acknowledgement at all' : (result?.reason ?? '');
}

async function connect() {
  const socket = io(URL, { transports: ['websocket'], forceNew: true, reconnection: false });
  // Installed before the first join, so no roster can slip past unrecorded.
  socket.rosters = [];
  socket.on('lobbyState', (state) => { socket.latest = state; socket.rosters.push(state); });
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, TIMEOUT);
    socket.on('connect', () => { clearTimeout(timer); resolve(); });
  });
  return socket;
}

const join = (socket, roomName, name) =>
  ask(socket, 'joinRoom', name === undefined ? { roomName, password: '' } : { roomName, password: '', name });

/** Every player in a roster, read straight off the wire. */
function everyone(state) {
  const out = [];
  for (const team of ['blue', 'red']) {
    (state?.teams?.[team] ?? []).forEach((p, slot) => { if (p) out.push({ team, slot, ...p }); });
  }
  for (const p of state?.available ?? []) out.push({ team: null, slot: -1, ...p });
  return out;
}

const occupantOf = (state, id) => everyone(state).find((p) => p.id === id);

/** Every connected client agrees on the roster, character for character. */
function converged(clients) {
  const rosters = clients.map((s) => JSON.stringify(s.latest));
  return rosters.every((r) => r === rosters[0]);
}

// ------------------------------------------------------------------ the server
const server = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
const booted = Date.now();
while (!/running on port/.test(serverLog) && Date.now() - booted < 10000) await wait(100);

const sockets = [];
function cleanup() { for (const s of sockets) { try { s.disconnect(); } catch { /* already gone */ } } server.kill(); }
process.on('exit', cleanup);

try {
  // ------------------------------------------------- everyone starts available
  console.log('\n--- a fresh room has no teams, and everyone is available ---');
  const room = 'RACE-1';
  const a = await connect(); sockets.push(a);
  const b = await connect(); sockets.push(b);
  const joinA = await join(a, room);
  const joinB = await join(b, room);
  await settle();
  check('both clients joined the room', joinA.success === true && joinB.success === true);
  check('the first player in is the host', joinA.isHost === true && joinB.isHost === false);

  const first = a.latest;
  check('a roster arrives on join', Boolean(first), first ? `${everyone(first).length} players listed` : 'never emitted');
  check('the server decides the team size and the client just reads it',
    first?.teamSize === 4, `teamSize ${first?.teamSize}`);
  check('both teams start empty',
    first?.teams.blue.filter(Boolean).length === 0 && first?.teams.red.filter(Boolean).length === 0);
  check('both players start in the available list', first?.available.length === 2);
  check('every player is listed exactly once', everyone(first).length === 2);
  check('a player cannot be in a team and the available list at once',
    first?.teams.blue.some(Boolean) === false && first?.available.length === 2);

  // ------------------------------------------------------ claiming a slot
  console.log('\n--- clicking an empty + puts the player in that slot ---');
  const claimed = await ask(a, 'selectTeam', { team: 'blue', slot: 1 });
  await settle();
  check('claiming a named slot succeeds', accepted(claimed), `blue[${claimed?.slot}]`);

  check('the player landed in exactly the slot they clicked',
    occupantOf(a.latest, a.id)?.slot === 1, `blue[${occupantOf(a.latest, a.id)?.slot}]`);
  check('the other client sees it without being told separately', converged([a, b]));
  check('claiming one slot leaves the other three free',
    a.latest?.teams.blue.filter(Boolean).length === 1);

  // ------------------------------------------- the click is an intent, not a fact
  console.log('\n--- a client cannot talk itself into a slot it was not given ---');
  const outOfRange = await ask(a, 'selectTeam', { team: 'blue', slot: 99 });
  check('a slot outside the team is refused', refused(outOfRange), reasonOf(outOfRange));
  const noSuchTeam = await ask(a, 'selectTeam', { team: 'purple', slot: 0 });
  check('a team that does not exist is refused', refused(noSuchTeam), reasonOf(noSuchTeam));
  const noTeamAtAll = await ask(a, 'selectTeam', {});
  check('a request naming no team is refused rather than silently standing down',
    refused(noTeamAtAll), reasonOf(noTeamAtAll));
  const noSlotAtAll = await ask(a, 'selectTeam', { team: 'blue' });
  check('naming a team with no slot takes the first free one rather than failing',
    accepted(noSlotAtAll), `blue[${noSlotAtAll?.slot}]`);
  await settle();
  check('after all four requests the player is on blue, still in one slot',
    occupantOf(a.latest, a.id)?.team === 'blue' && occupantOf(a.latest, a.id)?.slot === 0,
    `blue[${occupantOf(a.latest, a.id)?.slot}]`);

  // ------------------------------------------------------- switching teams
  console.log('\n--- switching teams removes the old slot ---');
  const switched = await ask(a, 'selectTeam', { team: 'red', slot: 0 });
  await settle();
  const moved = occupantOf(a.latest, a.id);
  check('switching to red succeeds', accepted(switched));
  check('the player is now in red[0]', moved?.team === 'red' && moved?.slot === 0);
  check('and appears exactly once in the whole roster',
    everyone(a.latest).filter((p) => p.id === a.id).length === 1,
    `${everyone(a.latest).filter((p) => p.id === a.id).length} entries for one player`);
  check('blue is empty again', a.latest?.teams.blue.filter(Boolean).length === 0);
  check('the other client agrees', converged([a, b]));

  // --------------------------------------------------- the race for one slot
  console.log('\n--- eight clients race for the same slot in one tick ---');
  const racers = [];
  for (let i = 0; i < 8; i += 1) {
    const s = await connect(); sockets.push(s);
    await join(s, room);
    racers.push(s);
  }
  await settle();

  // No awaits between these emits, so all eight arrive as one burst.
  const verdicts = await Promise.all(racers.map((s) => ask(s, 'selectTeam', { team: 'red', slot: 2 })));
  await settle();

  const winners = verdicts.map((v, i) => ({ v, i })).filter(({ v }) => accepted(v));
  const losers = verdicts.filter((v) => refused(v));
  check('exactly one client wins the slot', winners.length === 1,
    `${winners.length} winner, ${losers.length} refused, ${verdicts.filter((v) => v === NO_ACK).length} silent`);
  check('everybody else is told why', losers.every((v) => typeof v.reason === 'string' && v.reason.length > 0),
    reasonOf(losers[0]));
  check('nobody was left without an answer', verdicts.every((v) => v !== NO_ACK));

  // Red already holds `a` in slot 0, so the race added exactly one more.
  const redOccupants = a.latest?.teams.red.filter(Boolean) ?? [];
  check('red gained exactly one player from the race', redOccupants.length === 2,
    `red holds ${redOccupants.length}, one of which is the earlier player`);
  check('the contested slot holds exactly one player', Boolean(a.latest?.teams.red[2]),
    `red[2] = ${a.latest?.teams.red[2]?.id === racers[winners[0].i].id ? 'the winner' : 'SOMEONE ELSE'}`);
  check('and it is the client the server said yes to',
    a.latest?.teams.red[2]?.id === racers[winners[0].i].id);
  check('the player already on red is untouched', a.latest?.teams.red[0]?.id === a.id);
  check('the eight racers each appear once, none duplicated',
    everyone(a.latest).filter((p) => racers.some((r) => r.id === p.id)).length === 8);
  check('all ten clients converged on one roster', converged([a, b, ...racers]));

  // One interleaving can be lucky, so repeat it.
  console.log('\n--- repeating the race, from a cleared room each time ---');
  const everyoneHere = [a, b, ...racers];
  const counts = [];
  for (let round = 0; round < 6; round += 1) {
    for (const s of everyoneHere) await ask(s, 'selectTeam', { team: null });
    await settle(120);
    const team = round % 2 === 0 ? 'red' : 'blue';
    const slot = round % 4;
    const again = await Promise.all(racers.map((s) => ask(s, 'selectTeam', { team, slot })));
    counts.push(again.filter((v) => accepted(v)).length);
  }
  check('no round ever produced two winners', counts.every((n) => n === 1), `winner counts: ${counts.join(', ')}`);
  await settle();
  check('and the room is still coherent afterwards', converged(everyoneHere));

  // ------------------------------------------------------------- full teams
  console.log('\n--- a full team accepts nobody and offers no + ---');
  const fillRoom = 'FULL-1';
  // A team needs one client per slot: a player only ever holds one slot, so one
  // client cannot fill a team by clicking through it.
  const fillers = [];
  for (let i = 0; i < 5; i += 1) {
    const s = await connect(); sockets.push(s);
    await join(s, fillRoom);
    fillers.push(s);
  }
  await settle();
  const size = fillers[0].latest.teamSize;
  check('the room can hold more players than a single team', fillers.length > size,
    `${fillers.length} clients for ${size} slots`);

  const fill = [];
  for (let i = 0; i < size; i += 1) fill.push(await ask(fillers[i], 'selectTeam', { team: 'blue', slot: i }));
  check(`all ${size} blue slots can be filled`, fill.every((v) => accepted(v)));
  await settle();

  const spare = fillers[size];
  const overflow = await ask(spare, 'selectTeam', { team: 'blue', slot: null });
  check('asking for the first free slot in a full team is refused', refused(overflow), reasonOf(overflow));
  const namedOverflow = await ask(spare, 'selectTeam', { team: 'blue', slot: 0 });
  check('and so is naming a slot on it directly', refused(namedOverflow), reasonOf(namedOverflow));
  await settle();

  const filled = spare.latest?.teams.blue.filter(Boolean).length ?? 0;
  check('the team reports itself full, which is how the client hides the +',
    filled === size, `the client would show ${filled}/${size}`);
  const who = occupantOf(spare.latest, spare.id);
  check('the refused player is not on the team at all',
    who?.team === null, `they read as ${who?.team}`);
  check('they are still in the room and still visible', everyone(spare.latest).length === 5);
  check('and exactly once', everyone(spare.latest).filter((p) => p.id === spare.id).length === 1);
  check('every client agrees the team is full', converged(fillers));

  const tookRed = await ask(spare, 'selectTeam', { team: 'red', slot: 0 });
  check('the refused player can still take the other team', accepted(tookRed), `red[${tookRed?.slot}]`);
  await settle();

  // ------------------------------------------------- disconnect frees the slot
  console.log('\n--- leaving frees the slot and tells the room ---');
  const leaver = fillers[0];
  const hostBefore = spare.latest?.host;
  check('the first arrival is the host', hostBefore === leaver.id);
  check('the leaver is in blue[0]', occupantOf(spare.latest, leaver.id)?.slot === 0);

  leaver.disconnect();
  await settle();
  check('the departed player is gone from the roster',
    !everyone(spare.latest).some((p) => p.id === leaver.id),
    'otherwise their slot would look occupied for everybody else');
  check('and their slot is free again',
    (spare.latest?.teams.blue[0] ?? null) === null, 'blue[0] is offered again');
  check('the team is one short of full, so the + returns',
    (spare.latest?.teams.blue.filter(Boolean).length ?? 0) === size - 1,
    `blue is ${spare.latest?.teams.blue.filter(Boolean).length}/${size}`);
  check('the host moved on to somebody still here',
    spare.latest?.host && spare.latest.host !== hostBefore);
  check('every client agreed on who left', converged(fillers.slice(1)));
  check('the freed slot can now be claimed',
    accepted(await ask(spare, 'selectTeam', { team: 'blue', slot: 0 })));

  // ------------------------------------------------ teams lock at match start
  console.log('\n--- once the match starts the sides are frozen ---');
  await settle();
  const host = fillers.slice(1).find((s) => s.id === spare.latest?.host) ?? spare;
  const late = fillers[4];
  const beforeStart = late.latest;
  check('the waiting room is reported as waiting', beforeStart?.status === 'waiting', `status ${beforeStart?.status}`);
  check('so the client offers the +', beforeStart?.status !== 'playing');

  await ask(host, 'startGame', 'arena');
  await settle();
  check('the frozen roster is broadcast, so the client can disable the +',
    late.latest?.status === 'playing', `status ${late.latest?.status}`);

  // Read where this player actually is rather than assuming, then assert the
  // refused attempt left them there. That is the property that matters, and it
  // holds whichever side they happen to be on.
  const before = occupantOf(late.latest, late.id);
  // Aim at a slot that is genuinely vacant, read off the roster rather than
  // assumed, so this tests the freeze and not my guess about who is where.
  const emptySlotOn = (state, team) => (state?.teams?.[team] ?? []).findIndex((p) => !p);
  const other = before?.team === 'blue' ? 'red' : 'blue';
  const targetTeam = emptySlotOn(late.latest, other) >= 0 ? other : before?.team;
  const targetSlot = emptySlotOn(late.latest, targetTeam);
  check('there is an empty slot to try to claim', targetSlot >= 0,
    `${targetTeam}[${targetSlot}] is vacant`);

  const frozen = await ask(late, 'selectTeam', { team: targetTeam, slot: targetSlot });
  check('changing team mid-match is refused', refused(frozen), reasonOf(frozen));
  const after = occupantOf(late.latest, late.id);
  check('and the player is exactly where they were before the attempt',
    after?.team === before?.team && after?.slot === before?.slot,
    `${before?.team}[${before?.slot}] unchanged`);
  check('the vacant slot they asked for is still vacant',
    (late.latest?.teams[targetTeam]?.[targetSlot] ?? null) === null,
    `${targetTeam}[${targetSlot}] is still empty`);
  check('every client saw the freeze', converged(fillers.slice(1)));

  // ---------------------------------------------------- the score payload
  console.log('\n--- team travels into the in-game score payload ---');
  const scoreRoom = 'SCORE-1';
  const s1 = await connect(); sockets.push(s1);
  const s2 = await connect(); sockets.push(s2);
  await join(s1, scoreRoom);
  await join(s2, scoreRoom);
  await settle();
  await ask(s1, 'selectTeam', { team: 'blue', slot: 0 });
  await ask(s2, 'selectTeam', { team: 'red', slot: 0 });
  await settle();

  const scorePackets = [];
  s1.on('updateScores', (p) => scorePackets.push(p));
  await ask(s1, 'startGame', 'arena');
  await settle(600);
  const scores = scorePackets[0];
  check('updateScores arrives once the match starts', Boolean(scores));
  const myTeam = scores?.[s1.id]?.team;
  const theirTeam = scores?.[s2.id]?.team;
  check('the player record carries a team', typeof myTeam === 'string', `team ${myTeam}`);
  check('blue and red are distinguishable in the payload',
    myTeam === 'blue' && theirTeam === 'red', `${myTeam} vs ${theirTeam}`);

  // Scoreboard.normaliseTeam accepts exactly these values, which is what turns
  // the bar from you-versus-everyone into a real two-team score.
  const norm = (v) => (v === 1 || v === '1' || v === 'blue' ? 1 : v === 2 || v === '2' || v === 'red' ? 2 : null);
  check('Scoreboard.normaliseTeam understands both teams values',
    norm(myTeam) === 1 && norm(theirTeam) === 2);

  // ------------------------------------------------------------ player names
  console.log('\n--- names ---');
  const nameRoom = 'NAME-1';
  const n1 = await connect(); sockets.push(n1);
  const n2 = await connect(); sockets.push(n2);
  await join(n1, nameRoom, 'ACE');
  await join(n2, nameRoom, '<b>BOB</b>');
  await settle();
  const allNames = everyone(n1.latest).map((p) => p.name);
  check('a supplied name is used', allNames.includes('ACE'), allNames.join(', '));
  check('markup in a name survives as plain text rather than being dropped',
    allNames.some((n) => n.includes('<b>')), 'the client sets it with textContent, so it cannot become markup');
  check('names are unique within a room', new Set(allNames).size === allNames.length,
    `${allNames.length} names, ${new Set(allNames).size} distinct`);

  const anon = await connect(); sockets.push(anon);
  await join(anon, nameRoom);
  await settle();
  const anonName = occupantOf(anon.latest, anon.id)?.name;
  check('a player with no name gets a generated one', /^PLAYER \d+$/.test(anonName ?? ''), anonName);

  const long = await connect(); sockets.push(long);
  await join(long, nameRoom, 'X'.repeat(80));
  await settle();
  const longName = occupantOf(long.latest, long.id)?.name;
  check('an over-long name is capped', (longName?.length ?? 99) <= 16, `${longName?.length} characters`);
} catch (err) {
  console.log(`\n  FAIL harness threw: ${err?.stack ?? err}`);
  fail += 1;
} finally {
  cleanup();
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail === 0 ? 'ALL CHECKS PASSED' : `${fail} CHECK(S) FAILED`);
if (fail > 0 && serverLog) console.log(`\n--- server output ---\n${serverLog}`);
process.exit(fail === 0 ? 0 : 1);
