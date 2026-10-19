import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GATEWAY_QUIRK,
  GATEWAY_QUIRK_TTL_MS,
  GATEWAY_QUIRKS_STORAGE_KEY,
  createGatewayQuirkStore,
  gatewayQuirkScope,
  isSessionPatchRejection,
} from '../extension/lib/gateway-quirks.mjs';

const GATEWAY = 'https://gateway.example.test/';
const SOURCE = GATEWAY_QUIRK.SESSION_SOURCE_PATCH;

function memoryStorage(initial = {}) {
  const values = { ...initial };
  return {
    values,
    get: async (key) => ({ [key]: values[key] }),
    set: async (patch) => Object.assign(values, patch),
  };
}

test('a PATCH for a session that is gone is not read as a refused field', () => {
  const gone = { status: 404 };
  assert.equal(isSessionPatchRejection(gone, { error: { code: 'session_not_found', message: 'Session not found: abc' } }), false);
  // Without the session code, a 404 means the route itself is missing.
  assert.equal(isSessionPatchRejection(gone, { error: '404: Not Found' }), true);
  assert.equal(isSessionPatchRejection({ status: 405 }, null), true);
  assert.equal(isSessionPatchRejection({ status: 501 }, null), true);
});

test('only the unsupported-field answer counts as a refusal of the source field', () => {
  assert.equal(isSessionPatchRejection({ status: 400 }, { error: { code: 'unsupported_session_field', message: 'Unsupported session fields: source' } }), true);
  assert.equal(isSessionPatchRejection({ status: 400 }, { error: 'Unsupported session field: source' }), true);
  assert.equal(isSessionPatchRejection({ status: 400 }, { error: { code: 'invalid_title' } }), false);
  assert.equal(isSessionPatchRejection({ status: 500 }, { error: { code: 'unsupported_session_field' } }), false);
});

test('a probe is claimed once per gateway and field until its answer comes back', () => {
  const store = createGatewayQuirkStore({ storageArea: memoryStorage() });
  assert.equal(store.beginProbe(GATEWAY, SOURCE), true);
  assert.equal(store.beginProbe(GATEWAY, SOURCE), false, 'a second request waits for the first answer');
  assert.equal(store.beginProbe(GATEWAY, GATEWAY_QUIRK.PROMPT_DISPLAY_TEXT), true, 'other fields are independent');
  store.endProbe(GATEWAY, SOURCE);
  assert.equal(store.beginProbe(GATEWAY, SOURCE), true, 'an accepted probe leaves the field open for later sends');
});

test('a refusal is remembered for that gateway, persisted, and never probed again', async () => {
  const storage = memoryStorage();
  const now = 1_700_000_000_000;
  const store = createGatewayQuirkStore({ storageArea: storage, now: () => now });
  await store.load();
  assert.equal(store.beginProbe(GATEWAY, SOURCE), true);
  await store.markUnsupported(GATEWAY, SOURCE);
  store.endProbe(GATEWAY, SOURCE);

  assert.equal(store.isUnsupported(GATEWAY, SOURCE), true);
  assert.equal(store.beginProbe(GATEWAY, SOURCE), false);
  assert.equal(store.isUnsupported('https://other.example.test/', SOURCE), false, 'the answer is per gateway');
  assert.deepEqual(storage.values[GATEWAY_QUIRKS_STORAGE_KEY], {
    'https://gateway.example.test': { [SOURCE]: now },
  });

  const restarted = createGatewayQuirkStore({ storageArea: storage, now: () => now + 1_000 });
  await restarted.load();
  assert.equal(restarted.isUnsupported(GATEWAY, SOURCE), true, 'the refusal survives a reload of the panel');
});

test('a remembered refusal expires so an upgraded gateway gets another chance', async () => {
  const marked = 1_700_000_000_000;
  const storage = memoryStorage({
    [GATEWAY_QUIRKS_STORAGE_KEY]: { 'https://gateway.example.test': { [SOURCE]: marked } },
  });
  const later = createGatewayQuirkStore({ storageArea: storage, now: () => marked + GATEWAY_QUIRK_TTL_MS + 1 });
  await later.load();
  assert.equal(later.isUnsupported(GATEWAY, SOURCE), false);
  assert.equal(later.beginProbe(GATEWAY, SOURCE), true);
});

test('unknown fields, unknown gateways and unavailable storage never block a send', async () => {
  const store = createGatewayQuirkStore({
    storageArea: {
      get: async () => { throw new Error('storage unavailable'); },
      set: async () => { throw new Error('storage unavailable'); },
    },
  });
  await assert.doesNotReject(store.load());
  assert.equal(store.beginProbe(GATEWAY, 'not-a-quirk'), false);
  assert.equal(store.beginProbe('', SOURCE), false);
  assert.equal(await store.markUnsupported(GATEWAY, SOURCE), true, 'the answer still applies to this page');
  assert.equal(store.isUnsupported(GATEWAY, SOURCE), true);
});

test('gateway scope is the lower-cased origin so one gateway has one answer', () => {
  assert.equal(gatewayQuirkScope('HTTPS://Gateway.Example.test:443/some/path/'), 'https://gateway.example.test');
  assert.equal(gatewayQuirkScope(''), '');
});
