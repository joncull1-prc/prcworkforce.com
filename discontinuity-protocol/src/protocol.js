/**
 * Protocol rules, kept pure so they can be tested without a network or a clock.
 *
 * Measurement note. The four items are the SRBAI (Self-Report Behavioural
 * Automaticity Index; Gardner, Abraham, Lally & de Bruijn, 2012), a four-item
 * automaticity index drawn from the automaticity subscale of the twelve-item
 * SRHI (Verplanken & Orbell, 2003). The draft called the four-item measure the
 * SRHI. It is not, and an evidence-led product that misnames its own instrument
 * loses the argument on the first informed reading.
 *
 * Direction note. This protocol discontinues a behaviour, so a FALLING score is
 * the goal and a high baseline is a strong starting position, not a bad result.
 * Copy that reads like a score to be improved is the single most common way
 * participants misread the instrument.
 */

export const ITEMS = [
  'Doing it is something I do automatically.',
  'Doing it is something I do without having to consciously remember.',
  'Doing it is something I start doing before I realise I am doing it.',
  'Doing it is something I would find it hard not to do.',
];

export const MIN_TOTAL = 4;
export const MAX_TOTAL = 28;

/** Read numeric configuration with a safe default, so a typo cannot open a limit. */
function intVar(env, name, fallback, min, max) {
  const parsed = Number.parseInt(env?.[name] ?? '', 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

export function config(env = {}) {
  return {
    weeks: intVar(env, 'PROTOCOL_WEEKS', 13, 1, 13),
    threshold: intVar(env, 'GRADUATION_THRESHOLD', 8, MIN_TOTAL, MAX_TOTAL),
    consecutive: intVar(env, 'GRADUATION_CONSECUTIVE_WEEKS', 3, 1, 13),
    minWeek: intVar(env, 'GRADUATION_MIN_WEEK', 8, 1, 13),
    dispatchHour: intVar(env, 'DISPATCH_LOCAL_HOUR', 18, 0, 23),
    timeZone: env.DISPATCH_TIMEZONE || 'Europe/London',
  };
}

/**
 * Graduation.
 *
 * The draft graduated anyone whose two most recent logs were at or below the
 * threshold. Three separate problems: the two logs were not checked for being
 * consecutive weeks, a resubmitted week counted as two, and a participant could
 * therefore finish a ninety-day protocol in a fortnight. A protocol that can be
 * completed in two weeks is not a ninety-day protocol, and refunds follow.
 *
 * The rule here: the latest N consecutive weeks all at or below the threshold,
 * and not before the configured minimum week.
 */
export function evaluateGraduation(logs, settings) {
  const { threshold, consecutive, minWeek } = settings;
  const ordered = [...logs].sort((a, b) => b.week_number - a.week_number);
  if (ordered.length < consecutive) return { graduated: false, reason: 'insufficient_history' };

  const window = ordered.slice(0, consecutive);
  if (window[0].week_number < minWeek) return { graduated: false, reason: 'before_minimum_week' };

  for (let i = 0; i < window.length; i++) {
    if (window[i].total_score > threshold) return { graduated: false, reason: 'above_threshold' };
    if (i > 0 && window[i - 1].week_number - window[i].week_number !== 1) {
      return { graduated: false, reason: 'weeks_not_consecutive' };
    }
  }
  return { graduated: true, reason: 'sustained_below_threshold' };
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Which pulse a session is due, from elapsed time rather than a counter that
 * advances every Sunday regardless. The draft incremented on dispatch, so a
 * participant who activated on a Saturday was asked for a week-two reading the
 * next evening, one day into the protocol.
 *
 * A participant who missed weeks is asked for the current week only. Sending
 * the backlog would be three texts at once and a guaranteed opt-out.
 */
export function dueWeek(startedAtIso, nowMs, settings) {
  const started = Date.parse(startedAtIso);
  if (!Number.isFinite(started)) return 0;
  const elapsed = Math.floor((nowMs - started) / WEEK_MS);
  return Math.max(0, Math.min(elapsed, settings.weeks));
}

/**
 * True only at the configured local hour in the configured zone. Cloudflare
 * cron is UTC-only, so both candidate UTC hours are registered and this gate
 * decides which one is really 18:00 in London. Without it, every participant
 * gets the message an hour early for seven months of the year, while the
 * message itself claims 18:00.
 */
export function isDispatchHour(nowMs, settings) {
  const hour = new Intl.DateTimeFormat('en-GB', {
    timeZone: settings.timeZone,
    hour: '2-digit',
    hour12: false,
  }).format(new Date(nowMs));
  return Number.parseInt(hour, 10) === settings.dispatchHour;
}

/** Day number within the protocol, used in participant-facing copy. */
export function protocolDay(week) {
  return week * 7;
}

/**
 * Participant copy. Plain UK English, no streaks, no praise, no emoji: the
 * product's claim is that it is un-gimmicked, and the messages are the most
 * visible place that claim is either kept or broken.
 */
/**
 * The behaviour is deliberately NOT repeated in any text message. A lock screen
 * reading "Behaviour logged: vaping at my desk" discloses something private to
 * whoever is standing next to the participant, and it pushes the message over
 * the length where a third segment is charged. It appears on the page and in
 * the ledger, which the participant controls.
 */
export function activationMessage(baseline) {
  return `PRC Discontinuity Protocol. Day 0 automaticity: ${baseline} of 28. `
    + `A high number means a strongly automatic habit, which is what we are measuring. `
    + `Your first weekly audit link arrives Sunday at 18:00. Reply STOP to end messages.`;
}

export function pulseMessage(week, link) {
  return `PRC Discontinuity Protocol. Week ${week} audit, day ${protocolDay(week)}. `
    + `Four questions, about thirty seconds: ${link} Reply STOP to end messages.`;
}

export function graduationMessage() {
  return `PRC Discontinuity Protocol. Your automaticity has stayed at or below the exit threshold `
    + `for three consecutive audits. The protocol is complete and messages stop here. `
    + `Turn to the maintenance section of your ledger.`;
}
