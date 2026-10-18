import assert from 'node:assert/strict';
import test from 'node:test';

import {
  renderControlSnapshot,
  SNAPSHOT_VIEW_BUDGETS,
} from '../extension/lib/browser-control-snapshot-view.mjs';

function ref(number, role, name, extra = {}) {
  return { ref: `@e${number}`, role, name, sensitive: false, ...extra };
}

test('renders one line per element with state flags, headings, and a page-text excerpt', () => {
  const view = renderControlSnapshot({
    refs: [
      ref(1, 'link', 'Home'),
      ref(12, 'button', 'Add to cart', { disabled: true, backendDOMNodeId: 44 }),
      ref(13, 'checkbox', 'Gift wrap', { checked: true }),
      ref(14, 'button', 'Menu', { expanded: false, focused: true }),
      ref(15, 'textbox', 'Search', { hasValue: true }),
      ref(16, 'textbox', 'Sensitive field', { sensitive: true, hasValue: true }),
    ],
    headings: [{ level: 1, name: 'Shop' }, { level: 3, name: 'Shipping' }],
    text: 'Shop\nHome\nFree shipping over 50 dollars.',
    element_count: 6,
  });
  assert.equal(view.text, [
    '[@e1] link "Home"',
    '[@e12] button "Add to cart" (disabled)',
    '[@e13] checkbox "Gift wrap" (checked)',
    '[@e14] button "Menu" (collapsed, focused)',
    '[@e15] textbox "Search" (has value)',
    '[@e16] textbox "Sensitive field"',
    '',
    '## Shop',
    '## Shipping',
    '',
    'Free shipping over 50 dollars.',
  ].join('\n'));
  assert.equal(view.element_count, 6);
  assert.equal(view.truncated, false);
  assert.deepEqual(view.refs.map((item) => item.ref), ['@e1', '@e12', '@e13', '@e14', '@e15', '@e16']);
  assert.doesNotMatch(JSON.stringify(view), /backendDOMNodeId/);
  assert.deepEqual(Object.keys(view.refs[1]), ['ref', 'role', 'name']);
  assert.equal(JSON.parse(JSON.stringify(view)).refs[5].sensitive, true);
});

test('says so when a page has no interactive elements', () => {
  const view = renderControlSnapshot({ refs: [], text: 'Only prose here.' });
  assert.equal(view.text, '(no interactive elements)\n\nOnly prose here.');
});

test('stays inside the character budget and points at the rest when elements are cut', () => {
  const refs = Array.from({ length: 400 }, (_, index) => ref(index + 1, 'button', `Action number ${index + 1}`));
  const view = renderControlSnapshot({
    refs,
    element_count: 450,
    headings: [{ level: 2, name: 'Section' }],
    text: 'x'.repeat(5_000),
  }, { maxChars: SNAPSHOT_VIEW_BUDGETS.postAction });
  assert.ok(view.text.length <= SNAPSHOT_VIEW_BUDGETS.postAction);
  assert.equal(view.truncated, true);
  assert.equal(view.element_count, 450);
  assert.ok(view.refs.length < 400);
  const hint = view.text.split('\n').find((line) => line.startsWith('…'));
  assert.match(hint, new RegExp(`^\\u2026 ${450 - view.refs.length} more elements \\u2014 scroll or call browser_snapshot with full=true$`));
  assert.match(view.text, /\n## Section\n/);
  // Every listed ref is actionable, and nothing past the cut is advertised.
  assert.equal(view.text.includes(`[@e${view.refs.length + 1}]`), false);
});

test('full views use the larger budget and stop suggesting full=true', () => {
  const refs = Array.from({ length: 500 }, (_, index) => ref(index + 1, 'link', `Link ${index + 1}`));
  const view = renderControlSnapshot({ refs, element_count: 520, text: 'word '.repeat(20_000) }, {
    maxChars: SNAPSHOT_VIEW_BUDGETS.full,
    fullText: true,
  });
  assert.ok(view.text.length <= SNAPSHOT_VIEW_BUDGETS.full);
  assert.equal(view.refs.length, 500);
  assert.match(view.text, /… 20 more elements — scroll to reveal more/);
  assert.doesNotMatch(view.text, /full=true/);
  assert.equal(view.truncated, true);
});

test('a small budget still leaves room for the page text and never overflows', () => {
  const view = renderControlSnapshot({
    refs: Array.from({ length: 200 }, (_, index) => ref(index + 1, 'button', `Button ${index + 1}`)),
    text: 'Visible copy that explains the page. '.repeat(100),
  }, { maxChars: SNAPSHOT_VIEW_BUDGETS.turn });
  assert.ok(view.text.length <= SNAPSHOT_VIEW_BUDGETS.turn);
  assert.match(view.text, /Visible copy that explains the page\./);
});

test('redacts secrets in element names, headings, and page text', () => {
  const secret = 'sk-live-abcdefghijklmnopqrstuvwxyz0123456789';
  const view = renderControlSnapshot({
    refs: [ref(1, 'button', `Copy ${secret}`), ref(2, 'link', 'Docs')],
    headings: [{ level: 2, name: `Key ${secret}` }],
    text: `Your api_key=${secret} was created.\nNothing else.`,
  });
  assert.doesNotMatch(JSON.stringify(view), /abcdefghijklmnopqrstuvwxyz0123456789/);
  assert.match(view.text, /\[@e2\] link "Docs"/);
  assert.match(view.text, /Nothing else\./);
});

test('never prints sensitive element names even when the caller passes the raw name', () => {
  const view = renderControlSnapshot({ refs: [ref(7, 'textbox', 'Password', { sensitive: true })] });
  assert.equal(view.text.split('\n')[0], '[@e7] textbox "Sensitive field"');
  assert.equal(view.refs[0].name, 'Sensitive field');
});

test('does not repeat element and heading text in the excerpt', () => {
  const view = renderControlSnapshot({
    refs: [ref(1, 'link', 'Pricing')],
    headings: [{ level: 1, name: 'Welcome' }],
    text: 'Welcome\nPricing\nPlans start at ten dollars.',
  });
  assert.equal(view.text.endsWith('\n\nPlans start at ten dollars.'), true);
  assert.equal((view.text.match(/Pricing/g) || []).length, 1);
});
