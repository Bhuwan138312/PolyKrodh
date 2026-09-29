/**
 * Team deathmatch scoreboard.
 *
 * A thin bar at the top of the HUD reading left to right as
 * [ BLUE 8 | TEAM 1 ]  [ 5:00 ]  [ TEAM 2 | RED 7 ].
 *
 * The sides are fixed and are never swapped: blue is always the player's own
 * team and always sits on the left, red is always the opponents and always sits
 * on the right. Nothing about who is winning, what a team is numbered, or how
 * many players there are can move them.
 *
 * This module is purely presentational. It derives nothing about the match: the
 * two scores are sums of the kills the server reported, and the clock is the
 * time since this client's match began. It has no effect on health, death, or
 * visibility, and it never decides who is alive.
 *
 * What "your team" means: a player the server labels with a `team` defines it,
 * and the blue figure is the total for every player sharing that team - true
 * team deathmatch. The server does not send one today, so with no team labels
 * the bar falls back to the only split the data actually supports: you against
 * everyone else. If the server ever starts sending `team`, this becomes real TDM
 * with no change here.
 */

const TEAM_LABELS = Object.freeze({ 1: 'TEAM 1', 2: 'TEAM 2' });

export class Scoreboard {
  constructor() {
    this.root = document.querySelector('#scoreboard');
    this.hud = document.querySelector('#hud');
    // Blue is on the left, red on the right. The ids are named by colour, not
    // by position, because the positions are fixed and the colours are what
    // could otherwise get confused.
    this.blueScoreEl = document.querySelector('#sb-score-blue');
    this.blueNameEl = document.querySelector('#sb-name-blue');
    this.redScoreEl = document.querySelector('#sb-score-red');
    this.redNameEl = document.querySelector('#sb-name-red');
    this.clockEl = document.querySelector('#sb-clock');

    // id -> { id, kills, deaths, team }
    this.players = new Map();
    this.myId = null;
    // Wall-clock start of the match, in ms. Null until the first snapshot.
    this.startedAt = null;
    this.lastClock = null;
  }

  /**
   * Clear all state and hide the bar (new match, left the room, match over).
   * The clock is cleared too, so the next match starts from zero rather than
   * inheriting the last one's elapsed time.
   */
  reset() {
    this.players.clear();
    this.myId = null;
    this.startedAt = null;
    this.lastClock = null;
    this.setActive(false);
    this.paint(0, 0, 0);
  }

  setActive(on) {
    this.hud?.classList.toggle('has-scoreboard', Boolean(on));
  }

  /**
   * Apply an authoritative snapshot of the room. Merged rather than replaced so
   * a momentarily short payload can never make the bar flicker.
   */
  sync(players, myId) {
    if (myId) this.myId = myId;
    if (this.startedAt === null && players && typeof players === 'object') this.startedAt = now();
    if (players && typeof players === 'object') {
      Object.keys(players).forEach((id) => {
        const info = players[id];
        if (!info) return;
        const prev = this.players.get(id);
        this.players.set(id, {
          id,
          kills: toCount(info.kills),
          deaths: toCount(info.deaths),
          // A server-sent team is always believed; anything else stays null and
          // the side is decided by `sideOf` below.
          team: normaliseTeam(info.team) ?? prev?.team ?? null,
        });
      });
    }
    this.render();
  }

  /** A player left the room - drop them and re-read the two totals. */
  remove(id) {
    if (typeof id !== 'string') return;
    this.players.delete(id);
    this.render();
  }

  /**
   * Liveness is tracked but has no effect on the bar. It is kept so `setDead`
   * stays a valid call site for the death and respawn events that fire it.
   */
  setDead(id, dead) {
    const entry = this.players.get(id);
    if (entry) entry.dead = Boolean(dead);
  }

  /**
   * Which team the local player is on, or null when the server has not said.
   * Null is not an error: it just means the bar falls back to you-versus-all.
   */
  myTeam() {
    return this.myId ? this.players.get(this.myId)?.team ?? null : null;
  }

  /**
   * The side an entry belongs to, from the player's point of view.
   *
   * With server teams this is a real team comparison. Without them there is only
   * one fact to go on - who the local player is - so the player's own tally is
   * blue and everyone else's is red.
   */
  sideOf(entry) {
    const myTeam = this.myTeam();
    if (myTeam === null) return entry.id === this.myId ? 'blue' : 'red';
    return entry.team === myTeam ? 'blue' : 'red';
  }

  /** The two totals, blue first because blue is always the player's side. */
  scores() {
    let blue = 0;
    let red = 0;
    this.players.forEach((entry) => {
      if (this.sideOf(entry) === 'blue') blue += entry.kills;
      else red += entry.kills;
    });
    return { blue, red };
  }

  /**
   * Which team each panel names.
   *
   * The left panel is always the player's team, so when the server does name
   * teams the player's team number decides the wording - never the position,
   * which stays fixed.
   */
  labels() {
    const myTeam = this.myTeam();
    if (myTeam === 1) return { left: TEAM_LABELS[1], right: TEAM_LABELS[2] };
    if (myTeam === 2) return { left: TEAM_LABELS[2], right: TEAM_LABELS[1] };
    return { left: TEAM_LABELS[1], right: TEAM_LABELS[2] };
  }

  render() {
    // Only claim HUD real estate when there is genuinely a match to report.
    this.setActive(this.players.size > 0);
    const { blue, red } = this.scores();
    this.paint(blue, red, this.elapsed());
  }

  paint(blue, red, seconds) {
    setScore(this.blueScoreEl, blue);
    setScore(this.redScoreEl, red);
    const { left, right } = this.labels();
    if (this.blueNameEl) this.blueNameEl.textContent = left;
    if (this.redNameEl) this.redNameEl.textContent = right;
    this.paintClock(seconds);
  }

  paintClock(seconds) {
    if (!this.clockEl) return;
    const text = formatClock(seconds);
    // Once a second is the only resolution a match clock needs, so the DOM is
    // left alone in between rather than rewritten 60 times a second.
    if (text === this.lastClock) return;
    this.lastClock = text;
    this.clockEl.textContent = text;
  }

  /** Seconds since this client's match began. */
  elapsed() {
    if (this.startedAt === null) return 0;
    return Math.max(0, (now() - this.startedAt) / 1000);
  }

  /**
   * Advances the clock. Called every frame; the DOM is only touched when the
   * displayed second actually changes.
   */
  tick() {
    if (this.startedAt === null) return;
    if (!this.hud?.classList.contains('has-scoreboard')) return;
    this.paintClock(this.elapsed());
  }
}

/** Writes a score, flashing it only when the number actually changes. */
function setScore(el, value) {
  if (!el) return;
  const text = String(value);
  if (el.textContent === text) return;
  el.textContent = text;
  bump(el);
}

/** Accepts 1/'blue'/2/'red' from the server; anything else is treated as unset. */
function normaliseTeam(value) {
  if (value === 1 || value === '1' || value === 'blue') return 1;
  if (value === 2 || value === '2' || value === 'red') return 2;
  return null;
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Seconds as m:ss, the format the clock uses. Rolls over at an hour. */
function formatClock(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

/** Re-trigger a one-shot CSS animation. */
function bump(el) {
  if (!el) return;
  el.classList.remove('is-bumped');
  void el.offsetWidth;
  el.classList.add('is-bumped');
}
