// Scratch tool: resolve the scoreboard's real layout, the way the browser would,
// and report the box each piece ends up in. This is the check that catches a
// panel silently rendering the wrong colour, which reading the stylesheet cannot.
import fs from 'fs';

const css = fs.readFileSync('src/styles.css', 'utf8').replace(/\r\n/g, '\n');
const html = fs.readFileSync('index.html', 'utf8').replace(/\r\n/g, '\n');

const c = css.indexOf('   Team deathmatch scoreboard.');
const d = css.indexOf('\n.hud-top-left {', c);
// Comments are stripped first: a `/* ... */` sitting between a declaration and
// the next would otherwise hide it from the declaration parser below.
const board = css.slice(c, d).replace(/\/\*[\s\S]*?\*\//g, '');

// Every custom property the bar relies on, resolved once.
const varOf = (name) => {
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(board);
  return m ? m[1].trim() : null;
};
const V = {
  red: varOf('--tdm-red'),
  blue: varOf('--tdm-blue'),
  hud: varOf('--tdm-hud'),
  deep: varOf('--tdm-hud-deep'),
  edge: varOf('--tdm-edge'),
  cut: varOf('--tdm-cut'),
};

const ruleOf = (sel) => {
  const at = board.indexOf(sel);
  if (at < 0) return null;
  const from = board.indexOf('{', at);
  const to = board.indexOf('}', from);
  return board.slice(from + 1, to);
};
const decl = (body, prop) => {
  if (!body) return null;
  const m = new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`).exec(body);
  return m ? m[1].trim() : null;
};
const px = (v) => (v == null ? null : Number.parseFloat(v));
const rgba = (v) => {
  if (v == null) return null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
  if (hex) {
    const s = hex[1].length === 3 ? hex[1].split('').map((x) => x + x).join('') : hex[1];
    const n = Number.parseInt(s, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const m = /rgba?\(([^)]+)\)/.exec(v);
  if (!m) return null;
  const [r, g, b, a] = m[1].split(',').map((x) => Number.parseFloat(x));
  return { r, g, b, a: a === undefined ? 1 : a };
};

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
};

console.log('--- the colour variables the bar is built from ---');
Object.entries(V).forEach(([k, v]) => console.log(`   --tdm-${k.padEnd(9)} = ${v}`));

console.log('\n--- what colour does each score panel actually paint? ---');
// This is the reported bug. `background: currentColor` on an element that also
// declares `color: #fff` resolves against the element's OWN colour, so the panel
// came out white and the white numeral on it was invisible.
const scoreBody = ruleOf('.tdm-score');
const scoreBg = decl(scoreBody, 'background');
const scoreColor = decl(scoreBody, 'color');
// Blue is the base card and red overrides --team, so blue's colour comes from
// the `.tdm-team` rule and red's from the `.tdm-red` rule beside it.
const blueTeamVar = decl(ruleOf('.tdm-team'), '--team');
const redTeamVar = decl(ruleOf('.tdm-red'), '--team');
const accentBody = ruleOf('.tdm-accent');
const accentBg = decl(accentBody, 'background');

// `.tdm-score` asks for var(--team), which each side sets to its own colour, so
// the fill is resolved per side rather than once: blue's --team and red's --team
// are different declarations of the same name.
const resolveTeam = (declaration) => {
  const name = /var\((--[a-z-]+)\)/.exec(declaration ?? '')?.[1];
  if (!name) return declaration ?? null;
  const key = name.replace('--tdm-', '');
  return V[key] !== undefined ? V[key] : null;
};
const blueFill = resolveTeam(blueTeamVar);
const redFill = resolveTeam(redTeamVar);

console.log(`   .tdm-score  background = ${scoreBg}   color = ${scoreColor}`);
console.log(`   .tdm-team   --team     = ${blueTeamVar}  -> ${blueFill}   (LEFT, the player)`);
console.log(`   .tdm-red    --team     = ${redTeamVar}  -> ${redFill}   (RIGHT, the opponents)`);

check('the score panel is not painted with its own text colour', scoreBg !== 'currentColor',
  'currentColor on an element that sets color: #fff paints the panel white');
check('the score takes its colour from the team, not from its own text', scoreBg === 'var(--team)',
  `${scoreBg}`);
check('the BLUE left panel paints blue', blueFill === V.blue, `${blueFill}`);
check('the RED right panel paints red', redFill === V.red, `${redFill}`);
check('the two panels are different colours', redFill !== blueFill);
check('the accent line shares the panel colour', accentBg === scoreBg, `${accentBg}`);
const redRgb = rgba(redFill);
const whiteScore = rgba(scoreColor);
check('the numeral is white, so it reads on the colour',
  whiteScore.r === 255 && whiteScore.g === 255 && whiteScore.b === 255
  && (redRgb.r + redRgb.g + redRgb.b) / 3 < 140,
  `white on rgb(${redRgb.r}, ${redRgb.g}, ${redRgb.b})`);

console.log('\n--- the slab and the clock are dark, not grey ---');
const teamBg = rgba(V.hud);
const deepBg = rgba(V.deep);
check('the team slab is a cool near-black', teamBg.r < 20 && teamBg.g < 22 && teamBg.b < 26,
  `rgb(${teamBg.r}, ${teamBg.g}, ${teamBg.b})`);
check('it is nearly neutral, not tinted grey', Math.abs(teamBg.r - teamBg.g) <= 4 && teamBg.b - teamBg.g <= 6,
  'a few units of blue, which is what stops it reading as flat grey');
check('it is translucent', teamBg.a > 0.7 && teamBg.a < 0.95, `alpha ${teamBg.a}`);
check('the clock is darker than the teams', deepBg.r < teamBg.r && deepBg.a >= teamBg.a,
  `clock rgb(${deepBg.r}, ${deepBg.g}, ${deepBg.b}) a${deepBg.a}`);

console.log('\n--- resolving the layout to actual boxes ---');
const a = html.indexOf('<div id="scoreboard"');
const b = html.indexOf('</div>\n\n      <div class="hud-top-left"', a);
const slice = html.slice(a, b);
const order = [...slice.matchAll(/class="(tdm-score|tdm-name|tdm-clock)"/g)].map((m) => m[1]);
console.log(`   element order: ${order.join(' -> ')}`);
check('the reading order is score, name, clock, name, score',
  order.join(',') === 'tdm-score,tdm-name,tdm-clock,tdm-name,tdm-score', order.join(', '));
check('the blue team really is first in the markup',
  slice.indexOf('tdm-blue') < slice.indexOf('tdm-clock') && slice.indexOf('tdm-clock') < slice.indexOf('tdm-red'),
  'BLUE ... TIMER ... RED');
check('the blue score is the leftmost, the red score the rightmost',
  slice.indexOf('sb-score-blue') < slice.indexOf('sb-name-blue')
  && slice.indexOf('sb-name-red') < slice.indexOf('sb-score-red'),
  'BLUE SCORE | TEAM 1 ... TEAM 2 | RED SCORE');

// Heights, the score width and the clock width come from the bar's own custom
// properties, which is how the stylesheet shares them between the two sides.
// The clock is deliberately in pixels, because its clip-path is an SVG path in
// pixels and the two have to agree exactly.
const num = (name) => Number(new RegExp(`${name}:\\s*(\\d+)px`).exec(board)[1]);
const teamH = num('--tdm-team-h');
const clockH = num('--tdm-clock-h');
const scoreW = num('--tdm-score-w');
const clockW = num('--tdm-clock-w');
const barWidth = px(decl(ruleOf('.scoreboard'), 'width')?.match(/min\((\d+)px/)?.[1]);
const gap = px(decl(ruleOf('.scoreboard'), 'gap'));
const content = barWidth - gap * 2;
const teamW = (content - clockW) / 2;
const scoreSize = Number(decl(ruleOf('.tdm-score'), 'font')?.match(/([\d.]+)rem/)?.[1]);
const nameSize = Number(decl(ruleOf('.tdm-name'), 'font')?.match(/([\d.]+)rem/)?.[1]);
const clockSize = Number(decl(ruleOf('.tdm-time'), 'font')?.match(/([\d.]+)rem/)?.[1]);

console.log(`   bar            ${barWidth}px wide, gap ${gap}px`);
console.log(`   BLUE card      ${teamW.toFixed(1)} x ${teamH}px  (left, player)`);
console.log(`   clock          ${clockW} x ${clockH}px  (${((clockW / content) * 100).toFixed(1)}% of the bar)`);
console.log(`   RED card       ${teamW.toFixed(1)} x ${teamH}px  (right, opponents)`);
console.log(`   score block    ${scoreW} x ${teamH}px, ${scoreSize}rem`);
console.log(`   team name      ${nameSize}rem in ${(teamW - scoreW).toFixed(1)}px`);
console.log(`   clock numerals ${clockSize}rem`);

check('the clock is 20-25% of the bar', clockW / content >= 0.20 && clockW / content <= 0.25,
  `${((clockW / content) * 100).toFixed(1)}%`);
check('the two teams are the same width, so the bar is balanced',
  Math.abs(teamW - (content - clockW) / 2) < 0.01);
check('the clock stands taller than the teams, so it dominates',
  clockH > teamH, `${clockH}px against ${teamH}px`);
check('the bar is still thin, so it does not block the view', clockH <= 56, `${clockH}px tall`);
check('the bar is wide, not full-bleed', barWidth <= 700, `${barWidth}px`);
check('the score is large and about twice the team name',
  scoreSize / nameSize >= 1.9 && scoreSize / nameSize <= 2.2,
  `${(scoreSize / nameSize).toFixed(2)}x`);
check('the score fits inside its block', scoreSize * 16 <= teamH, `${scoreSize * 16}px in ${teamH}px`);
check('the score block is a meaningful part of its team', scoreW / teamW > 0.22 && scoreW / teamW < 0.45,
  `${((scoreW / teamW) * 100).toFixed(0)}% of the card`);

// ------------------------------------------------------------------ helpers
// A path is a list of coordinate pairs, and the only way to know which way a
// shape leans is to read them back. Both clock paths are measured this way
// below rather than re-derived from the shape's parameters: the previous pass
// used a formula, the formula was written to agree with the claim, and it passed
// against a path that had not actually been flipped.
const pointsOf = (p) => {
  const flat = p.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  const out = [];
  for (let i = 0; i < flat.length; i += 2) out.push({ x: flat[i], y: flat[i + 1] });
  return out;
};
/** The horizontal edge of the shape at its topmost and bottommost rows. */
const edgesOf = (pts) => {
  const topY = Math.min(...pts.map((p) => p.y));
  const bottomY = Math.max(...pts.map((p) => p.y));
  const widthAt = (y) => {
    const on = pts.filter((p) => p.y === y);
    return Math.max(...on.map((p) => p.x)) - Math.min(...on.map((p) => p.x));
  };
  const leftAt = (y) => Math.min(...pts.filter((p) => p.y === y).map((p) => p.x));
  const rightAt = (y) => Math.max(...pts.filter((p) => p.y === y).map((p) => p.x));
  return {
    topY,
    bottomY,
    top: widthAt(topY),
    bottom: widthAt(bottomY),
    leftTop: leftAt(topY),
    leftBottom: leftAt(bottomY),
    rightTop: rightAt(topY),
    rightBottom: rightAt(bottomY),
  };
};
/** True when the panel is wide at the top and narrows downward. */
const isFlippedWedge = (pts) => {
  const e = edgesOf(pts);
  return e.top > e.bottom && e.leftBottom > e.leftTop && e.rightBottom < e.rightTop;
};

console.log('\n--- the clock path has to match its box exactly ---');
const clockRule2 = ruleOf('.tdm-clock');
const path = /clip-path:\s*path\("([^"]+)"\)/.exec(clockRule2)?.[1] ?? '';
const pathPts = pointsOf(path);
const nums = pathPts.flatMap((p) => [p.x, p.y]);
const pathW = Math.max(...pathPts.map((p) => p.x));
const pathH = Math.max(...pathPts.map((p) => p.y));
console.log(`   path bounding box = ${pathW} x ${pathH}`);
console.log(`   element box       = ${clockW} x ${clockH}`);
check('the path describes exactly the element box', pathW === clockW && pathH === clockH,
  `path ${pathW}x${pathH}, element ${clockW}x${clockH}`);
check('it is wide, not a diamond', clockW / clockH > 2,
  `${(clockW / clockH).toFixed(2)}:1 - a diamond would be near 1:1`);

console.log('\n--- the two sides lean opposite ways, which is the whole shape ---');
// A parallelogram's left and right edges lean the SAME way. What is wanted here
// is that they lean opposite ways, making the panel symmetric, with the LONGER
// edge on top and the shorter one on the bottom.
//
// These are MEASURED from the path itself, not re-derived from the shape's
// parameters. The previous pass used a formula here, and the formula agreed with
// the claim while the drawn path did the opposite - so the test passed on a shape
// that was not flipped at all. Reading the edges off the emitted path is the only
// way this check can catch that.
const inset = num('--tdm-clock-inset');
const e = edgesOf(pathPts);
const topY = e.topY;
const bottomY = e.bottomY;
const measuredTop = e.top;
const measuredBottom = e.bottom;
const leftTop = e.leftTop;
const leftBottom = e.leftBottom;
console.log(`   inset asked for   = ${inset}px per side`);
console.log(`   MEASURED top edge = ${measuredTop.toFixed(0)}px`);
console.log(`   MEASURED foot     = ${measuredBottom.toFixed(0)}px`);
console.log(`   left edge goes    = ${leftTop} at the top -> ${leftBottom} at the foot, ` +
  `${leftBottom > leftTop ? 'inward' : 'OUTWARD'}`);
check('the top edge is the full width of the panel', Math.abs(measuredTop - clockW) < 0.6,
  `${measuredTop.toFixed(1)}px of ${clockW}px`);
check('the foot is the narrow one, so the sides fall inward as they descend',
  measuredBottom < measuredTop - 10,
  `${measuredBottom.toFixed(0)}px foot under a ${measuredTop.toFixed(0)}px top`);
check('the left edge really does move right on the way down', leftBottom > leftTop,
  `${leftTop} -> ${leftBottom}`);
check('the right edge really does move left on the way down',
  e.rightBottom < e.rightTop, 'both sides converge, so it is symmetric');
check('the taper is even on both sides, so the panel is symmetric',
  Math.abs((measuredTop - measuredBottom) / 2 - inset) < 0.6,
  `${((measuredTop - measuredBottom) / 2).toFixed(1)}px per side against ${inset}px asked`);
check('the text has room at the middle of the wedge, where it sits',
  clockSize * 16 * 2.6 < (measuredTop + measuredBottom) / 2,
  `"5:00" at ${clockSize}rem in ${((measuredTop + measuredBottom) / 2).toFixed(0)}px of clear width`);
check('the text is centred in the panel, not pushed to one end',
  /align-items:\s*center/.test(clockRule2) && !/padding-bottom/.test(clockRule2));
check('every coordinate sits inside the box',
  nums.every((n, i) => n >= -0.01 && n <= (i % 2 === 0 ? clockW : clockH) + 0.01),
  'nothing pokes out of the panel');
check('the compact clock path matches its own box too', (() => {
  // A path does not rescale, so each size needs a path describing exactly that
  // size. A hand-written compact path that drifts would clip the small clock.
  const media = css.slice(css.indexOf('@media'));
  const compactPath = /clip-path:\s*path\("([^"]+)"\)/.exec(media)?.[1] ?? '';
  const compactNums = compactPath.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (compactNums.length === 0) return false;
  const cw = Math.max(...compactNums.filter((_, i) => i % 2 === 0));
  const ch = Math.max(...compactNums.filter((_, i) => i % 2 === 1));
  const cWidth = Number(/--tdm-clock-w:\s*(\d+)px/.exec(media)[1]);
  const cHeight = Number(/--tdm-clock-h:\s*(\d+)px/.exec(media)[1]);
  return cw === cWidth && ch === cHeight;
})(), 'the compact path describes the compact box');
check('the compact clock is flipped the same way, not left the other way up', (() => {
  // The compact path is a second shape that has to agree with the first, and it
  // is the one most likely to be pasted in the wrong way round. Measured from
  // the path, same as the default size.
  const media = css.slice(css.indexOf('@media'));
  const compactPath = /clip-path:\s*path\("([^"]+)"\)/.exec(media)?.[1] ?? '';
  const pts = pointsOf(compactPath);
  return pts.length > 0 && isFlippedWedge(pts);
})(), 'the compact top is the wider edge too');
check('both clock paths agree, so the shape cannot flip between breakpoints',
  (() => {
    const media = css.slice(css.indexOf('@media'));
    const compactPath = /clip-path:\s*path\("([^"]+)"\)/.exec(media)?.[1] ?? '';
    return isFlippedWedge(pathPts) === isFlippedWedge(pointsOf(compactPath));
  })(), 'default and compact lean the same way');
check('the team name has room for its text', teamW - scoreW > 70,
  `${(teamW - scoreW).toFixed(1)}px for "TEAM 1"`);
check('the clock numerals fit its width', clockSize * 16 * 2.6 < clockW,
  `"5:00" at ${clockSize}rem needs about ${(clockSize * 16 * 2.6).toFixed(0)}px of ${clockW.toFixed(0)}px`);
check('the accent line under each name panel has room to read',
  teamW - scoreW > 60, `${(teamW - scoreW).toFixed(1)}px of underline`);

console.log('\n--- the diagonal seam, and the rounded clock outline ---');
const scoreClip = decl(scoreBody, 'clip-path');
const accentClip = decl(ruleOf('.tdm-blue .tdm-accent'), 'clip-path');
const accentClipRed = decl(ruleOf('.tdm-red .tdm-accent'), 'clip-path');
console.log(`   score seam  = ${scoreClip}`);
check('the score seam slants', scoreClip.includes('calc(100% - var(--tdm-cut))'));
// Vertex count is the number of comma-separated points inside polygon().
const vertices = (clip) => {
  const body = /polygon\((.*)\)/s.exec(clip ?? '')?.[1] ?? '';
  return body.split(',').map((p) => p.trim()).filter(Boolean);
};
const scorePoints = vertices(scoreClip);
check('the score seam is a four-sided parallelogram', scorePoints.length === 4, scorePoints.join(' | '));
check('both accent lines are rounded rather than cut',
  !accentClip && !accentClipRed,
  'the underlines are soft, per the correction');
check('the team name has room for its text', teamW - scoreW > 70,
  `${(teamW - scoreW).toFixed(1)}px for "TEAM 1"`);
check('the clock numerals fit its width', clockSize * 16 * 2.6 < clockW,
  `"5:00" at ${clockSize}rem needs about ${(clockSize * 16 * 2.6).toFixed(0)}px of ${clockW}px`);
check('the accent line under each name panel has room to read',
  teamW - scoreW > 60, `${(teamW - scoreW).toFixed(1)}px of underline`);
check('they run under the dark name half, not the score',
  decl(ruleOf('.tdm-blue .tdm-accent'), 'left') === 'var(--tdm-score-w)'
  && decl(ruleOf('.tdm-red .tdm-accent'), 'right') === 'var(--tdm-score-w)',
  'the underline starts where the colour ends');
check('every slant uses the one shared cut width',
  new Set((board.match(/--tdm-cut/g) || []).length ? ['ok'] : []).size === 1 && /--tdm-cut:\s*\d+px/.test(board));

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
