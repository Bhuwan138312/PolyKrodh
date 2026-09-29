// Scratch harness: drives the shotgun's tubular reload through a whole tube of
// shells with real three.js, checking the things the build cannot - that it
// runs at all, that the round rides in the fist, and that it ends up inside the
// tube at the port the model actually ships.
import * as THREE from 'three';
import { WeaponHands, SHELL_LOAD_BEAT } from './src/player/WeaponHands.js';

// The values measured off shotgun.glb through WeaponSystem's real transform
// chain (see test_shotgun_nodes.cjs).
const PORT = new THREE.Vector3(-0.0088, 0.0370, 0.1592);
const TUBE_DIR = new THREE.Vector3(0, 0, -1);
const SHELL_LENGTH = 0.060;
const SHELL_RADIUS = 0.0092;
const MAGAZINE_SIZE = 5;
// 4s for a full tube, so 4 / 5 = 0.8s a shell - the same value
// `mechanics.shellReload.shellDuration` carries in config.js.
const INTERVAL = 0.8;

const model = new THREE.Group();
const asset = new THREE.Group();
const hands = new WeaponHands({ model, asset, isPistol: false, showRightHand: true });

const rest = hands.leftHandBasePos.clone();
const shell = hands.shellProp;
const prop = shell;
const up = new THREE.Vector3(0, 1, 0);
const shellQuat = new THREE.Quaternion().setFromUnitVectors(up, TUBE_DIR);

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
};

// The shell's nose in model space, given where the prop is parked.
const distToPort = () => prop.position.clone().addScaledVector(TUBE_DIR, SHELL_LENGTH / 2).distanceTo(PORT);
// Where the fist has to stand for the round's nose to be on the mouth.
const alignHandPoint = () => PORT.clone().addScaledVector(TUBE_DIR, -0.075);

console.log(`beat table: grab=${SHELL_LOAD_BEAT.grab} carry=${SHELL_LOAD_BEAT.carry} align=${SHELL_LOAD_BEAT.align} insert=${SHELL_LOAD_BEAT.insert} follow=${SHELL_LOAD_BEAT.follow}`);
console.log(`hand rest: [${rest.toArray().map((v) => v.toFixed(4)).join(', ')}]`);

console.log('\n--- hand leaves the grip and reaches for ammunition ---');
const sourceCentre = PORT.clone()
  .add(new THREE.Vector3(-0.10, -0.15, 0.10))
  .addScaledVector(TUBE_DIR, 0.075 - SHELL_LENGTH / 2);
let handLeftGrip = false;
let fistStayedEmpty = true;
let sawRoundAtSource = false;
for (let i = 0; i <= 10; i += 1) {
  const phase = (SHELL_LOAD_BEAT.grab * i) / 10;
  hands.updateShellLoad({ beat: 0, phase, delta: INTERVAL / 10, insertPoint: PORT, insertDir: TUBE_DIR });
  if (hands.leftHand.position.distanceTo(rest) > 0.05) handLeftGrip = true;
  if (phase < SHELL_LOAD_BEAT.grab && prop.visible) fistStayedEmpty = false;
}
// Just after the grab the round must be in the fist, at the ammunition.
hands.updateShellLoad({ beat: 0, phase: SHELL_LOAD_BEAT.grab + 0.01, delta: 0.002, insertPoint: PORT, insertDir: TUBE_DIR });
if (prop.visible && prop.position.distanceTo(sourceCentre) < 0.02) sawRoundAtSource = true;
check('hand leaves the grip during the reach', handLeftGrip);
check('fist stays empty all the way down to the belt', fistStayedEmpty);
check('round is picked up at the ammunition', sawRoundAtSource);

console.log('\n--- round rides in the fist all the way to the port ---');
let worstLag = 0;
let alwaysSquare = true;
for (let i = 0; i <= 40; i += 1) {
  const phase = SHELL_LOAD_BEAT.carry + ((0.90 - SHELL_LOAD_BEAT.carry) * i) / 40;
  hands.updateShellLoad({ beat: 0, phase, delta: INTERVAL / 40, insertPoint: PORT, insertDir: TUBE_DIR });
  if (prop.visible) {
    // Squared with the tube the whole time it is in the hand.
    if (prop.quaternion.angleTo(shellQuat) > 0.02) alwaysSquare = false;
    // Leading the fist by exactly the grip offset, so it is carried, not floating.
    const expected = hands.leftHand.position.clone().addScaledVector(TUBE_DIR, 0.075 - SHELL_LENGTH / 2);
    worstLag = Math.max(worstLag, prop.position.distanceTo(expected));
  }
}
check('round stays square with the tube axis', alwaysSquare);
check('round stays locked to the fist', worstLag < 0.001, `worst offset ${worstLag.toFixed(5)}`);

console.log('\n--- alignment and insertion at the model\'s own port ---');
hands.updateShellLoad({ beat: 0, phase: SHELL_LOAD_BEAT.align, delta: 0.001, insertPoint: PORT, insertDir: TUBE_DIR });
const atAlign = distToPort();
check('nose sits on the port mouth at align', atAlign < 0.002, `nose is ${(atAlign * 1000).toFixed(1)}mm off`);

// Step through the push itself rather than jumping past it.
let sawRoundTravelling = false;
for (let i = 0; i <= 10; i += 1) {
  const phase = SHELL_LOAD_BEAT.insert + ((SHELL_LOAD_BEAT.follow - SHELL_LOAD_BEAT.insert) * i) / 10;
  hands.updateShellLoad({ beat: 0, phase, delta: 0.001, insertPoint: PORT, insertDir: TUBE_DIR });
  if (prop.visible && distToPort() > atAlign + 0.002) sawRoundTravelling = true;
}
const atFollow = distToPort();
check('round is visibly pushed down the tube', sawRoundTravelling,
  `nose went from ${(atAlign * 1000).toFixed(1)}mm off the mouth to ${(atFollow * 1000).toFixed(1)}mm`);
check('round ends up fully inside the tube',
  hands.leftHand.position.distanceTo(alignHandPoint()) > SHELL_LENGTH * 0.98,
  `hand pushed ${(hands.leftHand.position.distanceTo(alignHandPoint()) * 1000).toFixed(1)}mm, round is ${(SHELL_LENGTH * 1000).toFixed(0)}mm`);
check('round is hidden once inside the tube', !prop.visible);
check('the hand is at the port, not the hip', hands.leftHand.position.distanceTo(rest) > 0.2);

console.log('\n--- every shell in a full tube ---');
let beatProblems = 0;
const notes = [];
for (let beat = 0; beat < MAGAZINE_SIZE; beat += 1) {
  // Each round runs its own beat back to back, exactly as the game drives it.
  // The first frame of a beat is the one that must not snap: it has to start
  // from wherever the previous round left the hand.
  const before = hands.leftHand.position.clone();
  hands.updateShellLoad({ beat, phase: 0, delta: 0.001, insertPoint: PORT, insertDir: TUBE_DIR });
  const jump = hands.leftHand.position.distanceTo(before);
  if (jump > 0.01) { beatProblems += 1; notes.push(`beat ${beat} start jumped ${(jump * 1000).toFixed(0)}mm`); }
  // The fist is empty at the start of a beat - the hand goes back for a NEW round
  // rather than reusing the one it just pushed in.
  if (prop.visible) { beatProblems += 1; notes.push(`beat ${beat} started with a round in the fist`); }

  for (let i = 1; i <= 20; i += 1) {
    hands.updateShellLoad({ beat, phase: (0.95 * i) / 20, delta: INTERVAL / 20, insertPoint: PORT, insertDir: TUBE_DIR });
  }
  if (prop.visible) { beatProblems += 1; notes.push(`beat ${beat} ended with a round still visible`); }
}
check('a full tube of five reloads cleanly', beatProblems === 0, notes.join('; '));

console.log('\n--- a full reload at 60fps, checking for snaps ---');
// Driven the way the game drives it: one frame at a time, phase advancing by
// delta / interval. Recorded per phase segment, because a frame's step has to
// be compared against the frames around it in the SAME segment - two segments
// are meant to differ in speed, and comparing across that boundary reports a
// discontinuity that is not one.
const segmentOf = (phase) => {
  if (phase < SHELL_LOAD_BEAT.grab) return 'reach';
  if (phase < SHELL_LOAD_BEAT.carry) return 'grab';
  if (phase < SHELL_LOAD_BEAT.align) return 'carry';
  if (phase < SHELL_LOAD_BEAT.insert) return 'align';
  if (phase < SHELL_LOAD_BEAT.follow) return 'insert';
  return 'follow';
};

hands.restLeftHand();
let previous = hands.leftHand.position.clone();
const frames = [];
let elapsed = 0;
let maxStep = 0;
let maxStepAt = '';
for (let beat = 0; beat < MAGAZINE_SIZE; beat += 1) {
  for (let frame = 0; frame < 40; frame += 1) {
    const delta = 1 / 60;
    elapsed += delta;
    const position = elapsed / INTERVAL;
    const whole = Math.floor(position);
    if (whole >= MAGAZINE_SIZE) break;
    const phase = position - whole;
    hands.updateShellLoad({
      beat: whole,
      phase,
      delta,
      insertPoint: PORT,
      insertDir: TUBE_DIR,
    });
    const step = hands.leftHand.position.distanceTo(previous);
    if (step > maxStep) { maxStep = step; maxStepAt = `beat ${whole} ${segmentOf(phase)}`; }
    frames.push({ step, segment: segmentOf(phase), beat: whole });
    previous = hands.leftHand.position.clone();
  }
}
const steps = frames.map((f) => f.step);
const median = [...steps].sort((a, b) => a - b)[Math.floor(steps.length / 2)];
// A teleport spikes in BOTH directions: one frame far larger than the frame
// before it and the frame after it. A ramp between two phases of different
// speeds only spikes one way.
//
// This is sampled at 240Hz, not 60Hz, on purpose. Each phase of a shell beat
// spans only a handful of frames at 60Hz, and over that few samples any curve
// looks lumpy - the test would be measuring the frame rate, not the animation.
// Oversampling gives each phase enough points to tell a smooth ease from a
// genuine discontinuity.
const SPIKE = 3;
let worstSpike = 0;
let spikeAt = null;
let smoothWorst = 0;
let sampleCount = 0;
{
  const sampleHands = new WeaponHands({ model: new THREE.Group(), asset: new THREE.Group(), isPistol: false });
  const dt = 1 / 240;
  let previousSample = sampleHands.leftHand.position.clone();
  const samples = [];
  let t = 0;
  for (let i = 0; i < 240 * 2; i += 1) {
    t += dt;
    const position = t / INTERVAL;
    const whole = Math.floor(position);
    if (whole >= MAGAZINE_SIZE) break;
    const phase = position - whole;
    sampleHands.updateShellLoad({
      beat: whole, phase, delta: dt, insertPoint: PORT, insertDir: TUBE_DIR,
    });
    samples.push({
      step: sampleHands.leftHand.position.distanceTo(previousSample),
      segment: segmentOf(phase),
    });
    previousSample = sampleHands.leftHand.position.clone();
  }
  sampleCount = samples.length;
  for (let i = 1; i < samples.length - 1; i += 1) {
    const { step, segment } = samples[i];
    if (step < 0.0015) continue;
    const ratio = Math.min(
      step / Math.max(samples[i - 1].step, 1e-6),
      step / Math.max(samples[i + 1].step, 1e-6),
    );
    if (segment === 'reach') smoothWorst = Math.max(smoothWorst, ratio);
    if (ratio > worstSpike) { worstSpike = ratio; spikeAt = { segment, index: i }; }
  }
  console.log(`  ${sampleCount} samples at 240Hz (${(sampleCount / (MAGAZINE_SIZE * INTERVAL * 240)).toFixed(0)} per shell)`);
}
const reachProfile = frames.filter((f) => f.segment === 'reach' && f.beat === 0)
  .map((f) => f.step * 1000);
console.log(`  frames=${frames.length} at 60fps, median step=${(median * 1000).toFixed(1)}mm max step=${(maxStep * 1000).toFixed(1)}mm (${maxStepAt})`);
console.log(`  first reach at 60fps, mm per frame: ${reachProfile.map((v) => v.toFixed(0)).join(' -> ')}`);
// An eased move accelerates and then decelerates, so its per-frame steps rise and
// then fall. A linear or instant move does not.
const risesThenFalls = reachProfile.length < 3
  || (reachProfile[1] >= reachProfile[0]
    && reachProfile[reachProfile.length - 2] >= reachProfile[reachProfile.length - 1]);
check('the long reach accelerates and decelerates', risesThenFalls,
  reachProfile.map((v) => v.toFixed(0)).join(' -> '));
check('no discontinuity in any phase, oversampled', worstSpike < SPIKE,
  `worst two-sided spike ${worstSpike.toFixed(1)}x`
  + (spikeAt ? ` in ${spikeAt.segment} at sample ${spikeAt.index}` : ''));
check('the reach is smooth, not stepped, oversampled', smoothWorst < 1.6,
  `worst two-sided spike in the reach ${smoothWorst.toFixed(2)}x`);
// A real teleport is bounded by the longest leg the hand covers, the belt-to-port
// reach of about 0.48 m. A single frame must never cover a large fraction of it.
check('no frame covers a whole leg in one go', maxStep < 0.26,
  `largest single-frame move ${(maxStep * 1000).toFixed(1)}mm of a ~480mm leg`);

console.log('\n--- a reload cut short does not snap the hand ---');
hands.updateShellLoad({ beat: -1, phase: 0, delta: 0.016, insertPoint: PORT, insertDir: TUBE_DIR });
let worstRestartJump = 0;
for (let i = 0; i <= 20; i += 1) {
  const before = hands.leftHand.position.clone();
  hands.updateShellLoad({ beat: 0, phase: (0.5 * i) / 20, delta: 0.012, insertPoint: PORT, insertDir: TUBE_DIR });
  worstRestartJump = Math.max(worstRestartJump, hands.leftHand.position.distanceTo(before));
}
// Same threshold as above: a 20ms step at 60fps covers a third of a beat, so a
// few centimetres of travel is normal and a teleport is not.
check('restarting mid-reload does not teleport the hand', worstRestartJump < 0.26,
  `largest single-frame move ${(worstRestartJump * 1000).toFixed(1)}mm`);

console.log('\n--- hand walks back to the grip after the last round ---');
let returnFrames = 0;
for (let i = 0; i < 40; i += 1) {
  hands.updateShellLoad({ beat: -1, phase: 0, delta: 0.016, insertPoint: PORT, insertDir: TUBE_DIR });
  returnFrames += 1;
  if (hands.leftHand.position.distanceTo(rest) < 1e-6) break;
}
check('hand returns to its rest pose', hands.leftHand.position.distanceTo(rest) < 1e-6, `took ${returnFrames} frames`);
check('no round left in the fist', !prop.visible);
const restQuatMatches = hands.leftHand.quaternion.angleTo(hands.leftHandBaseQuat) < 1e-6;
check('hand rotation returns to rest too', restQuatMatches);

console.log('\n--- a model with no loading port still reloads, hand stays put ---');
const noPortHands = new WeaponHands({ model: new THREE.Group(), asset: new THREE.Group(), isPistol: false });
for (let i = 0; i < 20; i += 1) {
  noPortHands.updateShellLoad({ beat: 0, phase: i / 19, delta: 0.012, insertPoint: null, insertDir: null });
}
check('no throw with a missing port', noPortHands.leftHand.position.distanceTo(noPortHands.leftHandBasePos) < 1e-6);
check('no round spawned without a port', !noPortHands.shellProp.visible);

console.log('\n--- ammo counts up on the push, totals unchanged ---');
// The grant rule from WeaponSystem.updateShellReload, driven at 60fps, checked
// against the totals and the timing of the old beat-boundary rule.
const grantableAt = (elapsed, needed) => Math.min(
  needed,
  Math.max(0, Math.floor(elapsed / INTERVAL - SHELL_LOAD_BEAT.insert) + 1),
);
let grantClock = 0;
let loaded = 0;
let firstGrant = null;
const heldAt = (time) => {
  let magazine = 0;
  let t = 0;
  while (t < time) {
    t += 1 / 60;
    magazine = grantableAt(t, MAGAZINE_SIZE);
  }
  return magazine;
};
// Long enough to cover a whole tube, which is MAGAZINE_SIZE * INTERVAL = 4s.
for (let i = 0; i < 60 * (MAGAZINE_SIZE * INTERVAL + 1); i += 1) {
  grantClock += 1 / 60;
  const next = grantableAt(grantClock, MAGAZINE_SIZE);
  if (next > loaded) {
    if (firstGrant === null) firstGrant = grantClock;
    loaded = next;
  }
}
check('a full tube still loads five shells', loaded === MAGAZINE_SIZE, `loaded ${loaded}`);
check('nothing is granted before the first push is due', heldAt(SHELL_LOAD_BEAT.insert * INTERVAL - 0.02) === 0,
  `had ${heldAt(SHELL_LOAD_BEAT.insert * INTERVAL - 0.02)} at ${((SHELL_LOAD_BEAT.insert * INTERVAL - 0.02) * 1000).toFixed(0)}ms`);
check('the first shell lands with the push, not on the beat line',
  firstGrant !== null && firstGrant >= SHELL_LOAD_BEAT.insert * INTERVAL - 1 / 60,
  `first grant at ${(firstGrant * 1000).toFixed(0)}ms, push due at ${(SHELL_LOAD_BEAT.insert * INTERVAL * 1000).toFixed(0)}ms`);
check('the last shell lands on the last push, inside the reload',
  heldAt(MAGAZINE_SIZE * INTERVAL - 0.02) === MAGAZINE_SIZE,
  `had ${heldAt(MAGAZINE_SIZE * INTERVAL - 0.02)} just before the reload ended`);
check('the count never exceeds the tube', (() => {
  let worst = 0;
  let t = 0;
  while (t < MAGAZINE_SIZE * INTERVAL) { t += 1 / 60; worst = Math.max(worst, grantableAt(t, MAGAZINE_SIZE)); }
  return worst === MAGAZINE_SIZE;
})());
check('a partly loaded tube only loads what is missing', grantableAt(9.99, MAGAZINE_SIZE - 3) === 2,
  `asked for 2 of the last 3 beats`);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
