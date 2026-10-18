import assert from 'node:assert/strict';
import test from 'node:test';

import { artifactOpenOnComputerPolicy } from '../extension/lib/artifact-actions.mjs';

test('more launcher and installer formats are never handed to the OS from Open on computer', () => {
  for (const name of ['setup.msix', 'tool.pif', 'run.vb', 'page.chm', 'launch.jnlp', 'lib.dylib', 'start.pyw', 'a.cab', 'x.mjs', 'c.terminal']) {
    assert.equal(artifactOpenOnComputerPolicy(name).blocked, true, name);
  }
  for (const name of ['report.pdf', 'page.html', 'diagram.svg', 'sheet.xlsx', 'notes.txt']) {
    assert.equal(artifactOpenOnComputerPolicy(name).blocked, false, name);
  }
});
