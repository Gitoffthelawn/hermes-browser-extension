// Wiring assertions for the #94 composer paste interception. These read the
// source text so the paste branch, the honest cap warning, and the send-time
// excerpt mapping cannot be silently deleted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sidepanel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const composerDraft = readFileSync(new URL('../extension/lib/composer-draft.mjs', import.meta.url), 'utf8');
const sidepanelCss = readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');

test('composer paste listener routes non-image pastes through handlePasteText', () => {
  const listener = sidepanel.match(/els\.input\.addEventListener\('paste',[\s\S]*?\n {2}\}\);/)?.[0] || '';
  assert.match(listener, /handlePasteImages\(event\)/);
  assert.match(listener, /handlePasteText\(event\)/);
});

test('handlePasteText guards group rooms, the attachment cap, and prevents the default paste', () => {
  const fn = sidepanel.match(/function handlePasteText\(event\)[\s\S]*?\n\}/)?.[0] || '';
  assert.match(fn, /activeGroupProjection/);
  assert.match(fn, /PASTE_ARTIFACT_MAX_ATTACHMENTS/);
  assert.match(fn, /classifyPastedText\(text\)\.large/);
  assert.match(fn, /event\.preventDefault\(\)/);
  assert.match(fn, /addPasteArtifact\(text\)/);
  // The honest warning must name the inline limit it is protecting.
  assert.match(fn, /6,000/);
});

test('paste artifacts are built with the shared module and stats label', () => {
  const fn = sidepanel.match(/function addPasteArtifact\(text\)[\s\S]*?\n\}/)?.[0] || '';
  assert.match(fn, /buildPasteArtifact\(text\)/);
  assert.match(fn, /pasteArtifactMetaLabel\(artifact\)/);
});

test('the turn envelope maps paste artifacts through the excerpt mapper', () => {
  assert.match(sidepanel, /attachments:\s*preparedAttachments\.map\(attachmentForProtocol\)/);
  const fn = sidepanel.match(/function attachmentForProtocol\(attachment\)[\s\S]*?\n\}/)?.[0] || '';
  assert.match(fn, /pasteArtifactExcerpt\(/);
});

test('the composer keeps the text kind icon and gets a paste-artifact branch', () => {
  const icon = sidepanel.match(/function attachmentIcon\(kind = ''\)[\s\S]*?\n\}/)?.[0] || '';
  assert.match(icon, /text:\s*'▤'/);
});

test('the composer draft round-trips the paste artifact source marker', () => {
  assert.match(composerDraft, /source:\s*String\(attachment\.source \|\| ''\)/);
});

test('handlePasteText warns honestly in group rooms instead of returning silently', () => {
  const fn = sidepanel.match(/function handlePasteText\(event\)[\s\S]*?\n\}/)?.[0] || '';
  const groupBlock = fn.match(/if \(activeGroupProjection\) \{[\s\S]*?return false;\s*\}/)?.[0] || '';
  assert.match(groupBlock, /setStatus\('warn'/);
  assert.match(groupBlock, /Group rooms/);
});

test('handlePasteText rejects pastes past the local preservation limit before preventDefault', () => {
  const fn = sidepanel.match(/function handlePasteText\(event\)[\s\S]*?\n\}/)?.[0] || '';
  assert.match(fn, /pasteArtifactExceedsLocalLimit\(text\)/);
  const reject = fn.slice(0, fn.indexOf('event.preventDefault('));
  assert.match(reject, /pasteArtifactExceedsLocalLimit\(text\)/);
  assert.match(reject, /setStatus\('warn'/);
});

test('the paste status says only an excerpt is sent and the full text stays local', () => {
  const fn = sidepanel.match(/function handlePasteText\(event\)[\s\S]*?\n\}/)?.[0] || '';
  assert.match(fn, /excerpt/i);
  assert.match(fn, /stays on this device|remains local|stays local/i);
  assert.doesNotMatch(fn, /full text is kept and travels/);
});

test('the composer shows a visible notice for every paste that is sent as a shortened excerpt', () => {
  const fn = sidepanel.match(/function renderAttachments\(\) \{[\s\S]*?\n\}\n/)?.[0] || '';
  assert.match(fn, /pasteArtifactShortening\(attachment\)/);
  assert.match(fn, /attachments\.paste_excerpt_notice/);
  assert.match(fn, /setAttribute\('role', 'note'\)/);
  assert.match(fn, /attachment-excerpt-notice/);
  assert.match(sidepanelCss, /\.attachment-excerpt-notice \{/);
});
