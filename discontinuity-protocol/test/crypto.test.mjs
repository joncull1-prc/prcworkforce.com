import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertKey, hmacHex, encryptPhone, decryptPhone, constantTimeEquals,
  signPulseLink, verifyPulseLink, verifyTwilioSignature, randomCode, normaliseCode,
} from '../src/crypto.js';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const NOW = Date.parse('2026-09-06T12:00:00Z');
const FUTURE = Math.floor(NOW / 60000) + 1440;

test('a malformed key is rejected instead of silently accepted', () => {
  assert.throws(() => assertKey('short', 'ENCRYPTION_KEY'), /64 hex characters/);
  assert.throws(() => assertKey(undefined, 'ENCRYPTION_KEY'), /64 hex characters/);
  assert.throws(() => assertKey('z'.repeat(64), 'ENCRYPTION_KEY'), /64 hex characters/);
});

test('encryption round-trips and never falls back to plain text', async () => {
  const cipher = await encryptPhone('+447700900123', KEY_A, 'row-1');
  assert.ok(cipher.startsWith('v1.'));
  assert.ok(!cipher.includes('447700900123'));
  assert.equal(await decryptPhone(cipher, KEY_A, 'row-1'), '+447700900123');
});

test('a bad key throws rather than returning base64 of the number', async () => {
  // The original fallback returned btoa(plaintext) and reported success, which
  // stores the mobile number in clear text while looking fine.
  await assert.rejects(() => encryptPhone('+447700900123', 'nope', 'row-1'));
  const cipher = await encryptPhone('+447700900123', KEY_A, 'row-1');
  await assert.rejects(() => decryptPhone(cipher, KEY_B, 'row-1'));
  await assert.rejects(() => decryptPhone('not-versioned', KEY_A, 'row-1'));
});

test('ciphertext is bound to its row and cannot be moved between records', async () => {
  const cipher = await encryptPhone('+447700900123', KEY_A, 'token-hmac-1');
  await assert.rejects(() => decryptPhone(cipher, KEY_A, 'token-hmac-2'));
});

test('two encryptions of the same number differ', async () => {
  const a = await encryptPhone('+447700900123', KEY_A, 'row-1');
  const b = await encryptPhone('+447700900123', KEY_A, 'row-1');
  assert.notEqual(a, b);
});

test('keyed hashes depend on the key, so a leaked table is not a rainbow table', async () => {
  const withA = await hmacHex(KEY_A, '+447700900123');
  const withB = await hmacHex(KEY_B, '+447700900123');
  assert.notEqual(withA, withB);
  assert.equal(withA.length, 64);
  assert.equal(withA, await hmacHex(KEY_A, '+447700900123'));
});

test('constant-time comparison still compares correctly', () => {
  assert.equal(constantTimeEquals('abc', 'abc'), true);
  assert.equal(constantTimeEquals('abc', 'abd'), false);
  assert.equal(constantTimeEquals('abc', 'abcd'), false);
  assert.equal(constantTimeEquals('abc', undefined), false);
});

test('a valid pulse link verifies', async () => {
  const sig = await signPulseLink('ABCDEFGH1234', 5, FUTURE, KEY_A);
  assert.equal(sig.length, 24);
  assert.equal(await verifyPulseLink('ABCDEFGH1234', 5, FUTURE, sig, KEY_A, NOW), true);
});

test('a pulse link cannot be replayed for another session, week or expiry', async () => {
  const sig = await signPulseLink('ABCDEFGH1234', 5, FUTURE, KEY_A);
  assert.equal(await verifyPulseLink('ZZZZZZZZ9999', 5, FUTURE, sig, KEY_A, NOW), false);
  assert.equal(await verifyPulseLink('ABCDEFGH1234', 6, FUTURE, sig, KEY_A, NOW), false);
  assert.equal(await verifyPulseLink('ABCDEFGH1234', 5, FUTURE + 1, sig, KEY_A, NOW), false);
  assert.equal(await verifyPulseLink('ABCDEFGH1234', 5, FUTURE, sig, KEY_B, NOW), false);
});

test('an expired pulse link is refused', async () => {
  const past = Math.floor(NOW / 60000) - 1;
  const sig = await signPulseLink('ABCDEFGH1234', 5, past, KEY_A);
  assert.equal(await verifyPulseLink('ABCDEFGH1234', 5, past, sig, KEY_A, NOW), false);
});

test('a missing or malformed signature is refused', async () => {
  assert.equal(await verifyPulseLink('ABCDEFGH1234', 5, FUTURE, '', KEY_A, NOW), false);
  assert.equal(await verifyPulseLink('ABCDEFGH1234', 5, FUTURE, 'x'.repeat(24), KEY_A, NOW), false);
  assert.equal(await verifyPulseLink('ABCDEFGH1234', 5, Number.NaN, 'x'.repeat(24), KEY_A, NOW), false);
});

test('a Twilio webhook signature verifies and a forged one does not', async () => {
  // Reference vector from Twilio's published signature documentation.
  const token = '12345';
  const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
  const params = { Digits: '1234', To: '+18005551212', From: '+14158675309', Caller: '+14158675309', CallSid: 'CA1234567890ABCDE' };
  assert.equal(await verifyTwilioSignature(token, url, params, 'RSOYDt4T1cUTdK1PDd93/VVr8B8='), true);
  assert.equal(await verifyTwilioSignature(token, url, params, 'AAAAAAAAAAAAAAAAAAAAAAAAAAA='), false);
  assert.equal(await verifyTwilioSignature(token, url, { ...params, Digits: '9999' }, 'RSOYDt4T1cUTdK1PDd93/VVr8B8='), false);
  assert.equal(await verifyTwilioSignature(token, url, params, null), false);
});

test('printed codes avoid the characters people misread', () => {
  for (let i = 0; i < 200; i++) {
    assert.ok(!/[ILOU]/.test(randomCode(12)), 'code must not contain I, L, O or U');
    assert.equal(randomCode(10).length, 10);
  }
});

test('code normalisation folds the mistakes people actually make', () => {
  assert.equal(normaliseCode('x7-k9 p2il'), 'X7K9P211');
  assert.equal(normaliseCode('o0oU'), '000V');
  assert.equal(normaliseCode('  a b c  '), 'ABC');
});
