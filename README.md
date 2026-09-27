# POLY KRODH

A complete low-poly arena FPS built with Three.js and Vite. Fight three classes of AI bots across a compact city block, use cover and flanking routes, and clear the arena before the enemy does. The player weapon uses the supplied `m416.glb` model.

## Run locally

Requirements: Node.js 20.19+ (or 22.12+) and a modern browser with WebGL enabled.

```bash
npm install
npm run dev
```

Open the local URL printed by Vite (normally `http://localhost:5173`). Click **PLAY** to lock the mouse and deploy.

For a production build:

```bash
npm run build
npm run preview
```

The optimized build is written to `dist/`.

## Controls

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` | Move |
| Mouse | Look / aim |
| Left mouse | Fire |
| Right mouse | ADS / aim |
| `R` | Reload |
| `Space` | Jump |
| `Shift` | Sprint |
| `Esc` | Pause / release mouse |

If the mouse is released during a match, the game pauses. Click **RESUME** or the arena to capture it again.

## Gameplay

- **M416:** supplied GLB rifle model with named-part mechanics, visible first-person hands gripping the weapon, full-size view scaling, traveling projectiles spawned at `MuzzlePoint` and aimed at the camera/sight target, a working bolt, physical shell ejection from the GLB ejection point, a removable/replaceable magazine, 30-round capacity, 120-round reserve, automatic fire, recoil, spread, muzzle flash, and impact effects.
- **ADS / aim:** hold right mouse for a smooth 0.18-second transition, reduced FOV, tighter accuracy, lower recoil, slower movement, and red-dot alignment using the existing `ADSAim` reference when present or the GLB's red-dot reference otherwise.
- **Rifleman:** balanced range, health, and accuracy.
- **Breacher:** fast aggressive units that close distance; orange armor.
- **Sentinel:** durable long-range units that actively use cover; yellow armor.
- **AI:** staggered awareness checks, vision cones, line-of-sight raycasts, reaction delays, imperfect bursts, patrol/search states, A* grid pathfinding, stair routes for elevated positions, flanking positions, and cover cycles.
- **Difficulty:** Easy (6 bots), Normal (8), and Hard (9), with adjusted accuracy, reaction, and damage.

## Project structure

```text
public/models/m416.glb                Supplied M416 weapon asset
src/
├── config.js                 Gameplay and difficulty tuning
├── main.js                   Browser entry point
├── styles.css                HUD, menus, and responsive presentation
├── core/
│   ├── Game.js               Match lifecycle and game loop
│   ├── InputManager.js       Keyboard, mouse, and pointer lock
│   ├── AudioManager.js       Procedural Web Audio sound system
│   └── EffectPool.js         Tracers, impacts, and death particles
├── player/
│   ├── PlayerController.js         Movement, gravity, collision, and camera feel
│   ├── WeaponSystem.js             Rifle orchestration, holder, ammo, recoil, and firing
│   ├── GLBWeaponRig.js             Named GLB references and part animations
│   ├── WeaponProjectileSystem.js   Traveling projectile collision system
│   ├── ShellEjectionSystem.js      Casing spawn, physics, and cleanup
│   ├── WeaponHands.js              First-person hands and grip alignment
│   └── HealthSystem.js             Reusable player/bot health
├── enemies/
│   ├── EnemyAI.js            Bot behavior, combat, cover, and animation
│   └── BotSpawner.js         Match spawning and cleanup
├── navigation/
│   └── NavigationGrid.js     A* navigation and path smoothing data
├── world/
│   └── ArenaMap.js           Procedural map, props, cover, and spawn points
└── ui/
    └── UIManager.js          Menus, HUD, notifications, and match results
```

The arena, bots, effects, and sounds are generated in code. The rifle is loaded from `public/models/m416.glb` at runtime and falls back to the original procedural weapon only if the asset cannot be loaded. Named-part resolution prefers the expected names first, then the actual case-preserved names present in this GLB (`Shellejectionpoint`, `red_dot`, `adsaimpoint`, `Bulletshell`, and the existing M416 bolt/magazine nodes). The source `Bullet` and `Bulletshell` templates remain hidden and are cloned only for live shots and ejected casings. The resolver logs missing names and substitutions without renaming or flattening the source hierarchy; this GLB has no exact `GunBody`, `Trigger`, or `AimPoint` node.
