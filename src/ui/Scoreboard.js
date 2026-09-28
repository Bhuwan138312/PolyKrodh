/**
 * Multiplayer kill/death scoreboard.
 *
 * A full-width bar pinned to the top of the HUD, laid out like a
 * battle-royale team bar: you on the left, everyone else on the right, and a
 * live ALIVE counter in the middle.
 *
 * This module is purely presentational. It never derives state on its own -
 * it renders whatever the server last said via NetworkManager, so the bar can
 * only ever disagree with the authoritative score in the same way the rest of
 * the HUD does. It has no effect on health, death, or visibility.
 */
const MAX_ROWS = 5;
const MAX_NAME = 12;

export class Scoreboard {
  constructor() {
    this.root = document.querySelector('#scoreboard');
    this.hud = document.querySelector('#hud');
    this.mineEl = document.querySelector('#sb-rows-mine');
    this.enemyEl = document.querySelector('#sb-rows-enemy');
    this.aliveEl = document.querySelector('#sb-alive');
    this.centerEl = this.aliveEl ? this.aliveEl.parentElement : null;

    this.players = new Map(); // id -> { id, kills, deaths, dead }
    this.myId = null;
    this.rows = new Map();    // id -> { row, nameEl, killsEl, deathsEl, lastKills, lastDeaths }
    this.lastAlive = null;
  }

  /** Clear all state and hide the bar (new match, left the room, match over). */
  reset() {
    this.players.clear();
    this.rows.forEach(({ row }) => row.remove());
    this.rows.clear();
    this.myId = null;
    this.lastAlive = null;
    if (this.aliveEl) this.aliveEl.textContent = '0';
    this.setActive(false);
  }

  setActive(on) {
    this.hud?.classList.toggle('has-scoreboard', Boolean(on));
  }

  /**
   * Apply an authoritative snapshot of the room. Merged rather than replaced
   * so a momentarily short payload can never make the bar flicker empty.
   */
  sync(players, myId) {
    if (myId) this.myId = myId;
    if (players && typeof players === 'object') {
      Object.keys(players).forEach((id) => {
        const info = players[id];
        if (!info) return;
        const prev = this.players.get(id);
        this.players.set(id, {
          id,
          name: typeof info.name === 'string' ? info.name.slice(0, MAX_NAME) : null,
          kills: toCount(info.kills),
          deaths: toCount(info.deaths),
          // A snapshot without an explicit flag leaves the previous value alone.
          dead: typeof info.dead === 'boolean' ? info.dead : (prev ? prev.dead : false),
        });
      });
    }
    this.render();
  }

  /** Incremental liveness update, used by the death / respawn events. */
  setDead(id, dead) {
    if (typeof id !== 'string') return;
    const prev = this.players.get(id);
    if (!prev) return;
    prev.dead = Boolean(dead);
    this.render();
  }

  /** A player left the room - drop them from the board. */
  remove(id) {
    if (typeof id !== 'string') return;
    this.players.delete(id);
    const row = this.rows.get(id);
    if (row) {
      row.row.remove();
      this.rows.delete(id);
    }
    this.render();
  }

  /** Best players first; ties broken by fewest deaths. */
  ranked() {
    return [...this.players.values()].sort(
      (a, b) => b.kills - a.kills || a.deaths - b.deaths || a.id.localeCompare(b.id)
    );
  }

  displayName(entry) {
    if (entry.id === this.myId) return 'YOU';
    if (entry.name) return entry.name;
    return shortTag(entry.id);
  }

  render() {
    const ranked = this.ranked();
    const mine = ranked.filter((p) => p.id === this.myId);
    const others = ranked.filter((p) => p.id !== this.myId);
    const hidden = others.length - MAX_ROWS;

    // Only claim HUD real estate when there is genuinely a match to report.
    this.setActive(ranked.length > 1);

    this.paintColumn(mine, this.mineEl);
    this.paintColumn(others.slice(0, MAX_ROWS), this.enemyEl);
    if (hidden > 0) this.paintOverflow(this.enemyEl, hidden);
    else this.enemyEl?.querySelector('.sb-more')?.remove();
    this.dropStaleRows(ranked.slice(0, MAX_ROWS));

    const alive = ranked.filter((p) => !p.dead).length;
    if (this.aliveEl) this.aliveEl.textContent = String(alive);
    if (alive !== this.lastAlive) {
      this.lastAlive = alive;
      bump(this.centerEl);
    }
  }

  paintColumn(entries, container) {
    if (!container) return;
    const keep = new Set(entries.map((e) => e.id));
    container.querySelectorAll('.sb-entry').forEach((el) => {
      if (!keep.has(el.dataset.id)) el.remove();
    });
    entries.forEach((entry, index) => {
      const row = this.ensureRow(entry.id);
      row.nameEl.textContent = this.displayName(entry);
      row.row.classList.toggle('is-me', entry.id === this.myId);
      row.row.classList.toggle('is-dead', entry.dead);
      if (row.lastKills !== entry.kills) {
        row.killsEl.textContent = String(entry.kills);
        bump(row.killsEl);
        row.lastKills = entry.kills;
      }
      if (row.lastDeaths !== entry.deaths) {
        row.deathsEl.textContent = String(entry.deaths);
        row.lastDeaths = entry.deaths;
      }
      // Keep DOM order in sync with the ranking.
      if (container.children[index] !== row.row) {
        container.insertBefore(row.row, container.children[index] || null);
      }
    });
  }

  paintOverflow(container, count) {
    if (!container) return;
    let more = container.querySelector('.sb-more');
    if (!more) {
      more = document.createElement('div');
      // Deliberately not `.sb-entry`, so paintColumn's own pruning does not
      // delete and recreate this every render.
      more.className = 'sb-more';
      container.appendChild(more);
    }
    more.textContent = `+${count} MORE`;
  }

  ensureRow(id) {
    let entry = this.rows.get(id);
    if (entry) return entry;

    const row = document.createElement('div');
    row.className = 'sb-entry';
    row.dataset.id = id;

    const kills = document.createElement('span');
    kills.className = 'sb-kills';
    const name = document.createElement('span');
    name.className = 'sb-name';
    const deaths = document.createElement('span');
    deaths.className = 'sb-deaths';

    // DOM order is always [name, deaths, kills]; CSS mirrors the right column.
    row.append(name, deaths, kills);

    entry = { row, nameEl: name, killsEl: kills, deathsEl: deaths, lastKills: null, lastDeaths: null };
    this.rows.set(id, entry);
    return entry;
  }

  dropStaleRows(keep) {
    const ids = new Set(keep.map((e) => e.id));
    this.rows.forEach((entry, id) => {
      if (!ids.has(id)) {
        entry.row.remove();
        this.rows.delete(id);
      }
    });
  }
}

function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Fallback label for a player with no name. Socket ids are base64-ish and
 * routinely contain '-' and '_' (e.g. "l-R-SZw5Gse"), so strip the punctuation
 * before taking a tag - otherwise the bar reads "L-R-".
 */
function shortTag(id) {
  const clean = String(id).replace(/[^a-z0-9]/gi, '').toUpperCase();
  return clean.slice(0, 4) || '????';
}

/** Re-trigger a one-shot CSS animation. */
function bump(el) {
  if (!el) return;
  el.classList.remove('is-bumped');
  void el.offsetWidth;
  el.classList.add('is-bumped');
}
