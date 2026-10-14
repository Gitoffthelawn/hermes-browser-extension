import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
const activity = await import('../extension/lib/tool-call-group.mjs').catch(() => ({}));

// The UI must be a disclosure outside assistant bubbles, not N tool messages.
test('a tool sequence renders one collapsed disclosure with individually inspectable calls', () => {
  const { document } = parseHTML('<html><body></body></html>');
  assert.equal(typeof activity.createToolCallGroup, 'function');
  const group = activity.createToolCallGroup({ document, calls: [
    { tool_name: 'read_file', preview: 'src/app.js', status: 'completed' },
    { tool_name: 'terminal', preview: 'npm test', status: 'progress' },
  ], running: true });
  assert.equal(group.tagName, 'DETAILS');
  assert.equal(group.hasAttribute('open'), false);
  assert.equal(group.querySelectorAll('.tool-call-entry').length, 2);
  assert.equal(group.querySelector('.message'), null);
  assert.match(group.querySelector('summary').textContent, /2/);
  group.open = true;
  assert.equal(group.open, true);
  group.open = false;
  assert.equal(group.open, false);
});

test('live updates preserve the same open disclosure, expanded call and scroll position', () => {
  const { document } = parseHTML('<html><body></body></html>');
  const calls = [{ tool_name: 'terminal', preview: 'npm test', status: 'progress' }];
  const group = activity.createToolCallGroup({ document, calls, running: true });
  const list = group.querySelector('.tool-call-list');
  const entry = group.querySelector('.tool-call-entry');
  group.open = true; entry.open = true; list.scrollTop = 120;
  activity.updateToolCallGroup(group, { calls: [...calls, {tool_name:'read_file', preview:'src/app.js', status:'progress'}], running:true });
  assert.equal(group.open, true);
  assert.equal(group.querySelector('.tool-call-list'), list);
  assert.equal(group.querySelector('.tool-call-entry'), entry);
  assert.equal(entry.open, true);
  assert.equal(list.scrollTop, 120);
});

test('classic thinking cycles through different Hermes faces', () => {
  assert.equal(typeof activity.classicThinkingFace, 'function');
  assert.notEqual(activity.classicThinkingFace(0), activity.classicThinkingFace(1));
  assert.ok(activity.CLASSIC_THINKING_FACES.length > 5);
});
