import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import en from '../extension/lib/locales/en.mjs';
import { loadLocaleMessages, SUPPORTED_LOCALES } from '../extension/lib/i18n-registry.mjs';

const read = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
const [sidepanel, dialog, uiModel, html, readme, connectionGuide, permissions, privacy, security] = await Promise.all([
  read('extension/sidepanel.js'),
  read('extension/lib/browser-control-dialog.mjs'),
  read('extension/lib/browser-control-ui.mjs'),
  read('extension/sidepanel.html'),
  read('README.md'),
  read('guides/connection-guide.md'),
  read('PERMISSIONS.md'),
  read('PRIVACY.md'),
  read('SECURITY.md'),
]);

// Users read "Hermes Control" and plain attachment words. "Leased", "controller access",
// "browser-debugging access" and "Browser control" as a feature name are the jargon this replaces.
const JARGON = /\bleas(?:e|ed|es|ing)\b|controller access|browser-debugging|\bbrowser control\b|operate leased/i;

const NEW_KEYS = [
  'browser_control.scope_help_locked',
  'browser_control.tab_restricted',
  'browser_control.local_document_detail',
  'browser_control.toast_enable_failed',
  'browser_control.toast_attach_failed',
  'browser_control.toast_authorize_failed',
  'browser_control.toast_scope_unchanged',
  'browser_control.toast_view_unchanged',
  'browser_control.toast_state_unchanged',
  'browser_control.toast_stop_failed',
  'browser_control.toast_approval_failed',
  'browser_control.toast_rejection_failed',
  'browser_control.toast_attached',
  'browser_control.toast_attached_detail',
  'browser_control.error_session_enable',
  'browser_control.error_session_attach',
  'browser_control.error_attach_busy',
  'browser_control.error_attach_reconnecting',
  'browser_control.error_attach_restricted',
  'browser_control.error_attach_unavailable',
  'browser_control.error_release_failed',
  'browser_control.error_attach_failed',
  'browser_control.error_enable_failed',
  'browser_control.error_refresh_failed',
  'browser_control.error_select_tabs',
  'browser_control.error_active_tab',
  'browser_control.error_approval_failed',
  'ui.composer.group_chat',
  'ui.composer.send',
  'ui.composer.ask_hermes_label',
  'ui.composer.ask_hermes',
  'ui.composer.ask_bot_label',
  'ui.composer.ask_bot',
  'ui.composer.ask',
  'ui.composer.new_thread',
  'ui.composer.hermes_running',
  'ui.composer.bot_running',
];

test('Hermes Control catalog copy uses plain words and the product name', () => {
  const userFacing = Object.entries(en).filter(([key]) => key.startsWith('browser_control.')
    || key === 'settings.categories.permissions.summary'
    || key === 'run.stop_cancelled_commands');
  assert.ok(userFacing.length > 50, 'the Hermes Control catalog is covered');
  for (const [key, entry] of userFacing) {
    for (const text of typeof entry === 'string' ? [entry] : Object.values(entry)) {
      assert.doesNotMatch(text, JARGON, `${key} must not use lease or debugger jargon`);
    }
  }
  assert.equal(en['browser_control.title'], 'Hermes Control');
  assert.equal(en['settings.categories.permissions.summary'], 'Hermes Control, tab scope and page-sharing approval.');
  assert.match(en['browser_control.note'], /debugger access when it is installed or updated/);
});

test('README and guides name the feature Hermes Control and avoid lease jargon', () => {
  for (const [name, text] of [
    ['README.md', readme],
    ['guides/connection-guide.md', connectionGuide],
    ['PERMISSIONS.md', permissions],
    ['PRIVACY.md', privacy],
    ['SECURITY.md', security],
  ]) {
    assert.doesNotMatch(text, JARGON, `${name} avoids lease and browser-control jargon`);
  }
  assert.match(readme, /\*\*Hermes Control\*\* sets which tabs Hermes may operate/);
  assert.match(connectionGuide, /\| Hermes Control \| Yes \(Experimental\) \|/);
});

test('Hermes Control markup shows the product name and the plain attachment wording', () => {
  const card = html.match(/<section id="browserControlCard"[\s\S]*?<\/section>/)?.[0] || '';
  const dialogMarkup = html.match(/<dialog id="browserControlDialog"[\s\S]*?<\/dialog>/)?.[0] || '';
  assert.ok(card && dialogMarkup, 'the card and dialog are present');
  assert.doesNotMatch(card + dialogMarkup, JARGON);
  assert.match(card, /<h5 id="browserControlTitle" data-i18n="browser_control\.title">Hermes Control<\/h5>/);
  assert.match(card, /<small id="browserControlScopeLock"[^>]*\shidden>/, 'the settings scope explains why it is locked');
  assert.match(html, /<span id="localDocumentApprovalDetail" data-i18n="browser_control\.local_document_detail">/);
});

test('every Hermes Control and composer key used in code is a real English catalog key', () => {
  const keyPattern = /['"`](browser_control\.[a-z0-9_]+|ui\.composer\.[a-z0-9_]+)['"`]/g;
  const used = new Set();
  for (const source of [sidepanel, dialog]) {
    for (const [, key] of source.matchAll(keyPattern)) used.add(key);
  }
  assert.ok(used.has('browser_control.error_session_enable'));
  assert.ok(used.has('ui.composer.bot_running'));
  for (const key of used) {
    assert.ok(Object.hasOwn(en, key), `${key} is missing from en.mjs`);
  }
});

test('new Hermes Control and composer keys ship in every supported locale', async () => {
  for (const locale of SUPPORTED_LOCALES) {
    const messages = await loadLocaleMessages(locale.id);
    for (const key of NEW_KEYS) {
      assert.ok(Object.hasOwn(messages, key), `${locale.id} has ${key}`);
    }
  }
});

test('Hermes Control toasts, thrown errors, and composer labels no longer hardcode English', () => {
  for (const literal of [
    "title: 'Control not",
    "title: 'Scope unchanged'",
    "title: 'View unchanged'",
    "title: 'Control state unchanged'",
    "title: 'Stop failed'",
    "title: 'Approval not accepted'",
    "title: 'Rejection not accepted'",
    "title: 'This tab is attached'",
    "'Start or select a Hermes session",
    "'Could not lease",
    "'Could not release the previous tab lease.'",
    "'Controller capability refresh failed.'",
    "'Select one or more tabs in the Browser context scope",
    "'Approval decision was not accepted.'",
    "'Approve local document access",
    "textContent = 'GROUP CHAT'",
    "textContent = 'ASK HERMES'",
    "textContent = 'Ask Hermes'",
    "textContent = 'New Thread'",
    "textContent = 'Send'",
    "translateUiText('Hermes running')",
  ]) {
    assert.equal(sidepanel.includes(literal), false, `sidepanel.js no longer hardcodes ${literal}`);
  }
  assert.match(sidepanel, /showOperationToast\(\{ title: t\('browser_control\.toast_attached'\)/);
  assert.match(sidepanel, /els\.browserControlScopeLock\.hidden = !enabled;/);
  assert.match(sidepanel, /ui\.composer\.ask_bot_label', \{ name: botName\.toUpperCase\(\) \}/);
});

test('Hermes Control view copy in the state model uses attached-tab wording', () => {
  assert.doesNotMatch(uiModel, /leased tab|lease is owned|no tab is leased|operating the leased|exact tab is leased|controller connection|Browser debugging access|browser-control API key|Browser control needs/);
  assert.match(uiModel, /attached tab\$\{tabIdsFrom/);
});
