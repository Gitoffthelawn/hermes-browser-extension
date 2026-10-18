import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveChromeExecutable } from './e2e-chrome-env.mjs';

function withEnv(values, run) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('CHROME_PATH wins over a Playwright browser cache', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-chrome-env-'));
  try {
    const explicit = path.join(dir, 'my-chrome');
    writeFileSync(explicit, '');
    const cache = path.join(dir, 'cache');
    mkdirSync(path.join(cache, 'chromium-1', 'chrome-linux'), { recursive: true });
    writeFileSync(path.join(cache, 'chromium-1', 'chrome-linux', 'chrome'), '');
    const found = withEnv({ CHROME_PATH: explicit, PLAYWRIGHT_BROWSERS_PATH: cache }, () => resolveChromeExecutable());
    assert.equal(found, explicit);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a Playwright browser cache is used when CHROME_PATH is unset, newest build first', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-chrome-env-'));
  try {
    for (const build of ['chromium-1100', 'chromium-1200']) {
      mkdirSync(path.join(dir, build, 'chrome-linux'), { recursive: true });
      writeFileSync(path.join(dir, build, 'chrome-linux', 'chrome'), '');
    }
    const found = withEnv({ CHROME_PATH: undefined, PLAYWRIGHT_BROWSERS_PATH: dir }, () => resolveChromeExecutable());
    assert.equal(found, path.join(dir, 'chromium-1200', 'chrome-linux', 'chrome'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extra candidates are tried after CHROME_PATH', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-chrome-env-'));
  try {
    const extra = path.join(dir, 'edge');
    writeFileSync(extra, '');
    const found = withEnv({ CHROME_PATH: path.join(dir, 'missing') }, () => resolveChromeExecutable([extra]));
    assert.equal(found, extra);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
