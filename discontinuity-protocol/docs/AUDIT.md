# Build audit: what was wrong with version 1.0 and what changed

Every item below was present in the 1.0 monolith. Severity is the effect if the
draft had been deployed as written, not the effort to fix it.

Marked **[verify]** where a claim depends on law, a vendor policy or a figure
that should be confirmed against the primary source before anyone relies on it.

---

## 1. Would not have run at all

| # | Finding | Severity |
|---|---|---|
| 1 | `wrangler.toml` used `[site] bucket` but the Worker called `env.ASSETS.fetch()`. `[site]` creates a `__STATIC_CONTENT` binding, not `ASSETS`. Every page load throws. | Blocker |

Fixed by moving to `[assets]` with an explicit `binding = "ASSETS"`.

---

## 2. Secrets and access control

| # | Finding | Severity |
|---|---|---|
| 2 | Six live secrets in `[vars]` in a committed file: Supabase key, Twilio SID and auth token, and the AES key. Anyone with repository read access, and anyone who ever forked or mirrored it, has them all. A committed key is compromised the moment it lands, and rotating it later does not un-publish the history. | Critical |
| 3 | The Supabase **anon** key was used for every privileged write, and the schema defined **no row-level security**. The anon key is designed to be public. With RLS off, publishing it gives the world read and write on every table. | Critical |
| 4 | `POST /api/pulse` took a `sessionId` from the request body and trusted it. No signature, no ownership check. Anyone with a session UUID could post scores for that participant and, with two low scores, mark them graduated, which also silently ends their protocol. Session UUIDs travelled by SMS, sat in browser history and leaked in the `Referer` header. | Critical |
| 5 | `Access-Control-Allow-Origin: *` on state-changing endpoints. | High |
| 6 | Errors returned `err.message` to the caller: Postgres constraint text, upstream hostnames, internal detail. | High |
| 7 | No rate limiting anywhere. The activation code is a bearer credential, so the endpoint was an open enumeration oracle. | High |

Fixed by: every secret via `wrangler secret`, `.dev.vars` gitignored, a startup
configuration check that refuses to serve rather than run half-configured; the
service-role key only, with RLS enabled and no policies so a leaked publishable
key reaches nothing; signed pulse links that bind session, week and expiry;
same-origin only; generic client errors with a log reference; KV-backed throttles
on both write endpoints.

---

## 3. Cryptography

| # | Finding | Severity |
|---|---|---|
| 8 | `encryptPhone` caught its own failure and returned `btoa(plainText)`. A malformed key therefore stored every mobile number in clear text, base64-wrapped, while the code reported success. `decryptPhone` had the mirror-image fallback. This is the worst kind of bug: it makes a catastrophic failure look like a working system. | Critical |
| 9 | Phone numbers hashed with bare SHA-256. The UK mobile space is about 10^9 numbers. A laptop enumerates it in minutes, so the hash is a reversible encoding, not a protection. | High |
| 10 | Activation codes hashed with bare SHA-256. A six-character code has too little entropy to survive an offline search of a leaked table. | High |
| 11 | Ciphertext was not bound to its row, so a stolen ciphertext could be written into another participant's record to redirect their messages. | Medium |
| 12 | No key-format validation, no versioning, so key rotation had no path. | Medium |

Fixed by: no fallbacks, every failure throws; HMAC-SHA256 with separate peppers
for phone and token lookups; AES-256-GCM with the row's token hash as additional
authenticated data; a `v1.` ciphertext prefix; key validation at startup,
including a check that the four keys are actually distinct.

---

## 4. Correctness and data integrity

| # | Finding | Severity |
|---|---|---|
| 13 | `verifyAndDeactivateToken` did a SELECT then a PATCH. Classic time-of-check to time-of-use race: two simultaneous requests both pass, and two people activate one printed ledger. | High |
| 14 | No response in `db.js` checked `res.ok`. `insertSrhiLog` computed a total and returned it whether or not the row was written, so a rejected insert reported a successful week. | High |
| 15 | `createSession` returned `data[0]` with no check. A failed insert made it `undefined`, and the next line threw. By then the token was already spent, so the participant permanently lost the ledger they had paid for. | High |
| 16 | `total_score` was accepted alongside the four items with nothing tying them together, so a caller could post four sevens and a total of four. | High |
| 17 | No unique constraint on `(session_id, week_number)`. A resubmitted week wrote a second row, and two rows for the same week satisfied the "two consecutive weeks" graduation test on their own. | High |
| 18 | No input validation. Scores went straight to a `CHECK` constraint, so a bad value became a 500 carrying Postgres text. | High |
| 19 | No idempotency on dispatch. A cron retry or an overlapping run texted people twice. | Medium |

Fixed by: a single conditional `UPDATE` in `claim_activation_token`; every
response status-checked; a compensating `release_activation_token` so a failure
after the claim returns the ledger to the participant; a database `CHECK` that
the total equals the sum of its items; `UNIQUE (session_id, week_number)` and a
409 on repeat; strict validation before anything touches the database; a
`dispatch_log` row reserved before each send.

---

## 5. Money and abuse

| # | Finding | Severity |
|---|---|---|
| 20 | The activation endpoint accepted any string as a phone number and passed it to Twilio. Combined with no rate limit, that is an open SMS gateway. Pumping traffic to expensive international ranges is a known and industrialised way to monetise this exact shape of endpoint, and the bill arrives on the operator's account. | Critical |
| 21 | `sendSMS` returned `true` and logged to the console whenever credentials were absent. In production that means every participant receives nothing while the system reports success. | High |
| 22 | No message-length awareness. A link long enough to push a message to three segments triples the cost of every send, silently. | Low |

Fixed by: strict E.164 with an operator-controlled prefix allowlist, defaulting
to `+44` and rejecting UK landlines; per-address throttles; dry-run only when
explicitly enabled, missing credentials now a hard error; a segment counter with
a test that keeps the weekly message inside two segments.

---

## 6. Protocol logic

| # | Finding | Severity |
|---|---|---|
| 23 | Graduation needed two logs at or below 8, with no check that they were consecutive weeks and no minimum week. A participant could complete a ninety-day protocol in a fortnight. | High |
| 24 | `current_week` advanced when the text was *sent*, not by elapsed time. Someone activating on a Saturday was asked for a week-two reading the next evening, one day in. A missed week advanced the counter anyway, so the readings no longer matched the weeks. | High |
| 25 | The cron was `0 18 * * SUN`. Cloudflare cron is UTC. For the seven months of British Summer Time the message arrives at 19:00 while its own text says 18:00. | Medium |
| 26 | **No target behaviour was ever captured or referred to anywhere.** All four items ask about "this action" and nothing named it, on screen or on paper. Four numbers about an unnamed thing measure nothing, and a participant thinking about a different behaviour each week produces a trend line that looks like progress and is noise. This is the largest single hole in the 1.0 design, and it is a product hole, not a code one. | Critical |
| 27 | The weekly page abbreviated the items ("Done automatically?") while the baseline page used full wording. The baseline and the weekly readings were therefore not answers to the same questions. | High |
| 28 | Twelve weeks is 84 days. The product is called 90-day. | Medium |
| 29 | The magic link hardcoded `protocol.disruptor.com`, which appears nowhere else in the build. | Medium |
| 30 | Nothing told the participant that a high score is the expected starting point. For a discontinuation protocol a falling number is success, and the copy read like a score to improve. | Medium |

Fixed by: graduation requires three consecutive weeks at or below the threshold
and not before week 8; dispatch week derived from elapsed time with no backlog
sent; two UTC cron hours with a `Europe/London` gate so only the real 18:00
fires; a behaviour that is written on page 1 of the ledger, confirmed at
activation and restated in the participant's own hand on every weekly spread,
without the text ever reaching the store; identical full item wording in both places and in `protocol.js`;
13 weeks across 91 days stated consistently everywhere; the origin from
configuration; explicit copy about which direction the number should move.

---

## 7. Measurement and claims

| # | Finding | Severity |
|---|---|---|
| 31 | The four items were called the **SRHI** and credited to Verplanken. They are the **SRBAI** (Gardner, Abraham, Lally and de Bruijn, 2012), the four-item automaticity index derived from the twelve-item SRHI (Verplanken and Orbell, 2003). An evidence-led product that misnames its own instrument loses the argument with the readers most likely to buy it. **[verify]** Confidence: high on the SRBAI being the four-item measure; check the exact item wording against the published article before print. | High |
| 32 | The schema was labelled "Zero PII". An encrypted mobile number is personal data under UK GDPR, and so is a keyed hash of one. Writing "zero PII" into a schema tends to put it into a DPIA, a contract and a marketing page, where it becomes a misrepresentation. | High |
| 33 | The exit threshold of 8 out of 28 means a mean of 2 on a 1 to 7 scale. If most participants cannot reach it, most paying customers finish the protocol having formally failed. That is a refund and review problem, not a code problem. See the market note. | Medium |

Fixed by: SRBAI named correctly in the schema, the code, the pages and the print
spec, with full references and a correction note; the store described as
pseudonymised with the reasoning written into the schema; the threshold moved to
configuration with a recommendation to set it from pilot data.

---

## 8. Legal and data protection

| # | Finding | Severity |
|---|---|---|
| 34 | No consent capture for the weekly texts, and no record of it. | High |
| 35 | No STOP handling and no inbound webhook at all. Carrier and vendor rules require opt-out handling, and UK PECR governs unsolicited messages. **[verify]** these against Twilio's current UK requirements and your own advice. | High |
| 36 | No privacy notice, so no UK GDPR Article 13 information was given at the point of collection. | High |
| 37 | No erasure path and no retention period. | High |
| 38 | Had an inbound webhook existed without signature verification, anyone could have forged a STOP or a deletion for any number. | High |

Fixed by: a required consent checkbox with `consent_recorded_at` stored; an
inbound webhook with Twilio signature verification, tested against Twilio's own
published reference vector, handling STOP, START, HELP and DELETE; a drafted
Article 13 notice at `/privacy.html` with placeholders marked for legal review;
erasure by replying DELETE from the handset, which proves control of the number
without collecting identity documents that would then need storing.

---

## 9. Front end

| # | Finding | Severity |
|---|---|---|
| 39 | Tailwind loaded from a third-party CDN at runtime. That script is on the page that carries the signed audit link, and the page breaks entirely behind a corporate proxy that blocks the CDN. | Medium |
| 40 | `alert()` for every outcome, including failure. | Medium |
| 41 | No double-submit guard, so a slow network produced two activations and the second reported the code as already used. | Medium |
| 42 | The pulse page read `wk` from the URL and trusted it, defaulting to `'2'`. | Medium |
| 43 | No `Referrer-Policy`, no CSP, no `X-Frame-Options`. | Medium |
| 44 | Sliders had no accessible value announcement. | Low |

Fixed by: one local stylesheet and local ES modules, nothing third-party; inline
messages in a live region; a disabled submit while in flight; the week taken from
the signed link and verified server-side; a strict CSP, `no-referrer` and frame
denial on every page and in the Worker's asset path; `aria-valuetext` on each
slider.

---

## 10. Print specification

Twelve findings, listed with their resolutions in
[`print/LEDGER_SPECS.md` section 8](../print/LEDGER_SPECS.md). The two that
change production planning rather than wording:

- **The pagination did not add up.** Pages 16 to 103 is 88 pages; twelve weeks at
  two pages each is 24. The spec was unprintable as written.
- **A unique code per copy is variable data.** It cannot come off a single
  spot-colour plate, and printed on a visible page it can be read and used from a
  display copy before the book is ever sold.

---

## 10a. Found on the second review of this build, not in the 1.0 draft

Six defects introduced or left open by the first pass of this rebuild, found by
re-reading it as an opponent would.

| Finding | Effect | Fix |
|---|---|---|
| The partial unique index treated any non-graduated session as live for ever. A participant who ran all thirteen weeks without reaching the threshold could never buy a second ledger, which is precisely the customer most likely to want one. | Lockout | `dispatch_week < 13` added to the index predicate, and the pre-check query now mirrors the index exactly. |
| A failed send left the week reserved but the counter unadvanced. Because the due week comes from elapsed time, that week never came round again and the participant received nothing for the rest of the protocol. | Silent total failure for that participant | The counter advances as soon as the send is reserved. A failed send costs one link, not the remaining protocol. |
| Throttling charged every request to the caller's address. Mobile networks and company offices share addresses, so a team rolling this out would have locked itself out while an attacker rotating addresses was barely slowed. | Denial of service against legitimate users | Only failed attempts spend budget, and the limit rose to fifteen an hour. |
| The activation text repeated the named behaviour, so a lock screen could read "Behaviour logged: vaping at my desk" to whoever was standing nearby. It also pushed the message towards a third charged segment. | Privacy disclosure and cost | The behaviour appears only on the page and in the ledger. A test asserts it stays out of every message. |
| The cron read up to 500 participants in one invocation, ordered oldest first. Past the Worker's subrequest budget the newest joiners would simply never be texted, with nothing in the log to say so. | Silent starvation at scale | Paged reads, a documented ceiling of 200 per run, and a capacity warning in the log when it is reached. |
| Static assets are served ahead of the Worker, so security headers set in `worker.js` never applied to the pages themselves. | Missing headers where they matter most | A `public/_headers` file, kept alongside the CSP meta tag on each page. |

---

## 11. Known limits of this build

Stated plainly, because a fix list that claims completeness is its own defect.

- **Not deployed and not run against live services.** The 69 tests cover pure
  logic, cryptography, validation and the Worker's routes with Supabase and
  Twilio stubbed. Nothing here has run against a real Supabase, Twilio or
  Cloudflare account.
- **Dispatch is bounded at 200 participants per weekly run.** Beyond that the
  cron logs a capacity warning rather than silently dropping people, and the
  send should move to Cloudflare Queues. That threshold is an estimate from the
  per-invocation subrequest budget and has not been measured. **[verify]**
- **KV throttling is eventually consistent.** The effective limit can drift above
  the configured one across data centres. It bounds an attack; it does not
  enforce an exact number. Cloudflare's native rate-limiting binding is the
  stricter option.
- **The privacy notice is a draft.** It needs a data protection adviser, a real
  retention period and completed placeholders.
- **Compliance items marked [verify] are exactly that.** GPSR, EUDR, PECR and
  Twilio's UK registration requirements move, and this build should not be the
  source of truth for any of them.
- **The exit threshold is unvalidated.** 8 out of 28 is inherited from the draft.
  It should be set from pilot data, not from a round number.
- **The exact wording of the fourth SRBAI item needs checking against the
  published article.** It is the lowest-confidence factual claim in the build,
  and it is the same class of error this audit criticises in the draft. See
  [`CONFIDENCE-AND-RISK.md`](CONFIDENCE-AND-RISK.md) Part 1.
- **The behaviour is fixed on paper, not in the database.** An earlier pass of
  this rebuild made it a required stored field, which fixed the measurement and
  added free text about someone's private life to a store that otherwise holds a
  mobile number and fourteen sets of four numbers. It is now a declaration:
  the participant writes it on page 1, ticks to confirm, and every weekly page
  points them back to it. A test asserts that no habit text can reach the store
  through any field. The reasoning is in Part 2 of
  [`CONFIDENCE-AND-RISK.md`](CONFIDENCE-AND-RISK.md).
