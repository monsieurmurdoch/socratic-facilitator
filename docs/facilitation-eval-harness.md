# Facilitation Eval Harness

This harness measures whether Plato's facilitation policy makes better intervention choices than simple baselines.

It answers the product/investor question:

> Given the same multiparty transcript state, does Plato choose better facilitation behavior than a generic prompted model policy?

## Run It

```bash
npm run eval:facilitation
```

The command writes:

- `output/evals/facilitation-policy-latest.json`
- `output/evals/facilitation-policy-<timestamp>.json`

## What It Measures

Each fixture contains a transcript state and an expected facilitator action:

- whether to speak or stay silent
- acceptable facilitation moves
- target participant, when relevant
- rationale for the expected behavior

Current scoring:

- intervention timing: speak vs stay silent
- move fit: deepen, redirect, revisit anchor, etc.
- target fit: whether the quiet/dominant-participant case names the right person
- overtalk penalty: speaking when the group is already doing well
- missed-intervention penalty: staying silent when facilitation is needed

## Current Candidates

- `plato_policy`: local policy layer using `FacilitationOrchestrator`
- `baseline_question_every_turn`: asks a follow-up after every turn
- `baseline_silent`: never intervenes

The first baselines are intentionally simple. They exist to make failure obvious:

- question-only models overtalk good groups
- silent models miss stuck groups
- Plato should win by knowing when not to speak and what kind of move is needed

## How To Improve It

Add fixtures in:

`server/analysis/evals/facilitationPolicyFixtures.js`

Good next fixtures:

- loaded personal disclosure in a group
- two students in unresolved disagreement
- student asks Plato directly for help
- religious/political heat without toxicity
- quiet student ignored for five turns
- strong seminar flow where Plato must stay silent

The next major upgrade is preference judging:

1. Generate Plato output and baseline model output for the same fixture.
2. Blind the candidate labels.
3. Ask a human or judge model which intervention is better and why.
4. Track Plato win rate against Claude/Gemini baselines.

That is the number we eventually want to show:

> Plato wins X% of blinded facilitation decisions against prompted frontier models on consented multiparty evals.
