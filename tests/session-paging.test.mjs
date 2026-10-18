// Dashboard session-list paging (issues #9 and PRs #2 and #10). A short page
// with has_more set is not the end of the list, so the loader must ask again.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  DASHBOARD_SESSION_MAX_PAGES,
  DASHBOARD_SESSION_PAGE_LIMIT,
  collectSessionPages,
} from '../extension/lib/session-paging.mjs';

function rowsFrom(start, count) {
  return Array.from({ length: count }, (_value, index) => ({ id: `session-${start + index}` }));
}

// Serves a fixed list of sessions the way the dashboard does: offset and limit
// select a window, and has_more/total describe what is left.
function pagedServer(total, { pageCap = Infinity } = {}) {
  const requests = [];
  const fetchPage = async ({ offset, limit }) => {
    requests.push({ offset, limit });
    const size = Math.min(limit, pageCap, Math.max(0, total - offset));
    return {
      rows: rowsFrom(offset, size),
      hasMore: offset + size < total,
      total,
    };
  };
  return { fetchPage, requests };
}

test('a short page with has_more set is not the end: the loader asks for the next page', async () => {
  const requests = [];
  const pages = [
    { rows: rowsFrom(0, 40), hasMore: true, total: 90 },
    { rows: rowsFrom(40, 50), hasMore: false, total: 90 },
  ];
  const merged = await collectSessionPages({
    fetchPage: async (request) => {
      requests.push(request);
      return pages[request.page];
    },
  });
  assert.equal(requests.length, 2, 'the server said more sessions existed after a short page');
  assert.equal(requests[1].offset, 40);
  assert.equal(merged.length, 90);
});

test('a page of exactly the limit keeps paging while the server reports more', async () => {
  const server = pagedServer(250);
  const merged = await collectSessionPages({ fetchPage: server.fetchPage, limit: 100, maxPages: 10 });
  assert.deepEqual(server.requests.map((request) => request.offset), [0, 100, 200]);
  assert.equal(merged.length, 250);
});

test('paging follows total when has_more is absent and stops once every session is read', async () => {
  const pages = [
    { rows: rowsFrom(0, 100), total: 130 },
    { rows: rowsFrom(100, 30), total: 130 },
  ];
  const merged = await collectSessionPages({
    fetchPage: async ({ page }) => pages[page],
    limit: 100,
    maxPages: 5,
  });
  assert.equal(merged.length, 130);
});

test('paging stops at the page cap even when the server keeps reporting more', async () => {
  const server = pagedServer(10_000);
  const merged = await collectSessionPages({ fetchPage: server.fetchPage, limit: 100, maxPages: 5 });
  assert.equal(server.requests.length, 5);
  assert.equal(merged.length, 500);
});

test('the dashboard loader keeps a bounded page cap and the 100-row page size', () => {
  assert.equal(DASHBOARD_SESSION_PAGE_LIMIT, 100);
  assert.equal(DASHBOARD_SESSION_MAX_PAGES, 5);
});

test('an empty page ends paging without a request loop', async () => {
  const server = pagedServer(0);
  const merged = await collectSessionPages({ fetchPage: server.fetchPage });
  assert.deepEqual(merged, []);
  assert.equal(server.requests.length, 1);
});

test('a page that only repeats sessions already gathered ends paging', async () => {
  let calls = 0;
  const merged = await collectSessionPages({
    fetchPage: async () => {
      calls += 1;
      return { rows: rowsFrom(0, 3), hasMore: true, total: 999 };
    },
    maxPages: 5,
  });
  assert.equal(calls, 2, 'the second page added nothing new, so the loader stops instead of re-reading it');
  assert.equal(merged.length, 3);
});

test('a null page (a failed follow-on read) keeps the sessions already gathered', async () => {
  const merged = await collectSessionPages({
    fetchPage: async ({ page }) => (page === 0 ? { rows: rowsFrom(0, 100), hasMore: true, total: 500 } : null),
  });
  assert.equal(merged.length, 100);
});

test('rows are merged in server order and de-duplicated by id', async () => {
  const pages = [
    { rows: [{ id: 'a' }, { id: 'b' }], hasMore: true },
    { rows: [{ id: 'b' }, { session_id: 'c' }], hasMore: false },
  ];
  const merged = await collectSessionPages({ fetchPage: async ({ page }) => pages[page] });
  assert.deepEqual(merged.map((row) => row.id ?? row.session_id), ['a', 'b', 'c']);
});

test('the side panel dashboard loader pages through collectSessionPages without the short-page stop', () => {
  const source = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const loader = source.match(/async function loadDashboardSessionsForProfile\(profile = ''\) \{[\s\S]*?\n\}\n/)?.[0] || '';
  assert.match(loader, /collectSessionPages\(\{/);
  assert.doesNotMatch(loader, /rows\.length < limit/, 'a short page must not end paging while has_more is set');
  assert.doesNotMatch(loader, /shouldStopSessionPaging/);
});
