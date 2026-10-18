// One-time long-session notice (PRs #70 and #76). The note is due once per
// session, only when the open transcript is over the threshold.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import english from '../extension/lib/locales/en.mjs';
import {
  LONG_SESSION_NOTICE_SEEN_LIMIT,
  LONG_SESSION_NOTICE_THRESHOLD,
  longSessionNoticeDue,
  rememberLongSessionNotice,
} from '../extension/lib/long-session-notice.mjs';

test('the notice threshold is about one hundred messages and is not due at exactly the threshold', () => {
  assert.equal(LONG_SESSION_NOTICE_THRESHOLD, 100);
  assert.equal(longSessionNoticeDue({ sessionId: 's1', messageCount: 100 }), false);
  assert.equal(longSessionNoticeDue({ sessionId: 's1', messageCount: 101 }), true);
});

test('a session that already showed the notice does not show it again', () => {
  assert.equal(longSessionNoticeDue({ sessionId: 's1', messageCount: 400, seenSessionIds: ['s2', 's1'] }), false);
  assert.equal(longSessionNoticeDue({ sessionId: 's3', messageCount: 400, seenSessionIds: ['s2', 's1'] }), true);
});

test('missing session ids and unknown counts never trigger the notice', () => {
  assert.equal(longSessionNoticeDue({ sessionId: '', messageCount: 500 }), false);
  assert.equal(longSessionNoticeDue({ sessionId: 's1', messageCount: null }), false);
  assert.equal(longSessionNoticeDue({ sessionId: 's1', messageCount: Number.NaN }), false);
  assert.equal(longSessionNoticeDue({ sessionId: 's1', messageCount: 500, seenSessionIds: null }), true);
});

test('remembering a session moves it to the front without duplicates', () => {
  assert.deepEqual(rememberLongSessionNotice(['a', 'b'], 'b'), ['b', 'a']);
  assert.deepEqual(rememberLongSessionNotice([], 'c'), ['c']);
  assert.deepEqual(rememberLongSessionNotice(['a'], ''), ['a']);
});

test('the seen list stays bounded', () => {
  const full = Array.from({ length: LONG_SESSION_NOTICE_SEEN_LIMIT }, (_value, index) => `s${index}`);
  const next = rememberLongSessionNotice(full, 'fresh');
  assert.equal(next.length, LONG_SESSION_NOTICE_SEEN_LIMIT);
  assert.equal(next[0], 'fresh');
  assert.equal(next.includes(`s${LONG_SESSION_NOTICE_SEEN_LIMIT - 1}`), false, 'the oldest entry is dropped');
});

test('the copy explains the desync risk for long shared sessions in the locale catalog', () => {
  const copy = english['session.long_shared_notice'];
  assert.match(copy, /\{count\} messages/);
  assert.match(copy, /out of sync with other Hermes clients/);
});

test('the side panel adds the note once, after the transcript is saved or committed', () => {
  const source = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const trim = source.match(/async function trimAndSaveMessages\(\) \{[\s\S]*?\n\}\n/)?.[0] || '';
  assert.match(trim, /void noteLongSharedSessionIfDue\(\);/);
  const commit = source.match(/async function commitFetchedSessionMessages\([\s\S]*?\n\}\n/)?.[0] || '';
  assert.match(commit, /renderMessagesFromStorage\(\);\s*void noteLongSharedSessionIfDue\(\);/);
  const notice = source.match(/async function noteLongSharedSessionIfDue\(\) \{[\s\S]*?\n\}\n/)?.[0] || '';
  assert.match(notice, /LONG_SESSION_NOTICE_THRESHOLD/);
  assert.match(notice, /\['user', 'assistant'\]/);
  assert.match(notice, /addMessage\('system', t\('session\.long_shared_notice'/);
  assert.match(notice, /\{ persist: false \}/, 'the note is not written into the transcript store');
  assert.match(notice, /activeGroupProjection/);
  assert.match(source, /const LONG_SESSION_NOTICE_STORAGE_KEY = 'hermesBrowserLongSessionNoticeSeen';/);
});
