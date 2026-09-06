# The Discontinuity Protocol

A thirteen-week, ninety-one-day protocol for discontinuing a named habit. A
printed A5 ledger, a weekly text with a signed link, and four questions that
produce one number a week.

The measure is the **SRBAI**, the four-item Self-Report Behavioural Automaticity
Index (Gardner, Abraham, Lally and de Bruijn, 2012), drawn from the twelve-item
SRHI (Verplanken and Orbell, 2003). A **falling** score is the goal.

- [`docs/AUDIT.md`](docs/AUDIT.md) — every defect found in the 1.0 draft and what changed.
- [`docs/MARKET-STRESS-TEST.md`](docs/MARKET-STRESS-TEST.md) — where this loses to the market and what to do about it.
- [`docs/CONFIDENCE-AND-RISK.md`](docs/CONFIDENCE-AND-RISK.md) — how far to trust each finding, the case for the original design, and a launch pre-mortem.
- [`print/LEDGER_SPECS.md`](print/LEDGER_SPECS.md) — the print specification, corrected.

## Layout

```
src/worker.js      routes and the weekly cron
src/protocol.js    graduation rule, dispatch timing, participant copy (pure, tested)
src/crypto.js      HMAC, AES-GCM, link signing, Twilio signature (pure, tested)
src/validate.js    input rules (pure, tested)
src/db.js          Supabase access, every response status-checked
src/twilio.js      SMS dispatch and TwiML
db/schema.sql      tables, constraints, RLS, atomic token claim, erasure
public/            three pages, one stylesheet, three modules, nothing third-party
scripts/           activation-code generator
test/              67 tests, including a stubbed end-to-end suite
```

## How it runs

1. A ledger carries one printed ten-character code under a scratch-off panel.
2. The participant enters the code, a UK mobile, **the behaviour they are
   discontinuing**, and four Day 0 scores. The code is claimed atomically and
   cannot be reused.
3. Every Sunday at 18:00 London the cron works out which week each participant is
   actually due from elapsed time, reserves the send, and texts a signed link
   that expires in nine days.
4. Each week is recorded once. Resubmitting returns a 409 rather than overwriting.
5. Graduation requires three consecutive weeks at or below the threshold, and not
   before week 8.
6. Replying STOP ends messages. Replying DELETE erases the record and every
   reading.

## Deployment

```bash
npm install
npx wrangler kv namespace create THROTTLE          # put the ids in wrangler.toml
```

Run `db/schema.sql` in the Supabase SQL editor. Confirm afterwards that RLS is on
for all four tables and that no policies exist.

Set every secret. Generate the four keys separately: reusing one value across
purposes means a single leak compromises stored numbers, link signing and code
lookup at once, and the Worker refuses to start if it detects reuse.

```bash
for name in ENCRYPTION_KEY PHONE_PEPPER TOKEN_PEPPER LINK_SIGNING_KEY; do
  openssl rand -hex 32 | npx wrangler secret put "$name"
done
npx wrangler secret put SUPABASE_SERVICE_KEY
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
```

Edit the `[vars]` block in `wrangler.toml`: `SUPABASE_URL`, `PUBLIC_ORIGIN`,
`TWILIO_PHONE_NUMBER`, `SUPPORT_EMAIL`. Then:

```bash
npm test
npx wrangler deploy
curl -s https://<your-origin>/healthz     # {"ok":true,"issues":0}
```

Point the Twilio number's inbound message webhook at
`https://<your-origin>/api/sms/inbound` (HTTP POST). The URL must match
`PUBLIC_ORIGIN` exactly, because that is what the signature is checked against.

### Key custody

Read this before printing anything. Two of the seven secrets have no recovery
path, and losing either is the only failure in this system that cannot be fixed
afterwards.

- **`TOKEN_PEPPER`.** Change it or lose it and every code in every printed batch
  stops working at once. The database holds hashes, and the clear codes were
  destroyed after the print run exactly as the process instructs. There is no
  way back.
- **`ENCRYPTION_KEY`.** Lose it and no stored mobile number can be decrypted, so
  nobody can be texted again. The protocol stops dead for every participant
  simultaneously, mid-cohort.

The control costs nothing and takes ten minutes: **before the first print run,
write both values down and hold two independent offline copies with two
different people.** Do this on the day they are generated, not later.

The other five secrets can be rotated at any time. Rotating `LINK_SIGNING_KEY`
invalidates audit links already in flight, so do it just after a Sunday send
rather than just before one.

Generate a batch:

```bash
TOKEN_PEPPER=<the same value as the secret> npm run tokens -- 500 batch-2026-10
```

Two files appear. The CSV holds clear codes and goes to the printer only, over an
agreed secure channel, and is destroyed after the run. The SQL holds hashes and
is what Supabase gets. Both are gitignored; check before committing anyway.

## Before the first real cohort

- [ ] `/healthz` returns `ok`.
- [ ] **Use a long code or short code, not an alphanumeric sender ID.**
      Alphanumeric senders are one-way, so STOP and DELETE would silently never
      arrive while outbound texts kept working.
- [ ] Send an inbound STOP and an inbound DELETE from a real handset and confirm
      both take effect.
- [ ] Confirm a forged inbound POST without a valid signature is rejected.
- [ ] Activate a test ledger, then confirm the same code is refused a second time.
- [ ] Confirm the same mobile cannot start two protocols at once.
- [ ] Submit one week twice and confirm the second attempt returns 409.
- [ ] Confirm an expired or edited link is refused.
- [ ] Watch one live Sunday dispatch and check the send time against the clock,
      in both British Summer Time and GMT.
- [ ] Have the privacy notice reviewed and every placeholder filled.
- [ ] Set `GRADUATION_THRESHOLD` from pilot data and publish the definition
      before the cohort starts.
- [ ] Set `ALERT_WEBHOOK_URL`, then confirm a heartbeat arrives after a run.
      A weekly job with no heartbeat is one you hear about from a customer.
- [ ] Two offline copies of `TOKEN_PEPPER` and `ENCRYPTION_KEY`, held by two
      people. See **Key custody** above.
- [ ] Run about twenty people through the software with a PDF and twenty codes
      before committing to a print run. It costs a fortnight and settles the
      three numbers the product rests on: activation rate, drop-off curve and
      the achievable threshold.

## Tests

```bash
npm test
```

Sixty-seven tests. Thirty-seven cover the protocol rules, the cryptography and
the input validation, including Twilio's own published signature vector.
Thirty drive the Worker end to end with Supabase and Twilio stubbed at the
fetch boundary, and assert the negatives that matter: that a bare session
identifier buys nothing, that a rejected activation does not burn a printed
code, that a forged webhook writes nothing, that an upstream error message never
reaches the client.

They do not touch the network. Nothing in this build has been run against a live
Supabase, Twilio or Cloudflare account.
