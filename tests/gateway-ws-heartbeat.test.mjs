import assert from 'node:assert/strict';
import test from 'node:test';

import { createGatewayClient, WS_METHODS } from '../extension/lib/gateway-ws.mjs';

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this._listeners = {};
    FakeWebSocket.last = this;
  }

  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }

  send(data) { this.sent.push(data); }

  close() {
    this.readyState = 3;
    this._emit('close', { code: 1000 });
  }

  _emit(type, event) { for (const fn of this._listeners[type] || []) fn(event); }

  _open() {
    this.readyState = 1;
    this._emit('open', {});
  }

  _message(obj) { this._emit('message', { data: JSON.stringify(obj) }); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pings = (socket) => socket.sent.map((raw) => JSON.parse(raw)).filter((frame) => frame.method === WS_METHODS.gatewayPing);

async function connectWith(readyPayload, options = {}) {
  const client = createGatewayClient({
    WebSocketImpl: FakeWebSocket,
    requestTimeoutMs: 200,
    heartbeatIntervalMs: 15,
    heartbeatDeadlineMs: 40,
    ...options,
  });
  const connecting = client.connect('wss://host/api/ws?ticket=t');
  const socket = FakeWebSocket.last;
  socket._open();
  socket._message({ method: 'event', params: { type: 'gateway.ready', payload: readyPayload } });
  await connecting;
  return { client, socket };
}

test('an advertised gateway is pinged on a timer and a live socket stays open', async () => {
  const { client, socket } = await connectWith({ heartbeat: true });
  // The gateway answers gateway.ping on its read loop, as upstream does.
  socket.send = (data) => {
    socket.sent.push(data);
    const frame = JSON.parse(data);
    if (frame.method === WS_METHODS.gatewayPing) socket._message({ jsonrpc: '2.0', result: { ok: true }, id: frame.id });
  };
  await sleep(80);
  assert.ok(pings(socket).length >= 2, 'the client keeps probing an advertised gateway');
  assert.equal(socket.readyState, 1, 'an answered probe keeps the socket open');
  client.close();
});

test('a gateway that does not advertise heartbeat is never pinged', async () => {
  const { client, socket } = await connectWith({});
  await sleep(60);
  assert.equal(pings(socket).length, 0);
  assert.equal(socket.readyState, 1);
  client.close();
});

test('a silent gateway is dropped after the deadline and the caller hears the close', async () => {
  const { client, socket } = await connectWith({ heartbeat: true });
  let closes = 0;
  client.on('close', () => { closes += 1; });
  await sleep(150);
  assert.equal(socket.readyState, 3, 'the unanswered socket is closed');
  assert.equal(closes, 1, 'the caller receives the close event once');
  const sentAfterClose = pings(socket).length;
  await sleep(60);
  assert.equal(pings(socket).length, sentAfterClose, 'no further probes go out on a closed socket');
  client.close();
});
