import assert from 'node:assert/strict';
import test from 'node:test';

import {
  APPROVAL_CHOICES,
  buildApprovalBody,
  buildClarifyBody,
  buildEditDiff,
  buildWsApprovalResult,
  buildWsClarifyResult,
  createPromptQueueState,
  encodeMultiSelectAnswer,
  expiredPrompts,
  formatCountdown,
  isAlreadyResolvedBody,
  isClarifyToolEvent,
  isPromptActionable,
  isPromptEventName,
  isPromptRetired,
  normalizeApprovalChoices,
  normalizeApprovalPrompt,
  normalizeClarifyPrompt,
  promptFromServerRequest,
  promptKey,
  promptsFromRunStatus,
  reducePromptQueue,
  respondFailureCode,
  respondFailureMessage,
  visiblePrompts,
} from '../extension/lib/gateway-prompts.mjs';

const NOW = 1_700_000_000_000;

function approval(overrides = {}) {
  return normalizeApprovalPrompt({
    request_id: 'req-1',
    execution_generation: 3,
    command: 'rm -rf build',
    description: 'recursive delete',
    choices: ['once', 'session', 'always', 'deny'],
    timeout_s: 300,
    ...overrides,
  }, { transport: 'rest', scope: 'run-1', sessionId: 'sess-a', now: NOW });
}

test('approval choices always include deny and never include unknown words', () => {
  assert.deepEqual(normalizeApprovalChoices(['once', 'DENY', 'reboot', '', null, undefined, 7]), ['once', 'deny']);
  assert.deepEqual(normalizeApprovalChoices(['once']), ['once', 'deny']);
  assert.deepEqual(normalizeApprovalChoices(['rm', 'please']), ['deny'], 'no known value still leaves a way to refuse');
  assert.deepEqual(normalizeApprovalChoices(['always', 'once', 'once']), ['once', 'always', 'deny'], 'canonical order, no duplicates');
  assert.deepEqual(normalizeApprovalChoices(undefined), [...APPROVAL_CHOICES]);
  assert.deepEqual(normalizeApprovalChoices([]), [...APPROVAL_CHOICES]);
  assert.deepEqual(normalizeApprovalChoices('once'), [...APPROVAL_CHOICES]);
});

test('an approval request keeps the fields the gateway needs to be answered', () => {
  const entry = approval({ edit: undefined });
  assert.equal(entry.kind, 'approval');
  assert.equal(entry.key, 'rest:run-1:req-1');
  assert.equal(entry.requestId, 'req-1');
  assert.equal(entry.executionGeneration, 3);
  assert.equal(entry.timeoutS, 300);
  assert.equal(entry.deadline, NOW + 300_000);
  assert.equal(entry.sessionId, 'sess-a');
  assert.equal(entry.command, 'rm -rf build');
  assert.equal(entry.description, 'recursive delete');
  assert.deepEqual(entry.choices, ['once', 'session', 'always', 'deny']);
  assert.equal(entry.status, 'pending');
});

test('the session stream, pending_controls and WebSocket spell the approval id differently', () => {
  const fromControls = normalizeApprovalPrompt({ kind: 'approval', prompt_id: 'p-9', execution_generation: 0, command: 'ls' }, { scope: 'run-1', now: NOW });
  assert.equal(fromControls.requestId, 'p-9');
  assert.equal(fromControls.executionGeneration, 0, 'generation 0 is a real generation');
  const ws = promptFromServerRequest({
    id: 'srq-abc',
    method: 'approval',
    params: { session_id: 'live-1', request_id: 'req-7', command: 'ls', choices: ['once', 'deny'] },
  }, { now: NOW });
  assert.equal(ws.transport, 'ws');
  assert.equal(ws.key, 'ws:live-1:srq-abc');
  assert.equal(ws.wsRequestId, 'srq-abc');
  assert.equal(ws.requestId, 'req-7');
  assert.equal(ws.sessionId, 'live-1');
});

test('a gateway that predates request ids still gets one singleton prompt per run', () => {
  const entry = normalizeApprovalPrompt({ command: 'ls' }, { scope: 'run-1', now: NOW });
  assert.equal(entry.key, 'rest:run-1:default');
  assert.equal(entry.requestId, '');
  assert.deepEqual(buildApprovalBody(entry, 'once'), { choice: 'once' });
});

test('an edit approval carries the proposed change and can only be approved once', () => {
  const entry = approval({
    command: '',
    choices: ['once', 'session', 'always', 'deny'],
    edit: { tool_name: 'write_file', path: 'src/a.js', old_text: 'a\nb\n', new_text: 'a\nc\n', arguments: { content: 'secret' } },
  });
  assert.deepEqual(entry.choices, ['once', 'deny']);
  assert.equal(entry.command, 'Edit src/a.js');
  assert.equal(entry.edit.path, 'src/a.js');
  assert.equal(entry.edit.oldText, 'a\nb\n');
  assert.equal(entry.edit.newText, 'a\nc\n');
  assert.equal(Object.hasOwn(entry.edit, 'arguments'), false, 'raw tool arguments are not kept');
});

test('timeout_s is optional and bounded', () => {
  const none = approval({ timeout_s: undefined });
  assert.equal(none.timeoutS, null);
  assert.equal(none.hasTimeout, false);
  assert.ok(none.deadline > NOW + 60_000, 'a request without a timeout still gets a generous cap');
  assert.equal(approval({ timeout_s: -4 }).timeoutS, null);
  assert.equal(approval({ timeout_s: 'abc' }).timeoutS, null);
  assert.equal(approval({ timeout_s: 10_000_000 }).timeoutS, 24 * 60 * 60);
});

test('a clarify wait with no timeout never expires on its own', () => {
  const entry = normalizeClarifyPrompt({ prompt_id: 'c', question: 'Q?' }, { scope: 'r', now: NOW });
  assert.equal(entry.deadline, Infinity);
  assert.equal(entry.hasTimeout, false);
  assert.deepEqual(expiredPrompts(reducePromptQueue(createPromptQueueState(), { type: 'add', entry, now: NOW }), NOW + 24 * 3600_000), []);
  const timed = normalizeClarifyPrompt({ prompt_id: 'c2', question: 'Q?', timeout_s: 60 }, { scope: 'r', now: NOW });
  assert.equal(timed.deadline, NOW + 60_000);
});

test('garbage input never becomes a prompt', () => {
  assert.equal(normalizeApprovalPrompt(null), null);
  assert.equal(normalizeApprovalPrompt('rm -rf /'), null);
  assert.equal(normalizeApprovalPrompt([]), null);
  assert.equal(normalizeClarifyPrompt({ prompt_id: 'x' }, { scope: 'r' }), null, 'no question');
  assert.equal(promptFromServerRequest({ id: 'srq', method: 'sudo', params: { session_id: 's' } }), null);
  assert.equal(promptFromServerRequest({ method: 'approval', params: {} }), null);
});

test('clarify prompts normalize REST (one question) and WebSocket (batch) shapes', () => {
  const rest = normalizeClarifyPrompt({
    kind: 'clarify', prompt_id: 'c-1', execution_generation: 2, question: 'Which env?', choices: ['staging', 'prod'], multi_select: false,
  }, { scope: 'run-1', sessionId: 'sess-a', now: NOW });
  assert.equal(rest.kind, 'clarify');
  assert.equal(rest.key, 'rest:run-1:c-1');
  assert.deepEqual(rest.questions, [{ qid: '', question: 'Which env?', choices: ['staging', 'prod'], multiSelect: false }]);

  const ws = promptFromServerRequest({
    id: 'srq-2',
    method: 'clarify',
    params: {
      session_id: 'live-1',
      questions: [
        { qid: 'q1', question: 'Name?', choices: null, multi_select: false },
        { qid: 'q2', question: 'Pick', choices: ['a', 'b'], multi_select: true },
        { qid: 'q3', question: '' },
      ],
    },
  }, { now: NOW });
  assert.equal(ws.questions.length, 2, 'a blank question is dropped');
  assert.deepEqual(ws.questions[0].choices, []);
  assert.equal(ws.questions[1].multiSelect, true);
  assert.equal(ws.questions[1].qid, 'q2');
});

test('a question that would name the prototype is dropped', () => {
  const entry = normalizeClarifyPrompt({
    prompt_id: 'c', questions: [{ qid: '__proto__', question: 'bad' }, { qid: 'ok', question: 'fine' }],
  }, { scope: 'r' });
  assert.deepEqual(entry.questions.map((question) => question.qid), ['ok']);
});

test('multi_select without choices is plain free text', () => {
  const entry = normalizeClarifyPrompt({ prompt_id: 'c', question: 'Why?', multi_select: true }, { scope: 'r' });
  assert.equal(entry.questions[0].multiSelect, false);
});

test('the approval body echoes execution_generation and request_id when the gateway sent them', () => {
  const entry = approval();
  assert.deepEqual(buildApprovalBody(entry, 'once'), { request_id: 'req-1', execution_generation: 3, choice: 'once' });
  assert.deepEqual(Object.keys(buildApprovalBody(entry, 'deny')).sort(), ['choice', 'execution_generation', 'request_id']);
});

test('without a generation the body falls back to {choice, request_id}', () => {
  const entry = approval({ execution_generation: undefined });
  assert.deepEqual(buildApprovalBody(entry, 'session'), { choice: 'session', request_id: 'req-1' });
});

test('only a choice the gateway offered can be sent', () => {
  const smartDenied = approval({ choices: ['once', 'deny'] });
  assert.equal(buildApprovalBody(smartDenied, 'always'), null);
  assert.equal(buildApprovalBody(smartDenied, 'session'), null);
  assert.notEqual(buildApprovalBody(smartDenied, 'once'), null);
  assert.equal(buildApprovalBody(smartDenied, 'reboot'), null);
  assert.equal(buildApprovalBody(smartDenied, ''), null);
  assert.equal(buildApprovalBody(smartDenied, null), null);
  assert.equal(buildApprovalBody(approval(), 'ALWAYS').choice, 'always', 'case is normalized, never widened');
});

test('the clarify body carries the answer as text and is bounded', () => {
  const entry = normalizeClarifyPrompt({ prompt_id: 'c-1', execution_generation: 4, question: 'Q?' }, { scope: 'run-1' });
  assert.deepEqual(buildClarifyBody(entry, 'prod'), { request_id: 'c-1', execution_generation: 4, answer: 'prod' });
  assert.deepEqual(buildClarifyBody(entry, ''), { request_id: 'c-1', execution_generation: 4, answer: '' });
  assert.equal(buildClarifyBody(entry, 'x'.repeat(20_000)), null);
  assert.equal(buildClarifyBody(approval(), 'x'), null, 'an approval is never answered as a clarify');
});

test('WebSocket results match the gateway contract', () => {
  const entry = promptFromServerRequest({
    id: 'srq-1', method: 'approval', params: { session_id: 'live', request_id: 'r', command: 'ls', choices: ['once', 'deny'] },
  }, { now: NOW });
  assert.deepEqual(buildWsApprovalResult(entry, 'once'), { choice: 'once' });
  assert.equal(buildWsApprovalResult(entry, 'always'), null);

  const clarify = promptFromServerRequest({
    id: 'srq-2', method: 'clarify', params: { session_id: 'live', questions: [{ qid: 'q1', question: 'A?' }, { qid: 'q2', question: 'B?' }] },
  }, { now: NOW });
  assert.deepEqual(
    buildWsClarifyResult(clarify, { q1: 'yes', q2: null, other: 'ignored' }),
    { answers: { q1: 'yes', q2: null }, outcome: 'submitted' },
  );
  assert.equal(encodeMultiSelectAnswer(['a', 'b', 'a']), '["a","b"]');
});

test('a prompt is retired by 404, 409 or a settled error code, never by other failures', () => {
  assert.equal(isPromptRetired(409), true);
  assert.equal(isPromptRetired(404), true);
  assert.equal(isPromptRetired(400, 'approval_not_pending'), true);
  assert.equal(isPromptRetired(400, 'stale_generation'), true);
  assert.equal(isPromptRetired(200, 'already_resolved'), true);
  assert.equal(isPromptRetired(400, 'invalid_params'), false, 'a malformed body is a send failure, not a settled prompt');
  assert.equal(isPromptRetired(500, 'internal'), false);
  assert.equal(isPromptRetired(undefined, ''), false);
  assert.equal(isAlreadyResolvedBody({ status: 'already_resolved', prompt_id: 'p' }), true);
  assert.equal(isAlreadyResolvedBody({ status: 'resolved' }), false);
  assert.equal(respondFailureCode({ error: { code: 'Approval_Not_Pending' } }), 'approval_not_pending');
  assert.equal(respondFailureMessage({ error: { message: 'nope' } }, 500), 'nope');
  assert.equal(respondFailureMessage({}, 502), 'HTTP 502');
});

test('run status becomes prompts from pending_controls, with the legacy approval field as fallback', () => {
  const status = promptsFromRunStatus({
    run_id: 'run-1',
    status: 'waiting_for_approval',
    pending_controls: [
      { kind: 'approval', prompt_id: 'a1', execution_generation: 1, command: 'ls', choices: ['once', 'deny'] },
      { kind: 'clarify', prompt_id: 'c1', execution_generation: 1, question: 'Q?' },
      { kind: 'secret', prompt_id: 's1' },
    ],
  }, { now: NOW, sessionId: 'sess-a' });
  assert.equal(status.authoritative, true);
  assert.deepEqual(status.entries.map((entry) => entry.key), ['rest:run-1:a1', 'rest:run-1:c1']);

  const legacy = promptsFromRunStatus({
    run_id: 'run-2', status: 'waiting_for_approval', approval: { request_id: 'r9', command: 'ls' },
  }, { now: NOW });
  assert.equal(legacy.authoritative, false);
  assert.deepEqual(legacy.entries.map((entry) => entry.key), ['rest:run-2:r9']);

  assert.equal(promptsFromRunStatus({ run_id: 'r', status: 'completed', pending_controls: [] }).terminal, true);
  assert.equal(promptsFromRunStatus({ run_id: 'r', status: 'running' }).terminal, false);
  assert.deepEqual(promptsFromRunStatus(null).entries, []);
});

test('queue: adds are idempotent, several requests stay queued, and a settled key is not resurrected', () => {
  let state = createPromptQueueState();
  const first = approval({ request_id: 'r1' });
  const second = approval({ request_id: 'r2' });
  state = reducePromptQueue(state, { type: 'add', entry: first, now: NOW });
  state = reducePromptQueue(state, { type: 'add', entry: first, now: NOW });
  state = reducePromptQueue(state, { type: 'add', entry: second, now: NOW });
  assert.deepEqual(state.entries.map((entry) => entry.requestId), ['r1', 'r2'], 'a newer request does not strand the older one');

  state = reducePromptQueue(state, { type: 'settle', key: first.key, now: NOW });
  assert.deepEqual(state.entries.map((entry) => entry.requestId), ['r2']);
  state = reducePromptQueue(state, { type: 'add', entry: first, now: NOW + 1000 });
  assert.deepEqual(state.entries.map((entry) => entry.requestId), ['r2'], 'a status poll cannot bring back an answered prompt');
  state = reducePromptQueue(state, { type: 'add', entry: first, now: NOW + 11 * 60_000 });
  assert.equal(state.entries.length, 2, 'the memory of settled keys is bounded');
});

test('queue: answering locks the prompt, failure unlocks it with the reason', () => {
  const entry = approval();
  let state = reducePromptQueue(createPromptQueueState(), { type: 'add', entry, now: NOW });
  state = reducePromptQueue(state, { type: 'answering', key: entry.key });
  assert.equal(state.entries[0].status, 'answering');
  state = reducePromptQueue(state, { type: 'failed', key: entry.key, error: 'HTTP 502' });
  assert.equal(state.entries[0].status, 'pending');
  assert.equal(state.entries[0].error, 'HTTP 502');
  state = reducePromptQueue(state, { type: 'answering', key: entry.key });
  assert.equal(state.entries[0].error, '', 'a new attempt clears the old error');
});

test('queue: settling a scope drops every prompt of that run only', () => {
  let state = createPromptQueueState();
  const a = normalizeApprovalPrompt({ request_id: 'a', command: 'x' }, { scope: 'run-1', now: NOW });
  const b = normalizeApprovalPrompt({ request_id: 'b', command: 'x' }, { scope: 'run-2', now: NOW });
  state = reducePromptQueue(reducePromptQueue(state, { type: 'add', entry: a, now: NOW }), { type: 'add', entry: b, now: NOW });
  state = reducePromptQueue(state, { type: 'settleScope', transport: 'rest', scope: 'run-1', now: NOW });
  assert.deepEqual(state.entries.map((entry) => entry.requestId), ['b']);
});

test('queue: discard forgets nothing so a redelivery after reconnect is accepted', () => {
  const entry = promptFromServerRequest({ id: 'srq-1', method: 'approval', params: { session_id: 'live', request_id: 'r', command: 'ls' } }, { now: NOW });
  let state = reducePromptQueue(createPromptQueueState(), { type: 'add', entry, now: NOW });
  state = reducePromptQueue(state, { type: 'discard', key: entry.key });
  assert.equal(state.entries.length, 0);
  state = reducePromptQueue(state, { type: 'add', entry, now: NOW + 1 });
  assert.equal(state.entries.length, 1);
});

test('queue: expiry drops prompts past their deadline and reports them', () => {
  const short = approval({ request_id: 'short', timeout_s: 10 });
  const long = approval({ request_id: 'long', timeout_s: 600 });
  let state = createPromptQueueState();
  state = reducePromptQueue(reducePromptQueue(state, { type: 'add', entry: short, now: NOW }), { type: 'add', entry: long, now: NOW });
  assert.deepEqual(expiredPrompts(state, NOW + 9_000), []);
  assert.deepEqual(expiredPrompts(state, NOW + 10_000).map((entry) => entry.requestId), ['short']);
  state = reducePromptQueue(state, { type: 'expire', now: NOW + 10_000 });
  assert.deepEqual(state.entries.map((entry) => entry.requestId), ['long']);
});

test('queue: the backlog is bounded', () => {
  let state = createPromptQueueState();
  for (let index = 0; index < 60; index += 1) {
    state = reducePromptQueue(state, {
      type: 'add',
      entry: normalizeApprovalPrompt({ request_id: `r${index}`, command: 'x' }, { scope: 'run', now: NOW }),
      now: NOW,
    });
  }
  assert.equal(state.entries.length, 50);
  assert.equal(state.entries[0].requestId, 'r10');
});

test('prompts follow the session they were raised in', () => {
  let state = createPromptQueueState();
  const a = normalizeApprovalPrompt({ request_id: 'a', command: 'x' }, { scope: 'run-a', sessionId: 'sess-a', now: NOW });
  const b = normalizeApprovalPrompt({ request_id: 'b', command: 'x' }, { scope: 'run-b', sessionId: 'sess-b', now: NOW });
  state = reducePromptQueue(reducePromptQueue(state, { type: 'add', entry: a, now: NOW }), { type: 'add', entry: b, now: NOW });
  assert.deepEqual(visiblePrompts(state, ['sess-a']).map((entry) => entry.requestId), ['a']);
  assert.deepEqual(visiblePrompts(state, ['sess-b', '']).map((entry) => entry.requestId), ['b']);
  assert.deepEqual(visiblePrompts(state, []), []);
  assert.deepEqual(visiblePrompts(state, ['other']), []);

  const live = promptFromServerRequest({ id: 'srq-1', method: 'approval', params: { session_id: 'live-9', request_id: 'r', command: 'x' } }, { now: NOW });
  const withLive = reducePromptQueue(createPromptQueueState(), { type: 'add', entry: live, now: NOW });
  assert.deepEqual(visiblePrompts(withLive, ['stored-9']), [], 'unknown live session is not shown for another session');
  assert.equal(visiblePrompts(withLive, ['stored-9'], new Map([['live-9', 'stored-9']])).length, 1, 'a bound live id follows its session');
  assert.equal(visiblePrompts(withLive, ['live-9']).length, 1);
});

test('capability gating: WebSocket is always actionable, REST needs the run approval route', () => {
  assert.equal(isPromptActionable({ transport: 'ws', capabilities: { source: 'api-server' } }), true);
  const apiServer = { source: 'api-server', runApproval: false, approvalEvents: false };
  assert.equal(isPromptActionable({ transport: 'rest', kind: 'approval', capabilities: apiServer }), false);
  assert.equal(isPromptActionable({ transport: 'rest', kind: 'approval', capabilities: { ...apiServer, runApproval: true } }), true);
  assert.equal(isPromptActionable({ transport: 'rest', kind: 'approval', capabilities: { ...apiServer, approvalEvents: true } }), true);
  assert.equal(isPromptActionable({ transport: 'rest', kind: 'clarify', capabilities: apiServer }), false);
  assert.equal(isPromptActionable({ transport: 'rest', kind: 'clarify', capabilities: { ...apiServer, runApproval: true } }), true);
  assert.equal(isPromptActionable({ transport: 'rest', kind: 'clarify', capabilities: { ...apiServer, runClarify: true } }), true);
  assert.equal(isPromptActionable({ transport: 'rest', kind: 'approval', capabilities: { source: 'legacy' } }), true, 'unprobed gateway that emitted the prompt');
  assert.equal(isPromptActionable({ transport: 'rest', kind: 'approval', capabilities: null }), true);
});

test('prompt event names match what the gateway emits', () => {
  for (const name of ['approval.request', 'approval.settled', 'approval.responded', 'clarify.request', 'clarify.settled']) {
    assert.equal(isPromptEventName(name), true, name);
  }
  for (const name of ['approval.requested', 'approval.resolved', 'tool.started', 'run.completed', '']) {
    assert.equal(isPromptEventName(name), false, name);
  }
});

test('countdown formatting', () => {
  assert.equal(formatCountdown(300_000), '5:00');
  assert.equal(formatCountdown(61_000), '1:01');
  assert.equal(formatCountdown(999), '0:01');
  assert.equal(formatCountdown(-5), '0:00');
  assert.equal(promptKey({ transport: 'rest', scope: 'r', id: 'i' }), 'rest:r:i');
});

test('edit diffs trim shared lines, show what changed, and stay bounded', () => {
  const diff = buildEditDiff('one\ntwo\nthree\nfour\nfive\nsix\n', 'one\ntwo\nthree\nFOUR\nfive\nsix\n', { context: 1 });
  assert.deepEqual(diff.rows.map((row) => `${row.kind}:${row.text}`), [
    'gap:…', 'context:three', 'removed:four', 'added:FOUR', 'context:five', 'gap:…',
  ]);
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);

  const created = buildEditDiff(null, 'a\nb\n');
  assert.deepEqual(created.rows.map((row) => row.kind), ['added', 'added']);

  const big = buildEditDiff('', Array.from({ length: 500 }, (_, index) => `line ${index}`).join('\n'), { maxLines: 20 });
  assert.equal(big.rows.length, 20);
  assert.equal(big.truncated, true);

  const wide = buildEditDiff('', 'x'.repeat(1000), { maxLineLength: 50 });
  assert.equal(wide.rows[0].text.length, 51);
});

test('the clarify tool starting is recognized from every tool event shape', () => {
  assert.equal(isClarifyToolEvent({ toolName: 'clarify' }), true);
  assert.equal(isClarifyToolEvent({ tool_name: 'Clarify' }), true);
  assert.equal(isClarifyToolEvent({ name: 'clarify' }), true);
  assert.equal(isClarifyToolEvent({ toolName: 'terminal' }), false);
  assert.equal(isClarifyToolEvent(null), false);
  assert.equal(isClarifyToolEvent({}), false);
});
