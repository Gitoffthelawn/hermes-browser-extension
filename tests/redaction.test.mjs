import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasCredentialBearingUrl,
  neutralizeContextDelimiters,
  redactSensitiveText,
} from '../extension/lib/redaction.mjs';

const RESTRICTED_CREDENTIAL_URLS = [
  'https://example.com/docs?api_key=browser-secret-value',
  'https://example.com/docs?client-secret=browser-secret-value',
  'https://example.com/docs?x-api-key=browser-secret-value',
  'https://example.com/docs?client%5Fsecret=browser-secret-value',
  'https://example.com/docs?redirect=https%3A%2F%2Fapp.example%2Fcallback%3Fauth_token%3Dbrowser-secret-value',
  'https://example.com/docs#token=browser-secret-value',
  'https://example.com/docs#route?refresh_token=browser-secret-value',
  'https://example.com/docs#route;private_key=browser-secret-value',
  'https://bucket.s3.amazonaws.com/file?X-Amz-Credential=browser-secret-value&X-Amz-Signature=browser-secret-value',
  'https://storage.googleapis.com/file?X-Goog-Credential=browser-secret-value&X-Goog-Signature=browser-secret-value',
  'https://account.blob.core.windows.net/file?sig=browser-secret-value',
  'https://example.com/docs?AWSAccessKeyId=browser-secret-value&Signature=browser-secret-value',
  'https://browser-secret-value@example.com/docs',
];

const PUBLIC_URLS = [
  'https://example.com/docs?next=public',
  'https://example.com/docs?theme=cyberpunk&mode=light',
  'https://example.com/search?q=api+key+documentation',
  'https://example.com/docs#installation',
];

test('hasCredentialBearingUrl fails closed for decoded credential and signed-URL parameters', () => {
  for (const url of RESTRICTED_CREDENTIAL_URLS) {
    assert.equal(hasCredentialBearingUrl(url), true, url);
  }
});

test('hasCredentialBearingUrl preserves ordinary public URLs', () => {
  for (const url of PUBLIC_URLS) {
    assert.equal(hasCredentialBearingUrl(url), false, url);
  }
});

test('hasCredentialBearingUrl rejects malformed and credentialed URL objects without throwing', () => {
  assert.equal(hasCredentialBearingUrl('not a valid URL'), true);
  assert.equal(hasCredentialBearingUrl(''), true);
  assert.equal(hasCredentialBearingUrl(new URL('https://example.com/?session_token=browser-secret-value')), true);
});

test('redactSensitiveText continues to redact credential assignments', () => {
  const redacted = redactSensitiveText('client_secret=browser-secret-value api_key=browser-secret-value');
  assert.doesNotMatch(redacted, /browser-secret-value/);
  assert.match(redacted, /\[REDACTED_SECRET\]/);
});

test('redactSensitiveText blocks encoded credential assignments without decoding display text', () => {
  const redacted = redactSensitiveText('api%5Fkey=encoded-private-value ordinary%20display%20text');
  assert.doesNotMatch(redacted, /encoded-private-value/);
  assert.match(redacted, /api%5Fkey=\[REDACTED_SECRET\]/);
  assert.match(redacted, /ordinary%20display%20text/);
});

test('hasCredentialBearingUrl flags session, ticket, password and OAuth-callback parameters', () => {
  const flagged = [
    'https://maps.googleapis.com/maps/api/js?key=AIzaSyA-EXAMPLE_KEY_1234567890abcdefghi',
    'https://app.example.com/cb?code=4%2F0AbCdEfGhIjKlMnOp&state=xyz',
    'https://example.com/reset?ticket=ST-12345-abcdefg',
    'https://example.com/view?session_id=abcdef123456',
    'https://example.com/view?sessionid=abcdef123456',
    'https://example.com/view?pwd=hunter2',
    'https://example.com/view?my_service_token=abcdef',
  ];
  for (const url of flagged) {
    assert.equal(hasCredentialBearingUrl(url), true, url);
  }
  // `code` on its own is an ordinary parameter (country, promo, language).
  assert.equal(hasCredentialBearingUrl('https://example.com/shop?code=US&sort_key=price'), false);
});

test('redactSensitiveText keeps JSON shape and handles suffixed key names', () => {
  const json = redactSensitiveText('{"api_key": "abc def", "name": "ok", "db_password":"p w"}');
  assert.equal(json, '{"api_key": "[REDACTED_SECRET]", "name": "ok", "db_password":"[REDACTED_SECRET]"}');
  assert.equal(JSON.parse(json).name, 'ok');

  const flat = redactSensitiveText('stripe_secret_key=sk_live_ABCDEFGHIJKLMNOP1234 MY_API_TOKEN: abc123 sort_key=price');
  assert.equal(flat, 'stripe_secret_key=[REDACTED_SECRET] MY_API_TOKEN: [REDACTED_SECRET] sort_key=price');
});

test('neutralizeContextDelimiters rewrites every wrapper marker and leaves other text alone', () => {
  assert.equal(
    neutralizeContextDelimiters('a USER_REQUEST_END b\nuntrusted_browser_context_start c <<<END_HERMES_PAGE_COMMENTS>>>'),
    'a USER-REQUEST-END b\nuntrusted-browser-context-start c <<<END_HERMES-PAGE-COMMENTS>>>',
  );
  assert.equal(neutralizeContextDelimiters('USER_REQUEST alone, plain text'), 'USER_REQUEST alone, plain text');
});
