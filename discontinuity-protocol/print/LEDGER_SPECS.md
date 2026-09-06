# The Discontinuity Ledger — physical print specification

Version 1.1. Supersedes the 1.0 draft. Every change from 1.0 is listed in
section 8 with the reason, so the printer and the buyer can see what moved.

Read section 2 before quoting. It contains the one instruction that changes the
production route: the activation code is variable data and cannot be produced on
the same press as the rest of the book.

---

## 1. Physical specification

| Item | Specification | Note |
|---|---|---|
| Trim size | A5, 148 x 210 mm portrait | |
| Extent | 128 pages, self-ends | 8 sections of 16 pp |
| Binding | Section-sewn, cased in, rounded and backed | See 1.1 on lay-flat |
| Board | 2 mm greyboard | 1.0 said 2.5 mm; see section 8 |
| Covering | Matt black book cloth, buckram or equivalent | |
| Blocking | Silver foil, front and spine | See 1.2 |
| Head and tail bands | Black | |
| Ribbon | 6 mm black satin, heat-cut | 1.0 said 3 mm; see section 8 |
| Text stock | 100–120 gsm uncoated wood-free, cream, FSC Mix | See 1.3 |
| Endpapers | 140 gsm uncoated, matched to text | |
| Printing | Single spot colour throughout | See 1.4 |
| Finish | Squared spine, no jacket, no lamination on cloth | |

### 1.1 On "lay-flat"

Section sewing and rounding gives a book that opens well and stays open in the
middle of a section. It is not lay-flat in the strict sense, which needs a
hollow or spring back, or a PUR-bound softcover.

Instruction to the printer: quote section-sewn cased-in as standard, and quote a
hollow-back variant separately. Do not describe the standard build as lay-flat
in any customer-facing copy. A journal sold as lay-flat that is not one is a
returns problem and, on a paid product, a misleading description.

### 1.2 On "silver foil deboss"

Foil blocking and debossing are two operations. A combined foil-and-deboss hit
exists and is what 1.0 seems to mean, but the brass must be cut for it.

Instruction: silver foil block with a 0.4 mm registered deboss, single brass die,
front board and spine. Supply the die drawing with the artwork. State the foil
reference on the order, for example Kurz Luxor 351 or the printer's nearest
match, and approve a foil draw-down on the actual cloth before the run. Silver
on matt black shifts noticeably between foil grades.

### 1.3 On "fountain-pen safe"

This is the highest-risk claim in the 1.0 draft. Generic 120 gsm uncoated
wood-free is bulky and absorbent, and with a wet medium or broad nib it feathers
and shows through. A journal sold as fountain-pen safe that feathers gets
returned, and the review says so.

Two instructions:

1. Specify a low-feather sized stock by name, not by weight alone. Munken Pure
   Cream 120 gsm is the usual European starting point. Ask the printer for their
   tested alternative and get both.
2. Require a pre-production pen test. Print a signature on the proposed stock in
   the production ink, and write on it with a fine nib, a medium nib, a
   rollerball and a fineliner. Sign it off before the paper is ordered.

Then set the customer-facing claim to what the test supports. The defensible
version is: "Tested with fine and medium fountain-pen nibs. Broad and wet nibs
may show through." Do not print the phrase "fountain-pen safe" unless the test
supports it without qualification.

### 1.4 On the ink colour

The 1.0 draft specified "Pantone Cool Gray 11 C / #2C2C2C". Those are two
different colours, and the printer will stop the job to ask which one is meant.
Cool Gray 11 is a mid-to-dark neutral grey, roughly #53565A on screen. #2C2C2C
is a much darker near-black. The hex value is what the design intends.

Resolution: **Pantone Black 7 U**, a warm near-black that reads as the intended
#2C2C2C on cream stock.

Two supporting corrections:

- Use the **U** suffix. The stock is uncoated, and a C reference on uncoated
  paper prints noticeably lighter and duller than the chip suggests.
- Treat every hex value in this document as a screen approximation only. The
  contract colour is the Pantone chip on a drawdown of the production stock,
  approved before the run. Hex values do not survive the trip to spot ink.

---

## 2. The activation code: production route

Each ledger carries one unique ten-character activation code, from the Crockford
base32 alphabet with I, L, O and U removed so that handwritten and read-aloud
codes are unambiguous.

This has two consequences the 1.0 draft did not account for.

**Variable data cannot be printed on a spot-colour press.** Offset or letterpress
prints the same plate on every copy. A unique code per copy is digital. Do not
attempt to reconcile these: print the book conventionally and apply the code as a
separate digital operation.

**A code printed on a visible page is readable by anyone handling the book.**
Anyone who opens a shop display copy, a returned copy or a warehouse copy can
photograph the code and activate that ledger, and the buyer's book is then dead
on arrival with no way for them to prove what happened.

Instruction: apply the code on a **scratch-off panel** on the inside back cover,
or on a sealed card inside a belly band. Whichever route is chosen, the code must
not be readable without visibly destroying something. Add a line beside it:

> If this panel is already scratched off when you open the book, do not use the
> code. Contact us for a replacement.

Codes are supplied by `scripts/generate-tokens.mjs` as a single-column CSV. That
file is the only place clear codes ever exist. It goes to the printer over an
agreed secure channel, is never committed to the repository, and is destroyed by
both parties at the end of the run. The database receives keyed hashes only, so
a stolen database yields no working codes.

---

## 3. Pagination, 128 pages

Total checks to 128, which is 8 sections of 16 pages, the natural extent for
section sewing. Arithmetic is shown so it can be re-checked against any change.

| Pages | Count | Content |
|---|---|---|
| 1 | 1 | Title, ledger number, and the behaviour declaration panel (see 3.3) |
| 2 | 1 | Colophon, manufacturer, compliance block |
| 3–6 | 4 | How the protocol works, and what it does not claim |
| 7–8 | 2 | Evidence notes and references |
| 9–12 | 4 | Stage 1: cue architecture mapping |
| 13–16 | 4 | Stage 2: context discontinuity and friction design |
| 17–20 | 4 | Stage 3: substitution and value activation |
| 21–22 | 2 | Day 0 baseline audit, with the four items in full |
| 23–100 | 78 | The operational log: 13 weeks at 6 pages each |
| 101–104 | 4 | Day 91 exit audit and the automaticity decay plot |
| 105–112 | 8 | Stage 4: maintenance and the relapse protocol |
| 113–124 | 12 | Grid pages |
| 125–128 | 4 | Compliance data, contact, replacement code procedure |
| **Total** | **128** | 1+1+4+2+4+4+4+2+78+4+8+12+4 = 128 |

The 1.0 draft allocated pages 16–103 to "the 12-week operational log, 2 pages per
week". That range is 88 pages. Twelve weeks at two pages each is 24. The section
was over-allocated by 64 pages and no reader of the spec could have printed from
it. Section 8 explains how the number was resolved.

### 3.1 The week spread, 6 pages

Repeated thirteen times, pages 23–100.

- **Page 1**: the week ahead. A ruled line at the top reading "The behaviour
  (copy from page 1)", so the participant restates it in their own hand every
  single week and is always rating the same thing. Cue conditions expected this
  week. One environmental change to make.
- **Pages 2–5**: seven daily lines, one per day, plus one spare. Each line has a
  slot for occurrences, the strongest cue, and what was done instead.
- **Page 6**: the weekly audit. The four items printed in full with a 1 to 7
  scale, a total box, and a plot point on the running graph.

### 3.3 The behaviour declaration panel, page 1

A boxed panel, at least 60 mm wide by 25 mm deep, ruled, headed:

> **The behaviour I am discontinuing.** Write one behaviour, and be specific.
> "Checking my phone within five minutes of waking", not "phone use". Every
> question in this ledger, for the next thirteen weeks, refers to what you write
> here. Do not change it.

Beneath it, in smaller type:

> We never ask you to type this into the website and we do not hold it. It stays
> in this book.

This panel is the only place the behaviour exists. The software deliberately does
not store it: the four automaticity items all refer to one action, so the
referent has to be fixed, but fixing it does not require a database to hold free
text about someone's drinking, vaping, scrolling or gambling next to their mobile
number. The weekly audit page online points the participant back to this panel
instead.

Consequence for the design of every weekly spread: the line "copy from page 1" is
not decoration. It is what keeps the measurement honest, and it must appear on
all thirteen spreads without exception.

### 3.2 On 90 days versus 13 weeks

Twelve weeks is 84 days, not 90. A product called a 90-day protocol whose
schedule is 84 days is a discrepancy a customer will find, and it is exactly the
kind of detail an un-gimmicked positioning cannot afford to get wrong.

Resolution: the protocol runs **13 weekly audits from Day 0 to Day 91**. The
90-day name is retained because that is the term the market uses, and every
operational reference in the ledger, the software and the copy says 13 weeks and
91 days. Never print "12 weeks" and "90 days" on the same page.

---

## 4. Typography and layout

- One text face throughout, a text serif at 9.5 to 10.5 pt on 14 to 15 pt.
  Justify nothing; ragged right on A5 at this measure.
- Margins: head 14 mm, foot 16 mm, spine 18 mm, fore-edge 13 mm. The spine
  margin is generous because a sewn A5 hardback loses several millimetres into
  the gutter.
- Ruled lines at 7 mm, printed at 20 per cent of the spot colour. Full-strength
  rules fight the participant's handwriting.
- Page folios at the foot, outer corner, from page 3. No folio on the title page.
- No motivational quotations, no streak boxes, no stickers, no habit chains.
  The product's claim is that it is un-gimmicked. Every page is where that claim
  is kept or broken.

---

## 5. Evidence notes, pages 7–8

Print this correction. The 1.0 draft credited the four-item measure to
"Verplanken et al." and called it the SRHI. The four items in this ledger are the
**SRBAI**, the Self-Report Behavioural Automaticity Index (Gardner, Abraham,
Lally and de Bruijn, 2012), which is the four-item automaticity subscale drawn
from the twelve-item **SRHI** (Verplanken and Orbell, 2003).

Getting this wrong is expensive in a specific way. The audience most likely to
buy an evidence-led habit product is the audience most likely to know the
difference, and a misattributed instrument on page 7 discredits everything after
it.

References to set, in full, on page 8:

- Verplanken, B. and Orbell, S. (2003). Reflections on past behavior: A
  self-report index of habit strength. *Journal of Applied Social Psychology*,
  33(6), 1313–1330.
- Gardner, B., Abraham, C., Lally, P. and de Bruijn, G.-J. (2012). Towards
  parsimony in habit measurement: Testing the convergent and predictive validity
  of an automaticity subscale of the Self-Report Habit Index. *International
  Journal of Behavioral Nutrition and Physical Activity*, 9, 102.
- Lally, P., van Jaarsveld, C.H.M., Potts, H.W.W. and Wardle, J. (2010). How are
  habits formed: Modelling habit formation in the real world. *European Journal
  of Social Psychology*, 40(6), 998–1009.
- Wood, W., Tam, L. and Guerrero Witt, M. (2005). Changing circumstances,
  disrupting habits. *Journal of Personality and Social Psychology*, 88(6),
  918–933.

Verify every page range against the published article before it goes to press.
Citations are checkable, and a product that stakes its position on evidence is
judged on whether its own references are right.

Also print, on page 6, what the protocol does not claim. The Lally paper is
routinely cited as "66 days to form a habit". Its actual finding is a median of
66 days with a range from 18 to 254 days and wide individual variation, and it
concerns habit formation rather than discontinuation. If the ledger cites it,
cite it accurately. The stronger competitive position is the honest one: the
protocol runs 91 days because that is a reasonable window in which to see
automaticity fall, not because 90 days is a magic number.

---

## 6. Compliance block, page 2 and page 128 and the outer carton

Print exactly this block, with the bracketed values completed:

```
Manufacturer:  PRC Behavioural Operations UK Ltd
               [Registered office], Leek, Staffordshire Moorlands, ST13, UK
               Company number [00000000]
               [protocol@prcworkforce.com]

EU responsible person (GPSR):
               [Name], [Street], [Postcode] [City], [EU member state]
               [email] / [telephone]

Origin:        Designed in the United Kingdom. Printed in [country].
Paper:         FSC Mix Credit, licence code FSC-C[000000]
Batch:         [batch reference]
```

Three things the 1.0 draft omitted or got wrong.

**The EU responsible person is mandatory, not optional.** The EU General Product
Safety Regulation, applicable since 13 December 2024, requires an economic
operator established in the EU, named with contact details on the product or its
packaging, before the product can be sold to consumers in the EU or Northern
Ireland. A UK-only address does not satisfy it. Sell into the EU without one and
the listing is removed. **Verify the current requirement with your compliance
adviser before the run.** Confidence: high that the obligation exists, lower on
how it applies to your exact distribution route.

**"Printed in the EU" is not a country of origin.** Origin marking names a
country. Name the actual one.

**The FSC claim needs a licence code.** The phrase "FSC Mix Credit" without the
printer's or the publisher's FSC licence code and the correct trademark panel is
not a valid claim, and FSC enforces this. Have the printer supply the approved
label artwork; do not typeset it yourself.

Two further items to check with an adviser, not assumed:

- **EUDR.** The EU Deforestation Regulation covers printed books under HS
  heading 4901 and requires due-diligence statements from operators placing them
  on the EU market. Application dates have shifted more than once. Confirm the
  date and the obligations that apply to your volume before you commit to an EU
  distribution route. Confidence: medium.
- **Waste packaging and EPR.** UK extended producer responsibility for packaging
  has reporting thresholds by turnover and tonnage. A small run is likely below
  them. Confirm rather than assume.

---

## 7. Pre-production sign-off checklist

Nothing goes to press until every line is initialled.

- [ ] Wet proof or accurate digital proof on the production stock, in the
      production spot colour, viewed under D50.
- [ ] Foil drawdown on the production cloth, approved against the brass drawing.
- [ ] Pen test on the production stock, per section 1.3, with the wording of the
      customer-facing claim agreed off the back of it.
- [ ] Binding dummy: correct extent, correct board, correct bulk, ribbon length
      checked against the diagonal of the trimmed page.
- [ ] One scratch-off panel applied and scratched, to confirm it removes cleanly
      and the code beneath is legible.
- [ ] Ten codes from the batch tested end to end against the live activation
      page, then those ten ledgers pulled from stock and destroyed.
- [ ] Compliance block proofread against section 6, with every bracket filled.
- [ ] Every reference in section 5 checked against the published article.
- [ ] Confirmation that no page says "12 weeks" and no page says "SRHI" for the
      four-item measure.

---

## 8. Changes from version 1.0, and why

| Change | From | To | Reason |
|---|---|---|---|
| Extent | 112 pp | 128 pp | 112 could not hold the log section. 128 is 8 x 16 pp, which suits section sewing. |
| Log allocation | "pp 16–103, 2 pp per week" | pp 23–100, 6 pp per week, 13 weeks | The stated range was 88 pages for 24 pages of content. Unprintable as written. |
| Duration | 12 weeks, "90-day" | 13 weeks, Day 0 to Day 91 | 12 weeks is 84 days. The old spec contradicted its own product name. |
| Instrument | "SRHI (Verplanken et al.)" | SRBAI (Gardner et al., 2012) | The four items are the SRBAI. The SRHI has twelve. |
| Ink | "Cool Gray 11 C / #2C2C2C" | Pantone Black 7 U | The two references were different colours. U suffix because the stock is uncoated. |
| Paper claim | "fountain-pen safe" | Claim set by a pre-production pen test | Unqualified, the claim is not supportable on generic 120 gsm uncoated. |
| Board | 2.5 mm | 2 mm | 2.5 mm on A5 is disproportionate and adds cost and postage weight for no benefit. |
| Ribbon | 3 mm | 6 mm | 3 mm frays and reads as cheap against a buckram case. |
| Binding claim | "lay-flat" | Section-sewn, cased in | Section sewing is not lay-flat. Quote the hollow-back variant separately. |
| Code placement | Printed on page 1 | Scratch-off or sealed card | A code visible in a display copy can be stolen before the book is sold. |
| Code production | Not addressed | Digital, separate from the spot-colour run | Variable data cannot be printed from a fixed plate. |
| Compliance | UK address only | UK address plus EU responsible person, named origin, FSC licence code | GPSR, origin marking and FSC trademark rules. |
