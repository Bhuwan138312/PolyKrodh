import * as THREE from 'three';

export class AudioManager {
  constructor() {
    this.context = null;
    this.master = null;
    this.noiseBuffer = null;
    this.volume = 0.72;
    this.lastFootstep = 0;
    this.listenerPosition = new THREE.Vector3();
    this.listenerForward = new THREE.Vector3(0, 0, -1);
    this.listenerRight = new THREE.Vector3(1, 0, 0);
  }

  async resume() {
    try {
      if (!this.context && !this.createContext()) return false;
      if (this.context.state === 'suspended') await this.context.resume();
      return this.context.state === 'running';
    } catch {
      return false;
    }
  }

  createContext() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return false;
    this.context = new AudioContextClass();
    this.master = this.context.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.context.destination);

    const length = Math.floor(this.context.sampleRate * 0.5);
    this.noiseBuffer = this.context.createBuffer(1, length, this.context.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;

    this.m4Buffer = null;
    this.glockBuffer = null;
    this.m4ReloadBuffer = null;
    this.shotgunBuffer = null;
    this.foot1Buffer = null;
    this.foot2Buffer = null;
    this.useFoot1 = true;
    this.jumpBuffer = null;
    this.emptyShotBuffer = null;
    this.loadCustomSounds();

    return true;
  }

  async loadCustomSounds() {
    try {
      const responseM4 = await fetch('/sounds/assultrifle.mp3');
      const arrayBufferM4 = await responseM4.arrayBuffer();
      this.m4Buffer = await this.context.decodeAudioData(arrayBufferM4);
    } catch (e) {
      console.warn('Failed to load custom M4 sound', e);
    }

    try {
      const responseSuppressed = await fetch('/sounds/supressed.mp3');
      const arrayBufferSuppressed = await responseSuppressed.arrayBuffer();
      this.suppressedBuffer = await this.context.decodeAudioData(arrayBufferSuppressed);
    } catch (e) {
      console.warn('Failed to load suppressed sound', e);
    }

    try {
      const responseGlock = await fetch('/sounds/GLOCKSOUND.mp3');
      const arrayBufferGlock = await responseGlock.arrayBuffer();
      this.glockBuffer = await this.context.decodeAudioData(arrayBufferGlock);
    } catch (e) {
      console.warn('Failed to load custom Glock sound', e);
    }

    try {
      const responseShotgun = await fetch('/sounds/shotgun.mp3');
      const arrayBufferShotgun = await responseShotgun.arrayBuffer();
      this.shotgunBuffer = await this.context.decodeAudioData(arrayBufferShotgun);
    } catch (e) {
      console.warn('Failed to load shotgun sound', e);
    }

    try {
      const responsePistolReload = await fetch('/sounds/reloadpistol.mp3');
      const arrayBufferPistolReload = await responsePistolReload.arrayBuffer();
      this.pistolReloadBuffer = await this.context.decodeAudioData(arrayBufferPistolReload);
    } catch (e) {
      console.warn('Failed to load pistol reload sound', e);
    }

    try {
      const responseM4Reload = await fetch('/sounds/reloadrifle.mp3');
      const arrayBufferM4Reload = await responseM4Reload.arrayBuffer();
      this.m4ReloadBuffer = await this.context.decodeAudioData(arrayBufferM4Reload);
    } catch (e) {
      console.warn('Failed to load M4 reload sound', e);
    }

    try {
      const responseFoot1 = await fetch('/sounds/foot1.mp3');
      const arrayBufferFoot1 = await responseFoot1.arrayBuffer();
      this.foot1Buffer = await this.context.decodeAudioData(arrayBufferFoot1);
    } catch (e) {
      console.warn('Failed to load foot1 sound', e);
    }

    try {
      const responseFoot2 = await fetch('/sounds/foot2.mp3');
      const arrayBufferFoot2 = await responseFoot2.arrayBuffer();
      this.foot2Buffer = await this.context.decodeAudioData(arrayBufferFoot2);
    } catch (e) {
      console.warn('Failed to load foot2 sound', e);
    }

    try {
      const responseJump = await fetch('/sounds/jump.mp3');
      const arrayBufferJump = await responseJump.arrayBuffer();
      this.jumpBuffer = await this.context.decodeAudioData(arrayBufferJump);
    } catch (e) {
      console.warn('Failed to load jump sound', e);
    }

    try {
      const responseEmpty = await fetch('/sounds/emptyshot.mp3');
      const arrayBufferEmpty = await responseEmpty.arrayBuffer();
      this.emptyShotBuffer = await this.context.decodeAudioData(arrayBufferEmpty);
    } catch (e) {
      console.warn('Failed to load empty shot sound', e);
    }
  }

  setVolume(value) {
    this.volume = THREE.MathUtils.clamp(value, 0, 1);
    if (this.master) this.master.gain.value = this.volume;
  }

  updateListener(camera) {
    if (!this.context) return;
    const listener = this.context.listener;
    const position = camera.getWorldPosition(new THREE.Vector3());
    const forward = camera.getWorldDirection(new THREE.Vector3());
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion()));
    this.listenerPosition.copy(position);
    this.listenerForward.copy(forward);
    this.listenerRight.crossVectors(forward, up).normalize();
    const now = this.context.currentTime;
    if (listener.positionX) {
      listener.positionX.setTargetAtTime(position.x, now, 0.02);
      listener.positionY.setTargetAtTime(position.y, now, 0.02);
      listener.positionZ.setTargetAtTime(position.z, now, 0.02);
      listener.forwardX.setTargetAtTime(forward.x, now, 0.02);
      listener.forwardY.setTargetAtTime(forward.y, now, 0.02);
      listener.forwardZ.setTargetAtTime(forward.z, now, 0.02);
      listener.upX.setTargetAtTime(up.x, now, 0.02);
      listener.upY.setTargetAtTime(up.y, now, 0.02);
      listener.upZ.setTargetAtTime(up.z, now, 0.02);
    } else {
      listener.setPosition(position.x, position.y, position.z);
      listener.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }

  play(name, worldPosition = null, options = {}) {
    if (!this.context || this.context.state !== 'running') return;
    let panner = null;
    try {
      panner = this.createPanner(worldPosition);
    } catch {
      panner = null;
    }
    const destination = panner || this.master;
    const now = this.context.currentTime + (options.delay || 0);
    const settings = {
      gunshot: () => this.gunshot(destination, now, 1, 130),
      m4_shot: () => this.m4_shot(destination, now, 1.2),
      shotgun_shot: () => this.shotgun_shot(destination, now, 1),
      shell_insert: () => this.click(destination, now, 1500, 0.03, 0.05),
      glock_shot: () => this.glock_shot(destination, now, 1.1),
      suppressed_shot: () => this.suppressed_shot(destination, now, 1.2),
      enemyShot: () => this.gunshot(destination, now, 0.62, 105),
      reload: () => this.reload(destination, now),
      reload_pistol: () => this.reload_pistol(destination, now),
      reload_m4: () => this.reload_m4(destination, now),
      dry: () => this.dry(destination, now),
      hit: () => this.tone(destination, now, 480, 260, 0.055, 0.075, 'square'),
      headshot: () => this.tone(destination, now, 860, 420, 0.07, 0.09, 'square'),
      damage: () => this.damage(destination, now),
      death: () => this.death(destination, now),
      jump: () => this.jump(destination, now),
      footstep: () => this.footstep(destination, now, options),
      ui: () => this.click(destination, now, 620, 0.028, 0.045),
      victory: () => this.victory(destination, now),
      defeat: () => this.defeat(destination, now),
    };
    try {
      settings[name]?.();
    } catch {
      // Audio must never take down the render loop in a restricted browser.
    }
  }

  createPanner(position) {
    if (!position) return null;
    const offset = new THREE.Vector3().subVectors(position, this.listenerPosition);
    const distance = offset.length();
    const spatialGain = this.context.createGain();
    const attenuation = distance > 70 ? 0 : Math.max(0.02, Math.exp(-distance * 0.045));
    spatialGain.gain.value = 1;
    spatialGain.__lpsSpatialGain = attenuation;

    if (this.context.createStereoPanner) {
      const panner = this.context.createStereoPanner();
      const direction = distance > 0.001 ? offset.multiplyScalar(1 / distance) : new THREE.Vector3();
      panner.pan.value = THREE.MathUtils.clamp(direction.dot(this.listenerRight), -0.82, 0.82);
      panner.connect(spatialGain);
    }
    spatialGain.connect(this.master);
    return spatialGain;
  }

  noise(destination, now, duration, gain, filterType, frequency) {
    const source = this.context.createBufferSource();
    source.buffer = this.noiseBuffer;
    const filter = this.context.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = frequency;
    const envelope = this.context.createGain();
    envelope.gain.setValueAtTime(Math.max(0.0001, gain * (pannerGain(destination))), now);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    source.connect(filter).connect(envelope).connect(destination);
    source.start(now, Math.random() * 0.25);
    source.stop(now + duration);
  }

  tone(destination, now, startFrequency, endFrequency, duration, gain, type = 'sine') {
    const oscillator = this.context.createOscillator();
    const envelope = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(startFrequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, endFrequency), now + duration);
    envelope.gain.setValueAtTime(Math.max(0.0001, gain * pannerGain(destination)), now);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(envelope).connect(destination);
    oscillator.start(now);
    oscillator.stop(now + duration);
  }

  click(destination, now, frequency, duration, gain) {
    this.tone(destination, now, frequency, frequency * 0.72, duration, gain, 'square');
  }

  gunshot(destination, now, strength, pitch) {
    const pannerGainValue = pannerGain(destination);
    const source = this.context.createBufferSource();
    source.buffer = this.noiseBuffer;
    const lowpass = this.context.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.setValueAtTime(2400, now);
    lowpass.frequency.exponentialRampToValueAtTime(420, now + 0.11);
    const envelope = this.context.createGain();
    envelope.gain.setValueAtTime(0.24 * strength * pannerGainValue, now);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    source.connect(lowpass).connect(envelope).connect(destination);
    source.start(now, Math.random() * 0.3);
    source.stop(now + 0.13);

    const oscillator = this.context.createOscillator();
    const bass = this.context.createGain();
    oscillator.frequency.setValueAtTime(pitch, now);
    oscillator.frequency.exponentialRampToValueAtTime(48, now + 0.085);
    bass.gain.setValueAtTime(0.19 * strength * pannerGainValue, now);
    bass.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
    oscillator.connect(bass).connect(destination);
    oscillator.start(now);
    oscillator.stop(now + 0.1);
  }

  m4_shot(destination, now, strength) {
    const pannerGainValue = pannerGain(destination);

    if (this.m4Buffer) {
      const source = this.context.createBufferSource();
      source.buffer = this.m4Buffer;
      const gain = this.context.createGain();
      gain.gain.value = 1.2 * strength * pannerGainValue;
      source.connect(gain).connect(destination);
      source.start(now);
      return;
    }

    this.gunshot(destination, now, strength * 0.8, 150);
  }

  /**
   * The shotgun blast. Gain sits between the suppressed rifle (0.5) and the
   * unsuppressed one (1.2) so the bigger sample never shouts over them.
   */
  shotgun_shot(destination, now, strength) {
    const pannerGainValue = pannerGain(destination);

    if (this.shotgunBuffer) {
      const source = this.context.createBufferSource();
      source.buffer = this.shotgunBuffer;
      const gain = this.context.createGain();
      gain.gain.value = 0.95 * strength * pannerGainValue;
      source.connect(gain).connect(destination);
      source.start(now);
      return;
    }

    // Fallback if the sample fails to load: a low, heavy thump.
    this.gunshot(destination, now, strength * 1.05, 95);
  }

  suppressed_shot(destination, now, strength) {
    const pannerGainValue = pannerGain(destination);

    if (this.suppressedBuffer) {
      const source = this.context.createBufferSource();
      source.buffer = this.suppressedBuffer;
      const gain = this.context.createGain();
      // Reduced by 30% (from 1.2 to 0.84)
      gain.gain.value = 0.50 * strength * pannerGainValue;
      source.connect(gain).connect(destination);
      source.start(now);
      return;
    }

    // Fallback if audio file fails to load
    this.gunshot(destination, now, strength * 0.4, 250);
  }

  glock_shot(destination, now, strength) {
    const pannerGainValue = pannerGain(destination);

    if (this.glockBuffer) {
      const source = this.context.createBufferSource();
      source.buffer = this.glockBuffer;
      const gain = this.context.createGain();
      gain.gain.value = 0.3 * strength * pannerGainValue; // Reduced volume by 15%
      source.connect(gain).connect(destination);
      source.start(now);
      return;
    }

    // Glock: Punchy, blunt, less high-frequency ringing
    const lowpass = this.context.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.setValueAtTime(2000, now);
    lowpass.frequency.exponentialRampToValueAtTime(300, now + 0.08);

    const envelope = this.context.createGain();
    envelope.gain.setValueAtTime(0.35 * strength * pannerGainValue, now);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + 0.1);

    source.connect(lowpass).connect(envelope).connect(destination);
    source.start(now, Math.random() * 0.3);
    source.stop(now + 0.11);

    // Lower body thump
    const oscillator = this.context.createOscillator();
    const bass = this.context.createGain();
    oscillator.frequency.setValueAtTime(140, now);
    oscillator.frequency.exponentialRampToValueAtTime(50, now + 0.06);
    bass.gain.setValueAtTime(0.3 * strength * pannerGainValue, now);
    bass.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
    oscillator.connect(bass).connect(destination);
    oscillator.start(now);
    oscillator.stop(now + 0.09);
  }

  reload(destination, now) {
    this.click(destination, now, 1150, 0.035, 0.07);
    this.click(destination, now + 0.72, 680, 0.045, 0.065);
    this.click(destination, now + 1.2, 920, 0.04, 0.06);
  }

  reload_pistol(destination, now) {
    if (this.pistolReloadBuffer) {
      const source = this.context.createBufferSource();
      source.buffer = this.pistolReloadBuffer;
      const gain = this.context.createGain();
      gain.gain.value = 1.0 * pannerGain(destination);
      source.connect(gain).connect(destination);
      source.start(now);
    } else {
      this.reload(destination, now);
    }
  }

  reload_m4(destination, now) {
    if (this.m4ReloadBuffer) {
      const source = this.context.createBufferSource();
      source.buffer = this.m4ReloadBuffer;
      const gain = this.context.createGain();
      gain.gain.value = 1.0 * pannerGain(destination);
      source.connect(gain).connect(destination);
      source.start(now);
    } else {
      this.reload(destination, now);
    }
  }

  dry(destination, now) {
    if (this.emptyShotBuffer) {
      const source = this.context.createBufferSource();
      source.buffer = this.emptyShotBuffer;
      const gain = this.context.createGain();
      gain.gain.value = 0.3 * pannerGain(destination); // Reduced volume by 40%
      source.connect(gain).connect(destination);
      source.start(now);
    } else {
      this.click(destination, now, 920, 0.035, 0.055);
    }
  }

  damage(destination, now) {
    const value = pannerGain(destination);
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = 'sawtooth';
    oscillator.frequency.setValueAtTime(110, now);
    oscillator.frequency.exponentialRampToValueAtTime(54, now + 0.2);
    gain.gain.setValueAtTime(0.12 * value, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    oscillator.connect(gain).connect(destination);
    oscillator.start(now);
    oscillator.stop(now + 0.23);
  }

  footstep(destination, now, options = {}) {
    if (now - this.lastFootstep < 0.16) return;
    this.lastFootstep = now;

    // Choose alternating buffer
    const buffer = this.useFoot1 ? this.foot1Buffer : this.foot2Buffer;
    this.useFoot1 = !this.useFoot1; // toggle for next step

    if (buffer) {
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      const gain = this.context.createGain();
      // Speed up audio when running to match the faster strides
      const speed = options.speed || 5.2;

      // Smooth blend factor between walking (5.2) and sprinting (8.0)
      const blend = Math.max(0, Math.min(1, (speed - 5.2) / (8.0 - 5.2)));

      // Increase walking sound speed slightly more (1.25x) and transition smoothly to sprint speed (1.5x)
      source.playbackRate.value = 1.25 + (1.50 - 1.25) * blend;

      // Dynamically adjust volume: softer when walking, louder when running for a natural transition
      gain.gain.value = (0.7 + 0.3 * blend) * pannerGain(destination);

      source.connect(gain).connect(destination);
      source.start(now);
    } else {
      this.noise(destination, now, 0.055, 0.035, 'bandpass', 220 + Math.random() * 80);
    }
  }

  jump(destination, now) {
    if (this.jumpBuffer) {
      const source = this.context.createBufferSource();
      source.buffer = this.jumpBuffer;
      const gain = this.context.createGain();
      gain.gain.value = 1.0 * pannerGain(destination);
      source.connect(gain).connect(destination);
      source.start(now);
    } else {
      this.tone(destination, now, 170, 250, 0.12, 0.035, 'sine');
    }
  }

  death(destination, now) {
    this.tone(destination, now, 160, 42, 0.32, 0.09, 'sawtooth');
    this.noise(destination, now, 0.24, 0.07, 'lowpass', 620);
  }

  victory(destination, now) {
    [392, 523, 659].forEach((frequency, index) => {
      this.tone(destination, now + index * 0.13, frequency, frequency, 0.28, 0.055, 'triangle');
    });
  }

  defeat(destination, now) {
    [220, 185, 131].forEach((frequency, index) => {
      this.tone(destination, now + index * 0.18, frequency, frequency * 0.92, 0.35, 0.05, 'triangle');
    });
  }
}

function pannerGain(destination) {
  return destination?.__lpsSpatialGain ?? 1;
}
