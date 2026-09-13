# 03 — Market & Corporate Pricing Research

Investigator 3, 2026-09-11. Pure web research; no repo files other than this
one were modified. All URLs were accessed 2026-09-11.

**Product context.** UK private-tutor whiteboard (sen-tutor.co.uk). Free tier
(code truth: 1 room, tutor + 1 student — `spec/STATE.md:26`), planned Tutor Pro
(20 rooms / 10 participants / 90-day retention per `security.md:979-986`), and
now an owner request for corporate/company accounts with "special per-seat
pricing".

**Conflict flag — corporate vs the owner's target-market decision.** `security.md:953-961`
(owner decision, 2026-08-18) says the product is *not* a school product: "no seat
pools, no rosters, no district billing, no admin consoles", and `security.md:988`
says "No School tier." A corporate account priced per seat reintroduces
seat-count billing and central billing at minimum. It only stays inside the
decision if a company is a *billing group of individually-owned tutor accounts*,
not an org with pooled seats, student seats, rosters, or an admin console over
rooms. That shape question is the first thing the orchestrator/owner must settle;
everything below prices the constrained shape and says where the wider shape
would cost more.

---

## Comparables table

List prices published by the vendor unless marked third-party; ex-VAT unless
noted; per seat/user/tutor unless noted. "Annual" = effective monthly price when
billed yearly.

| Product | Plan | Price / seat / mo, billed annually | Min seats | Notes (free tier, uplift, billing) | Source |
|---|---|---|---|---|---|
| Miro | Free / Starter / Business / Enterprise | Starter $8 ($10 monthly); Business $20 ($25 monthly); Enterprise custom | 1 on card; invoice min 10 (Starter) or 5 (Business); Enterprise from 30 members | Free = 3 editable boards. Starter: unlimited boards. Business adds SSO, guest editors, multiple teams. Enterprise = procurement/security, custom. Annual saves 20% | miro.com/pricing; help.miro.com (billing + plan articles) |
| Figma | Professional / Organization / Enterprise | Professional Full seat $16 (GBP £14 annual); Organization Full $55, Dev $25, Collab $5 (GBP £50); Enterprise Full $90 (GBP £85) | Not published; view seats free | Professional self-serve; Org/Enterprise invoiced quarterly, pro-rated seats; SSO/admin at Organization+ | figma.com/pricing; figma.com/organization; help.figma.com pricing-update article |
| Canva | Free / Pro / Business / Enterprise | Business $25 (or $250/user/yr); legacy Teams was $29.99 for first 5 users | No minimum (Business) | Free = 5 GB. Business adds brand controls, team admin, higher AI limits. Enterprise custom from ~50 users | canva.com/pricing; canva.com/help/canva-business-billing; felloai.com (third-party); vendr.com (third-party) |
| Notion | Free / Plus / Business / Enterprise | Plus $10 ($12 monthly); Business $20 ($24 monthly); Enterprise custom | None (can start at 1 member); guests free | Business adds SAML SSO, private teamspaces, workspace AI. Enterprise adds SCIM/audit logs; self-serve below 100 employees, sales above. Annual ≈17% off | notion.com/pricing; notion.com/help/upgrade-or-downgrade-your-plan |
| Padlet | Free / Platinum / Team / Classroom / School | Platinum £14/mo or £110/yr (£9.17/mo, "save 34%"); Team £17.99/mo or £129.99/yr per Maker ("save 39%"); School from £900/yr for 10 teachers (£7.50/teacher/mo) | School plan starts at 10 teachers; Team has no published minimum | Free = 3 padlets, 1 user. Team adds permissions, user management, analytics. School adds SSO, LMS, invoice billing, unlimited students; POs only ≥$1,000 | padlet.com/site/subscriptions; padlet.help (Schools, Classroom articles) |
| Kahoot! | 360 Pro Start→Ultra (business) / 360 Spirit (team) / school plans | 360 Pro $19–$79/host/mo, annual only; 360 Spirit ≈$20/licence/mo but **min 25 licences** ($6,000/yr); school teacher plans $3–$25/teacher/mo annual | 25 licences on 360 Spirit; district/site licence = quote | Free = 10 participants, non-commercial. Business priced per host, participants join free. Annual billing mandatory for business. Spirit figure is third-party | kahoot360.com/en-GB/pricing; kahoot.com/schools/plans; triviamaker.com (third-party) |
| Quizizz / Wayground | Starter (free) / Individual / School & District | No public per-seat price for School & District (quote only); third-party reports Super ≈$5/mo, ~$50/mo for up to 30 users | Not published | Individuals pay by card; schools pay by PO/check/ACH; district plan reimburses teachers who paid personally | wayground.com/home/plans; help.wayground.com; makerstations.io (third-party); lingobright.com (third-party) |
| Nearpod | Silver (free) / Gold / Platinum / Schools & Districts | Gold $159/yr (≈$13.25/mo); Platinum $397/yr (≈$33/mo) per teacher | None published | Free = 300 MB, 40 students/lesson. Schools & Districts = quote (unlimited storage, admin reporting, co-teaching) | nearpod.com/pricing; support.renaissance.com (licence types) |
| Whiteboard.chat | Educator (free) / paid / Schools-Districts | Vendor page exposes no numbers (JS app in fetched copy). TrustRadius lists individual $15 and Schools/Districts $150/mo — treat as unverified | Not published | Free = 10 boards, 7-day board life, ads on instructor board only. Pricing FAQ documents plan behaviour, not prices | trustradius.com (third-party); web.whiteboard.chat pricing FAQ |
| Explain Everything | Free / Pro / Team / School | Pro $7.49/user/mo billed yearly (commercial); Team $9.99/mo or $89.99/yr per person; education plans quote-based | Not published | Free = 3 projects. School teacher licence bundles 100 student licences, custom quote | explaineverything.com/pricing; help.explaineverything.com |
| Mentimeter | Free / Basic / Pro / Enterprise | Pro $24.99/presenter/mo billed yearly (annual only); Basic ≈$11.99/mo annual (third-party); Enterprise custom | Enterprise recommended at 10+ licences; buyer's guide cites 10 as the minimum threshold | Pro adds unlimited presentations, integrations, workspace bundling. Enterprise adds SSO, SCIM, CSM. No monthly Pro | mentimeter.com/plans; help.mentimeter.com; Mentimeter Buyer's Guide (PDF) |
| Vevox | Free / Starter / Pro / Enterprise (business); Education equivalents | Business Starter $11.95/mo ($143.40/yr); Pro $24.95/mo ($19.96 promo); extra user £252/yr; Education Starter $7.75/mo, Pro $14.95/mo | Enterprise 3+ users; Education Institution 5+ users | Enterprise: SSO, admin, pay-only-for-active-users, invoice/PO. Free tier generous | vevox.com/pricing (business + education); help.vevox.com (pricing, additional licences) |
| Pencil Spaces | Usage-based (from 2026-09-01) + legacy seat plans | Pro $0.40/session-hour (10-hr min = $4/mo); Expert $1.20/hr ($12/mo min); Master $5/hr ($50/mo min); Enterprise from $2,000/mo. Legacy seats $6/$19/$49/$149/mo | Enterprise custom; legacy plans had implicit scale tiers | Billing starts when 2+ people are in a Space; first person free. Seat-based plan listed "coming soon" | pencilspaces.com/pricing; pencilspaces.com/pricing-upcoming; pencilspaces.com blog (2026-08-20) |
| Lucidspark | Free / Individual / Team / Enterprise | Individual $9/mo; Team $10/user/mo (monthly or annual) | Not published; a "3-seat minimum" is widely repeated but undocumented — do not trust it | Free = 3 boards. Team adds voting, timers, facilitator tools. SSO/SCIM/domain control only on Enterprise (quote) | help.lucid.co (Lucidspark plans); brainstormer.ai (third-party, Aug 2026) |
| Slack | Free / Pro / Business+ / Enterprise+ | Pro $7.25/user/mo annual (UK £5.75); Business+ $15 (UK £12); Enterprise+ contact sales | No published minimum; secondhand data says 2-person teams are billed 3 seats | Business+ adds AI, SAML SSO, compliance. Annual saves vs monthly; UK prices published in GBP | salesforce.com/slack/pricing; slack.com/pricing; costbench.com (third-party) |
| Google Workspace | Business Starter / Standard / Plus / Enterprise | Starter $7 (promo $4.90 first 20 users); Standard $14; Plus $22; Enterprise contact sales. Annual saves 16% | None; Starter–Plus capped at 300 users, Enterprise no cap | Hard cap creates a self-serve→enterprise threshold at 300 users. GBP/EUR localized pricing offered | workspace.google.com/pricing |

Two patterns worth naming: (1) an **individual teacher plan in the US$3–15/mo
band** is the norm (Kahoot $3–12, Vevox edu $7.75, Explain Everything $7.49,
Nearpod $13.25, Mentimeter $11.99, Whiteboard.chat $3–7 third-party), and (2) a
**team/corporate uplift of 1.5–3× the personal price and/or a hard minimum seat
count** (Padlet Team £17.99, Miro Business $20, Kahoot Spirit min 25, Miro
invoice min 5–10, Mentimeter Enterprise 10+).

---

## Volume-discount norms

- **Annual billing.** Median annual discount across 569 SaaS plans (210
  products) is **20%**; most categories cluster **16–25%** (Comparedge, July
  2026). Vendor statements agree: Miro "annual saves 20%"; Google Workspace
  "save 16% with 1 year commitment"; Padlet Platinum 34% / Team 39% (deep
  because its monthly rates are high). Anything above ~40% is usually an
  introductory rate, not a discount.
- **Per-seat volume bands.** Transaction data (50–5,000-seat deals) shows an
  automatic volume layer of **15–25%** off list, a 3-year term layer of
  **5–10%**, and extra strategic/competitive layers of 5–20% each, stacked
  multiplicatively (VendorBenchmark). Achievable discounts rise from **15–30%**
  at 100–499 seats to **25–40%** at 500–1,999 seats.
- **But small teams pay close to list.** Startups under 250 employees typically
  achieve only **5–18%** off list, mostly from annual/multi-year commitment, not
  headcount (VendorBenchmark company-size guide). Procurement data shows
  card-bought SaaS averages **$8.4k/yr** and PO-bought **$47.6k/yr**; cards
  dominate **73%** of contracts under $25k/yr while POs are used in **82%** of
  contracts over $100k/yr (Cloudnuro).
- **Term discounts.** Common benchmark ladder: annual **15–20%**, 2-year
  **20–25%**, 3-year **25–30%**, plus **5–10%** for paying up front
  (Knowledgelib benchmark; VendorBenchmark: multi-year adds ~5%/yr).
- **Custom / "contact sales" thresholds observed:** Miro Enterprise **from 30
  members**; Notion Enterprise self-serve **under 100 employees**; Google
  Workspace Starter–Plus capped at **300 users**; Canva Enterprise ~**50+**;
  Mentimeter Enterprise at **10+**; Kahoot team plan needs **25 licences**;
  Miro invoice billing min **5–10**; Padlet School from **10 teachers**;
  Slack/Zoom Enterprise+ = contact sales. Simple reading: self-serve to roughly
  10–30 seats, hybrid to ~100, sales-led above.

---

## UK VAT/invoicing notes

- **Rate.** UK standard VAT is **20%**; UK digital services are standard-rated
  (Anrok UK guide; Stripe). If the seller is UK-established and sells to UK
  customers, it charges 20% (once VAT-registered) — the domestic reverse charge
  does **not** apply to SaaS (it is limited to specified goods/construction,
  etc. — Stripe reverse-charge guide).
- **B2B reverse charge.** Applies to *cross-border* B2B services: a UK business
  buying digital services from a non-UK supplier self-accounts; a UK supplier
  selling to an overseas business charges 0% UK VAT and must show the customer's
  VAT number plus a "reverse charge" statement (Stripe; uktaxdrag; Marosa). For
  a UK-based Teacher Playground, corporate UK customers simply get a normal 20%
  VAT invoice and reclaim it as input tax.
- **Full VAT invoice must show** (HMRC VATREC5010): unique sequential number;
  time of supply; date of issue; supplier name, address, VAT number; customer
  name and address; description of services; quantity/extent; rate of VAT and
  amount excluding VAT per item; gross total excluding VAT; cash-discount rate;
  total VAT; unit price; margin-scheme and reverse-charge references where
  relevant.
- **Why companies want invoice, not card.** B2B payment is an approval workflow,
  not a checkout: PO number required before activation, vendor onboarding,
  AP review, then batch payment runs; a missing PO can auto-reject an invoice
  (Afternoon; Fortune Herald). Most B2B buyers want invoice with terms (HHL
  study cited by B2B-Commerce-Agentur: 95% want invoice purchase), and 54%
  abandon checkout when only cards are offered (Baymard, cited in the same
  source). Small contracts still go on card — the flip happens around
  $15k–25k/yr ACV (Cloudnuro).
- **Stripe funnel impact.** Stripe UK charges **1.5% + 20p** per standard UK
  card, 2.5% + 20p EEA, 3.25% + 20p international, plus **2% currency
  conversion** if prices are in USD; Stripe Invoicing adds **0.4–0.5% per paid
  invoice** and Billing adds a further percentage of recurring volume
  (stripe.com/gb/pricing; merchanthq.co.uk). Invoice-plus-bank-transfer avoids
  card fees but adds 30–60+ day DSO (Fortune Herald). Practical shape: keep
  Stripe Checkout + Billing for personal and small corporate card sales; use
  Stripe Invoicing for annual corporate invoices (pay by transfer or card).

---

## Referral benchmarks

- **Two-sided beats one-sided.** Dual-sided programs lift participation ~29%
  and completion 52% vs 29% for one-sided (2026 statistics roundup,
  blog.mean.ceo); other compilations report 30–60% more completed referrals;
  the canonical "give a month, get a month" / credit-both-sides pattern is the
  SaaS default because credit is cheaper than cash and re-engages both users
  (Referral Earl; Track360; Cello; Reditus).
- **Reward depth.** Most successful programs land at **10–20% of AOV per side**;
  above ~25% erodes margin without lifting conversion (Referral Earl). Typical
  referral conversion is **3–5%** of clicks, top performers >8% (Cello); SaaS
  SMB referral CAC is **$35–70** vs $150–400 enterprise (Referral Rocket).
  Referred users convert to paid at roughly normal-to-better rates (~1/3 in a
  122-signup sample — Reditus).
- **Mechanics and fraud control.** Fire rewards on a verified billing event
  (`invoice.paid`), never signup; 30-day review/clawback window; exclude
  self-referrals; block disposable email domains; device/IP/velocity checks;
  cap rewards per referrer; prefer account credit to cash (Cello; Track360;
  Referral Earl).
- **Examples.**
  - **Preply (edtech marketplace):** tutor advocate earns **$25**; invitee gets
    **30% off first trial**; reward paid 30 days after the invitee's first
    subscription lesson. Student advocates get credits + 70% off first trial.
  - **Cambly (edtech):** ambassador earns **from $30 per qualified conversion**
    ($50+ spend); student referral gives the friend +10 minutes and the referrer
    60 minutes on subscription.
  - **Wyzant (edtech marketplace):** tutor keeps **100% of their hourly rate**
    (platform fee waived) for referred students — one-sided but high-value;
    student still pays the normal 9% service fee.
  - **Whiteboard.chat (direct edtech competitor):** teacher earns **10% of the
    contract value** for signing a school/district — a commission-style B2B
    referral worth copying only if corporate deals are sales-assisted.
  - **Non-edtech reference points:** Dropbox 500MB each side; PayPal $10 each;
    Airtable credit both sides (Track360/Cello teardowns).

---

## Recommended pricing

Assumes the constrained corporate shape (billing group of named tutor accounts;
students never billable; no shared seat pool, rosters, or room-admin console).
Anchors: personal prices in the UK market sit at £9–18/mo (Padlet Platinum
£14/mo / £110/yr, Team £17.99 per Maker; Figma Professional £14/mo; Miro
Starter ≈$8; Explain Everything Pro $7.49; Vevox edu $7.75), annual discounts
cluster 16–25% (Miro 20%, Google 16%), and small-team volume discounts are
small (5–18% — VendorBenchmark).

**Personal (Tutor Pro), GBP, ex-VAT displayed with "incl. VAT" note for UK
consumers:**

| Plan | Price | Effective | Reasoning |
|---|---|---|---|
| Tutor Pro monthly | **£9.99/mo** | £9.99 | Sits under the £10 psychological threshold; between Whiteboard.chat/Explain Everything and Miro/Padlet. |
| Tutor Pro annual | **£95/yr** | £7.92/mo | 20% off monthly — exactly the market median (Comparedge); undercuts Padlet Platinum £110. |

**Corporate ("Tutor Company"), GBP, annual prepay, per named tutor seat,
minimum 3 seats:**

| Volume band | Price/seat/mo (annual) | Annual/seat | Discount vs personal annual (£7.92/mo) | Notes |
|---|---|---|---|---|
| 3–9 seats | **£7.50** | £90 | ~5% | Small partnerships pay near list (benchmark: startups 5–18% off). |
| 10–24 seats | **£6.50** | £78 | ~18% | Mid-market volume norm (15–25%). |
| 25–99 seats | **£5.50** | £66 | ~31% | Top of observed volume ranges (25–35% at larger deals). |
| 100+ seats | Quote | — | — | Sales-assisted; floor ~£45/seat/yr. |

Justification for the corporate price *level*: it is 1.5–3× the personal price
only in the other direction (discount), which is what buyers expect from team
plans (Padlet Team is £17.99 vs £14 Platinum; Miro Business is $20 vs $8
Starter). A tutor company's value is retention and central billing, not
per-seat collaboration, so the uplift that Miro charges for SSO does not exist
here yet — therefore discount, not premium.

**What corporate includes (constrained shape):** one consolidated annual
invoice and VAT receipt (PO number field), seat management (add/remove named
tutor seats at renewal, pro-rated additions), per-tutor Tutor Pro entitlements
unchanged, optional company SSO **only if/when** the owner reopens the market
decision. **Not** included: student seats, shared room pools, rosters, or
org-wide content/room administration.

**Billing motion — card self-serve, invoice-first at scale.** 3–9 seats:
self-serve card at checkout (instant). 10+ seats and any PO customer:
invoice-first, annual prepay, 14–30 day terms via Stripe Invoicing; card still
accepted. Rationale: cards dominate below ~$25k ACV, POs/AP above
(Cloudnuro); invoice costs 0.4–0.5% vs 1.5% + 20p card, but watch DSO.

**Referral (two-sided, in product):**
- Referred tutor: **first month free** on annual (or 50% off first month on
  monthly).
- Referrer: **one month account credit** once the referred tutor's first paid
  invoice clears.
- Controls: fire on `invoice.paid`, 30-day refund clawback, max 6 rewards per
  account per 12 months, self-referral/email/device dedupe, both sides must be
  on a paid plan.
- Anchors: two-sided lifts completion ~30–60%; 10–20% of AOV per side; Preply
  pays $25 + 30% off trial; Cambly pays from $30. On £9.99, one month each side
  is ~£20/referral, comfortably below the $35–70 SMB referral CAC benchmark.

**Confidence.** Comparables: high (vendor pages, accessed 2026-09-11; third
party figures labelled). Volume/discount norms: high (multiple 2026 benchmark
reports agree on 16–25%/20% median). Recommended numbers: medium — there is no
UK tutor willingness-to-pay survey and no live conversion data; the band is
anchored to list prices, not measured demand. Corporate scope conflict: high —
`security.md:953-961, 988` explicitly excludes the shape "corporate per-seat
pricing" implies.

**What would change the recommendation:**
1. Owner decision on corporate shape: billing-group (prices above hold) vs
   managed organisation with SSO/admin/room oversight (reopens the school
   decision; add a premium tier at £10–14/seat/mo and an enterprise quote, and
   re-open SEC-015's scope).
2. Observed corporate size mix: mostly 2-tutor partnerships → drop the corporate
   SKU, sell "add a second tutor seat" at personal price; mostly 20–50 tutors →
   add bands and consider a £5–6 floor.
3. VAT status: if not VAT-registered, £9.99 is actually received in full; once
   registered, display ex-VAT for B2B and VAT-inclusive for consumers.
4. Cloudflare Access cost at corporate scale (see below).
5. Any willingness-to-pay evidence from pilot tutors.

---

## Sources

All accessed 2026-09-11 unless noted. Third-party estimate sites are marked (3P).

Vendor pricing pages:
- https://miro.com/pricing/ ; https://help.miro.com/hc/en-us/articles/360017571714-Miro-billing ; https://help.miro.com/hc/en-us/articles/360014270500-Understanding-Miro-plans-and-pricing
- https://www.figma.com/pricing/ ; https://www.figma.com/organization/ ; https://help.figma.com/hc/en-us/articles/27468498501527-Updates-to-Figma-s-pricing-seats-and-billing-experience
- https://www.canva.com/pricing/ ; https://www.canva.com/help/canva-business-billing/
- https://www.notion.com/pricing ; https://www.notion.com/help/upgrade-or-downgrade-your-plan
- https://padlet.com/site/subscriptions ; https://padlet.help/l/en/article/v1fz9vy4io-padlet-for-schools ; https://padlet.help/l/en/article/z2f1db89rd-padlet-classroom
- https://kahoot360.com/en-GB/pricing/ ; https://kahoot.com/schools/plans/
- https://wayground.com/home/plans ; https://help.wayground.com/support/solutions/articles/158000403874-understanding-wayground-plans
- https://nearpod.com/pricing ; https://support.renaissance.com/s/article/Nearpod-s-License-Types-1752689960552
- https://web.whiteboard.chat/docs/faq-on-pricing-plans/ (vendor page has no prices)
- https://explaineverything.com/pricing/ ; https://help.explaineverything.com/hc/en-us/articles/360013907993
- https://www.mentimeter.com/plans ; https://help.mentimeter.com/en/articles/5938993-which-plan-is-right-for-you ; https://assets.ctfassets.net/rvt0uslu5yqp/6nCz86IILLNCwkcCbiD14J/74c9cfaacca904ebfd7c4f5efb7b842f/Buyersguide.pdf
- https://www.vevox.com/pricing ; https://www.vevox.com/pricing/business-pricing ; https://help.vevox.com/hc/en-us/articles/360010207838-Pricing
- https://www.pencilspaces.com/pricing ; https://www.pencilspaces.com/pricing-upcoming ; https://www.pencilspaces.com/blog/pencil-spaces-new-pricing
- https://help.lucid.co/hc/en-us/articles/360058103411-Lucidspark-Plans
- https://www.salesforce.com/slack/pricing/ ; https://slack.com/pricing
- https://workspace.google.com/pricing

Third-party pricing estimates (3P): https://www.vendr.com/marketplace/canva ;
https://www.vendr.com/marketplace/kahoot ; https://felloai.com/canva-pricing/ ;
https://www.makerstations.io/quizizz-pricing/ ; https://www.lingobright.com/ed-tech/quizziz-pricing/ ;
https://www.trustradius.com/products/whiteboard-chat/pricing ;
https://marketgenius.ai/products/whiteboardchat-whiteboardchat ;
https://brainstormer.ai/lucidspark-pricing ; https://costbench.com/software/communication/slack/ ;
https://toolradar.com/tools/mentimeter/pricing ; https://www.wooclap.com/en/blog/vevox-pricing/ ;
https://triviamaker.com/kahoot-pricing/

Discount/volume benchmarks:
- https://comparedge.com/reports/annual-discount-report-2026 (median annual discount 20%)
- https://vendorbenchmark.com/blog/saas-pricing-benchmarks-enterprise-2026 ; https://vendorbenchmark.com/blog/saas-discount-ranges-deal-size-benchmark ; https://vendorbenchmark.com/guides/saas-pricing-benchmark-by-company-size
- https://www.renewalpad.com/insights/saas-benchmark-pricing-2026
- https://knowledgelib.io/finance/saas-benchmarks/enterprise-pricing-strategy/2026

UK VAT/invoicing:
- https://www.gov.uk/hmrc-internal-manuals/vat-trader-records/vatrec5010 (invoice contents)
- https://www.gov.uk/hmrc-internal-manuals/vat-place-of-supply-services/vatposs14300 (reverse charge, services)
- https://stripe.com/en-de/resources/more/uk-reverse-charge-vat (reverse-charge scope and wording)
- https://uktaxdrag.co.uk/uk-vat-digital-services-reverse-charge-2026-27.html (B2B/B2C digital services)
- https://www.anrok.com/vat-software-digital-services/united-kingdom (20% standard rate)
- https://stripe.com/gb/pricing ; https://merchanthq.co.uk/fees/stripe/ (UK card fees, Invoicing 0.4–0.5%)
- https://www.cloudnuro.ai/blog/pay-for-saas (card vs PO thresholds, PO pricing 18–27% better)
- https://fortuneherald.com/featured/when-stripe-is-not-enough-enterprise-invoicing-challenges-in-saas/ ; https://www.afternoon.co/blog/invoicing-B2B-SaaS ; https://www.b2b-commerce-agentur.de/en/blog/b2b-payment-methods-invoice-credit-limit/

Referrals:
- https://cello.so/blog/what-is-referral-program-build-saas/ ; https://cello.so/blog/referral-marketing-examples-cut-cac/
- https://track360.io/blog/saas-referral-program-build-guide-2026 ; https://track360.io/blog/saas-referral-program-examples-2026
- https://referralearl.com/double-sided-referral-rewards/
- https://getreditus.com/blog/saas-referral-programs-definitive-guide
- https://blog.mean.ceo/referral-program-participation-conversion-statistics/
- https://blogs.referralrocket.io/referral-program-kpis-12-metrics-to-track-in-2026-with-benchmarks/
- https://help.preply.com/en/articles/11538098-tutor-referral-program-invite-students-to-preply ; https://help.preply.com/en/articles/11537548-referral-program-for-students
- https://www.cambly.com/english/ambassador ; https://studentsupport.cambly.com/hc/en-us/articles/360000312486
- https://support.wyzant.com/tutors/referrals-for-tutors/tutor-referrals-faqs/

Repo context (not web): `security.md:946-990`, `spec/STATE.md:26-35`.

---

## Open questions

1. **The Free tier is inconsistent across sources.** The brief says 1 room /
   2 people; `security.md:979-986` proposes 2 rooms / 3 participants / 2
   distinct students / 7-day retention; `spec/STATE.md:26` and
   `UX_IMPROVEMENTS.md:84` say code enforces 1 room and host + 1 student, while
   public pricing copy says 2 rooms / 3 people. Which catalog is the pricing
   anchored to? (SEC-015 depends on it.)
2. **Does corporate re-open the school decision?** `security.md:953-961` bans
   seat pools, rosters, district billing, and admin consoles, and `security.md:988`
   says no School tier. If the owner wants a managed company console, that
   decision must be explicitly amended on record before Phase 7; if corporate is
   billing-only, say so in the catalog and keep the SKU free of org-admin over
   rooms.
3. **What does a "seat" entitle?** Recommended: one named tutor = one Tutor Pro
   account (same 20 rooms / 10 participants per tutor). Confirm students remain
   non-seats and never appear in corporate billing.
4. **Cloudflare Access economics.** `security.md:958-961` notes ~a dozen active
   tutors fit the free 50-user Access tier because each tutor adds few users. A
   10-tutor company with ~10–20 students each exceeds 50 users; corporate
   pricing may need to absorb Access plan cost or the corporate motion should
   wait until auth no longer depends on Access. Who prices that?
5. **Annual-only for corporate?** Recommendation is yes (annual prepay,
   pro-rated seat additions). Confirm refund/cancellation terms (compare Miro's
   invoice min and Padlet's ≥$1,000 PO rule).
6. **VAT registration status today** and whether public prices should be shown
   ex-VAT (B2B norm) or inc-VAT (consumer expectation). Pricing above is net;
   add 20% for UK non-VAT-registered consumers.
7. **Currency.** GBP-only is recommended; charging USD from the UK adds Stripe's
   2% conversion fee and friction for UK companies reclaiming VAT.
8. **Referral reward medium.** Account credit only, or cash option at scale?
   Credit is the benchmark default and avoids fraud/tax complexity; confirm caps
   (recommended 6 rewards/12 months) and whether corporate referrals get a
   larger reward (whiteboard.chat pays 10% of contract value).
9. **No willingness-to-pay data.** Recommended numbers are list-price anchored;
   a short pilot/landing-page test (e.g., £9.99 vs £12 monthly) before locking
   the catalog would raise confidence.
