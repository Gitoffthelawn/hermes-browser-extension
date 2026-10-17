import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REST_FOLLOW_ACTIVE_MS,
  REST_FOLLOW_ACTIVE_WINDOW_MS,
  REST_FOLLOW_IDLE_MS,
  createRestFollowState,
  messageCountFromSessionPayload,
  restFollowDue,
  restFollowStep,
} from '../extension/lib/session-follow.mjs';

test('message count is read from either session payload shape', () => {
  assert.equal(messageCountFromSessionPayload({ session: { message_count: 72 } }), 72);
  assert.equal(messageCountFromSessionPayload({ message_count: 5 }), 5);
  assert.equal(messageCountFromSessionPayload({ session: {} }), null);
  assert.equal(messageCountFromSessionPayload(null), null);
});

test('the first look records a baseline, then only a changed count refreshes', () => {
  let state = createRestFollowState();
  let step = restFollowStep(state, 's1', 10, 1000);
  assert.equal(step.refresh, false);
  assert.equal(step.state.count, 10);
  state = step.state;
  step = restFollowStep(state, 's1', 10, 4000);
  assert.equal(step.refresh, false);
  state = step.state;
  step = restFollowStep(state, 's1', 12, 7000);
  assert.equal(step.refresh, true);
  assert.equal(step.state.count, 12);
});

test('switching sessions starts over with a new baseline', () => {
  const state = restFollowStep(createRestFollowState(), 's1', 10, 1000).state;
  const step = restFollowStep(state, 's2', 3, 2000);
  assert.equal(step.refresh, false);
  assert.equal(step.state.sessionId, 's2');
  assert.equal(step.state.count, 3);
});

test('an unreadable count never triggers a refresh or loses state', () => {
  const state = restFollowStep(createRestFollowState(), 's1', 10, 1000).state;
  const step = restFollowStep(state, 's1', null, 5000);
  assert.equal(step.refresh, false);
  assert.equal(step.state, state);
});

test('polls quickly while a session is changing and slowly once it settles', () => {
  const state = restFollowStep(createRestFollowState(), 's1', 10, 0).state;
  assert.equal(restFollowDue(state, 's1', REST_FOLLOW_ACTIVE_MS - 1), false);
  assert.equal(restFollowDue(state, 's1', REST_FOLLOW_ACTIVE_MS), true);
  const settledAt = REST_FOLLOW_ACTIVE_WINDOW_MS + 1;
  const settled = { ...state, lastCheckAt: settledAt };
  assert.equal(restFollowDue(settled, 's1', settledAt + REST_FOLLOW_IDLE_MS - 1), false);
  assert.equal(restFollowDue(settled, 's1', settledAt + REST_FOLLOW_IDLE_MS), true);
  assert.equal(restFollowDue(state, '', 1e9), false);
  assert.equal(restFollowDue(state, 's2', 1), true);
});
