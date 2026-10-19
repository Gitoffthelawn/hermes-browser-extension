import assert from 'node:assert/strict';
import test from 'node:test';

import {
  dashboardFileStreamUrl,
  fetchDashboardFileStreamObjectUrl,
  releaseDashboardStreamBlob,
} from '../extension/lib/model-discovery.mjs';

const BASE = 'https://dashboard.example.test';
const SECRET = 'session-secret-value';

function videoResponse(body = new Uint8Array([0, 1, 2, 3]), status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'video/mp4' } });
}

test('the stream URL names the file and never carries a token', () => {
  const url = new URL(dashboardFileStreamUrl(`${BASE}/?session=1#top`, 'clips/demo.mp4'));
  assert.equal(url.origin, BASE);
  assert.equal(url.pathname, '/api/files/stream');
  assert.equal(url.searchParams.get('path'), 'clips/demo.mp4');
  assert.equal([...url.searchParams.keys()].join(','), 'path');
  assert.equal(url.hash, '');
});

test('managed video is read with the session header and played from a blob URL', async () => {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url: String(url), headers: options.headers, credentials: options.credentials });
    return videoResponse();
  };
  const objectUrl = await fetchDashboardFileStreamObjectUrl({
    baseUrl: BASE,
    filePath: 'videos/demo.mp4',
    token: SECRET,
    fetchFn,
  });
  try {
    assert.match(objectUrl, /^blob:/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers['X-Hermes-Session-Token'], SECRET);
    assert.equal(calls[0].headers.Authorization, undefined);
    assert.equal(calls[0].credentials, 'include');
    assert.equal(calls[0].url.includes(SECRET), false, 'the token never appears in the request URL');
    assert.equal(new URL(calls[0].url).searchParams.has('token'), false);
    assert.equal(objectUrl.includes(SECRET), false, 'nor in the URL the element plays');
  } finally {
    releaseDashboardStreamBlob(objectUrl);
  }
});

test('a file the dashboard refuses, or an empty one, yields no playable URL', async () => {
  const refused = await fetchDashboardFileStreamObjectUrl({
    baseUrl: BASE,
    filePath: 'videos/missing.mp4',
    token: SECRET,
    fetchFn: async () => videoResponse(new Uint8Array(), 404),
  });
  assert.equal(refused, '');

  const empty = await fetchDashboardFileStreamObjectUrl({
    baseUrl: BASE,
    filePath: 'videos/empty.mp4',
    token: SECRET,
    fetchFn: async () => videoResponse(new Uint8Array()),
  });
  assert.equal(empty, '');

  const offline = await fetchDashboardFileStreamObjectUrl({
    baseUrl: BASE,
    filePath: 'videos/demo.mp4',
    token: SECRET,
    fetchFn: async () => { throw new TypeError('network down'); },
  });
  assert.equal(offline, '');
});

test('releasing a blob revokes it once and the call is safe to repeat', async () => {
  const revoked = [];
  const originalRevoke = URL.revokeObjectURL;
  URL.revokeObjectURL = (url) => { revoked.push(url); };
  try {
    const objectUrl = await fetchDashboardFileStreamObjectUrl({
      baseUrl: BASE,
      filePath: 'videos/demo.mp4',
      token: SECRET,
      fetchFn: async () => videoResponse(),
    });
    releaseDashboardStreamBlob(objectUrl);
    releaseDashboardStreamBlob(objectUrl);
    releaseDashboardStreamBlob('');
    assert.deepEqual(revoked, [objectUrl]);
  } finally {
    URL.revokeObjectURL = originalRevoke;
  }
});
