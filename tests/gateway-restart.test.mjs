import test from 'node:test';
import assert from 'node:assert/strict';

import { parseHTML } from 'linkedom';
import {
  createGatewayRestartAction,
  gatewayRestartFailureText,
  GATEWAY_RESTART_WAIT_MS,
  restartGatewayViaDashboard,
  waitForGatewayReturn,
  watchGatewayRestart,
} from '../extension/lib/gateway-restart.mjs';

const BASE = 'http://127.0.0.1:9999';

function response(status, body, { json = true } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (json ? JSON.stringify(body) : String(body)),
    json: async () => body,
  };
}

function fakeDashboard({ bootIds = ['old', 'new'], restartStatus = 200, token = 'tok123', downPolls = 0 } = {}) {
  const calls = [];
  let statusReads = 0;
  let restarted = false;
  const fetchFn = async (url, options = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: options.method || 'GET', token: options.headers?.['X-Hermes-Session-Token'] });
    if (path === '/') return response(200, `<script>window.__HERMES_SESSION_TOKEN__="${token}";</script>`, { json: false });
    if (path === '/api/gateway/restart') { restarted = true; return response(restartStatus, { ok: restartStatus === 200 }); }
    if (path === '/api/status') {
      statusReads += 1;
      if (restarted && statusReads <= downPolls + 1) throw new Error('connection refused');
      const bootId = restarted ? bootIds[1] : bootIds[0];
      return response(200, { gateway_running: true, gateway_state: 'running', memory: { boot_id: bootId } });
    }
    return response(404, {});
  };
  return { fetchFn, calls };
}

const fast = { pollMs: 1, sleep: async () => {} };

test('restart posts to the dashboard with the session token and waits for a new boot id', async () => {
  const dash = fakeDashboard();
  const result = await restartGatewayViaDashboard({ baseUrl: BASE, fetchFn: dash.fetchFn, ...fast });

  assert.equal(result.ok, true);
  assert.equal(result.bootId, 'new');
  const post = dash.calls.find((call) => call.path === '/api/gateway/restart');
  assert.equal(post.method, 'POST');
  assert.equal(post.token, 'tok123');
});

test('restart is not reported until the old gateway is actually replaced', async () => {
  const dash = fakeDashboard({ bootIds: ['same', 'same'] });
  const result = await restartGatewayViaDashboard({ baseUrl: BASE, fetchFn: dash.fetchFn, waitMs: 1_000, ...fast });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
});

test('restart tolerates the gateway being briefly down while it relaunches', async () => {
  const dash = fakeDashboard({ downPolls: 3 });
  const result = await restartGatewayViaDashboard({ baseUrl: BASE, fetchFn: dash.fetchFn, ...fast });
  assert.equal(result.ok, true);
});

test('restart reports a refused request and never claims success', async () => {
  const dash = fakeDashboard({ restartStatus: 401 });
  const result = await restartGatewayViaDashboard({ baseUrl: BASE, fetchFn: dash.fetchFn, ...fast });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'rejected');
  assert.equal(result.status, 401);
});

test('restart without a dashboard or token fails with a reason instead of guessing', async () => {
  assert.equal((await restartGatewayViaDashboard({ baseUrl: '', ...fast })).reason, 'no-dashboard');
  const noToken = fakeDashboard({ token: '' });
  assert.equal((await restartGatewayViaDashboard({ baseUrl: BASE, fetchFn: noToken.fetchFn, ...fast })).reason, 'no-token');
  const unreachable = await restartGatewayViaDashboard({ baseUrl: BASE, fetchFn: async () => { throw new Error('down'); }, ...fast });
  assert.equal(unreachable.reason, 'unreachable');
});

test('the wait budget outlasts a measured ~85s multi-profile restart', () => {
  assert.ok(GATEWAY_RESTART_WAIT_MS >= 150_000);
});

test('a timeout hands back the old boot id so a later check cannot be fooled by the old process', async () => {
  const dash = fakeDashboard({ bootIds: ['same', 'same'] });
  const result = await restartGatewayViaDashboard({ baseUrl: BASE, fetchFn: dash.fetchFn, waitMs: 1_000, ...fast });
  assert.equal(result.beforeBootId, 'same');
});

test('progress reports stopping then starting, and success needs a running gateway', async () => {
  const seq = [
    { gateway_running: true, gateway_state: 'running', memory: { boot_id: 'old' } },
    null,
    { gateway_running: false, gateway_state: 'starting', memory: { boot_id: 'new' } },
    { gateway_running: true, gateway_state: 'running', memory: { boot_id: 'new' } },
  ];
  let i = 0;
  const fetchFn = async () => {
    const next = seq[Math.min(i, seq.length - 1)]; i += 1;
    if (!next) throw new Error('refused');
    return response(200, next);
  };
  const stages = [];
  const result = await waitForGatewayReturn({ baseUrl: BASE, beforeBootId: 'old', fetchFn, onProgress: ({ stage }) => stages.push(stage), ...fast });
  assert.equal(result.ok, true);
  assert.deepEqual(stages, ['stopping', 'starting']);
});

test('a new boot id that is not running yet is not a finished restart', async () => {
  const fetchFn = async () => response(200, { gateway_running: false, gateway_state: 'starting', memory: { boot_id: 'new' } });
  const result = await waitForGatewayReturn({ baseUrl: BASE, beforeBootId: 'old', fetchFn, waitMs: 1_000, ...fast });
  assert.equal(result.ok, false);
});

function mount(options = {}) {
  const { document } = parseHTML('<!doctype html><html><body></body></html>');
  const action = createGatewayRestartAction({ document, ...options });
  document.body.append(action);
  const q = (selector) => action.querySelector(selector);
  const click = async (selector) => { q(selector).dispatchEvent(new document.defaultView.Event('click')); await new Promise((r) => setTimeout(r, 5)); };
  return { action, q, click };
}

test('restart control walks idle -> armed -> working -> done and shows the success send-off', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let restarted = 0;
  const { action, q, click } = mount({ restart: async ({ onProgress }) => { restarted += 1; onProgress({ stage: 'starting' }); await gate; return { ok: true }; } });

  assert.equal(action.dataset.phase, 'idle');
  await click('.gateway-restart-primary');
  assert.equal(action.dataset.phase, 'armed');
  assert.equal(restarted, 0);
  await click('.gateway-restart-primary');
  assert.equal(action.dataset.phase, 'working');
  assert.equal(action.dataset.stage, 'starting');
  assert.equal(q('.gateway-restart-progress').hidden, false);
  assert.equal(q('.gateway-restart-primary').disabled, true);
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(action.dataset.phase, 'done');
  assert.equal(q('.gateway-restart-success').hidden, false);
  assert.equal(q('.gateway-restart-buttons').hidden, true, 'The restart button must not come back after a finished restart.');
  assert.equal(q('.gateway-restart-success-text').textContent, 'Hermes restarted');
});

test('a slow restart becomes Check again and never falls back to a second restart', async () => {
  let restarts = 0;
  let checks = 0;
  const { action, q, click } = mount({
    restart: async () => { restarts += 1; return { ok: false, reason: 'timeout', beforeBootId: 'old' }; },
    check: async ({ beforeBootId }) => { checks += 1; assert.equal(beforeBootId, 'old'); return { ok: true }; },
  });
  await click('.gateway-restart-primary');
  await click('.gateway-restart-primary');
  assert.equal(action.dataset.phase, 'stalled');
  assert.equal(q('.gateway-restart-primary').textContent, 'Check again');
  await click('.gateway-restart-primary');
  assert.equal(action.dataset.phase, 'done');
  assert.equal(restarts, 1);
  assert.equal(checks, 1);
});

test('a refused restart returns to the button with the manual command, not a fake success', async () => {
  const { action, q, click } = mount({ restart: async () => ({ ok: false, reason: 'rejected' }) });
  await click('.gateway-restart-primary');
  await click('.gateway-restart-primary');
  assert.equal(action.dataset.phase, 'idle');
  assert.match(q('.gateway-restart-note').textContent, /hermes gateway restart/);
});

test('watcher stays silent while the gateway is healthy, then follows an outside restart to done', async () => {
  const seq = [
    { gateway_running: true, gateway_state: 'running', memory: { boot_id: 'a' } },
    { gateway_running: true, gateway_state: 'running', memory: { boot_id: 'a' } },
    null,
    { gateway_running: false, gateway_state: 'starting', memory: { boot_id: 'b' } },
    { gateway_running: true, gateway_state: 'running', memory: { boot_id: 'b' } },
  ];
  let i = 0;
  const fetchFn = async () => {
    const next = seq[Math.min(i, seq.length - 1)]; i += 1;
    if (!next) throw new Error('refused');
    return response(200, next);
  };
  const stages = [];
  const result = await watchGatewayRestart({ baseUrl: BASE, fetchFn, onProgress: ({ stage }) => stages.push(stage), ...fast });
  assert.equal(result.ok, true);
  assert.equal(result.bootId, 'b');
  assert.deepEqual(stages, ['stopping', 'starting']);
});

test('watcher never reports a restart when the gateway simply keeps running', async () => {
  const fetchFn = async () => response(200, { gateway_running: true, gateway_state: 'running', memory: { boot_id: 'a' } });
  const stages = [];
  let polls = 0;
  const result = await watchGatewayRestart({
    baseUrl: BASE, fetchFn, onProgress: ({ stage }) => stages.push(stage), shouldStop: () => (polls += 1) > 5, ...fast,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stopped');
  assert.deepEqual(stages, []);
});

test('control follows an outside restart with no click and never calls restart', async () => {
  let restarts = 0;
  const { action, q } = mount({
    restart: async () => { restarts += 1; return { ok: true }; },
    watch: async ({ onProgress, shouldStop }) => {
      onProgress({ stage: 'stopping' });
      await new Promise((r) => setTimeout(r, 5));
      onProgress({ stage: 'starting' });
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(shouldStop(), false);
      return { ok: true };
    },
  });
  // Poll for the terminal phase instead of a fixed sleep so the assertion does
  // not race the watcher timers under full-suite load.
  const deadline = Date.now() + 2000;
  while (action.dataset.phase !== 'done' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(action.dataset.phase, 'done');
  assert.equal(q('.gateway-restart-buttons').hidden, true);
  assert.equal(restarts, 0);
});

test('a user click takes over from the watcher so the two never fight', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let watcherStopped = false;
  const { action, click } = mount({
    restart: async () => { await gate; return { ok: true }; },
    watch: async ({ shouldStop }) => { while (!shouldStop()) await new Promise((r) => setTimeout(r, 2)); watcherStopped = true; return { ok: false, reason: 'stopped' }; },
  });
  await click('.gateway-restart-primary');
  await click('.gateway-restart-primary');
  assert.equal(action.dataset.phase, 'working');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(watcherStopped, true);
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(action.dataset.phase, 'done');
});

test('every failure reason tells the user the manual command', () => {
  for (const reason of ['no-dashboard', 'no-token', 'rejected', 'unreachable', 'timeout', 'anything-else']) {
    assert.match(gatewayRestartFailureText(reason), /hermes gateway restart/);
  }
});
