import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sessionIsLiveFromStatus, shouldAttachLiveSession } from '../extension/lib/live-session-attach.mjs';

const ready = {
  dashboardTransport: true,
  connectionReady: true,
  sending: false,
  sessionId: 'sess-1',
  currentSessionId: 'sess-1',
  alreadyAttachedTo: '',
};

test('a gateway status reporting running attaches; idle or missing does not', () => {
  assert.equal(sessionIsLiveFromStatus({ running: true }), true);
  assert.equal(sessionIsLiveFromStatus({ running: false }), false);
  assert.equal(sessionIsLiveFromStatus({}), false);
  assert.equal(sessionIsLiveFromStatus(null), false);
});

test('attach requires dashboard transport, a ready socket, and the viewed session', () => {
  assert.equal(shouldAttachLiveSession(ready), true);
  assert.equal(shouldAttachLiveSession({ ...ready, dashboardTransport: false }), false);
  assert.equal(shouldAttachLiveSession({ ...ready, connectionReady: false }), false);
  assert.equal(shouldAttachLiveSession({ ...ready, currentSessionId: 'other' }), false);
  assert.equal(shouldAttachLiveSession({ ...ready, sessionId: '' }), false);
});

test('attach never double-paints this panel\'s own turn or a session already followed', () => {
  assert.equal(shouldAttachLiveSession({ ...ready, sending: true }), false);
  assert.equal(shouldAttachLiveSession({ ...ready, alreadyAttachedTo: 'sess-1' }), false);
  assert.equal(shouldAttachLiveSession({ ...ready, alreadyAttachedTo: 'sess-2' }), true);
});
