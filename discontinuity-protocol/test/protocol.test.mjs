import test from 'node:test';
import assert from 'node:assert/strict';
import {
  config, evaluateGraduation, dueWeek, isDispatchHour, activationMessage, pulseMessage,
} from '../src/protocol.js';
import { segmentCount } from '../src/twilio.js';

const settings = config({});

const log = (week, total) => ({ week_number: week, total_score: total });

test('config falls back to safe defaults when a variable is nonsense', () => {
  const bad = config({ PROTOCOL_WEEKS: 'many', GRADUATION_THRESHOLD: '99', GRADUATION_MIN_WEEK: '-3' });
  assert.equal(bad.weeks, 13);
  assert.equal(bad.threshold, 8);
  assert.equal(bad.minWeek, 8);
});

test('graduation needs three consecutive weeks at or below the threshold', () => {
  assert.equal(evaluateGraduation([log(10, 7), log(9, 8), log(8, 6)], settings).graduated, true);
});

test('a single week resubmitted cannot graduate anyone', () => {
  // The old unique-constraint gap: two rows for the same week looked consecutive.
  const verdict = evaluateGraduation([log(9, 6), log(9, 6), log(9, 6)], settings);
  assert.equal(verdict.graduated, false);
  assert.equal(verdict.reason, 'weeks_not_consecutive');
});

test('a ninety-day protocol cannot be finished in a fortnight', () => {
  const verdict = evaluateGraduation([log(3, 5), log(2, 5), log(1, 5)], settings);
  assert.equal(verdict.graduated, false);
  assert.equal(verdict.reason, 'before_minimum_week');
});

test('a gap in the weeks blocks graduation', () => {
  const verdict = evaluateGraduation([log(12, 6), log(10, 6), log(9, 6)], settings);
  assert.equal(verdict.graduated, false);
  assert.equal(verdict.reason, 'weeks_not_consecutive');
});

test('one reading above the threshold blocks graduation', () => {
  assert.equal(evaluateGraduation([log(12, 9), log(11, 6), log(10, 6)], settings).graduated, false);
});

test('too little history blocks graduation', () => {
  assert.equal(evaluateGraduation([log(12, 4), log(11, 4)], settings).reason, 'insufficient_history');
});

test('the due week comes from elapsed time, not from a Sunday counter', () => {
  const started = '2026-09-05T09:00:00Z'; // A Saturday.
  const nextDay = Date.parse('2026-09-06T17:00:00Z');
  // The draft would have asked for a week-two reading one day in.
  assert.equal(dueWeek(started, nextDay, settings), 0);
  assert.equal(dueWeek(started, Date.parse('2026-09-13T09:00:00Z'), settings), 1);
  assert.equal(dueWeek(started, Date.parse('2026-10-04T09:00:00Z'), settings), 4);
});

test('the due week is capped at the end of the protocol', () => {
  assert.equal(dueWeek('2026-01-01T00:00:00Z', Date.parse('2027-01-01T00:00:00Z'), settings), 13);
});

test('a malformed start date does not schedule a send', () => {
  assert.equal(dueWeek('not-a-date', Date.now(), settings), 0);
});

test('dispatch fires at 18:00 London in both British Summer Time and GMT', () => {
  assert.equal(isDispatchHour(Date.parse('2026-07-05T17:00:00Z'), settings), true);  // BST
  assert.equal(isDispatchHour(Date.parse('2026-07-05T18:00:00Z'), settings), false);
  assert.equal(isDispatchHour(Date.parse('2026-12-06T18:00:00Z'), settings), true);  // GMT
  assert.equal(isDispatchHour(Date.parse('2026-12-06T17:00:00Z'), settings), false);
});

test('no message repeats the behaviour, which would leak it to a lock screen', () => {
  assert.ok(!activationMessage(24).toLowerCase().includes('behaviour logged'));
  assert.equal(activationMessage(24).includes('28'), true);
});

test('participant messages stay within a sensible number of SMS segments', () => {
  const link = 'https://protocol.prcworkforce.com/p?c=ABCDEFGH1234&w=7&e=29876543&s=0123456789abcdef01234567';
  assert.ok(segmentCount(pulseMessage(7, link)) <= 2, 'pulse message should be at most two segments');
  assert.ok(segmentCount(activationMessage(24)) <= 2, 'activation message should be at most two segments');
});

test('a link fits in the pulse message without truncation', () => {
  const link = 'https://protocol.prcworkforce.com/p?c=ABCDEFGH1234&w=13&e=29876543&s=0123456789abcdef01234567';
  assert.ok(pulseMessage(13, link).includes(link));
});
