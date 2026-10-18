// Session route answers from the Hermes API server (issue #89). A bare 403 with
// no JSON body is the CORS gate refusing the extension origin. It must name the
// exact origin and .env line, and it must stay session-scoped: the connection
// and the composer draft are left alone.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  isBareForbiddenResponse,
  materializeSessionRoute,
  sessionRouteError,
  sessionRouteOriginRefusal,
} from '../extension/lib/session-materialization.mjs';

const SESSION_PATH = '/api/sessions/hermes-browser-extension-1';
const FIREFOX_ORIGIN = 'moz-extension://19b91a4d-7c3e-4f2a-9d1b-5e6f7a8b9c0d';

// A scripted gateway: each request gets the next answer for its method and path.
function scriptedFetch(answers) {
  const calls = [];
  const fetchImpl = async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET', body: options.body });
    const answer = answers.shift();
    assert.ok(answer, `unexpected request ${options.method || 'GET'} ${path}`);
    return new Response(answer.body ?? '', { status: answer.status });
  };
  return { apiFetch: fetchImpl, calls };
}

test('an empty or non-JSON 403 is the origin refusal; a JSON 403 is an authorization answer', () => {
  assert.equal(isBareForbiddenResponse({ status: 403, body: '' }), true);
  assert.equal(isBareForbiddenResponse({ status: 403, body: '   ' }), true);
  assert.equal(isBareForbiddenResponse({ status: 403, body: 'Forbidden' }), true);
  assert.equal(isBareForbiddenResponse({ status: 403, body: '{"error":{"message":"Forbidden"}}' }), false);
  assert.equal(isBareForbiddenResponse({ status: 401, body: '' }), false);
  assert.equal(isBareForbiddenResponse({ status: 404, body: '' }), false);
});

test('the refusal names the Firefox extension origin and the exact .env line', () => {
  const refusal = sessionRouteOriginRefusal({
    action: 'Create Hermes Browser Extension session',
    status: 403,
    body: '',
    extensionOrigin: `${FIREFOX_ORIGIN}/`,
  });
  assert.equal(refusal.origin, FIREFOX_ORIGIN);
  assert.equal(refusal.envLine, `API_SERVER_CORS_ORIGINS=${FIREFOX_ORIGIN}`);
  assert.equal(refusal.action, 'Create Hermes Browser Extension session');
});

test('the refusal names the Chromium extension origin the same way', () => {
  const refusal = sessionRouteOriginRefusal({
    action: 'Inspect Hermes Browser Extension session',
    status: 403,
    body: '',
    extensionOrigin: 'chrome-extension://abcdefghijklmnop/',
  });
  assert.equal(refusal.envLine, 'API_SERVER_CORS_ORIGINS=chrome-extension://abcdefghijklmnop');
});

test('a refusal without a known extension origin still gives a usable placeholder', () => {
  const refusal = sessionRouteOriginRefusal({ action: 'x', status: 403, body: '', extensionOrigin: '' });
  assert.equal(refusal.origin, 'chrome-extension://<extension-id>');
});

test('a JSON 403 never becomes an origin refusal', () => {
  assert.equal(sessionRouteOriginRefusal({
    action: 'Create Hermes Browser Extension session',
    status: 403,
    body: '{"error":{"message":"Forbidden"}}',
    extensionOrigin: FIREFOX_ORIGIN,
  }), null);
});

test('GET 404 then POST 403 with an empty body: the create step is refused for this origin and nothing else is sent', async () => {
  const { apiFetch, calls } = scriptedFetch([{ status: 404 }, { status: 403 }]);
  const failures = [];
  await assert.rejects(materializeSessionRoute({
    apiFetch,
    sessionPath: SESSION_PATH,
    extensionOrigin: FIREFOX_ORIGIN,
    createBody: () => ({ id: 'hermes-browser-extension-1' }),
    failure: (details) => {
      failures.push(details);
      return sessionRouteError(details);
    },
  }), (error) => {
    assert.equal(error.originRefused, true);
    assert.equal(error.hermesSetupFailure, true, 'the stream must not fall back to a non-streaming retry');
    assert.equal(error.remoteDiagnostic, null, 'an origin refusal is never reported as a remote authorization problem');
    assert.equal(error.httpStatus, 403);
    assert.equal(error.originRefusal.envLine, `API_SERVER_CORS_ORIGINS=${FIREFOX_ORIGIN}`);
    return true;
  });
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
    `GET ${SESSION_PATH}`,
    'POST /api/sessions',
  ]);
  assert.equal(failures[0].action, 'Create Hermes Browser Extension session');
  assert.equal(failures[0].originRefusal.origin, FIREFOX_ORIGIN);
});

test('GET 403 with an empty body (the gate also covers GET) is refused on the inspect step', async () => {
  const { apiFetch, calls } = scriptedFetch([{ status: 403 }]);
  await assert.rejects(materializeSessionRoute({
    apiFetch,
    sessionPath: SESSION_PATH,
    extensionOrigin: FIREFOX_ORIGIN,
    createBody: () => ({}),
  }), (error) => {
    assert.equal(error.originRefused, true);
    assert.equal(error.sessionRouteAction, 'Inspect Hermes Browser Extension session');
    return true;
  });
  assert.equal(calls.length, 1, 'no create request follows a refused lookup');
});

test('a JSON 403 on create is an ordinary route failure, not an origin refusal', async () => {
  const { apiFetch } = scriptedFetch([{ status: 404 }, { status: 403, body: '{"error":{"message":"Forbidden"}}' }]);
  await assert.rejects(materializeSessionRoute({
    apiFetch,
    sessionPath: SESSION_PATH,
    extensionOrigin: FIREFOX_ORIGIN,
    createBody: () => ({}),
  }), (error) => {
    assert.equal(error.originRefused, false);
    assert.equal(error.originRefusal, null);
    assert.equal(error.hermesSetupFailure, true);
    return true;
  });
});

test('a gateway without session routes reports unavailable instead of throwing', async () => {
  const { apiFetch } = scriptedFetch([{ status: 404 }, { status: 405 }]);
  const outcome = await materializeSessionRoute({
    apiFetch,
    sessionPath: SESSION_PATH,
    createBody: () => ({}),
  });
  assert.equal(outcome.outcome, 'unavailable');
});

test('an existing session is reported as present without a create request', async () => {
  const { apiFetch, calls } = scriptedFetch([{ status: 200, body: '{"id":"hermes-browser-extension-1"}' }]);
  const outcome = await materializeSessionRoute({
    apiFetch,
    sessionPath: SESSION_PATH,
    createBody: () => ({}),
  });
  assert.equal(outcome.outcome, 'present');
  assert.equal(calls.length, 1);
});

test('a create that answers 409 counts as created, and the title repair runs between lookup and create', async () => {
  const order = [];
  const { apiFetch } = scriptedFetch([{ status: 404 }, { status: 409 }]);
  const wrapped = async (path, options) => {
    order.push(`${options?.method || 'GET'} ${path}`);
    return apiFetch(path, options);
  };
  const outcome = await materializeSessionRoute({
    apiFetch: wrapped,
    sessionPath: SESSION_PATH,
    beforeCreate: async () => { order.push('beforeCreate'); },
    createBody: () => { order.push('createBody'); return { id: 'x' }; },
  });
  assert.equal(outcome.outcome, 'created');
  assert.deepEqual(order, [`GET ${SESSION_PATH}`, 'beforeCreate', 'createBody', 'POST /api/sessions']);
});

test('the side panel reports a refused create as a session-scoped note that keeps the draft and the connection', () => {
  const source = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const reporter = source.match(/function reportSessionOriginRefusal\(error\) \{[\s\S]*?\n\}\n/)?.[0] || '';
  assert.match(reporter, /session\.origin_refused_title/);
  assert.match(reporter, /addMessage\('system', detail, \{ persist: false \}\)/);
  assert.doesNotMatch(reporter, /markGatewayUnreachable|markGatewayDegraded|markConnectionProbe|applyRemoteDiagnostic|connectionController/);

  const prepareCatch = source.match(/async function askHermes\([\s\S]*?\n {2}\} catch \(error\) \{\n {4}activeRunControl = markRunTerminal\(activeRunControl, 'failed'\);\n {4}sending = false;[\s\S]*?\n {2}\}\n/)?.[0] || '';
  assert.match(prepareCatch, /if \(error\?\.originRefused\) \{[\s\S]*?reportSessionOriginRefusal\(error\);[\s\S]*?return false;/);
  assert.ok(
    prepareCatch.indexOf('error?.originRefused') < prepareCatch.indexOf("setStatus('error', 'Could not start Hermes session'"),
    'the origin refusal must be handled before the generic setup error',
  );
});

test('the turn-level handler restores the draft before it reports an origin refusal, and never demotes the connection there', () => {
  const source = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const branchStart = source.indexOf('      if (error?.originRefused) {');
  const branchEnd = source.indexOf('      if (error?.remoteDiagnostic && applyRemoteDiagnostic', branchStart);
  assert.ok(branchStart > 0 && branchEnd > branchStart, 'origin branch must sit before the remote diagnostic branch');
  const branch = source.slice(branchStart, branchEnd);
  assert.match(branch, /persistCurrentComposerDraft\(\{ immediate: true \}\)/);
  assert.match(branch, /reportSessionOriginRefusal\(error\);\s*return didSend;/);
  assert.doesNotMatch(branch, /markGatewayUnreachable|markGatewayDegraded|applyRemoteDiagnostic/);
});

test('the side panel sends session routes through materializeSessionRoute and labels origin refusals with the origin', () => {
  const source = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const create = source.match(/function createSessionRouteError\(\{[\s\S]*?\n\}\n/)?.[0] || '';
  assert.match(create, /if \(originRefusal\) \{[\s\S]*?session\.origin_refused[\s\S]*?originRefusal\.origin[\s\S]*?originRefusal\.envLine/);
  assert.match(source, /extensionOrigin: currentExtensionOrigin\(\)/);
});
