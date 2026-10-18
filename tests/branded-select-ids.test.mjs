import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { mountBrandedSelect } from '../extension/lib/branded-select.mjs';

function withDom(markup, run) {
  const dom = new JSDOM(`<!doctype html><body>${markup}</body>`);
  const keys = ['document', 'MutationObserver', 'Event', 'window'];
  const originals = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
  Object.assign(globalThis, {
    document: dom.window.document,
    MutationObserver: dom.window.MutationObserver,
    Event: dom.window.Event,
    window: dom.window,
  });
  try {
    return run(dom.window.document);
  } finally {
    dom.window.close();
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}

test('selects without an id get unique button and list ids', () => {
  withDom('<select aria-label="One"><option>a</option></select><select aria-label="Two"><option>b</option></select>', (document) => {
    for (const select of document.querySelectorAll('select')) mountBrandedSelect(select);
    const ids = [...document.querySelectorAll('[id]')].map((node) => node.id);
    assert.equal(ids.length, 4);
    assert.equal(new Set(ids).size, 4, `duplicate ids: ${ids.join(', ')}`);
    for (const button of document.querySelectorAll('.branded-select-button')) {
      const list = document.getElementById(button.getAttribute('aria-controls'));
      assert.ok(list?.classList.contains('branded-select-list'), "aria-controls points at the select's own list");
      assert.equal(button.nextElementSibling, list);
    }
  });
});

test('selects with an id keep their derived ids and label association', () => {
  withDom('<label for="mode">Mode</label><select id="mode"><option>a</option></select>', (document) => {
    mountBrandedSelect(document.getElementById('mode'));
    assert.ok(document.getElementById('modeButton'));
    assert.ok(document.getElementById('modeList'));
    assert.equal(document.querySelector('label').htmlFor, 'modeButton');
  });
});
