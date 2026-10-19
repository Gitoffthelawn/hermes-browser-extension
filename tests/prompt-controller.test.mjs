import assert from 'node:assert/strict';
import test from 'node:test';

import { createPendingControlsPoller, createPromptController } from '../extension/lib/prompt-controller.mjs';

function harness(overrides = {}) {
  const clock = { now: 1_700_000_000_000 };
  const notices = [];
  const rest = [];
  const timers = { fn: null, cleared: 0 };
  const state = { viewed: ['sess-a'], caps: { source: 'api-server', runApproval: true }, response: { status: 200, payload: { status: 'resolved' } } };
  const controller = createPromptController({
    now: () => clock.now,
    setIntervalFn: (fn) => { timers.fn = fn; return 1; },
    clearIntervalFn: () => { timers.cleared += 1; timers.fn = null; },
    getViewedSessionIds: () => state.viewed,
    getCapabilities: () => state.caps,
    respondRest: async (entry, body) => {
      rest.push({ entry, body });
      if (state.response instanceof Error) throw state.response;
      return state.response;
    },
    onNotice: (notice) => notices.push(notice),
    ...overrides,
  });
  return { controller, clock, notices, rest, timers, state };
}

const approvalEvent = (extra = {}) => ({
  run_id: 'run-1', request_id: 'req-1', execution_generation: 2, command: 'rm -rf x', description: 'delete', choices: ['once', 'deny'], timeout_s: 120, ...extra,
});

test('an approval event becomes one visible card keyed by run and request', () => {
  const { controller, notices } = harness();
  assert.equal(controller.ingestRestEvent('approval.request', approvalEvent(), { sessionId: 'sess-a' }), true);
  const snap = controller.getSnapshot();
  assert.equal(snap.visible.length, 1);
  assert.equal(snap.visible[0].key, 'rest:run-1:req-1');
  assert.equal(snap.visible[0].actionable, true);
  assert.equal(notices[0].type, 'requested');
  assert.equal(notices[0].viewed, true);
});

test('the same event twice is one prompt', () => {
  const { controller, notices } = harness();
  controller.ingestRestEvent('approval.request', approvalEvent(), { sessionId: 'sess-a' });
  controller.ingestRestEvent('approval.request', approvalEvent(), { sessionId: 'sess-a' });
  assert.equal(controller.getSnapshot().total, 1);
  assert.equal(notices.filter((notice) => notice.type === 'requested').length, 1);
});

test('a prompt from another session is held, not shown, and appears when that session is viewed', () => {
  const { controller, notices, state } = harness();
  controller.ingestRestEvent('approval.request', approvalEvent(), { sessionId: 'sess-b' });
  assert.equal(controller.getSnapshot().visible.length, 0);
  assert.equal(controller.getSnapshot().hiddenCount, 1);
  assert.equal(notices[0].viewed, false);
  assert.equal(controller.hasPending(['sess-a']), false);
  state.viewed = ['sess-b'];
  assert.equal(controller.getSnapshot().visible.length, 1);
  assert.equal(controller.hasPending(['sess-b']), true);
});

test('answering sends the exact body, then the card closes', async () => {
  const { controller, rest, notices } = harness();
  controller.ingestRestEvent('approval.request', approvalEvent(), { sessionId: 'sess-a' });
  const result = await controller.answerApproval('rest:run-1:req-1', 'once');
  assert.equal(result.ok, true);
  assert.deepEqual(rest[0].body, { request_id: 'req-1', execution_generation: 2, choice: 'once' });
  assert.equal(rest[0].entry.scope, 'run-1');
  assert.equal(controller.getSnapshot().total, 0);
  assert.equal(notices.at(-1).type, 'sent');
});

test('Deny is always sendable even when the gateway listed nothing recognizable', async () => {
  const { controller, rest } = harness();
  controller.ingestRestEvent('approval.request', approvalEvent({ choices: ['bogus'] }), { sessionId: 'sess-a' });
  assert.deepEqual(controller.getSnapshot().visible[0].choices, ['deny']);
  assert.equal((await controller.answerApproval('rest:run-1:req-1', 'once')).ok, false);
  assert.equal(rest.length, 0, 'an unoffered choice is never sent');
  assert.equal((await controller.answerApproval('rest:run-1:req-1', 'deny')).ok, true);
  assert.equal(rest[0].body.choice, 'deny');
});

test('a double click cannot send twice', async () => {
  const { controller, rest } = harness();
  controller.ingestRestEvent('approval.request', approvalEvent(), { sessionId: 'sess-a' });
  const first = controller.answerApproval('rest:run-1:req-1', 'once');
  const second = await controller.answerApproval('rest:run-1:req-1', 'once');
  assert.equal(second.ok, false);
  await first;
  assert.equal(rest.length, 1);
});

test('409 and 404 retire the card with a retired notice instead of an error', async () => {
  for (const status of [409, 404]) {
    const { controller, notices, state } = harness();
    state.response = { status, payload: { error: { code: 'approval_not_pending' } } };
    controller.ingestRestEvent('approval.request', approvalEvent(), { sessionId: 'sess-a' });
    const result = await controller.answerApproval('rest:run-1:req-1', 'once');
    assert.equal(result.retired, true);
    assert.equal(controller.getSnapshot().total, 0);
    assert.equal(notices.at(-1).type, 'retired');
  }
});

test('an already_resolved success also reads as retired', async () => {
  const { controller, notices, state } = harness();
  state.response = { status: 200, payload: { status: 'already_resolved', prompt_id: 'req-1' } };
  controller.ingestRestEvent('approval.request', approvalEvent(), { sessionId: 'sess-a' });
  await controller.answerApproval('rest:run-1:req-1', 'once');
  assert.equal(notices.at(-1).type, 'retired');
});

test('a 400 or a network error keeps the card answerable and says why', async () => {
  for (const response of [{ status: 400, payload: { error: { code: 'invalid_params', message: 'bad body' } } }, new Error('offline')]) {
    const { controller, notices, state } = harness();
    state.response = response;
    controller.ingestRestEvent('approval.request', approvalEvent(), { sessionId: 'sess-a' });
    const result = await controller.answerApproval('rest:run-1:req-1', 'once');
    assert.equal(result.ok, false);
    const [shown] = controller.getSnapshot().visible;
    assert.equal(shown.status, 'pending');
    assert.match(shown.error, /bad body|offline/);
    assert.equal(notices.at(-1).type, 'failed');
    state.response = { status: 200, payload: {} };
    assert.equal((await controller.answerApproval('rest:run-1:req-1', 'deny')).ok, true, 'retry works');
  }
});

test('without the run approval route the card is informational and nothing can be sent', async () => {
  const { controller, rest, state } = harness();
  state.caps = { source: 'api-server', runApproval: false, approvalEvents: false };
  controller.ingestRestEvent('approval.request', approvalEvent(), { sessionId: 'sess-a' });
  assert.equal(controller.getSnapshot().visible[0].actionable, false);
  assert.equal((await controller.answerApproval('rest:run-1:req-1', 'deny')).ok, false);
  assert.equal(rest.length, 0);
  controller.dismiss('rest:run-1:req-1');
  assert.equal(controller.getSnapshot().total, 0);
});

test('an expired prompt cannot be answered and is dropped with a notice', async () => {
  const { controller, clock, rest, notices, timers } = harness();
  controller.ingestRestEvent('approval.request', approvalEvent({ timeout_s: 30 }), { sessionId: 'sess-a' });
  assert.equal(typeof timers.fn, 'function', 'the countdown clock runs while a prompt is open');
  clock.now += 31_000;
  assert.equal((await controller.answerApproval('rest:run-1:req-1', 'once')).ok, false);
  assert.equal(rest.length, 0, 'nothing is ever auto-approved or sent after expiry');
  assert.equal(controller.getSnapshot().total, 0);
  assert.equal(notices.at(-1).type, 'expired');
  assert.equal(timers.fn, null, 'the clock stops with the last prompt');
});

test('the tick drops expired prompts and refreshes the countdown for the rest', () => {
  const { controller, clock, timers, notices } = harness();
  controller.ingestRestEvent('approval.request', approvalEvent({ request_id: 'short', timeout_s: 5 }), { sessionId: 'sess-a' });
  controller.ingestRestEvent('approval.request', approvalEvent({ request_id: 'long', timeout_s: 500 }), { sessionId: 'sess-a' });
  const seen = [];
  controller.subscribe((snap) => seen.push(snap.visible.length));
  clock.now += 6_000;
  timers.fn();
  assert.equal(controller.getSnapshot().visible.map((entry) => entry.requestId).join(), 'long');
  assert.equal(notices.filter((notice) => notice.type === 'expired').length, 1);
  assert.ok(seen.length >= 2);
});

test('a run ending retires its prompts', () => {
  const { controller } = harness();
  controller.ingestRestEvent('approval.request', approvalEvent(), { sessionId: 'sess-a' });
  controller.ingestRestEvent('approval.request', approvalEvent({ run_id: 'run-2', request_id: 'x' }), { sessionId: 'sess-a' });
  controller.settleScope('rest', 'run-1');
  assert.deepEqual(controller.getSnapshot().visible.map((entry) => entry.scope), ['run-2']);
});

test('a settled event retires only the matching prompt', () => {
  const { controller } = harness();
  controller.ingestRestEvent('approval.request', approvalEvent({ request_id: 'r1' }), { sessionId: 'sess-a' });
  controller.ingestRestEvent('approval.request', approvalEvent({ request_id: 'r2' }), { sessionId: 'sess-a' });
  controller.ingestRestEvent('approval.settled', { run_id: 'run-1', prompt_id: 'r1' });
  assert.deepEqual(controller.getSnapshot().visible.map((entry) => entry.requestId), ['r2']);
});

test('run status restores prompts a reattached stream missed and retires the ones resolved elsewhere', () => {
  const { controller, clock } = harness();
  controller.ingestRunStatus('run-1', {
    run_id: 'run-1',
    status: 'waiting_for_approval',
    pending_controls: [
      { kind: 'approval', prompt_id: 'a1', execution_generation: 1, command: 'ls', choices: ['once', 'deny'], timeout_s: 200 },
      { kind: 'clarify', prompt_id: 'c1', execution_generation: 1, question: 'Which?', choices: ['x', 'y'] },
    ],
  }, { sessionId: 'sess-a' });
  assert.deepEqual(controller.getSnapshot().visible.map((entry) => entry.kind), ['approval', 'clarify']);

  // The next read no longer lists the approval, but it is too fresh to retire.
  controller.ingestRunStatus('run-1', { run_id: 'run-1', status: 'running', pending_controls: [
    { kind: 'clarify', prompt_id: 'c1', execution_generation: 1, question: 'Which?', choices: ['x', 'y'] },
  ] }, { sessionId: 'sess-a' });
  assert.equal(controller.getSnapshot().total, 2, 'a read that races the event does not retire a new prompt');
  clock.now += 5_000;
  controller.ingestRunStatus('run-1', { run_id: 'run-1', status: 'running', pending_controls: [
    { kind: 'clarify', prompt_id: 'c1', execution_generation: 1, question: 'Which?', choices: ['x', 'y'] },
  ] }, { sessionId: 'sess-a' });
  assert.deepEqual(controller.getSnapshot().visible.map((entry) => entry.kind), ['clarify']);

  controller.ingestRunStatus('run-1', { run_id: 'run-1', status: 'completed' }, { sessionId: 'sess-a' });
  assert.equal(controller.getSnapshot().total, 0);
});

test('an answered prompt is not restored by the next status read', async () => {
  const { controller } = harness();
  const status = { run_id: 'run-1', status: 'waiting_for_approval', pending_controls: [
    { kind: 'approval', prompt_id: 'a1', execution_generation: 1, command: 'ls', choices: ['once', 'deny'] },
  ] };
  controller.ingestRunStatus('run-1', status, { sessionId: 'sess-a' });
  await controller.answerApproval('rest:run-1:a1', 'once');
  controller.ingestRunStatus('run-1', status, { sessionId: 'sess-a' });
  assert.equal(controller.getSnapshot().total, 0);
});

test('a clarify answer goes to /clarify as text, and a skip sends an empty answer', async () => {
  const { controller, rest } = harness();
  controller.ingestRestEvent('clarify.request', {
    run_id: 'run-1', kind: 'clarify', prompt_id: 'c1', execution_generation: 5, question: 'Env?', choices: ['staging', 'prod'],
  }, { sessionId: 'sess-a' });
  await controller.answerClarify('rest:run-1:c1', { '': 'prod' });
  assert.equal(rest[0].entry.kind, 'clarify');
  assert.deepEqual(rest[0].body, { request_id: 'c1', execution_generation: 5, answer: 'prod' });

  controller.ingestRestEvent('clarify.request', {
    run_id: 'run-1', kind: 'clarify', prompt_id: 'c2', execution_generation: 5, question: 'Again?',
  }, { sessionId: 'sess-a' });
  await controller.answerClarify('rest:run-1:c2', { '': null });
  assert.equal(rest[1].body.answer, '');
});

test('an approval cannot be answered as a clarify or the other way around', async () => {
  const { controller, rest } = harness();
  controller.ingestRestEvent('approval.request', approvalEvent(), { sessionId: 'sess-a' });
  assert.equal((await controller.answerClarify('rest:run-1:req-1', { '': 'x' })).ok, false);
  assert.equal(rest.length, 0);
});

function wsRequest(id, method, params) {
  return { id, method, params: { session_id: 'live-1', ...params } };
}

test('a WebSocket approval request is answered on its own connection with {choice}', async () => {
  const { controller, notices } = harness({ getViewedSessionIds: () => ['sess-a'] });
  controller.bindSession('live-1', 'sess-a');
  const replies = [];
  const client = {};
  const owned = controller.ingestServerRequest(
    wsRequest('srq-1', 'approval', { request_id: 'r', command: 'ls', choices: ['once', 'session', 'deny'] }),
    { reply: async (result) => { replies.push(result); }, replyError: () => {}, client },
  );
  assert.equal(owned, true);
  assert.equal(controller.getSnapshot().visible.length, 1, 'a bound live id shows under the session it belongs to');
  assert.equal(controller.getSnapshot().visible[0].actionable, true);
  assert.equal(notices[0].type, 'requested');
  await controller.answerApproval('ws:live-1:srq-1', 'session');
  assert.deepEqual(replies, [{ choice: 'session' }]);
  assert.equal(controller.getSnapshot().total, 0);
});

test('a WebSocket clarify batch answers every question and carries nulls for skips', async () => {
  const { controller } = harness({ getViewedSessionIds: () => ['live-1'] });
  const replies = [];
  controller.ingestServerRequest(
    wsRequest('srq-2', 'clarify', { questions: [{ qid: 'q1', question: 'A?' }, { qid: 'q2', question: 'B?', choices: ['x'] }] }),
    { reply: async (result) => { replies.push(result); }, replyError: () => {}, client: {} },
  );
  await controller.answerClarify('ws:live-1:srq-2', { q1: 'hello', q2: null });
  assert.deepEqual(replies, [{ answers: { q1: 'hello', q2: null }, outcome: 'submitted' }]);
});

test('methods the controller does not own are left to the caller', () => {
  const { controller } = harness();
  assert.equal(controller.ingestServerRequest(wsRequest('srq-3', 'sudo', {}), { reply() {}, replyError() {} }), false);
  assert.equal(controller.ingestServerRequest(wsRequest('srq-4', 'secret', {}), { reply() {}, replyError() {} }), false);
});

test('a malformed owned request is declined instead of left waiting', () => {
  const { controller } = harness();
  const errors = [];
  const owned = controller.ingestServerRequest(
    { id: 'srq-5', method: 'clarify', params: { session_id: 'live-1', questions: [] } },
    { reply() {}, replyError: (code, message) => errors.push([code, message]) },
  );
  assert.equal(owned, true);
  assert.equal(errors[0][0], -32602);
  assert.equal(controller.getSnapshot().total, 0);
});

test('request.cancel withdraws the card, and the reason decides whether to say so', () => {
  const { controller, notices } = harness({ getViewedSessionIds: () => ['live-1'] });
  controller.ingestServerRequest(wsRequest('srq-6', 'approval', { request_id: 'r', command: 'ls' }), { reply() {}, replyError() {}, client: {} });
  controller.cancelServerRequest('srq-6', { reason: 'timeout' });
  assert.equal(controller.getSnapshot().total, 0);
  assert.deepEqual([notices.at(-1).type, notices.at(-1).reason], ['cancelled', 'timeout']);
  controller.cancelServerRequest('srq-unknown', { reason: 'timeout' });
});

test('an answer after the connection closed fails visibly and keeps the card', async () => {
  const { controller } = harness({ getViewedSessionIds: () => ['live-1'] });
  controller.ingestServerRequest(wsRequest('srq-7', 'approval', { request_id: 'r', command: 'ls' }), {
    reply: async () => { throw new Error('WebSocket is not open'); }, replyError() {}, client: {},
  });
  const result = await controller.answerApproval('ws:live-1:srq-7', 'deny');
  assert.equal(result.ok, false);
  const [shown] = controller.getSnapshot().visible;
  assert.equal(shown.status, 'pending');
  assert.match(shown.error, /not open/);
});

test('a closed connection discards its prompts and a resume can redeliver them', async () => {
  const { controller } = harness({ getViewedSessionIds: () => ['live-1'] });
  const oldClient = {};
  const request = wsRequest('srq-8', 'approval', { request_id: 'r', command: 'ls' });
  controller.ingestServerRequest(request, { reply: async () => { throw new Error('closed'); }, replyError() {}, client: oldClient });
  controller.dropClient(oldClient);
  assert.equal(controller.getSnapshot().total, 0);
  const replies = [];
  controller.ingestServerRequest(request, { reply: async (result) => { replies.push(result); }, replyError() {}, client: {} });
  assert.equal(controller.getSnapshot().total, 1);
  await controller.answerApproval('ws:live-1:srq-8', 'deny');
  assert.deepEqual(replies, [{ choice: 'deny' }]);
});

test('a redelivered request moves the answer to the live connection', async () => {
  const { controller } = harness({ getViewedSessionIds: () => ['live-1'] });
  const request = wsRequest('srq-9', 'approval', { request_id: 'r', command: 'ls' });
  const stale = [];
  const fresh = [];
  controller.ingestServerRequest(request, { reply: async (result) => { stale.push(result); }, replyError() {}, client: {} });
  controller.ingestServerRequest(request, { reply: async (result) => { fresh.push(result); }, replyError() {}, client: {} });
  assert.equal(controller.getSnapshot().total, 1);
  await controller.answerApproval('ws:live-1:srq-9', 'once');
  assert.deepEqual([stale.length, fresh.length], [0, 1]);
});

test('binding a live id re-announces a prompt that arrived before its session was known', () => {
  const { controller, notices } = harness({ getViewedSessionIds: () => ['sess-a'] });
  controller.ingestServerRequest(wsRequest('srq-10', 'approval', { request_id: 'r', command: 'ls' }), { reply() {}, replyError() {}, client: {} });
  assert.equal(notices.at(-1).viewed, false);
  controller.bindSession('live-1', 'sess-a');
  assert.equal(notices.at(-1).viewed, true);
  assert.equal(controller.getSnapshot().visible.length, 1);
});

test('listeners get the current snapshot at once and can unsubscribe', () => {
  const { controller } = harness();
  const seen = [];
  const off = controller.subscribe((snap) => seen.push(snap.total));
  controller.ingestRestEvent('approval.request', approvalEvent(), { sessionId: 'sess-a' });
  off();
  controller.ingestRestEvent('approval.request', approvalEvent({ request_id: 'other' }), { sessionId: 'sess-a' });
  assert.deepEqual(seen, [0, 1]);
});

// ---- poller ---------------------------------------------------------------

function pollerHarness(fetchStatus) {
  const timers = [];
  const statuses = [];
  const poller = createPendingControlsPoller({
    fetchStatus,
    onStatus: (payload) => statuses.push(payload),
    quietMs: 8000,
    pollMs: 4000,
    maxFailures: 2,
    setTimeoutFn: (fn, delay) => { timers.push({ fn, delay, live: true }); return timers.length - 1; },
    clearTimeoutFn: (id) => { if (timers[id]) timers[id].live = false; },
  });
  const fire = async () => {
    const timer = timers.filter((item) => item.live).at(-1);
    timer.live = false;
    await timer.fn();
  };
  return { poller, timers, statuses, fire };
}

test('the poller waits for a quiet stream before reading status, then keeps reading', async () => {
  const { poller, timers, statuses, fire } = pollerHarness(async () => ({ run_id: 'r', status: 'running' }));
  poller.start();
  assert.equal(timers.at(-1).delay, 8000);
  await fire();
  assert.equal(statuses.length, 1);
  assert.equal(timers.at(-1).delay, 4000);
});

test('stream activity postpones the next read', async () => {
  const { poller, timers, statuses } = pollerHarness(async () => ({}));
  poller.start();
  poller.activity();
  poller.activity();
  assert.equal(timers.filter((timer) => timer.live).length, 1, 'one pending read at a time');
  assert.equal(timers.at(-1).delay, 8000);
  assert.equal(statuses.length, 0);
});

test('a poke reads status soon, and the next stream activity is still honoured', async () => {
  const { poller, timers } = pollerHarness(async () => ({}));
  poller.start();
  poller.poke();
  assert.equal(timers.filter((timer) => timer.live).length, 1);
  assert.equal(timers.at(-1).delay, 750);
  poller.stop();
  poller.poke();
  assert.equal(timers.filter((timer) => timer.live).length, 0, 'a stopped poller cannot be woken');
});

test('stop prevents any further read, even one already scheduled', async () => {
  const { poller, timers, statuses } = pollerHarness(async () => ({}));
  poller.start();
  poller.stop();
  assert.equal(timers.some((timer) => timer.live), false);
  assert.equal(poller.active, false);
  await timers[0].fn();
  assert.equal(statuses.length, 0);
});

test('the poller gives up after repeated failures instead of hammering the gateway', async () => {
  const { poller, timers, fire } = pollerHarness(async () => { throw new Error('down'); });
  poller.start();
  await fire();
  await fire();
  assert.equal(poller.active, false);
  assert.equal(timers.filter((timer) => timer.live).length, 0);
});
