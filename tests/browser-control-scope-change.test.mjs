import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers';
import { createControllerServiceWorker, CONTROLLER_WORKER_MESSAGES } from '../extension/lib/controller-service-worker.mjs';
import { TAB_LEASE_STORAGE_KEY } from '../extension/lib/tab-leases.mjs';

const trusted = { url: 'chrome-extension://scope-fixture/sidepanel.html' };
const type = 'HERMES_CONTROLLER_SCOPE_REPLACE';

async function fixture({ paused = false, approvalStore, getTab, beforeWrite } = {}) {
  const values = { hermesBrowserSettings: {
    connectionMode: 'local', connectionTransport: 'local-api', gatewayMode: 'local-api',
    gatewayUrl: 'http://127.0.0.1:8642', apiKey: ['scope', 'fixture', 'credential'].join('-'),
    activeProfile: 'default', sessionId: 'scope-session', browserControlEnabled: true,
    browserControlPaused: paused, browserControlScope: 'this-tab',
  } };
  let fail = false;
  let connection;
  const storageArea = {
    async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => Object.hasOwn(values, k)).map(k => [k, structuredClone(values[k])])); },
    async set(next) {
      if (fail && Object.hasOwn(next, 'hermesBrowserSettings')) throw new Error('fixture persistence failed');
      if (Object.hasOwn(next, 'hermesBrowserSettings')) await beforeWrite?.();
      Object.assign(values, structuredClone(next));
    },
  };
  const worker = createControllerServiceWorker({
    storageArea, extensionOrigin: 'chrome-extension://scope-fixture',
    product: { id: 'chromium', engine: 'chromium', label: 'Chromium' },
    randomUUID: (() => { let n = 0; return () => `scope-owner-${++n}`; })(),
    now: () => 1000,
    getTab: getTab || (async id => ({ id, windowId: 2, url: `https://example.test/${id}` })),
    executeBrowserCommand: async () => ({ ok: true, result: {} }),
    approvalStore,
    connector: { async connect(options) {
      connection = { async send() {}, async heartbeat() {}, close() {}, emit: frame => options.onFrame(frame) };
      return connection;
    } },
  });
  await worker.boot();
  const ownerId = worker.status().controllerId;
  await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.leaseAcquire, kind: 'this-tab', ownership: 'owned', ownerId, tabIds: [10], windowId: 2 }, trusted);
  const replace = (kind, tabIds, extra = {}, sender = trusted) => worker.handleMessage({ type, kind, tabIds, ownerId, expectedGeneration: worker.status().generation, expectedSettingsRevision: worker.status().settingsRevision, ...extra }, sender);
  return { worker, values, ownerId, replace, connection: () => connection, failWrite: () => { fail = true; } };
}

test('scope replacement is a declared trusted worker message', () => {
  assert.equal(CONTROLLER_WORKER_MESSAGES.scopeReplace, type);
});

test('inline scope replacement updates exact leases and preference without disabling control or reconnecting', async () => {
  const f = await fixture();
  const generation = f.worker.status().generation;
  const result = await f.replace('selected-tabs', [10, 12]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.leasedTabIds, [10, 12]);
  assert.equal(result.controllerId, f.ownerId);
  assert.equal(result.generation, generation);
  assert.equal(result.controlEnabled, true);
  assert.equal(result.paused, false);
  assert.equal(f.values.hermesBrowserSettings.browserControlScope, 'selected-tabs');
  assert.deepEqual(f.values[TAB_LEASE_STORAGE_KEY].entries.map(l => l.kind), ['selected-tabs', 'selected-tabs']);
  assert.equal(Object.hasOwn(f.values.hermesBrowserSettings, 'browserControlViewBehavior'), false);
});

test('task-set and this-tab changes replace kind and drop only the previous owned tabs', async () => {
  const f = await fixture({ paused: true });
  await f.worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.leaseAcquire, kind: 'this-tab', ownership: 'borrowed', ownerId: 'observer', tabIds: [20] }, trusted);
  assert.equal((await f.replace('task-set', [10, 12], { taskSetId: 'scope-task' })).ok, true);
  assert.equal(f.values[TAB_LEASE_STORAGE_KEY].entries.find(l => l.tabId === 12).taskSetId, 'scope-task');
  const result = await f.replace('this-tab', [12]);
  assert.equal(result.ok, true);
  assert.equal(result.paused, true);
  assert.deepEqual([...result.leasedTabIds].sort((a, b) => a - b), [12, 20]);
  assert.equal(f.values[TAB_LEASE_STORAGE_KEY].entries.find(l => l.tabId === 20).ownerId, 'observer');
});

for (const [name, kind, ids, extra] of [
  ['empty multi-tab selection', 'selected-tabs', [], {}],
  ['implicit all tabs', 'all-tabs', [10], {}],
  ['invalid id', 'selected-tabs', [10, -1], {}],
  ['string id', 'this-tab', ['10'], {}],
  ['more than one this-tab', 'this-tab', [10, 12], {}],
  ['task without identity', 'task-set', [10], {}],
  ['wrong controller owner', 'this-tab', [10], { ownerId: 'not-this-controller' }],
]) test(`scope replacement rejects ${name} without changing leases or settings`, async () => {
  const f = await fixture();
  const before = structuredClone(f.values);
  const result = await f.replace(kind, ids, extra);
  assert.equal(result.ok, false);
  assert.deepEqual(f.values, before);
  assert.deepEqual(f.worker.status().leasedTabIds, [10]);
});

test('untrusted page cannot change control scope', async () => {
  const f = await fixture();
  const result = await f.replace('selected-tabs', [10, 12], {}, { url: 'https://example.test' });
  assert.equal(result.error, 'untrusted_sender');
  assert.deepEqual(f.worker.status().leasedTabIds, [10]);
});

test('a selected borrowed lease conflict preserves the original attachment', async () => {
  const f = await fixture();
  await f.worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.leaseAcquire, kind: 'this-tab', ownership: 'borrowed', ownerId: 'observer', tabIds: [20] }, trusted);
  const before = structuredClone(f.values);
  const result = await f.replace('selected-tabs', [10, 20]);
  assert.equal(result.ok, false);
  assert.deepEqual(f.values, before);
});

test('restricted and vanished selected tabs preserve the old scope', async () => {
  for (const getTab of [async id => ({ id, url: 'chrome://settings/', windowId: 2 }), async () => { throw new Error('Tab closed'); }]) {
    const f = await fixture({ getTab });
    const before = structuredClone(f.values);
    const result = await f.replace('selected-tabs', [10, 12]);
    assert.equal(result.ok, false);
    assert.deepEqual(f.values, before);
  }
});

test('pending approval blocks authority replacement', async () => {
  const f = await fixture({ approvalStore: { grant() {}, consume() {}, count: () => 1, pending: () => [{ approvalId: 'pending' }] } });
  const result = await f.replace('selected-tabs', [10, 12]);
  assert.equal(result.error, 'controller_busy');
  assert.deepEqual(f.worker.status().leasedTabIds, [10]);
});

test('failed atomic persistence rolls back runtime and retains the old stored scope', async () => {
  const f = await fixture();
  const before = structuredClone(f.values);
  f.failWrite();
  const result = await f.replace('selected-tabs', [10, 12]);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'scope_persist_failed');
  assert.deepEqual(f.worker.status().leasedTabIds, [10]);
  assert.deepEqual(f.values, before);
});

for (const extra of [{ expectedGeneration: -1 }, { expectedSettingsRevision: -1 }]) {
  test(`stale authority cannot replace leases: ${Object.keys(extra)[0]}`, async () => {
    const f = await fixture();
    const before = structuredClone(f.values);
    const result = await f.replace('selected-tabs', [10, 12], extra);
    assert.equal(result.error, 'stale_controller');
    assert.deepEqual(f.values, before);
  });
}

test('a successful scope acknowledgment is no longer marked in progress', async () => {
  const f = await fixture();
  const result = await f.replace('selected-tabs', [10, 12]);
  assert.equal(result.scopeChanging, false);
});

test('a queued metadata write cannot resurrect staged leases after a failed scope save', async () => {
  let entered;
  let release;
  const saving = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture({ beforeWrite: async () => { entered(); await gate; throw new Error('save rejected'); } });
  const changing = f.replace('selected-tabs', [10, 12]);
  await saving;
  const metadata = f.worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.documentReady, tabId: 10, frameId: 0 }, trusted);
  await new Promise(resolve => setImmediate(resolve));
  release();
  assert.equal((await changing).error, 'scope_persist_failed');
  await metadata;
  assert.deepEqual(f.worker.status().ownedTabIds, [10]);
  assert.deepEqual(f.values[TAB_LEASE_STORAGE_KEY].entries.map(l => l.tabId), [10]);
  assert.equal(f.values.hermesBrowserSettings.browserControlScope, 'this-tab');
});


