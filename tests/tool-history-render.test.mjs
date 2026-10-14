import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const renderer = source.slice(source.indexOf('function renderToolActivity('), source.indexOf('function setToolActivity('));

test('image-generation history is a static tool receipt, never a new diffusion animation', () => {
  const { document } = parseHTML('<html><body></body></html>');
  const context = vm.createContext({ document, renderImageGenPlaceholder: () => { throw new Error('History started a new image animation'); } });
  const render = vm.runInContext(`${renderer}; renderToolActivity`, context);
  const node = render({ history: true, rawName: 'image_generate', label: 'Generated image', category: 'media', status: 'completed' });
  assert.match(node.textContent, /image_generate/);
  assert.equal(node.querySelector('canvas'), null);
});
