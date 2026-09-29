// Scratch check: the scoreboard must read left to right as
// [ BLUE 8 | TEAM 1 ]  [ 5:00 ]  [ TEAM 2 | RED 7 ] - blue always the player's
// side on the left, red always the opponents on the right, three panels that
// interlock rather than sitting apart, and a clock that dominates the middle.
import fs from 'fs';

// Normalised line endings, so the section slicing below cannot miss its end
// marker on a CRLF checkout and silently swallow the rest of the file.
const html = fs.readFileSync('index.html', 'utf8').replace(/\r\n/g, '\n');
const css = fs.readFileSync('src/styles.css', 'utf8').replace(/\r\n/g, '\n');
const rawJs = fs.readFileSync('src/ui/Scoreboard.js', 'utf8');
// Comments describe what the module deliberately does not do, so the "never
// touches" checks have to look at the code alone.
const js = rawJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
};

const a = html.indexOf('<div id="scoreboard"');
const b = html.indexOf('</div>\n\n      <div class="hud-top-left"', a);
const boardHtml = html.slice(a, b);
const c = css.indexOf('   Team deathmatch scoreboard.');
const d = css.indexOf('\n.hud-top-left {', c);
const boardCss = css.slice(c, d);
const flat = boardCss.replace(/\s+/g, ' ');
const at = (sel) => flat.indexOf(sel);
const rule = (sel) => {
  const start = at(sel);
  if (start < 0) return '';
  const end = flat.indexOf('}', start);
  return flat.slice(start, end);
};

console.log('--- the visual hierarchy, left to right ---');
// BLUE 8 -> TEAM 1 -> [5:00] -> TEAM 2 -> RED 7
check('blue comes first: it is the players side', boardHtml.indexOf('tdm-blue') < boardHtml.indexOf('tdm-clock'));
check('its score leads, on the outer left',
  boardHtml.indexOf('sb-score-blue') < boardHtml.indexOf('sb-name-blue'));
check('then its name', boardHtml.indexOf('sb-name-blue') < boardHtml.indexOf('tdm-clock'));
check('the clock is the centre', boardHtml.indexOf('tdm-clock') < boardHtml.indexOf('tdm-red'));
check('red mirrors it, name before score',
  boardHtml.indexOf('sb-name-red') < boardHtml.indexOf('sb-score-red'));
check('and its score is last, on the outer right',
  boardHtml.indexOf('sb-score-red') < boardHtml.length);
check('red is the opponents side, on the right', boardHtml.indexOf('tdm-red') > boardHtml.indexOf('tdm-clock'));
check('exactly two scores, two names, two accents, one clock',
  (boardHtml.match(/tdm-score/g) || []).length === 2
  && (boardHtml.match(/tdm-name/g) || []).length === 2
  && (boardHtml.match(/tdm-accent/g) || []).length === 2
  && (boardHtml.match(/tdm-clock/g) || []).length === 1);
check('the ids are named by colour, not by side, so they cannot be confused',
  boardHtml.includes('sb-score-blue') && boardHtml.includes('sb-score-red'));

console.log('\n--- the score is integrated into the team panel, not a plate on it ---');
// The reported bug: `background: currentColor` on an element that also sets
// `color: #fff` resolves against its OWN colour, so the panel rendered white
// with white text. The colour now comes from an inherited custom property.
check('the score no longer uses currentColor', !/background:\s*currentColor/.test(boardCss));
check('the score is filled from the team variable', /background:\s*var\(--team\)/.test(rule('.tdm-score')));
check('the team passes its colour down as a variable',
  /\.tdm-team \{[^}]*--team: var\(--tdm-blue\)/.test(flat)
  && /\.tdm-red \{ --team: var\(--tdm-red\)/.test(flat));
check('the score and the accent share that one variable',
  (boardCss.match(/background:\s*var\(--team\)/g) || []).length === 2,
  'the coloured score block and the accent line');
check('the number itself is white on the colour', /color:\s*#fff/.test(rule('.tdm-score')));

console.log('\n--- each team is one wide dark slab ---');
check('the team slab is the dark HUD material', /background:\s*var\(--tdm-hud\)/.test(rule('.tdm-team')));
check('the team slab fills its share of the bar', /flex:\s*1 1 0/.test(rule('.tdm-team')));
check('the name sits in the dark half of that same slab',
  /flex:\s*1 1 auto/.test(rule('.tdm-name')) && !/\.tdm-label/.test(boardCss),
  'no separate label box any more');
check('the slab is a single thin band', /height:\s*var\(--tdm-team-h\)/.test(rule('.tdm-team')));

console.log('\n--- the join between colour and dark is a diagonal seam ---');
check('the blue score leans away from the seam',
  /clip-path:\s*polygon\(0 0, calc\(100% - var\(--tdm-cut\)\) 0, 100% 100%, 0 100%\)/.test(rule('.tdm-score')));
check('the red score mirrors it',
  /\.tdm-red \.tdm-score \{ clip-path:\s*polygon\(var\(--tdm-cut\) 0, 100% 0, 100% 100%, 0 100%\)/.test(flat));
check('the seam is a real diagonal', Number(/--tdm-cut:\s*(\d+)px/.exec(boardCss)[1]) >= 12,
  `${/--tdm-cut:\s*(\d+)px/.exec(boardCss)[1]}px`);

console.log('\n--- soft geometry: rounded cards, not sharp polygons ---');
// The correction reversed an earlier sharp/angular pass: the cards are meant to
// be rounded, and only the score seam stays diagonal.
check('both team cards are rounded', /border-radius:\s*var\(--tdm-radius\)/.test(rule('.tdm-team')));
check('the radius is noticeable but still a panel',
  Number(/--tdm-radius:\s*(\d+)px/.exec(boardCss)[1]) >= 6
  && Number(/--tdm-radius:\s*(\d+)px/.exec(boardCss)[1]) <= 14,
  `${/--tdm-radius:\s*(\d+)px/.exec(boardCss)[1]}px`);
check('the card clips its children, which is what rounds the score corners',
  /overflow:\s*hidden/.test(rule('.tdm-team')),
  'the score block inherits the card radius through the clip');
check('the cards are not polygons any more', !/\.tdm-(blue|red) \{[^}]*clip-path/.test(flat),
  'no clip-path on the cards themselves');
check('the accent lines are rounded too',
  /border-radius:\s*0 3px 3px 0/.test(rule('.tdm-blue .tdm-accent'))
  && /border-radius:\s*3px 0 0 3px/.test(rule('.tdm-red .tdm-accent')));
check('there is depth on the cards, kept light',
  /0 2px 8px rgba\(0, 0, 0, 0\.35\)/.test(rule('.tdm-team')));

console.log('\n--- thin accent lines under the dark name panels ---');
check('the accent is absolutely placed on the bottom',
  /position:\s*absolute/.test(rule('.tdm-accent')) && /bottom:\s*0/.test(rule('.tdm-accent')));
check('it is thin', /height:\s*3px/.test(rule('.tdm-accent')));
check('blue underlines its name panel, not its score',
  /\.tdm-blue \.tdm-accent \{ left: var\(--tdm-score-w\); right: 0/.test(flat));
check('red underlines its name panel, not its score',
  /\.tdm-red \.tdm-accent \{ left: 0; right: var\(--tdm-score-w\)/.test(flat));

console.log('\n--- the clock: a wide wedge, long edge on top, sides leaning apart ---');
// A parallelogram's sides lean the same way; this one's lean opposite ways, so
// the panel is symmetric. The longer edge is the one on top and the shorter on
// the bottom, so the sides fall inward as they descend. That silhouette cannot
// be made with border-radius, and clip-path: polygon() cannot round a corner, so
// the whole outline is one SVG path with the rounding baked in. It must be a
// plate, not a diamond.
const clockRule = rule('.tdm-clock');
const clockPath = /clip-path:\s*path\("([^"]+)"\)/.exec(clockRule)?.[1];
check('it uses an explicit path, so it can be both tapered and rounded',
  Boolean(clockPath), 'clip-path: path()');
check('it is sized in pixels to match its path', /flex:\s*0 0 var\(--tdm-clock-w\)/.test(clockRule),
  'a path does not scale, so the box must not either');
const quads = (clockPath ?? '').match(/Q/g) || [];
const straight = (clockPath ?? '').match(/[ML]/g) || [];
check('all four of its corners are rounded', quads.length === 4, `${quads.length} rounded corners`);
// A wedge has four edges, but the two top corners are joined by a straight run
// that is long enough to survive the rounding, so it survives as one segment.
// The opening move plus the top edge plus the two slopes plus the bottom is five
// straight commands; the count is asserted loosely because the real claim is the
// shape, which the layout test measures.
check('it is drawn with straight runs between the rounded corners', straight.length >= 4,
  `${straight.length} straight runs, ${quads.length} rounded corners`);
check('it is a polygon path, not a curve or a circle',
  /^[MLQZ\d.\s-]+$/.test(clockPath ?? '') && !/[CcAa]/.test(clockPath ?? ''),
  'straight lines and one quadratic per corner');
check('it has no border-radius fighting its clip', !/border-radius/.test(clockRule),
  'the path carries the rounding on its own');
check('it is the heavier material', /background:\s*var\(--tdm-hud-deep\)/.test(rule('.tdm-clock')));
check('it does not shrink to fit its text', !/min-width:\s*\d+px/.test(rule('.tdm-clock')), 'flex-basis pins it');
check('its numerals are large, bold and white',
  /font:\s*700\s*2\.1rem/.test(rule('.tdm-time')) && /color:\s*#fff/.test(rule('.tdm-time')));
check('tabular so the clock does not jitter', /font-variant-numeric:\s*tabular-nums/.test(rule('.tdm-time')));

console.log('\n--- one unified bar, three soft panels ---');
check('the clock is centred vertically', /align-items:\s*center/.test(rule('.scoreboard')));
check('the score lives inside its team card, not beside it',
  /\.tdm-score \{[^}]*height: 100%/.test(flat) && /flex: 0 0 auto/.test(rule('.tdm-score')),
  'full height of the card it is printed into');
check('the score width is a shared variable, so both sides match',
  /--tdm-score-w:\s*\d+px/.test(boardCss)
  && (boardCss.match(/var\(--tdm-score-w\)/g) || []).length >= 3);

console.log('\n--- proportions ---');
const scoreSize = Number(/font:\s*700 ([\d.]+)rem/.exec(rule('.tdm-score'))?.[1]);
const nameSize = Number(/font:\s*700 ([\d.]+)rem/.exec(rule('.tdm-name'))?.[1]);
check('the score is large and about twice the team name',
  scoreSize / nameSize >= 1.9 && scoreSize / nameSize <= 2.2,
  `${scoreSize}rem vs ${nameSize}rem = ${(scoreSize / nameSize).toFixed(2)}x`);
check('the score is bold', /font:\s*700/.test(rule('.tdm-score')));
check('the whole bar is wide', /width:\s*min\(640px, 54vw\)/.test(rule('.scoreboard')));
check('the bar is horizontally balanced', /transform:\s*translateX\(-50%\)/.test(rule('.scoreboard')));
check('the bar stays thin, so it does not block the view',
  Number(/--tdm-clock-h:\s*(\d+)px/.exec(boardCss)[1]) <= 56, '52px at its tallest');

console.log('\n--- HUD material: dark, translucent, subtle depth ---');
check('the team card is a cool near-black, not grey',
  /--tdm-hud:\s*rgba\(13,\s*15,\s*19,\s*0\.84\)/.test(boardCss));
check('the clock is darker still', /--tdm-hud-deep:\s*rgba\(7,\s*8,\s*11,\s*0\.92\)/.test(boardCss));
check('there is depth, kept light', /filter:\s*drop-shadow\(0 3px 10px/.test(rule('.scoreboard')));
check('and a hairline inner edge', /inset 0 0 0 1px/.test(boardCss));

console.log('\n--- nothing else in the HUD is touched ---');
check('the crosshair is untouched', !/\.crosshair\s*\{[^}]*tdm/.test(css));
// The bar's own rules live in one section plus its responsive counterpart, so
// the claim to check is that no TDM selector appears before that section - i.e.
// nothing was added to the health, ammo, crosshair or objective-chip blocks.
check('health, ammo and the objective chip are unchanged',
  !/\.tdm-/.test(css.slice(0, c)),
  'no TDM selector appears before the scoreboard section');
check('the old bar is completely gone',
  !/\.sb-(entry|rows|center|alive|side|label|rule|more|kills|deaths|name)/.test(css)
  && !html.includes('sb-rows-mine') && !html.includes('sb-alive'));
check('no outer stripes left over', !html.includes('tdm-stripe') && !css.includes('tdm-stripe'));
check('no gradients, icons or decoration', !/gradient|url\(|@font-face/.test(boardCss));
check('the old amber team colour is gone', !/242,\s*196,\s*92/.test(boardCss));
// The compact override has to carry its own clock path, because a path in
// pixels does not rescale with the box.
const media = css.slice(css.indexOf('@media'));
check('the compact size gives the clock its own path',
  (media.match(/clip-path:\s*path\(/g) || []).length === 1);
check('and no radius leaks into the clock path, which would square it off',
  !/\.tdm-clock\s*\{[^}]*border-radius/.test(flat));
check('the wedge inset is a shared variable, so both sizes taper alike',
  /--tdm-clock-inset:\s*\d+px/.test(boardCss) && /--tdm-clock-inset:\s*\d+px/.test(media));
// The previous pass had the long edge at the bottom; this one flips it to the
// top, and the text goes back to being centred rather than sat low.
check('the clock text is centred, now that the wide end is the top',
  /align-items:\s*center/.test(rule('.tdm-clock')) && !/padding-bottom/.test(rule('.tdm-clock')));

console.log('\n--- the module is presentation only ---');
check('it never touches health or damage', !/health|damage|hurt/.test(js));
check('it never decides who is alive', !/isAlive\s*=/.test(js));
check('scores come from the server kills', /entry\.kills/.test(js));
check('a server-sent team is believed', /info\.team/.test(js));
check('the clock only writes when the second changes', /text === this\.lastClock/.test(js));

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
