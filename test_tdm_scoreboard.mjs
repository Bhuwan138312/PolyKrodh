// Scratch check: the scoreboard's two figures and two labels. The rule under
// test is that blue is always the player's side and always on the left, red is
// always the opponents and always on the right, and nothing - not who is
// winning, not a team number, not a room size - can move them.
import fs from 'fs';

class StubEl {
  constructor(id) {
    this.id = id;
    this.textContent = '';
    this.className = '';
    this.classList = {
      set: new Set(),
      add(...c) { c.forEach((x) => this.set.add(x)); },
      remove(...c) { c.forEach((x) => this.set.delete(x)); },
      contains(c) { return this.set.has(c); },
      toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); },
    };
    this.children = [];
    this.parentElement = null;
  }
  querySelector() { return null; }
  remove() {}
  get offsetWidth() { return 0; }
}

const els = new Map();
['#scoreboard', '#hud', '#sb-score-blue', '#sb-score-red', '#sb-name-blue', '#sb-name-red', '#sb-clock']
  .forEach((sel) => els.set(sel, new StubEl(sel)));
els.get('#sb-name-blue').textContent = 'TEAM 1';
els.get('#sb-name-red').textContent = 'TEAM 2';
els.get('#sb-score-blue').textContent = '0';
els.get('#sb-score-red').textContent = '0';

globalThis.document = { querySelector: (sel) => els.get(sel) ?? null };
let clockMs = 0;
globalThis.performance = { now: () => clockMs };

const { Scoreboard } = await import('./src/ui/Scoreboard.js');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
};

const hud = els.get('#hud');
const blue = els.get('#sb-score-blue');
const red = els.get('#sb-score-red');
const clock = els.get('#sb-clock');
const read = () => ({
  blue: blue.textContent,
  red: red.textContent,
  leftLabel: els.get('#sb-name-blue').textContent,
  rightLabel: els.get('#sb-name-red').textContent,
  clock: clock.textContent,
  active: hud.classList.contains('has-scoreboard'),
});

const sb = new Scoreboard();

console.log('--- an empty room shows nothing ---');
sb.reset();
check('it starts hidden', read().active === false);
check('both figures read zero', read().blue === '0' && read().red === '0');

console.log('\n--- with no server teams, blue is you and red is everyone else ---');
sb.reset();
sb.sync({ me: { kills: 8, deaths: 2 }, them: { kills: 5, deaths: 3 } }, 'me');
check('your kills are the blue figure, on the left', read().blue === '8', `blue=${read().blue}`);
check('the opponent kills are the red figure, on the right', read().red === '5', `red=${read().red}`);
check('nothing is lost between the two panels', Number(read().blue) + Number(read().red) === 13);

console.log('\n--- the sides never swap, whatever the score ---');
// The player is behind by a lot, ahead by a lot, and level. The bar must not move.
const snapshots = [
  { you: 0, them: 20 },
  { you: 20, them: 0 },
  { you: 7, them: 7 },
];
for (const s of snapshots) {
  sb.reset();
  sb.sync({ me: { kills: s.you }, them: { kills: s.them } }, 'me');
  check(`you ${s.you} - ${s.them}: you are still on the left, in blue`,
    read().blue === String(s.you) && read().red === String(s.them) && read().leftLabel === 'TEAM 1',
    `blue=${read().blue} red=${read().red} left=${read().leftLabel}`);
}

console.log('\n--- the sides never swap, whatever the team numbers ---');
// A room of four with the local player last in the snapshot: a join-order split
// would have put them on the right, and that is exactly what must not happen.
sb.reset();
sb.sync({
  a: { kills: 4 }, b: { kills: 4 }, c: { kills: 4 }, me: { kills: 4 },
}, 'me');
check('the player is on the left even when they appear last',
  read().blue === '4' && read().leftLabel === 'TEAM 1', `blue=${read().blue} left=${read().leftLabel}`);
check('all three opponents are pooled into the right figure', read().red === '12', `red=${read().red}`);

console.log('\n--- a server that names teams: blue is the players team ---');
sb.reset();
sb.sync({
  x: { kills: 4, team: 2 },   // on my team
  y: { kills: 6, team: 1 },   // against me
  z: { kills: 2, team: 2 },   // on my team
  w: { kills: 1, team: 1 },   // against me
}, 'x');
check('my team is pooled into blue', read().blue === '6', `blue=${read().blue} (4 + 2)`);
check('the other team is pooled into red', read().red === '7', `red=${read().red} (6 + 1)`);
check('and the left panel names my team, TEAM 2', read().leftLabel === 'TEAM 2', read().leftLabel);
check('the right panel names the other one, TEAM 1', read().rightLabel === 'TEAM 1', read().rightLabel);

console.log('\n--- a player on team 1 gets the matching wording ---');
sb.reset();
sb.sync({
  me: { kills: 3, team: 1 },
  them: { kills: 4, team: 2 },
}, 'me');
check('left is TEAM 1 in blue', read().leftLabel === 'TEAM 1' && read().blue === '3',
  `${read().leftLabel} ${read().blue}`);
check('right is TEAM 2 in red', read().rightLabel === 'TEAM 2' && read().red === '4',
  `${read().rightLabel} ${read().red}`);

console.log('\n--- team names are accepted however the server spells them ---');
for (const [given, expected] of [['1', 1], ['2', 2], [1, 1], [2, 2], ['blue', 1], ['red', 2]]) {
  sb.reset();
  sb.sync({ me: { kills: 1, team: given }, them: { kills: 1, team: given === 2 ? 1 : 2 } }, 'me');
  const want = expected === 1 ? 'TEAM 1' : 'TEAM 2';
  check(`team "${given}" is understood`, read().leftLabel === want,
    `left=${read().leftLabel}, wanted ${want}`);
}
for (const junk of [0, 3, 'green', null, undefined, {}]) {
  sb.reset();
  sb.sync({ me: { kills: 1, team: junk }, them: { kills: 1 } }, 'me');
  check(`nonsense team ${JSON.stringify(junk)} falls back to you-vs-them`,
    read().leftLabel === 'TEAM 1' && read().blue === '1' && read().red === '1',
    `left=${read().leftLabel} blue=${read().blue} red=${read().red}`);
}

console.log('\n--- the clock ---');
sb.reset();
sb.sync({ me: { kills: 0 }, them: { kills: 0 } }, 'me');
check('it starts at 0:00', read().clock === '0:00', read().clock);
clockMs = 65_000; sb.tick();
check('it counts up in m:ss', read().clock === '1:05', read().clock);
clockMs = 300_000; sb.tick();
check('five minutes in it reads 5:00', read().clock === '5:00', read().clock);
let writes = 0;
const before = clock.textContent;
clockMs = 300_016;
for (let i = 0; i < 60; i += 1) { clockMs += 16; sb.tick(); }
check('it only writes when the second changes', clock.textContent === before, 'no churn between seconds');
clockMs = 120_000;
sb.reset();
check('a reset clears it', read().clock === '0:00', read().clock);
sb.sync({ me: { kills: 0 }, them: { kills: 0 } }, 'me');
check('and the next match starts from zero', read().clock === '0:00', read().clock);

console.log('\n--- incremental updates and players leaving ---');
sb.reset();
sb.sync({ me: { kills: 1 }, them: { kills: 1 } }, 'me');
sb.setDead('me', true);
check('a death changes nothing on the bar', read().blue === '1' && read().red === '1',
  'liveness is not drawn');
sb.sync({ me: { kills: 4 }, them: { kills: 1 } }, 'me');
check('a kill moves the blue figure', read().blue === '4' && read().red === '1',
  `${read().blue} - ${read().red}`);
sb.remove('them');
check('an opponent leaving moves their kills off the board', read().red === '0', `red=${read().red}`);
check('and leaves mine alone', read().blue === '4', `blue=${read().blue}`);
sb.remove('nobody');
check('removing someone absent is harmless', sb.players.size === 1);

console.log('\n--- rubbish input ---');
sb.reset();
sb.sync({ a: { kills: -5 }, b: { kills: 'lots' }, c: null, d: { kills: 2.7 } }, 'a');
check('negative and non-numeric kills count as zero, fractions floor',
  Number(read().blue) + Number(read().red) === 2, `${read().blue} + ${read().red}`);
sb.sync(null, null);
check('a null snapshot leaves the bar intact', sb.players.size === 3);
check('and it is still shown', read().active === true);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
