import assert from 'node:assert/strict';
import test from 'node:test';

import { hasCredentialBearingUrl, redactSensitiveText } from '../extension/lib/redaction.mjs';

test('an unquoted value does not swallow the bracket that closes its JSON object or array', () => {
  assert.equal(redactSensitiveText('{"token": 5}'), '{"token": [REDACTED_SECRET]}');
  assert.equal(
    redactSensitiveText('{"a": {"secret": true}, "b": 1}'),
    '{"a": {"secret": [REDACTED_SECRET]}, "b": 1}',
  );
  assert.equal(redactSensitiveText('[{"token": 123456}]'), '[{"token": [REDACTED_SECRET]}]');
});

test('credentials inside JSON that was itself stored as a string are redacted', () => {
  assert.equal(
    redactSensitiveText('{\\"password\\":\\"hunter2\\",\\"name\\":\\"ok\\"}'),
    '{\\"password\\":\\"[REDACTED_SECRET]\\",\\"name\\":\\"ok\\"}',
  );
  assert.equal(
    redactSensitiveText('log: {\\"db_secret\\": \\"a b c\\"}'),
    'log: {\\"db_secret\\": \\"[REDACTED_SECRET]\\"}',
  );
  assert.equal(redactSensitiveText('{\\"title\\":\\"A token of thanks\\"}'), '{\\"title\\":\\"A token of thanks\\"}');
});

test('code and state only mark a URL as an OAuth callback when the code looks like one', () => {
  // Store locators and promo links carry both words with short values.
  assert.equal(hasCredentialBearingUrl('https://shop.example.com/stores?state=CA&code=US'), false);
  assert.equal(hasCredentialBearingUrl('https://example.com/cart?code=SAVE10&state=open'), false);
  // A real callback carries a long opaque code.
  assert.equal(hasCredentialBearingUrl('https://app.example.com/cb?code=4%2F0AbCdEfGhIjKlMnOp&state=xyz'), true);
  assert.equal(hasCredentialBearingUrl('https://app.example.com/cb?state=abc123&code=a1b2c3d4e5f6a7b8c9d0'), true);
  assert.equal(hasCredentialBearingUrl('https://app.example.com/cb#code=a1b2c3d4e5f6a7b8c9d0&state=s'), true);
});

test('a ticket parameter is a credential only when it looks like a service ticket', () => {
  assert.equal(hasCredentialBearingUrl('https://support.example.com/tickets?ticket=1234'), false);
  assert.equal(hasCredentialBearingUrl('https://support.example.com/tickets?ticket=INC-1042'), false);
  assert.equal(hasCredentialBearingUrl('https://sso.example.com/login?ticket=ST-12345-abcdefg'), true);
  assert.equal(hasCredentialBearingUrl('https://sso.example.com/login?ticket=a1b2c3d4e5f6a7b8c9d0e1f2a3'), true);
});
