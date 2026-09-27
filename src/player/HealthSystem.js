export class HealthSystem {
  constructor(maxHealth, onDamage = null, onDeath = null) {
    this.maxHealth = maxHealth;
    this.current = maxHealth;
    this.onDamage = onDamage;
    this.onDeath = onDeath;
    this.dead = false;
  }

  reset() {
    this.current = this.maxHealth;
    this.dead = false;
    this.onDamage?.(0, this.current);
  }

  damage(amount) {
    if (this.dead || amount <= 0) return false;
    const applied = Math.min(this.current, amount);
    this.current = Math.max(0, this.current - applied);
    this.onDamage?.(applied, this.current);
    if (this.current <= 0 && !this.dead) {
      this.dead = true;
      this.onDeath?.();
    }
    return true;
  }

  heal(amount) {
    this.current = Math.min(this.maxHealth, this.current + Math.max(0, amount));
  }

  get ratio() {
    return this.maxHealth > 0 ? this.current / this.maxHealth : 0;
  }
}
