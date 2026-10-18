import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { pairingStartCanContinue } from '../extension/lib/common.mjs';

test('automatic pairing continues only after an OK answer with a token or an approval link', () => {
  assert.equal(pairingStartCanContinue({ ok: true, payload: { token: 'tok' } }), true);
  assert.equal(pairingStartCanContinue({ ok: true, payload: { approval_url: 'https://gateway.example.test/approve', pairing_id: 'p1' } }), true);
  assert.equal(pairingStartCanContinue({ ok: true, payload: {} }), false, 'an answer with nothing to act on is manual setup');
  assert.equal(pairingStartCanContinue({ ok: true, payload: null }), false, 'an unreadable answer is manual setup');
  assert.equal(pairingStartCanContinue({ ok: true, payload: 'not json' }), false);
  assert.equal(pairingStartCanContinue({ ok: false, payload: { token: 'tok' } }), false, 'a refused start never continues');
  assert.equal(pairingStartCanContinue({}), false);
});

test('a failed pairing start no longer throws into the connection error path', () => {
  const source = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /throw new Error\(pairingFailureMessage\(pairingStart\.status/);
  assert.match(source, /pairingStartCanContinue\(\{ ok: pairingStart\?\.ok === true, payload: pairingPayload \}\)/);
  assert.match(source, /reason: 'manual-setup-required'/);
});
