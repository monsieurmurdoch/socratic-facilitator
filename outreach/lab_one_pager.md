# Multi-Party Facilitation Trajectories — A Data & Research Collaboration Proposal

*One-pager for AI labs (Anthropic Applied Research, OpenAI ARK, Allen AI, etc.)*

---

## The capability gap

Current frontier models are trained predominantly on dyadic and monologic text. They are excellent prompt-responders. They are notably poor at:

- **Sustained n-party conversation** — tracking who said what across 6–12 speakers over 30+ minutes
- **Knowing when not to speak** — current models intervene on every turn; real facilitation is mostly silence
- **Reading group dynamics** — dominance, drift, unexplored disagreement, listening behavior
- **Producing utterances appropriate to the *state* of a conversation**, not just the last message

This is a known frontier. There is no public corpus of high-quality, structured, multi-party facilitation data.

## What we have

Socratic Facilitator is a deployed multi-party AI facilitator currently running [N] live discussions with [M] adult learners. Every session generates a structured trajectory:

```
{
  conversation_state: { participant_count, talk_distribution, dominance_score,
                        listening_score, unexplored_tensions, anchor_claims, ... },
  facilitator_decision: { should_speak: bool, move_type: enum, target_participant,
                          generated_utterance, reasoning },
  observed_outcome: { next_n_turns, participant_responses,
                      downstream_engagement_delta }
}
```

This is not "transcripts." It is **paired agent-in-the-loop trajectories with intervention decisions and downstream outcomes** — the structure required for offline RL, instruction tuning on facilitation moves, and behavioral evaluation of multi-party reasoning.

## Why this dataset is rare

| Why labs can't easily get it elsewhere | |
|---|---|
| Zoom / Google Meet / Teams | Contractually committed not to train on customer content. Enterprise sales motion makes this permanent. |
| YouTube panel discussions | No agent traces. No counterfactuals. No structured state. |
| Synthetic multi-agent generation | Improving, but lacks ground-truth human reactions to facilitator decisions. Useful as augmentation, not replacement. |
| Academic discourse corpora (Switchboard, AMI) | Small (hundreds of hours), old, single-domain, no agent-in-the-loop. |

## What we are proposing

A research collaboration in one of three shapes — open to discussion:

1. **Data licensing.** Periodic delivery of de-identified, consented trajectories. Tiered exclusivity options. Suitable for evals and SFT.
2. **Joint research project.** Co-authored paper on multi-party facilitation benchmarks or fine-tuning. We bring the corpus and deployed system; you bring training compute and methodology expertise.
3. **Capability eval.** We provide a held-out evaluation set (decisions + ground-truth outcomes); you measure your frontier model against it. Useful for your internal capability tracking; useful for us as third-party validation.

## Provenance and consent

All data is collected with explicit informed consent from adult participants (no minors), under privacy controls aligned with Common Crawl / Stanford CRFM data-handling norms. Class-level retention and AI-scoring opt-outs are first-class features. We can produce a data card and consent flow walkthrough on request.

## Honest limitations

- Current corpus size is **[X] sessions / [Y] turns** as of [date]. Modest. Growing ~[Z]/month.
- Domain skew: predominantly adult learners in cohort-based courses and seminars. We are deliberately not yet collecting K-12 (compliance) or workplace meetings (commercial conflicts).
- The facilitator model driving the current system is built on Claude Haiku 4.5 — so there is some shared pre-training distribution between agent and likely consumers. Worth noting.
- We don't yet have a published evaluation showing measurable downstream model improvement from training on this data. That's exactly the kind of thing a collaboration could produce.

## What we are not

- Not a vendor pitching a product to your team.
- Not asking for funding or strategic investment in this conversation.
- Not selling to your competitors yet — this is the right moment for whoever moves first.

## Ask

A 30-minute scoping call with the team responsible for [model post-training / capability evaluation / data partnerships]. If there's mutual interest, we can move to a data-sample exchange under MNDA within two weeks.

## Contact

Robert Malka — [email] — [LinkedIn]
Codebase, technical writeups, and corpus stats available on request.

---

*Last updated: 2026-04-16*
