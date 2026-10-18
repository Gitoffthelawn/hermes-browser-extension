import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { mountBrandedSelect } from '../extension/lib/branded-select.mjs';
import { browserControlScopeHelpKey, createBrowserControlDialog } from '../extension/lib/browser-control-dialog.mjs';
import en from '../extension/lib/locales/en.mjs';

const html = await readFile(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');

function fixture() {
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  const { document } = dom.window;
  const originals = Object.fromEntries(['document', 'MutationObserver', 'Event', 'window'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document, MutationObserver: dom.window.MutationObserver, Event: dom.window.Event, window: dom.window });
  const byId = id => document.getElementById(id);
  const dialog = byId('browserControlDialog');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new dom.window.Event('close')); };
  const tooltip = byId('browserControlTooltip');
  let helpOpen = false;
  tooltip.matches = selector => selector === ':popover-open' && helpOpen;
  tooltip.showPopover = () => { helpOpen = true; };
  tooltip.hidePopover = () => { helpOpen = false; };
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const select = byId('browserControlDialogScopeInput');
  mountBrandedSelect(select);
  const ui = createBrowserControlDialog({ dialog, launcher: byId('browserControlMenuButton'), closeButton: byId('browserControlDismissButton'),
    label: () => 'Hermes Control', refresh: () => {}, translate: key => en[key] || key,
    scopeInput: select, scopeHelp: byId('browserControlDialogScopeHelp'),
    tabsField: byId('browserControlDialogTabs'), tabsList: byId('browserControlDialogTabList'),
    applyButton: byId('browserControlDialogApplyScope'), scopeHint: byId('browserControlDialogScopeHint'),
    getScope: () => 'this-tab', getSelectedTabIds: () => [], loadTabs: async () => [], applyScope: async () => {},
  });
  const help = { 'show-tab': en['browser_control.help_show_tab'] };
  const render = () => ui.render({ enabled: true, view: { state: 'ready', tone: 'ok', title: 'Ready', detail: '' }, canChangeScope: true, help });
  render();
  byId('browserControlMenuButton').click();
  // The asynchronous tab load has its own tests; keep this help fixture enabled.
  select.disabled = false; select.brandedSelect.sync();
  return { dom, document, select, tooltip, render, byId, helpOpen: () => helpOpen, cleanup() {
    dom.window.close();
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  } };
}

for (const value of ['this-tab', 'selected-tabs', 'task-set']) {
  test(`scope ${value} shows its helper as visible text, linked from the select, and survives polling`, () => {
    const f = fixture();
    try {
      const key = `browser_control.help_scope_${value.replaceAll('-', '_')}`;
      assert.ok(en[key], 'canonical explanation exists');
      assert.equal(browserControlScopeHelpKey(value), key);
      const helpElement = f.byId('browserControlDialogScopeHelp');
      f.select.value = value;
      f.select.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
      assert.equal(helpElement.textContent, en[key]);
      assert.match(f.select.getAttribute('aria-describedby'), /\bbrowserControlDialogScopeHelp\b/);
      assert.match(f.byId('browserControlDialogScopeInputButton').getAttribute('aria-describedby'), /\bbrowserControlDialogScopeHelp\b/);
      f.render();
      assert.equal(helpElement.textContent, en[key], 'poll must keep the helper for the chosen scope');
      assert.equal(f.tooltip.textContent, '', 'scope choices do not open a floating tooltip');
    } finally { f.cleanup(); }
  });
}

test('scope options carry no title-only or hover tooltips; the visible helper replaces them', () => {
  const f = fixture();
  try {
    f.byId('browserControlDialogScopeInputButton').click();
    for (const option of f.select.options) {
      assert.equal(option.hasAttribute('title'), false, `${option.value} has no title-only tooltip`);
      assert.equal(option.hasAttribute('data-control-help'), false, `${option.value} has no hover tooltip`);
    }
    const item = f.document.querySelector('#browserControlDialogScopeInputList [data-value="task-set"]');
    assert.ok(item, 'the branded option is rendered');
    assert.equal(item.hasAttribute('data-control-help'), false);
    assert.equal(item.hasAttribute('aria-description'), false);
  } finally { f.cleanup(); }
});

test('icon-style control buttons keep hover and focus help that survives polling', () => {
  const f = fixture();
  try {
    const showTab = f.byId('browserControlDialogShowTabButton');
    f.tooltip.getBoundingClientRect = () => ({ width: 280, height: 80 });
    showTab.getBoundingClientRect = () => ({ left: 20, width: 120, top: 400, bottom: 436 });
    showTab.dispatchEvent(new f.dom.window.Event('focusin', { bubbles: true }));
    assert.equal(f.tooltip.textContent, en['browser_control.help_show_tab']);
    assert.equal(f.helpOpen(), true);
    assert.equal(showTab.getAttribute('aria-describedby'), f.tooltip.id);
    f.render();
    assert.equal(f.tooltip.textContent, en['browser_control.help_show_tab'], 'poll must not erase button help');
    showTab.dispatchEvent(new f.dom.window.Event('focusout', { bubbles: true }));
    assert.equal(f.helpOpen(), false);
  } finally { f.cleanup(); }
});

test('scope selects are labelled and described by visible helper text in both surfaces', async () => {
  const settingsSelect = html.match(/<select id="browserControlScopeInput"[^>]*>/)?.[0] || '';
  assert.match(settingsSelect, /aria-labelledby="browserControlScopeLabel"/);
  assert.match(settingsSelect, /aria-describedby="browserControlScopeHelp browserControlScopeLock"/);
  assert.match(html, /<small id="browserControlScopeHelp"[^>]*data-i18n="browser_control\.help_scope_this_tab"/);
  assert.match(html, /<small id="browserControlScopeLock"[^>]*data-i18n="browser_control\.scope_help_locked"[^>]*\shidden>/);
  const dialogSelect = html.match(/<select id="browserControlDialogScopeInput"[^>]*>/)?.[0] || '';
  assert.match(dialogSelect, /aria-describedby="browserControlDialogScopeHelp browserControlDialogScopeHint"/);
  assert.match(html, /<small id="browserControlDialogScopeHelp"/);
  assert.doesNotMatch(html, /data-control-help="scope_/);
  assert.doesNotMatch(html, /<option[^>]+title="Control only/);
});

test('scope help describes explicit boundaries and distinguishes a shared task', () => {
  assert.match(en['browser_control.help_scope_this_tab'] || '', /only.*current tab/i);
  assert.match(en['browser_control.help_scope_selected_tabs'] || '', /only.*choose/i);
  assert.match(en['browser_control.help_scope_task_set'] || '', /shared.*task/i);
  assert.match(en['browser_control.help_scope_task_set'] || '', /only.*choose/i);
});

test('ordinary branded menus do not acquire control-specific help', () => {
  const dom = new JSDOM('<select id="ordinary"><option value="one">One</option></select>');
  const originals = Object.fromEntries(['document', 'MutationObserver'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { document: dom.window.document, MutationObserver: dom.window.MutationObserver });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  try {
    mountBrandedSelect(dom.window.document.querySelector('select'));
    dom.window.document.querySelector('button').click();
    assert.equal(dom.window.document.querySelector('[role="option"]').hasAttribute('data-control-help'), false);
  } finally {
    dom.window.close();
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
});
