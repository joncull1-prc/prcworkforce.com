/**
 * HTTP helpers: responses, security headers, throttling.
 */

/**
 * The original design sent Access-Control-Allow-Origin: * on state-changing
 * routes, which invites any page on the internet to drive the API in a
 * visitor's session. The pages and the API share one origin, so cross-origin
 * access is simply never granted.
 */
export function securityHeaders() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
}

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...securityHeaders(), ...extraHeaders },
  });
}

/**
 * Client-facing errors never carry an exception message. The draft returned
 * err.message, which hands out Postgres constraint text, upstream hostnames
 * and stack detail. The reference goes to the log instead.
 */
export function problem(status, message, reference, extraHeaders = {}) {
  return json(
    reference ? { error: message, reference } : { error: message },
    status,
    extraHeaders,
  );
}

/** 429 with the header clients and crawlers actually respect. */
export function tooManyRequests(message, retryAfterSeconds) {
  return problem(429, message, undefined, { 'Retry-After': String(retryAfterSeconds) });
}

/**
 * Applied to every static page. Referrer-Policy matters most on the pulse page:
 * without it, the signed link is sent in the Referer header to every third
 * party the page contacts.
 */
export const CONTENT_SECURITY_POLICY = "default-src 'none'; script-src 'self'; "
  + "style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; "
  + "form-action 'none'; frame-ancestors 'none'";

export function pageHeaders(contentType = 'text/html; charset=utf-8') {
  return {
    'Content-Type': contentType,
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

/**
 * Fixed-window throttle backed by Workers KV.
 *
 * Purpose on /api/activate: a printed code is a bearer credential, so without
 * a limit an attacker enumerates codes until one activates and steals a ledger.
 * Purpose on /api/pulse: caps forgery attempts against a signed link.
 *
 * KV is eventually consistent, so the effective limit can drift slightly above
 * the configured one across data centres. That is acceptable for abuse control:
 * it turns an unbounded attack into a bounded one. Cloudflare's native rate
 * limiting binding is the stricter option if exactness ever matters.
 */
function windowKey(bucket, identifier, windowSeconds) {
  return `rl:${bucket}:${identifier}:${Math.floor(Date.now() / (windowSeconds * 1000))}`;
}

/**
 * Read the budget without spending it.
 *
 * Checking and spending are separate calls so that only FAILED attempts consume
 * budget. Charging every request would punish shared addresses: a company
 * rolling the protocol out to a team sits behind one address, as do most mobile
 * networks, and a single counter would lock out the legitimate majority while
 * barely inconveniencing an attacker who can rotate addresses.
 */
export async function throttleCheck(kv, bucket, identifier, limit, windowSeconds) {
  if (!kv) return { allowed: true, remaining: limit };
  const used = Number((await kv.get(windowKey(bucket, identifier, windowSeconds))) || 0);
  return { allowed: used < limit, remaining: Math.max(0, limit - used) };
}

/** Spend one unit of budget. Called after a rejected attempt, never after a good one. */
export async function throttleRecord(kv, bucket, identifier, windowSeconds) {
  if (!kv) return;
  const key = windowKey(bucket, identifier, windowSeconds);
  const used = Number((await kv.get(key)) || 0);
  await kv.put(key, String(used + 1), { expirationTtl: Math.max(60, windowSeconds * 2) });
}

/** Best-effort client address, used only as a throttling key. */
export function clientKey(request) {
  const forwarded = request.headers.get('X-Forwarded-For');
  return request.headers.get('CF-Connecting-IP')
    || (forwarded ? forwarded.split(',')[0].trim() : null)
    || 'unknown';
}

/** Correlates a generic client error with the detailed server-side log line. */
export function newReference() {
  return crypto.randomUUID().slice(0, 8);
}
