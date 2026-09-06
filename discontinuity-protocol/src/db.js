/**
 * Supabase (PostgREST) access layer.
 *
 * Two rules the draft broke and this module enforces:
 *   1. Every response is status-checked. The draft ignored res.ok everywhere,
 *      so a rejected insert still returned a score and reported success.
 *   2. The service_role key is used, never the anon key. The anon key is
 *      designed to be public; using it for privileged writes means the API is
 *      only as safe as the row-level policies, and the draft shipped none.
 */

class DatabaseError extends Error {
  constructor(operation, status, detail) {
    super(`${operation} failed (${status}): ${detail}`);
    this.name = 'DatabaseError';
    this.status = status;
  }
}

function headers(env, extra = {}) {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function request(env, operation, path, init = {}) {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, init);
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new DatabaseError(operation, response.status, detail);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

/** Postgres unique-violation, surfaced by PostgREST as HTTP 409. */
export function isConflict(error) {
  return error instanceof DatabaseError && error.status === 409;
}

const SESSION_FIELDS =
  'id,public_code,token_hmac,phone_hmac,encrypted_phone,target_behaviour,baseline_score,'
  + 'dispatch_week,is_graduated,sms_opted_out,started_at';

/**
 * Claim a printed activation code. One conditional UPDATE, so two simultaneous
 * requests cannot both claim the same ledger.
 */
export async function claimToken(tokenHmac, env) {
  const rows = await request(env, 'claimToken', '/rpc/claim_activation_token', {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify({ p_token_hmac: tokenHmac }),
  });
  return Array.isArray(rows) && rows.length > 0;
}

/** Put a claimed code back if the activation that followed it did not complete. */
export async function releaseToken(tokenHmac, env) {
  await request(env, 'releaseToken', '/rpc/release_activation_token', {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify({ p_token_hmac: tokenHmac }),
  });
}

export async function createSession(fields, env) {
  const rows = await request(env, 'createSession', '/participant_sessions', {
    method: 'POST',
    headers: headers(env, { Prefer: 'return=representation' }),
    body: JSON.stringify(fields),
  });
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new DatabaseError('createSession', 500, 'insert returned no row');
  }
  return rows[0];
}

/**
 * Insert one weekly log. The unique constraint on (session_id, week_number)
 * makes a repeat submission a conflict rather than a silent second row, which
 * is what let a single week satisfy the consecutive-weeks graduation test.
 */
export async function insertLog(sessionId, weekNumber, scores, env) {
  const total = scores.reduce((sum, value) => sum + value, 0);
  await request(env, 'insertLog', '/srbai_logs', {
    method: 'POST',
    headers: headers(env, { Prefer: 'return=minimal' }),
    body: JSON.stringify({
      session_id: sessionId,
      week_number: weekNumber,
      q1_score: scores[0],
      q2_score: scores[1],
      q3_score: scores[2],
      q4_score: scores[3],
      total_score: total,
    }),
  });
  return total;
}

/** The most recent logs for a session, newest week first. */
export async function recentLogs(sessionId, env, limit = 6) {
  return (await request(
    env,
    'recentLogs',
    `/srbai_logs?session_id=eq.${encodeURIComponent(sessionId)}`
      + `&select=week_number,total_score&order=week_number.desc&limit=${limit}`,
    { headers: headers(env) },
  )) || [];
}

export async function markGraduated(sessionId, env) {
  await request(env, 'markGraduated', `/participant_sessions?id=eq.${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    headers: headers(env, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ is_graduated: true, graduated_at: new Date().toISOString() }),
  });
}

export async function sessionByPublicCode(publicCode, env) {
  const rows = await request(
    env,
    'sessionByPublicCode',
    `/participant_sessions?public_code=eq.${encodeURIComponent(publicCode)}&select=${SESSION_FIELDS}&limit=1`,
    { headers: headers(env) },
  );
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/**
 * A running protocol on this number, if there is one.
 *
 * The filter mirrors the partial unique index uq_sessions_active_phone exactly.
 * A looser query here would let the request through and turn the index's
 * rejection into a 500 instead of a clear message.
 */
export async function activeSessionByPhoneHmac(phoneHmac, env) {
  const rows = await request(
    env,
    'activeSessionByPhoneHmac',
    `/participant_sessions?phone_hmac=eq.${encodeURIComponent(phoneHmac)}`
      + `&is_graduated=eq.false&sms_opted_out=eq.false&dispatch_week=lt.13`
      + `&select=${SESSION_FIELDS}&order=created_at.desc&limit=1`,
    { headers: headers(env) },
  );
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/**
 * Sessions eligible for a weekly send. Graduated and opted-out participants are
 * excluded in the query, not in the loop, so a code change cannot accidentally
 * text someone who has said STOP.
 */
export async function sessionsDueForDispatch(env, limit = 200, offset = 0) {
  return (await request(
    env,
    'sessionsDueForDispatch',
    `/participant_sessions?is_graduated=eq.false&sms_opted_out=eq.false`
      + `&dispatch_week=lt.13&select=${SESSION_FIELDS}`
      + `&order=started_at.asc,id.asc&limit=${limit}&offset=${offset}`,
    { headers: headers(env) },
  )) || [];
}

/**
 * Reserve this week's send. The unique constraint on (session_id, week_number)
 * means a cron retry, an overlapping invocation or a manual re-run cannot text
 * the same participant twice. Returns false when the send is already reserved.
 */
export async function reserveDispatch(sessionId, weekNumber, env) {
  try {
    await request(env, 'reserveDispatch', '/dispatch_log', {
      method: 'POST',
      headers: headers(env, { Prefer: 'return=minimal' }),
      body: JSON.stringify({ session_id: sessionId, week_number: weekNumber }),
    });
    return true;
  } catch (error) {
    if (isConflict(error)) return false;
    throw error;
  }
}

export async function confirmDispatch(sessionId, weekNumber, env) {
  await request(
    env,
    'confirmDispatch',
    `/dispatch_log?session_id=eq.${encodeURIComponent(sessionId)}&week_number=eq.${weekNumber}`,
    {
      method: 'PATCH',
      headers: headers(env, { Prefer: 'return=minimal' }),
      body: JSON.stringify({ delivered: true }),
    },
  );
}

export async function setDispatchWeek(sessionId, weekNumber, env) {
  await request(env, 'setDispatchWeek', `/participant_sessions?id=eq.${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    headers: headers(env, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ dispatch_week: weekNumber }),
  });
}

export async function setOptOut(phoneHmac, optedOut, env) {
  await request(env, 'setOptOut', `/participant_sessions?phone_hmac=eq.${encodeURIComponent(phoneHmac)}`, {
    method: 'PATCH',
    headers: headers(env, { Prefer: 'return=minimal' }),
    body: JSON.stringify({
      sms_opted_out: optedOut,
      opted_out_at: optedOut ? new Date().toISOString() : null,
    }),
  });
}

/** Right to erasure. Deletes the session and, by cascade, every log it owns. */
export async function eraseByPhoneHmac(phoneHmac, env) {
  const removed = await request(env, 'eraseByPhoneHmac', '/rpc/erase_participant', {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify({ p_phone_hmac: phoneHmac }),
  });
  return Number(removed) || 0;
}
