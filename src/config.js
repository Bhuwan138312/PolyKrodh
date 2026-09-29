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
    // The hip-fire field of view. Every scoped weapon derives its zoomed FOV
    // from this number, so a magnification of 6 means "one sixth of this".
    baseFov: 90,
    ads: {
      // How long the raise itself takes, in seconds. This is a duration, not a
      // time constant: the interpolation below runs from 0 to 1 across it and
      // then stops, so the gun is genuinely in place on the frame it is due.
      transition: 0.18,
      fov: 68,
      movementMultiplier: 0.72,
      lookMultiplier: 0.68,
      swayMultiplier: 0.28,
      recoilMultiplier: 0.72,
      shakeMultiplier: 0.62,
      spreadMultiplier: 0.2,
      // How a scoped weapon enters its scope. Three beats, in this order:
      //
      //   1. The rifle comes up like any other gun's ADS, and is fully visible
      //      for that whole beat. Nothing is masked at all up to `maskStart`.
      //      Closing the mask immediately instead - which an earlier revision
      //      did, over 17ms - made the ADS feel like a cut rather than a move,
      //      because there was no weapon travel to read at all.
      //   2. The scope opens: the mask closes from `maskStart` to `maskFull`,
      //      about 65ms, over the same eased raise as the gun and the zoom, so
      //      all three arrive together.
      //   3. The rifle is dropped at `viewmodelHiddenAt`, which is after
      //      `maskFull`, so it is already behind solid black and cannot be seen
      //      going. On release it comes back at `viewmodelBackAt`, which is
      //      `maskFull`, so it is restored while the mask is still solid and
      //      then emerges as the vignette opens. The band between the two sits
      //      behind solid black, so toggling inside it cannot flicker.
      //
      // These are amounts, not milliseconds, so they ride the ease-out curve
      // rather than a wall clock: `amount` is what the weapon position, the
      // rotation and the zoom are all reading, so gating the mask on it is what
      // keeps the three in step. Converting a time to an amount is
      // `1 - (1 - ms / transition_ms)^2` inverted, i.e. 35ms of a 180ms raise
      // is 0.351 - hence `maskStart: 0.35`, which puts the first hint of vignette
      // at 35ms. The earlier 0.45 was ~47ms of actual delay, a frame or so late
      // against the intent.
      //
      // These are measured against the real sniper.glb vertices. At hip fire the
      // optic is already 83% inside the clear circle, so nothing can be done
      // about that - but its centre stays low and it grows downward and outward
      // rather than sweeping across, which is what leaves room for beat 1. Only
      // `Object_4` (a small corner, 0.44 x 0.98 NDC at its worst) and `Object_6`
      // (a 0.14 x 0.24 disc) newly enter the middle during the raise, and the
      // second not until ads 0.70 - by which point the mask is all but solid.
      scopeOverlay: {
        maskStart: 0.31,
        maskFull: 0.80,
        viewmodelHiddenAt: 0.87,
        viewmodelBackAt: 0.80,
      },
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
    // Minimum time between two shots while the trigger is held (~3 shells a
    // second). Holding the trigger keeps pumping at this rate.
    fireInterval: 0.32,
    // Per shell, and the source of the whole reload length: WeaponSystem derives
    // the duration from how many are missing, so a full tube takes 5 x 0.8 = 4s
    // and a single shell takes 4 / 5 = 0.8s. Kept here in step with
    // `mechanics.shellReload.shellDuration`, which is what the shell-loading
    // animation actually runs on.
    reloadDuration: 0.8,
    bodyDamage: 112,
    headDamage: 168,
    range: 60,
    baseSpread: 0.0025,
    moveSpread: 0.012,
    recoilPitch: 0.052,
    recoilYaw: 0.012,
    // Low ammo warning at 2 shells
    lowAmmoThreshold: 2,
    singleShot: false,
    // No reloadPose here on purpose. The shotgun used to carry one of its own,
    // which lifted and pushed the viewmodel forward to swing the loading port
    // into frame; it read as the weapon flying up and away, which is not how a
    // reload should look. It now takes the same mag-swap tilt every other gun
    // does - see the shared block in WeaponSystem.update - so the gun stays put
    // on screen and merely cants over while the shells go in.
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
      // Tubular reload: the tube gains one shell per `shellDuration` window. The
      // reload is four seconds for a full tube, so 4 / 5 = 0.8s per shell, and
      // the length scales with how many are actually missing - one shell is one
      // window, a full tube is five. The ammo is handed over by WeaponSystem
      // itself, so a model without a usable shell-insert point still reloads
      // correctly, just without the hand animation.
      shellReload: {
        shellDuration: 0.8,
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
  /**
   * The bolt-action sniper. It is the only weapon set to `singleShot`, so it
   * fires one round per click rather than spraying on a held trigger, and the
   * slow `fireInterval` is the bolt cycle being worked by hand between shots.
   *
   * Its `bolt.duration` is deliberately long. That timer drives two things at
   * once - the model's own `charging_bolt` animation and the shell eject - so
   * stretching it to just under half the fire interval gives the bolt a full,
   * readable lift-and-drop on every round while still completing before the
   * gun is allowed to fire again. A short bolt would look like the rifle's
   * snap and would make the gun feel like an assault rifle with a scope.
   */
  sniper: {
    magazineSize: 5,
    reserveSize: 30,
    maxReserve: 60,
    // The bolt cycle. Long enough that the handle visibly works after every
    // shot, and the cap that keeps a held trigger from queueing a second round.
    fireInterval: 0.85,
    // A detachable box on a bolt-action is a slow, deliberate reload.
    reloadDuration: 2.4,
    bodyDamage: 90,
    headDamage: 150,
    range: 200,
    // Almost no inherent wobble: it is meant to be the long-range answer, and
    // the move penalty is what stops it being the answer while sprinting.
    baseSpread: 0.0006,
    moveSpread: 0.016,
    recoilPitch: 0.085,
    recoilYaw: 0.016,
    lowAmmoThreshold: 1,
    singleShot: true,
    // The optic. A magnification of M shows a field of view of baseFov / M, so
    // against the 90-degree hip FOV: 2x -> 45, 4x -> 22.5, 6x -> 15. Only the
    // sniper has a scope; every other weapon falls back to the flat `ads.fov`.
    scope: {
      // Weakest setting first, so scrolling up always magnifies.
      magnifications: [2, 4, 6],
      // Powers up at 4x, the middle step. It is the setting you want for an
      // actual long-range shot, and the wheel is there to drop to 2x when the
      // target turns out to be close, without ever leaving the scope.
      defaultStep: 1,
      // A literal 6x on a 90 FOV is 15 degrees, which is already close to a
      // pinhole - below this the world stretches badly at the screen edges.
      minFov: 15,
    },
    mechanics: {
      projectile: {
        speed: 340,
        range: 200,
        length: 0.32,
        radius: 0.008,
        maxActive: 16,
        maxStepDistance: 2.5,
      },
      bolt: {
        // The pause between the shot and the handle moving. A bolt-action is
        // worked after firing, never during, so the gun sits still for a beat
        // first. 0.2s of dead time, then the 0.55s travel below.
        delay: 0.2,
        // 0.55s of bolt travel: up by 0.38, held, then eased back home.
        duration: 0.55,
        // A bolt-action handle is drawn straight back along the bore and returns
        // along the same line. Deliberately no rotation and no vertical
        // translation: on this model the node is the whole bolt carrier rather
        // than a small lever, so turning it swung the bolt around the receiver
        // and lifting it slid the assembly out of the top. A straight pull is
        // what this rig does well.
        travel: 0.25,
      },
      trigger: {
        duration: 0.055,
        travel: 0.14,
      },
      // Same detach-and-insert shape as the rifle, scaled for a bigger mag well.
      magazine: {
        removeStart: 0.1,
        removeEnd: 0.2,
        insertStart: 0.45,
        insertEnd: 0.65,
        cockStart: 0.8,
        cockEnd: 1.0,
        downDistance: 1.4,
        backwardDistance: 0.6,
      },
      shell: {
        // Thrown harder than any of the other three, which sit at 1.35 / 1.0 /
        // 1.0. A bolt-action case is dragged out of a tight chamber against
        // extractor tension rather than flicked by a slide, so it needs the
        // energy to clear the receiver at this scale - and the longer flight
        // time is what makes it read at all once it is this large.
        speed: 2.2,
        lift: 2.0,
        backwardSpeed: 0.55,
        gravity: 9.8,
        lifetime: 2.2,
        maxActive: 8,
        // The rifle has no shell mesh of its own, so it ejects the procedural
        // casing, and that one is the reference size every other weapon is
        // measured against. Scaled up because it is thrown across a long sight
        // picture and read at a distance, where a true-to-scale case is a
        // speck. An override rather than a change to the shared geometry, so
        // the three guns that eject their own modelled casings are untouched.
        size: 1.6,
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
   * The 1v1 duel opponent. It fights on exactly the player's terms: `health` is
   * the player's own max health and `damage` is the player's own weapon body
   * damage, so both sides need the same number of body shots and the bot has no
   * hidden extra survivability. There is no separate bot-only damage rule -
   * these are the same shared numbers, referenced rather than restated.
   * `chaseSpeed` matches the player's sprintSpeed so it can run you down once
   * it has eyes on you, but it walks at a human `speed` when repositioning.
   */
  pro: {
    name: 'PRO', color: 0xb03a48, accent: 0xffd166,
    health: GAME_CONFIG.player.health,
    speed: 4.6, chaseSpeed: 9.5,
    detection: 46, attackRange: 32,
    preferredRange: 10, reaction: [0.34, 0.6], fireInterval: [0.58, 0.84],
    accuracy: [0.66, 0.79], burst: [2, 4], coverChance: 0.3,
    // A body shot is worth the same to the bot as it is to the player.
    damage: [GAME_CONFIG.weapon.bodyDamage, GAME_CONFIG.weapon.bodyDamage],
  },
});

/**
 * How each weapon model is fitted to the screen, in the order the player picks
 * them. `targetLength` scales the asset to that length in its own space, and
 * `viewScale` scales the holder in front of the camera on top of it - a
 * viewmodel has to read at arm's length through a wide lens, which is why the
 * on-screen gun is much larger than a real one.
 *
 * This lives here, and not inline in Game.js, because the same four numbers also
 * decide how big a copy of the model is in a remote player's hands. A character
 * holding a gun is meant to be holding the gun you are holding, so both sizes
 * are read from this one list rather than kept in step by hand.
 */
export const WEAPON_MODELS = Object.freeze([
  Object.freeze({
    key: 'M416', displayName: 'M416', modelUrl: '/models/m416rifle.glb?v=4',
    targetLength: 1.15, viewScale: 1.15,
  }),
  Object.freeze({
    key: 'Pistol', displayName: 'Pistol', modelUrl: '/models/Pistol.glb',
    targetLength: 0.42, viewScale: 1.0,
  }),
  Object.freeze({
    key: 'Shotgun', displayName: 'Shotgun', modelUrl: '/models/shotgun.glb',
    targetLength: 1.45, viewScale: 1.34,
  }),
  Object.freeze({
    key: 'Sniper', displayName: 'Sniper', modelUrl: '/models/sniper.glb',
    targetLength: 1.66, viewScale: 1.15,
  }),
]);
