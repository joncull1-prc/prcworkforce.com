/**
 * Cryptographic helpers.
 *
 * Design rules enforced here:
 *   1. No silent fallbacks. The original draft fell back to btoa(plaintext)
 *      when key import failed, which stores the mobile number in clear text
 *      while the code still reports success. Every failure now throws.
 *   2. Every stored hash is keyed (HMAC). A bare SHA-256 of a mobile number or
 *      a six-character code is reversible by exhaustive search in seconds.
 *   3. Ciphertext is versioned and bound to its row, so a stolen ciphertext
 *      cannot be pasted into another participant's record.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const HEX_KEY = /^[0-9a-f]{64}$/i;

/** Validate a 32-byte key expressed as 64 hex characters. */
export function assertKey(hex, name) {
  if (typeof hex !== 'string' || !HEX_KEY.test(hex)) {
    throw new Error(`${name} is missing or malformed: expected 64 hex characters.`);
  }
  return hex.toLowerCase();
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

// Chunked so a large buffer cannot blow the argument limit of String.fromCharCode.
function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Comparison whose duration does not depend on where two strings first differ. */
export function constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function importHmacKey(keyHex, name) {
  return crypto.subtle.importKey(
    'raw',
    hexToBytes(assertKey(keyHex, name)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/** Keyed hash, hex encoded. Used for token and phone lookup values. */
export async function hmacHex(keyHex, value, keyName = 'key') {
  const key = await importHmacKey(keyHex, keyName);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return bytesToHex(sig);
}

/**
 * Encrypt a mobile number with AES-256-GCM.
 *
 * `aad` binds the ciphertext to the row that owns it. Passing the row's
 * token HMAC means a ciphertext lifted from one row will not decrypt in
 * another, so an attacker with write access cannot redirect a participant's
 * SMS to a number they control.
 */
export async function encryptPhone(plainText, keyHex, aad) {
  const key = await crypto.subtle.importKey(
    'raw', hexToBytes(assertKey(keyHex, 'ENCRYPTION_KEY')),
    { name: 'AES-GCM' }, false, ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(aad) },
    key,
    encoder.encode(plainText),
  );
  const combined = new Uint8Array(iv.length + cipher.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipher), iv.length);
  // Version prefix so the key can be rotated without guessing the format.
  return `v1.${bytesToBase64(combined)}`;
}

/** Decrypt a stored mobile number. Throws on any tampering or key mismatch. */
export async function decryptPhone(stored, keyHex, aad) {
  if (typeof stored !== 'string' || !stored.startsWith('v1.')) {
    throw new Error('Unrecognised ciphertext version.');
  }
  const combined = base64ToBytes(stored.slice(3));
  if (combined.length < 29) throw new Error('Ciphertext too short.');
  const key = await crypto.subtle.importKey(
    'raw', hexToBytes(assertKey(keyHex, 'ENCRYPTION_KEY')),
    { name: 'AES-GCM' }, false, ['decrypt'],
  );
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: combined.subarray(0, 12), additionalData: encoder.encode(aad) },
    key,
    combined.subarray(12),
  );
  return decoder.decode(plain);
}

/**
 * Signed pulse links.
 *
 * The original design let anyone who knew a session UUID post scores for it,
 * and session UUIDs travel by SMS, sit in browser history and leak through the
 * Referer header. A link is now a signature over the session code, the week and
 * an expiry, so a guessed or replayed identifier is worthless.
 *
 * The signature is truncated to 24 hex characters (96 bits). That is far beyond
 * forgeable for a link that expires in days and is rate limited at the edge.
 */
export async function signPulseLink(publicCode, week, expiryEpochMinutes, keyHex) {
  const payload = `pulse.v1|${publicCode}|${week}|${expiryEpochMinutes}`;
  const full = await hmacHex(keyHex, payload, 'LINK_SIGNING_KEY');
  return full.slice(0, 24);
}

export async function verifyPulseLink(publicCode, week, expiryEpochMinutes, signature, keyHex, nowMs = Date.now()) {
  if (typeof signature !== 'string' || signature.length !== 24) return false;
  if (!Number.isInteger(expiryEpochMinutes) || expiryEpochMinutes <= 0) return false;
  if (expiryEpochMinutes * 60_000 < nowMs) return false;
  const expected = await signPulseLink(publicCode, week, expiryEpochMinutes, keyHex);
  return constantTimeEquals(expected, signature);
}

/**
 * Twilio inbound-webhook signature (X-Twilio-Signature): HMAC-SHA1 over the
 * full request URL with every POST parameter appended in key order, base64.
 * Without this check anyone can POST a forged "STOP" or "DELETE" for any number.
 */
export async function verifyTwilioSignature(authToken, url, params, header) {
  if (typeof header !== 'string' || header.length === 0) return false;
  let data = url;
  for (const key of Object.keys(params).sort()) data += key + params[key];
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(authToken), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return constantTimeEquals(bytesToBase64(new Uint8Array(sig)), header);
}

/** Crockford base32, excluding I, L, O and U so printed codes cannot be misread. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function randomCode(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % 32];
  return out;
}

/** Fold the shapes people actually write into the printed alphabet. */
export function normaliseCode(raw) {
  return String(raw)
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/I/g, '1')
    .replace(/L/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V');
}
