import assert from 'node:assert/strict';
import test from 'node:test';

import { createWakeBackgroundController } from '../extension/lib/wake-background.mjs';

const LOCAL_ONLY_DETAIL = 'Native wake needs the local Hermes gateway on this computer. Remote connections can use browser wake instead.';

function chromeWith(settings) {
  const values = { hermesBrowserSettings: settings };
  return {
    values,
    api: {
      runtime: {
        getManifest: () => ({ version: '0.2.0' }),
        getURL: (path) => `chrome-extension://test/${path}`,
        getContexts: async () => [],
        sendMessage: async () => ({ ok: true }),
      },
      storage: {
        local: {
          get: async (key) => (typeof key === 'string' ? { [key]: values[key] } : { ...values }),
          set: async (patch) => Object.assign(values, patch),
          remove: async (key) => { delete values[key]; },
        },
      },
      offscreen: {
        createDocument: async () => {},
        closeDocument: async () => {},
      },
      tabs: {
        query: async () => [{ id: 1, url: 'http://127.0.0.1:9119/', status: 'complete', active: true }],
      },
      scripting: {
        executeScript: async () => [],
      },
    },
  };
}

async function settle(controller, state) {
  for (let attempt = 0; attempt < 40 && controller.state().state !== state; attempt += 1) {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 2));
  }
  return controller.state();
}

test('native wake never reaches for the loopback dashboard from a remote API connection', async () => {
  const requests = [];
  const chrome = chromeWith({
    connectionMode: 'remote',
    connectionTransport: 'remote-api',
    gatewayUrl: 'https://agent.example.test',
    apiKey: 'remote-key',
  });
  const controller = createWakeBackgroundController({
    chromeApi: chrome.api,
    fetchFn: async (url) => {
      requests.push(String(url));
      return { ok: true, text: async () => '' };
    },
    gatewayClientFactory: () => {
      requests.push('websocket-client');
      throw new Error('no dashboard socket may be opened from a remote API connection');
    },
    openPanel: async () => {},
  });
  await controller.configure({
    wakeWordEnabled: true,
    wakeWordPreferNative: true,
    wakeWordBrowserFallback: false,
    wakeWordPhrase: 'hey hermes',
  });
  const state = await settle(controller, 'unavailable');
  assert.equal(state.state, 'unavailable');
  assert.equal(state.detail, LOCAL_ONLY_DETAIL);
  assert.deepEqual(requests, [], 'a remote API connection makes no loopback request for wake');
});

test('native wake from a local gateway still asks the local dashboard for its credential', async () => {
  const requests = [];
  const chrome = chromeWith({ connectionMode: 'local', connectionTransport: 'local-api', gatewayMode: 'local-api' });
  const controller = createWakeBackgroundController({
    chromeApi: chrome.api,
    fetchFn: async (url) => {
      requests.push(String(url));
      return { ok: true, text: async () => '<script>window.__HERMES_SESSION_TOKEN__ = "local-token";</script>' };
    },
    gatewayClientFactory: () => ({
      on: () => () => {},
      connect: async () => { throw new Error('offline for this test'); },
      request: async () => ({}),
      close: () => {},
    }),
    openPanel: async () => {},
  });
  await controller.configure({
    wakeWordEnabled: true,
    wakeWordPreferNative: true,
    wakeWordBrowserFallback: false,
    wakeWordPhrase: 'hey hermes',
  });
  await settle(controller, 'unavailable');
  assert.ok(requests.some((url) => url.startsWith('http://127.0.0.1:9119')), 'the local engine is still reachable');
  assert.notEqual(controller.state().detail, LOCAL_ONLY_DETAIL);
});
