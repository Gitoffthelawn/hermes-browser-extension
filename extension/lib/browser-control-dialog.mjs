import { validateBrowserControlUrl } from './browser-control-safety.mjs';

// Presentation and explicit scope intent only; the worker owns the transaction.
export function createBrowserControlDialog({ dialog, launcher, closeButton, focusFallback, label, refresh,
  scopeInput, tabsField, tabsList, applyButton, scopeHint, loadTabs, getScope, getSelectedTabIds,
  applyScope, translate = (key) => key,
}) {
  let enabled = false;
  let backdropPressed = false;
  let canChangeScope = false;
  let applying = false;
  let loadingTabs = false;
  let loadGeneration = 0;
  let draftTabIds = new Set();
  let feedbackKey = '';
  let flairPending = false;
  let previousState = 'off';

  const playFlair = () => {
    if (!flairPending || !dialog.open || !dialog.classList.contains('is-pointer-open')) return;
    dialog.classList.add('is-energized');
    flairPending = false;
  };
  const syncScopeDraft = () => {
    if (!scopeInput) return;
    const multiTab = scopeInput.value !== 'this-tab';
    scopeInput.disabled = !canChangeScope || applying || loadingTabs;
    scopeInput.brandedSelect?.sync();
    tabsField.hidden = !multiTab;
    for (const box of tabsList.querySelectorAll('input')) {
      box.disabled = scopeInput.disabled || (!box.checked && draftTabIds.size >= 32);
    }
    applyButton.disabled = scopeInput.disabled || (multiTab && draftTabIds.size === 0);
    applyButton.setAttribute('aria-busy', String(applying));
    scopeHint.textContent = translate(!canChangeScope ? 'browser_control.scope_busy'
      : feedbackKey || (multiTab && !draftTabIds.size ? 'browser_control.scope_selection_required' : 'browser_control.scope_locked'));
  };
  const resetScopeDraft = async () => {
    if (!scopeInput) return;
    const generation = ++loadGeneration;
    scopeInput.value = getScope();
    draftTabIds = new Set(getSelectedTabIds());
    feedbackKey = '';
    loadingTabs = true;
    tabsList.replaceChildren();
    syncScopeDraft();
    try {
      const tabs = (await loadTabs()).filter((tab) => validateBrowserControlUrl(tab.url, { allowLocalFiles: true }).ok);
      if (generation !== loadGeneration || !dialog.open) return;
      const offered = new Set(tabs.map((tab) => tab.id));
      draftTabIds = new Set([...draftTabIds].filter((id) => offered.has(id)));
      for (const tab of tabs) {
        const option = dialog.ownerDocument.createElement('label');
        option.className = 'browser-control-tab-option';
        const checkbox = dialog.ownerDocument.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = draftTabIds.has(tab.id);
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) draftTabIds.add(tab.id); else draftTabIds.delete(tab.id);
          feedbackKey = '';
          syncScopeDraft();
        });
        const title = dialog.ownerDocument.createElement('span');
        title.textContent = tab.title || tab.url;
        title.title = title.textContent;
        option.append(checkbox, title);
        tabsList.append(option);
      }
      if (!tabs.length) {
        const empty = dialog.ownerDocument.createElement('span');
        empty.textContent = translate('ui.no.matching.tabs');
        tabsList.append(empty);
      }
    } catch {
      if (generation === loadGeneration) feedbackKey = 'browser_control.scope_failed';
    } finally {
      if (generation === loadGeneration) { loadingTabs = false; syncScopeDraft(); }
    }
  };
  scopeInput?.addEventListener('change', () => { feedbackKey = ''; syncScopeDraft(); });
  applyButton?.addEventListener('click', async () => {
    if (applyButton.disabled || applying || !canChangeScope) return;
    applying = true;
    syncScopeDraft();
    try {
      await applyScope({ scope: scopeInput.value, tabIds: [...draftTabIds] });
      feedbackKey = 'browser_control.scope_updated';
    } catch (error) {
      feedbackKey = error?.code === 'controller_busy' ? 'browser_control.scope_busy' : 'browser_control.scope_failed';
    } finally {
      applying = false;
      syncScopeDraft();
    }
  });
  dialog.addEventListener('animationend', (event) => {
    if (event.animationName === 'control-flare') dialog.classList.remove('is-energized');
  });

  const restoreFocus = () => {
    launcher.setAttribute('aria-expanded', 'false');
    const target = launcher.hidden ? focusFallback : launcher;
    target?.focus({ preventScroll: true });
  };
  const tooltip = dialog.querySelector('#browserControlTooltip');
  let helpTarget = null;
  const hideHelp = () => {
    if (tooltip?.matches(':popover-open')) tooltip.hidePopover();
    helpTarget?.removeAttribute('aria-describedby');
    helpTarget = null;
  };
  const showHelp = (button) => {
    if (!tooltip || !dialog.open || !button?.dataset.help) return;
    helpTarget = button;
    tooltip.textContent = button.dataset.help;
    if (!tooltip.matches(':popover-open')) tooltip.showPopover();
    // A control named by its help text already says it; describing it with the same text would repeat it.
    if (!button.hasAttribute('data-help-as-name')) button.setAttribute('aria-describedby', tooltip.id);
    // Anchor option help to the picker, so a lower option's explanation cannot
    // cover the choices above it while the user moves through the menu.
    const picker = button.getAttribute('role') === 'option' ? button.closest('.branded-select') : null;
    const target = (picker || button).getBoundingClientRect();
    const rect = tooltip.getBoundingClientRect();
    const edge = 16;
    const left = Math.max(edge, Math.min(target.left + target.width / 2 - rect.width / 2, window.innerWidth - rect.width - edge));
    const above = target.top - rect.height - 10;
    const top = above >= edge ? above : Math.min(target.bottom + 10, window.innerHeight - rect.height - edge);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.max(edge, top)}px`;
  };
  const helpButton = (target) => target?.closest?.('[data-control-help]');
  dialog.addEventListener('pointerover', (event) => {
    const button = helpButton(event.target);
    if (button && !button.contains(event.relatedTarget)) showHelp(button);
  });
  dialog.addEventListener('pointerout', (event) => {
    const button = helpButton(event.target);
    if (button && !button.contains(event.relatedTarget)) hideHelp();
  });
  dialog.addEventListener('focusin', (event) => showHelp(helpButton(event.target)));
  dialog.addEventListener('focusout', hideHelp);
  dialog.addEventListener('scroll', hideHelp);
  dialog.addEventListener('click', (event) => { if (helpButton(event.target)) hideHelp(); });
  const close = () => {
    hideHelp();
    if (dialog.open) dialog.close();
  };
  const outsideCard = (event) => {
    const rect = dialog.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right
      || event.clientY < rect.top || event.clientY > rect.bottom;
  };

  launcher.addEventListener('click', (event) => {
    if (!enabled || dialog.open) return;
    dialog.classList.toggle('is-pointer-open', event.detail > 0);
    dialog.showModal();
    playFlair();
    void resetScopeDraft();
    launcher.setAttribute('aria-expanded', 'true');
    // Refresh authority without activating another tab or blocking the dialog.
    Promise.resolve().then(refresh).catch(() => {});
  });
  closeButton.addEventListener('click', close);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener('close', () => {
    loadGeneration += 1;
    dialog.classList.remove('is-energized');
    hideHelp(); restoreFocus();
  });
  dialog.addEventListener('pointerdown', (event) => {
    backdropPressed = event.target === dialog && outsideCard(event);
  });
  dialog.addEventListener('click', (event) => {
    if (backdropPressed && event.target === dialog && outsideCard(event)) close();
    backdropPressed = false;
  });

  return {
    close,
    render({ enabled: nextEnabled, view, help = {}, canChangeScope: nextCanChangeScope = false }) {
      launcher.classList.toggle('just-enabled', nextEnabled && !enabled);
      if (nextEnabled && (!enabled || (view.state === 'ready' && previousState !== 'ready' && previousState !== 'active'))) flairPending = true;
      if (!nextEnabled) flairPending = false;
      previousState = view.state;
      enabled = nextEnabled;
      canChangeScope = nextCanChangeScope;
      if (!dialog.open && scopeInput) scopeInput.value = getScope();
      syncScopeDraft();
      playFlair();
      dialog.dataset.state = view.state;
      dialog.dataset.tone = view.tone;
      for (const button of dialog.querySelectorAll('[data-control-help]')) {
        const key = button.dataset.controlHelp;
        const text = help[key] || (key.startsWith('scope_') ? translate(`browser_control.help_${key}`) : '');
        if (text !== button.dataset.help) {
          button.dataset.help = text;
          // The status light is named by its help text (the full status), so the text is its name, not a description.
          if (button.hasAttribute('data-help-as-name')) button.setAttribute('aria-label', text);
          else button.setAttribute('aria-description', text);
          if (helpTarget === button) showHelp(button);
        }
      }
      launcher.hidden = !enabled;
      launcher.dataset.state = view.state;
      launcher.dataset.tone = view.tone;
      launcher.setAttribute('aria-label', `${label()}: ${view.title}`);
      launcher.title = `${label()}: ${view.title}\n${view.detail}`;
      if (!enabled) close();
    },
  };
}
