import * as THREE from 'three';

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
    this.hitMarker = document.querySelector('#hit-marker');
    this.weaponName = document.querySelector('#weapon-name');
    this.weaponOutlines = [
      document.querySelector('#weapon-outline-0'),
      document.querySelector('#weapon-outline-1'),
      document.querySelector('#weapon-outline-2')
    ];
    this.killFeed = document.querySelector('#kill-feed');
    this.captureHint = document.querySelector('#capture-hint');
    this.moveState = document.querySelector('#move-state');
    this.sensitivity = document.querySelector('#sensitivity');
    this.sensitivityValue = document.querySelector('#sensitivity-value');
    this.controlsOverlay = document.querySelector('#controls-overlay');
    this.fpsCounter = document.querySelector('#fps-counter');
    this.difficulty = 'normal';
    this.map = 'arena';
    this.callbacks = {};
    this.hitMarkerTimer = 0;
    this.killTimers = new Set();
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

  updateLobbyPlayers(players, hostId, myId) {
    const container = document.querySelector('#lobby-players-container');
    container.innerHTML = '';
    
    Object.values(players).forEach((p, index) => {
      const div = document.createElement('div');
      div.style.padding = '10px 15px';
      div.style.background = 'rgba(0,0,0,0.4)';
      div.style.borderLeft = p.id === myId ? '3px solid var(--amber)' : '3px solid var(--cyan)';
      div.style.display = 'flex';
      div.style.justifyContent = 'space-between';
      div.style.fontFamily = 'monospace';
      
      const isHost = p.id === hostId;
      div.innerHTML = `
        <span style="color: white;">PLAYER ${index + 1} ${p.id === myId ? '<span style="color: var(--amber);">(YOU)</span>' : ''}</span>
        <span style="color: ${isHost ? 'var(--amber)' : 'var(--cyan)'};">${isHost ? 'HOST' : 'JOINED'}</span>
      `;
      container.appendChild(div);
    });
    
    // Show/hide start button depending on if we are the host
    const startBtn = document.querySelector('#lobby-start-btn');
    if (startBtn) {
      startBtn.style.display = myId === hostId ? 'flex' : 'none';
    }
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

  setAmmo(magazine, reserve, reloading = false, elapsed = 0, currentWeaponConfig = null) {
    const config = currentWeaponConfig || this.weaponConfig;
    this.ammoLabel.childNodes[0].nodeValue = `${magazine} / `;
    const span = this.ammoLabel.querySelector('span');
    if (span) span.textContent = String(reserve);
    this.ammoLabel.classList.toggle('low', magazine <= 7);
    const hasReserve = reserve > 0;
    this.reloadPrompt.classList.toggle('visible', !reloading && magazine === 0 && hasReserve);
    this.reloadCopy.textContent = reloading
      ? 'RELOADING'
      : magazine === 0
        ? (hasReserve ? 'MAGAZINE EMPTY' : 'NO AMMO')
        : 'R  RELOAD';
    this.reloadFill.style.transform = `scaleX(${reloading ? Math.min(1, elapsed / config.reloadDuration) : magazine / config.magazineSize})`;
  }

  setActiveWeaponIcon(index, displayName = '') {
    this.weaponOutlines.forEach((icon, i) => {
      if (icon) icon.classList.toggle('active', i === index);
    });
    if (this.weaponName && displayName) {
      this.weaponName.textContent = displayName;
    }
  }

  setMoveState(state) {
    if (this.moveState.textContent !== state) this.moveState.textContent = state;
  }

  setSpread(spread) {
    const pixels = 4 + spread * 650;
    this.crosshair.style.setProperty('--cross-gap', `${pixels.toFixed(1)}px`);
  }

  setADS(amount) {
    const ads = THREE.MathUtils.clamp(amount, 0, 1);
    this.hud.classList.toggle('aim-mode', ads > 0.45);
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

  announceKill(typeName = 'HOSTILE') {
    const item = document.createElement('div');
    item.className = 'kill-item';
    item.innerHTML = `<span>ELIMINATED</span><strong>${typeName}</strong>`;
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
    }, 1900);
    this.killTimers.add(removeTimer);
    while (this.killFeed.children.length > 4) this.killFeed.lastElementChild.remove();
  }

  resetMatchHud() {
    clearTimeout(this.hitMarkerTimer);
    this.killTimers.forEach((timer) => clearTimeout(timer));
    this.killTimers.clear();
    this.killFeed.replaceChildren();
    this.hitMarker.classList.remove('active', 'headshot');
    this.reloadPrompt.classList.remove('visible');
    this.damageVignette.style.opacity = '0';
    this.captureHint.classList.add('is-hidden');
    this.setADS(0);
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
}
