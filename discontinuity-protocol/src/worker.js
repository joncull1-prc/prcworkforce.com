/**
 * Discontinuity Protocol — Cloudflare Worker.
 *
 * Routes
 *   POST /api/activate       claim a printed code, record the Day 0 baseline
 *   GET  /api/pulse-context  what a signed link is for, so the page can render
 *   POST /api/pulse          record one weekly audit against a signed link
 *   POST /api/sms/inbound    Twilio webhook: STOP, START, HELP, DELETE
 *   GET  /healthz            configuration sanity, no secrets
 *   *                        static assets
 */

import {
  assertKey, hmacHex, encryptPhone, decryptPhone,
  signPulseLink, verifyPulseLink, verifyTwilioSignature,
  randomCode, normaliseCode,
} from './crypto.js';
import { sendSMS, twiml, emptyTwiml } from './twilio.js';
import * as db from './db.js';
import {
  config, evaluateGraduation, dueWeek, isDispatchHour,
  activationMessage, pulseMessage, graduationMessage,
} from './protocol.js';
import {
  ValidationError, readJson, validatePhone, validateScores,
  validateBehaviourDeclared, validateCode,
} from './validate.js';
import {
  json, problem, tooManyRequests, throttleCheck, throttleRecord,
  clientKey, newReference, pageHeaders,
} from './http.js';

const ACTIVATION_CODE_LENGTH = 10;
const PUBLIC_CODE_LENGTH = 12;
const LINK_LIFETIME_MINUTES = 9 * 24 * 60; // Nine days: a late responder is not locked out.

const REQUIRED_SECRETS = [
  'SUPABASE_SERVICE_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN',
  'ENCRYPTION_KEY', 'PHONE_PEPPER', 'TOKEN_PEPPER', 'LINK_SIGNING_KEY',
];
const HEX_SECRETS = ['ENCRYPTION_KEY', 'PHONE_PEPPER', 'TOKEN_PEPPER', 'LINK_SIGNING_KEY'];

/**
 * Fail loudly and early on missing or malformed configuration. The class of bug
 * this prevents is the worst kind: a system that looks healthy while storing
 * mobile numbers in clear text or signing links with an empty key.
 */
function configErrors(env) {
  const errors = [];
  for (const name of REQUIRED_SECRETS) {
    if (!env[name]) errors.push(`${name} is not set`);
  }
  for (const name of HEX_SECRETS) {
    if (env[name]) {
      try { assertKey(env[name], name); } catch (error) { errors.push(error.message); }
    }
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_URL.startsWith('https://')) {
    errors.push('SUPABASE_URL is not an https URL');
  }
  if (!env.PUBLIC_ORIGIN || !env.PUBLIC_ORIGIN.startsWith('https://')) {
    errors.push('PUBLIC_ORIGIN is not an https URL');
  }
  // Distinct keys: reusing one secret for several purposes means a single leak
  // compromises stored numbers, link signing and code lookup at once.
  const values = HEX_SECRETS.map((name) => env[name]).filter(Boolean);
  if (new Set(values).size !== values.length) errors.push('key material is reused across purposes');
  return errors;
}

/**
 * Weekly heartbeat.
 *
 * A scheduled job with no heartbeat is a job you find out about from a
 * customer. This posts one line to an operator-chosen endpoint after every run,
 * successful or not, so a silent failure surfaces in days rather than weeks.
 * Optional, and it can never break the run: any failure to report is swallowed.
 */
async function heartbeat(env, payload) {
  if (!env.ALERT_WEBHOOK_URL) return;
  try {
    await fetch(env.ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'discontinuity-protocol', at: new Date().toISOString(), ...payload }),
    });
  } catch (error) {
    console.error(JSON.stringify({ event: 'heartbeat.failed', message: error?.message }));
  }
}

function logError(reference, route, error) {
  console.error(JSON.stringify({
    event: 'request.failed', reference, route,
    name: error?.name, message: error?.message,
  }));
}

/** Build a signed pulse link. */
async function buildPulseLink(env, publicCode, week, nowMs) {
  const expiry = Math.floor(nowMs / 60000) + LINK_LIFETIME_MINUTES;
  const signature = await signPulseLink(publicCode, week, expiry, env.LINK_SIGNING_KEY);
  return `${env.PUBLIC_ORIGIN}/p?c=${publicCode}&w=${week}&e=${expiry}&s=${signature}`;
}

/**
 * Validate the four query parameters that make up a signed link. Returns the
 * session only when the signature, the expiry and the week all check out, so
 * no route can accidentally trust a bare identifier.
 */
async function authoriseLink(url, env, settings, nowMs) {
  const publicCode = normaliseCode(url.searchParams.get('c') || '');
  const week = Number.parseInt(url.searchParams.get('w') || '', 10);
  const expiry = Number.parseInt(url.searchParams.get('e') || '', 10);
  const signature = url.searchParams.get('s') || '';

  if (publicCode.length !== PUBLIC_CODE_LENGTH || !Number.isInteger(week)) return null;
  if (week < 1 || week > settings.weeks) return null;

  const ok = await verifyPulseLink(publicCode, week, expiry, signature, env.LINK_SIGNING_KEY, nowMs);
  if (!ok) return null;

  const session = await db.sessionByPublicCode(publicCode, env);
  return session ? { session, week } : null;
}

const HOUR = 3600;

async function handleActivate(request, env, settings, reference) {
  // Only failed attempts spend budget, so a team activating from one office
  // address is not locked out by its own colleagues.
  const address = clientKey(request);
  const budget = await throttleCheck(env.THROTTLE, 'activate', address, 15, HOUR);
  if (!budget.allowed) return tooManyRequests('Too many failed attempts. Try again in an hour.', HOUR);
  const spend = () => throttleRecord(env.THROTTLE, 'activate', address, HOUR);

  const body = await readJson(request);
  const code = validateCode(normaliseCode(body.code ?? body.token ?? ''), ACTIVATION_CODE_LENGTH);
  const phone = validatePhone(body.phone, env.ALLOWED_DIAL_PREFIXES);
  validateBehaviourDeclared(body.behaviourRecorded);
  const scores = validateScores(body.scores);
  if (body.consent !== true) {
    return problem(400, 'Tick the box to confirm you agree to receive the weekly audit texts.');
  }

  const tokenHmac = await hmacHex(env.TOKEN_PEPPER, code, 'TOKEN_PEPPER');
  const phoneHmac = await hmacHex(env.PHONE_PEPPER, phone, 'PHONE_PEPPER');

  // Checked before the token is claimed. Claiming first would burn a printed
  // ledger on a request that is about to be rejected anyway.
  const existing = await db.activeSessionByPhoneHmac(phoneHmac, env);
  if (existing) {
    await spend();
    return problem(409, 'That mobile number already has a protocol running. Finish or stop it first.');
  }

  const claimed = await db.claimToken(tokenHmac, env);
  // One message for "unknown" and "already used" so the endpoint cannot be used
  // to tell valid codes from spent ones.
  if (!claimed) {
    await spend();
    return problem(403, 'That activation code is not valid or has already been used.');
  }

  try {
    const encrypted = await encryptPhone(phone, env.ENCRYPTION_KEY, tokenHmac);
    const baseline = scores.reduce((sum, value) => sum + value, 0);

    let session = null;
    for (let attempt = 0; attempt < 3 && !session; attempt++) {
      try {
        session = await db.createSession({
          public_code: randomCode(PUBLIC_CODE_LENGTH),
          token_hmac: tokenHmac,
          phone_hmac: phoneHmac,
          encrypted_phone: encrypted,
          baseline_score: baseline,
        }, env);
      } catch (error) {
        if (db.isConflict(error) && attempt < 2) continue;
        throw error;
      }
    }

    await db.insertLog(session.id, 0, scores, env);

    const delivery = await sendSMS(phone, activationMessage(baseline), env);
    if (!delivery.sent) {
      console.error(JSON.stringify({ event: 'activation.sms_failed', reference, sessionId: session.id }));
    }

    return json({
      ok: true,
      baseline,
      smsDelivered: delivery.sent === true,
      nextAudit: 'Sunday 18:00',
    });
  } catch (error) {
    // The participant must not lose a printed ledger to our failure.
    try { await db.releaseToken(tokenHmac, env); } catch (releaseError) {
      logError(reference, 'activate.release', releaseError);
    }
    throw error;
  }
}

async function handlePulseContext(url, env, settings) {
  const authorised = await authoriseLink(url, env, settings, Date.now());
  if (!authorised) return problem(403, 'That link is not valid or has expired.');
  const { session, week } = authorised;
  if (session.is_graduated) return problem(410, 'This protocol is already complete.');
  // No behaviour is returned, because none is stored. The page points the
  // participant back to page 1 of their ledger instead.
  return json({
    ok: true,
    week,
    baseline: session.baseline_score,
    totalWeeks: settings.weeks,
  });
}

async function handlePulse(request, url, env, settings, reference) {
  const nowMs = Date.now();
  const address = clientKey(request);
  const budget = await throttleCheck(env.THROTTLE, 'pulse', address, 40, HOUR);
  if (!budget.allowed) return tooManyRequests('Too many failed attempts. Try again later.', HOUR);

  const authorised = await authoriseLink(url, env, settings, nowMs);
  if (!authorised) {
    await throttleRecord(env.THROTTLE, 'pulse', address, HOUR);
    return problem(403, 'That link is not valid or has expired.');
  }
  const { session, week } = authorised;

  if (session.is_graduated) return problem(410, 'This protocol is already complete.');

  const body = await readJson(request);
  const scores = validateScores(body.scores);

  let total;
  try {
    total = await db.insertLog(session.id, week, scores, env);
  } catch (error) {
    // A repeat submission is expected behaviour, not a fault: people tap the
    // same SMS link twice. It must not overwrite the reading already recorded.
    if (db.isConflict(error)) {
      return problem(409, 'Week ' + week + ' is already recorded. Each week is logged once.');
    }
    throw error;
  }

  const logs = await db.recentLogs(session.id, env, settings.consecutive + 2);
  const verdict = evaluateGraduation(logs, settings);

  if (verdict.graduated) {
    await db.markGraduated(session.id, env);
    if (!session.sms_opted_out) {
      try {
        const phone = await decryptPhone(session.encrypted_phone, env.ENCRYPTION_KEY, session.token_hmac);
        await sendSMS(phone, graduationMessage(), env);
      } catch (error) {
        logError(reference, 'pulse.graduation_sms', error);
      }
    }
  }

  return json({
    ok: true,
    week,
    total,
    baseline: session.baseline_score,
    change: total - session.baseline_score,
    graduated: verdict.graduated,
  });
}

/**
 * Twilio inbound webhook.
 *
 * The signature check is not optional. Without it anyone can POST a forged
 * "DELETE" for any number and erase another participant's record, or forge a
 * STOP and silence them. The signed URL is rebuilt from PUBLIC_ORIGIN rather
 * than request.url, because a proxy in front of the Worker can change the host
 * and quietly break every verification.
 */
async function handleInboundSms(request, url, env, reference) {
  const form = await request.formData();
  const params = {};
  for (const [key, value] of form.entries()) params[key] = String(value);

  const signedUrl = `${env.PUBLIC_ORIGIN}${url.pathname}${url.search}`;
  const valid = await verifyTwilioSignature(
    env.TWILIO_AUTH_TOKEN, signedUrl, params, request.headers.get('X-Twilio-Signature'),
  );
  if (!valid) {
    console.error(JSON.stringify({ event: 'sms.bad_signature', reference }));
    return problem(403, 'Signature check failed.');
  }

  const from = String(params.From || '');
  const keyword = String(params.Body || '').trim().toUpperCase().replace(/[^A-Z]/g, '');
  if (!from) return emptyTwiml();

  const phoneHmac = await hmacHex(env.PHONE_PEPPER, from, 'PHONE_PEPPER');

  if (['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'].includes(keyword)) {
    await db.setOptOut(phoneHmac, true, env);
    return emptyTwiml(); // Twilio sends the carrier-mandated confirmation itself.
  }

  if (['START', 'UNSTOP', 'YES'].includes(keyword)) {
    await db.setOptOut(phoneHmac, false, env);
    return twiml('PRC Discontinuity Protocol: weekly audit texts resumed.');
  }

  if (['DELETE', 'ERASE', 'FORGET'].includes(keyword)) {
    const removed = await db.eraseByPhoneHmac(phoneHmac, env);
    return twiml(removed > 0
      ? 'PRC Discontinuity Protocol: your record and all readings are deleted. Nothing about you remains.'
      : 'PRC Discontinuity Protocol: no record found for this number.');
  }

  return twiml(
    `PRC Discontinuity Protocol. Weekly audit texts, one per week for 13 weeks. `
    + `STOP to end. DELETE to erase your record. Help: ${env.SUPPORT_EMAIL || 'see your ledger'}`,
  );
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const reference = newReference();

    if (url.pathname === '/healthz') {
      const errors = configErrors(env);
      return json({ ok: errors.length === 0, issues: errors.length }, errors.length === 0 ? 200 : 503);
    }

    if (url.pathname.startsWith('/api/')) {
      const errors = configErrors(env);
      if (errors.length > 0) {
        console.error(JSON.stringify({ event: 'config.invalid', reference, errors }));
        return problem(503, 'The service is not configured correctly.', reference);
      }

      const settings = config(env);
      try {
        if (url.pathname === '/api/activate' && request.method === 'POST') {
          return await handleActivate(request, env, settings, reference);
        }
        if (url.pathname === '/api/pulse-context' && request.method === 'GET') {
          return await handlePulseContext(url, env, settings);
        }
        if (url.pathname === '/api/pulse' && request.method === 'POST') {
          return await handlePulse(request, url, env, settings, reference);
        }
        if (url.pathname === '/api/sms/inbound' && request.method === 'POST') {
          return await handleInboundSms(request, url, env, reference);
        }
        return problem(404, 'Unknown endpoint.');
      } catch (error) {
        if (error instanceof ValidationError) return problem(400, error.message);
        logError(reference, url.pathname, error);
        return problem(500, 'Something went wrong. Quote this reference if you contact us.', reference);
      }
    }

    // /p is the pulse page. Serving it from a stable path keeps the SMS short.
    const assetRequest = url.pathname === '/p'
      ? new Request(new URL('/pulse.html', url).toString(), request)
      : request;

    const asset = await env.ASSETS.fetch(assetRequest);
    const headers = new Headers(asset.headers);
    for (const [key, value] of Object.entries(pageHeaders(asset.headers.get('Content-Type') || 'text/html; charset=utf-8'))) {
      headers.set(key, value);
    }
    return new Response(asset.body, { status: asset.status, headers });
  },

  /**
   * Weekly dispatch. Registered on two UTC hours; only the one that is 18:00 in
   * Europe/London does any work.
   */
  async scheduled(event, env, ctx) {
    const errors = configErrors(env);
    if (errors.length > 0) {
      console.error(JSON.stringify({ event: 'cron.config_invalid', errors }));
      await heartbeat(env, { status: 'config_invalid', issues: errors.length });
      return;
    }

    const settings = config(env);
    const nowMs = event?.scheduledTime || Date.now();
    if (!isDispatchHour(nowMs, settings)) return;

    // Each send costs several subrequests, and a Worker invocation has a fixed
    // budget for those. Page through in batches and stop at a documented ceiling
    // rather than silently truncating the cohort. Ordering is stable, so the
    // work that is skipped is skipped visibly, in the log.
    const PAGE = 100;
    const MAX_PER_RUN = 200;
    const sessions = [];
    for (let offset = 0; sessions.length < MAX_PER_RUN; offset += PAGE) {
      const page = await db.sessionsDueForDispatch(env, PAGE, offset);
      sessions.push(...page);
      if (page.length < PAGE) break;
    }
    if (sessions.length >= MAX_PER_RUN) {
      console.warn(JSON.stringify({
        event: 'cron.capacity_reached', cap: MAX_PER_RUN,
        note: 'Move weekly dispatch to Cloudflare Queues before the cohort grows further.',
      }));
    }

    let sent = 0;
    let skipped = 0;

    for (const session of sessions) {
      try {
        const week = dueWeek(session.started_at, nowMs, settings);
        if (week < 1 || week <= session.dispatch_week) { skipped++; continue; }

        // Reserve before sending, so a retry or an overlapping run cannot text
        // the same participant twice.
        const reserved = await db.reserveDispatch(session.id, week, env);
        if (!reserved) { skipped++; continue; }

        // Advance the counter as soon as the send is reserved, before attempting
        // it. If the send then fails, the participant misses one link instead of
        // being stuck on this week for ever: the reservation would block every
        // future retry of week N, and because the due week comes from elapsed
        // time, week N never comes round again anyway.
        await db.setDispatchWeek(session.id, week, env);

        const phone = await decryptPhone(session.encrypted_phone, env.ENCRYPTION_KEY, session.token_hmac);
        const link = await buildPulseLink(env, session.public_code, week, nowMs);
        const delivery = await sendSMS(phone, pulseMessage(week, link), env);

        if (delivery.sent) {
          await db.confirmDispatch(session.id, week, env);
          sent++;
        } else {
          console.error(JSON.stringify({ event: 'cron.send_failed', sessionId: session.id, week }));
        }
      } catch (error) {
        // One bad row must not stop the run for everyone else.
        console.error(JSON.stringify({
          event: 'cron.session_failed', sessionId: session.id, message: error?.message,
        }));
      }
    }

    const failed = sessions.length - sent - skipped;
    console.log(JSON.stringify({ event: 'cron.complete', considered: sessions.length, sent, skipped, failed }));
    await heartbeat(env, {
      status: failed > 0 ? 'completed_with_failures' : 'ok',
      considered: sessions.length, sent, skipped, failed,
    });
  },
};
