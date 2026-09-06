# Pilot protocol: twenty people, no printed book

The purpose is to stop you spending money on a print run you cannot yet
justify, and to settle the numbers the product rests on before they become
expensive to get wrong.

---

## 0. A correction to earlier advice

I previously said a pilot "costs a fortnight and settles the activation rate,
the drop-off curve and the threshold". Two parts of that were wrong and one was
overstated.

- **A fortnight is wrong.** A fortnight tests the software. The drop-off curve
  and the achievable threshold are properties of a thirteen-week protocol and
  take thirteen weeks to observe. There is no shortcut, because the thing being
  measured is what happens to people over three months.
- **The activation rate cannot be measured this way.** A PDF emailed to a
  volunteer is a completely different funnel from a hardback bought in a shop
  with a scratch-off panel inside the back cover. The pilot tells you nothing
  useful about retail activation.
- **The threshold can be estimated, not settled.** Twenty people is enough to
  rule out a grossly wrong number and nowhere near enough to fix a right one.
  Section 8 puts figures on that.

The pilot is still the right call. It is just two stages rather than one, and it
takes about four months rather than two weeks.

---

## 1. What this is, and what it is not

**It is** a shakedown of the whole system, and a first look at what happens to
real automaticity scores over thirteen weeks.

**It is not** a trial. There is no control group, no randomisation, no blinding
and no pre-specified power calculation. Anything it produces is descriptive.

Say so in every place the results are ever quoted. A product whose whole
positioning is that it is honest about evidence cannot describe twenty
self-selected volunteers as a study. The competitive advantage is that you
publish your numbers and label them accurately, and the label is half of it.

---

## 2. Stage A: technical shakedown

**Five people, two weeks, thirteen weeks of protocol simulated.**

Run against a separate Supabase project and a separate Worker, with their own
keys. Never against the production project.

### Compressing thirteen weeks into two

Two settings already in the build do this without touching any code.

**Fire the cron on demand.** The dispatch gate is configuration, so on staging
set the local hour to whichever hour you are working in, and set a frequent cron:

```toml
[triggers]
crons = ["*/15 * * * *"]

[vars]
DISPATCH_LOCAL_HOUR = "14"   # whatever hour it is where you are testing
```

**Move participants through time.** The due week comes from elapsed time, so
backdating a start date advances a participant by exactly that many weeks:

```sql
-- Advance every staging participant by one week and let the next cron fire.
UPDATE public.participant_sessions
   SET started_at = started_at - INTERVAL '7 days';
```

Repeat thirteen times, waiting for a dispatch between each. A full protocol runs
in an afternoon, and every participant receives thirteen real texts with thirteen
real signed links.

### Stage A must produce all of these before it ends

- [ ] `/healthz` returns `ok` on staging and on production.
- [ ] All thirteen links arrive, in order, each valid, each recording once.
- [ ] A link edited in the address bar is refused. A link from last week still
      works. A link from three weeks ago does not.
- [ ] The same week submitted twice returns a clear message and does not
      overwrite the first reading.
- [ ] **A real STOP sent from a real handset actually stops the messages.** If
      the sender is alphanumeric this will fail silently, which is the single
      most likely way this product breaks in the field.
- [ ] A real DELETE erases the record, confirmed by looking in the database.
- [ ] A forged webhook POST without a valid signature changes nothing.
- [ ] One activation code cannot be used twice, and one mobile cannot run two
      protocols at once.
- [ ] A heartbeat arrives at `ALERT_WEBHOOK_URL` after every run.
- [ ] Both offline copies of `TOKEN_PEPPER` and `ENCRYPTION_KEY` exist, held by
      two people. Nothing else on this list is unrecoverable.
- [ ] Cost per participant recorded, from the real invoice, not an estimate.

Stage B does not start until every line is initialled.

---

## 3. Stage B: outcome pilot

**Twenty activated participants, thirteen weeks, real time.**

Recruit twenty-eight to land twenty activations. Non-activation among volunteers
runs lower than in retail, but it is not zero.

### Materials

- The ledger as a PDF, printed at home or read on screen. It **must** contain
  the page 1 behaviour panel and the "copy from page 1" line on all thirteen
  weekly spreads. Without those the pilot is not testing the product you intend
  to sell, because the fixed referent is the whole basis of the measurement.
- Twenty-eight activation codes from a real batch, generated the real way.
- A one-page brief: what it is, what it is not, how to stop, how to be erased.
- The privacy notice, with the placeholders actually filled in.

### Who to recruit

People who genuinely want to stop something, recruited however you can reach
them. Do not screen for likely success: a pilot that recruits only the motivated
produces a completion rate you cannot repeat and a threshold that is too strict
for everyone else.

Exclude anyone whose behaviour needs clinical help rather than a journal. Say
plainly in the brief that this is not treatment for addiction, and point to the
appropriate NHS route. **[verify]** the exact wording with your adviser.

### Consent

The same consent as production, plus one addition: that their anonymised
aggregate results may be published. Nobody's individual data is ever published,
and with twenty people that promise has teeth only if you also refuse to report
any subgroup small enough to identify someone.

---

## 4. Pre-registration

Write this down, date it, and send it to yourself before the first person
activates. One page.

1. The exit threshold you are testing, and why that number.
2. The second outcome, "substantial reduction", defined as a fall of a stated
   number of points from Day 0.
3. The proportion of completers you would want to reach the exit threshold for
   the product to be viable.
4. What counts as a completer: a stated minimum number of weekly readings,
   including the Day 91 audit.
5. What result would make you not print.

This costs twenty minutes and it is the difference between a pilot and a
rationalisation. Without it, every number that comes back can be read as
encouraging.

---

## 5. What to measure

| Measure | Why it matters |
|---|---|
| Weekly response rate, by week | The drop-off curve. Where people leave is where the product needs work. |
| Completion rate | The denominator for everything else, and a figure worth publishing. |
| Day 0 score distribution | Tells you whether buyers arrive with strong habits. If baselines cluster low, the instrument has little room to move. |
| Day 91 score distribution | Sets the threshold. |
| Change from Day 0, per person | The number participants care about, and the basis of "substantial reduction". |
| Proportion reaching each candidate threshold | The commercial question. |
| Support contacts, by cause | "Link expired" volume tells you whether nine days is right. |
| SMS cost per participant | From the invoice. |
| Whether people understood the scale direction | Ask directly at week 2. If more than two of twenty thought a rising score was good, the copy has failed. |

---

## 6. Analysis, and the trap in it

Setting the threshold from the pilot and then reporting the pilot's outcomes
against that same threshold is circular. The number will always look reasonable,
because it was chosen to.

**The clean sequence:**

1. Use the pilot to choose the threshold.
2. Publish the pilot as descriptive, with the threshold stated as provisional.
3. Fix the threshold before the first paying cohort starts.
4. Report that cohort against the pre-fixed number.

Step 4 is the one that produces a defensible claim. Steps 1 to 3 produce a
defensible process, which is what lets you make the claim later without anyone
being able to say you moved the goalposts.

---

## 7. Stop rules

Halt and fix before continuing if any of these happen.

- Anyone receives a message after sending STOP. Stop immediately. This is a
  regulatory matter, not a bug.
- A Sunday dispatch is missed, or the heartbeat does not arrive. Do not carry on
  until the cause is known: a silent weekly job is the failure that costs a
  cohort.
- Weekly response rate is below fifty per cent at week six. The contact model
  needs redesigning before it is printed into a book.
- More than two participants report they could not tell which direction the
  score should move.

---

## 8. What twenty people can and cannot tell you

If twelve of twenty complete and six of those reach the threshold, that is fifty
per cent. The ninety-five per cent confidence interval on six out of twelve runs
from about **25 per cent to 75 per cent**.

| Result | Proportion | 95% interval | Width |
|---|---|---|---|
| 6 of 12 completers | 50% | 25% to 75% | 49 points |
| 8 of 14 completers | 57% | 33% to 79% | 46 points |
| 10 of 20 | 50% | 30% to 70% | 40 points |
| 12 of 20 | 60% | 39% to 78% | 39 points |

Wilson intervals. **[verify]** the arithmetic if it matters to a decision.

Read that honestly. A pilot this size cannot distinguish "half of people pass"
from "a quarter do" or "three quarters do". What it can do is rule out the
disasters: if one person in twenty reaches the threshold, the number is wrong,
and you will know that with total clarity. Ruling out disasters before a print
run is the entire point, and it is worth four months.

Do not publish an interval this wide as though it were a finding. Publish the
raw counts: "six of the twelve people who completed reached the threshold."
Counts cannot be over-read the way a percentage can.

---

## 9. The gate

Print only when all of these are true.

- Every Stage A line is initialled.
- Stage B ran to Day 91 without a stop rule firing.
- The threshold and the second outcome are fixed and written down.
- The compliance block has every bracket filled and has been read by an adviser.
- The pen test, the foil drawdown and the binding dummy are all signed off.
- The activation code panel has been tested: applied, scratched, legible.

---

## 10. Cost and timeline

Roughly £50 to £150 for the whole pilot: about 280 messages at two segments
each, plus a number rental for four months, on free tiers everywhere else.
**[verify]** against current rates. The real cost is time, not money.

| Week | |
|---|---|
| 0 | Setup, staging project, keys, key escrow, PDF ledger |
| 1 to 2 | Stage A |
| 3 | Fix whatever Stage A found |
| 4 | Recruit and activate |
| 5 to 18 | Stage B, thirteen weeks plus the Day 91 audit |
| 19 | Analysis, fix the threshold, decide |

About four and a half months to the print decision.

**The one compression worth making:** run the artwork, the foil die, the pen test
and the compliance review in parallel with Stage B. Commit to design and to
proofs, but not to the paper order. If the pilot says stop, you lose the design
time and none of the print cost, and if it says go you print immediately rather
than starting a ten-week production process from cold.
