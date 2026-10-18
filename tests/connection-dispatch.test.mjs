import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CONNECTION_ACTIONS,
  connectionActionForSettings,
  unsavedGatewayUrlForConnect,
} from '../extension/lib/connection-dispatch.mjs';
import { CONNECTION_TRANSPORTS } from '../extension/lib/connection-modes.mjs';

test('Cloud always dispatches to active-tab ticket attach, never Local API', () => {
  assert.equal(connectionActionForSettings({
    connectionSchemaVersion: 1,
    connectionMode: 'cloud',
    connectionTransport: CONNECTION_TRANSPORTS.CLOUD_TICKET_WS,
    gatewayUrl: 'http://127.0.0.1:8642',
    apiKey: 'legacy-key-that-must-be-ignored',
  }), CONNECTION_ACTIONS.CLOUD_ACTIVE_TAB_ATTACH);
});

test('Local and both Remote transports remain explicit', () => {
  assert.equal(connectionActionForSettings({ connectionMode: 'local' }), CONNECTION_ACTIONS.LOCAL_API_PAIR_OR_CONNECT);
  assert.equal(connectionActionForSettings({
    connectionSchemaVersion: 1,
    connectionMode: 'remote',
    connectionTransport: CONNECTION_TRANSPORTS.REMOTE_API,
  }), CONNECTION_ACTIONS.REMOTE_API_CONNECT);
  assert.equal(connectionActionForSettings({
    connectionSchemaVersion: 1,
    connectionMode: 'remote',
    connectionTransport: CONNECTION_TRANSPORTS.REMOTE_DASHBOARD,
  }), CONNECTION_ACTIONS.REMOTE_DASHBOARD_ATTACH);
});

test('Connect uses a gateway URL typed into the settings form but not yet saved', () => {
  assert.equal(unsavedGatewayUrlForConnect({
    savedUrl: 'http://127.0.0.1:8642',
    typedUrl: 'http://192.168.1.50:8642/',
    savedConnectionMode: 'local',
    formConnectionMode: 'local',
    savedGatewayMode: 'local-api',
    formGatewayMode: 'local-api',
  }), 'http://192.168.1.50:8642');
});

test('Connect keeps the saved URL when the form still shows it', () => {
  assert.equal(unsavedGatewayUrlForConnect({
    savedUrl: 'http://127.0.0.1:8642',
    typedUrl: 'http://127.0.0.1:8642/v1',
    savedConnectionMode: 'local',
    formConnectionMode: 'local',
  }), null);
  assert.equal(unsavedGatewayUrlForConnect({
    savedUrl: 'http://127.0.0.1:8642',
    typedUrl: '   ',
    savedConnectionMode: 'local',
    formConnectionMode: 'local',
  }), null, 'an empty field never overrides the saved URL');
});

test('an unsaved connection or gateway mode change stays pending until Save', () => {
  assert.equal(unsavedGatewayUrlForConnect({
    savedUrl: 'http://127.0.0.1:8642',
    typedUrl: 'https://hermes.example.com',
    savedConnectionMode: 'local',
    formConnectionMode: 'remote',
    savedGatewayMode: 'local-api',
    formGatewayMode: 'local-api',
  }), null);
  assert.equal(unsavedGatewayUrlForConnect({
    savedUrl: 'http://127.0.0.1:8642',
    typedUrl: 'https://hermes.example.com',
    savedConnectionMode: 'remote',
    formConnectionMode: 'remote',
    savedGatewayMode: 'remote-api',
    formGatewayMode: 'remote-dashboard',
  }), null);
});

test('Cloud attach never adopts a form URL: it attaches to the active tab', () => {
  assert.equal(unsavedGatewayUrlForConnect({
    savedUrl: 'https://agent.example.com',
    typedUrl: 'https://other.example.com',
    savedConnectionMode: 'cloud',
    formConnectionMode: 'cloud',
  }), null);
});

test('the side panel adopts the typed gateway URL before it dispatches a connection', () => {
  const source = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const connect = source.match(/async function connectToHermes\(\) \{[\s\S]*?\n\}\n/)?.[0] || '';
  assert.match(connect, /adoptUnsavedGatewayUrlForConnect\(\);/);
  assert.ok(
    connect.indexOf('adoptUnsavedGatewayUrlForConnect();') < connect.indexOf('connectionActionForSettings(settings)'),
    'the URL must be adopted before the connection action is chosen',
  );
  const adopt = source.match(/function adoptUnsavedGatewayUrlForConnect\(\) \{[\s\S]*?\n\}\n/)?.[0] || '';
  assert.match(adopt, /unsavedGatewayUrlForConnect\(\{/);
  assert.match(adopt, /isTrustedDashboardOrigin\(nextUrl/);
  assert.match(adopt, /connectionController\.cancel\('connection settings changed'\)/);
});
