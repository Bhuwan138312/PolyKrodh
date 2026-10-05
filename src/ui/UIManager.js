import * as THREE from 'three';
import { GAME_CONFIG } from '../config.js';

// The two sides, in the order they are drawn. The left column is always blue and
// the right always red, so nothing here depends on who you are.
const LOBBY_TEAMS = Object.freeze(['blue', 'red']);

// How long a refusal from the server stays on screen.
const LOBBY_REFUSAL_MS = 4000;

export class UIManager {
  constructor({ audio, weaponConfig }) {
    this.audio = audio;
    this.weaponConfig = weaponConfig;
    this.screens = {
      loading: document.querySelector('#loading-screen'),
      menu: document.querySelector('#main-menu'),
      host: document.querySelector('#host-screen'),
      join: document.querySelector('#join-screen'),
      password: document.querySelector('#password-screen'),
      lobby: document.querySelector('#lobby-screen'),
      how: document.querySelector('#how-screen'),
      customControls: document.querySelector('#custom-controls-screen'),
      pause: document.querySelector('#pause-screen'),
      end: document.querySelector('#end-screen'),
      quit: document.querySelector('#quit-screen'),
    };
    this.hud = document.querySelector('#hud');
    this.healthValue = document.querySelector('#health-value');
    this.healthFill = document.querySelector('#health-fill');
    this.enemiesValue = document.querySelector('#enemies-value');
    this.ammoLabel = document.querySelector('.ammo-label');
    this.reloadFill = document.querySelector('#reload-fill');
    this.reloadCopy = document.querySelector('#reload-copy');
    this.reloadPrompt = document.querySelector('#reload-prompt');
    this.damageVignette = document.querySelector('#damage-vignette');
    this.crosshair = document.querySelector('#crosshair');
    // Gap = base + spread * scale. The shotgun's own values describe the much
    // wider pellet cone; see setCrosshairStyle.
    this.crosshairSpread = { base: 4, scale: 650 };
    this.hitMarker = document.querySelector('#hit-marker');
    this.weaponName = document.querySelector('#weapon-name');
    this.weaponOutlines = [
      document.querySelector('#weapon-outline-0'),
      document.querySelector('#weapon-outline-1'),
      document.querySelector('#weapon-outline-2'),
      document.querySelector('#weapon-outline-3')
    ];
    this.killFeed = document.querySelector('#kill-feed');
    this.duelBanner = document.querySelector('#duel-banner');
    this.captureHint = document.querySelector('#capture-hint');
    this.moveState = document.querySelector('#move-state');
    this.scopeReadout = document.querySelector('#scope-readout');
    this.scopeMask = document.querySelector('#scope-mask');
    this.sensitivity = document.querySelector('#sensitivity');
    this.sensitivityValue = document.querySelector('#sensitivity-value');
    this.controlsOverlay = document.querySelector('#controls-overlay');
    this.fpsCounter = document.querySelector('#fps-counter');
    this.difficulty = 'duel';
    this.map = 'arena';
    this.callbacks = {};
    this.hitMarkerTimer = 0;
    this.killTimers = new Set();
    // Team-lobby state. Deliberately only what the last snapshot said plus a
    // timestamped refusal message; the roster itself is never cached here,
    // because the server is the only authority on who is in which slot.
    this.lobbyTeamSize = 4;
    this.lobbyLocked = false;
    this.lobbyRefusal = null;
    this.lobbyTeamsEl = document.querySelector('#lobby-teams');
    this.bindButtons();
  }

  setCallbacks(callbacks) {
    this.callbacks = callbacks;
  }

  bindButtons() {
    document.querySelectorAll('.difficulty-button[data-difficulty]').forEach((button) => {
      button.addEventListener('click', () => {
        this.audio.resume();
        this.audio.play('ui');
        this.difficulty = button.dataset.difficulty;
        document.querySelectorAll('.difficulty-button[data-difficulty]').forEach((item) => item.classList.toggle('active', item === button));
      });
    });

    document.querySelectorAll('.krunker-map-card[data-map]').forEach((button) => {
      button.addEventListener('click', () => {
        this.audio.resume();
        this.audio.play('ui');
        this.map = button.dataset.map;
        document.querySelectorAll('.krunker-map-card[data-map]').forEach((item) => item.style.borderColor = (item === button) ? 'var(--color-primary)' : 'transparent');
      });
    });



    const actions = [
      ['#play-button', () => this.callbacks.startMatch?.(this.difficulty, this.map)],
      ['#host-button', () => this.show('host')],
      ['#host-cancel-btn', () => this.show('menu')],
      ['#host-confirm-btn', () => {
        const roomName = document.querySelector('#host-room-input').value.trim() || 'MyLobby';
        const password = document.querySelector('#host-password-input').value.trim();
        this.callbacks.hostMatch?.(roomName, password);
      }],
      ['#join-button', () => {
        this.show('join');
        this.refreshRoomList();
      }],
      ['#join-cancel-btn', () => this.show('menu')],
      ['#join-refresh-btn', () => this.refreshRoomList()],
      ['#password-cancel-btn', () => {
        document.querySelector('#join-password-input').value = '';
        document.querySelector('#password-error').style.display = 'none';
        this.show('join');
      }],
      ['#password-confirm-btn', () => {
        const password = document.querySelector('#join-password-input').value.trim();
        document.querySelector('#password-error').style.display = 'none';
        this.callbacks.joinMatch?.(this.pendingJoinRoomName, password);
      }],
      ['#lobby-start-btn', () => this.callbacks.startGame?.()],
      ['#lobby-leave-btn', () => this.callbacks.leaveLobby?.()],
      ['#how-button', () => {
        this.settingsSource = 'menu';
        this.show('how');
      }],
      ['#how-button-pause', () => {
        this.settingsSource = 'pause';
        this.show('how');
      }],
      ['#how-back-button', () => {
        if (this.settingsSource === 'pause') {
          this.show('pause');
        } else {
          this.show('menu');
        }
      }],
      ['#custom-controls-btn', () => this.show('customControls')],
      ['#custom-controls-back', () => this.show('how')],
      ['#quit-button', () => this.callbacks.quit?.()],
      ['#quit-back-button', () => this.callbacks.showMenu?.()],
      ['#resume-button', () => this.callbacks.resume?.()],
      ['#restart-button', () => this.callbacks.restart?.()],
      ['#pause-menu-button', () => this.callbacks.showMenu?.()],
      ['#again-button', () => this.callbacks.restart?.()],
      ['#end-menu-button', () => this.callbacks.showMenu?.()],
    ];
    actions.forEach(([selector, callback]) => {
      const button = document.querySelector(selector);
      button.addEventListener('click', () => {
        this.audio.resume();
        this.audio.play('ui');
        callback();
      });
    });

    // Team selection is delegated from the whole team area rather than bound per
    // slot, because the slot elements are reused across renders - a listener on
    // each one would have to be torn down and rebuilt on every snapshot.
    //
    // These clicks only send an intent. Nothing moves until the server has
    // checked the slot and broadcast the roster again, so a click that loses a
    // race simply redraws as it was instead of showing a team the player is not
    // actually in.
    this.lobbyTeamsEl?.addEventListener('click', (event) => {
      const target = event.target.closest('.lobby-slot.is-empty, .lobby-avail-join');
      if (!target || !this.lobbyTeamsEl.contains(target)) return;
      if (target.disabled) return;
      if (this.lobbyLocked) return;

      this.audio.resume();
      this.audio.play('ui');

      if (target.dataset.availJoin) {
        // No team named: the emptier one, so a single "+" cannot send a full team
        // sideways. The server still validates whichever slot it picks.
        this.callbacks.selectTeam?.({ team: this.preferredTeam(), slot: null });
        return;
      }

      const slot = Number(target.dataset.slot);
      if (!Number.isInteger(slot)) return;
      this.callbacks.selectTeam?.({ team: target.dataset.team, slot });
    });

    // The empty slots are divs so they can hold a name or a "+" without the
    // element changing type; give them keyboard access to match.
    this.lobbyTeamsEl?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const target = event.target.closest('.lobby-slot.is-empty');
      if (!target || !this.lobbyTeamsEl.contains(target)) return;
      event.preventDefault();
      target.click();
    });

    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');
    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        tabContents.forEach(c => c.classList.add('is-hidden'));
        
        btn.classList.add('active');
        document.querySelector(`#tab-${btn.dataset.tab}`).classList.remove('is-hidden');
      });
    });

    this.sensitivity.addEventListener('input', () => {
      const value = Number(this.sensitivity.value);
      this.sensitivityValue.value = value.toFixed(1);
      this.callbacks.setSensitivity?.(value);
    });

    const invertY = document.querySelector('#invert-y');
    if (invertY) {
      invertY.checked = localStorage.getItem('invertY') === 'true';
      invertY.addEventListener('change', (e) => {
        this.callbacks.setInvertY?.(e.target.checked);
      });
    }

    const graphicsBtns = document.querySelectorAll('.graphics-btn');
    if (graphicsBtns.length > 0) {
      const savedQuality = localStorage.getItem('graphicsQuality') || 'high';
      graphicsBtns.forEach(b => b.classList.toggle('active', b.dataset.quality === savedQuality));
      
      graphicsBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          graphicsBtns.forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          const val = btn.dataset.quality;
          localStorage.setItem('graphicsQuality', val);
          this.callbacks.setGraphicsQuality?.(val);
        });
      });
    }

    const savedBindings = JSON.parse(localStorage.getItem('bindings')) || {
      forward: 'KeyW', backward: 'KeyS', left: 'KeyA', right: 'KeyD', jump: 'Space', sprint: 'ShiftLeft', reload: 'KeyR'
    };

    const updateBindingUIs = (action, code) => {
      const displayStr = code.replace('Key', '').replace('Arrow', '');
      const rebindBtn = document.querySelector(`.keybind-btn[data-action="${action}"]`);
      if (rebindBtn) {
        rebindBtn.textContent = displayStr;
        rebindBtn.dataset.currentKey = displayStr;
      }
      const readKbd = document.querySelector(`kbd[data-read-action="${action}"]`);
      if (readKbd) readKbd.textContent = displayStr;
    };

    Object.entries(savedBindings).forEach(([action, code]) => updateBindingUIs(action, code));

    let activeRebindBtn = null;
    const rebindBtns = document.querySelectorAll('.keybind-btn');
    rebindBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        if (activeRebindBtn) activeRebindBtn.textContent = activeRebindBtn.dataset.currentKey;
        activeRebindBtn = btn;
        btn.dataset.currentKey = btn.textContent;
        btn.textContent = '...';
      });
    });

    window.addEventListener('keydown', (e) => {
      if (activeRebindBtn) {
        e.preventDefault();
        const code = e.code;
        if (code === 'Escape') {
          activeRebindBtn.textContent = activeRebindBtn.dataset.currentKey;
        } else {
          updateBindingUIs(activeRebindBtn.dataset.action, code);
          this.callbacks.setBinding?.(activeRebindBtn.dataset.action, code);
        }
        activeRebindBtn = null;
        return;
      }
      
      if (e.code === 'KeyH' && !e.repeat) {
        this.controlsOverlay?.classList.toggle('is-hidden');
      }
    });

    const searchInput = document.querySelector('#join-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        if (this.currentRooms) {
          this.renderRoomList(this.currentRooms, searchInput.value);
        }
      });
    }
  }

  async refreshRoomList() {
    const container = document.querySelector('#room-list-container');
    const searchInput = document.querySelector('#join-search-input');
    container.innerHTML = '<div style="color: rgba(255,255,255,0.5); text-align: center; margin-top: 20px;">LOADING SERVERS...</div>';
    
    try {
      const serverPort = window.location.port === '5173' ? ':3001' : (window.location.port ? ':' + window.location.port : '');
      const baseUrl = `${window.location.protocol}//${window.location.hostname}${serverPort}`;
      const res = await fetch(`${baseUrl}/rooms`);
      const rooms = await res.json();
      this.currentRooms = rooms;
      this.renderRoomList(rooms, searchInput.value);
    } catch (e) {
      container.innerHTML = '<div style="color: var(--amber); text-align: center; margin-top: 20px;">ERROR CONNECTING TO MASTER SERVER</div>';
    }
  }

  renderRoomList(rooms, filter = '') {
    const container = document.querySelector('#room-list-container');
    const filtered = rooms.filter(r => r.name.toLowerCase().includes(filter.toLowerCase()));
    
    if (filtered.length === 0) {
      container.innerHTML = '<div style="color: rgba(255,255,255,0.5); text-align: center; margin-top: 20px;">NO ROOMS FOUND</div>';
      return;
    }
    
    container.innerHTML = '';
    filtered.forEach(r => {
      const btn = document.createElement('button');
      btn.className = 'secondary-button';
      btn.style.width = '100%';
      btn.style.justifyContent = 'space-between';
      btn.style.padding = '12px 15px';
      btn.innerHTML = `<span style="font-family: monospace; font-size: 1.1rem; color: white;">${r.isPrivate ? '🔒 ' : ''}${r.name}</span><span style="color: var(--cyan);">${r.playerCount} PLAYERS</span>`;
      btn.onclick = () => {
        this.audio.play('ui');
        if (r.isPrivate) {
          this.pendingJoinRoomName = r.name;
          document.querySelector('#password-room-name').textContent = r.name;
          this.show('password');
        } else {
          this.callbacks.joinMatch?.(r.name, '');
        }
      };
      container.appendChild(btn);
    });
  }

  /**
   * Draws the team-selection lobby from one authoritative snapshot.
   *
   * The server owns who is in which slot; this only draws what it says. Nothing
   * here moves a player: a click sends an intent through `selectTeam`, and the
   * next snapshot is what actually changes the screen. That is why the renderer
   * trusts `state` completely and keeps no team state of its own.
   *
   * @param {object} state  a server `lobbyState` payload
   * @param {string} myId   our own socket id, so we can mark ourselves
   */
  renderLobbyTeams(state, myId) {
    if (!state || typeof state !== 'object') return;

    // The server decides how many slots a team has; the default only matters if
    // some other build sends a roster without saying.
    const size = Number.isInteger(state.teamSize) && state.teamSize > 0 ? state.teamSize : 4;
    this.lobbyTeamSize = size;
    // Once the match is running the sides are fixed, so nothing on this screen is
    // clickable any more.
    const locked = state.status === 'playing';
    this.lobbyLocked = locked;
    // Kept so `preferredTeam` can do its arithmetic from the same snapshot the
    // screen was just drawn from, instead of a second copy that could disagree.
    this.lobbyTeamsState = state;

    const taken = { blue: 0, red: 0 };
    for (const team of LOBBY_TEAMS) {
      const roster = Array.isArray(state.teams?.[team]) ? state.teams[team] : [];
      const slots = this.ensureTeamSlots(team, size);
      slots.forEach((el, index) => {
        const player = roster[index] ?? null;
        if (player) taken[team] += 1;
        this.paintSlot(el, team, index, player, myId, state.host, locked);
      });

      const count = document.querySelector(`#lobby-${team}-count`);
      if (count) count.textContent = `${taken[team]}/${size}`;
    }

    this.paintAvailable(state, myId, locked);
    this.paintLobbyHint(state, myId);

    // Show/hide start button depending on if we are the host.
    const startBtn = document.querySelector('#lobby-start-btn');
    if (startBtn) startBtn.style.display = state.host === myId ? 'flex' : 'none';
  }

  /**
   * Builds the eight slot elements once and then reuses them.
   *
   * The lobby re-renders on every snapshot, so rebuilding the buttons each time
   * would destroy the element the player just clicked and throw away keyboard
   * focus with it. The structure never changes; only the contents do.
   */
  ensureTeamSlots(team, size) {
    const host = document.querySelector(`#lobby-${team}-slots`);
    if (!host) return [];
    if (host.childElementCount !== size) {
      host.textContent = '';
      for (let i = 0; i < size; i += 1) {
        const slot = document.createElement('div');
        // A div, not a button: only the empty ones are interactive, and swapping
        // the element type per render is what would lose the click.
        slot.className = 'lobby-slot';
        host.appendChild(slot);
      }
    }
    return Array.from(host.children);
  }

  /** Fills one slot: a name, or a "+" when it is free and selectable. */
  paintSlot(el, team, index, player, myId, hostId, locked) {
    el.className = 'lobby-slot';
    el.textContent = '';
    delete el.dataset.team;
    delete el.dataset.slot;
    el.removeAttribute('role');
    // A slot that was empty was focusable, so drop it again once it fills - it
    // would otherwise stay in the tab order with nothing to do.
    el.removeAttribute('tabindex');
    el.removeAttribute('title');

    if (player) {
      el.classList.add('is-filled');
      el.appendChild(chip('lobby-slot-name', player.name || 'PLAYER'));
      if (player.id === myId) el.appendChild(chip('lobby-chip lobby-chip-you', 'YOU'));
      if (player.isHost || player.id === hostId) el.appendChild(chip('lobby-chip lobby-chip-host', 'HOST'));
      return;
    }

    if (locked) {
      el.classList.add('is-locked');
      el.textContent = '—';
      el.title = 'The sides are fixed once the match starts';
      return;
    }

    el.classList.add('is-empty');
    el.dataset.team = team;
    el.dataset.slot = String(index);
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.textContent = '+';
    el.title = `Join ${team} team`;
  }

  /** The middle column: everyone in the room who has not taken a side. */
  paintAvailable(state, myId, locked) {
    const list = document.querySelector('#lobby-avail-list');
    if (!list) return;

    const waiting = Array.isArray(state.available) ? state.available : [];
    list.textContent = '';

    for (const player of waiting) {
      const row = document.createElement('div');
      const isMe = player.id === myId;
      row.className = isMe ? 'lobby-avail-row is-you' : 'lobby-avail-row';

      row.appendChild(chip('lobby-avail-name', player.name || 'PLAYER'));
      if (isMe) row.appendChild(chip('lobby-chip lobby-chip-you', 'YOU'));
      if (player.isHost) row.appendChild(chip('lobby-chip lobby-chip-host', 'HOST'));

      const join = document.createElement('button');
      join.type = 'button';
      join.className = 'lobby-avail-join';
      join.textContent = '+';
      // Only you can put yourself on a team. The same "+" is drawn for everyone
      // so the column reads as one list, but on anyone else it is inert rather
      // than a control that would do nothing.
      join.disabled = locked || !isMe;
      if (isMe) {
        join.dataset.availJoin = '1';
        join.title = locked ? 'The sides are fixed once the match starts' : 'Take a team';
      } else {
        join.title = 'That player picks their own team';
      }
      row.appendChild(join);

      list.appendChild(row);
    }
  }

  /**
   * The line under the available list. Normally it just says what to do; a
   * refusal from the server is shown here instead so a click is never silent.
   */
  paintLobbyHint(state, myId) {
    const hint = document.querySelector('#lobby-avail-hint');
    if (!hint) return;

    // A refusal is dated rather than simply stored, because it arrives in the
    // same packet as the snapshot that would otherwise clear it on the way in.
    const refusal = this.lobbyRefusal;
    const isFresh = refusal && refusal.forId === myId && Date.now() - refusal.at < LOBBY_REFUSAL_MS;
    if (isFresh) {
      hint.textContent = refusal.reason;
      hint.classList.add('is-refused');
      return;
    }

    hint.classList.remove('is-refused');
    if (state.status === 'playing') {
      hint.textContent = 'MATCH IN PROGRESS';
    } else {
      const amIWaiting = (state.available ?? []).some((p) => p.id === myId);
      hint.textContent = amIWaiting ? 'PICK A TEAM' : 'WAITING FOR PLAYERS';
    }
  }

  /** Records why a team move was refused, so the hint can say it. */
  showLobbyRefusal(reason, forId) {
    this.lobbyRefusal = { reason, forId, at: Date.now() };
  }

  /**
   * Which team the available-list "+" should ask for: whichever has more room.
   *
   * A preference, not a decision. The server still picks the slot and can refuse,
   * which is what stops this from being a way to bypass the rules - it only
   * chooses which side to try. Ties go to blue, which is the left-hand column and
   * so the one this screen reads first.
   */
  preferredTeam() {
    const state = this.lobbyTeamsState;
    const free = (team) => {
      const roster = Array.isArray(state?.teams?.[team]) ? state.teams[team] : [];
      return Math.max(0, this.lobbyTeamSize - roster.filter(Boolean).length);
    };
    return free('blue') >= free('red') ? 'blue' : 'red';
  }

  finishLoading() {
    this.screens.loading.classList.add('is-hidden');
    this.show('menu');
  }

  show(name) {
    Object.entries(this.screens).forEach(([key, screen]) => {
      screen.classList.toggle('is-hidden', key !== name);
    });
    this.hud.classList.toggle('is-hidden', name !== null && name !== 'pause');
    if (name !== 'pause' && name !== null) this.hud.classList.add('is-hidden');
  }

  showHud() {
    Object.values(this.screens).forEach((screen) => screen.classList.add('is-hidden'));
    this.hud.classList.remove('is-hidden');
  }

  setHealth(current, maximum) {
    const rounded = Math.ceil(current);
    this.healthValue.textContent = String(rounded).padStart(3, '0');
    this.healthFill.style.transform = `scaleX(${Math.max(0, current / maximum)})`;
    this.healthFill.classList.toggle('critical', current / maximum < 0.3);
  }

  setEnemies(count) {
    this.enemiesValue.textContent = String(count).padStart(2, '0');
  }

  updateMultiplayerScores(myKills, myDeaths, otherKills, otherDeaths, otherCount) {
    const chip = this.enemiesValue.parentElement;
    if (chip) {
      chip.classList.add('tdm-mode');
      const label = chip.querySelector('span:nth-child(2)');
      const dot = chip.querySelector('.pulse-dot');
      if (dot) dot.style.display = 'none'; // Hide the pulse dot in TDM mode
      
      if (label) {
        if (otherCount === 1) {
          label.textContent = `YOU ${myKills} - ${otherKills} ENEMY`;
        } else {
          label.textContent = `KILLS ${myKills} - DEATHS ${myDeaths}`;
        }
      }
      this.enemiesValue.textContent = '';
    }
  }
  setAmmo(magazine, reserve, reloading = false, elapsed = 0, currentWeaponConfig = null, reloadDuration = null) {
    const config = currentWeaponConfig || this.weaponConfig;
    this.ammoLabel.childNodes[0].nodeValue = `${magazine} / `;
    const span = this.ammoLabel.querySelector('span');
    if (span) span.textContent = String(reserve);
    // A shotgun only holds 5, so a fixed "nearly empty" mark of 7 would paint
    // the counter red at all times; its own threshold is used instead.
    this.ammoLabel.classList.toggle('low', magazine <= (config.lowAmmoThreshold ?? 7));
    const hasReserve = reserve > 0;
    this.reloadPrompt.classList.toggle('visible', !reloading && magazine === 0 && hasReserve);
    this.reloadCopy.textContent = reloading
      ? 'RELOADING'
      : magazine === 0
        ? (hasReserve ? 'MAGAZINE EMPTY' : 'NO AMMO')
        : 'R  RELOAD';
    const duration = reloadDuration ?? config.reloadDuration;
    this.reloadFill.style.transform = `scaleX(${reloading ? Math.min(1, elapsed / duration) : magazine / config.magazineSize})`;
  }

  setActiveWeaponIcon(index, displayName = '') {
    this.weaponOutlines.forEach((icon, i) => {
      if (icon) icon.classList.toggle('active', i === index);
    });
    if (this.weaponName && displayName) {
      this.weaponName.textContent = displayName;
    }
    // Every weapon swap goes through here, so the crosshair style follows the
    // active weapon automatically.
    this.setCrosshairStyle(displayName);
  }

  /**
   * The shotgun gets the traditional four separated bars with an empty middle:
   * no dot, a wider body than the rifle crosshair, and a gap that follows the
   * pellet cone. Every other weapon keeps the standard crosshair.
   */
  setCrosshairStyle(displayName = '') {
    const shotgun = String(displayName).toLowerCase() === 'shotgun';
    this.crosshair.classList.toggle('shotgun-mode', shotgun);
    // The shotgun's reticle is a wide four-bar ring with a big empty middle, so
    // its gap has to be far larger than the rifle's few-pixel one.
    this.crosshairSpread = shotgun
      ? { base: 22, scale: 170 }
      : { base: 4, scale: 650 };
  }

  setMoveState(state) {
    if (this.moveState.textContent !== state) this.moveState.textContent = state;
  }

  /**
   * Shows what magnification the scope is set to, but only for a scoped weapon
   * and only while it is actually aimed. Called every frame, so it writes only
   * when something really changed - the text and the hidden flag are both
   * compared before touching the DOM, which keeps this off the hot path for
   * the three guns that have no optic.
   * `magnification` of 0 means the weapon has no scope at all.
   */
  setScopeReadout(magnification, scoped) {
    if (!this.scopeReadout) return;
    const text = magnification ? `${magnification}x` : '';
    const visible = Boolean(text) && scoped;
    if (this.scopeReadout.textContent !== text) this.scopeReadout.textContent = text;
    if (this.scopeReadout.hidden !== !visible) this.scopeReadout.hidden = !visible;
  }

  /**
   * Fades the screen-space scope in as a scoped weapon comes up to ADS.
   *
   * The sniper's eye ends up inside its own scope tube, so the 3D scope cannot
   * be drawn at full aim - you would be looking at the inside of the wall. This
   * overlay takes over instead, which is what a scope view actually is in every
   * shooter.
   *
   * It runs over the same eased raise as the gun and the zoom, so all three
   * arrive together, and it is deliberately NOT the whole raise: it stays
   * completely off while the rifle comes up, so that first beat is a normal
   * weapon raise you can actually see, and only then closes to full black.
   * Closing from the very first frame instead made the ADS read as a cut.
   * It reaches solid at `maskFull`, before WeaponSystem drops the viewmodel, so
   * the rifle is already behind black when it goes.
   */
  setScopeOverlay(scoped, amount) {
    if (!this.scopeMask) return;
    const { maskStart, maskFull } = GAME_CONFIG.player.ads.scopeOverlay;
    const span = Math.max(maskFull - maskStart, 1e-3);
    const fade = scoped ? THREE.MathUtils.clamp((amount - maskStart) / span, 0, 1) : 0;
    const on = fade > 0.001;
    if (this.scopeMask.hidden !== !on) this.scopeMask.hidden = !on;
    this.scopeMask.style.opacity = fade.toFixed(3);

    // The reticle is a child of the mask, so it fades in with it. The crosshair
    // has to be gone before that starts or the two are drawn on top of each
    // other, and its own 120ms CSS transition is far too slow to guarantee that
    // once the scope opens late in the raise - it would still be fading at
    // 153ms while the mask went solid at 83ms. So for a scoped weapon the
    // crosshair is driven from the same clock as the mask, fading out over the
    // raise itself and reaching zero exactly at `maskStart`, and its CSS
    // transition is switched off so there is only one thing setting its opacity.
    // Unscoped weapons keep the class-and-transition path in setADS, untouched.
    this.hud.classList.toggle('scope-mode', scoped);
    if (scoped) this.crosshair.style.opacity = (1 - Math.min(1, amount / maskStart)).toFixed(3);
    else this.crosshair.style.opacity = '';
  }

  setSpread(spread) {
    const { base, scale } = this.crosshairSpread;
    const pixels = base + spread * scale;
    this.crosshair.style.setProperty('--cross-gap', `${pixels.toFixed(1)}px`);
  }

  setADS(amount, scoped = false) {
    const ads = THREE.MathUtils.clamp(amount, 0, 1);
    // A scoped weapon does not use this path at all: its crosshair is driven
    // from setScopeOverlay, on the same clock as the mask, so that the crosshair
    // and the scope reticle never share the screen. Skipping the class here also
    // stops a stale `aim-mode` from a previously held unscoped weapon fighting
    // the inline opacity - setScopeOverlay clears it for scoped weapons.
    if (!scoped) this.hud.classList.toggle('aim-mode', ads > 0.45);
    else this.hud.classList.remove('aim-mode');
  }

  setDamageFlash(amount) {
    this.damageVignette.style.opacity = String(Math.min(1, amount));
  }

  setFPS(fps) {
    if (this.fpsCounter) this.fpsCounter.textContent = Math.round(fps);
  }

  setCaptureHint(visible) {
    this.captureHint.classList.toggle('is-hidden', !visible);
  }

  showHitMarker(headshot = false) {
    clearTimeout(this.hitMarkerTimer);
    this.hitMarker.classList.remove('active', 'headshot');
    void this.hitMarker.offsetWidth;
    this.hitMarker.classList.add('active');
    if (headshot) this.hitMarker.classList.add('headshot');
    this.hitMarkerTimer = setTimeout(() => this.hitMarker.classList.remove('active', 'headshot'), 150);
  }

  /**
   * Solo death-cam countdown. `null` hides it; a number shows that many
   * seconds remaining before the duel round respawns, and `killerName` names
   * the bot the camera is locked onto.
   */
  setDuelBanner(seconds, killerName = null) {
    if (!this.duelBanner) return;
    if (seconds === null || seconds === undefined) {
      this.duelBanner.classList.remove('visible');
      this.duelBanner.textContent = '';
      return;
    }
    this.duelBanner.classList.add('visible');
    const by = killerName ? ` BY ${killerName}` : '';
    this.duelBanner.innerHTML = `ELIMINATED${by}<strong>RESPAWN IN ${Math.max(1, Math.ceil(seconds))}</strong>`;
  }

  announceKill(killerName, victimName, weapon = 'assaultrifle', isKillerFriendly = true, isVictimFriendly = false) {
    const item = document.createElement('div');
    item.className = 'kill-item';

    const inner = document.createElement('div');
    inner.className = 'kill-item-inner';
    
    inner.innerHTML = `
      <div class="kill-killer ${isKillerFriendly ? 'friendly' : 'enemy'}"><span>${killerName}</span></div>
      <div class="kill-weapon"><img src="/pictures/${weapon}-outline.png" alt="weapon"/></div>
      <div class="kill-victim ${isVictimFriendly ? 'friendly' : 'enemy'}"><span>${victimName}</span></div>
    `;

    item.appendChild(inner);
    this.killFeed.prepend(item);
    requestAnimationFrame(() => item.classList.add('visible'));
    const removeTimer = setTimeout(() => {
      item.classList.remove('visible');
      const detachTimer = setTimeout(() => {
        item.remove();
        this.killTimers.delete(detachTimer);
      }, 220);
      this.killTimers.add(detachTimer);
      this.killTimers.delete(removeTimer);
    }, 4000);
    this.killTimers.add(removeTimer);
    while (this.killFeed.children.length > 5) this.killFeed.lastElementChild.remove();
  }

  resetMatchHud() {
    clearTimeout(this.hitMarkerTimer);
    this.killTimers.forEach((timer) => clearTimeout(timer));
    this.killTimers.clear();
    this.killFeed.replaceChildren();
    
    const chip = this.enemiesValue.parentElement;
    if (chip) {
      chip.classList.remove('tdm-mode');
      const label = chip.querySelector('span:nth-child(2)');
      const dot = chip.querySelector('.pulse-dot');
      if (label) label.textContent = 'HOSTILES';
      if (dot) dot.style.display = 'block';
    }

    this.hitMarker.classList.remove('active', 'headshot');
    this.reloadPrompt.classList.remove('visible');
    this.damageVignette.style.opacity = '0';
    this.captureHint.classList.add('is-hidden');
    this.setADS(0);
    // The scope overlay and its readout are driven per frame, so they have to
    // be torn down explicitly - otherwise pausing or ending a match while aimed
    // would leave a black scope stuck over the menu.
    this.setScopeOverlay(false, 0);
    this.setScopeReadout(0, false);
  }

  showEnd(won, kills, total, health) {
    const title = document.querySelector('#end-title');
    const subtitle = document.querySelector('#end-subtitle');
    const kicker = document.querySelector('#end-kicker');
    title.textContent = won ? 'MISSION COMPLETE' : 'MISSION FAILED';
    subtitle.textContent = won ? 'ARENA SECURED' : 'OPERATIVE DOWN';
    kicker.textContent = won ? 'MISSION REPORT // SUCCESS' : 'MISSION REPORT // FAILURE';
    document.querySelector('#end-kills').textContent = `${kills} / ${total}`;
    document.querySelector('#end-health').textContent = `${Math.ceil(health)}%`;
    document.querySelector('#again-button span').textContent = won ? 'PLAY AGAIN' : 'TRY AGAIN';
    document.querySelector('#end-screen').classList.toggle('victory', won);
    this.show('end');
  }
  showMultiplayerEnd(winnerId, stats, localId) {
    const title = document.querySelector('#end-title');
    const subtitle = document.querySelector('#end-subtitle');
    const kicker = document.querySelector('#end-kicker');
    
    const isWinner = winnerId === localId;
    title.textContent = isWinner ? 'VICTORY' : 'DEFEAT';
    subtitle.textContent = isWinner ? 'MATCH WON' : 'MATCH LOST';
    kicker.textContent = 'MULTIPLAYER REPORT';
    
    const myStats = stats[localId];
    document.querySelector('#end-kills').textContent = `${myStats ? myStats.kills || 0 : 0} KILLS`;
    document.querySelector('#end-health').textContent = `${myStats ? myStats.deaths || 0 : 0} DEATHS`;
    
    const againBtn = document.querySelector('#again-button span');
    againBtn.textContent = 'RETURN TO LOBBY';
    
    document.querySelector('#end-screen').classList.toggle('victory', isWinner);
    this.show('end');
  }
}

/**
 * A labelled span for the team lobby.
 *
 * Built as a node and filled with `textContent` rather than assembled into an
 * HTML string, because the text is a player name that came off the network: it
 * must never be parsed as markup, however the server sanitised it.
 */
function chip(className, text) {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}
