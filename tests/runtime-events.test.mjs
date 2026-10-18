import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BROWSER_RUNTIME_EVENT_NAMES,
  TOOL_EVENT_NAME_ALIASES,
  browserRuntimeEventName,
  normalizeBrowserRuntimeEvent,
  reduceAssistantStreamText,
} from '../extension/lib/runtime-events.mjs';

test('browser runtime event names are stable and exclude browser control', () => {
  assert.deepEqual(BROWSER_RUNTIME_EVENT_NAMES, {
    runStarted: 'run.started',
    runCompleted: 'run.completed',
    assistantDelta: 'assistant.delta',
    assistantCompleted: 'assistant.completed',
    toolStarted: 'tool.started',
    toolProgress: 'tool.progress',
    toolFinished: 'tool.finished',
    approvalRequested: 'approval.requested',
    approvalResolved: 'approval.resolved',
    steerAccepted: 'steer.accepted',
    steerQueued: 'steer.queued',
    sessionReset: 'session.reset',
    subagentFinished: 'subagent.finished',
  });
  assert.equal(browserRuntimeEventName('toolStarted'), 'tool.started');
  assert.equal(browserRuntimeEventName('browser.control.started'), 'runtime.unknown');
  assert.equal(Object.values(BROWSER_RUNTIME_EVENT_NAMES).some((name) => /browser\.control|control\./.test(name)), false);
});

test('normalizeBrowserRuntimeEvent maps current Hermes stream aliases to stable tool event names', () => {
  assert.equal(TOOL_EVENT_NAME_ALIASES['hermes.tool.progress'], 'tool.progress');

  const started = normalizeBrowserRuntimeEvent({
    type: 'hermes.tool.progress',
    data: { tool_name: 'read_file', status: 'started', preview: 'README.md' },
  });
  assert.equal(started.name, 'tool.started');
  assert.equal(started.toolName, 'read_file');
  assert.equal(started.status, 'started');
  assert.match(started.preview, /README/);

  const finished = normalizeBrowserRuntimeEvent({
    type: 'tool.finished',
    data: { name: 'terminal', status: 'completed', preview: 'Authorization: Bearer demo' },
  });
  assert.equal(finished.name, 'tool.finished');
  assert.equal(finished.toolName, 'terminal');
  assert.equal(finished.status, 'completed');
  assert.doesNotMatch(finished.preview, /Bearer demo/);
  assert.match(finished.preview, /Authorization: (?:Bearer \[REDACTED_BEARER\]|\*\*\*|\[REDACTED\])/);
});

test('upstream REST tool.completed and tool.failed finish the tool row instead of becoming unknown', async () => {
  const { normalizeToolActivity } = await import('../extension/lib/common.mjs');
  const { mergeToolCallActivity } = await import('../extension/lib/tool-call-group.mjs');

  const completed = normalizeBrowserRuntimeEvent({ type: 'tool.completed', data: { message_id: 'm1', tool_name: 'read_file', preview: 'README.md' } });
  assert.equal(completed.name, 'tool.finished');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.toolName, 'read_file');

  const failed = normalizeBrowserRuntimeEvent({ type: 'tool.failed', data: { message_id: 'm1', tool_name: 'terminal', preview: 'exit 1' } });
  assert.equal(failed.name, 'tool.finished');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.toolName, 'terminal');

  // An explicit status from the payload still wins.
  assert.equal(normalizeBrowserRuntimeEvent({ type: 'tool.failed', data: { tool_name: 'x', status: 'error' } }).status, 'error');

  // End to end: started then completed/failed leave one finished row per call.
  let calls = [];
  for (const event of [
    { type: 'tool.started', data: { tool_name: 'read_file' } },
    { type: 'tool.completed', data: { tool_name: 'read_file' } },
    { type: 'tool.started', data: { tool_name: 'terminal' } },
    { type: 'tool.failed', data: { tool_name: 'terminal' } },
  ]) calls = mergeToolCallActivity(calls, normalizeToolActivity(normalizeBrowserRuntimeEvent(event)));
  assert.deepEqual(calls.map((call) => [call.rawName, call.status]), [['read_file', 'completed'], ['terminal', 'failed']]);
});

test('unknown runtime events keep the payload status', () => {
  const unknown = normalizeBrowserRuntimeEvent({ type: 'hermes.future.event', data: { status: 'Running', message: 'hi' } });
  assert.equal(unknown.name, 'runtime.unknown');
  assert.equal(unknown.status, 'running');
  assert.equal(normalizeBrowserRuntimeEvent({ type: 'hermes.future.event', data: {} }).status, '');
});

test('final assistant.completed media content wins over raw deltas and run transcript history', () => {
  const rawMedia = 'Yep.\n\nMEDIA:C:\\Users\\Jaybo\\generated.png';
  const deliveredImage = 'Yep.\n\n![image](data:image/png;base64,aGVybWVz)';
  let state = reduceAssistantStreamText({}, { type: 'assistant.delta', data: { delta: rawMedia } });
  assert.equal(state.text, rawMedia);
  assert.equal(state.finalized, false);

  state = reduceAssistantStreamText(state, { type: 'assistant.completed', data: { content: deliveredImage } });
  assert.equal(state.text, deliveredImage);
  assert.equal(state.finalized, true);

  state = reduceAssistantStreamText(state, {
    type: 'run.completed',
    data: { messages: [{ role: 'assistant', content: rawMedia }] },
  });
  assert.equal(state.text, deliveredImage);
  assert.equal(state.finalized, true);

  state = reduceAssistantStreamText(state, {
    type: 'run.completed',
    data: {
      messages: [
        { role: 'assistant', content: 'Let me generate that.' },
        { role: 'tool', content: 'saved image' },
        { role: 'assistant', content: rawMedia },
      ],
    },
  });
  assert.equal(state.text, `Let me generate that.\n\n${deliveredImage}`);
  assert.equal(state.finalized, true);
});

test('run.completed remains a fallback when assistant.completed is absent', () => {
  const state = reduceAssistantStreamText({}, {
    type: 'run.completed',
    data: { messages: [{ role: 'assistant', content: 'fallback transcript text' }] },
  });
  assert.equal(state.text, 'fallback transcript text');
  assert.equal(state.finalized, false);
});
test('run.completed reconcile drops prior-turn bubbles restacked by degraded server history', () => {
  const priorA = 'earlier reply one';
  const priorB = 'earlier reply two';
  // Degraded-history server payload: current-turn segment first, then prior turns.
  const stackedPayload = [
    { role: 'assistant', content: 'current turn segment' },
    { role: 'assistant', content: priorA },
    { role: 'assistant', content: priorB },
  ];
  let state = reduceAssistantStreamText(
    {},
    { type: 'assistant.delta', data: { delta: 'current turn segment' } },
    [priorA, priorB],
  );
  assert.equal(state.text, 'current turn segment');

  state = reduceAssistantStreamText(state, { type: 'run.completed', data: { messages: stackedPayload } }, [priorA, priorB]);
  assert.equal(state.text, 'current turn segment');
});

test('reconcile keeps genuinely new intermediate segments and never swallows the only part', () => {
  // Intermediate tool-turn segment this panel has NOT shown yet survives.
  let state = reduceAssistantStreamText(
    {},
    { type: 'assistant.delta', data: { delta: 'partial live' } },
    ['older bubble'],
  );
  state = reduceAssistantStreamText(state, {
    type: 'run.completed',
    data: { messages: [{ role: 'assistant', content: 'hidden segment before tools' }, { role: 'assistant', content: 'partial live' }] },
  }, ['older bubble']);
  assert.equal(state.text, 'hidden segment before tools\n\npartial live');

  // Server sends exactly a known prior reply as the only part (repeat-question
  // case): never return empty; fall back to raw.
  state = reduceAssistantStreamText({}, {}, ['the very same reply']);
  state = reduceAssistantStreamText(state, {
    type: 'assistant.completed',
    data: { content: 'the very same reply' },
  }, ['the very same reply']);
  assert.equal(state.text, 'the very same reply');
  assert.equal(state.finalized, true);
});

test('no known list behaves exactly as before (back-compat)', () => {
  const state = reduceAssistantStreamText({}, {
    type: 'assistant.completed',
    data: { content: 'fresh reply' },
  });
  assert.equal(state.text, 'fresh reply');
});
