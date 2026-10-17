import assert from 'node:assert/strict';
import test from 'node:test';

import { createHermesClient } from '../extension/lib/hermes-client.mjs';

test('session inventory waits for a cold database beyond the old three-second deadline', async () => {
  const startedAt = Date.now();
  const client = createHermesClient({
    getConnection: () => ({ gatewayUrl: 'http://127.0.0.1:8642' }),
    fetchImpl: async (_url, { signal }) => {
      assert.ok(signal, 'session enumeration must have a bounded request deadline');
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 3_100);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      });
      return jsonResponse({ data: [{ id: 'existing-session' }], has_more: false });
    },
  });
  assert.deepEqual(await client.listSessions(), [{ id: 'existing-session' }]);
  assert.ok(Date.now() - startedAt >= 3_000);
});

test('session inventory still aborts an unresponsive gateway at its configured deadline', async () => {
  const client = createHermesClient({
    getConnection: () => ({ gatewayUrl: 'http://127.0.0.1:8642' }),
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  // AbortSignal.timeout does not keep Node alive by itself.
  const keepAlive = setInterval(() => {}, 100);
  try {
    await assert.rejects(client.listSessions({ requestTimeoutMs: 25 }), { name: 'TimeoutError' });
  } finally {
    clearInterval(keepAlive);
  }
});

test('session inventory follows the server page limit without skipping rows or repeating pins', async () => {
  const offsets = [];
  const pages = [
    { data: [{ id: 'a' }, { id: 'b' }, { id: 'pin', pinned: true }], limit: 2, offset: 0, has_more: true },
    { data: [{ id: 'c' }, { id: 'd' }, { id: 'pin', pinned: true }], limit: 2, offset: 2, has_more: true },
    { data: [{ id: 'e' }, { id: 'pin', pinned: true }], limit: 2, offset: 4, has_more: false },
  ];
  const client = createHermesClient({
    getConnection: () => ({ gatewayUrl: 'http://127.0.0.1:8642' }),
    fetchImpl: async (url) => {
      offsets.push(Number(new URL(url).searchParams.get('offset')));
      return jsonResponse(pages.shift());
    },
  });
  const rows = await client.listSessions({ limit: 500 });
  assert.deepEqual(offsets, [0, 2, 4]);
  assert.deepEqual(rows.map((row) => row.id), ['a', 'b', 'pin', 'c', 'd', 'e']);
});

function jsonResponse(payload, { status = 200 } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('Hermes client resolves dynamic connection settings and safe request headers', async () => {
  const calls = [];
  let connection = { gatewayUrl: 'http://127.0.0.1:8642/', apiKey: 'secret-value', activeProfile: 'work' };
  const client = createHermesClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ ok: true });
    },
    getConnection: () => connection,
  });

  await client.fetch('/health', { method: 'GET' });
  connection = { gatewayUrl: 'https://agent.example/', apiKey: '', activeProfile: '' };
  await client.fetch('/v1/models', { method: 'GET' });

  // Bot Mode API transport: per-profile paths are multiplexed as /p/<profile>/...
  assert.equal(calls[0].url, 'http://127.0.0.1:8642/p/work/health');
  assert.equal(calls[0].url.includes('/p/work/v1/'), false, 'profile prefix applies once, ahead of the requested path');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret-value');
  assert.equal(calls[0].options.headers['X-Hermes-Profile'], 'work');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[1].url, 'https://agent.example/v1/models');
  assert.equal('Authorization' in calls[1].options.headers, false);
});

test('Hermes client paginates sessions and normalizes response containers', async () => {
  const urls = [];
  const pages = [
    { data: [{ id: 'a' }, { id: 'b' }], has_more: true, total: 3 },
    { sessions: [{ id: 'c' }], hasMore: false, total: 3 },
  ];
  const client = createHermesClient({
    fetchImpl: async (url) => {
      urls.push(url);
      return jsonResponse(pages.shift());
    },
    getConnection: () => ({ gatewayUrl: 'http://localhost:8642', apiKey: 'x' }),
  });

  const sessions = await client.listSessions({ limit: 2, maxPages: 4 });
  assert.deepEqual(sessions.map((session) => session.id), ['a', 'b', 'c']);
  assert.match(urls[0], /limit=2&offset=0/);
  assert.match(urls[1], /limit=2&offset=2/);
});

test('Hermes client loads canonical session messages without leaking response shapes', async () => {
  const client = createHermesClient({
    fetchImpl: async () => jsonResponse({ data: [{ role: 'user', content: 'hello' }] }),
    getConnection: () => ({ gatewayUrl: 'http://localhost:8642', apiKey: 'x' }),
  });
  assert.deepEqual(await client.getSessionMessages('session/one'), [{ role: 'user', content: 'hello' }]);
});

test('Hermes client reports bounded HTTP failures', async () => {
  const client = createHermesClient({
    fetchImpl: async () => new Response(`private-body-${'x'.repeat(1200)}`, { status: 500 }),
    getConnection: () => ({ gatewayUrl: 'http://localhost:8642', apiKey: 'x' }),
  });
  await assert.rejects(() => client.listSessions(), (error) => {
    assert.equal(error.status, 500);
    assert.ok(error.message.length < 700);
    return true;
  });
});
