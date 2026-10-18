import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';

import { normalizeApprovalPrompt, normalizeClarifyPrompt, promptFromServerRequest } from '../extension/lib/gateway-prompts.mjs';
import { createPromptCard } from '../extension/lib/prompt-card.mjs';

const NOW = 1_700_000_000_000;

function fixture() {
  const { document } = parseHTML('<html><body><button id="composer"></button><section id="card" hidden></section></body></html>');
  const container = document.getElementById('card');
  const calls = [];
  let listener = null;
  const controller = {
    subscribe(fn) { listener = fn; return () => { listener = null; }; },
    answerApproval: (...args) => { calls.push(['approval', ...args]); return Promise.resolve({ ok: true }); },
    answerClarify: (...args) => { calls.push(['clarify', ...args]); return Promise.resolve({ ok: true }); },
    dismiss: (...args) => { calls.push(['dismiss', ...args]); },
  };
  const t = (key, params) => (params ? `${key}|${JSON.stringify(params)}` : key);
  // linkedom has no focus model: record focus() calls and expose activeElement.
  let active = null;
  const focused = [];
  let owner = Object.getPrototypeOf(document.createElement('button'));
  while (owner && !Object.hasOwn(owner, 'focus')) owner = Object.getPrototypeOf(owner);
  const originalFocus = owner?.focus;
  if (owner) {
    owner.focus = function focus() {
      active = this;
      focused.push(this);
    };
  }
  Object.defineProperty(document, 'activeElement', { configurable: true, get: () => active });
  const restore = () => { if (owner) owner.focus = originalFocus; };
  const card = createPromptCard({ container, t, controller });
  const show = (visible, extra = {}) => listener({ visible, hiddenCount: 0, total: visible.length, now: NOW, ...extra });
  const type = (input, value) => {
    input.value = value;
    input.dispatchEvent(new document.defaultView.Event('input'));
  };
  return { document, container, calls, card, show, type, controller, focused, restore, isActive: (node) => active === node };
}

function approval(overrides = {}, entry = {}) {
  return {
    ...normalizeApprovalPrompt({
      request_id: 'req-1', execution_generation: 1, command: 'rm -rf build', description: 'recursive delete',
      choices: ['once', 'session', 'always', 'deny'], timeout_s: 120, ...overrides,
    }, { scope: 'run-1', sessionId: 'sess', now: NOW }),
    actionable: true,
    ...entry,
  };
}

const buttonsOf = (container) => [...container.querySelectorAll('button')];

test('the card stays hidden until a prompt is visible and hides again when none is', () => {
  const f = fixture();
  assert.equal(f.container.hidden, true);
  f.show([approval()]);
  assert.equal(f.container.hidden, false);
  f.show([]);
  assert.equal(f.container.hidden, true);
  assert.equal(f.container.children.length, 0);
});

test('an approval card shows the command, reason, countdown and the choices the gateway offered', () => {
  const f = fixture();
  f.show([approval()]);
  assert.equal(f.container.querySelector('.agent-prompt-command').textContent, 'rm -rf build');
  assert.equal(f.container.querySelector('.agent-prompt-reason').textContent, 'recursive delete');
  assert.match(f.container.querySelector('.agent-prompt-countdown').textContent, /exec_approval\.countdown\|\{"time":"2:00"\}/);
  assert.deepEqual(buttonsOf(f.container).map((button) => button.dataset.choice), ['once', 'session', 'always', 'deny']);
  assert.match(f.container.textContent, /exec_approval\.choice_help/);
});

test('Deny is the last button, is styled as the safe default, and takes focus', () => {
  const f = fixture();
  try {
    f.show([approval()]);
    const deny = buttonsOf(f.container).at(-1);
    assert.equal(deny.dataset.choice, 'deny');
    assert.match(deny.className, /agent-prompt-deny/);
    assert.ok(f.isActive(deny), 'Deny holds focus, so a stray Enter or Space refuses');
    f.show([approval()], { now: NOW + 5000 });
    assert.equal(f.focused.length, 1, 'a countdown tick does not steal focus again');
  } finally {
    f.restore();
  }
});

test('focus is not taken from a field the user is typing in', () => {
  const f = fixture();
  try {
    const field = f.document.createElement('textarea');
    f.document.body.append(field);
    field.focus();
    f.show([approval()]);
    assert.ok(f.isActive(field));
    assert.equal(f.focused.length, 1, 'only the field itself was focused');
  } finally {
    f.restore();
  }
});

test('a smart-denied request offers only Approve once and Deny', () => {
  const f = fixture();
  f.show([approval({ choices: ['once', 'deny'] })]);
  assert.deepEqual(buttonsOf(f.container).map((button) => button.dataset.choice), ['once', 'deny']);
  assert.doesNotMatch(f.container.textContent, /exec_approval\.choice_help/, 'no explanation of grants that are not offered');
});

test('pressing a choice answers exactly that prompt', () => {
  const f = fixture();
  f.show([approval()]);
  buttonsOf(f.container).find((button) => button.dataset.choice === 'session').click();
  assert.deepEqual(f.calls, [['approval', 'rest:run-1:req-1', 'session']]);
});

test('text from Hermes is never parsed as markup', () => {
  const f = fixture();
  const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  f.show([approval({ command: hostile, description: hostile })]);
  assert.equal(f.container.querySelector('img'), null);
  assert.equal(f.container.querySelector('script'), null);
  assert.equal(f.container.querySelector('.agent-prompt-command').textContent, hostile);
  f.show([{ ...normalizeClarifyPrompt({ prompt_id: 'c', question: hostile, choices: [hostile] }, { scope: 'r', now: NOW }), actionable: true }]);
  assert.equal(f.container.querySelector('img'), null);
  assert.equal(f.container.querySelector('script'), null);
});

test('an edit approval renders a diff with textContent and no Always or Session button', () => {
  const f = fixture();
  const entry = approval({
    command: '',
    edit: { tool_name: 'write_file', path: 'src/<b>.js', old_text: 'a\n<script>x</script>\nc\n', new_text: 'a\n<script>y</script>\nc\n' },
  });
  f.show([entry]);
  assert.equal(f.container.querySelector('script'), null);
  const rows = [...f.container.querySelectorAll('.agent-prompt-diff-row')].map((row) => row.textContent);
  assert.ok(rows.includes('- <script>x</script>'));
  assert.ok(rows.includes('+ <script>y</script>'));
  assert.match(f.container.querySelector('summary').textContent, /src\/<b>\.js/);
  assert.deepEqual(buttonsOf(f.container).map((button) => button.dataset.choice), ['once', 'deny']);
});

test('the countdown updates without rebuilding the card', () => {
  const f = fixture();
  const entry = approval();
  f.show([entry], { now: NOW });
  const before = f.container.querySelector('.agent-prompt-body');
  f.show([entry], { now: NOW + 60_000 });
  assert.ok(f.container.querySelector('.agent-prompt-body') === before, 'same DOM node, so focus and typing survive');
  assert.match(f.container.querySelector('.agent-prompt-countdown').textContent, /"time":"1:00"/);
});

test('a request with no timeout shows no countdown', () => {
  const f = fixture();
  f.show([approval({ timeout_s: undefined })]);
  assert.equal(f.container.querySelector('.agent-prompt-countdown'), null);
});

test('the oldest prompt is shown with a count of those waiting behind it', () => {
  const f = fixture();
  f.show([approval({ request_id: 'a' }), approval({ request_id: 'b' }), approval({ request_id: 'c' })]);
  assert.match(f.container.querySelector('.agent-prompt-queue').textContent, /"count":2/);
  buttonsOf(f.container).at(-1).click();
  assert.equal(f.calls[0][1], 'rest:run-1:a');
});

test('while an answer is in flight the buttons are disabled', () => {
  const f = fixture();
  f.show([approval({}, { status: 'answering' })]);
  assert.ok(buttonsOf(f.container).every((button) => button.disabled));
});

test('a failed send shows the reason and leaves the buttons usable', () => {
  const f = fixture();
  f.show([approval({}, { error: 'HTTP 502' })]);
  const error = f.container.querySelector('.agent-prompt-error');
  assert.match(error.textContent, /exec_approval\.send_failed\|\{"error":"HTTP 502"\}/);
  assert.equal(error.getAttribute('role'), 'alert');
  assert.ok(buttonsOf(f.container).every((button) => !button.disabled));
});

test('an informational card offers no way to answer, only to close', () => {
  const f = fixture();
  f.show([approval({}, { actionable: false })]);
  assert.equal(buttonsOf(f.container).filter((button) => button.dataset.choice).length, 0);
  assert.match(f.container.textContent, /exec_approval\.info_only/);
  buttonsOf(f.container)[0].click();
  assert.deepEqual(f.calls, [['dismiss', 'rest:run-1:req-1']]);
});

test('a single-choice clarify question answers on the first click', () => {
  const f = fixture();
  const entry = { ...normalizeClarifyPrompt({ prompt_id: 'c1', execution_generation: 1, question: 'Env?', choices: ['staging', 'prod'] }, { scope: 'run-1', now: NOW }), actionable: true };
  f.show([entry]);
  assert.equal(f.container.querySelector('.agent-prompt-question-text').textContent, 'Env?');
  const choices = [...f.container.querySelectorAll('.agent-prompt-choice')];
  assert.deepEqual(choices.map((button) => button.textContent), ['staging', 'prod']);
  choices[1].click();
  assert.deepEqual(f.calls, [['clarify', 'rest:run-1:c1', { '': 'prod' }]]);
});

test('typed text answers a clarify question on Enter', () => {
  const f = fixture();
  const entry = { ...normalizeClarifyPrompt({ prompt_id: 'c1', question: 'Name?' }, { scope: 'run-1', now: NOW }), actionable: true };
  f.show([entry]);
  const input = f.container.querySelector('.agent-prompt-input');
  f.type(input, 'blue');
  const enter = new f.document.defaultView.Event('keydown', { cancelable: true });
  enter.key = 'Enter';
  input.dispatchEvent(enter);
  assert.deepEqual(f.calls, [['clarify', 'rest:run-1:c1', { '': 'blue' }]]);
});

test('typed text replaces a picked option in a multi-question batch', () => {
  const f = fixture();
  const entry = {
    ...promptFromServerRequest({
      id: 'srq-1', method: 'clarify',
      params: { session_id: 'live', questions: [{ qid: 'q1', question: 'Env?', choices: ['staging', 'prod'] }, { qid: 'q2', question: 'Why?' }] },
    }, { now: NOW }),
    actionable: true,
  };
  f.show([entry]);
  const choices = [...f.container.querySelectorAll('.agent-prompt-choice')];
  choices[0].click();
  assert.deepEqual(f.calls, [], 'a batch is only sent from its own button');
  f.type(f.container.querySelectorAll('.agent-prompt-input')[0], 'canary');
  buttonsOf(f.container).find((button) => button.textContent === 'clarify.send').click();
  assert.deepEqual(f.calls, [['clarify', 'ws:live:srq-1', { q1: 'canary', q2: null }]]);
});

test('an empty answer is not sent, Skip sends nulls', () => {
  const f = fixture();
  const entry = { ...normalizeClarifyPrompt({ prompt_id: 'c1', question: 'Name?' }, { scope: 'run-1', now: NOW }), actionable: true };
  f.show([entry]);
  const [send, skip] = buttonsOf(f.container);
  send.click();
  assert.deepEqual(f.calls, []);
  skip.click();
  assert.deepEqual(f.calls, [['clarify', 'rest:run-1:c1', { '': null }]]);
});

test('multi-select answers travel as a JSON array of the chosen labels', () => {
  const f = fixture();
  const entry = {
    ...normalizeClarifyPrompt({ prompt_id: 'c1', question: 'Which?', choices: ['a', 'b', 'c'], multi_select: true }, { scope: 'run-1', now: NOW }),
    actionable: true,
  };
  f.show([entry]);
  const choices = [...f.container.querySelectorAll('.agent-prompt-choice')];
  choices[0].click();
  choices[2].click();
  assert.deepEqual(f.calls, [], 'picking does not send');
  buttonsOf(f.container).find((button) => button.textContent === 'clarify.send').click();
  assert.deepEqual(f.calls, [['clarify', 'rest:run-1:c1', { '': '["a","c"]' }]]);
});

test('a WebSocket clarify batch collects an answer per question', () => {
  const f = fixture();
  const entry = {
    ...promptFromServerRequest({
      id: 'srq-1', method: 'clarify',
      params: { session_id: 'live', questions: [{ qid: 'q1', question: 'First?' }, { qid: 'q2', question: 'Second?' }] },
    }, { now: NOW }),
    actionable: true,
  };
  f.show([entry]);
  const inputs = [...f.container.querySelectorAll('.agent-prompt-input')];
  assert.equal(inputs.length, 2);
  f.type(inputs[0], 'one');
  buttonsOf(f.container).find((button) => button.textContent === 'clarify.send').click();
  assert.deepEqual(f.calls, [['clarify', 'ws:live:srq-1', { q1: 'one', q2: null }]]);
});

test('typed clarify text survives a re-render of the same prompt', () => {
  const f = fixture();
  const entry = { ...normalizeClarifyPrompt({ prompt_id: 'c1', question: 'Name?' }, { scope: 'run-1', now: NOW }), actionable: true };
  f.show([entry]);
  f.type(f.container.querySelector('.agent-prompt-input'), 'half typed');
  f.show([{ ...entry, status: 'answering' }]);
  assert.equal(f.container.querySelector('.agent-prompt-input').value, 'half typed');
  assert.equal(f.container.querySelector('.agent-prompt-input').disabled, true);
});

test('destroy hides the card and stops listening', () => {
  const f = fixture();
  f.show([approval()]);
  f.card.destroy();
  assert.equal(f.container.hidden, true);
  assert.equal(f.container.children.length, 0);
});
