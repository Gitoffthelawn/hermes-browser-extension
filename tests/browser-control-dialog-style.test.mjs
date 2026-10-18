import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const css = (await readFile(new URL('../extension/sidepanel.css', import.meta.url), 'utf8'))
  .replace(/\/\*[\s\S]*?\*\//g, '');

// Every style rule as { selector, body }. Rules inside an at-rule (@media) are matched on
// their own, so the checks below see them as ordinary rules.
function styleRules(source) {
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selector: selector.trim(),
    body,
  }));
}

const rules = styleRules(css);
// The Hermes Control window and the parts its markup gives it.
const dialogRule = /\.browser-control-(dialog|dismiss|tooltip|tab-option|tabs|strip|action|field|view|config|live-indicator)\b/;
const dialogRules = rules.filter((rule) => dialogRule.test(rule.selector));

test('Hermes Control window corners are square: no border-radius other than the theme radius or 0', () => {
  const offenders = [];
  for (const rule of dialogRules) {
    for (const match of rule.body.matchAll(/(?:^|[;{\s])(border[a-z-]*radius)\s*:\s*([^;}]+)/g)) {
      const value = match[2].trim();
      // The live dot is round, like the Settings status dot; every box stays square.
      if (/live-indicator/.test(rule.selector) && value === '50%') continue;
      if (!/^(var\(--radius\)|0(px)?)$/.test(value)) offenders.push(`${rule.selector} { ${match[1]}: ${value} }`);
    }
  }
  assert.deepEqual(offenders, []);
  const box = rules.find((rule) => rule.selector === '.browser-control-dialog');
  assert.match(box?.body || '', /border-radius:\s*var\(--radius\)/);
});

test('Hermes Control window keeps a frosted surface, with a reduced-transparency fallback that turns it off', () => {
  const box = rules.find((rule) => rule.selector === '.browser-control-dialog');
  assert.ok(box, 'the dialog box rule exists');
  assert.match(box.body, /backdrop-filter:\s*blur\(14px\) saturate\(1\.2\)/);
  assert.match(box.body, /background:\s*color-mix\(in srgb, var\(--hermes-paper\) 82%, transparent\)/);
  const fallback = css.match(/@media \(prefers-reduced-transparency:\s*reduce\),\s*\(forced-colors:\s*active\)\s*\{\s*\.browser-control-dialog\s*\{([^}]*)\}\s*\}/);
  assert.ok(fallback, 'the reduced-transparency and forced-colours fallback exists');
  assert.match(fallback[1], /background:\s*var\(--hermes-paper\)/);
  assert.match(fallback[1], /backdrop-filter:\s*none/);
  // The dimmed backdrop keeps its blur; it has no radius or glow of its own.
  const backdrop = rules.find((rule) => rule.selector === '.browser-control-dialog::backdrop');
  assert.ok(backdrop, 'the backdrop rule exists');
  assert.match(backdrop.body, /backdrop-filter:\s*blur\(/);
  assert.doesNotMatch(backdrop.body, /border-radius|box-shadow/);
});

test('Hermes Control title is the Settings heading: display face, accent colour, one line, no 28px or 34px size', () => {
  const titleRules = rules.filter((rule) => /browser-control-dialog-title\b/.test(rule.selector));
  assert.ok(titleRules.length > 0, 'the title has a rule');
  for (const rule of titleRules) {
    assert.doesNotMatch(rule.body, /\b(28|34)px\b/, `${rule.selector} still sets a 28px or 34px title`);
  }
  assert.doesNotMatch(css, /font-profile="signature"\]\s+\.browser-control-dialog-title\s*\{[^}]*font-size/);
  const titleBody = titleRules.map((rule) => rule.body).join('\n');
  assert.match(titleBody, /font:\s*500 calc\(16px \* var\(--hermes-text-zoom,\s*1\)\)\/1\.15 var\(--hermes-font-display\)/);
  assert.match(titleBody, /color:\s*var\(--control-accent\)/);
  assert.match(titleBody, /white-space|overflow-wrap/);
});

test('Hermes Control state shows in the status chip and the live dot; the sparkle flare and energy line are gone', () => {
  assert.match(css, /\.browser-control-dialog \.browser-control-flare,\s*\.browser-control-dialog \.browser-control-energy\s*\{\s*display:\s*none/);
  assert.doesNotMatch(css, /border-left:\s*3px solid var\(--control-energy\)/);
  const chip = rules.find((rule) => rule.selector === '.browser-control-dialog .browser-control-strip-copy strong');
  assert.ok(chip, 'the status chip rule exists');
  assert.match(chip.body, /text-transform:\s*uppercase/);
  assert.match(css, /\.browser-control-live-indicator \{ animation: control-heartbeat/);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)\s*\{[^@]*?live-indicator \{ animation: none; \}/);
});

test('Hermes Control window colours come from theme tokens only', () => {
  for (const rule of dialogRules) {
    assert.doesNotMatch(rule.body, /#[0-9a-fA-F]{3,8}\b/, `${rule.selector} has a hex colour`);
    assert.doesNotMatch(rule.body, /\b(rgb|hsl)a?\(\s*\d/, `${rule.selector} has a literal colour`);
  }
});

test('the composer launcher stays square', () => {
  const launcher = rules.find((rule) => rule.selector === '.composer-actions #browserControlMenuButton');
  assert.ok(launcher, 'the launcher rule exists');
  assert.match(launcher.body, /border-radius:\s*var\(--radius\)/);
});
