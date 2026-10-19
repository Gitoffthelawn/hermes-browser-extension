import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { mountBrandedSelect } from '../extension/lib/branded-select.mjs';
import { createBrowserControlDialog } from '../extension/lib/browser-control-dialog.mjs';
import en from '../extension/lib/locales/en.mjs';

const html = await readFile(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const localeNames = (await readdir(new URL('../extension/lib/locales/', import.meta.url))).filter((name) => name.endsWith('.mjs'));
const locales = await Promise.all(localeNames.map(async (name) => (await import(new URL(`../extension/lib/locales/${name}`, import.meta.url))).default));

// Every help key the window's markup uses. "status" is the light, whose text is the live status; it is built at render time.
const windowMarkup = html.match(/<dialog id="browserControlDialog"[\s\S]*?<\/dialog>/)?.[0] || '';
const markupKeys = [...new Set([...windowMarkup.matchAll(/data-control-help="([^"]+)"/g)].map((match) => match[1]))].sort();
const STATIC_KEYS = markupKeys.filter((key) => key !== 'status');

test('every control in the Hermes Control window carries a help key', () => {
  assert.deepEqual(markupKeys, [
    'apply', 'approve', 'attach', 'authorize', 'close', 'follow', 'off', 'pause', 'reject',
    'scope', 'scope_selected_tabs', 'scope_task_set', 'scope_this_tab', 'status', 'stay', 'stop',
  ]);
  // Each control named in the request has its own key, not a shared one.
  for (const key of ['apply', 'authorize', 'approve', 'reject', 'scope', 'stay', 'follow', 'close', 'status', 'pause', 'stop', 'attach', 'off']) {
    assert.ok(markupKeys.includes(key), `${key} has help`);
  }
});

test('each help key has a non-empty explanation in English and in every locale', () => {
  assert.equal(locales.length, 21, 'all 21 locales are present');
  for (const key of STATIC_KEYS) {
    const id = `browser_control.help_${key}`;
    assert.ok(en[id]?.trim(), `${id} exists in English`);
    for (const [index, locale] of locales.entries()) {
      assert.ok(locale[id]?.trim(), `${id} exists in ${localeNames[index]}`);
    }
  }
  // The scope help for each tab checkbox is generated in the dialog, so it needs its own key too.
  for (const key of ['browser_control.help_scope_tab']) {
    for (const [index, locale] of locales.entries()) {
      assert.ok(locale[key]?.trim(), `${key} exists in ${localeNames[index]}`);
    }
  }
});

test('the window passes each control its explanation from the locale catalogue', () => {
  for (const key of ['apply', 'authorize', 'approve', 'reject', 'scope', 'stay', 'follow', 'close', 'attach', 'off', 'stop']) {
    assert.match(source, new RegExp(`\\b${key}: t\\('browser_control\\.help_${key}'\\)`), `sidepanel passes ${key} help`);
  }
  assert.match(source, /pause: t\(paused \? 'browser_control\.help_resume' : 'browser_control\.help_pause'\)/);
  assert.match(source, /status: statusLine/);
});

const WINDOW_CONTROLS = [
  ['browserControlDismissButton', 'close'],
  ['browserControlAttachButton', 'attach'],
  ['browserControlAuthorizeButton', 'authorize'],
  ['browserControlApproveButton', 'approve'],
  ['browserControlRejectButton', 'reject'],
  ['browserControlOffButton', 'off'],
  ['browserControlPauseButton', 'pause'],
  ['browserControlStopButton', 'stop'],
  ['browserControlDialogApplyScope', 'apply'],
  ['browserControlDialogStayButton', 'stay'],
  ['browserControlDialogFollowButton', 'follow'],
  ['browserControlDialogScopeInputButton', 'scope'],
];

function fixture() {
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  const { document } = dom.window;
  const originals = Object.fromEntries(['document', 'MutationObserver', 'Event', 'window', 'MouseEvent'].map((key) => [key, globalThis[key]]));
  Object.assign(globalThis, { document, MutationObserver: dom.window.MutationObserver, Event: dom.window.Event, window: dom.window, MouseEvent: dom.window.MouseEvent });
  const byId = (id) => document.getElementById(id);
  const dialog = byId('browserControlDialog');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new dom.window.Event('close')); };
  const tooltip = byId('browserControlTooltip');
  let helpOpen = false;
  tooltip.matches = (selector) => selector === ':popover-open' && helpOpen;
  tooltip.showPopover = () => { helpOpen = true; };
  tooltip.hidePopover = () => { helpOpen = false; };
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const select = byId('browserControlDialogScopeInput');
  for (const option of select.options) option.title = en[option.dataset.i18nTitle] || '';
  mountBrandedSelect(select);
  const help = Object.fromEntries(STATIC_KEYS.map((key) => [key, en[`browser_control.help_${key}`]]));
  const ui = createBrowserControlDialog({
    dialog, launcher: byId('browserControlMenuButton'), closeButton: byId('browserControlDismissButton'),
    label: () => 'Hermes Control', refresh: () => {}, translate: (key) => en[key] || key,
    scopeInput: select, tabsField: byId('browserControlDialogTabs'), tabsList: byId('browserControlDialogTabList'),
    applyButton: byId('browserControlDialogApplyScope'), scopeHint: byId('browserControlDialogScopeHint'),
    getScope: () => 'this-tab', getSelectedTabIds: () => [],
    loadTabs: async () => [{ id: 10, title: 'First', url: 'https://example.test/1' }, { id: 12, title: 'Second', url: 'https://example.test/2' }],
    applyScope: async () => {},
  });
  const render = () => ui.render({
    enabled: true,
    view: { state: 'approval', tone: 'warn', title: 'Approval needed', detail: 'Press Enter?' },
    help: { ...help, pause: en['browser_control.help_pause'] },
    canChangeScope: true,
  });
  render();
  byId('browserControlMenuButton').click();
  return {
    dom, document, byId, tooltip, render, helpOpen: () => helpOpen,
    cleanup() {
      dom.window.close();
      for (const [key, value] of Object.entries(originals)) {
        if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
      }
    },
  };
}

test('hovering each window control shows its explanation, and so does keyboard focus', async () => {
  const f = fixture();
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const [id, key] of WINDOW_CONTROLS) {
      const control = id === 'browserControlDialogScopeInputButton' ? f.document.querySelector('#browserControlDialogScopeInputButton') : f.byId(id);
      assert.ok(control, `${id} exists`);
      const expected = en[`browser_control.help_${key}`];
      assert.ok(expected, `${key} has English help`);
      control.dispatchEvent(new f.dom.window.MouseEvent('pointerover', { bubbles: true }));
      assert.equal(f.tooltip.textContent, expected, `${id} hover shows its help`);
      assert.equal(f.helpOpen(), true, `${id} hover opens the tooltip`);
      control.dispatchEvent(new f.dom.window.MouseEvent('pointerout', { bubbles: true }));
      assert.equal(f.helpOpen(), false, `${id} leaving hides it`);
      control.dispatchEvent(new f.dom.window.FocusEvent('focusin', { bubbles: true }));
      assert.equal(f.tooltip.textContent, expected, `${id} focus shows its help`);
      assert.equal(f.helpOpen(), true);
      control.dispatchEvent(new f.dom.window.FocusEvent('focusout', { bubbles: true }));
      assert.equal(f.helpOpen(), false, `${id} losing focus hides it`);
    }
  } finally { f.cleanup(); }
});

test('a real keyboard focus on a visible control shows its explanation and names it by description', async () => {
  const f = fixture();
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const apply = f.byId('browserControlDialogApplyScope');
    apply.focus();
    assert.equal(f.tooltip.textContent, en['browser_control.help_apply']);
    assert.equal(apply.getAttribute('aria-describedby'), f.tooltip.id);
    assert.equal(apply.getAttribute('aria-description'), en['browser_control.help_apply']);
  } finally { f.cleanup(); }
});

test('each scope checkbox explains itself on hover and focus', async () => {
  const f = fixture();
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.byId('browserControlDialogScopeInputButton').click();
    f.byId('browserControlDialogScopeInput').value = 'selected-tabs';
    f.byId('browserControlDialogScopeInput').dispatchEvent(new f.dom.window.Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const option = f.document.querySelector('#browserControlDialogTabList .browser-control-tab-option');
    assert.ok(option, 'a tab option is offered');
    const checkbox = option.querySelector('input');
    assert.equal(option.dataset.controlHelp, 'scope_tab');
    checkbox.dispatchEvent(new f.dom.window.MouseEvent('pointerover', { bubbles: true }));
    assert.equal(f.tooltip.textContent, en['browser_control.help_scope_tab']);
    checkbox.dispatchEvent(new f.dom.window.MouseEvent('pointerout', { bubbles: true }));
    checkbox.dispatchEvent(new f.dom.window.FocusEvent('focusin', { bubbles: true }));
    assert.equal(f.tooltip.textContent, en['browser_control.help_scope_tab']);
    assert.equal(checkbox.getAttribute('aria-description'), en['browser_control.help_scope_tab']);
  } finally { f.cleanup(); }
});

test('the scope picker keeps its hint while its help shows, and help adds and removes only its own id', async () => {
  const f = fixture();
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const picker = f.document.querySelector('#browserControlDialogScopeInputButton');
    const hint = 'browserControlDialogScopeHint';
    assert.equal(picker.getAttribute('aria-describedby'), hint, 'the picker starts described by its hint');
    picker.dispatchEvent(new f.dom.window.MouseEvent('pointerover', { bubbles: true }));
    assert.equal(picker.getAttribute('aria-describedby'), `${hint} ${f.tooltip.id}`, 'hover adds the tooltip beside the hint');
    picker.dispatchEvent(new f.dom.window.MouseEvent('pointerout', { bubbles: true }));
    assert.equal(picker.getAttribute('aria-describedby'), hint, 'leaving removes only the tooltip');
    picker.dispatchEvent(new f.dom.window.FocusEvent('focusin', { bubbles: true }));
    assert.equal(picker.getAttribute('aria-describedby'), `${hint} ${f.tooltip.id}`, 'focus adds the tooltip beside the hint');
    picker.dispatchEvent(new f.dom.window.FocusEvent('focusout', { bubbles: true }));
    assert.equal(picker.getAttribute('aria-describedby'), hint, 'losing focus removes only the tooltip');
  } finally { f.cleanup(); }
});
