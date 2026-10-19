import assert from 'node:assert/strict';
import test from 'node:test';

async function refsModule() {
  try {
    return await import('../extension/lib/browser-control-refs.mjs');
  } catch (error) {
    assert.fail(`Phase 6 browser-control refs module is required: ${error?.message || error}`);
  }
}

const scope = Object.freeze({
  controllerId: 'controller-1',
  leaseOwnerId: 'controller-1',
  leaseId: 'lease-1',
  tabId: 7,
  frameId: 0,
  documentGeneration: 3,
});

test('Phase 6 snapshots mint stable bounded refs without exposing sensitive field values', async () => {
  const { createBrowserControlRefStore } = await refsModule();
  const refs = createBrowserControlRefStore({ maxRefsPerDocument: 3, maxDocuments: 2 });
  const snapshot = refs.replace({
    ...scope,
    nodes: [
      { role: 'heading', name: 'Welcome' },
      { role: 'textbox', name: 'Search', value: 'public query', backendDOMNodeId: 11 },
      { role: 'textbox', name: 'Password', value: 'never-return-this', inputType: 'password', backendDOMNodeId: 12 },
      { role: 'button', name: 'Continue', backendDOMNodeId: 13 },
    ],
  });

  assert.equal(snapshot.ok, true);
  assert.deepEqual(snapshot.refs.map((item) => item.ref), ['@e1', '@e2', '@e3']);
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.refs[1].name, 'Search');
  assert.equal('value' in snapshot.refs[1], false);
  assert.equal(snapshot.refs[2].name, 'Sensitive field');
  assert.equal(snapshot.refs[2].sensitive, true);
  assert.doesNotMatch(JSON.stringify(snapshot), /never-return-this|public query/);

  const repeated = refs.replace({
    ...scope,
    nodes: [
      { role: 'heading', name: 'Welcome' },
      { role: 'textbox', name: 'Search', backendDOMNodeId: 11 },
    ],
  });
  assert.deepEqual(repeated.refs.map((item) => item.ref), ['@e1', '@e2']);
});

test('Phase 6 ref resolution requires exact controller, lease, tab, frame, and document generation', async () => {
  const { createBrowserControlRefStore } = await refsModule();
  const refs = createBrowserControlRefStore();
  refs.replace({ ...scope, nodes: [{ role: 'button', name: 'Search', backendDOMNodeId: 44 }] });

  const exact = refs.resolve({ ...scope, ref: '@e1' });
  assert.equal(exact.ok, true);
  assert.equal(exact.target.backendDOMNodeId, 44);

  for (const mismatch of [
    { controllerId: 'controller-2' },
    { leaseOwnerId: 'foreign-owner' },
    { leaseId: 'lease-2' },
    { tabId: 8 },
    { frameId: 2 },
    { documentGeneration: 4 },
  ]) {
    const result = refs.resolve({ ...scope, ...mismatch, ref: '@e1' });
    assert.equal(result.ok, false, JSON.stringify(mismatch));
    assert.equal(result.error, 'stale_ref_scope', JSON.stringify(mismatch));
  }
  assert.deepEqual(refs.resolve({ ...scope, ref: '@e99' }), { ok: false, error: 'unknown_ref' });
});

test('Phase 6 navigation invalidates only affected ref scopes and bounds retained documents', async () => {
  const { createBrowserControlRefStore } = await refsModule();
  const refs = createBrowserControlRefStore({ maxDocuments: 2 });
  refs.replace({ ...scope, tabId: 7, nodes: [{ role: 'button', name: 'A' }] });
  refs.replace({ ...scope, tabId: 8, nodes: [{ role: 'button', name: 'B' }] });
  assert.equal(refs.documentCount(), 2);

  assert.equal(refs.invalidateTab(7), 1);
  assert.equal(refs.resolve({ ...scope, tabId: 7, ref: '@e1' }).error, 'stale_ref_scope');
  assert.equal(refs.resolve({ ...scope, tabId: 8, ref: '@e1' }).ok, true);

  refs.replace({ ...scope, tabId: 9, nodes: [{ role: 'button', name: 'C' }] });
  refs.replace({ ...scope, tabId: 10, nodes: [{ role: 'button', name: 'D' }] });
  assert.equal(refs.documentCount(), 2);
  assert.equal(refs.resolve({ ...scope, tabId: 8, ref: '@e1' }).error, 'stale_ref_scope');
});

test('Phase 6 re-snapshots keep the refs of surviving nodes and never reuse a vanished ref number', async () => {
  const { createBrowserControlRefStore } = await refsModule();
  const refs = createBrowserControlRefStore();
  const first = refs.replace({
    ...scope,
    nodes: [
      { role: 'button', name: 'Search', backendDOMNodeId: 11 },
      { role: 'link', name: 'Docs', backendDOMNodeId: 12 },
      { role: 'button', name: 'Cart', backendDOMNodeId: 13 },
    ],
  });
  assert.deepEqual(first.refs.map((item) => item.ref), ['@e1', '@e2', '@e3']);

  // A banner appears before everything, Docs vanishes, order changes.
  const second = refs.replace({
    ...scope,
    nodes: [
      { role: 'button', name: 'Accept cookies', backendDOMNodeId: 20 },
      { role: 'button', name: 'Cart', backendDOMNodeId: 13 },
      { role: 'button', name: 'Search', backendDOMNodeId: 11 },
    ],
  });
  assert.deepEqual(second.refs.map((item) => [item.name, item.ref]), [
    ['Accept cookies', '@e4'],
    ['Cart', '@e3'],
    ['Search', '@e1'],
  ]);
  assert.equal(refs.resolve({ ...scope, ref: '@e1' }).target.backendDOMNodeId, 11);
  assert.equal(refs.resolve({ ...scope, ref: '@e3' }).target.backendDOMNodeId, 13);
  assert.deepEqual(refs.resolve({ ...scope, ref: '@e2' }), { ok: false, error: 'unknown_ref' }, 'the vanished node loses its ref');

  // The old @e2 must not silently point at a different element later.
  const third = refs.replace({ ...scope, nodes: [
    { role: 'link', name: 'Docs', backendDOMNodeId: 99 },
    { role: 'button', name: 'Search', backendDOMNodeId: 11 },
  ] });
  assert.deepEqual(third.refs.map((item) => item.ref), ['@e5', '@e1']);
  assert.equal(refs.resolve({ ...scope, ref: '@e2' }).ok, false);
});

test('Phase 6 stable refs reset when the document generation, tab, or frame changes', async () => {
  const { createBrowserControlRefStore } = await refsModule();
  const refs = createBrowserControlRefStore();
  const nodes = [{ role: 'button', name: 'A', backendDOMNodeId: 5 }, { role: 'button', name: 'B', backendDOMNodeId: 6 }];
  refs.replace({ ...scope, nodes });
  refs.replace({ ...scope, nodes: [nodes[1]] });
  assert.equal(refs.resolve({ ...scope, ref: '@e2' }).target.name, 'B');

  for (const change of [{ documentGeneration: 4 }, { tabId: 8 }, { frameId: 2 }]) {
    const fresh = refs.replace({ ...scope, ...change, nodes: [nodes[1], nodes[0]] });
    assert.deepEqual(fresh.refs.map((item) => item.ref), ['@e1', '@e2'], JSON.stringify(change));
  }
  refs.invalidateScope(scope);
  const afterInvalidate = refs.replace({ ...scope, nodes });
  assert.deepEqual(afterInvalidate.refs.map((item) => item.ref), ['@e1', '@e2'], 'an invalidated document starts numbering again');
});

test('Phase 6 stable refs match nodes without a DOM id by role, name, and occurrence', async () => {
  const { createBrowserControlRefStore } = await refsModule();
  const refs = createBrowserControlRefStore();
  refs.replace({ ...scope, nodes: [
    { role: 'button', name: 'More' },
    { role: 'button', name: 'More' },
    { role: 'link', name: 'Home' },
  ] });
  const again = refs.replace({ ...scope, nodes: [
    { role: 'link', name: 'Home' },
    { role: 'button', name: 'More' },
    { role: 'button', name: 'More' },
    { role: 'button', name: 'More' },
  ] });
  assert.deepEqual(again.refs.map((item) => item.ref), ['@e3', '@e1', '@e2', '@e4']);
});

test('Phase 6 refs carry state flags but never field values or the raw input type', async () => {
  const { createBrowserControlRefStore } = await refsModule();
  const refs = createBrowserControlRefStore();
  const minted = refs.replace({ ...scope, nodes: [
    {
      role: 'textbox', name: 'Search', backendDOMNodeId: 1, focused: true, editable: true, hasValue: true, value: 'typed secret', inputType: 'search',
    },
    { role: 'checkbox', name: 'Agree', backendDOMNodeId: 2, checked: false, disabled: true },
    { role: 'button', name: 'Menu', backendDOMNodeId: 3, expanded: true },
    { role: 'textbox', name: '', backendDOMNodeId: 4, inputType: 'password', hasValue: true },
  ] });
  assert.deepEqual(minted.refs[0], {
    ref: '@e1', role: 'textbox', name: 'Search', sensitive: false, backendDOMNodeId: 1, focused: true, editable: true, hasValue: true,
  });
  assert.deepEqual([minted.refs[1].checked, minted.refs[1].disabled], [false, true]);
  assert.equal(minted.refs[2].expanded, true);
  assert.deepEqual([minted.refs[3].name, minted.refs[3].sensitive], ['Sensitive field', true], 'an unnamed password input is sensitive through its type');
  assert.doesNotMatch(JSON.stringify(minted), /typed secret|inputType|search"/);
  assert.equal(refs.resolve({ ...scope, ref: '@e2' }).target.disabled, true);
});

test('Phase 6 stable refs still honour the per-document cap', async () => {
  const { createBrowserControlRefStore } = await refsModule();
  const refs = createBrowserControlRefStore({ maxRefsPerDocument: 2 });
  const nodes = [1, 2, 3].map((id) => ({ role: 'button', name: `B${id}`, backendDOMNodeId: id }));
  refs.replace({ ...scope, nodes });
  const shifted = refs.replace({ ...scope, nodes: [nodes[2], ...nodes.slice(0, 2)] });
  assert.equal(shifted.truncated, true);
  assert.deepEqual(shifted.refs.map((item) => [item.name, item.ref]), [['B3', '@e3'], ['B1', '@e1']]);
  assert.equal(refs.resolve({ ...scope, ref: '@e2' }).ok, false);
});
