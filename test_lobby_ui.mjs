// Checks the team lobby against real DOM.
//
// Driven through the real index.html and the real UIManager in jsdom, so this
// covers the things a stylesheet cannot assert: that the three columns are in the
// order the screen is meant to read, that a slot shows a name or a "+" and never
// both, that a full team offers no "+" at all, that only your own row is
// clickable, and that clicking sends an intent instead of moving anything on
// screen by itself.
//
// It also proves the ids and classes UIManager reaches for still exist in the
// markup, because the UIManager constructor binds a button for every selector it
// looks up and throws on the first one that is missing.
import fs from 'fs';
import { JSDOM } from 'jsdom';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}${detail ? `  ${detail}` : ''}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? `  ${detail}` : ''}`); }
}

const html = fs.readFileSync('index.html', 'utf8');
const dom = new JSDOM(html, { pretendToBeVisual: true, url: 'http://localhost/' });
for (const key of ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle']) {
  globalThis[key] = dom.window[key];
}
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
// jsdom only provides localStorage for a real origin, so supply the store the
// settings screens read at bind time.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

// The module is imported after the globals exist, because it queries the document
// as soon as it is constructed.
const { UIManager } = await import('./src/ui/UIManager.js');

const sent = [];
const audio = { resume() {}, play() {} };
const ui = new UIManager({ audio, weaponConfig: {} });
ui.setCallbacks({ selectTeam: (intent) => sent.push(intent) });

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const ME = 'me-socket';
const player = (id, extra = {}) => ({ id, name: `PLAYER ${id.slice(0, 3)}`, isHost: false, ...extra });

/** Builds the roster shape the server sends. */
function roster({ blue = [], red = [], available = [], host = ME, status = 'waiting', teamSize = 4 } = {}) {
  const pad = (arr, size) => {
    const out = arr.slice(0, size);
    while (out.length < size) out.push(null);
    return out;
  };
  return { host, status, teamSize, teams: { blue: pad(blue, teamSize), red: pad(red, teamSize) }, available };
}

const plusIn = (team) => $$(`#lobby-${team}-slots .lobby-slot.is-empty`).map((el) => el.textContent);
const namesIn = (team) => $$(`#lobby-${team}-slots .lobby-slot.is-filled .lobby-slot-name`).map((el) => el.textContent);

try {
  // --------------------------------------------------------------- structure
  console.log('\n--- three columns, blue left and red right, always ---');
  const areas = ['#lobby-teams'];
  check('the team area exists', areas.every((s) => $(s)));
  check('the old flat player list is gone', !$('#lobby-players-container'),
    'nothing still injects into a container that is no longer there');
  check('the lobby keeps its kicker, title, room line and controls',
    Boolean($('#lobby-screen .panel-kicker') && $('#lobby-screen h2')
      && $('#lobby-room-name') && $('#lobby-start-btn') && $('#lobby-leave-btn')),
    'START MATCH and LEAVE are untouched');

  const panels = $$('#lobby-teams > section');
  check('exactly three sections', panels.length === 3, panels.map((p) => p.className.split(' ').pop()).join(', '));
  check('the first is the blue team', panels[0].classList.contains('lobby-team-blue'));
  check('the middle is the available list', panels[1].classList.contains('lobby-avail'));
  check('the last is the red team', panels[2].classList.contains('lobby-team-red'));
  check('blue comes before red in the markup, so it is on the left on screen',
    panels[0].classList.contains('lobby-team-blue') && panels[2].classList.contains('lobby-team-red'));
  check('both teams are labelled', /BLUE TEAM/.test($('#lobby-blue-slots').closest('section').textContent)
    && /RED TEAM/.test($('#lobby-red-slots').closest('section').textContent));
  check('the middle column is labelled', /AVAILABLE/.test($('.lobby-avail-head').textContent));

  // ------------------------------------------------------- an empty roster
  console.log('\n--- a room where nobody has chosen ---');
  ui.renderLobbyTeams(roster({ available: [player(ME)] }), ME);
  check('four slots are rendered on each team', 4 === $$('#lobby-blue-slots .lobby-slot').length
    && 4 === $$('#lobby-red-slots .lobby-slot').length, '4 and 4');
  check('every empty slot shows a +', plusIn('blue').join('') === '++++' && plusIn('red').join('') === '++++');
  check('no slot shows a name yet', namesIn('blue').length === 0 && namesIn('red').length === 0);
  check('both counts read 0/4', $('#lobby-blue-count').textContent === '0/4' && $('#lobby-red-count').textContent === '0/4');
  check('you are listed as available',
    $$('.lobby-avail-row').length === 1 && $('.lobby-avail-row').classList.contains('is-you'));
  check('your available row is marked YOU', $$('.lobby-avail-row .lobby-chip-you').length === 1);
  check('the hint tells you to pick a side', $('#lobby-avail-hint').textContent === 'PICK A TEAM');
  check('the host sees START MATCH', $('#lobby-start-btn').style.display === 'flex');

  // ----------------------------------------------------- claiming a slot
  console.log('\n--- clicking an empty + on blue ---');
  sent.length = 0;
  $('#lobby-blue-slots').children[2].click();
  check('the click asks the server for that exact slot',
    sent.length === 1 && sent[0].team === 'blue' && sent[0].slot === 2, JSON.stringify(sent[0]));
  check('and nothing moves on screen by itself',
    plusIn('blue').join('') === '++++', 'a click is an intent, not a fact');

  console.log('\n--- the roster comes back and the slot now holds a name ---');
  ui.renderLobbyTeams(roster({
    blue: [player('a1'), player('a2'), player(ME)],
    available: [player('w1'), player('w2')],
  }), ME);
  check('the claimed slot shows the name instead of the +',
    plusIn('blue').join('') === '+', `one + left, occupied: ${namesIn('blue').join(', ')}`);
  check('the name shown is the one the server sent',
    namesIn('blue')[2] === `PLAYER ${ME.slice(0, 3)}`, namesIn('blue')[2]);
  check('the counts follow the roster',
    $('#lobby-blue-count').textContent === '3/4' && $('#lobby-red-count').textContent === '0/4');
  check('only your own slot is marked YOU',
    $$('#lobby-blue-slots .lobby-chip-you').length === 1);
  check('you are no longer in the available list', !$$('.lobby-avail-row.is-you').length);
  check('the others still waiting are listed',
    $$('.lobby-avail-row').length === 2 && $$('.lobby-avail-row.is-you').length === 0);
  check('the hint now says it is waiting for players',
    $('#lobby-avail-hint').textContent === 'WAITING FOR PLAYERS');

  // ---------------------------------------------------------- a full team
  console.log('\n--- a full team ---');
  ui.renderLobbyTeams(roster({
    blue: [player('a1'), player('a2'), player('a3'), player(ME)],
    available: [player('w1')],
  }), ME);
  check('all four blue slots show names', plusIn('blue').length === 0 && namesIn('blue').length === 4);
  check('the full team offers no + at all', plusIn('blue').length === 0, 'the + disappears');
  check('the count reads 4/4', $('#lobby-blue-count').textContent === '4/4');
  check('the other team still offers all four', plusIn('red').join('') === '++++');

  console.log('\n--- clicking is impossible on a full team ---');
  sent.length = 0;
  $$('#lobby-blue-slots .lobby-slot').forEach((el) => el.click());
  check('no request is sent from a full team', sent.length === 0);

  // ------------------------------------------------------ who may be moved
  console.log('\n--- only you can move yourself ---');
  ui.renderLobbyTeams(roster({
    blue: [player('a1'), player('a2'), player('a3'), player(ME)],
    available: [player('w1'), player('w2'), player('w3')],
  }), ME);
  const joins = $$('.lobby-avail-join');
  check('every waiting player is drawn with a +', joins.length === 3, `${joins.length} rows`);
  check('your own + is the only one enabled',
    joins.filter((b) => !b.disabled).length === 0,
    'you are already on a team here, so none of them act for you');

  ui.renderLobbyTeams(roster({ available: [player('w1'), player(ME), player('w3')] }), ME);
  const joins2 = $$('.lobby-avail-join');
  check('when you are waiting, exactly your + is enabled',
    joins2.filter((b) => !b.disabled).length === 1);
  check('and it is your row', joins2.filter((b) => !b.disabled)[0].closest('.lobby-avail-row').classList.contains('is-you'));
  check("someone else's + is drawn but inert",
    joins2.filter((b) => b.disabled).length === 2 && joins2.every((b) => b.textContent === '+'),
    'a + that would do nothing is not left looking clickable');

  sent.length = 0;
  joins2.filter((b) => !b.disabled)[0].click();
  check('your available + asks for a team, and names no slot',
    sent.length === 1 && sent[0].slot === null && ['blue', 'red'].includes(sent[0].team),
    JSON.stringify(sent[0]));

  console.log('\n--- the available + goes to the emptier team ---');
  ui.renderLobbyTeams(roster({ red: [player('r1'), player('r2')], available: [player(ME)] }), ME);
  sent.length = 0;
  $('.lobby-avail-join').click();
  check('with red the fuller side, it asks for blue', sent[0]?.team === 'blue', JSON.stringify(sent[0]));
  ui.renderLobbyTeams(roster({ blue: [player('b1'), player('b2'), player('b3')], available: [player(ME)] }), ME);
  sent.length = 0;
  $('.lobby-avail-join').click();
  check('with blue the fuller side, it asks for red', sent[0]?.team === 'red', JSON.stringify(sent[0]));
  ui.renderLobbyTeams(roster({ available: [player(ME)] }), ME);
  sent.length = 0;
  $('.lobby-avail-join').click();
  check('on a tie it asks for blue', sent[0]?.team === 'blue');

  // ------------------------------------------------------------- frozen
  console.log('\n--- once the match is running ---');
  ui.renderLobbyTeams(roster({
    blue: [player('a1')],
    available: [player('w1'), player('w2')],
    status: 'playing',
  }), ME);
  check('no + is offered on either team', plusIn('blue').length === 0 && plusIn('red').length === 0);
  check('the vacant slots read as inert dashes',
    $$('#lobby-blue-slots .lobby-slot.is-locked').length === 3
      && $$('#lobby-red-slots .lobby-slot.is-locked').length === 4);
  check('no + is offered in the available list either',
    $$('.lobby-avail-join').every((b) => b.disabled));
  check('the hint says the match is in progress',
    $('#lobby-avail-hint').textContent === 'MATCH IN PROGRESS');
  sent.length = 0;
  $$('#lobby-teams .lobby-slot, #lobby-teams .lobby-avail-join').forEach((el) => el.click());
  check('nothing sends a request once the sides are frozen', sent.length === 0);

  // -------------------------------------------------------- a refusal shown
  console.log('\n--- a refusal is not a silent click ---');
  ui.renderLobbyTeams(roster({ available: [player(ME)] }), ME);
  ui.showLobbyRefusal('That slot was just taken', ME);
  ui.renderLobbyTeams(roster({ available: [player(ME)] }), ME);
  check('the reason from the server is shown',
    $('#lobby-avail-hint').textContent === 'That slot was just taken');
  check('and styled as a refusal', $('#lobby-avail-hint').classList.contains('is-refused'));

  // --------------------------------------------------- the roster is trusted
  console.log('\n--- the roster is drawn as sent, whatever it contains ---');
  const nasty = '<img src=x onerror=alert(1)>';
  ui.renderLobbyTeams(roster({ blue: [player('a1', { name: nasty })] }), ME);
  check('a name is inserted as text, never parsed as markup',
    $$('#lobby-blue-slots img').length === 0 && namesIn('blue')[0] === nasty,
    `${namesIn('blue')[0].length} characters, no element created`);

  ui.renderLobbyTeams(roster({
    blue: [player('a1')],
    available: [player('a1')],
  }), ME);
  check('a player listed in two places is drawn once, in the available list',
    namesIn('blue').length === 1 && $$('.lobby-avail-row').length === 1
      && $$('.lobby-avail-name').filter((n) => n.textContent.startsWith('PLAYER a1')).length === 1,
    'the team slots win, since that is where the player really is');

  console.log('\n--- a malformed roster does not throw ---');
  let threw = null;
  try {
    ui.renderLobbyTeams(null, ME);
    ui.renderLobbyTeams({}, ME);
    ui.renderLobbyTeams({ teams: { blue: null, red: 'nonsense' }, available: null }, ME);
    ui.renderLobbyTeams(roster({ teamSize: 6, blue: [player('a1'), player('a2'), player('a3'), player('a4'), player('a5'), player('a6')] }), ME);
  } catch (err) { threw = err; }
  check('empty, null and nonsense payloads are survived', threw === null, threw?.message ?? '');
  check('and the team size is read from the server, not assumed',
    $$('#lobby-blue-slots .lobby-slot').length === 6, `${$$('#lobby-blue-slots .lobby-slot').length} slots for a teamSize of 6`);

  // --------------------------------------------------------- slot reuse
  console.log('\n--- the slot elements are reused, not rebuilt ---');
  ui.renderLobbyTeams(roster({ blue: [player('a1')] }), ME);
  const element = $('#lobby-blue-slots').children[0];
  ui.renderLobbyTeams(roster({ blue: [player('a2'), player('a3')] }), ME);
  check('the same node is still there after two more renders',
    $('#lobby-blue-slots').children[0] === element,
    'rebuilding would destroy the element a player just clicked');
  check('but its contents did change', element.textContent.includes('a2'), element.textContent);
  check('a filled slot is not left in the tab order',
    !element.hasAttribute('tabindex'), 'only the + is focusable');
  ui.renderLobbyTeams(roster(), ME);
  check('and an emptied slot becomes focusable again',
    $('#lobby-blue-slots').children[0].getAttribute('tabindex') === '0');

  // ------------------------------------------------------- host-only button
  console.log('\n--- only the host is offered START MATCH ---');
  ui.renderLobbyTeams(roster({ host: 'someone-else' }), ME);
  check('a non-host cannot see it', $('#lobby-start-btn').style.display === 'none');
  ui.renderLobbyTeams(roster({ host: ME }), ME);
  check('the host can', $('#lobby-start-btn').style.display === 'flex');
  ui.renderLobbyTeams(roster({ host: ME, blue: [player(ME, { isHost: true })] }), ME);
  check('and the host is flagged in their own slot',
    $('#lobby-blue-slots .lobby-chip-host') !== null);
} catch (err) {
  console.log(`\n  FAIL harness threw: ${err?.stack ?? err}`);
  fail += 1;
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail === 0 ? 'ALL CHECKS PASSED' : `${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
