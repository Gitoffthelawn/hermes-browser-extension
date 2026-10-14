import assert from 'node:assert/strict';
import { test } from 'node:test';

import { friendlyModelName, friendlyModelParts } from '../extension/lib/model-friendly-name.mjs';

test('the provider prefix and dashes never reach the friendly name', () => {
  assert.equal(
    friendlyModelName('claude-subscription-directsdk-experimental/claude-sonnet-5-5[1m]'),
    'Sonnet 5.5 1M',
  );
  assert.equal(friendlyModelName('claude-haiku-5-5[1m]'), 'Haiku 5.5 1M');
  assert.equal(friendlyModelName('claude-opus-5-5[1m]'), 'Opus 5.5 1M');
});

test('a date pin is dropped and the version keeps its dots', () => {
  assert.equal(friendlyModelName('claude-sonnet-4-5-20250929'), 'Sonnet 4.5');
});

test('the context window is a quiet tag, separate from the name', () => {
  assert.deepEqual(friendlyModelParts('claude-sonnet-5-5[1m]'), { name: 'Sonnet 5.5', tag: '1M' });
});

test('gemini, gpt, o-series and vendor casing read as people write them', () => {
  assert.equal(friendlyModelName('gemini-3.8-flash-high'), 'Gemini 3.8 Flash High');
  assert.equal(friendlyModelName('gpt-6.1-sol'), 'GPT 6.1 Sol');
  assert.equal(friendlyModelName('o4-mini'), 'o4 Mini');
  assert.equal(friendlyModelName('z-ai/glm-5.3-flash'), 'GLM 5.3 Flash');
});

test('an empty id reads as "No model" instead of an empty chip', () => {
  assert.equal(friendlyModelName(''), 'No model');
});
