import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as live from '../extension/lib/live-session-attach.mjs';

const roster = (payload, ids) => {
  assert.equal(typeof live.sessionLiveRoster, 'function');
  return live.sessionLiveRoster(payload, ids);
};

test('active_list maps live runtime IDs onto durable IDs already in this profile', () => {
  const rows = roster({ sessions: [
    { id: 'live-1', session_key: 'stored-1', status: 'streaming', title: 'Working' },
    { id: 'live-2', session_key: 'other-profile', status: 'streaming' },
    { id: 'live-3', session_key: 'stored-3', status: 'idle' },
  ] }, ['stored-1', 'stored-3']);
  assert.equal(rows.size, 2);
  assert.equal(rows.get('stored-1').liveId, 'live-1');
  assert.equal(rows.get('stored-1').state, 'running');
  assert.equal(rows.get('stored-3').state, 'idle');
  assert.equal(rows.has('other-profile'), false);
});

test('empty snapshots clear stale running rows without inventing state', () => {
  assert.equal(roster({ sessions: [] }, ['stored-1']).size, 0);
  assert.equal(roster({}, ['stored-1']).size, 0);
});
