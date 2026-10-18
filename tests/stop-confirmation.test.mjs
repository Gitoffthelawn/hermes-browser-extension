import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  RUN_CONTROL_PHASES,
  RUN_TERMINAL_STATUSES,
  RUN_UNCONFIRMED_REASONS,
  beginRunControl,
  canReleaseUnconfirmedRun,
  dashboardTerminalStatus,
  markRunTerminal,
  markRunUnconfirmed,
  requestRunStop,
  restTerminalStatus,
  waitForTerminalStatus,
  withRunControlId,
} from '../extension/lib/run-control-lifecycle.mjs';
import { WS_METHODS, readGatewaySessionStatus } from '../extension/lib/gateway-ws.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const sidepanel = read('extension/sidepanel.js');
const app = read('extension/app.js');

// ---- Stop confirmation ---------------------------------------------------------------

test('session.status answers rendered text, and Stop is confirmed from that text', () => {
  const idle = { output: 'Hermes TUI Status\n\nSession ID: abc\nAgent Running: No' };
  const busy = { output: 'Hermes TUI Status\n\nSession ID: abc\nAgent Running: Yes' };
  assert.equal(dashboardTerminalStatus(idle, { stopRequested: true }), RUN_TERMINAL_STATUSES.CANCELLED);
  assert.equal(dashboardTerminalStatus(idle), RUN_TERMINAL_STATUSES.COMPLETED);
  assert.equal(dashboardTerminalStatus(busy, { stopRequested: true }), '');
  assert.equal(dashboardTerminalStatus({ output: 'Hermes TUI Status' }, { stopRequested: true }), '', 'text without the line proves nothing');
  assert.equal(dashboardTerminalStatus({ output: 'Agent Running: Yesterday' }, { stopRequested: true }), '');
});

test('a polled Stop confirms against the real status text instead of timing out', async () => {
  const reads = [
    { output: 'Agent Running: Yes' },
    { output: 'Agent Running: Yes' },
    { output: 'Agent Running: No' },
  ];
  const result = await waitForTerminalStatus({
    readStatus: async () => reads.shift(),
    terminalStatus: (payload) => dashboardTerminalStatus(payload, { stopRequested: true }),
    timeoutMs: 1_000,
    pollMs: 1,
  });
  assert.equal(result.status, RUN_TERMINAL_STATUSES.CANCELLED);
  assert.equal(result.attempts, 3);
});

test('a session-authority state is read as running or idle, and other words keep the run held', () => {
  for (const status of ['working', 'waiting', 'starting', 'running']) {
    assert.equal(dashboardTerminalStatus({ status }, { stopRequested: true }), '', status);
  }
  assert.equal(dashboardTerminalStatus({ status: 'idle' }, { stopRequested: true }), RUN_TERMINAL_STATUSES.CANCELLED);
});

test('a run the gateway interrupted itself is over, and not completed', () => {
  assert.equal(restTerminalStatus({ status: 'interrupted' }), RUN_TERMINAL_STATUSES.CANCELLED);
  assert.equal(restTerminalStatus({ status: 'running' }), '');
  assert.equal(restTerminalStatus({ status: 'waiting_for_approval' }), '');
  assert.equal(dashboardTerminalStatus({ status: 'interrupted' }), RUN_TERMINAL_STATUSES.CANCELLED);
});

function scriptedClient(handlers, readyPayload = null) {
  const calls = [];
  return {
    calls,
    readyPayload,
    async request(method, params) {
      calls.push({ method, params });
      const handler = handlers[method];
      if (handler === undefined) {
        const error = new Error(`unknown method: ${method}`);
        error.rpcCode = -32601;
        error.data = { reason: 'unknown_method' };
        throw error;
      }
      const value = typeof handler === 'function' ? await handler(params) : handler;
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

test('a legacy gateway is asked session.status and nothing else', async () => {
  const client = scriptedClient({ [WS_METHODS.sessionStatus]: { output: 'Agent Running: No' } }, { heartbeat: true });
  assert.deepEqual(await readGatewaySessionStatus(client, 'live-1', { storedSessionId: 'sess-1' }), { output: 'Agent Running: No' });
  assert.deepEqual(client.calls.map((call) => call.method), [WS_METHODS.sessionStatus]);
});

test('a session authority is read from its active list, because it serves no session.status', async () => {
  const sessions = [{ id: 'other', status: 'working' }, { id: 'live-1', status: 'working' }];
  const client = scriptedClient({ [WS_METHODS.sessionActiveList]: async () => ({ sessions }) }, { session_authority: true });
  const busy = await readGatewaySessionStatus(client, 'live-1', { storedSessionId: 'sess-1' });
  assert.equal(dashboardTerminalStatus(busy, { stopRequested: true }), '');
  sessions[1].status = 'idle';
  const idle = await readGatewaySessionStatus(client, 'live-1', { storedSessionId: 'sess-1' });
  assert.equal(dashboardTerminalStatus(idle, { stopRequested: true }), RUN_TERMINAL_STATUSES.CANCELLED);
  assert.deepEqual(client.calls.at(-1), { method: WS_METHODS.sessionActiveList, params: { current_session_id: 'sess-1' } });
  sessions[1].status = 'starting';
  assert.equal(dashboardTerminalStatus(await readGatewaySessionStatus(client, 'live-1'), { stopRequested: true }), '');
});

test('a session the authority does not list is read from the resume snapshot, and unknown stays held', async () => {
  const snapshot = { running: false, execution_state: 'idle' };
  const client = scriptedClient({
    [WS_METHODS.sessionActiveList]: { sessions: [] },
    [WS_METHODS.sessionResume]: async () => snapshot,
  }, { session_authority: true });
  const idle = await readGatewaySessionStatus(client, 'live-1', { storedSessionId: 'sess-1' });
  assert.equal(dashboardTerminalStatus(idle, { stopRequested: true }), RUN_TERMINAL_STATUSES.CANCELLED);
  assert.deepEqual(client.calls.at(-1).params, { session_id: 'sess-1', omit_messages: true });
  for (const unreadable of [{ running: false, execution_state: 'unknown' }, { running: true, execution_state: 'running' }, {}]) {
    Object.keys(snapshot).forEach((key) => delete snapshot[key]);
    Object.assign(snapshot, unreadable);
    const held = await readGatewaySessionStatus(client, 'live-1', { storedSessionId: 'sess-1' });
    assert.equal(dashboardTerminalStatus(held, { stopRequested: true }), '', JSON.stringify(unreadable));
  }
});

test('only an authority gateway, and only for an unknown method, falls back; every other failure surfaces', async () => {
  const refused = Object.assign(new Error('permission_denied'), { rpcCode: 4001, data: { reason: 'permission_denied' } });
  const authority = scriptedClient({ [WS_METHODS.sessionStatus]: refused }, { session_authority: true });
  await assert.rejects(readGatewaySessionStatus(authority, 'live-1'), /permission_denied/);
  assert.equal(authority.calls.length, 1);
  const legacy = scriptedClient({}, { heartbeat: true });
  await assert.rejects(readGatewaySessionStatus(legacy, 'live-1'), /unknown method/);
  assert.equal(legacy.calls.length, 1, 'a legacy gateway is not probed with an authority verb');
  await assert.rejects(readGatewaySessionStatus(authority, ''), /live Hermes session/);
});

test('both surfaces confirm a dashboard Stop through the status reader', () => {
  assert.match(sidepanel, /readGatewaySessionStatus\(connection\.client, sessionId, \{ storedSessionId: connection\.wsStoredSessionId \}\)/);
  assert.match(app, /readGatewaySessionStatus\(connection\.client, dashboardStatusSessionId, \{ storedSessionId: activeSessionId \}\)/);
});

// ---- a Stop that never learned a run id ---------------------------------------------------

test('a stream that Stop closed is never turned into a completed run by the turn that was reading it', () => {
  const block = sidepanel.match(/&& \[RUN_CONTROL_PHASES\.RUNNING, RUN_CONTROL_PHASES\.STOPPING, RUN_CONTROL_PHASES\.UNCONFIRMED\]\.includes\(activeRunControl\?\.phase\)[\s\S]{0,420}?markRunTerminal\(activeRunControl, streamTerminalStatus \|\| 'completed'\)/)?.[0] || '';
  assert.match(block, /!\(streamAborted && activeRunControl\.phase !== RUN_CONTROL_PHASES\.RUNNING\)/);
  assert.match(sidepanel, /if \(isAbortError\(streamError\)\) \{\s*streamAborted = true;/);
  assert.match(sidepanel, /let streamAborted = false;/);
});

test('the lifecycle holds an unconfirmed Stop that has no run id, and only that one may be released by hand', () => {
  const running = requestRunStop(beginRunControl({ transport: 'rest' }));
  const held = markRunUnconfirmed(running, RUN_UNCONFIRMED_REASONS.RUN_ID_UNKNOWN);
  assert.equal(held.phase, RUN_CONTROL_PHASES.UNCONFIRMED);
  assert.equal(held.unconfirmedReason, RUN_UNCONFIRMED_REASONS.RUN_ID_UNKNOWN);
  assert.equal(canReleaseUnconfirmedRun(held), true);
  // Anything Hermes can still be asked about is confirmed by asking, never released by hand.
  assert.equal(canReleaseUnconfirmedRun(withRunControlId(held, 'run-9')), false);
  assert.equal(canReleaseUnconfirmedRun(markRunUnconfirmed(running, 'other')), false);
  assert.equal(canReleaseUnconfirmedRun(running), false);
  assert.equal(canReleaseUnconfirmedRun(markRunTerminal(held, 'cancelled')), false);
  assert.equal(canReleaseUnconfirmedRun(null), false);
});

test('Release exists on both surfaces, runs only from its button, and is declared in every locale', () => {
  assert.match(read('extension/sidepanel.html'), /<button id="releaseRunButton" type="button" data-i18n="run\.release" hidden>/);
  assert.match(read('extension/app.html'), /<button id="webReleaseRunButton" type="button" data-i18n="run\.release" hidden>/);
  assert.match(sidepanel, /els\.releaseRunButton\?\.addEventListener\('click', \(\) => \{ void releaseUnconfirmedRun\(\); \}\);/);
  assert.match(app, /els\.webReleaseRunButton\?\.addEventListener\('click', \(\) => \{ void releaseUnconfirmedWebRun\(\); \}\);/);
  assert.equal((sidepanel.match(/releaseUnconfirmedRun\(\)/g) || []).length, 2, 'declared and bound, never called anywhere else');
  assert.equal((app.match(/releaseUnconfirmedWebRun\(\)/g) || []).length, 2);
  const release = sidepanel.match(/async function releaseUnconfirmedRun\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(release, /if \(!canReleaseUnconfirmedRun\(activeRunControl\)\) return false;/);
  for (const locale of ['en', 'de', 'ja', 'zh-CN', 'pt-BR']) {
    const strings = read(`extension/lib/locales/${locale}.mjs`);
    assert.match(strings, /"run\.release": "[^"]+",/, locale);
    assert.match(strings, /"run\.release_detail": "[^"]+",/, locale);
  }
});
