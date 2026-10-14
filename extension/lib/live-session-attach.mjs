// Pure decisions for following a Hermes session that is already running when
// the user opens it. The side panel owns the DOM and gateway subscriptions;
// this module only answers "is it live?" and "may we attach now?".
//
// Attach is read-only: it paints the gateway's live deltas and tool events
// for that one session. It never starts or interrupts a run.

import { liveStateFromSessionRow } from './session-live-state.mjs';
import { browserDisplayMessages } from './web-run-state.mjs';
import { sanitizeToolPreview } from './common.mjs';

// Only decorate sessions from the current profile's historical list. The
// process-wide active_list RPC is not itself a profile-scoped session browser.
export function sessionLiveRoster(payload, allowedIds = []) {
  const allowed = new Set(allowedIds.map(String));
  const result = new Map();
  for (const row of Array.isArray(payload?.sessions) ? payload.sessions : []) {
    const id = String(row.session_key || '');
    if (!id || !allowed.has(id)) continue;
    result.set(id, { ...liveStateFromSessionRow(row), liveId: String(row.id || ''), status: row.status });
  }
  return result;
}

export function sessionIsLiveFromStatus(statusPayload = null) {
  if (!statusPayload || typeof statusPayload !== 'object') return false;
  const state = liveStateFromSessionRow(statusPayload)?.state;
  if (state !== 'unknown') return state === 'running';
  // session.status is a human-readable RPC on released gateways.
  return /^Agent Running:\s*Yes\s*$/mi.test(String(statusPayload.output || ''));
}

export function shouldAttachLiveSession({
  dashboardTransport = false,
  connectionReady = false,
  sending = false,
  sessionId = '',
  currentSessionId = '',
  alreadyAttachedTo = '',
} = {}) {
  const target = String(sessionId || '').trim();
  if (!dashboardTransport || !connectionReady) return false;
  if (!target) return false;
  // This panel's own turn already paints the bubble; never double-attach.
  if (sending) return false;
  if (String(currentSessionId || '').trim() !== target) return false;
  if (String(alreadyAttachedTo || '').trim() === target) return false;
  return true;
}

// Display receipts, never raw tool output. Support both the REST conversation
// and the gateway's display projection without changing model-facing history.
export function sessionToolDisplayMessages(rows = []) {
  if (!Array.isArray(rows)) return [];
  const output = [];
  const calls = new Map();
  const completed = new Set(rows.filter(row => row?.role === 'tool' && row.display_kind !== 'hidden')
    .map(row => String(row.tool_call_id || '')));
  const receipt = (name, args, preview, done, id = '') => {
    const hint = args?.command || args?.path || args?.query || args?.url || preview || '';
    return {
      role: 'assistant', content: '',
      toolActivity: { tool_name: name || 'Hermes tool', tool_call_id: id,
        type: done ? 'tool.complete' : 'tool.start', status: done ? 'completed' : 'progress',
        preview: sanitizeToolPreview(hint) },
    };
  };
  for (const row of rows) {
    if (!row || row.display_kind === 'hidden') continue;
    if (browserDisplayMessages([row]).length) output.push(row);
    for (const call of Array.isArray(row.tool_calls) ? row.tool_calls : []) {
      const fn = call.function || call;
      let args = fn.arguments || {};
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { args = {}; }
      }
      const id = String(call.id || call.call_id || '');
      calls.set(id, { name: fn.name, args });
      if (!id || !completed.has(id)) output.push(receipt(fn.name, args, '', false, id));
    }
    if (row.role === 'tool') {
      const id = String(row.tool_call_id || '');
      const call = calls.get(id);
      output.push(receipt(call?.name || row.tool_name || row.name, call?.args || row.args, row.context || '', true, id));
    }
  }
  return output;
}
