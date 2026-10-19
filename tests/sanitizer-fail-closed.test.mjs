import { test } from 'node:test';
import assert from 'node:assert/strict';

// No DOM is installed in this process, which is the situation inside the MV3
// service worker. The sanitizer must return inert text, never live markup.
assert.equal(typeof globalThis.window, 'undefined');

const { renderMarkdownSafe, sanitizeHtml } = await import('../extension/lib/sanitizer.mjs');

test('sanitizeHtml without a DOM escapes instead of returning the input', () => {
  const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const result = sanitizeHtml(hostile);
  assert.doesNotMatch(result, /<[a-z]/i);
  assert.match(result, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test('renderMarkdownSafe without a DOM escapes the source instead of returning raw renderer HTML', () => {
  const result = renderMarkdownSafe('[click](javascript:alert(1)) <b onmouseover=alert(1)>x</b>');
  assert.doesNotMatch(result, /<[a-z]/i);
  assert.equal(renderMarkdownSafe(''), '');
});
