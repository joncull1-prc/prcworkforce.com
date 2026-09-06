import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { signPulseLink, hmacHex } from '../src/crypto.js';

/**
 * End-to-end tests for the router, with Supabase and Twilio stubbed at the
 * global fetch boundary. These catch the wiring faults that unit tests cannot:
 * a route that trusts an identifier, an error path that leaks, a token claimed
 * before a request that was going to be rejected anyway.
 */

const KEYS = {
  ENCRYPTION_KEY: '11'.repeat(32),
  PHONE_PEPPER: '22'.repeat(32),
  TOKEN_PEPPER: '33'.repeat(32),
  LINK_SIGNING_KEY: '44'.repeat(32),
};

function makeEnv(overrides = {}) {
  const store = new Map();
  return {
    ...KEYS,
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SERVICE_KEY: 'service-key',
    TWILIO_ACCOUNT_SID: 'AC0000000000000000000000000000000',
    TWILIO_AUTH_TOKEN: 'auth-token',
    TWILIO_PHONE_NUMBER: '+447700900000',
    PUBLIC_ORIGIN: 'https://protocol.example.com',
    ALLOWED_DIAL_PREFIXES: '+44',
    SUPPORT_EMAIL: 'protocol@example.com',
    SMS_DRY_RUN: '1',
    THROTTLE: {
      async get(key) { return store.get(key) ?? null; },
      async put(key, value) { store.set(key, value); },
    },
    ASSETS: { async fetch() { return new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } }); } },
    ...overrides,
  };
}

const SESSION = {
  id: '11111111-2222-3333-4444-555555555555',
  public_code: 'ABCDEFGH1234',
  token_hmac: 'f'.repeat(64),
  phone_hmac: 'e'.repeat(64),
  // Encrypted under ENCRYPTION_KEY with token_hmac as additional data, filled in below.
  encrypted_phone: null,
  target_behaviour: 'checking my phone in bed',
  baseline_score: 24,
  dispatch_week: 5,
  is_graduated: false,
  sms_opted_out: false,
  started_at: '2026-06-01T09:00:00Z',
};

/**
 * Route stubbed upstream calls. `plan` maps a matcher to a response, and every
 * call is recorded so a test can assert that something did NOT happen, which is
 * the only way to prove a token was not claimed.
 */
function installFetch(plan) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, method: init.method || 'GET', body: init.body });
    for (const [fragment, responder] of plan) {
      if (url.includes(fragment)) {
        const result = typeof responder === 'function' ? responder(calls.length) : responder;
        const status = result.status ?? 200;
        // A 204 must have no body at all, which is what PostgREST really sends
        // for a write with Prefer: return=minimal.
        return status === 204
          ? new Response(null, { status })
          : new Response(JSON.stringify(result.body ?? null), { status });
      }
    }
    return new Response('[]', { status: 200 });
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

const post = (path, body) => new Request(`https://protocol.example.com${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.10' },
  body: JSON.stringify(body),
});

const goodActivation = {
  code: 'X7K9P2M4RT',
  phone: '+447700900123',
  behaviour: 'checking my phone in bed',
  scores: [7, 6, 6, 5],
  consent: true,
};

test('healthz refuses to report healthy when a key is missing', async () => {
  const env = makeEnv({ ENCRYPTION_KEY: undefined });
  const response = await worker.fetch(new Request('https://protocol.example.com/healthz'), env);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).ok, false);
});

test('healthz refuses to report healthy when two keys are the same value', async () => {
  // Reusing one secret across purposes means one leak compromises stored
  // numbers, link signing and code lookup together.
  const env = makeEnv({ PHONE_PEPPER: KEYS.TOKEN_PEPPER });
  const response = await worker.fetch(new Request('https://protocol.example.com/healthz'), env);
  assert.equal(response.status, 503);
});

test('healthz reports healthy on a complete configuration', async () => {
  const response = await worker.fetch(new Request('https://protocol.example.com/healthz'), makeEnv());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, issues: 0 });
});

test('an API call on a misconfigured Worker fails closed and leaks nothing', async () => {
  const env = makeEnv({ SUPABASE_SERVICE_KEY: undefined });
  const response = await worker.fetch(post('/api/activate', goodActivation), env);
  assert.equal(response.status, 503);
  const data = await response.json();
  assert.equal(data.error, 'The service is not configured correctly.');
  assert.ok(!JSON.stringify(data).includes('SUPABASE'));
});

test('a bad phone number is rejected before any activation code is claimed', async () => {
  const stub = installFetch([]);
  try {
    const response = await worker.fetch(
      post('/api/activate', { ...goodActivation, phone: '+12125550100' }), makeEnv(),
    );
    assert.equal(response.status, 400);
    assert.equal(stub.calls.filter((c) => c.url.includes('claim_activation_token')).length, 0);
  } finally { stub.restore(); }
});

test('activation without consent is refused', async () => {
  const stub = installFetch([]);
  try {
    const response = await worker.fetch(
      post('/api/activate', { ...goodActivation, consent: false }), makeEnv(),
    );
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Tick the box/);
  } finally { stub.restore(); }
});

test('a spent activation code gives the same answer as an unknown one', async () => {
  const stub = installFetch([
    ['claim_activation_token', { body: [] }],
    ['participant_sessions', { body: [] }],
  ]);
  try {
    const response = await worker.fetch(post('/api/activate', goodActivation), makeEnv());
    assert.equal(response.status, 403);
    assert.equal(
      (await response.json()).error,
      'That activation code is not valid or has already been used.',
    );
  } finally { stub.restore(); }
});

test('a mobile with a protocol already running cannot start another', async () => {
  const stub = installFetch([
    ['dispatch_week=lt.13', { body: [SESSION] }],
    ['claim_activation_token', { body: [{ id: 'token-id' }] }],
  ]);
  try {
    const response = await worker.fetch(post('/api/activate', goodActivation), makeEnv());
    assert.equal(response.status, 409);
    // The check happens first, so a request that was going to be rejected does
    // not burn the printed ledger.
    assert.equal(stub.calls.filter((c) => c.url.includes('claim_activation_token')).length, 0);
  } finally { stub.restore(); }
});

test('a good activation claims the code, records week zero and reports the baseline', async () => {
  const stub = installFetch([
    ['dispatch_week=lt.13', { body: [] }],
    ['claim_activation_token', { body: [{ id: 'token-id' }] }],
    ['participant_sessions', { body: [{ ...SESSION, baseline_score: 24 }] }],
    ['srbai_logs', { body: null, status: 201 }],
  ]);
  try {
    const response = await worker.fetch(post('/api/activate', goodActivation), makeEnv());
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.ok, true);
    assert.equal(data.baseline, 24);

    const logCall = stub.calls.find((c) => c.url.includes('srbai_logs'));
    const logged = JSON.parse(logCall.body);
    assert.equal(logged.week_number, 0);
    assert.equal(logged.total_score, 24);

    const created = JSON.parse(stub.calls.find((c) => c.url.includes('participant_sessions') && c.method === 'POST').body);
    assert.ok(created.encrypted_phone.startsWith('v1.'));
    assert.ok(!JSON.stringify(created).includes('447700900123'), 'the number must never be stored in clear');
  } finally { stub.restore(); }
});

test('a database failure after the claim puts the printed code back', async () => {
  const stub = installFetch([
    ['dispatch_week=lt.13', { body: [] }],
    ['claim_activation_token', { body: [{ id: 'token-id' }] }],
    ['release_activation_token', { body: null }],
    ['participant_sessions', { body: { message: 'boom' }, status: 500 }],
  ]);
  try {
    const response = await worker.fetch(post('/api/activate', goodActivation), makeEnv());
    assert.equal(response.status, 500);
    const data = await response.json();
    assert.ok(!JSON.stringify(data).includes('boom'), 'upstream detail must not reach the client');
    assert.ok(data.reference, 'a reference is returned so the log line can be found');
    assert.equal(stub.calls.filter((c) => c.url.includes('release_activation_token')).length, 1);
  } finally { stub.restore(); }
});

async function signedQuery(week, minutesAhead = 1440) {
  const expiry = Math.floor(Date.now() / 60000) + minutesAhead;
  const signature = await signPulseLink(SESSION.public_code, week, expiry, KEYS.LINK_SIGNING_KEY);
  return `?c=${SESSION.public_code}&w=${week}&e=${expiry}&s=${signature}`;
}

test('a session identifier on its own buys nothing', async () => {
  // The original design accepted a bare session id in the body and wrote scores
  // for it. Here there is no route that will take one.
  const stub = installFetch([['participant_sessions', { body: [SESSION] }]]);
  try {
    const response = await worker.fetch(post('/api/pulse', { sessionId: SESSION.id, weekNumber: 6, scores: [1, 1, 1, 1] }), makeEnv());
    assert.equal(response.status, 403);
    assert.equal(stub.calls.filter((c) => c.url.includes('srbai_logs')).length, 0);
  } finally { stub.restore(); }
});

test('a link with an altered week or a forged signature is refused', async () => {
  const stub = installFetch([['participant_sessions', { body: [SESSION] }]]);
  try {
    const query = await signedQuery(6);
    const tampered = query.replace('w=6', 'w=7');
    const forged = query.replace(/s=.{24}$/, `s=${'0'.repeat(24)}`);
    for (const q of [tampered, forged, '?c=ABCDEFGH1234&w=6&e=99999999&s=x']) {
      const response = await worker.fetch(post(`/api/pulse${q}`, { scores: [2, 2, 2, 2] }), makeEnv());
      assert.equal(response.status, 403);
    }
    assert.equal(stub.calls.filter((c) => c.url.includes('srbai_logs')).length, 0);
  } finally { stub.restore(); }
});

test('an expired link is refused', async () => {
  const stub = installFetch([['participant_sessions', { body: [SESSION] }]]);
  try {
    const query = await signedQuery(6, -10);
    const response = await worker.fetch(post(`/api/pulse${query}`, { scores: [2, 2, 2, 2] }), makeEnv());
    assert.equal(response.status, 403);
  } finally { stub.restore(); }
});

test('a valid link records the week and reports the change from baseline', async () => {
  const stub = installFetch([
    ['srbai_logs?session_id', { body: [{ week_number: 6, total_score: 8 }, { week_number: 5, total_score: 12 }] }],
    ['srbai_logs', { body: null, status: 201 }],
    ['participant_sessions', { body: [SESSION] }],
  ]);
  try {
    const query = await signedQuery(6);
    const response = await worker.fetch(post(`/api/pulse${query}`, { scores: [2, 2, 2, 2] }), makeEnv());
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.week, 6);
    assert.equal(data.total, 8);
    assert.equal(data.baseline, 24);
    assert.equal(data.change, -16);
    // Week 6 is before the minimum week, so nothing graduates here.
    assert.equal(data.graduated, false);
  } finally { stub.restore(); }
});

test('a fabricated total cannot be posted, only the four items count', async () => {
  const stub = installFetch([
    ['srbai_logs?session_id', { body: [] }],
    ['srbai_logs', { body: null, status: 201 }],
    ['participant_sessions', { body: [SESSION] }],
  ]);
  try {
    const query = await signedQuery(6);
    await worker.fetch(post(`/api/pulse${query}`, { scores: [5, 5, 5, 5], total: 4, total_score: 4 }), makeEnv());
    const written = JSON.parse(stub.calls.find((c) => c.url.includes('srbai_logs') && c.method === 'POST').body);
    assert.equal(written.total_score, 20);
  } finally { stub.restore(); }
});

test('submitting the same week twice does not overwrite the first reading', async () => {
  const stub = installFetch([
    ['srbai_logs', { body: { message: 'duplicate key' }, status: 409 }],
    ['participant_sessions', { body: [SESSION] }],
  ]);
  try {
    const query = await signedQuery(6);
    const response = await worker.fetch(post(`/api/pulse${query}`, { scores: [2, 2, 2, 2] }), makeEnv());
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /already recorded/);
  } finally { stub.restore(); }
});

test('scores outside one to seven never reach the database', async () => {
  const stub = installFetch([['participant_sessions', { body: [SESSION] }]]);
  try {
    const query = await signedQuery(6);
    const response = await worker.fetch(post(`/api/pulse${query}`, { scores: [9, 9, 9, 9] }), makeEnv());
    assert.equal(response.status, 400);
    assert.equal(stub.calls.filter((c) => c.url.includes('srbai_logs')).length, 0);
  } finally { stub.restore(); }
});

test('a finished protocol accepts nothing further', async () => {
  const stub = installFetch([['participant_sessions', { body: [{ ...SESSION, is_graduated: true }] }]]);
  try {
    const query = await signedQuery(6);
    const response = await worker.fetch(post(`/api/pulse${query}`, { scores: [2, 2, 2, 2] }), makeEnv());
    assert.equal(response.status, 410);
  } finally { stub.restore(); }
});

test('pulse context returns the behaviour so the page asks about the right thing', async () => {
  const stub = installFetch([['participant_sessions', { body: [SESSION] }]]);
  try {
    const query = await signedQuery(6);
    const response = await worker.fetch(
      new Request(`https://protocol.example.com/api/pulse-context${query}`), makeEnv(),
    );
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.behaviour, 'checking my phone in bed');
    assert.equal(data.week, 6);
  } finally { stub.restore(); }
});

async function twilioPost(params, env, signature) {
  const body = new URLSearchParams(params);
  return new Request('https://protocol.example.com/api/sms/inbound', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Twilio-Signature': signature,
      'CF-Connecting-IP': '203.0.113.10',
    },
    body: body.toString(),
  });
}

/** Sign the way Twilio does, so a genuine webhook can be simulated. */
async function twilioSignature(authToken, url, params) {
  let data = url;
  for (const key of Object.keys(params).sort()) data += key + params[key];
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(authToken), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  return btoa(String.fromCharCode(...sig));
}

test('a forged inbound message cannot stop or erase anyone', async () => {
  const stub = installFetch([]);
  try {
    const env = makeEnv();
    for (const keyword of ['STOP', 'DELETE']) {
      const response = await worker.fetch(
        await twilioPost({ From: '+447700900123', Body: keyword }, env, 'not-a-signature'), env,
      );
      assert.equal(response.status, 403);
    }
    assert.equal(stub.calls.length, 0, 'nothing may be written on a failed signature check');
  } finally { stub.restore(); }
});

test('a genuine STOP stops the messages', async () => {
  const stub = installFetch([['participant_sessions', { body: null, status: 204 }]]);
  try {
    const env = makeEnv();
    const params = { From: '+447700900123', Body: 'Stop ' };
    const signature = await twilioSignature(
      env.TWILIO_AUTH_TOKEN, 'https://protocol.example.com/api/sms/inbound', params,
    );
    const response = await worker.fetch(await twilioPost(params, env, signature), env);
    assert.equal(response.status, 200);

    const patch = stub.calls.find((c) => c.method === 'PATCH');
    assert.ok(patch, 'an opt-out must be written');
    assert.equal(JSON.parse(patch.body).sms_opted_out, true);
    // The lookup must use the keyed hash, never the number itself.
    assert.ok(!patch.url.includes('447700900123'));
    assert.ok(patch.url.includes(await hmacHex(KEYS.PHONE_PEPPER, '+447700900123')));
  } finally { stub.restore(); }
});

test('a genuine DELETE erases the record', async () => {
  const stub = installFetch([['erase_participant', { body: 1 }]]);
  try {
    const env = makeEnv();
    const params = { From: '+447700900123', Body: 'DELETE' };
    const signature = await twilioSignature(
      env.TWILIO_AUTH_TOKEN, 'https://protocol.example.com/api/sms/inbound', params,
    );
    const response = await worker.fetch(await twilioPost(params, env, signature), env);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /deleted/);
    assert.equal(stub.calls.filter((c) => c.url.includes('erase_participant')).length, 1);
  } finally { stub.restore(); }
});

test('an unknown endpoint is a plain 404', async () => {
  const response = await worker.fetch(
    new Request('https://protocol.example.com/api/nope', { method: 'POST' }), makeEnv(),
  );
  assert.equal(response.status, 404);
});

test('API responses carry the security headers and are never cached', async () => {
  const response = await worker.fetch(new Request('https://protocol.example.com/healthz'), makeEnv());
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
});

test('the weekly cron only runs at 18:00 London and never texts twice', async () => {
  const env = makeEnv();
  const session = { ...SESSION, dispatch_week: 5, started_at: '2026-05-03T09:00:00Z' };
  // Encrypt a number the way activation would, so the cron can decrypt it.
  const { encryptPhone } = await import('../src/crypto.js');
  session.encrypted_phone = await encryptPhone('+447700900123', KEYS.ENCRYPTION_KEY, session.token_hmac);

  const wrongHour = installFetch([['participant_sessions', { body: [session] }]]);
  try {
    await worker.scheduled({ scheduledTime: Date.parse('2026-07-05T18:00:00Z') }, env);
    assert.equal(wrongHour.calls.length, 0, 'nothing should happen at 19:00 British Summer Time');
  } finally { wrongHour.restore(); }

  let page = 0;
  const rightHour = installFetch([
    ['dispatch_log', { body: null, status: 201 }],
    ['participant_sessions?is_graduated', () => ({ body: page++ === 0 ? [session] : [] })],
    ['participant_sessions', { body: null, status: 204 }],
    ['api.twilio.com', { body: { sid: 'SM1' } }],
  ]);
  try {
    await worker.scheduled({ scheduledTime: Date.parse('2026-07-05T17:00:00Z') }, env);
    const reserved = rightHour.calls.filter((c) => c.url.includes('dispatch_log') && c.method === 'POST');
    assert.equal(reserved.length, 1, 'exactly one send is reserved');
    // Started 3 May, running on 5 July: nine weeks elapsed, not six.
    assert.equal(JSON.parse(reserved[0].body).week_number, 9);
  } finally { rightHour.restore(); }
});

test('the cron does not text a participant who has opted out', async () => {
  const stub = installFetch([['participant_sessions', { body: [] }]]);
  try {
    await worker.scheduled({ scheduledTime: Date.parse('2026-07-05T17:00:00Z') }, makeEnv());
    const query = stub.calls.find((c) => c.url.includes('participant_sessions')).url;
    // Excluded in the query, so a change to the loop cannot reintroduce them.
    assert.ok(query.includes('sms_opted_out=eq.false'));
    assert.ok(query.includes('is_graduated=eq.false'));
  } finally { stub.restore(); }
});

test('a failed send advances the week instead of stranding the participant', async () => {
  const env = makeEnv({ SMS_DRY_RUN: undefined });
  const { encryptPhone } = await import('../src/crypto.js');
  const session = {
    ...SESSION,
    dispatch_week: 5,
    started_at: '2026-05-03T09:00:00Z',
    encrypted_phone: await encryptPhone('+447700900123', KEYS.ENCRYPTION_KEY, SESSION.token_hmac),
  };

  let page = 0;
  const stub = installFetch([
    ['dispatch_log', { body: null, status: 201 }],
    ['participant_sessions?is_graduated', () => ({ body: page++ === 0 ? [session] : [] })],
    ['participant_sessions', { body: null, status: 204 }],
    ['api.twilio.com', { body: { message: 'carrier rejected' }, status: 400 }],
  ]);
  try {
    await worker.scheduled({ scheduledTime: Date.parse('2026-07-05T17:00:00Z') }, env);
    const advance = stub.calls.find((c) => c.method === 'PATCH' && c.url.includes('participant_sessions'));
    assert.ok(advance, 'the dispatch week must advance even though the send failed');
    assert.equal(JSON.parse(advance.body).dispatch_week, 9);
    // The reservation is never confirmed, so the log records what really happened.
    const confirms = stub.calls.filter((c) => c.method === 'PATCH' && c.url.includes('dispatch_log'));
    assert.equal(confirms.length, 0);
  } finally { stub.restore(); }
});
