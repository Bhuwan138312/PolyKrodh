export class HealthSystem {
  constructor(maxHealth, onDamage = null, onDeath = null) {
    this.maxHealth = maxHealth;
    this.current = maxHealth;
    this.onDamage = onDamage;
    this.onDeath = onDeath;
    this.dead = false;
  }

  /**
   * Single source of truth for "still in play". Visibility and shooting both
   * read this instead of re-deriving liveness from a damage number, so a
   * non-lethal hit can never be mistaken for a death.
   */
  get isAlive() {
    return !this.dead && this.current > 0;
  }

  reset() {
    this.current = this.maxHealth;
    this.dead = false;
    this.onDamage?.(0, this.current);
  }

  damage(amount) {
    if (this.dead || !(amount > 0)) return false;
    const applied = Math.min(this.current, amount);
    this.current = Math.max(0, this.current - applied);
    this.onDamage?.(applied, this.current);
    if (this.current <= 0 && !this.dead) {
      this.dead = true;
      this.onDeath?.();
    }
    return true;
  }

  /**
   * Adopts a health value that came from an authoritative source (the
   * multiplayer server). Liveness is decided purely by that value, never by the
   * fact that a bullet connected, so taking damage below the death threshold
   * only ever moves the number.
   */
  setHealth(value) {
    if (!Number.isFinite(value)) return false;
    const next = Math.max(0, Math.min(this.maxHealth, value));
    const applied = Math.max(0, this.current - next);
    this.current = next;
    // A positive authoritative value revives us even if a local death flag was
    // left behind by a stale packet.
    if (this.dead && next > 0) this.dead = false;
    this.onDamage?.(applied, next);
    if (next <= 0 && !this.dead) {
      this.dead = true;
      this.onDeath?.();
    }
    return true;
  }

  /**
   * Applies an authoritative death verdict without pretending a hit did it.
   * Used when the server reports a player as dead.
   */
  kill() {
    if (this.dead && this.current <= 0) return false;
    this.current = 0;
    this.dead = true;
    this.onDamage?.(0, 0);
    this.onDeath?.();
    return true;
  }

  heal(amount) {
    this.current = Math.min(this.maxHealth, this.current + Math.max(0, amount));
  }

  get ratio() {
    return this.maxHealth > 0 ? this.current / this.maxHealth : 0;
  }
}
