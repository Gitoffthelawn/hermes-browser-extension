import assert from 'node:assert/strict';
import test from 'node:test';

import { CONTROLLER_ADAPTER_IDS } from '../extension/lib/browser-controller-adapter.mjs';

async function adaptersModule() {
  try {
    return await import('../extension/lib/browser-control-browser-adapters.mjs');
  } catch (error) {
    assert.fail(`Phase 6 browser adapters module is required: ${error?.message || error}`);
  }
}

// Deterministic time for load waits and settle: sleeping advances the clock.
function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms) => { time += ms; },
  };
}

function chromiumApis({ failMethod = '' } = {}) {
  const calls = [];
  const detachListeners = [];
  const eventListeners = [];
  // Per-method overrides: handlers[method] = (params) => result (may throw).
  const handlers = {};
  const tabs = new Map([
    [7, { id: 7, windowId: 4, active: true, status: 'complete', title: 'Example', url: 'https://example.test/start' }],
    [8, { id: 8, windowId: 4, active: false, status: 'complete', title: 'Other', url: 'https://other.test/' }],
  ]);
  const api = {
    debugger: {
      attach: async (target, version) => { calls.push(['attach', target, version]); },
      detach: async (target) => { calls.push(['detach', target]); },
      onDetach: {
        addListener(listener) { detachListeners.push(listener); },
        removeListener(listener) {
          const index = detachListeners.indexOf(listener);
          if (index >= 0) detachListeners.splice(index, 1);
        },
      },
      onEvent: {
        addListener(listener) { eventListeners.push(listener); },
        removeListener(listener) {
          const index = eventListeners.indexOf(listener);
          if (index >= 0) eventListeners.splice(index, 1);
        },
      },
      sendCommand: async (target, method, params = {}) => {
        calls.push(['command', target, method, params]);
        if (method === failMethod) throw new Error(`forced ${method} failure`);
        if (handlers[method]) return handlers[method](params, target);
        if (method === 'Page.navigate') {
          tabs.set(target.tabId, { ...tabs.get(target.tabId), url: params.url, title: 'Next page' });
          return { frameId: 'main-frame', loaderId: 'loader-1' };
        }
        if (method === 'Page.navigateToHistoryEntry') {
          tabs.set(target.tabId, { ...tabs.get(target.tabId), url: 'https://example.test/old', title: 'Old page' });
          return {};
        }
        if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 1000, clientHeight: 800 } };
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              { nodeId: '1', backendDOMNodeId: 44, role: { value: 'button' }, name: { value: 'Search' }, ignored: false },
              { nodeId: '2', backendDOMNodeId: 45, role: { value: 'textbox' }, name: { value: 'Password' }, properties: [{ name: 'editable', value: { value: 'plaintext' } }], ignored: false },
              { nodeId: '3', role: { value: 'StaticText' }, name: { value: 'Public page text' }, ignored: false },
            ],
          };
        }
        if (method === 'DOM.getBoxModel') {
          return { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } };
        }
        if (method === 'Page.getNavigationHistory') {
          return { currentIndex: 1, entries: [{ id: 2, url: 'https://example.test/old' }, { id: 3, url: 'https://example.test/start' }] };
        }
        if (method === 'Page.captureScreenshot') return { data: 'ZmFrZS1wbmc=' };
        return {};
      },
    },
    tabs: {
      get: async (tabId) => ({ ...tabs.get(tabId) }),
      query: async () => [...tabs.values()].map((tab) => ({ ...tab })),
      update: async (tabId, changes) => {
        calls.push(['tabs.update', tabId, changes]);
        const next = { ...tabs.get(tabId), ...changes };
        tabs.set(tabId, next);
        return { ...next };
      },
      create: async (details) => {
        calls.push(['tabs.create', details]);
        const id = Math.max(...tabs.keys()) + 1;
        const next = { id, windowId: details.windowId || 4, active: details.active !== false, url: details.url };
        tabs.set(id, next);
        return { ...next };
      },
      remove: async (tabId) => {
        calls.push(['tabs.remove', tabId]);
        tabs.delete(Number(tabId));
      },
      group: async (details) => { calls.push(['tabs.group', details]); return 91; },
      ungroup: async (tabIds) => { calls.push(['tabs.ungroup', tabIds]); },
    },
    scripting: {
      executeScript: async (details) => {
        calls.push(['executeScript', details.target]);
        return [{ result: { hasUnsavedContent: false } }];
      },
    },
  };
  return {
    api,
    calls,
    tabs,
    handlers,
    emitDetach(tabId, reason) {
      for (const listener of [...detachListeners]) listener({ tabId }, reason);
    },
    emitEvent(tabId, method, params = {}) {
      for (const listener of [...eventListeners]) listener({ tabId }, method, params);
    },
    detachListeners,
    eventListeners,
  };
}

const commandMethods = (calls) => calls.filter((call) => call[0] === 'command').map((call) => call[2]);
const countCalls = (calls, name) => calls.filter((call) => call[0] === name).length;
const openSignal = () => new AbortController().signal;
const clickTarget = { backendDOMNodeId: 44 };

function firefoxApis() {
  const calls = [];
  const tabs = new Map([
    [7, { id: 7, windowId: 4, active: true, title: 'Example', url: 'https://example.test/start' }],
    [8, { id: 8, windowId: 4, active: false, title: 'Other', url: 'https://other.test/' }],
  ]);
  const api = {
    tabs: {
      get: async (tabId) => ({ ...tabs.get(tabId) }),
      query: async () => [...tabs.values()].map((tab) => ({ ...tab })),
      update: async (tabId, changes) => {
        calls.push(['tabs.update', tabId, changes]);
        const next = { ...tabs.get(tabId), ...changes };
        tabs.set(tabId, next);
        return { ...next };
      },
      goBack: async (tabId) => { calls.push(['tabs.goBack', tabId]); },
      captureVisibleTab: async (windowId, options) => {
        calls.push(['captureVisibleTab', windowId, options]);
        return 'data:image/png;base64,ZmFrZQ==';
      },
      create: async (details) => {
        calls.push(['tabs.create', details]);
        const id = Math.max(...tabs.keys()) + 1;
        const next = { id, windowId: details.windowId || 4, active: details.active !== false, url: details.url };
        tabs.set(id, next);
        return { ...next };
      },
      remove: async (tabId) => {
        calls.push(['tabs.remove', tabId]);
        tabs.delete(Number(tabId));
      },
    },
    scripting: {
      executeScript: async (details) => {
        calls.push(['executeScript', details.target]);
        if (Array.isArray(details.args) && details.args.includes('snapshot')) {
          return [{ result: {
            title: 'Example',
            url: 'https://example.test/start',
            text: 'Public page text',
            nodes: [{ role: 'button', name: 'Search', selector: '[data-hermes-ref="1"]' }],
          } }];
        }
        return [{ result: { ok: true, hasUnsavedContent: false } }];
      },
    },
  };
  return { api, calls };
}

const scope = Object.freeze({ tabId: 7, frameId: 0 });

test('Chromium Phase 6 adapter snapshots AX refs through one persistent session and detaches on release', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const { api, calls } = chromiumApis();
  const adapter = createChromiumCdpAdapter({ browserApi: api });
  assert.equal(adapter.contract.id, CONTROLLER_ADAPTER_IDS.CHROMIUM_CDP);
  const snapshot = await adapter.execute('browser_snapshot', {}, { scope, signal: new AbortController().signal });
  assert.equal(snapshot.title, 'Example');
  assert.equal(snapshot.url, 'https://example.test/start');
  assert.match(snapshot.text, /Public page text/);
  assert.deepEqual(snapshot.nodes.map((node) => [node.role, node.name, node.backendDOMNodeId]), [
    ['button', 'Search', 44],
    ['textbox', 'Password', 45],
  ]);
  assert.deepEqual(calls.map((call) => call[0] === 'command' ? `${call[0]}:${call[2]}` : call[0]), [
    'attach',
    'command:Accessibility.enable',
    'command:Accessibility.getFullAXTree',
  ]);
  assert.equal(await adapter.releaseTab(7), true);
  assert.equal(calls.at(-1)[0], 'detach');
  assert.equal(await adapter.releaseTab(7), false, 'releasing an unattached tab is a no-op');
});

test('Chromium Phase 6 adapter emits trusted click, type, press, scroll, navigation, back, and screenshot sequences on one attach', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const { api, calls } = chromiumApis();
  const adapter = createChromiumCdpAdapter({ browserApi: api, ...fakeClock() });
  const signal = new AbortController().signal;
  const target = { backendDOMNodeId: 44 };

  await adapter.execute('browser_click', { ref: '@e1' }, { scope, signal, target });
  await adapter.execute('browser_type', { ref: '@e1', text: 'hello' }, { scope, signal, target });
  await adapter.execute('browser_press', { key: 'Enter' }, { scope, signal });
  await adapter.execute('browser_scroll', { direction: 'down' }, { scope, signal });
  await adapter.execute('browser_navigate', { url: 'https://example.test/next' }, { scope, signal });
  await adapter.execute('browser_back', {}, { scope, signal });
  const screenshot = await adapter.execute('browser_screenshot', {}, { scope, signal });

  assert.deepEqual(commandMethods(calls), [
    'DOM.enable', 'DOM.scrollIntoViewIfNeeded', 'DOM.getBoxModel', 'DOM.getNodeForLocation',
    'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent',
    'DOM.focus', 'DOM.resolveNode', 'Input.insertText',
    'Input.dispatchKeyEvent', 'Input.dispatchKeyEvent',
    'Page.getLayoutMetrics', 'Input.dispatchMouseEvent', 'Runtime.evaluate',
    'Page.enable', 'Page.navigate',
    'Page.getNavigationHistory', 'Page.navigateToHistoryEntry',
    'Page.captureScreenshot',
  ]);
  const mouse = calls.find((call) => call[0] === 'command' && call[2] === 'Input.dispatchMouseEvent' && call[3].type === 'mousePressed');
  assert.deepEqual({ x: mouse[3].x, y: mouse[3].y, button: mouse[3].button }, { x: 20, y: 30, button: 'left' });
  const typed = calls.find((call) => call[0] === 'command' && call[2] === 'Input.insertText');
  assert.equal(typed[3].text, 'hello');
  assert.equal(screenshot.dataUrl, 'data:image/png;base64,ZmFrZS1wbmc=');
  assert.equal(countCalls(calls, 'attach'), 1, 'one attach serves every operation on the tab');
  assert.equal(countCalls(calls, 'detach'), 0);
  assert.deepEqual(calls.find((call) => call[0] === 'attach').slice(1), [{ tabId: 7 }, '1.3']);
});

test('Chromium adapter attaches once for many operations and concurrent first use, enabling each domain once', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const { api, calls } = chromiumApis();
  const adapter = createChromiumCdpAdapter({ browserApi: api });
  const context = { scope, signal: openSignal() };
  await Promise.all(Array.from({ length: 5 }, () => adapter.execute('browser_snapshot', {}, context)));
  for (let index = 0; index < 4; index += 1) await adapter.execute('browser_snapshot', {}, context);
  await adapter.execute('browser_click', { ref: '@e1' }, { ...context, target: clickTarget });
  await adapter.execute('browser_click', { ref: '@e1' }, { ...context, target: clickTarget });
  assert.equal(countCalls(calls, 'attach'), 1);
  assert.equal(countCalls(calls, 'detach'), 0);
  const methods = commandMethods(calls);
  assert.equal(methods.filter((method) => method === 'Accessibility.enable').length, 1);
  assert.equal(methods.filter((method) => method === 'DOM.enable').length, 1);
});

test('Chromium adapter targetBounds reuses the action session instead of attaching again', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const { api, calls } = chromiumApis();
  const adapter = createChromiumCdpAdapter({ browserApi: api });
  const rect = await adapter.targetBounds({ scope, signal: openSignal(), target: clickTarget });
  assert.deepEqual(rect, { x: 10, y: 20, width: 20, height: 20 });
  await adapter.execute('browser_click', { ref: '@e1' }, { scope, signal: openSignal(), target: clickTarget });
  assert.equal(countCalls(calls, 'attach'), 1);
  assert.equal(await adapter.targetBounds({ scope, signal: openSignal(), target: null }), null);
});

test('Chromium adapter detaches an idle session after the idle window and re-attaches on demand', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const { api, calls } = chromiumApis();
  const timers = [];
  const cleared = new Set();
  const adapter = createChromiumCdpAdapter({
    browserApi: api,
    idleMs: 60_000,
    setTimer: (callback, ms) => { const handle = { callback, ms }; timers.push(handle); return handle; },
    clearTimer: (handle) => { cleared.add(handle); },
  });
  const context = { scope, signal: openSignal() };
  await adapter.execute('browser_snapshot', {}, context);
  const idleTimers = () => timers.filter((handle) => !cleared.has(handle) && handle.ms === 60_000);
  assert.equal(idleTimers().length, 1);
  await adapter.execute('browser_snapshot', {}, context);
  assert.equal(idleTimers().length, 1, 'each command restarts the single idle timer');
  assert.equal(countCalls(calls, 'detach'), 0);

  idleTimers()[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(countCalls(calls, 'detach'), 1);
  await adapter.execute('browser_snapshot', {}, context);
  assert.equal(countCalls(calls, 'attach'), 2);
  assert.equal(commandMethods(calls).filter((method) => method === 'Accessibility.enable').length, 2, 'domains are re-enabled per session');
});

test('Chromium adapter does not idle-detach while a command is still running', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  const timers = [];
  const adapter = createChromiumCdpAdapter({
    browserApi: chromium.api,
    idleMs: 1_000,
    setTimer: (callback, ms) => { const handle = { callback, ms }; timers.push(handle); return handle; },
    clearTimer: () => {},
  });
  await adapter.execute('browser_snapshot', {}, { scope, signal: openSignal() });
  const firstIdleTimer = timers.at(-1);
  let finish;
  chromium.handlers['Accessibility.getFullAXTree'] = () => new Promise((resolve) => { finish = resolve; });
  const pending = adapter.execute('browser_snapshot', {}, { scope, signal: openSignal() });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const before = timers.length;
  firstIdleTimer.callback();
  assert.equal(countCalls(chromium.calls, 'detach'), 0, 'a busy session is never detached');
  assert.equal(timers.length, before + 1, 'the idle timer is re-armed instead');
  finish({ nodes: [] });
  await pending;
});

test('Chromium adapter re-attaches once and retries when a command reports the debugger is not attached', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api });
  const context = { scope, signal: openSignal() };
  await adapter.execute('browser_snapshot', {}, context);

  let failures = 1;
  chromium.handlers['Accessibility.getFullAXTree'] = () => {
    if (failures > 0) {
      failures -= 1;
      throw new Error('Debugger is not attached to the tab with id: 7.');
    }
    return { nodes: [] };
  };
  const snapshot = await adapter.execute('browser_snapshot', {}, context);
  assert.deepEqual(snapshot.nodes, []);
  assert.equal(countCalls(chromium.calls, 'attach'), 2);
  assert.equal(commandMethods(chromium.calls).filter((method) => method === 'Accessibility.enable').length, 2, 'the retry re-enables domains');

  failures = 2;
  await assert.rejects(adapter.execute('browser_snapshot', {}, context), /not attached/i);
  assert.equal(countCalls(chromium.calls, 'attach'), 3, 'one re-attach per failed command, never a loop');

  chromium.handlers['Accessibility.getFullAXTree'] = () => {
    throw new Error('Detached while handling command.');
  };
  await assert.rejects(adapter.execute('browser_snapshot', {}, context), /detached while handling/i);
});

test('Chromium adapter does not silently re-attach after an external detach already dropped the session', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  const events = [];
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api, onDebuggerDetach: (event) => events.push(event) });
  const context = { scope, signal: openSignal() };
  await adapter.execute('browser_snapshot', {}, context);
  chromium.handlers['Accessibility.getFullAXTree'] = () => {
    chromium.emitDetach(7, 'canceled_by_user');
    throw new Error('Detached while handling command.');
  };
  await assert.rejects(adapter.execute('browser_snapshot', {}, context), /detached while handling/i);
  assert.equal(countCalls(chromium.calls, 'attach'), 1);
  assert.deepEqual(events, [{ tabId: 7, reason: 'canceled_by_user', recoverable: false }]);
});

test('Chromium parity primitives hover drag scroll-to modifiers clipped screenshots and reactive typing', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  chromium.api.debugger.sendCommand = async (target, method, params = {}) => {
    chromium.calls.push(['command', target, method, params]);
    if (method === 'DOM.getBoxModel') return { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'object-44' } };
    if (method === 'Page.captureScreenshot') return { data: 'ZmFrZS1wbmc=' };
    return {};
  };
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api, ...fakeClock() });
  const signal = new AbortController().signal;
  const source = { backendDOMNodeId: 44 };
  const destination = { backendDOMNodeId: 46 };

  await adapter.execute('browser_hover', { ref: '@e1' }, { scope, signal, target: source });
  await adapter.execute('browser_drag', { ref: '@e1', to_ref: '@e2' }, { scope, signal, target: source, destination });
  await adapter.execute('browser_scroll_to', { ref: '@e1' }, { scope, signal, target: source });
  await adapter.execute('browser_press', { key: 'k', modifiers: ['ctrl', 'shift'] }, { scope, signal });
  await adapter.execute('browser_type', { ref: '@e1', text: 'reactive fixture' }, { scope, signal, target: source });
  const screenshot = await adapter.execute('browser_screenshot', { ref: '@e1', zoom: 2 }, { scope, signal, target: source });
  await adapter.execute('browser_click', { x: 25, y: 35 }, { scope, signal });

  const commands = chromium.calls.filter((call) => call[0] === 'command');
  const mouse = commands.filter((call) => call[2] === 'Input.dispatchMouseEvent').map((call) => call[3]);
  assert.deepEqual(mouse.map(({ type, button }) => [type, button || 'none']), [
    ['mouseMoved', 'none'],
    ['mouseMoved', 'none'], ['mousePressed', 'left'], ['mouseMoved', 'left'], ['mouseReleased', 'left'],
    ['mouseMoved', 'none'], ['mousePressed', 'left'], ['mouseReleased', 'left'],
  ]);
  assert.deepEqual(mouse.slice(2, 5).map(({ buttons }) => buttons), [1, 1, 0], 'drag holds the left button while moving');
  const keyDown = commands.find((call) => call[2] === 'Input.dispatchKeyEvent' && call[3].type === 'rawKeyDown');
  assert.equal(keyDown[3].modifiers, 10);
  assert.equal(commands.some((call) => call[2] === 'DOM.scrollIntoViewIfNeeded'), true);
  const callFunctions = commands.filter((call) => call[2] === 'Runtime.callFunctionOn');
  assert.match(callFunctions[0][3].functionDeclaration, /select\(\)/, 'typing selects existing content first');
  const reactive = callFunctions.at(-1);
  assert.equal(reactive[3].objectId, 'object-44');
  assert.match(reactive[3].functionDeclaration, /input/);
  assert.match(reactive[3].functionDeclaration, /change/);
  assert.doesNotMatch(JSON.stringify(callFunctions), /reactive fixture/);
  const capture = commands.find((call) => call[2] === 'Page.captureScreenshot');
  assert.deepEqual(capture[3].clip, { x: 10, y: 20, width: 20, height: 20, scale: 2 });
  assert.equal(screenshot.dataUrl, 'data:image/png;base64,ZmFrZS1wbmc=');
});

test('Chromium Phase 6 adapter keeps its session after a CDP failure and aborts before later commands', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const { api, calls } = chromiumApis({ failMethod: 'DOM.getBoxModel' });
  const adapter = createChromiumCdpAdapter({ browserApi: api });
  await assert.rejects(
    adapter.execute('browser_click', { ref: '@e1' }, { scope, signal: new AbortController().signal, target: { backendDOMNodeId: 44 } }),
    /forced DOM\.getBoxModel failure/,
  );
  assert.equal(countCalls(calls, 'detach'), 0, 'a failed command is not a reason to drop the session');

  const aborted = new AbortController();
  aborted.abort(new Error('cancelled'));
  const before = calls.length;
  await assert.rejects(adapter.execute('browser_scroll', { direction: 'down' }, { scope, signal: aborted.signal }), /cancelled/i);
  assert.equal(calls.length, before);
  await adapter.releaseTab(7);
  assert.equal(calls.at(-1)[0], 'detach');
});

test('Chromium adapter reports external debugger detach reasons but never its own detaches', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  const events = [];
  const adapter = createChromiumCdpAdapter({
    browserApi: chromium.api,
    onDebuggerDetach: (event) => events.push(event),
  });
  const context = { scope, signal: openSignal() };

  // Chrome emits onDetach synchronously inside our own detach().
  chromium.api.debugger.detach = async (target) => {
    chromium.calls.push(['detach', target]);
    chromium.emitDetach(target.tabId, 'canceled_by_user');
  };
  await adapter.execute('browser_snapshot', {}, context);
  await adapter.releaseTab(7);
  assert.deepEqual(events, [], 'extension cleanup must not pause its own lease');

  // Chrome emits onDetach after the detach() promise already resolved.
  await adapter.execute('browser_snapshot', {}, context);
  chromium.api.debugger.detach = async (target) => { chromium.calls.push(['detach', target]); };
  await adapter.releaseTab(7);
  chromium.emitDetach(7, 'canceled_by_user');
  assert.deepEqual(events, [], 'a late event for our own detach is still expected');

  // The expectation is consumed: a later real detach is external and drops the session.
  await adapter.execute('browser_snapshot', {}, context);
  const attachesBefore = countCalls(chromium.calls, 'attach');
  chromium.emitDetach(7, 'replaced_with_devtools');
  chromium.emitDetach(7, 'target_closed');
  assert.deepEqual(events, [
    { tabId: 7, reason: 'replaced_with_devtools', recoverable: false },
    { tabId: 7, reason: 'target_closed', recoverable: false },
  ]);
  await adapter.execute('browser_snapshot', {}, context);
  assert.equal(countCalls(chromium.calls, 'attach'), attachesBefore + 1, 'the dropped session is re-created on the next command');
  await adapter.dispose();
  assert.equal(chromium.detachListeners.length, 0);
  assert.equal(chromium.eventListeners.length, 0);
});

test('Chromium adapter clears the expected-detach marker when no onDetach event follows', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  const events = [];
  const timers = [];
  const adapter = createChromiumCdpAdapter({
    browserApi: chromium.api,
    onDebuggerDetach: (event) => events.push(event),
    setTimer: (callback, ms) => { const handle = { callback, ms }; timers.push(handle); return handle; },
    clearTimer: () => {},
  });
  await adapter.execute('browser_snapshot', {}, { scope, signal: openSignal() });
  await adapter.releaseTab(7);
  const grace = timers.find((handle) => handle.ms === 1_000);
  assert.ok(grace, 'a bounded grace timer cleans up the marker');
  grace.callback();
  chromium.emitDetach(7, 'canceled_by_user');
  assert.deepEqual(events, [{ tabId: 7, reason: 'canceled_by_user', recoverable: false }]);
});

test('Chromium adapter recovers its own stale attachment but still reports a real debugger conflict', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const stale = chromiumApis();
  let attaches = 0;
  stale.api.debugger.attach = async (target, version) => {
    stale.calls.push(['attach', target, version]);
    attaches += 1;
    if (attaches === 1) throw new Error('Another debugger is already attached to the tab with id: 7.');
  };
  const events = [];
  const adapter = createChromiumCdpAdapter({ browserApi: stale.api, onDebuggerDetach: (event) => events.push(event) });
  const snapshot = await adapter.execute('browser_snapshot', {}, { scope, signal: openSignal() });
  assert.equal(snapshot.title, 'Example');
  assert.deepEqual(stale.calls.slice(0, 3).map((call) => call[0]), ['attach', 'detach', 'attach']);
  assert.deepEqual(events, [], 'the recovery detach is ours, not an external one');

  const foreign = chromiumApis();
  foreign.api.debugger.attach = async () => { throw new Error('Another debugger is already attached to the tab with id: 7.'); };
  foreign.api.debugger.detach = async () => { throw new Error('Debugger is not attached to the tab with id: 7.'); };
  await assert.rejects(
    createChromiumCdpAdapter({ browserApi: foreign.api }).execute('browser_snapshot', {}, { scope, signal: openSignal() }),
    (error) => error?.code === 'debugger_conflict',
  );
});

test('Chromium adapter reports another-debugger conflicts truthfully and never issues CDP commands', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  chromium.api.debugger.attach = async () => {
    throw new Error('Another debugger is already attached to the tab');
  };
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api });
  await assert.rejects(
    adapter.execute('browser_snapshot', {}, { scope, signal: new AbortController().signal }),
    (error) => error?.code === 'debugger_conflict' && /another debugger/i.test(error.message),
  );
  assert.equal(chromium.calls.some((call) => call[0] === 'command'), false);
});

test('Phase 6 screenshot adapters reject oversize inline payloads instead of returning corrupt truncation', async () => {
  const { createChromiumCdpAdapter, createFirefoxWebExtensionAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  chromium.api.debugger.sendCommand = async (_target, method) => {
    chromium.calls.push(['command', _target, method]);
    if (method === 'Page.captureScreenshot') return { data: 'A'.repeat(1_500_001) };
    return {};
  };
  await assert.rejects(
    createChromiumCdpAdapter({ browserApi: chromium.api }).execute(
      'browser_screenshot', {}, { scope, signal: new AbortController().signal },
    ),
    /screenshot_too_large/,
  );

  const firefox = firefoxApis();
  firefox.api.tabs.captureVisibleTab = async () => `data:image/png;base64,${'A'.repeat(1_500_001)}`;
  await assert.rejects(
    createFirefoxWebExtensionAdapter({ browserApi: firefox.api }).execute(
      'browser_screenshot', {}, { scope, signal: new AbortController().signal },
    ),
    /screenshot_too_large/,
  );
});

test('Phase 6 tab listing redacts restricted leased-tab metadata', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const { api } = chromiumApis();
  api.tabs.query = async () => [{
    id: 7,
    windowId: 4,
    active: true,
    title: 'Private wallet',
    url: 'https://example.test/account/wallet',
    favIconUrl: 'https://example.test/private.ico',
  }];
  const result = await createChromiumCdpAdapter({ browserApi: api }).execute(
    'browser_tabs', {}, { scope, leasedTabIds: [7], signal: new AbortController().signal },
  );
  assert.deepEqual(result.tabs, [{
    id: 7,
    active: true,
    pinned: false,
    audible: false,
    title: '(restricted tab)',
    url: '(omitted by privacy guard)',
    favIconUrl: '',
  }]);
});

test('Phase 6 adapters create and close owned tabs while Chromium alone groups task tabs', async () => {
  const { createChromiumCdpAdapter, createFirefoxWebExtensionAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  const chrome = createChromiumCdpAdapter({ browserApi: chromium.api });
  const context = { scope, leasedTabIds: [7, 8], ownedTabIds: [7, 8], signal: new AbortController().signal };
  assert.deepEqual(await chrome.execute('browser_tab_create', { url: 'https://example.test/new', active: false }, context), {
    tab: { id: 9, windowId: 4, active: false, url: 'https://example.test/new' },
  });
  await chrome.execute('browser_tab_group', { tab_ids: [7, 8] }, context);
  await chrome.execute('browser_tab_ungroup', { tab_ids: [7, 8] }, context);
  await chrome.execute('browser_tab_close', { tab_id: 8 }, context);
  assert.deepEqual(chromium.calls.filter((call) => call[0].startsWith('tabs.')), [
    ['tabs.create', { url: 'https://example.test/new', active: false, windowId: 4 }],
    ['tabs.group', { tabIds: [7, 8] }],
    ['tabs.ungroup', [7, 8]],
    ['tabs.remove', 8],
  ]);
  await assert.rejects(chrome.execute('browser_tab_close', { tab_id: 99 }, context), /owned/i);

  const firefox = firefoxApis();
  const fox = createFirefoxWebExtensionAdapter({ browserApi: firefox.api });
  const foxCreated = await fox.execute('browser_tab_create', { url: 'https://example.test/new', active: true }, context);
  assert.equal(foxCreated.tab.id, 9);
  await fox.execute('browser_tab_close', { tab_id: 8 }, context);
  await assert.rejects(fox.execute('browser_tab_group', { tab_ids: [7, 8] }, context), /not supported/i);
});

test('Phase 6 inspection does not inject a page probe into restricted surfaces', async () => {
  const { createFirefoxWebExtensionAdapter } = await adaptersModule();
  const { api, calls } = firefoxApis();
  api.tabs.get = async () => ({ id: 7, url: 'https://example.test/account/wallet' });
  const inspected = await createFirefoxWebExtensionAdapter({ browserApi: api }).inspect({
    tabId: 7,
    frameId: 0,
    signal: new AbortController().signal,
  });
  assert.deepEqual(inspected, {
    currentUrl: 'https://example.test/account/wallet',
    hasUnsavedContent: false,
  });
  assert.equal(calls.some((call) => call[0] === 'executeScript'), false);
});

test('Phase 2 light inspection reads only the tab URL and skips the page probe', async () => {
  const { createFirefoxWebExtensionAdapter } = await adaptersModule();
  const { api, calls } = firefoxApis();
  api.tabs.get = async () => ({ id: 7, url: 'https://example.test/list' });
  const adapter = createFirefoxWebExtensionAdapter({ browserApi: api });
  const light = await adapter.inspect({ tabId: 7, frameId: 0, signal: openSignal(), light: true });
  assert.deepEqual(light, { currentUrl: 'https://example.test/list', hasUnsavedContent: false });
  assert.equal(calls.some((call) => call[0] === 'executeScript'), false);
  await adapter.inspect({ tabId: 7, frameId: 0, signal: openSignal() });
  assert.equal(calls.some((call) => call[0] === 'executeScript'), true, 'the default probe still checks for unsaved content');
});

test('Firefox Phase 6 adapter runs only the truthful safe WebExtension subset', async () => {
  const { createFirefoxWebExtensionAdapter } = await adaptersModule();
  const { api, calls } = firefoxApis();
  const adapter = createFirefoxWebExtensionAdapter({ browserApi: api });
  assert.equal(adapter.contract.id, CONTROLLER_ADAPTER_IDS.FIREFOX_WEBEXTENSION);
  assert.equal(adapter.contract.actions.includes('browser_click'), false);

  const snapshot = await adapter.execute('browser_snapshot', {}, { scope, signal: new AbortController().signal });
  assert.equal(snapshot.nodes[0].name, 'Search');
  await adapter.execute('browser_scroll', { direction: 'down' }, { scope, signal: new AbortController().signal });
  await adapter.execute('browser_navigate', { url: 'https://example.test/next' }, { scope, signal: new AbortController().signal });
  await adapter.execute('browser_back', {}, { scope, signal: new AbortController().signal });
  const screenshot = await adapter.execute('browser_screenshot', {}, { scope, signal: new AbortController().signal });
  const tabs = await adapter.execute('browser_tabs', {}, { scope, leasedTabIds: [7, 8], signal: new AbortController().signal });
  await adapter.execute('browser_tab_activate', { tab_id: 8 }, { scope, signal: new AbortController().signal });

  assert.equal(screenshot.dataUrl, 'data:image/png;base64,ZmFrZQ==');
  assert.equal(tabs.tabs.length, 2);
  assert.deepEqual(calls.map((call) => call[0]), [
    'executeScript', 'executeScript', 'tabs.update', 'tabs.goBack', 'captureVisibleTab', 'tabs.update',
  ]);
  await assert.rejects(
    adapter.execute('browser_click', { ref: '@e1' }, { scope, signal: new AbortController().signal }),
    /not supported/i,
  );
});

function mouseEvents(calls) {
  return calls
    .filter((call) => call[0] === 'command' && call[2] === 'Input.dispatchMouseEvent')
    .map((call) => call[3]);
}

test('Chromium click moves the pointer first and presses with the left button held', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const { api, calls } = chromiumApis();
  const adapter = createChromiumCdpAdapter({ browserApi: api });
  const result = await adapter.execute('browser_click', { ref: '@e1' }, { scope, signal: openSignal(), target: clickTarget });
  assert.deepEqual(result, { status: 'clicked' });
  assert.deepEqual(mouseEvents(calls), [
    { type: 'mouseMoved', x: 20, y: 30, button: 'none', buttons: 0 },
    { type: 'mousePressed', x: 20, y: 30, button: 'left', buttons: 1, clickCount: 1 },
    { type: 'mouseReleased', x: 20, y: 30, button: 'left', buttons: 0, clickCount: 1 },
  ]);
  const hitTest = calls.find((call) => call[2] === 'DOM.getNodeForLocation');
  assert.deepEqual(hitTest[3], { x: 20, y: 30, includeUserAgentShadowDOM: true });
  assert.ok(commandMethods(calls).indexOf('DOM.getNodeForLocation') < commandMethods(calls).indexOf('Input.dispatchMouseEvent'));
});

test('Chromium click reports obscured when another element covers the point and still clicks', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  chromium.handlers['DOM.getNodeForLocation'] = () => ({ backendNodeId: 99 });
  chromium.handlers['DOM.resolveNode'] = ({ backendNodeId }) => ({ object: { objectId: `object-${backendNodeId}` } });
  let contained = false;
  chromium.handlers['Runtime.callFunctionOn'] = () => ({ result: { value: contained } });
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api });
  const context = { scope, signal: openSignal(), target: clickTarget };

  assert.deepEqual(await adapter.execute('browser_click', { ref: '@e1' }, context), { status: 'clicked', obscured: true });
  assert.equal(mouseEvents(chromium.calls).map((event) => event.type).join(), 'mouseMoved,mousePressed,mouseReleased');
  const contains = chromium.calls.find((call) => call[2] === 'Runtime.callFunctionOn');
  assert.equal(contains[3].objectId, 'object-44');
  assert.deepEqual(contains[3].arguments, [{ objectId: 'object-99' }]);
  assert.match(contains[3].functionDeclaration, /contains/);

  contained = true;
  assert.deepEqual(await adapter.execute('browser_click', { ref: '@e1' }, context), { status: 'clicked' }, 'a child of the target is not an obstruction');

  chromium.handlers['DOM.getNodeForLocation'] = () => ({ backendNodeId: 44 });
  assert.deepEqual(await adapter.execute('browser_click', { ref: '@e1' }, context), { status: 'clicked' });
});

test('Chromium click never fails because the hit test failed', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  chromium.handlers['DOM.getNodeForLocation'] = () => { throw new Error('hit test unavailable'); };
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api });
  const result = await adapter.execute('browser_click', { ref: '@e1' }, { scope, signal: openSignal(), target: clickTarget });
  assert.deepEqual(result, { status: 'clicked' });
  assert.equal(mouseEvents(chromium.calls).length, 3);
});

test('Chromium coordinate clicks skip the hit test but still move before pressing', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const { api, calls } = chromiumApis();
  await createChromiumCdpAdapter({ browserApi: api }).execute('browser_click', { x: 25.4, y: 35 }, { scope, signal: openSignal() });
  assert.equal(calls.some((call) => call[2] === 'DOM.getNodeForLocation'), false);
  assert.deepEqual(mouseEvents(calls).map(({ type, buttons }) => [type, buttons]), [
    ['mouseMoved', 0], ['mousePressed', 1], ['mouseReleased', 0],
  ]);
});

test('Chromium type clears the field by default and appends only when clear is false', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  chromium.handlers['DOM.resolveNode'] = () => ({ object: { objectId: 'object-44' } });
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api });
  const context = { scope, signal: openSignal(), target: clickTarget };

  assert.deepEqual(await adapter.execute('browser_type', { ref: '@e1', text: 'replacement' }, context), { status: 'typed' });
  assert.deepEqual(commandMethods(chromium.calls).filter((method) => method !== 'DOM.enable'), [
    'DOM.focus', 'DOM.resolveNode', 'Runtime.callFunctionOn', 'Input.insertText', 'Runtime.callFunctionOn',
  ]);
  const [clear, , events] = chromium.calls.filter((call) => call[2] === 'Runtime.callFunctionOn' || call[2] === 'Input.insertText');
  assert.match(clear[3].functionDeclaration, /\.select\(\)/);
  assert.match(clear[3].functionDeclaration, /isContentEditable/);
  assert.match(clear[3].functionDeclaration, /selectNodeContents/);
  assert.match(events[3].functionDeclaration, /"input"/);

  chromium.calls.length = 0;
  await adapter.execute('browser_type', { ref: '@e1', text: 'more', clear: false }, context);
  assert.deepEqual(commandMethods(chromium.calls), ['DOM.focus', 'DOM.resolveNode', 'Input.insertText', 'Runtime.callFunctionOn']);
  const last = chromium.calls.at(-1);
  assert.match(last[3].functionDeclaration, /"input"/);
  assert.doesNotMatch(JSON.stringify(chromium.calls), /select\(\)/);
  assert.equal(chromium.calls.find((call) => call[2] === 'Input.insertText')[3].text, 'more');
});

function keyEventsFrom(calls) {
  return calls.filter((call) => call[2] === 'Input.dispatchKeyEvent').map((call) => call[3]);
}

test('Chromium Enter sends a carriage-return text so implicit form submission fires', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const { api, calls } = chromiumApis();
  const adapter = createChromiumCdpAdapter({ browserApi: api });
  await adapter.execute('browser_press', { key: 'Enter' }, { scope, signal: openSignal() });
  await adapter.execute('browser_press', { key: 'Return' }, { scope, signal: openSignal() });
  await adapter.execute('browser_press', { key: 'Escape' }, { scope, signal: openSignal() });
  const events = keyEventsFrom(calls);
  assert.deepEqual(events[0], {
    type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0, text: '\r', unmodifiedText: '\r',
  });
  assert.deepEqual(events[1], { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0 });
  assert.equal(events[2].text, '\r', 'Return is Enter');
  assert.equal(events[4].type, 'rawKeyDown', 'keys without text use rawKeyDown');
  assert.equal('text' in events[4], false);
});

test('Chromium press accepts modifier combos in the key and keeps the modifiers option', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const { api, calls } = chromiumApis();
  const adapter = createChromiumCdpAdapter({ browserApi: api });
  const press = (args) => adapter.execute('browser_press', args, { scope, signal: openSignal() });

  await press({ key: 'Control+a' });
  await press({ key: 'Meta+a' });
  await press({ key: 'Shift+Tab' });
  await press({ key: 'a' });
  await press({ key: 'Shift+a' });
  await press({ key: 'k', modifiers: ['ctrl', 'shift'] });
  await press({ key: 'Control+Shift+ArrowLeft' });
  await press({ key: 'Control++' });
  await press({ key: ' ' });
  const downs = keyEventsFrom(calls).filter((event) => event.type !== 'keyUp');

  assert.deepEqual(downs[0], { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  assert.deepEqual(downs[1], {
    type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4, commands: ['selectAll'],
  });
  assert.deepEqual(downs[2], { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
  assert.deepEqual(downs[3], {
    type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 0, text: 'a', unmodifiedText: 'a',
  });
  assert.equal(downs[4].text, 'A');
  assert.equal(downs[4].modifiers, 8);
  assert.equal(downs[5].modifiers, 10);
  assert.equal(downs[5].type, 'rawKeyDown');
  assert.equal(downs[6].key, 'ArrowLeft');
  assert.equal(downs[6].modifiers, 10);
  assert.equal(downs[7].key, '+');
  assert.equal(downs[7].modifiers, 2);
  assert.equal(downs[8].key, ' ');
  assert.equal(downs[8].text, ' ');
  await assert.rejects(press({ key: 'Hyper+a' }), /Unsupported key modifier/);
});

test('Chromium scroll sends a wheel event at the viewport centre and returns the new position', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  const position = { scrollX: 0, scrollY: 680, maxY: 4_000, atTop: false, atBottom: false };
  chromium.handlers['Runtime.evaluate'] = () => ({ result: { value: position } });
  const waits = [];
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api, sleep: async (ms) => { waits.push(ms); } });
  const context = { scope, signal: openSignal() };

  const down = await adapter.execute('browser_scroll', { direction: 'down' }, context);
  assert.deepEqual(down, { status: 'scrolled', position });
  assert.deepEqual(mouseEvents(chromium.calls), [{ type: 'mouseWheel', x: 500, y: 400, deltaX: 0, deltaY: 680 }]);
  assert.deepEqual(waits, [120], 'a short settle delay precedes the position read');
  assert.ok(commandMethods(chromium.calls).indexOf('Input.dispatchMouseEvent') < commandMethods(chromium.calls).lastIndexOf('Runtime.evaluate'));
  assert.match(chromium.calls.at(-1)[3].expression, /scrollY/);

  chromium.calls.length = 0;
  await adapter.execute('browser_scroll', { direction: 'up' }, context);
  await adapter.execute('browser_scroll', { direction: 'right', amount: 300 }, context);
  await adapter.execute('browser_scroll', { direction: 'page_down', amount: 50 }, context);
  await adapter.execute('browser_scroll', { direction: 'left', amount: 99_999 }, context);
  await adapter.execute('browser_scroll', { direction: 'down', amount: 'lots' }, context);
  assert.deepEqual(mouseEvents(chromium.calls).map(({ deltaX, deltaY }) => [deltaX, deltaY]), [
    [0, -680], [300, 0], [0, 100], [-5_000, 0], [0, 680],
  ]);
  await assert.rejects(adapter.execute('browser_scroll', { direction: 'sideways' }, context), /Unsupported scroll direction/);
});

test('Chromium scroll falls back to window.scrollBy when the wheel event fails and omits an unreadable position', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  chromium.handlers['Input.dispatchMouseEvent'] = () => { throw new Error('wheel unsupported'); };
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api, ...fakeClock() });
  const result = await adapter.execute('browser_scroll', { direction: 'down', amount: 400 }, { scope, signal: openSignal() });
  assert.deepEqual(result, { status: 'scrolled' });
  const evaluations = chromium.calls.filter((call) => call[2] === 'Runtime.evaluate');
  assert.match(evaluations[0][3].expression, /window\.scrollBy\(\{left:0,top:400,behavior:'auto'\}\)/);
  assert.doesNotMatch(evaluations[0][3].expression, /down|args|direction|javascript:/i);
  assert.equal(evaluations.length, 2, 'the position is still read after the fallback');
});

test('Chromium scroll at a ref scrolls the element into view and wheels over its centre', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const { api, calls } = chromiumApis();
  const adapter = createChromiumCdpAdapter({ browserApi: api, ...fakeClock() });
  await adapter.execute('browser_scroll', { direction: 'down' }, { scope, signal: openSignal(), target: clickTarget });
  assert.equal(calls.some((call) => call[2] === 'DOM.scrollIntoViewIfNeeded'), true);
  assert.deepEqual(mouseEvents(calls).map(({ x, y }) => [x, y]), [[20, 30]]);
});

test('Chromium navigate to the tab\'s current URL is a no-op, ignoring hash and trailing slash', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  chromium.tabs.set(7, { ...chromium.tabs.get(7), url: 'https://example.test/docs/page/?q=1#top' });
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api });
  for (const url of ['https://example.test/docs/page?q=1', 'https://example.test/docs/page/?q=1#other', 'https://example.test/docs/page/?q=1']) {
    const result = await adapter.execute('browser_navigate', { url }, { scope, signal: openSignal() });
    assert.deepEqual(result, {
      url: 'https://example.test/docs/page/?q=1#top', title: 'Example', status: 'already-open', navigated: false,
    });
  }
  assert.deepEqual(chromium.calls, [], 'no attach and no Page.navigate for the same page');

  const different = await adapter.execute('browser_navigate', { url: 'https://example.test/docs/page?q=2' }, { scope, signal: openSignal() });
  assert.equal(different.status, 'navigated');
  assert.equal(chromium.calls.some((call) => call[2] === 'Page.navigate'), true);
});

test('Chromium navigate returns the final URL and title after the load finishes', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  chromium.handlers['Page.navigate'] = (params, target) => {
    // The destination redirects; the tab is still loading until the load event.
    chromium.tabs.set(target.tabId, { ...chromium.tabs.get(target.tabId), status: 'loading', url: 'https://example.test/redirected', title: 'Landing' });
    setTimeout(() => {
      chromium.tabs.set(target.tabId, { ...chromium.tabs.get(target.tabId), status: 'complete' });
      chromium.emitEvent(target.tabId, 'Page.loadEventFired', {});
    }, 5);
    return { frameId: 'main-frame' };
  };
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api });
  const result = await adapter.execute('browser_navigate', { url: 'https://example.test/old-link' }, { scope, signal: openSignal() });
  assert.deepEqual(result, {
    url: 'https://example.test/redirected', title: 'Landing', status: 'navigated', navigated: true, timedOut: false,
  });
  assert.equal(chromium.eventListeners.length, 1, 'the event listener lives once per adapter, waiters are per navigation');
});

test('Chromium navigate ignores frame-stopped events from other frames', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  const clock = fakeClock();
  chromium.handlers['Page.navigate'] = (params, target) => {
    chromium.tabs.set(target.tabId, { ...chromium.tabs.get(target.tabId), status: 'loading', url: params.url });
    return { frameId: 'main-frame' };
  };
  let polls = 0;
  const adapter = createChromiumCdpAdapter({
    browserApi: chromium.api,
    now: clock.now,
    sleep: async (ms) => {
      await clock.sleep(ms);
      polls += 1;
      if (polls === 1) chromium.emitEvent(7, 'Page.frameStoppedLoading', { frameId: 'ad-frame' });
      if (polls === 3) chromium.emitEvent(7, 'Page.frameStoppedLoading', { frameId: 'main-frame' });
    },
  });
  const result = await adapter.execute('browser_navigate', { url: 'https://example.test/two' }, { scope, signal: openSignal() });
  assert.equal(result.timedOut, false);
  assert.equal(polls, 3);
});

test('Chromium navigate turns a Page.navigate errorText into a navigation_failed error', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  chromium.handlers['Page.navigate'] = () => ({ frameId: 'main-frame', errorText: 'net::ERR_NAME_NOT_RESOLVED' });
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api, ...fakeClock() });
  await assert.rejects(
    adapter.execute('browser_navigate', { url: 'https://nope.invalid/' }, { scope, signal: openSignal() }),
    (error) => error?.code === 'navigation_failed' && /ERR_NAME_NOT_RESOLVED/.test(error.message),
  );
});

test('Chromium navigate and back report timedOut instead of failing when the page never finishes loading', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  const clock = fakeClock();
  chromium.handlers['Page.navigate'] = (params, target) => {
    chromium.tabs.set(target.tabId, { ...chromium.tabs.get(target.tabId), status: 'loading', url: params.url, title: 'Slow page' });
    return { frameId: 'main-frame' };
  };
  chromium.handlers['Page.navigateToHistoryEntry'] = () => ({});
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api, ...clock });
  const result = await adapter.execute('browser_navigate', { url: 'https://example.test/slow' }, { scope, signal: openSignal() });
  assert.deepEqual(result, {
    url: 'https://example.test/slow', title: 'Slow page', status: 'navigated', navigated: true, timedOut: true,
  });
  assert.ok(clock.now() >= 8_000 && clock.now() < 8_500, `waited the 8s cap, not longer (${clock.now()})`);

  chromium.tabs.set(7, { ...chromium.tabs.get(7), status: 'loading' });
  const back = await adapter.execute('browser_back', {}, { scope, signal: openSignal() });
  assert.equal(back.status, 'navigated-back');
  assert.equal(back.timedOut, true);
});

test('Chromium back waits for the load and returns the page it landed on', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const { api } = chromiumApis();
  const adapter = createChromiumCdpAdapter({ browserApi: api, ...fakeClock() });
  const back = await adapter.execute('browser_back', {}, { scope, signal: openSignal() });
  assert.deepEqual(back, {
    url: 'https://example.test/old', title: 'Old page', status: 'navigated-back', navigated: true, timedOut: false,
  });
});

test('Chromium navigate aborts promptly when the command is cancelled during the load wait', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  chromium.handlers['Page.navigate'] = (params, target) => {
    chromium.tabs.set(target.tabId, { ...chromium.tabs.get(target.tabId), status: 'loading', url: params.url });
    return { frameId: 'main-frame' };
  };
  const controller = new AbortController();
  const adapter = createChromiumCdpAdapter({
    browserApi: chromium.api,
    sleep: async () => { controller.abort(new Error('deadline')); },
  });
  await assert.rejects(
    adapter.execute('browser_navigate', { url: 'https://example.test/slow' }, { scope, signal: controller.signal }),
    /deadline/,
  );
});

test('Chromium settle in dom mode waits for a quiet window and never throws', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  let quiet = true;
  chromium.handlers['Runtime.evaluate'] = () => ({ result: { value: quiet } });
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api, ...fakeClock() });

  const settled = await adapter.settle({ scope, signal: openSignal(), mode: 'dom' });
  assert.deepEqual(settled, { navigated: false, url: 'https://example.test/start', title: 'Example', timedOut: false });
  const evaluate = chromium.calls.find((call) => call[2] === 'Runtime.evaluate');
  assert.equal(evaluate[3].awaitPromise, true);
  assert.equal(evaluate[3].returnByValue, true);
  assert.match(evaluate[3].expression, /MutationObserver/);
  assert.match(evaluate[3].expression, /setTimeout\(\(\) => finish\(true\), 150\)/);
  assert.match(evaluate[3].expression, /setTimeout\(\(\) => finish\(false\), 1200\)/);

  quiet = false;
  assert.equal((await adapter.settle({ scope, signal: openSignal() })).timedOut, true, 'a page that never goes quiet hits the cap');

  chromium.handlers['Runtime.evaluate'] = () => { throw new Error('Execution context was destroyed.'); };
  const failed = await adapter.settle({ scope, signal: openSignal(), mode: 'dom' });
  assert.equal(failed.timedOut, true);
  assert.equal(failed.url, 'https://example.test/start');
});

test('Chromium settle switches to the load wait when the action started a navigation', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api, ...fakeClock() });
  // A click is already loading a new document when settle runs.
  chromium.tabs.set(7, { ...chromium.tabs.get(7), status: 'loading', url: 'https://example.test/clicked' });
  let polls = 0;
  const originalGet = chromium.api.tabs.get;
  chromium.api.tabs.get = async (tabId) => {
    polls += 1;
    if (polls >= 3) chromium.tabs.set(7, { ...chromium.tabs.get(7), status: 'complete', title: 'Clicked page' });
    return originalGet(tabId);
  };
  const settled = await adapter.settle({ scope, signal: openSignal(), mode: 'dom' });
  assert.deepEqual(settled, { navigated: true, url: 'https://example.test/clicked', title: 'Clicked page', timedOut: false });
  assert.equal(chromium.calls.some((call) => call[2] === 'Runtime.evaluate'), false, 'no in-page wait while the document is loading');

  // A navigation that begins during the quiet window is detected afterwards.
  const second = chromiumApis();
  second.handlers['Runtime.evaluate'] = () => {
    second.tabs.set(7, { ...second.tabs.get(7), status: 'complete', url: 'https://example.test/after-click', title: 'After click' });
    throw new Error('Execution context was destroyed.');
  };
  const secondAdapter = createChromiumCdpAdapter({ browserApi: second.api, ...fakeClock() });
  const detected = await secondAdapter.settle({ scope, signal: openSignal() });
  assert.deepEqual(detected, { navigated: true, url: 'https://example.test/after-click', title: 'After click', timedOut: false });
});

test('Chromium settle in navigation mode returns immediately for a loaded tab and honours the timeout for a loading one', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  const clock = fakeClock();
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api, ...clock });
  const loaded = await adapter.settle({ scope, signal: openSignal(), mode: 'navigation' });
  assert.deepEqual(loaded, { navigated: true, url: 'https://example.test/start', title: 'Example', timedOut: false });
  assert.equal(clock.now(), 0);

  chromium.tabs.set(7, { ...chromium.tabs.get(7), status: 'loading' });
  const slow = await adapter.settle({ scope, signal: openSignal(), mode: 'navigation', timeoutMs: 1_000 });
  assert.equal(slow.timedOut, true);
  assert.ok(clock.now() >= 1_000 && clock.now() < 1_300);
});

test('Chromium settle never throws for a missing scope, a gone tab, or a cancelled command', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api, ...fakeClock() });
  assert.deepEqual(
    await adapter.settle({ scope: {}, signal: openSignal(), mode: 'dom' }),
    { navigated: false, url: '', title: '', timedOut: true },
  );
  chromium.api.tabs.get = async () => { throw new Error('No tab with id: 7.'); };
  assert.deepEqual(
    await adapter.settle({ scope, signal: openSignal(), mode: 'navigation' }),
    { navigated: true, url: '', title: '', timedOut: true },
  );
  chromium.api.tabs.get = async () => ({ id: 7, status: 'complete', url: 'https://example.test/start', title: 'Example' });
  const aborted = new AbortController();
  aborted.abort(new Error('cancelled'));
  const result = await adapter.settle({ scope, signal: aborted.signal, mode: 'dom' });
  assert.equal(result.timedOut, true);
  assert.deepEqual(await adapter.settle(), { navigated: false, url: '', title: '', timedOut: true });
});

test('Chromium maps missing-node CDP errors to a stale_ref error that tells the model what to do', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const expected = /That element is gone .* browser_snapshot\./;
  for (const [method, message] of [
    ['DOM.getBoxModel', 'Could not find node with given id'],
    ['DOM.scrollIntoViewIfNeeded', 'No node with given id found'],
    ['DOM.resolveNode', 'No node with given id found'],
    ['DOM.focus', 'Node is detached from document'],
  ]) {
    const chromium = chromiumApis();
    chromium.handlers[method] = () => { throw new Error(message); };
    const adapter = createChromiumCdpAdapter({ browserApi: chromium.api });
    const action = method === 'DOM.resolveNode' || method === 'DOM.focus' ? 'browser_type' : 'browser_click';
    await assert.rejects(
      adapter.execute(action, { ref: '@e1', text: 'x' }, { scope, signal: openSignal(), target: clickTarget }),
      (error) => error?.code === 'stale_ref' && expected.test(error.message),
      method,
    );
  }
  const chromium = chromiumApis();
  chromium.handlers['DOM.getBoxModel'] = () => { throw new Error('Could not compute box model.'); };
  await assert.rejects(
    createChromiumCdpAdapter({ browserApi: chromium.api }).execute('browser_click', { ref: '@e1' }, { scope, signal: openSignal(), target: clickTarget }),
    (error) => error?.code === undefined && /box model/.test(error.message),
  );
});

test('Chromium snapshot derives sensitive-field signals and state flags from AX properties without reading values', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  const ax = (role, name, extra = {}) => ({
    nodeId: String(Math.random()), backendDOMNodeId: extra.id, role: { value: role }, name: { value: name }, ignored: false, ...extra.node,
    properties: extra.properties || [],
  });
  const prop = (name, value) => ({ name, value: { type: 'boolean', value } });
  chromium.handlers['Accessibility.getFullAXTree'] = () => ({
    nodes: [
      ax('heading', 'Sign in', { id: 10, properties: [prop('level', 1)] }),
      ax('StaticText', 'Sign in'),
      ax('navigation', 'Primary'),
      ax('textbox', '', { id: 11, properties: [prop('protected', true), prop('editable', 'plaintext'), prop('focused', true)], node: { value: { value: 'hunter2-secret' } } }),
      ax('textbox', 'Email', { id: 12, properties: [prop('editable', 'plaintext'), { name: 'autocomplete', value: { value: 'email' } }], node: { value: { value: 'me@example.test' } } }),
      ax('checkbox', 'Remember me', { id: 13, properties: [{ name: 'checked', value: { type: 'tristate', value: 'mixed' } }] }),
      ax('button', 'Menu', { id: 14, properties: [prop('expanded', true), prop('disabled', true)] }),
      ax('img', '', { id: 15 }),
      ax('img', 'Logo', { id: 16 }),
      ax('StaticText', 'Welcome back'),
    ],
  });
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api });
  const compactView = await adapter.execute('browser_snapshot', {}, { scope, signal: openSignal() });
  assert.deepEqual(compactView.nodes.map((node) => node.backendDOMNodeId), [11, 12, 13, 14, 16], 'unlabeled images are dropped, unnamed inputs are kept');
  assert.deepEqual(compactView.nodes[0], {
    role: 'textbox', name: '', backendDOMNodeId: 11, inputType: 'password', focused: true, editable: true, hasValue: true,
  });
  assert.deepEqual(compactView.nodes[1], {
    role: 'textbox', name: 'Email', backendDOMNodeId: 12, autocomplete: 'email', editable: true, hasValue: true,
  });
  assert.equal(compactView.nodes[2].checked, 'mixed');
  assert.deepEqual([compactView.nodes[3].expanded, compactView.nodes[3].disabled], [true, true]);
  assert.deepEqual(compactView.headings, [{ level: 1, name: 'Sign in' }]);
  assert.deepEqual(compactView.landmarks, [{ role: 'navigation', name: 'Primary' }]);
  assert.equal(compactView.text, 'Sign in\nWelcome back', 'the heading and its static-text child are not repeated');
  assert.doesNotMatch(JSON.stringify(compactView), /hunter2-secret|me@example\.test/);

  const fullView = await adapter.execute('browser_snapshot', { full: true }, { scope, signal: openSignal() });
  assert.equal(fullView.full, true);
  assert.deepEqual(fullView.nodes.map((node) => node.backendDOMNodeId), [11, 12, 13, 14, 15, 16]);
});

test('Chromium snapshot text is capped in compact mode and larger when full is requested', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  chromium.handlers['Accessibility.getFullAXTree'] = () => ({
    nodes: Array.from({ length: 400 }, (_, index) => ({
      nodeId: String(index), role: { value: 'StaticText' }, name: { value: `paragraph ${index} ${'x'.repeat(100)}` }, ignored: false,
    })),
  });
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api });
  const compactView = await adapter.execute('browser_snapshot', {}, { scope, signal: openSignal() });
  const fullView = await adapter.execute('browser_snapshot', { full: true }, { scope, signal: openSignal() });
  assert.ok(compactView.text.length <= 6_000);
  assert.ok(fullView.text.length > 30_000);
});

test('Chromium adapter dispose detaches every session and stops listening', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  const events = [];
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api, onDebuggerDetach: (event) => events.push(event) });
  await adapter.execute('browser_snapshot', {}, { scope, signal: openSignal() });
  await adapter.execute('browser_snapshot', {}, { scope: { tabId: 8, frameId: 0 }, signal: openSignal() });
  assert.equal(countCalls(chromium.calls, 'attach'), 2);
  await adapter.dispose();
  assert.deepEqual(chromium.calls.filter((call) => call[0] === 'detach').map((call) => call[1].tabId).sort(), [7, 8]);
  assert.equal(chromium.detachListeners.length, 0);
  assert.equal(chromium.eventListeners.length, 0);
  assert.deepEqual(events, []);
});

test('Firefox adapter exposes the same settle and release contract without a debugger', async () => {
  const { createFirefoxWebExtensionAdapter } = await adaptersModule();
  const { api } = firefoxApis();
  const adapter = createFirefoxWebExtensionAdapter({ browserApi: api, ...fakeClock() });
  assert.equal(await adapter.releaseTab(7), false);
  assert.deepEqual(
    await adapter.settle({ scope, signal: openSignal(), mode: 'dom' }),
    { navigated: false, url: 'https://example.test/start', title: 'Example', timedOut: false },
  );
  api.tabs.get = async () => ({ id: 7, status: 'loading', url: 'https://example.test/start', title: 'Example' });
  const slow = await adapter.settle({ scope, signal: openSignal(), timeoutMs: 500 });
  assert.equal(slow.navigated, true);
  assert.equal(slow.timedOut, true);
});
