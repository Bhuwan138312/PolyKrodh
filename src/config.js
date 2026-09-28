export const GAME_CONFIG = Object.freeze({
  arenaHalfSize: 34,
  player: {
    health: 100,
    radius: 0.38,
    height: 1.78,
    eyeHeight: 1.62,
    walkSpeed: 5.2,
    sprintSpeed: 9.5,
    acceleration: 48,
    airAcceleration: 12,
    groundDamping: 12,
    airDamping: 1.2,
    gravity: 22,
    jumpSpeed: 7.25,
    stepHeight: 0.56,
    // Vertical movement is integrated in small substeps and the fall speed is
    // capped, so a fast drop can never pass through a thin floor or ledge.
    maxFallSpeed: 32,
    verticalSubstep: 0.16,
    ads: {
      transition: 0.18,
      fov: 68,
      movementMultiplier: 0.72,
      lookMultiplier: 0.68,
      swayMultiplier: 0.28,
      recoilMultiplier: 0.72,
      shakeMultiplier: 0.62,
      spreadMultiplier: 0.2,
    },
  },
  weapon: {
    magazineSize: 30,
    reserveSize: 120,
    maxReserve: 120,
    fireInterval: 0.095,
    reloadDuration: 1.25,
    bodyDamage: 34,
    headDamage: 68,
    range: 120,
    baseSpread: 0.0025,
    moveSpread: 0.012,
    recoilPitch: 0.024,
    recoilYaw: 0.01,
    mechanics: {
      projectile: {
        speed: 220,
        range: 120,
        length: 0.24,
        radius: 0.009,
        maxActive: 24,
        maxStepDistance: 2.5,
      },
      bolt: {
        duration: 0.082,
        travel: 0.42,
      },
      trigger: {
        duration: 0.055,
        travel: 0.16,
      },
      magazine: {
        removeStart: 0.10,
        removeEnd: 0.20,
        insertStart: 0.45,
        insertEnd: 0.65,
        cockStart: 0.80,
        cockEnd: 1.0,
        downDistance: 1.4,
        backwardDistance: 0.6,
      },
      shell: {
        speed: 1.35,
        lift: 1.05,
        backwardSpeed: 0.34,
        gravity: 9.8,
        lifetime: 1.8, // Shorter lifetime so they despawn faster
        maxActive: 16, // Heavily reduced active shells
      },
    },
  },
  /**
   * The pump shotgun. It is the only weapon with `pellets`, which turns one
   * trigger pull into a fan of projectiles that all leave the gun's own
   * bullet-spawn point. Each pellet carries its own slice of `bodyDamage`
   * (a single pellet can never land the whole blast, and pellets that miss
   * simply never contribute), and the tube holds 5 shells that are fed in one
   * at a time through the model's own shell-insert point.
   */
  shotgun: {
    magazineSize: 5,
    reserveSize: 30,
    maxReserve: 60,
    fireInterval: 0.68,
    // Per shell. The real reload length is derived from how many are missing.
    reloadDuration: 0.42,
    bodyDamage: 112,
    headDamage: 168,
    range: 60,
    baseSpread: 0.0025,
    moveSpread: 0.012,
    recoilPitch: 0.052,
    recoilYaw: 0.012,
    lowAmmoThreshold: 2,
    // A pump gun fires one shell per trigger pull, like the pistol.
    singleShot: true,
    pellets: {
      count: 8,
      // Half-angle of the cone the pellets fan out through.
      spread: 0.08,
      damageFalloffStart: 9,
      damageFalloffEnd: 26,
      damageFalloffMin: 0.3,
    },
    mechanics: {
      projectile: {
        speed: 190,
        range: 60,
        length: 0.1,
        radius: 0.006,
        maxActive: 96,
        maxStepDistance: 2.5,
        // Low-poly pellet look instead of the rifle tracer.
        style: 'pellet',
      },
      bolt: {
        duration: 0.1,
        travel: 0.36,
      },
      trigger: {
        duration: 0.055,
        travel: 0.14,
      },
      // Unused by the shotgun (it has no detachable magazine); kept so the
      // shared rig/hand code can never read undefined.
      magazine: {
        removeStart: 0.1,
        removeEnd: 0.2,
        insertStart: 0.45,
        insertEnd: 0.65,
        cockStart: 0.8,
        cockEnd: 1.0,
        downDistance: 1.2,
        backwardDistance: 0.4,
      },
      shell: {
        speed: 1.35,
        lift: 1.0,
        backwardSpeed: 0.34,
        gravity: 9.8,
        lifetime: 2.2,
        maxActive: 16,
      },
      // Tubular reload: one shell per `shellDuration` window.
      shellReload: {
        shellDuration: 0.42,
        // Where a fresh shell starts, relative to the shell-insert point.
        insertOffset: [0, -0.13, 0.07],
        insertRotation: [0.7, 0.3, 0.18],
      },
    },
  },
  secondaryWeapon: {
    magazineSize: 12,
    reserveSize: 60,
    maxReserve: 60,
    fireInterval: 0.18, // 220ms gap (approx 4.5 shots per second)
    reloadDuration: 1.25,
    bodyDamage: 25,
    headDamage: 50,
    range: 60,
    baseSpread: 0.005,
    moveSpread: 0.015,
    recoilPitch: 0.018,
    recoilYaw: 0.008,
    mechanics: {
      projectile: {
        speed: 150,
        range: 60,
        length: 0.15,
        radius: 0.007,
        maxActive: 12,
        maxStepDistance: 2.0,
      },
      bolt: { // For pistol slide
        duration: 0.1, // Set to 100ms as requested
        travel: 0.06, // Reduced travel distance
      },
      trigger: {
        duration: 0.055,
        travel: 0.05,
      },
      magazine: {
        removeStart: 0.1,
        removeEnd: 0.2,
        insertStart: 0.5,
        insertEnd: 0.8,
        cockStart: 0.85,
        cockEnd: 0.95,
        downDistance: 0.5,
        backwardDistance: 0.0,
      },
      shell: {
        speed: 1.0,
        lift: 1.2,
        backwardSpeed: 0.1,
        gravity: 9.8,
        lifetime: 1.5,
        maxActive: 8,
      },
    },
  },
  difficulties: {
    training: {
      label: 'TRAINING', count: 0, accuracy: 0,
      reactionMultiplier: 1, damageMultiplier: 1,
    },
    /**
     * The single-player duel: exactly one PRO bot. `botType` makes the spawner
     * ignore the random type rotation so the opponent is always the pro.
     * `easy`/`normal`/`hard` are kept as valid keys because multiplayer calls
     * startMatch('normal', ...); they are no longer offered in the solo menu.
     */
    duel: {
      label: '1V1 BOT', count: 1, accuracy: 0, botType: 'pro',
      reactionMultiplier: 1, damageMultiplier: 1,
    },
    easy: {
      label: 'EASY', count: 15, accuracy: -0.08,
      reactionMultiplier: 1.35, damageMultiplier: 0.75,
    },
    normal: {
      label: 'NORMAL', count: 20, accuracy: 0,
      reactionMultiplier: 1, damageMultiplier: 1,
    },
    hard: {
      label: 'HARD', count: 25, accuracy: 0.07,
      reactionMultiplier: 0.74, damageMultiplier: 1.12,
    },
  },
});

export const BOT_TYPES = Object.freeze({
  normal: {
    name: 'RIFLEMAN', color: 0x3c91a8, accent: 0x8bd9e8,
    health: 100, speed: 2.85, detection: 39, attackRange: 29,
    preferredRange: 15, reaction: [0.42, 0.72], fireInterval: [0.72, 1.02],
    accuracy: [0.70, 0.80], burst: [2, 4], damage: [8, 11], coverChance: 0.42,
  },
  aggressive: {
    name: 'BREACHER', color: 0xd7683f, accent: 0xffb05c,
    health: 88, speed: 4.05, detection: 37, attackRange: 18,
    preferredRange: 6.5, reaction: [0.32, 0.58], fireInterval: [0.58, 0.84],
    accuracy: [0.59, 0.69], burst: [2, 3], damage: [6, 9], coverChance: 0.2,
  },
  defensive: {
    name: 'SENTINEL', color: 0xc5a73d, accent: 0xffef86,
    health: 115, speed: 2.55, detection: 43, attackRange: 34,
    preferredRange: 23, reaction: [0.58, 0.88], fireInterval: [0.82, 1.2],
    accuracy: [0.77, 0.87], burst: [2, 3], damage: [10, 13], coverChance: 0.72,
  },
  /**
   * The 1v1 duel opponent. Tuned to take roughly 7 rifle body shots
   * (weapon.bodyDamage 34 -> 6 hits is 204, 7 hits is 238, so 210 needs 7).
   * `chaseSpeed` matches the player's sprintSpeed so it can run you down once
   * it has eyes on you, but it walks at a human `speed` when repositioning.
   */
  pro: {
    name: 'PRO', color: 0xb03a48, accent: 0xffd166,
    health: 210, speed: 4.6, chaseSpeed: 9.5,
    detection: 46, attackRange: 32,
    preferredRange: 10, reaction: [0.34, 0.6], fireInterval: [0.58, 0.84],
    accuracy: [0.66, 0.79], burst: [2, 4], damage: [7, 10], coverChance: 0.3,
  },
});
