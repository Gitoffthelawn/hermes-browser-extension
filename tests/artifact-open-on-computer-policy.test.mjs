import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { artifactOpenOnComputerPolicy } from '../extension/lib/artifact-actions.mjs';
import english from '../extension/lib/locales/en.mjs';

const appSource = readFileSync(new URL('../extension/app.js', import.meta.url), 'utf8');

test('programs, scripts and extensionless files are never handed to the OS handler', () => {
  for (const name of ['setup.exe', '/tmp/run.sh', 'C:\\Users\\me\\payload.PS1', 'installer.msi', 'macro.js', 'app.dmg', 'Makefile', 'notes.txt.lnk']) {
    assert.equal(artifactOpenOnComputerPolicy(name).blocked, true, name);
  }
});

test('ordinary documents are allowed but still go through the confirmation', () => {
  for (const name of ['report.pdf', '/home/user/out/chart.png', 'data.csv', 'notes.md']) {
    const policy = artifactOpenOnComputerPolicy(name);
    assert.equal(policy.blocked, false, name);
    assert.ok(policy.name, name);
  }
});

test('full view confirms in extension UI before downloading and opening a model-named file', () => {
  const start = appSource.indexOf('async function openArtifactCardOnComputer(plan)');
  assert.ok(start > 0);
  const body = appSource.slice(start, appSource.indexOf('async function saveArtifactCardFile', start));
  const confirmAt = body.indexOf('confirmFulltabArtifactOpenOnComputer(plan)');
  assert.ok(confirmAt >= 0, 'the open handler must confirm first');
  assert.ok(confirmAt < body.indexOf('downloads.download'), 'confirm before any download starts');
  assert.ok(confirmAt < body.indexOf('downloads.open'), 'confirm before the OS hand-off');
  assert.match(appSource, /artifactOpenOnComputerPolicy\(plan\.source\)/);
  assert.match(appSource, /window\.confirm\(t\('ui\.artifact\.open_on_computer\.confirm'/);
  assert.match(english['ui.artifact.open_on_computer.confirm'], /\{name\}/);
  assert.match(english['ui.artifact.open_on_computer.blocked'], /\{name\}/);
});
