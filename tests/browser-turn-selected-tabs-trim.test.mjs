import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBrowserTurnEnvelope } from '../extension/lib/browser-context-protocol.mjs';

// Issue: the side panel passes the SAME tab list as both `tabs` and `selectedTabs`
// on every follow-active / pinned turn (sidepanel.js passes promptTabs to both).
// The envelope then serializes that list twice, paying for the duplicate on the
// wire and in the model's context on every single turn. A `selectedTabs` list that
// is an exact duplicate of `tabs` carries no information, so it is emitted as [].
// A genuinely different selection (user selected specific tabs) is preserved verbatim.
// The companion parser only requires selectedTabs to be a list (isinstance list),
// so [] is accepted and `browser_get_context` reports an empty selection.

const activeTab = { id: 7, active: true, pinned: false, audible: false, title: 'Fixture tab', url: 'https://example.org/a', favIconUrl: '' };
const page = { restricted: false, reason: '', selectedText: '', text: 'PAGE_TEXT', youtubeTranscript: '', extraction: {}, siteAdapter: {}, meta: { description: 'd', language: 'en', headings: [] }, pickedElement: null };
const scope = { mode: 'pinned-tab', pinnedTabId: 7 };
const settings = { contextDepth: 'full', includeTabs: false, includePageText: true, includeSelectedText: true, maxTabs: 12 };

test('an identical selectedTabs list is not serialized twice', () => {
  const envelope = buildBrowserTurnEnvelope({
    humanInput: 'hi', activeTab, tabs: [activeTab], selectedTabs: [activeTab], pageContext: page,
    contextScope: scope, settings, contextHash: 'aa521d5e50110f92', contextDelivery: 'full',
    browserControl: { availability: 'unavailable' },
  });
  const payload = envelope.browser_context.payload;
  assert.deepEqual(payload.tabs, [payload.activeTab]);
  assert.deepEqual(payload.selectedTabs, [], 'duplicate selection must collapse to []');
});

test('a genuinely different selection is preserved verbatim', () => {
  const other = { id: 9, active: false, pinned: false, audible: false, title: 'Second tab', url: 'https://example.org/b', favIconUrl: '' };
  const envelope = buildBrowserTurnEnvelope({
    humanInput: 'hi', activeTab, tabs: [activeTab], selectedTabs: [activeTab, other], pageContext: page,
    contextScope: scope, settings, contextHash: 'aa521d5e50110f92', contextDelivery: 'full',
    browserControl: { availability: 'unavailable' },
  });
  const payload = envelope.browser_context.payload;
  assert.equal(payload.selectedTabs.length, 2, 'a real multi-tab selection must survive');
  assert.deepEqual(payload.tabs, [payload.activeTab]);
});

test('trim keeps the companion-parser contract (protocol, hash, list shapes)', () => {
  const parseLike = (raw) => {
    const e = JSON.parse(raw);
    if (e.protocol !== 'hermes.browser.turn.v2') return null;
    if (e.human_input.source !== 'composer' || typeof e.human_input.text !== 'string') return null;
    if (!Array.isArray(e.attachment_context.items)) return null;
    if (e.source_receipt.protocol !== 'hermes.browser.turn.v2' || e.source_receipt.version !== 2) return null;
    if (e.browser_context.delivery !== 'full' || e.source_receipt.delivery !== 'full') return null;
    const p = e.browser_context.payload;
    if (p.protocol !== 'hermes.browser.context.v1') return null;
    if (!Array.isArray(p.tabs) || !Array.isArray(p.selectedTabs)) return null;
    if (typeof e.source_receipt.context_hash !== 'string') return null;
    return p;
  };
  const raw = JSON.stringify(buildBrowserTurnEnvelope({
    humanInput: 'hi', activeTab, tabs: [activeTab], selectedTabs: [activeTab], pageContext: page,
    contextScope: scope, settings, contextHash: 'aa521d5e50110f92', contextDelivery: 'full',
    browserControl: { availability: 'unavailable' },
  }));
  const parsed = parseLike(raw);
  assert.ok(parsed, 'trimmed envelope must still satisfy the companion parser');
  assert.equal(parsed.contextScope.mode, 'pinned-tab');
  assert.equal(JSON.parse(raw).source_receipt.context_hash, 'aa521d5e50110f92');
});
