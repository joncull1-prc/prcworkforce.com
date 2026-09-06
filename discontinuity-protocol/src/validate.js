/**
 * Request validation.
 *
 * Every rule here exists because its absence is exploitable or expensive:
 *   - Unvalidated scores reach a database CHECK constraint and return a 500
 *     carrying a Postgres error string to the caller.
 *   - An unvalidated destination number turns the activation endpoint into a
 *     free SMS gateway. Sending to premium-rate ranges abroad ("SMS pumping"
 *     or artificially inflated traffic) is the standard way this class of
 *     endpoint is monetised by attackers, and the bill lands on the operator.
 */

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

/** Strict E.164, with an operator-controlled allowlist of dialling prefixes. */
export function validatePhone(raw, allowedPrefixes) {
  if (typeof raw !== 'string') throw new ValidationError('Enter a mobile number.');
  const cleaned = raw.replace(/[\s()\-.]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(cleaned)) {
    throw new ValidationError('Enter the number in international format, for example +447700900123.');
  }
  const allowed = (allowedPrefixes || '')
    .split(',')
    .map((prefix) => prefix.trim())
    .filter(Boolean);
  if (allowed.length > 0 && !allowed.some((prefix) => cleaned.startsWith(prefix))) {
    throw new ValidationError('That country code is not supported for this protocol.');
  }
  // UK mobiles are +447 followed by nine digits. Landlines cannot receive SMS,
  // so rejecting them here saves a failed send and a confused participant.
  if (cleaned.startsWith('+44') && !/^\+447\d{9}$/.test(cleaned)) {
    throw new ValidationError('Enter a UK mobile number, for example +447700900123.');
  }
  return cleaned;
}

/** Four SRBAI items, each an integer from 1 to 7. */
export function validateScores(raw) {
  if (!Array.isArray(raw) || raw.length !== 4) {
    throw new ValidationError('Answer all four questions.');
  }
  return raw.map((value) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 7) {
      throw new ValidationError('Each answer must be a whole number from 1 to 7.');
    }
    return value;
  });
}

export function validateWeek(raw, maxWeek) {
  const week = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
  if (!Number.isInteger(week) || week < 0 || week > maxWeek) {
    throw new ValidationError('That week is outside the protocol window.');
  }
  return week;
}

/**
 * The behaviour being discontinued. The SRBAI items all refer to "this action";
 * without a named referent the four scores measure nothing in particular, and
 * a participant rating a different behaviour each week produces a trend line
 * that looks like progress and is actually noise.
 */
export function validateBehaviour(raw) {
  if (typeof raw !== 'string') throw new ValidationError('Name the behaviour you are discontinuing.');
  // Replace control characters with a space rather than deleting them, so a
  // stripped character cannot silently weld two words together.
  const trimmed = raw.replace(CONTROL_CHARS, ' ').trim().replace(/\s+/g, ' ');
  if (trimmed.length < 3 || trimmed.length > 120) {
    throw new ValidationError('Describe the behaviour in 3 to 120 characters.');
  }
  return trimmed;
}

export function validateCode(normalised, expectedLength) {
  if (typeof normalised !== 'string' || normalised.length !== expectedLength) {
    throw new ValidationError('That activation code is not valid.');
  }
  return normalised;
}

/** Parse a JSON body with a hard size limit, so a huge body cannot be used to burn CPU. */
export async function readJson(request, maxBytes = 4096) {
  const declared = request.headers.get('content-length');
  if (declared && Number(declared) > maxBytes) {
    throw new ValidationError('Request body too large.');
  }
  const text = await request.text();
  if (text.length > maxBytes) throw new ValidationError('Request body too large.');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ValidationError('Malformed request.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationError('Malformed request.');
  }
  return parsed;
}
