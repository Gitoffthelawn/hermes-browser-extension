import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_REQUEST_TIMEOUT_MS, createHermesClient } from '../extension/lib/hermes-client.mjs';

const connection = () => ({ gatewayUrl: 'http://127.0.0.1:8642' });

test('the client default is a finite deadline, well above a normal answer', () => {
  assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 60_000);
});

test('an ordinary request that never answers is abandoned at the client deadline', async () => {
  const client = createHermesClient({
    getConnection: connection,
    defaultRequestTimeoutMs: 25,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  // AbortSignal.timeout does not keep Node alive by itself.
  const keepAlive = setInterval(() => {}, 100);
  try {
    await assert.rejects(client.fetch('/api/sessions/abc/messages', { method: 'GET' }), { name: 'TimeoutError' });
  } finally {
    clearInterval(keepAlive);
  }
});

test('streams, uploads and agent turns carry no default deadline', async () => {
  const signals = [];
  const client = createHermesClient({
    getConnection: connection,
    defaultRequestTimeoutMs: 25,
    fetchImpl: async (_url, options) => {
      signals.push(options.signal);
      return new Response('{}', { status: 200 });
    },
  });
  await client.fetch('/api/sessions/s1/chat/stream', { method: 'POST', body: '{}' });
  await client.fetch('/api/sessions/s1/chat', { method: 'POST', body: '{}' });
  await client.fetch('/v1/chat/completions', { method: 'POST', body: '{}' });
  await client.fetch('/v1/artifacts/upload', { method: 'POST', body: new Blob(['bytes']) });
  await client.fetch('/api/audio/transcribe', { method: 'POST', body: '{}' });
  await client.fetch('/api/sessions/s1/compress', { method: 'POST', body: '{}' });
  await client.fetch('/api/events', { method: 'GET', headers: { Accept: 'text/event-stream' } });
  assert.equal(signals.length, 7);
  assert.ok(signals.every((signal) => signal === undefined), 'none of these may be cut off by the default');
});

test('a caller signal or an explicit timeoutMs decides the deadline, and redirects stay refused', async () => {
  const seen = [];
  const client = createHermesClient({
    getConnection: connection,
    defaultRequestTimeoutMs: 25,
    fetchImpl: async (_url, options) => {
      seen.push(options);
      return new Response('{}', { status: 200 });
    },
  });
  const controller = new AbortController();
  await client.fetch('/v1/runs/r1', { method: 'GET', signal: controller.signal });
  assert.equal(seen[0].signal, controller.signal, 'the caller keeps control of its own cancellation');

  await client.fetch('/v1/runs/r1', { method: 'GET', timeoutMs: 0 });
  assert.equal(seen[1].signal, undefined, 'timeoutMs: 0 switches the default off');
  assert.equal('timeoutMs' in seen[1], false, 'timeoutMs is a client option and is not forwarded to fetch');

  await client.fetch('/health', { method: 'GET', timeoutMs: 5_000 });
  assert.ok(seen[2].signal instanceof AbortSignal, 'an explicit deadline is applied');

  await client.fetch('/health', { method: 'GET' });
  assert.equal(seen[3].redirect, 'error');
});
