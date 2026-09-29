// Scratch check: read the real config the game ships and confirm the tubular
// reload timing is the 4s the design calls for, scaled by how many shells are
// actually missing. The per-shell value is what WeaponSystem multiplies, so the
// total falls out of the tube size rather than being hard-coded twice.
import { GAME_CONFIG } from './src/config.js';

const CONFIG = GAME_CONFIG.shotgun;
const per = CONFIG.mechanics.shellReload.shellDuration;
const size = CONFIG.magazineSize;

console.log(`magazine size       = ${size}`);
console.log(`shellDuration       = ${per}`);
console.log(`declared reloadDuration = ${CONFIG.reloadDuration}`);

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
};

for (const n of [1, 2, 3, 4, 5]) {
  console.log(`  ${n} shell${n === 1 ? '' : 's'} -> ${(n * per).toFixed(2)}s`);
}

console.log('');
check('a full tube reloads in 4s', size * per === 4, `${size} x ${per} = ${(size * per).toFixed(2)}s`);
check('one shell is a quarter-second short of that, i.e. 4/5', per === 4 / size, `${per} vs ${(4 / size).toFixed(4)}`);
check('the two duration fields agree', CONFIG.reloadDuration === per,
  `${CONFIG.reloadDuration} vs ${per}`);

// The shotgun must not carry a reload pose of its own. It took one that lifted
// and pushed the viewmodel forward, which read as the gun flying up and out of
// frame; it now shares the mag-swap tilt that every other weapon uses, so there
// is nothing left to translate the holder with.
check('the shotgun ships no reload pose of its own', CONFIG.reloadPose === undefined,
  CONFIG.reloadPose ? 'still present' : 'absent, so the shared tilt is all there is');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
