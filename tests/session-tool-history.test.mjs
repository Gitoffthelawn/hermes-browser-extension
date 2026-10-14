import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as history from '../extension/lib/live-session-attach.mjs';

const project = (rows) => {
  assert.equal(typeof history.sessionToolDisplayMessages, 'function');
  return history.sessionToolDisplayMessages(rows);
};

test('REST assistant tool_calls and results survive history without duplicate receipts', () => {
  const rows = [
    { role: 'user', content: 'Check it' },
    { role: 'assistant', content: 'Checking', tool_calls: [{ id: 'call1', function: { name: 'terminal', arguments: '{"command":"npm test"}' } }] },
    { role: 'tool', tool_call_id: 'call1', tool_name: 'terminal', content: 'private output' },
    { role: 'assistant', content: 'Done' },
  ];
  const visible = project(rows);
  const tools = visible.filter(row => row.toolActivity);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].toolActivity.tool_name, 'terminal');
  assert.equal(tools[0].toolActivity.type, 'tool.complete');
  assert.equal(tools[0].toolActivity.preview, 'npm test');
  assert.ok(!JSON.stringify(visible).includes('private output'));
  assert.deepEqual(visible.filter(row => !row.toolActivity).map(row => row.content), ['Check it', 'Checking', 'Done']);
});

test('dashboard display-projected tools keep name and safe preview', () => {
  const tools = project([{ role: 'tool', name: 'read_file', args: { path: 'src/app.js' }, context: 'src/app.js' }]);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].toolActivity.tool_name, 'read_file');
  assert.equal(tools[0].toolActivity.preview, 'src/app.js');
});

test('unfinished calls remain running, hidden scaffolding stays hidden', () => {
  const tools = project([
    { role: 'assistant', content: '', tool_calls: [{ id: 'pending', function: { name: 'web_search', arguments: '{"query":"Hermes"}' } }] },
    { role: 'tool', name: 'secret', display_kind: 'hidden', content: 'hidden' },
  ]);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].toolActivity.type, 'tool.start');
  assert.equal(tools[0].toolActivity.preview, 'Hermes');
});
