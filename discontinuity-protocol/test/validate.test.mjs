import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ValidationError, validatePhone, validateScores, validateWeek,
  validateBehaviourDeclared, validateCode,
} from '../src/validate.js';

test('a UK mobile in any common shape is accepted and normalised', () => {
  assert.equal(validatePhone('+44 7700 900123', '+44'), '+447700900123');
  assert.equal(validatePhone('+44-7700-900123', '+44'), '+447700900123');
});

test('the endpoint cannot be used as a free SMS gateway to any country', () => {
  // Unrestricted destinations are how this endpoint class gets monetised:
  // traffic is pumped to expensive ranges and the operator pays the bill.
  assert.throws(() => validatePhone('+12125550100', '+44'), ValidationError);
  assert.throws(() => validatePhone('+8801700000000', '+44'), ValidationError);
  assert.equal(validatePhone('+12125550100', '+44,+1'), '+12125550100');
});

test('a UK landline is refused because it cannot receive the audit text', () => {
  assert.throws(() => validatePhone('+442071838750', '+44'), ValidationError);
});

test('malformed numbers are refused', () => {
  for (const bad of ['07700900123', '+0447700900123', 'not a number', '', '+44', null, 12345]) {
    assert.throws(() => validatePhone(bad, '+44'), ValidationError);
  }
});

test('scores must be four whole numbers from one to seven', () => {
  assert.deepEqual(validateScores([1, 4, 7, 2]), [1, 4, 7, 2]);
  const bad = [[1, 2, 3], [1, 2, 3, 4, 5], [0, 1, 2, 3], [1, 2, 3, 8], [1, 2, 3, 4.5], ['4', 4, 4, 4], null, {}];
  for (const value of bad) assert.throws(() => validateScores(value), ValidationError);
});

test('a fabricated score cannot reach the database and return a Postgres error', () => {
  // The draft passed straight through to a CHECK constraint, and the resulting
  // 500 carried the constraint text back to the caller.
  assert.throws(() => validateScores([99, 99, 99, 99]), ValidationError);
});

test('week numbers outside the protocol window are refused', () => {
  assert.equal(validateWeek('7', 13), 7);
  assert.equal(validateWeek(0, 13), 0);
  for (const bad of [-1, 14, 'seven', 1.5, null]) {
    assert.throws(() => validateWeek(bad, 13), ValidationError);
  }
});

test('the behaviour must be declared as written, and only a boolean is accepted', () => {
  assert.equal(validateBehaviourDeclared(true), true);
  // Anything truthy but not exactly true is refused, so the text of a habit
  // cannot be smuggled through this field into the store.
  for (const bad of ['checking my phone in bed', 'true', 1, {}, [], false, undefined, null]) {
    assert.throws(() => validateBehaviourDeclared(bad), ValidationError);
  }
});

test('activation codes must be the printed length', () => {
  assert.equal(validateCode('ABCDEFGH12', 10), 'ABCDEFGH12');
  assert.throws(() => validateCode('ABC', 10), ValidationError);
  assert.throws(() => validateCode(null, 10), ValidationError);
});
