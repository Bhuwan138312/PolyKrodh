export class InputManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set();
    this.mouseDelta = { x: 0, y: 0 };
    this.firing = false;
    this.ads = false;
    this.enabled = false;
    const savedSens = localStorage.getItem('sensitivity');
    this.sensitivity = savedSens !== null ? Number(savedSens) : 1;
    this.invertY = localStorage.getItem('invertY') === 'true';
    this.bindings = JSON.parse(localStorage.getItem('bindings')) || {
      forward: 'KeyW',
      backward: 'KeyS',
      left: 'KeyA',
      right: 'KeyD',
      jump: 'Space',
      sprint: 'ShiftLeft',
      reload: 'KeyR'
    };
    this.onEscape = null;
    this.onPointerLockChange = null;
    this.onPointerLockError = null;
    this.onAnyInteraction = null;
    this.onBlur = null;
    this.onScrollUp = null;
    this.onScrollDown = null;
    this.onKeyE = null;
    this.onKeyQ = null;

    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleKeyUp = this.handleKeyUp.bind(this);
    this.handleMouseMove = this.handleMouseMove.bind(this);
    this.handleMouseDown = this.handleMouseDown.bind(this);
    this.handleMouseUp = this.handleMouseUp.bind(this);
    this.handlePointerLock = this.handlePointerLock.bind(this);
    this.handlePointerLockError = this.handlePointerLockError.bind(this);
    this.handleCanvasClick = this.handleCanvasClick.bind(this);
    this.handleBlur = this.handleBlur.bind(this);
    this.handleWheel = this.handleWheel.bind(this);
    this.handleContextMenu = (event) => event.preventDefault();

    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('mousemove', this.handleMouseMove);
    window.addEventListener('mousedown', this.handleMouseDown);
    window.addEventListener('mouseup', this.handleMouseUp);
    document.addEventListener('pointerlockchange', this.handlePointerLock);
    document.addEventListener('pointerlockerror', this.handlePointerLockError);
    window.addEventListener('blur', this.handleBlur);
    canvas.addEventListener('click', this.handleCanvasClick);
    canvas.addEventListener('contextmenu', this.handleContextMenu);
    window.addEventListener('wheel', this.handleWheel, { passive: false });
  }

  handleKeyDown(event) {
    if (!this.enabled) return;
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) {
      event.preventDefault();
    }
    if (!this.keys.has(event.code)) this.pressed.add(event.code);
    this.keys.add(event.code);
    if (event.code === 'Escape' && !event.repeat) this.onEscape?.();
    if (event.code === 'Digit1' && !event.repeat) this.onDigit1?.();
    if (event.code === 'Digit2' && !event.repeat) this.onDigit2?.();
    if (event.code === 'Digit3' && !event.repeat) this.onDigit3?.();
    if (event.code === 'Digit4' && !event.repeat) this.onDigit4?.();
    if (event.code === 'KeyE' && !event.repeat) this.onKeyE?.();
    if (event.code === 'KeyQ' && !event.repeat) this.onKeyQ?.();
  }

  handleWheel(event) {
    if (!this.enabled) return;
    if (event.deltaY > 0) {
      this.onScrollDown?.();
    } else if (event.deltaY < 0) {
      this.onScrollUp?.();
    }
  }

  handleKeyUp(event) {
    this.keys.delete(event.code);
  }

  handleMouseMove(event) {
    if (!this.enabled || document.pointerLockElement !== this.canvas) return;
    const movementX = Number(event.movementX);
    const movementY = Number(event.movementY);
    if (!Number.isFinite(movementX) || !Number.isFinite(movementY)) return;
    this.mouseDelta.x += movementX * this.sensitivity;
    this.mouseDelta.y += movementY * this.sensitivity * (this.invertY ? -1 : 1);
  }

  handleMouseDown(event) {
    if (!this.enabled || document.pointerLockElement !== this.canvas) return;
    if (event.button === 0) this.firing = true;
    if (event.button === 2) this.ads = true;
  }

  handleMouseUp(event) {
    if (event.button === 0) this.firing = false;
    if (event.button === 2) this.ads = false;
  }

  handlePointerLock() {
    const locked = document.pointerLockElement === this.canvas;
    if (!locked) {
      this.firing = false;
      this.ads = false;
    }
    this.onPointerLockChange?.(locked);
  }

  handlePointerLockError() {
    this.firing = false;
    this.ads = false;
    this.onPointerLockError?.();
  }

  handleCanvasClick() {
    this.onAnyInteraction?.();
    if (this.enabled && document.pointerLockElement !== this.canvas) {
      this.requestPointerLock();
    }
  }

  handleBlur() {
    this.clear();
    this.onBlur?.();
  }

  requestPointerLock() {
    if (!this.enabled) return;
    if (typeof this.canvas.requestPointerLock !== 'function') {
      this.handlePointerLockError();
      return;
    }
    try {
      const result = this.canvas.requestPointerLock();
      if (result?.catch) result.catch(() => this.handlePointerLockError());
    } catch {
      this.handlePointerLockError();
    }
  }

  releasePointerLock() {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock?.();
  }

  isDown(code) {
    return this.keys.has(code);
  }

  wasPressed(code) {
    return this.pressed.has(code);
  }

  getMovement() {
    const x = Number(this.isActionDown('right')) - Number(this.isActionDown('left'));
    const z = Number(this.isActionDown('forward')) - Number(this.isActionDown('backward'));
    const length = Math.hypot(x, z);
    return length > 1 ? { x: x / length, z: z / length } : { x, z };
  }

  consumeMouseDelta() {
    const delta = { ...this.mouseDelta };
    this.mouseDelta.x = 0;
    this.mouseDelta.y = 0;
    return delta;
  }

  endFrame() {
    this.pressed.clear();
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) this.clear();
  }

  setBinding(action, code) {
    this.bindings[action] = code;
    localStorage.setItem('bindings', JSON.stringify(this.bindings));
  }

  setInvertY(invert) {
    this.invertY = invert;
    localStorage.setItem('invertY', invert);
  }

  setSensitivity(value) {
    this.sensitivity = value;
    localStorage.setItem('sensitivity', value);
  }

  isActionDown(action) {
    return this.isDown(this.bindings[action]);
  }

  wasActionPressed(action) {
    return this.wasPressed(this.bindings[action]);
  }

  clear() {
    this.keys.clear();
    this.pressed.clear();
    this.firing = false;
    this.ads = false;
    this.mouseDelta.x = 0;
    this.mouseDelta.y = 0;
  }
}
