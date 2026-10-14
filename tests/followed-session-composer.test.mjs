import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { composerControlState } from '../extension/lib/common.mjs';
const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('function currentComposerDraftState('), source.indexOf('function updateComposerBusyState('));

test('the composer treats a followed live session as busy without pretending this panel submitted the turn', () => {
  const context = vm.createContext({ sending: false, composerControlState, isConnected: () => true,
    viewedSessionIsRunning: () => true, canSteerActiveRun: () => true,
    attachments: [], els: { input: { value: 'Use the other file' } } });
  const state = vm.runInContext(`${body};currentComposerDraftState()`, context);
  assert.equal(state.busyDraft, true);
  assert.equal(state.controls.steer.hidden, false);
  assert.equal(state.controls.queue.hidden, false);
  assert.equal(state.controls.inlineSend.hidden, true);
});
