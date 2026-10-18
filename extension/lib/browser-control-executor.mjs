import {
  BROWSER_CONTROL_RISKS,
  classifyBrowserControlAction,
} from './browser-control-safety.mjs';
import { redactSensitiveText } from './browser-context-protocol.mjs';
import { redactSensitiveTextWithCount } from './content-extraction-core.mjs';
import { hasCredentialBearingUrl } from './redaction.mjs';
import {
  base64ToBytes,
} from './browser-control-artifacts.mjs';
import { MAX_INLINE_SCREENSHOT_CHARS } from './screenshot-limits.mjs';
import { renderControlSnapshot, SNAPSHOT_VIEW_BUDGETS } from './browser-control-snapshot-view.mjs';

const MAX_RESULT_TEXT = 100_000;
const MAX_CONSOLE_ENTRIES = 200;
const MAX_CONSOLE_ENTRY_CHARS = 2_000;
const MAX_NETWORK_REQUESTS = 100;
const MAX_RESPONSE_BODY_CHARS = 100_000;
const RESPONSE_BODY_MIME_RE = /^(?:text\/[a-z0-9.+-]+|application\/(?:json|javascript|xml|xhtml\+xml|problem\+json))(?:;|$)/i;
const CDP_DENY_METHOD_PREFIXES = ['Browser.', 'Target.', 'SystemInfo.', 'Tracing.', 'Memory.', 'Debugger.'];
const CDP_DENY_METHODS = new Set([
  'Page.close',
  'Page.navigate',
  'Page.navigateToHistoryEntry',
  'Page.reload',
  'Page.setWebLifecycleState',
  'Runtime.evaluate',
  'Runtime.terminateExecution',
]);

// Actions that change the page and therefore return fresh page state.
const POST_ACTION_ACTIONS = new Set([
  'browser_navigate', 'browser_back', 'browser_click', 'browser_type', 'browser_fill', 'browser_select',
  'browser_press', 'browser_scroll', 'browser_scroll_to', 'browser_hover',
]);
// Probes that only need the tab URL, not the unsaved-content page script.
const URL_ONLY_PROBE_ACTIONS = new Set(['browser_snapshot', 'browser_scroll', 'browser_screenshot', 'browser_back']);
const APPROVALS_RECHECK_ACTIONS = new Set(['browser_click', 'browser_drag', 'browser_press', 'browser_type']);
// The broker cancels a command at 30 s; the approval wait must end first.
const APPROVAL_WAIT_CAP_MS = 28_000;
const APPROVAL_TIMEOUT_MESSAGE = 'Waiting for your approval in the Hermes panel timed out.';
const POST_ACTION_SETTLE_MS = 1_200;
const POST_ACTION_MIN_BUDGET_MS = 250;
const POST_ACTION_DEADLINE_MARGIN_MS = 400;
const GENERATION_POLL_MS = 25;
const GENERATION_MAX_POLLS = 20;

// Adapter errors that carry a model-actionable code keep it; everything else
// is reported as a generic command_error.
const ADAPTER_ERROR_CODES = new Set(['stale_ref', 'navigation_failed']);

const APPROVAL_MESSAGES = Object.freeze({
  'cross-origin-unsaved-content': 'Leave this page while unsaved content may be present?',
  'submission-key': 'Press Enter to submit the current form or message?',
  'consequential-action': 'Run this consequential browser action?',
  'coordinate-click': 'Click these exact viewport coordinates?',
  'drag-action': 'Drag this target to the selected destination?',
  'tab-close': 'Close this Hermes-owned browser tab?',
  'console-metadata': 'Read console messages from this page?',
  'network-metadata': 'Read network request metadata for this page?',
  'response-body': 'Read the response body for this network request?',
  'pdf-generation': 'Generate a PDF of this page and store it as an artifact?',
  'file-upload': 'Upload the approved artifact to this page?',
  'evaluate-code': 'Run this evaluate code on the page?',
  'cdp-command': 'Send this raw CDP command to the page?',
  'dialog-consequence': 'Approve this page dialog?',
  'dialog-action': 'Handle this page dialog?',
});

const TIMED_OUT = Symbol('timed-out');

function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), Math.max(1, ms));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function compact(value, limit = 300) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function pickResultValue(value = null) {
  if (!value || typeof value !== 'object') return value;
  if (Object.hasOwn(value, 'value')) return value.value;
  if (Object.hasOwn(value, 'result')) return value.result;
  return value;
}

function safeNetworkUrl(value = '') {
  const url = compact(value, 2_000);
  if (!url) return '';
  if (hasCredentialBearingUrl(url)) {
    try {
      return `${new URL(url).origin}/(omitted by privacy guard)`;
    } catch {
      return '(omitted by privacy guard)';
    }
  }
  return redactSensitiveText(url);
}

function errorOutcome(code, message = '') {
  return {
    ok: false,
    error: {
      code,
      ...(message ? { message } : {}),
    },
  };
}

function normalizedScope(value = {}) {
  return {
    controllerId: compact(value.controllerId, 160),
    leaseOwnerId: compact(value.leaseOwnerId, 160),
    leaseId: compact(value.leaseId, 160),
    leaseGeneration: Number(value.leaseGeneration),
    tabId: Number(value.tabId),
    frameId: Math.max(0, Number(value.frameId) || 0),
    documentGeneration: Number(value.documentGeneration),
  };
}

function pageOrigin(value = '') {
  try {
    const parsed = new URL(String(value || ''));
    if (['http:', 'https:'].includes(parsed.protocol)) return parsed.origin;
    // Approved local documents: the file itself is the identity. Compare the
    // normalized file path so staying on the same local file passes while
    // navigating to a different local file still trips domain_changed.
    if (parsed.protocol === 'file:') return `file:${parsed.pathname}`;
    return '';
  } catch {
    return '';
  }
}

function frameMatchesScope(frame = {}, scope = {}) {
  return Number(frame.tab_id) === scope.tabId
    && Math.max(0, Number(frame.frame_id) || 0) === scope.frameId
    && Number(frame.document_generation) === scope.documentGeneration
    && Boolean(scope.controllerId)
    && scope.leaseOwnerId === scope.controllerId;
}

function safeResultUrl(value = '') {
  return safeNetworkUrl(value);
}

function safeResultTitle(value = '') {
  return redactSensitiveText(compact(value, 500));
}

// Renders the page into the model-facing view. `refResult` is the output of
// refs.replace for the same nodes, so every ref in the text is actionable.
function safeSnapshotResult(value = {}, refResult = {}, { maxChars, fullText = false } = {}) {
  const view = renderControlSnapshot({
    text: value.text,
    headings: value.headings,
    refs: Array.isArray(refResult.refs) ? refResult.refs : [],
    element_count: Array.isArray(value.nodes) ? value.nodes.length : 0,
    truncated: Boolean(value.truncated || refResult.truncated),
  }, { maxChars, fullText });
  return {
    title: safeResultTitle(value.title),
    url: safeResultUrl(value.url),
    text: view.text,
    refs: view.refs,
    truncated: view.truncated,
    element_count: view.element_count,
  };
}

function safeScrollPosition(position = null) {
  if (!position || typeof position !== 'object') return null;
  const numbers = ['scrollX', 'scrollY', 'maxY'].map((key) => Number(position[key]));
  if (!numbers.every(Number.isFinite)) return null;
  return {
    scrollX: numbers[0],
    scrollY: numbers[1],
    maxY: numbers[2],
    atTop: position.atTop === true,
    atBottom: position.atBottom === true,
  };
}

function navigationResult(status, value) {
  const url = safeResultUrl(value?.url);
  const title = safeResultTitle(value?.title);
  return {
    status,
    ...(url ? { url } : {}),
    ...(title ? { title } : {}),
    ...(typeof value?.navigated === 'boolean' ? { navigated: value.navigated } : {}),
    ...(value?.timedOut === true ? { timedOut: true } : {}),
  };
}

function sanitizedActionResult(action, value) {
  if (action === 'browser_type') return { status: 'typed' };
  if (action === 'browser_fill') return { status: 'filled' };
  if (action === 'browser_select') return { status: 'selected' };
  if (action === 'browser_press') return { status: 'pressed' };
  if (action === 'browser_click') return { status: 'clicked', ...(value?.obscured === true ? { obscured: true } : {}) };
  if (action === 'browser_drag') return { status: 'dragged' };
  if (action === 'browser_hover') return { status: 'hovered' };
  if (action === 'browser_scroll') {
    const position = safeScrollPosition(value?.position);
    return { status: 'scrolled', ...(position ? { position } : {}) };
  }
  if (action === 'browser_scroll_to') return { status: 'scrolled-to-target' };
  if (action === 'browser_navigate') {
    return navigationResult(value?.status === 'already-open' ? 'already-open' : 'navigated', value);
  }
  if (action === 'browser_back') return navigationResult('navigated-back', value);
  if (action === 'browser_tab_activate') return { status: 'tab-activated' };
  if (action === 'browser_tab_close') return { status: 'tab-closed' };
  if (action === 'browser_tab_create') {
    const tab = value?.tab || {};
    return { tab: {
      id: Number(tab.id),
      windowId: Number(tab.windowId),
      active: tab.active === true,
      url: compact(tab.url, 2_000),
    } };
  }
  if (action === 'browser_tab_group') return { status: 'tabs-grouped', groupId: Number(value?.groupId) };
  if (action === 'browser_tab_ungroup') return { status: 'tabs-ungrouped' };
  if (action === 'browser_dialog') {
    return {
      status: compact(value?.status, 80) || (value?.accept === true ? 'dialog-accepted' : 'dialog-dismissed'),
    };
  }
  if (action === 'browser_screenshot') {
    const dataUrl = String(value?.dataUrl || '');
    return {
      status: 'captured',
      dataUrl,
    };
  }
  if (action === 'browser_tabs') {
    return {
      tabs: Array.isArray(value?.tabs) ? value.tabs.slice(0, 100).map((tab) => ({
        id: Number(tab?.id),
        active: tab?.active === true,
        title: compact(tab?.title, 500),
        url: compact(tab?.url, 2_000),
      })).filter((tab) => Number.isInteger(tab.id) && tab.id > 0) : [],
    };
  }
  return value && typeof value === 'object' ? { status: compact(value.status || 'completed', 80) } : { status: 'completed' };
}

export function createBrowserControlExecutor({
  adapter,
  approvals,
  refs,
  artifacts = null,
  now = Date.now,
  defaultDeadlineMs = 30_000,
  developerMode = false,
  cdpPolicy = null,
} = {}) {
  if (!adapter?.contract || typeof adapter.execute !== 'function') throw new TypeError('Browser control adapter is required.');
  if (!approvals?.consume) throw new TypeError('Browser control approval store is required.');
  if (!refs?.resolve || !refs?.replace) throw new TypeError('Browser control ref store is required.');
  if (artifacts && (typeof artifacts.upload !== 'function' || typeof artifacts.download !== 'function')) {
    throw new TypeError('Browser control artifact client requires upload and download.');
  }
  const boundedDefaultDeadline = Math.max(1, Number(defaultDeadlineMs) || 1);
  const boundedDeveloperMode = developerMode === true;
  const boundedCdpPolicy = cdpPolicy && typeof cdpPolicy === 'object'
    ? {
      allow: Array.isArray(cdpPolicy.allow) ? cdpPolicy.allow.map((method) => compact(method, 200)).filter(Boolean) : [],
      deny: Array.isArray(cdpPolicy.deny) ? cdpPolicy.deny.map((method) => compact(method, 200)).filter(Boolean) : [],
    }
    : { allow: [], deny: [] };

  async function execute(frame = {}, context = {}) {
    const {
      scope: rawScope = {}, signal: callerSignal, leasedTabIds = [], ownedTabIds = [], currentWindowId = null,
      currentDocumentGeneration = null, snapshotBudget = '',
    } = context;
    let scope = normalizedScope(rawScope);
    if (!frameMatchesScope(frame, scope)) return errorOutcome('scope_mismatch', 'The command no longer matches the owned tab document.');

    const action = compact(frame.action, 120);
    const args = frame.arguments && typeof frame.arguments === 'object' ? { ...frame.arguments } : {};
    const ownedTabs = new Set(Array.from(leasedTabIds || []).map(Number).filter((tabId) => Number.isInteger(tabId) && tabId > 0));
    if (!ownedTabs.size) ownedTabs.add(scope.tabId);
    const controllerOwnedTabs = new Set(Array.from(ownedTabIds || []).map(Number).filter((tabId) => Number.isInteger(tabId) && tabId > 0));
    if (!controllerOwnedTabs.size) controllerOwnedTabs.add(scope.tabId);
    if (action === 'browser_tab_activate') {
      const targetTabId = Number(args.tab_id);
      if (!ownedTabs.has(targetTabId)) return errorOutcome('lease_required', 'The target tab is not owned by this controller.');
      scope = { ...scope, tabId: targetTabId };
    }
    if (action === 'browser_tab_close') {
      const targetTabId = Number(args.tab_id);
      if (!controllerOwnedTabs.has(targetTabId)) return errorOutcome('lease_not_owned', 'The target tab is not owned by this controller.');
    }
    if (action === 'browser_tab_group' || action === 'browser_tab_ungroup') {
      const tabIds = [...new Set((Array.isArray(args.tab_ids) ? args.tab_ids : []).map(Number))];
      if (!tabIds.length || tabIds.some((tabId) => !controllerOwnedTabs.has(tabId))) {
        return errorOutcome('lease_not_owned', 'Every grouped tab must be owned by this controller.');
      }
    }
    if (!adapter.contract.enabled || !adapter.contract.actions?.includes(action)) {
      return errorOutcome('unsupported_action', `The active browser adapter does not support ${action || 'this action'}.`);
    }

    const startedAt = Number(now());
    const requestedDeadline = Number(frame.deadline_at);
    const deadlineAt = Number.isFinite(requestedDeadline) && requestedDeadline > 0
      ? requestedDeadline
      : startedAt + boundedDefaultDeadline;
    if (startedAt >= deadlineAt) return errorOutcome('deadline_expired', 'The command deadline expired before execution.');
    if (callerSignal?.aborted) return errorOutcome('cancelled', 'The command was cancelled before execution.');

    const controller = new AbortController();
    let pendingApprovalId = '';
    let terminalCode = '';
    let terminalMessage = '';
    let settleAbort;
    const aborted = new Promise((resolve) => {
      settleAbort = resolve;
    });
    const abort = (code, message) => {
      if (terminalCode) return;
      terminalCode = code;
      terminalMessage = message;
      try {
        controller.abort(new Error(message));
      } catch {
        // Abort delivery is best effort; the terminal race still fails closed.
      }
      settleAbort(errorOutcome(code, message));
    };
    const callerAbort = () => abort('cancelled', 'The command was cancelled.');
    callerSignal?.addEventListener?.('abort', callerAbort, { once: true });
    // A deadline that lands while the human is still deciding is an approval
    // timeout, which the model should relay as such rather than as a failure.
    const timer = setTimeout(
      () => (pendingApprovalId
        ? abort('approval_timeout', APPROVAL_TIMEOUT_MESSAGE)
        : abort('deadline_exceeded', 'The command exceeded its execution deadline.')),
      Math.max(1, deadlineAt - Number(now())),
    );
    let approvalTimer = null;

    // Page state after a mutating action. It never fails the action: whatever
    // goes wrong is reported as snapshot_error next to the action's own status.
    async function collectPostActionState({ action: performed, value: performedValue }) {
      const canSettle = typeof adapter.settle === 'function';
      const canSnapshot = adapter.contract.actions.includes('browser_snapshot');
      if (!canSettle && !canSnapshot) return {};
      const state = {};
      const budgetMs = () => deadlineAt - Number(now()) - POST_ACTION_DEADLINE_MARGIN_MS;
      if (budgetMs() < POST_ACTION_MIN_BUDGET_MS) {
        return canSnapshot ? { snapshot_error: 'deadline_near' } : {};
      }

      let settled = null;
      const alreadyOpen = performedValue?.status === 'already-open';
      if (canSettle && !alreadyOpen) {
        try {
          settled = await adapter.settle({
            scope,
            signal: controller.signal,
            mode: 'dom',
            timeoutMs: Math.max(1, Math.min(POST_ACTION_SETTLE_MS, budgetMs())),
          }) || null;
        } catch {
          settled = null;
        }
      }
      if (controller.signal.aborted) return state;

      const navigated = performedValue?.navigated === true || settled?.navigated === true;
      let pageUrl = compact(settled?.url || performedValue?.url, 2_000);
      let pageTitle = compact(settled?.title || performedValue?.title, 500);
      if (canSettle || typeof performedValue?.navigated === 'boolean') state.navigated = navigated;
      if (settled?.timedOut === true || performedValue?.timedOut === true) state.timedOut = true;
      if (!canSnapshot) {
        if (pageUrl) state.url = safeResultUrl(pageUrl);
        if (pageTitle) state.title = safeResultTitle(pageTitle);
        return state;
      }

      if (!pageUrl && typeof adapter.inspect === 'function') {
        try {
          pageUrl = compact((await adapter.inspect({
            tabId: scope.tabId, frameId: scope.frameId, signal: controller.signal, light: true,
          }))?.currentUrl, 2_000);
        } catch {
          pageUrl = '';
        }
      }
      const allowLocalDocuments = Boolean(context?.allowLocalDocuments ?? context?.settings?.allowLocalDocuments);
      if (!pageUrl) {
        state.snapshot_error = 'page_unavailable';
      } else if (classifyBrowserControlAction({
        action: 'browser_snapshot', currentUrl: pageUrl, allowLocalDocuments,
      }).risk === BROWSER_CONTROL_RISKS.BLOCKED) {
        // Same gate as browser_snapshot: a restricted page is never read.
        state.snapshot_error = 'restricted_page';
        pageUrl = pageOrigin(pageUrl);
        pageTitle = '';
      }
      if (pageUrl) state.url = safeResultUrl(pageUrl);
      if (pageTitle) state.title = safeResultTitle(pageTitle);
      if (state.snapshot_error) {
        if (navigated) refs.invalidateTab(scope.tabId);
        return state;
      }

      try {
        if (navigated) refs.invalidateTab(scope.tabId);
        const generation = await settledDocumentGeneration(navigated);
        const snapshotScope = { ...scope, documentGeneration: generation };
        const pending = adapter.execute('browser_snapshot', { full: false }, {
          signal: controller.signal,
          scope: snapshotScope,
          target: null,
          destination: null,
          deadlineAt,
          leasedTabIds: [...ownedTabs],
          ownedTabIds: [...controllerOwnedTabs],
          currentWindowId: Number(currentWindowId) || null,
        });
        pending.catch(() => {});
        const raw = await withTimeout(pending, budgetMs());
        if (controller.signal.aborted) return state;
        if (raw === TIMED_OUT) {
          state.snapshot_error = 'snapshot_timeout';
          return state;
        }
        // The generation may have moved while the snapshot ran; refs must be
        // minted under the one the next command will carry.
        const mintGeneration = readDocumentGeneration(generation);
        const minted = refs.replace({
          ...scope,
          documentGeneration: mintGeneration,
          nodes: Array.isArray(raw?.nodes) ? raw.nodes : [],
        });
        if (!minted.ok) {
          state.snapshot_error = 'ref_bind_failed';
          return state;
        }
        const snapshot = safeSnapshotResult(raw, minted, { maxChars: SNAPSHOT_VIEW_BUDGETS.postAction });
        state.snapshot = {
          text: snapshot.text,
          refs: snapshot.refs,
          truncated: snapshot.truncated,
          element_count: snapshot.element_count,
        };
      } catch (error) {
        if (controller.signal.aborted) return state;
        state.snapshot_error = ADAPTER_ERROR_CODES.has(error?.code) ? error.code : 'snapshot_failed';
      }
      return state;
    }

    function readDocumentGeneration(fallback) {
      if (typeof currentDocumentGeneration !== 'function') return fallback;
      try {
        const value = Number(currentDocumentGeneration(scope.tabId, scope.frameId));
        return Number.isInteger(value) && value >= 1 ? value : fallback;
      } catch {
        return fallback;
      }
    }

    // The worker bumps the document generation from tabs.onUpdated and from the
    // content script's document-ready message. After a navigation, wait for
    // those to land and settle so refs are minted under the generation the
    // next command will use. If it never moves, the current value stands.
    async function settledDocumentGeneration(expectChange) {
      const from = scope.documentGeneration;
      if (typeof currentDocumentGeneration !== 'function') return from;
      let current = readDocumentGeneration(from);
      if (current === from && !expectChange) return current;
      for (let poll = 0; poll < GENERATION_MAX_POLLS && !controller.signal.aborted; poll += 1) {
        await new Promise((resolve) => { setTimeout(resolve, GENERATION_POLL_MS); });
        const next = readDocumentGeneration(from);
        if (next === current && current !== from) return current;
        current = next;
      }
      return current;
    }

    const operation = (async () => {
      let target = null;
      let destination = null;
      if (['browser_click', 'browser_drag', 'browser_fill', 'browser_hover', 'browser_scroll_to', 'browser_select', 'browser_type'].includes(action) && args.ref) {
        const resolved = refs.resolve({ ...scope, ref: args.ref });
        if (!resolved.ok) return errorOutcome(resolved.error, 'The target ref is not valid for this document.');
        target = resolved.target;
      }
      if (action === 'browser_screenshot' && args.ref) {
        const resolved = refs.resolve({ ...scope, ref: args.ref });
        if (!resolved.ok) return errorOutcome(resolved.error, 'The screenshot target ref is not valid for this document.');
        target = resolved.target;
      }
      if (action === 'browser_drag') {
        const resolved = refs.resolve({ ...scope, ref: args.to_ref });
        if (!resolved.ok) return errorOutcome(resolved.error, 'The drag destination ref is not valid for this document.');
        destination = resolved.target;
      }
      if (['browser_drag', 'browser_fill', 'browser_hover', 'browser_scroll_to', 'browser_select', 'browser_type'].includes(action) && !target) {
        return errorOutcome('invalid_ref', 'This action requires an exact target ref.');
      }
      if (action === 'browser_click' && !target && !(Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y)))) {
        return errorOutcome('invalid_ref', 'Click requires an exact target ref or approved viewport coordinates.');
      }

      let pageState = {};
      let waitedForApproval = false;
      if (typeof adapter.inspect === 'function' && [
        'browser_back', 'browser_click', 'browser_drag', 'browser_fill', 'browser_hover', 'browser_navigate', 'browser_press',
        'browser_screenshot', 'browser_scroll', 'browser_scroll_to', 'browser_select', 'browser_snapshot', 'browser_type',
        'browser_console', 'browser_network_requests', 'browser_response_body', 'browser_pdf', 'browser_upload',
        'browser_evaluate', 'browser_cdp', 'browser_dialog',
      ].includes(action)) {
        pageState = await adapter.inspect({
          tabId: scope.tabId,
          frameId: scope.frameId,
          signal: controller.signal,
          ...(URL_ONLY_PROBE_ACTIONS.has(action) ? { light: true } : {}),
        }) || {};
      }
      if (controller.signal.aborted) return errorOutcome(terminalCode || 'cancelled', terminalMessage || 'The command was cancelled.');

      const policy = classifyBrowserControlAction({
        action,
        arguments: args,
        target: target || {},
        currentUrl: pageState.currentUrl,
        hasUnsavedContent: pageState.hasUnsavedContent === true,
        developerMode: boundedDeveloperMode,
        allowLocalDocuments: Boolean(context?.allowLocalDocuments ?? context?.settings?.allowLocalDocuments),
      });
      if (policy.risk === BROWSER_CONTROL_RISKS.BLOCKED) {
        return errorOutcome('sensitive_action_blocked', policy.reason || 'This action is blocked.');
      }
      if (policy.risk === BROWSER_CONTROL_RISKS.APPROVAL) {
        const binding = action === 'browser_upload' ? compact(args.artifact_id, 200) : '';
        const approval = {
          approvalId: compact(frame.approval_id || frame.command_id, 160),
          approvalNonce: compact(frame.approval_nonce || frame.approval_id || frame.command_id, 160),
          commandId: frame.command_id,
          controllerId: scope.controllerId,
          leaseId: scope.leaseId,
          leaseGeneration: scope.leaseGeneration,
          tabId: scope.tabId,
          documentGeneration: scope.documentGeneration,
          action,
          state: 'paused',
          ...(binding ? { binding } : {}),
        };
        let approvalReason = APPROVAL_MESSAGES[policy.reason] || 'This browser action requires approval.';
        let approvalDetail = '';
        if (action === 'browser_evaluate') {
          const preview = compact(String(args.code ?? args.expression ?? ''), 800);
          approvalReason = `Run this evaluate code on the page?\n\n\`\`\`\n${preview}\n\`\`\``;
          approvalDetail = preview;
        }
        let consumed = approvals.consume(approval);
        if (!consumed.ok) {
          pendingApprovalId = approval.approvalId;
          waitedForApproval = true;
          approvalTimer = setTimeout(
            () => abort('approval_timeout', APPROVAL_TIMEOUT_MESSAGE),
            Math.max(1, Math.min(deadlineAt, startedAt + APPROVAL_WAIT_CAP_MS) - Number(now())),
          );
          const requested = await approvals.request({
            ...approval,
            reason: approvalReason,
            ...(approvalDetail ? { detail: approvalDetail } : {}),
          });
          clearTimeout(approvalTimer);
          approvalTimer = null;
          if (!requested?.ok) {
            return errorOutcome(requested?.error || 'approval_cancelled', 'The approval request was cancelled.');
          }
          if (controller.signal.aborted) {
            approvals.cancelRequest?.(approval.approvalId);
            return errorOutcome(terminalCode || 'cancelled', terminalMessage || 'The command was cancelled.');
          }
          consumed = approvals.consume(approval);
          pendingApprovalId = '';
        }
        if (!consumed.ok) return errorOutcome('approval_required', policy.reason || 'This action requires approval.');
      }

      // One probe per action; only a human approval wait leaves room for the page to change.
      if (waitedForApproval && typeof adapter.inspect === 'function' && APPROVALS_RECHECK_ACTIONS.has(action)) {
        const current = await adapter.inspect({
          tabId: scope.tabId,
          frameId: scope.frameId,
          signal: controller.signal,
        }) || {};
        if (controller.signal.aborted) {
          return errorOutcome(terminalCode || 'cancelled', terminalMessage || 'The command was cancelled.');
        }
        const beforeOrigin = pageOrigin(pageState.currentUrl);
        const currentOrigin = pageOrigin(current.currentUrl);
        if (!beforeOrigin || !currentOrigin || beforeOrigin !== currentOrigin) {
          return errorOutcome('domain_changed', 'The page origin changed before the action could run.');
        }
      }

      // Phase 8 privileged pre-execution gates: raw CDP method policy and
      // approved-artifact download for file uploads.
      let artifact = null;
      if (action === 'browser_cdp') {
        const method = compact(args.method, 200);
        const allowList = boundedCdpPolicy.allow;
        const denyList = boundedCdpPolicy.deny;
        const denied = CDP_DENY_METHODS.has(method)
          || CDP_DENY_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix))
          || denyList.includes(method);
        if (denied || (allowList.length && !allowList.includes(method))) {
          return errorOutcome('cdp_method_denied', `The raw CDP method ${method || 'unknown'} is not permitted.`);
        }
      }
      if (action === 'browser_upload') {
        if (!artifacts) {
          return errorOutcome('artifact_transport_unavailable', 'No one-shot artifact transport is available for file upload.');
        }
        const downloaded = await artifacts.download({ artifactId: compact(args.artifact_id, 200) });
        if (!downloaded.ok) {
          return errorOutcome(downloaded.error, downloaded.message || 'The approved artifact could not be downloaded.');
        }
        artifact = downloaded.artifact;
      }

      const value = await adapter.execute(action, args, {
        signal: controller.signal,
        scope,
        target,
        destination,
        deadlineAt,
        leasedTabIds: [...ownedTabs],
        ownedTabIds: [...controllerOwnedTabs],
        currentWindowId: Number(currentWindowId) || null,
        ...(artifact ? { artifact } : {}),
      });
      if (controller.signal.aborted) return errorOutcome(terminalCode || 'cancelled', terminalMessage || 'The command was cancelled.');

      if (action === 'browser_console') {
        const entries = Array.isArray(value?.entries) ? value.entries : [];
        const safe = entries.slice(0, MAX_CONSOLE_ENTRIES).map((entry) => ({
          type: compact(entry?.type, 40) || 'log',
          text: redactSensitiveText(String(entry?.text ?? '')).slice(0, MAX_CONSOLE_ENTRY_CHARS),
        }));
        return { ok: true, result: { entries: safe, truncated: entries.length > MAX_CONSOLE_ENTRIES } };
      }
      if (action === 'browser_network_requests') {
        if (args.include_bodies === true) {
          return errorOutcome('network_bodies_blocked', 'Network response bodies are never included in metadata reads.');
        }
        const requests = Array.isArray(value?.requests) ? value.requests : [];
        const safe = requests.slice(0, MAX_NETWORK_REQUESTS).map((request) => ({
          requestId: compact(request?.requestId, 120),
          method: compact(request?.method, 20),
          status: Number.isFinite(Number(request?.status)) ? Number(request.status) : null,
          mimeType: compact(request?.mimeType, 120),
          resourceType: compact(request?.resourceType, 60),
          size: Number.isFinite(Number(request?.size)) ? Number(request.size) : null,
          url: safeNetworkUrl(request?.url),
        })).filter((request) => request.requestId || request.url);
        return {
          ok: true,
          result: {
            requests: safe,
            truncated: requests.length > MAX_NETWORK_REQUESTS,
            bodiesIncluded: false,
          },
        };
      }
      if (action === 'browser_response_body') {
        const body = String(value?.body ?? value?.text ?? '');
        const mimeType = compact(value?.mimeType, 120);
        if (!RESPONSE_BODY_MIME_RE.test(mimeType)) {
          return errorOutcome('body_mime_not_allowed', 'This response body MIME type is not eligible for reading.');
        }
        if (body.length > MAX_RESPONSE_BODY_CHARS) {
          return errorOutcome('body_too_large', 'The response body exceeds the bounded read cap.');
        }
        const scanned = redactSensitiveTextWithCount(body);
        if (scanned.count > 0) {
          return errorOutcome('body_contains_secrets', 'The response body contains secrets and was not returned.');
        }
        return { ok: true, result: { mimeType, size: body.length, body: scanned.text, truncated: false } };
      }
      if (action === 'browser_pdf') {
        if (!artifacts) {
          return errorOutcome('artifact_transport_unavailable', 'No one-shot artifact transport is available for PDF storage.');
        }
        const bytes = (value?.bytes instanceof Uint8Array || value?.bytes instanceof ArrayBuffer)
          ? value.bytes
          : (value?.base64 ? base64ToBytes(value.base64) : (typeof value?.bytes === 'string' ? value.bytes : null));
        if (!bytes) return errorOutcome('pdf_bytes_missing', 'The PDF action produced no readable bytes.');
        const uploaded = await artifacts.upload({
          name: compact(args.filename || 'page.pdf', 255),
          mimeType: 'application/pdf',
          bytes,
          scope,
          action: 'browser_pdf',
        });
        if (!uploaded.ok) return errorOutcome(uploaded.error, uploaded.message || 'The PDF artifact could not be stored.');
        return { ok: true, result: uploaded.receipt };
      }
      if (action === 'browser_upload') {
        return {
          ok: true,
          result: {
            status: 'uploaded',
            name: artifact?.name || '',
            mimeType: artifact?.mimeType || '',
            size: Number(artifact?.size) || 0,
            checksum: artifact?.checksum || '',
          },
        };
      }
      if (action === 'browser_evaluate') {
        const raw = pickResultValue(value);
        let text = '';
        try {
          text = typeof raw === 'string' ? raw : JSON.stringify(raw);
        } catch {
          text = String(raw);
        }
        const redacted = redactSensitiveText(text);
        const truncated = redacted.length > MAX_RESULT_TEXT;
        return { ok: true, result: { value: redacted.slice(0, MAX_RESULT_TEXT), truncated } };
      }
      if (action === 'browser_cdp') {
        const raw = pickResultValue(value);
        let text = '';
        try {
          text = typeof raw === 'string' ? raw : JSON.stringify(raw);
        } catch {
          text = String(raw);
        }
        return { ok: true, result: { status: 'cdp-command-sent', value: redactSensitiveText(text).slice(0, MAX_RESULT_TEXT) } };
      }

      if (action === 'browser_snapshot') {
        const full = args.full === true;
        const minted = refs.replace({ ...scope, nodes: Array.isArray(value?.nodes) ? value.nodes : [] });
        if (!minted.ok) return errorOutcome(minted.error, 'Could not bind snapshot refs.');
        // The worker's turn-context snapshot is the only caller that sets
        // snapshotBudget (never a model argument); it asks for the small view.
        const turnView = snapshotBudget === 'turn' && !full;
        return {
          ok: true,
          result: safeSnapshotResult(value, minted, {
            maxChars: turnView
              ? SNAPSHOT_VIEW_BUDGETS.turn
              : (full ? SNAPSHOT_VIEW_BUDGETS.full : SNAPSHOT_VIEW_BUDGETS.snapshot),
            fullText: full,
          }),
        };
      }
      if (action === 'browser_screenshot') {
        const dataUrl = String(value?.dataUrl || '');
        if (!dataUrl.startsWith('data:image/png;base64,') || dataUrl.length > MAX_INLINE_SCREENSHOT_CHARS) {
          return errorOutcome('screenshot_too_large', 'The screenshot exceeds the inline Phase 6 transport cap.');
        }
      }
      if (action === 'browser_navigate' || action === 'browser_back') refs.invalidateTab(scope.tabId);
      if (POST_ACTION_ACTIONS.has(action)) {
        const state = await collectPostActionState({ action, value });
        return { ok: true, result: { ...sanitizedActionResult(action, value), ...state } };
      }
      if (action === 'browser_tabs') {
        const filtered = { tabs: Array.isArray(value?.tabs) ? value.tabs.filter((tab) => ownedTabs.has(Number(tab?.id))) : [] };
        return { ok: true, result: sanitizedActionResult(action, filtered) };
      }
      return { ok: true, result: sanitizedActionResult(action, value) };
    })().catch((error) => {
      if (controller.signal.aborted) return errorOutcome(terminalCode || 'cancelled', terminalMessage || 'The command was cancelled.');
      return errorOutcome(
        ADAPTER_ERROR_CODES.has(error?.code) ? error.code : 'command_error',
        error?.message || 'The browser action failed.',
      );
    });

    try {
      return await Promise.race([operation, aborted]);
    } finally {
      clearTimeout(timer);
      if (approvalTimer) clearTimeout(approvalTimer);
      if (pendingApprovalId) approvals.cancelRequest?.(pendingApprovalId);
      callerSignal?.removeEventListener?.('abort', callerAbort);
    }
  }

  return { execute };
}
