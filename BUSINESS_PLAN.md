# Socratic Facilitator — 6-Month Business Plan

*Working draft. Numbers below are honest estimates; replace with real data as it comes in.*

---

## 1. Thesis

We are building the first **n-party conversation facilitation system** — an AI that understands and acts inside the lifecycle of a multi-person discussion, rather than responding to dyadic prompts.

Two value propositions, ordered by time horizon:

- **Near-term (Year 1):** SaaS to adult cohort-based course instructors and mastermind facilitators who need help running better discussions.
- **Long-term (Year 2+):** The platform is the data-collection apparatus. Every session generates *paired facilitation trajectories* — `[conversation state] → [intervention decision] → [downstream effect]`. This corpus is licensable to AI labs that want non-dyadic conversation capability.

The K-12 vertical is **not** our wedge. It has slow procurement, compliance overhead (COPPA/FERPA), and direct competitive overlap with Google Classroom + Khanmigo. Adult cohort learning has none of those problems and richer data.

---

## 2. Market

### 2.1 Cohort-based course instructors (primary wedge)

| Layer | Estimate | Source / reasoning |
|---|---|---|
| Total cohort-based course revenue (English) | $1–3B/yr | Maven public statements; A16Z 2022 cohort-based learning report |
| Active cohort instructors (English-speaking) | 50k–100k | Maven (~5k), Reforge, Section, Polygence, Outschool-adult, Skool, plus indie |
| Realistic SAM (instructors with paying cohorts running ≥quarterly) | 10k–20k | Filter for active, repeat operators |
| Tooling spend per instructor / yr | $500–1,500 | Comparable spend on Circle, Riverside, transcription tools |
| **SAM (revenue)** | **$10–30M/yr** | |

### 2.2 Mastermind / peer-group facilitators (secondary)

| Layer | Estimate | Source / reasoning |
|---|---|---|
| Members in formal peer groups globally | 500k–1M | YPO 30k, EO 17k, Vistage 45k, Hampton 8k, Pavilion 10k, Chief 20k, plus long tail |
| Active group facilitators | 20k–50k | ~10 facilitators per 1k members on average |
| Tooling spend per facilitator / yr | $1k–5k | Higher ACV; facilitation IS the product |
| **SAM (revenue)** | **$20–250M/yr** | |

### 2.3 Data licensing (long-term)

Hard to size precisely. Reference points:
- Anthropic, OpenAI, xAI, and Google collectively spend $100M+/yr on labeled data and human feedback (Scale AI, Surge, Mercor public reporting).
- Specialty conversation datasets sell for $1–50M depending on volume, exclusivity, and uniqueness.
- Single research-collaboration deal: $250k–$2M.
- Acquisition outcome (data + team): $10–100M range based on comparable acqui-hires (Adept, Inflection talent deals).

**Headline: TAM ≈ $100–500M/yr in adult facilitation tooling. Optionality of $10M+ data deals on top.**

---

## 3. Why now / why us

- **Why now:** Multi-agent / multi-party AI is the next obvious capability frontier. Labs are publicly hunting for non-dyadic data. Cohort-based learning is a ~5-year-old market still consolidating.
- **Why us:** We've already built the hard part — a working n-party facilitator with state tracking, intervention scoring, and a generated post-session report. Most competitors are building "AI tutors" (dyadic) or "meeting summarizers" (passive). We are alone in the lane.
- **Defensibility:** Not the feature (Google could clone in 6 months). The defensibility is (a) consented adult-vertical data, (b) paired agent traces with outcomes, (c) brand and trust in a niche the BigCos won't bother with.

---

## 4. Wedge product

**For Maven / Polygence / Section instructors:**

> "Plato joins your live cohort sessions and async discussion threads, runs breakouts you can't be in, and writes the debrief you'd otherwise spend an hour on."

Three core jobs:
1. **Live co-facilitator** in synchronous sessions — surfaces quiet voices, presses unexplored tensions, never lectures.
2. **Async discussion runner** for between-session forums — keeps threads moving, cross-references prior posts, drafts summaries.
3. **Post-session report** (already built) — top contributors, strongest moments, unresolved tensions, suggested next prompt.

**Pricing (test, not committed):**
- Free: 1 cohort, ≤10 students, watermarked report
- Pro: $49/mo, unlimited cohorts ≤25 students each, unbranded report, transcript export
- Operator: $199/mo, multi-instructor, white-label, API access

---

## 5. Go-to-market (next 6 months)

GTM is **founder-led, instructor-by-instructor, no procurement**. The Notion / Superhuman edtech playbook.

| Channel | Mechanism | Target output |
|---|---|---|
| Cold DM on LinkedIn / Twitter | 50 cohort instructors / week | 5 design-partner conversations / week |
| Maven Slack + cohort-instructor communities | Lurk, helpful posts, then offer | Inbound trickle by month 3 |
| Loom-driven sales | 3-min product demo Loom embedded in DMs | 20% reply rate target |
| Content (1 post / week) | Specific essays on facilitation craft | SEO + credibility |
| Mastermind warm intros | Each instructor asked: "know any group facilitators?" | 1–2 mastermind pilots by month 4 |
| Lab outreach | Anthropic Applied Research, OpenAI ARK, Allen AI | One scoping call by month 6 |

**No paid ads. No SEO play before month 4. No conferences.**

---

## 6. Six-month milestones

| Month | Product | GTM | Data |
|---|---|---|---|
| **M1** | Pivot positioning; instructor-focused onboarding; data consent flow | 30 instructor interviews; landing page live | Eval set built (200 labeled facilitation moments) |
| **M2** | "Discussion pack" template (reusable session); report polish | 5–10 free design partners | First 50 sessions logged |
| **M3** | Pricing experiment; first paid conversion | Public Loom; 3 testimonial-style essays | 200 sessions; first quality benchmarks |
| **M4** | Async discussion thread feature | 25 paying instructors; 1 mastermind pilot signed | 500 sessions |
| **M5** | API for cohort platforms (Circle, Skool integration) | 50 paying instructors; lab scoping call | 1k sessions; data corpus characterization paper draft |
| **M6** | Decide: vertical-scale path vs. research-partner path | 100 paying instructors **OR** signed lab MOU | Decision-quality dataset |

**Success metric at M6:** ≥$5k MRR **and** at least one lab conversation past first call. If both hit, raise seed. If only one, extend runway and iterate. If neither, the thesis is wrong and we should know.

---

## 7. Team

**Today (M0):** Robert (founder, product + eng).

**Hiring sequence over 6 months:**

| Role | When | Why | Comp range |
|---|---|---|---|
| Founding engineer (full-stack + AI) | M1–M2 | Product velocity; you can't sell and code at the same time | $150–180k + 1.5–3% |
| Part-time research lead (PhD candidate / postdoc) | M2 | Owns the eval set, writes the data narrative, credibility for lab pitches | $4–6k/mo (0.5 FTE) |
| Design contractor | M2–M3, ~10hr/wk | Instructor-facing polish; first impressions matter to indie creators | $80–120/hr |
| GTM lead (community + content) | M4–M5 | When founder-led sales hits ceiling at ~30 customers | $120–150k + 1–2% |

**Total burn 6 months: ~$300–500k** (assuming founder takes minimal salary, contractors not full-time, no office).

**Roles intentionally NOT hiring:**
- Sales (founder-led until M6)
- Marketing (content owned by GTM lead)
- Customer success (founder + engineer split it)
- Compliance/legal (contracted as needed; not a full-time role until enterprise deals appear)

---

## 8. Funding

Three plausible paths, in order of preference:

1. **Bootstrap to M6 + tactical angels.** Raise $300–500k from operator angels (cohort-course founders, ex-Maven/Section, ex-Anthropic). Buys 12 months. Avoids early valuation lock-in.
2. **Pre-seed at M3 if signal is strong.** $1–1.5M at $8–12M cap from edtech / AI-tooling specialist funds (Reach Capital, GSV, Owl Ventures' new fund, or AI-leaning generalists like Conviction).
3. **Research grant / lab partnership.** Anthropic Frontier Model Forum, OpenAI Researcher Access Program, NSF SBIR. Slow to close but non-dilutive.

**Don't raise a $5M seed in the first 6 months.** Premature capital forces premature scaling and you don't yet know the wedge.

---

## 9. Risks (honest list)

| Risk | Severity | Mitigation |
|---|---|---|
| Adult cohort market is smaller than estimated | High | Validate by month 3 with paid conversion rate; pivot to mastermind segment if instructor LTV is poor |
| Maven / Skool / Circle build a competing in-house facilitator | Medium | They probably won't — they're focused on platform, not content quality. But ship fast and stay ahead. |
| Synthetic multi-agent data displaces the data moat | Medium-High (2–3 yr horizon) | Can't fully mitigate. Hedge by also building a strong SaaS that stands without the data play. |
| Founder bandwidth (solo) | High | Hire founding engineer in M1–M2. Don't slip this. |
| Quality of facilitation isn't differentiated enough | Medium | Build the eval set early. Measure obsessively. Publish results. |
| Lab partnership timeline (12–18 months) is too long | Medium | Run SaaS as the floor; lab deal is the ceiling. |
| Privacy backlash if data play becomes public before policy is solid | Medium | Consent flow built into onboarding. Privacy policy reviewed by counsel before M3. Never train without explicit opt-in. |

---

## 10. What we explicitly say no to (next 6 months)

- K-12 schools, districts, LMS integrations
- Live transcription as a product (Otter et al. own that)
- "AI tutor" framing
- Conferences, sponsorships, paid media
- Custom enterprise contracts (until M6)
- Mobile app
- Any feature that takes more than 2 weeks to ship

---

## 11. Decision gates

The plan above is a hypothesis, not a commitment. We re-evaluate at:

- **End of M2:** Are 5+ instructors using the product weekly without prompting? If no → reposition before spending more.
- **End of M4:** ≥$2k MRR? If no → vertical may be wrong, consider mastermind-first.
- **End of M6:** ≥$5k MRR **or** lab MOU? If neither → fundamental thesis question.

---

*Last updated: 2026-04-16*
