import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const background = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source.charAt(i) === '{') depth += 1;
    if (source.charAt(i) === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function actionClickHarness(browserApi) {
  const calls = [];
  const context = vm.createContext({
    browserApi,
    openHermesPanelFromGesture: (tab) => { calls.push(['open', tab.id]); return Promise.resolve(true); },
  });
  vm.runInContext(`${extractFunction(background, 'handleActionClick')}; globalThis.handleActionClick = handleActionClick;`, context);
  return { click: context.handleActionClick, calls };
}

test('Firefox toolbar button toggles the window sidebar, synchronously inside the click', async () => {
  const sidebarCalls = [];
  const harness = actionClickHarness({
    sidebarAction: { toggle() { sidebarCalls.push('toggle'); return Promise.resolve(); }, open() { sidebarCalls.push('open'); } },
  });
  const pending = harness.click({ id: 4 });
  assert.deepEqual(sidebarCalls, ['toggle'], 'toggle runs before the listener yields');
  await pending;
  assert.deepEqual(harness.calls, [], 'no second open attempt after a toggle');
  assert.match(background, /browserApi\.action\.onClicked\.addListener\(handleActionClick\);/);
});

test('a rejected Firefox toggle still opens Hermes the old way', async () => {
  const harness = actionClickHarness({ sidebarAction: { toggle: () => Promise.reject(new Error('nope')) } });
  await harness.click({ id: 9 });
  assert.deepEqual(harness.calls, [['open', 9]]);
});

test('Chromium side panel and Opera keep the existing open path', async () => {
  const chromium = actionClickHarness({ sidePanel: { open() {} }, sidebarAction: { toggle() { throw new Error('unused'); } } });
  await chromium.click({ id: 1 });
  assert.deepEqual(chromium.calls, [['open', 1]]);
  const opera = actionClickHarness({ sidebarAction: { setOpenState() {} } });
  await opera.click({ id: 2 });
  assert.deepEqual(opera.calls, [['open', 2]]);
});

test('Settings explains the window sidebar instead of offering a per-tab choice that cannot work', () => {
  assert.match(html, /<p id="panelResidencySidebarNote" class="hint" hidden data-i18n="ui\.sidebar\.stays\.open\.across\.tabs">/);
  const elements = new Map([
    ['panelResidencySidebarNote', { hidden: true }],
    ['panelResidencyOptions', { grid: { hidden: false }, querySelector() { return this.grid; } }],
  ]);
  const run = (browserApi) => {
    const context = vm.createContext({ browserApi, globalThis: {}, document: { getElementById: (id) => elements.get(id) } });
    vm.runInContext(`${extractFunction(panel, 'panelUsesWindowSidebar')}\n${extractFunction(panel, 'renderPanelResidencyHost')}\nrenderPanelResidencyHost();`, context);
    return [elements.get('panelResidencySidebarNote').hidden, elements.get('panelResidencyOptions').grid.hidden];
  };
  assert.deepEqual(run({ sidebarAction: { toggle() {} } }), [false, true], 'Firefox: note shown, choices hidden');
  assert.deepEqual(run({ sidePanel: {}, sidebarAction: undefined }), [true, false], 'Chromium: choices shown, note hidden');
});
