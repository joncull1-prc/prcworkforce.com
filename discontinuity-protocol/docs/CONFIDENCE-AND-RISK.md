# Confidence ratings, the case for the 1.0 design, and a launch pre-mortem

Three things the audit does not cover: how much to trust each finding, what the
original draft got right that this rebuild risks losing, and what would actually
kill the first cohort.

---

## Part 1: Confidence, finding by finding

Scale:

- **Certain** — proved by a test in this repository, or plain arithmetic.
- **High** — I would act on it without checking first.
- **Medium** — probably right, but check it before it costs money or goes to press.
- **Low** — a judgement call. Reasonable people would decide differently.

Two separate questions are rated where they differ: whether the **defect** was
real, and whether the **fix** is the right one.

### Code and configuration

| Finding | Defect real? | Fix right? | Note |
|---|---|---|---|
| `[site]` bucket with `env.ASSETS` breaks every page load | High | High | `[site]` creates `__STATIC_CONTENT`, not `ASSETS`. Not testable here without deploying. |
| Secrets committed in `[vars]` | Certain | Certain | Visible in the file. |
| Anon key used for privileged writes, no RLS in the schema | Certain | High | Postgres tables are RLS-off unless enabled, and Supabase exposes them to `anon`. |
| `/api/pulse` trusted a session id from the body | Certain | High | Tested: a bare session id now buys nothing. Truncating the signature to 96 bits is a deliberate trade for SMS length. |
| `encryptPhone` fell back to `btoa(plaintext)` | Certain | Certain | Both tested. |
| Unkeyed SHA-256 of phone numbers and short codes | Certain | Certain | Tested. The reversibility claim rests on the UK mobile space being about 10^9, which is arithmetic. |
| Token claim was a check-then-update race | Certain | High | The single conditional `UPDATE` is correct SQL. Not tested under real concurrency. |
| No response in the data layer checked `res.ok` | Certain | Certain | Tested. |
| Nothing tied `total_score` to its four items | Certain | Certain | Now a database `CHECK`, and tested at the API. |
| No unique constraint on `(session_id, week_number)` | Certain | High | Depends on PostgREST mapping a unique violation to HTTP 409. **Verify on first deploy.** |
| Graduation reachable in a fortnight, weeks never checked as consecutive | Certain | High on the logic, **Low on the numbers** | Three weeks and a week-8 floor are my choice, not evidence. See Part 2. |
| Week counter advanced on dispatch rather than elapsed time | Certain | High | Tested. Introduces its own dependency on a parseable `started_at`, which is handled. |
| Cron in UTC while the copy says 18:00 | High | High | Cloudflare cron is UTC. Tested across British Summer Time and GMT with the real timezone database. |
| No E.164 validation, so an open SMS gateway | Certain | High | The attack is well documented. The `+44` default is a policy choice, not a technical one. |
| No rate limiting | Certain | Medium | KV is eventually consistent, so the limit is approximate. It bounds an attack; it does not enforce a number. |
| `err.message` returned to the caller | Certain | Certain | Tested. |
| No consent, no STOP, no erasure, no privacy notice | Certain | High | The Twilio signature check is verified against Twilio's own published test vector, so that part is **Certain**. |
| Third-party CDN on the page carrying the signed link | Certain | High | |
| Dispatch ceiling of about 200 per run | Medium | Medium | Derived from the per-invocation subrequest budget, not measured. The warning in the log is the real safeguard. |

### Measurement and evidence

| Claim | Confidence | Note |
|---|---|---|
| The four-item measure is the SRBAI, not the SRHI | High | SRBAI is the four-item automaticity index (Gardner, Abraham, Lally and de Bruijn, 2012); SRHI is twelve items (Verplanken and Orbell, 2003). |
| **The exact wording of the four items** | **Medium. This is the lowest-confidence factual claim in the whole build.** | Items 1 to 3 I am confident of. **Item 4 is the doubtful one.** I used "would find it hard not to do", which is an SRHI item; the canonical SRBAI fourth item is more likely "something I do without thinking". Check the published article and correct `src/protocol.js`, `public/srbai.js` and the ledger together before anything is printed. Getting this wrong is the exact error the audit criticises the 1.0 draft for. |
| Lally et al. (2010): median 66 days, range roughly 18 to 254 | Medium-high | The median is well known. Check the range and the sample size in the paper before quoting either. |
| A falling automaticity score indicates a weakening habit | High | This is what the instrument is for. It is self-report, which is a real limitation and is stated on the page. |
| The exit threshold of 8 out of 28 is achievable for most people | **Low. Unknown.** | Inherited from the draft. Nobody has data. This is the largest commercial unknown in the product. |

### Print and compliance

| Claim | Confidence | Note |
|---|---|---|
| The 1.0 pagination did not add up | Certain | 103 − 16 + 1 = 88 pages allocated to 24 pages of content. |
| 128 pages is 8 sections of 16 | Certain | Arithmetic. |
| Cool Gray 11 C and #2C2C2C are different colours | High | Cool Gray 11 is a mid-dark neutral, roughly #53565A. |
| Pantone Black 7 U is the right substitute | Medium | A judgement from the intended hex. The instruction that matters is unchanged either way: the chip on a drawdown is the contract, not a hex value. |
| A C-suffix reference on uncoated stock prints lighter than the chip | High | Standard print practice. |
| Generic 120 gsm uncoated is not reliably fountain-pen safe | High | The required pen test removes the need to be certain. |
| Munken Pure Cream 120 gsm is a reasonable starting stock | Medium | A recommendation. The printer's tested alternative may be better. |
| Variable data cannot be printed from a fixed spot-colour plate | Certain | |
| A code on a visible page can be read from a display copy | Certain | |
| GPSR requires a named EU responsible person from 13 December 2024 | High that the obligation exists; **Medium** on how it applies to your route to market | Depends on whether you place product on the EU market and how. Take advice. |
| EUDR covers printed books under HS 4901 | Medium | Application dates have moved more than once. Verify. |
| FSC claims require a licence code and approved artwork | High | |

### Market claims

Everything in `MARKET-STRESS-TEST.md` is **Medium** on specifics and **High** on
the structural picture. Prices, feature sets and positioning move. Check every
competitor claim before it reaches a deck.

Two exceptions:

- **Alphanumeric sender IDs cannot receive replies: High.** This is the finding
  most worth acting on immediately, because it silently breaks consent
  withdrawal while the outbound texts keep working perfectly.
- **BestSelf's SELF Journal is a thirteen-week structure: Medium-high.** Enough
  to stop presenting "thirteen weeks" as a differentiator.

---

## Part 2: The case for the 1.0 design

Arguing for the draft, honestly, because some of what I changed was a trade and
not an improvement.

### It could have shipped this month

The draft is about six hundred lines and one person can hold all of it in their
head. My rebuild needs a KV namespace, seven secrets, two database functions, a
webhook with signature verification and a signed-link scheme. Every one of those
is something to configure wrongly at three in the morning. I raised the floor of
operational competence the product requires, and for a small operator that is a
real cost, not a free win.

### The short instrument was the right call

Four items rather than twelve. A twelve-item questionnaire every Sunday would
have destroyed response rates, and a protocol nobody answers measures nothing at
all. The draft picked correctly and then labelled it wrongly. The label was the
error, not the choice.

### The generous graduation rule had a commercial logic

Two low weeks and you are finished. I called it a hole, and scientifically it is
one. Commercially it is not obviously wrong. People who believe they succeeded
renew, refer and do not ask for refunds. My rule of three consecutive weeks with
a week-8 floor is more defensible and will produce fewer people who feel they
won. **That is a trade I imposed without being asked, and it is reversible:**
both numbers are configuration, not code.

### The unauthenticated link was frictionless

In a threat model where the product is small and nobody is attacking it, an
unsigned link that never expires generates no support tickets. My nine-day
expiry will produce a steady trickle of "my link says it is not valid". The
draft's version was wrong, but it was wrong in a direction that cost nothing
until someone cared enough to attack it.

### The cheaper book might be the right book

112 pages was a lighter, cheaper product. My 128-page cased hardback is a better
object and a worse margin, in a category where the brand leader sells for less.
The extra pages are justified by the arithmetic, which genuinely did not work.
The board, cloth and foil are not: those are a bet that the buyer will pay for a
physical object rather than for the measurement. **Test that bet before you
print it.**

### The strongest point: not storing the behaviour may have been deliberate

I treated the missing target behaviour as the largest hole in the design, and on
the measurement argument I stand by that: four scores about an unnamed thing
measure nothing.

But there is a real counter-argument, and it is a good one. The behaviour is
written on page 1 of a physical book that the participant controls. Keeping it
out of the database means the store holds a mobile number and fourteen numbers,
and nothing that describes anyone's private life. By making it a required stored
field I added free text about someone's drinking, vaping, scrolling or gambling
to a record I had otherwise worked hard to minimise. That is arguably more
sensitive than everything else in the row combined.

**Three ways to resolve it, and I would now recommend the third:**

1. Store it, as built. Simple, and the weekly page can restate it exactly.
2. Store a participant-chosen nickname only, "the desk thing", so the referent
   is stable and the store learns nothing.
3. **Store nothing, and have the weekly page say: "Rate the past seven days for
   the behaviour you wrote on page 1 of your ledger."** This keeps the whole
   point of the fix, which is that the participant rates one fixed thing every
   week, and gives up nothing except the convenience of seeing it on screen.

Option 3 is a genuine improvement over what I built, and it came out of arguing
for the draft rather than against it.

**This is now what the build does.** The `target_behaviour` column is gone. The
activation page asks the participant to write the behaviour on page 1 and tick to
confirm; only that boolean reaches the server. Every weekly page says "rate the
behaviour you wrote on page 1 of your ledger", and every weekly spread in the
printed book carries a "copy from page 1" line so it is restated in their own
hand thirteen times. A test asserts that no habit text can reach the store
through any field, including one named `behaviour`.

The measurement discipline is fully preserved: the referent is fixed, restated
weekly, and identical at Day 0 and Day 91. What is given up is the convenience of
seeing it echoed on screen. What is gained is that the database never holds a
sentence about anyone's drinking, vaping, scrolling or gambling.

### Where the draft has no defence

Committed secrets, the silent plaintext fallback, the anon key with no
row-level security, no destination validation on an endpoint that sends texts,
and a print spec whose pagination did not add up. There is no version of these
that is a reasonable trade.

---

## Part 3: Pre-mortem on the first cohort

It is nine months from now. Five hundred ledgers were printed, the cohort ran,
and it did not work. Here is what happened, most likely first.

### 1. The texts were sent from an alphanumeric sender, so STOP never arrived

Outbound worked perfectly. Every participant got every link. Nobody could reply,
so every STOP went nowhere, the opt-out flag was never set, and people kept
receiving texts after asking to stop. One of them complained to the Information
Commissioner's Office.

**Likelihood: high if not specifically checked. Severity: high.** This is the
single most likely failure because everything looks fine from the operator's
side. Prevention: use a long code or short code, and send a real STOP and a real
DELETE from a real handset before a single ledger is printed.

### 2. A key was lost or rotated, and every printed ledger died at once

`TOKEN_PEPPER` changed. Every code in every book stopped working, and there is
no recovery: the database holds hashes, and the clear codes were destroyed after
the print run exactly as the process instructs.

Or `ENCRYPTION_KEY` was lost mid-cohort. No stored number can be decrypted, so
nobody can be texted again, and the protocol stops dead for everyone
simultaneously.

**Likelihood: low. Severity: total and unrecoverable.** This is the worst risk
in the product because there is no clever fix afterwards. Prevention is entirely
procedural and costs nothing, so it is addressed below.

### 3. Nobody noticed the Sunday job had stopped

Cloudflare missed a firing, or the Supabase project paused on an inactive plan,
or a decryption started failing. The Worker logged it correctly and nobody read
the logs. Three weeks of the cohort were lost before a participant emailed to
ask where their link was.

**Likelihood: high over thirteen weeks. Severity: high.** A weekly job with no
heartbeat is a job you find out about from customers. Addressed below.

### 4. Most people never activated

The book sold. Roughly half the buyers scratched the panel, typed a ten-character
code and a mobile number, and started. The rest meant to and did not. The cohort
was half the size planned and self-selected towards the already-motivated, so the
published outcome data flattered the product and could not be defended.

**Likelihood: high. Severity: medium.** Activation friction is the known tax on
any physical-to-digital handoff. Measure it from day one and publish it. An
activation rate is a number no competitor publishes.

### 5. Most completers formally failed

The exit threshold of 8 out of 28 turned out to be far below what a typical
participant reaches in thirteen weeks. People did the work, saw a real fall, and
were told they had not passed. Refunds, and reviews saying the test is rigged.

**Likelihood: unknown, which is the problem. Severity: high.** Nobody has the
data to say. Prevention: pilot first, set the threshold from the pilot, publish
the definition before the cohort starts, and define a second reachable outcome.

### 6. Drop-off made the data unusable

Weeks 3 to 5 are where behaviour-change programmes lose people. Sixty per cent
stopped answering. The completion rate was too low to publish, so the one thing
that would have justified the price never existed.

**Likelihood: high. Severity: high, because the published outcomes are the whole
strategy.** Mitigation: publish the dropout rate as a headline figure rather than
hiding it. A product that reports its own completion rate is more credible than
one that reports only its successes, and it costs nothing to be first.

### 7. The clocks changed

The last Sunday in October fell mid-cohort. The dispatch gate is tested in both
British Summer Time and GMT, so this one is genuinely covered, but it is worth
watching live on the night rather than trusting a unit test.

**Likelihood: low. Severity: low.**

### 8. The print run arrived wrong

The compliance block went to press with a bracket unfilled, or the silver foil
looked grey against the cloth, or the paper feathered. Five hundred units,
unsellable or embarrassing.

**Likelihood: medium. Severity: high, because it is the largest single cash
outlay.** The sign-off checklist in the print spec exists for this, and it only
works if somebody actually initials every line.

### 9. The codes leaked at the printer

The clear-code CSV sat in an email thread. Somebody activated a few hundred
ledgers before they shipped.

**Likelihood: low. Severity: high.** The process already says secure channel and
destroy after the run. Add one control: activate ten codes yourself before
shipping and confirm the rest are still unclaimed on the day the books arrive.

### 10. It worked, and nobody bought it

The protocol did what it says. There was no distribution. Five hundred books in
a garage.

**Likelihood: the highest on this list. Severity: total.** Nothing in this
repository addresses it, and no amount of engineering will.

### What the pre-mortem says to do, in order

1. **Escrow the keys before printing anything.** Two independent copies of
   `TOKEN_PEPPER` and `ENCRYPTION_KEY`, held by two people, offline, written
   down. Nothing else on this list is unrecoverable.
2. **Add a weekly heartbeat**, so a silent failure reaches a human within days
   rather than weeks.
3. **Test a real inbound STOP and DELETE from a real handset**, before the print
   run, not after.
4. **Pilot with about twenty people and no printed book.** A PDF and twenty
   codes. It costs a fortnight and almost nothing, and it settles the activation
   rate, the drop-off curve and the threshold, which are the three numbers the
   whole product rests on.
5. **Set the threshold from the pilot and publish the definition** before the
   first paying cohort starts.
6. **Then print.**

The order matters more than any individual item. Printing five hundred hardbacks
before twenty people have been through the software is the decision that turns
every other risk on this list into an expensive one.
