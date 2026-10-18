/**
 * Shared secret redaction helpers for browser-context surfaces.
 */
import { isSensitiveAssignmentKey, redactSensitiveTextWithCount } from './content-extraction-core.mjs';

const CREDENTIAL_URL_PARAMETER_NAMES = new Set([
  'apikey',
  'xapikey',
  'accesstoken',
  'authtoken',
  'refreshtoken',
  'sessiontoken',
  'idtoken',
  'csrftoken',
  'bearertoken',
  'token',
  'clientsecret',
  'password',
  'passwd',
  'secret',
  'privatekey',
  'awssecretaccesskey',
  'secretaccesskey',
  'awsaccesskeyid',
  'xamzcredential',
  'xamzsignature',
  'xamzsecuritytoken',
  'xgoogcredential',
  'xgoogsignature',
  'googleaccessid',
  'credential',
  'signature',
  'sig',
  'pwd',
  'passphrase',
  'sessionid',
  'sessid',
  'phpsessid',
  'jsessionid',
  'ticket',
  'apisecret',
  'accesskey',
  'secretkey',
]);
// OAuth callbacks carry a one-time `code` next to `state`. `code` alone is far
// too common (country, promo and language codes) to treat as a credential.
const OAUTH_CALLBACK_PARAMETER_NAMES = ['code', 'state'];

function decodedUrlLayers(value = '') {
  const layers = [String(value || '')];
  for (let index = 0; index < 3; index += 1) {
    const current = layers[layers.length - 1].replace(/\+/g, ' ');
    let decoded;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      decoded = current.replace(/%([0-9a-fA-F]{2})/g, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
    }
    if (decoded === layers[layers.length - 1]) break;
    layers.push(decoded);
  }
  return layers;
}

function normalizedCredentialParameterName(value = '') {
  const layers = decodedUrlLayers(value);
  return layers[layers.length - 1].trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function credentialParameterNames(value = '') {
  const names = new Set();
  for (const layer of decodedUrlLayers(value)) {
    const assignment = /(?:^|[?&#;\s])([^=?#&;\s]+)\s*=/g;
    let match;
    while ((match = assignment.exec(layer)) !== null) {
      names.add(normalizedCredentialParameterName(match[1]));
    }
  }
  return names;
}

const CONTEXT_DELIMITER_RE = /(?:USER_REQUEST|UNTRUSTED_BROWSER_CONTEXT)_(?:START|END)|HERMES_PAGE_COMMENTS/gi;

/**
 * Page-derived text is placed between fixed delimiter lines
 * (USER_REQUEST_START/END, UNTRUSTED_BROWSER_CONTEXT_START/END, the page
 * comment wrapper). Page text that spells one of those markers could close the
 * untrusted block early and forge the section after it, so every marker is
 * rewritten (case-insensitively, wherever it appears) into a form no parser or
 * reader treats as a delimiter. Ordinary text is returned unchanged.
 */
export function neutralizeContextDelimiters(value = '') {
  return String(value ?? '').replace(CONTEXT_DELIMITER_RE, (marker) => marker.replaceAll('_', '-'));
}

export function redactSensitiveText(value = '') {
  return redactSensitiveTextWithCount(value).text;
}

/**
 * Detect credential-bearing URL metadata before a tab URL crosses a prompt,
 * receipt, diagnostic, persistence, or transport boundary.
 */
export function hasCredentialBearingUrl(value = '') {
  let parsed;
  try {
    parsed = value instanceof URL ? value : new URL(String(value || ''));
  } catch {
    return true;
  }

  if (parsed.username || parsed.password) return true;
  const names = new Set([
    ...credentialParameterNames(parsed.search),
    ...credentialParameterNames(parsed.hash),
  ]);
  if ([...names].some((name) => CREDENTIAL_URL_PARAMETER_NAMES.has(name) || isSensitiveAssignmentKey(name))) return true;
  if (OAUTH_CALLBACK_PARAMETER_NAMES.every((name) => names.has(name))) return true;
  // A recognisable secret shape (for example `?key=AIza...`) is credential
  // bearing whatever the parameter is called.
  return [parsed.search, parsed.hash].some((part) => (
    decodedUrlLayers(part).some((layer) => redactSensitiveTextWithCount(layer).count > 0)
  ));
}
