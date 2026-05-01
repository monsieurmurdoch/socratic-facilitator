# Socratic Facilitator Status

Canonical operating note for the Socratic Facilitator / Expanse project.

This file is designed to stay in the repo and mirror into Obsidian at:

`~/Documents/Obsidian Vault/Coding/Socratic-Facilitator (Expanse)/status.md`

Related Obsidian notes: [[Project - Expanse Conversation AI]], [[Spec - Expanse Conversation AI MVP]]

The local pre-push hook runs `node scripts/sync-obsidian-status.mjs --push-update`, which refreshes the current push snapshot, archives the previous snapshot in this same document, and mirrors this file plus the professional product board/roadmap into Obsidian.

## Current Read

The app is strongest as an AI-facilitated recurring small-group seminar product. The near-term wedge should be homeschool/co-op seminars or a similarly reachable cohort buyer, while preserving the broader thesis: multiparty conversational AI trained and evaluated on real, consented group interaction.

The product should not try to beat Gemini or Claude on raw model capability. It should compete on group ritual, facilitation policy, trust, memory, consented data, curriculum, and recurring social graph.

The detailed working roadmap is now maintained as a checkbox-style product board in `docs/roadmap-bizplan.md`, mirrored into Obsidian as `roadmap-bizplan.md`.

## Current Priorities

1. Prep the product for real paying users by closing the obvious trust gaps: teacher-control authorization, session/material/transcript access checks, consent/data-use defaults, and a reliable test harness.
2. Finish the app roadmap for a real pilot: class rooms, live sessions, source materials, post-session reports, parent/teacher dashboards, backend reliability, model-provider abstraction, and eval instrumentation.
3. Build a three-week paid-pilot motion around one concrete buyer: homeschool families, homeschool co-ops, cohort instructors, or alumni/book-club organizers.
4. Discover high-quality data pipelines for rich multiparty conversation, scored by consent feasibility, recurrence, conversational richness, signal quality, labeling cost, and business adjacency.
5. Keep the social-media spinout alive as a later milestone: recurring AI-hosted rooms with curation, memory, moderation, and group continuity, not random Chatroulette-style matching.

## Three-Week Map

### Week 1: Make It Trustworthy Enough To Demo

- Add role/ownership checks to WebSocket teacher controls.
- Protect session details, source text, transcripts, material upload, priming, and deletion behind membership/ownership or signed join capability.
- Add clear consent language for recording/transcripts/data use before any real pilot.
- Fix Jest discovery so `.claude`, `.local`, and generated worktrees are ignored.
- Create a pilot demo path that can be shown in under 10 minutes.
- Confirm the live session backend path: session creation, room-code join, participant roster, start/end, transcript persistence, report generation, and cleanup.

### Week 2: Find The First Paying Client

- Pick one pilot offer:
  - Homeschool seminar pod: weekly 45-minute AI-facilitated reading discussion.
  - Cohort instructor assistant: Plato runs discussion and produces a facilitator report.
  - Alumni/book-club room: recurring facilitated discussion for affinity groups.
- Price-test three packages:
  - $15-25 per child/month for light participation.
  - $49 per child/month for weekly seminar cohort.
  - $300 per pod/month for a 5-8 student group.
- Build a target list of 50 prospects across homeschool co-ops, classical education groups, parent communities, independent teachers, and small colleges/cohort programs.
- Run 20 direct conversations before optimizing the product any further.

### Week 3: Pilot, Instrument, Learn

- Run at least 3 live sessions with real users.
- Capture consented transcripts and basic session metadata.
- Label a small sample manually using the existing move taxonomy.
- Compare facilitator interventions against a baseline prompt-only model.
- Measure: show-up rate, completion rate, parent/teacher satisfaction, "would you meet again?", and whether participants talked to each other more than to the AI.

## Data Pipeline Discovery

High-value data is not merely "conversation." It is recurring, consented, multiparty, emotionally varied, and rich enough to show lifecycle dynamics.

Candidate pipelines to score:

- Homeschool/co-op seminars: high product adjacency, moderate volume, strong consent path.
- College seminars: high signal, slow access, IRB/faculty trust issues.
- Alumni/book clubs: strong recurrence, useful bridge to social product, variable rigor.
- Group coaching/life coaching: good emotional range, clear buyer, potential privacy complexity.
- Language-learning conversation circles: high volume, clear willingness to practice, international angle.
- Toastmasters/writing workshops: structured feedback norms, strong consent potential.
- Peer-support groups: strong need and emotional richness, must avoid regulated therapy claims.
- Japanese AI/social pilots: potentially useful if a real local partner exists.
- Game/voice lobbies: massive volume, but noisy and risky; useful only as contrast/control data unless heavily filtered.

Conversation lifecycle categories worth labeling:

- Socratic inquiry.
- Informal friendship/bro-ing out.
- Tender group moment.
- Conflict and repair.
- Dominance and inclusion.
- Awkward silence and restart.
- Group decision-making.
- Reading together.
- Advice-seeking.
- Storytelling and memory formation.

## Open Questions

- Who is the first buyer who can say yes in under 30 days?
- What is the smallest paid seminar product that feels valuable without model training?
- Which consent/data-use structure preserves the data moat without making users feel exploited?
- What does the social spinout learn from the seminar product that Gemini/Claude cannot simply copy?
- Which backend pieces must be production-grade before paid pilots, and which can remain manual/demo-grade for the first 3 weeks?

<!-- PUSH-UPDATE:CURRENT:START -->
## Current Push Snapshot

- Last updated: 2026-05-01T20:46:59.217Z
- Branch: feat/semantic-retrieval
- Commit: 34d11e8
- Push remote: origin
- Working tree:
  - Clean working tree
<!-- PUSH-UPDATE:CURRENT:END -->

## Archived Push Updates

<!-- PUSH-UPDATE:ARCHIVE:START -->
## Current Push Snapshot

- Last updated: 2026-05-01T20:43:39.898Z
- Branch: feat/semantic-retrieval
- Commit: 63e08d0
- Push remote: origin
- Working tree:
  - Clean working tree

---

## Current Push Snapshot

- Last updated: 2026-05-01T20:35:45.016Z
- Branch: feat/semantic-retrieval
- Commit: 2c997f0
- Push remote: origin
- Working tree:
  - Clean working tree

---

## Current Push Snapshot

- Last updated: 2026-05-01T20:25:19.361Z
- Branch: feat/semantic-retrieval
- Commit: c7e4713
- Push remote: origin
- Working tree:
  - Clean working tree

---

## Current Push Snapshot

- Last updated: 2026-05-01T20:15:56.874Z
- Branch: feat/semantic-retrieval
- Commit: e52ea2f
- Push remote: origin
- Working tree:
  - Clean working tree

---

## Current Push Snapshot

- Last updated: 2026-05-01T20:11:23.095Z
- Branch: feat/semantic-retrieval
- Commit: 3f50e0b
- Push remote: origin
- Working tree:
  - Clean working tree

---

## Current Push Snapshot

- Last updated: 2026-05-01T20:11:06.965Z
- Branch: feat/semantic-retrieval
- Commit: 5b45f22
- Push remote: origin
- Working tree:
  - Clean working tree

---

## Current Push Snapshot

- Last updated: 2026-04-30T20:37:43.687Z
- Branch: feat/semantic-retrieval
- Commit: 25eda24
- Push remote: origin
- Working tree:
  - Clean working tree

---

## Current Push Snapshot

- Last updated: 2026-04-30T20:36:52.958Z
- Branch: feat/semantic-retrieval
- Commit: 94b5f50
- Push remote: origin
- Working tree:
  - M .gitignore
  -  M client/public/admin.html
  -  M client/public/dashboard.html
  -  M client/public/index.html
  -  M client/src/app.js
  -  M client/src/dashboard.css
  -  M client/src/main.js
  -  M client/src/state.js
  -  M client/src/style.css
  -  M docs/roadmap-bizplan.md
  -  M server/db/repositories/participants.js
  -  M server/db/repositories/sessions.js

---

## Current Push Snapshot

- Last updated: 2026-04-30T05:08:23.971Z
- Branch: feat/semantic-retrieval
- Commit: 50aa13b
- Push remote: origin
- Working tree:
  - M status.md
  - ?? "# Cold DM playbook \342\200\224 cohort instructors.md"
  - ?? "# Multi-Party Facilitation Trajectories "
  - ?? "# Socratic Facilitator \342\200\224 6-Month Business.md"
  - ?? "docs/Socratic Facilitator_Notes.pages"
  - ?? docs/socratic_facilitator_blueprint.docx

---

## Current Push Snapshot

- Last updated: 2026-04-30T04:51:34.867Z
- Branch: feat/semantic-retrieval
- Commit: 9208b74
- Push remote: origin
- Working tree:
  - M status.md
  - ?? "# Cold DM playbook \342\200\224 cohort instructors.md"
  - ?? "# Multi-Party Facilitation Trajectories "
  - ?? "# Socratic Facilitator \342\200\224 6-Month Business.md"
  - ?? "docs/Socratic Facilitator_Notes.pages"
  - ?? docs/socratic_facilitator_blueprint.docx

---

## Current Push Snapshot

- Last updated: 2026-04-30T04:42:48.774Z
- Branch: feat/semantic-retrieval
- Commit: 26cf1e2
- Push remote: origin
- Working tree:
  - M status.md
  - ?? "# Cold DM playbook \342\200\224 cohort instructors.md"
  - ?? "# Multi-Party Facilitation Trajectories "
  - ?? "# Socratic Facilitator \342\200\224 6-Month Business.md"
  - ?? "docs/Socratic Facilitator_Notes.pages"
  - ?? docs/socratic_facilitator_blueprint.docx

---

## Current Push Snapshot

- Last updated: 2026-04-30T01:30:52.500Z
- Branch: feat/semantic-retrieval
- Commit: 45dd7f7
- Push remote: origin
- Working tree:
  - M status.md
  - ?? "# Cold DM playbook \342\200\224 cohort instructors.md"
  - ?? "# Multi-Party Facilitation Trajectories "
  - ?? "# Socratic Facilitator \342\200\224 6-Month Business.md"
  - ?? "docs/Socratic Facilitator_Notes.pages"
  - ?? docs/socratic_facilitator_blueprint.docx

---

## Current Push Snapshot

- Last updated: 2026-04-29T21:50:43.393Z
- Branch: feat/semantic-retrieval
- Commit: f295533
- Push remote: origin
- Working tree:
  - M status.md
  - ?? "# Cold DM playbook \342\200\224 cohort instructors.md"
  - ?? "# Multi-Party Facilitation Trajectories "
  - ?? "# Socratic Facilitator \342\200\224 6-Month Business.md"
  - ?? "docs/Socratic Facilitator_Notes.pages"
  - ?? docs/socratic_facilitator_blueprint.docx

---

## Current Push Snapshot

- Last updated: 2026-04-29T21:26:47.328Z
- Branch: feat/semantic-retrieval
- Commit: fcd8de9
- Push remote: origin
- Working tree:
  - M status.md
  - ?? "# Cold DM playbook \342\200\224 cohort instructors.md"
  - ?? "# Multi-Party Facilitation Trajectories "
  - ?? "# Socratic Facilitator \342\200\224 6-Month Business.md"
  - ?? "docs/Socratic Facilitator_Notes.pages"
  - ?? docs/socratic_facilitator_blueprint.docx

---

## Current Push Snapshot

- Last updated: 2026-04-27T21:33:13.691Z
- Branch: feat/semantic-retrieval
- Commit: e7418a0
- Push remote: origin
- Working tree:
  - A  docs/roadmap-bizplan.md
  - M  package.json
  - A  scripts/hooks/pre-push
  - A  scripts/sync-obsidian-status.mjs
  - A  status.md
  - ?? "# Cold DM playbook \342\200\224 cohort instructors.md"
  - ?? "# Multi-Party Facilitation Trajectories "
  - ?? "# Socratic Facilitator \342\200\224 6-Month Business.md"
  - ?? "docs/Socratic Facilitator_Notes.pages"
  - ?? docs/socratic_facilitator_blueprint.docx

---

## Current Push Snapshot

- Last updated: 2026-04-24T07:40:59.525Z
- Branch: feat/semantic-retrieval
- Commit: 5f40705
- Push remote: origin
- Working tree:
  - M package.json
  - ?? "# Cold DM playbook \342\200\224 cohort instructors.md"
  - ?? "# Multi-Party Facilitation Trajectories "
  - ?? "# Socratic Facilitator \342\200\224 6-Month Busines.md"
  - ?? docs/
  - ?? scripts/hooks/
  - ?? scripts/sync-obsidian-status.mjs
  - ?? status.md
<!-- PUSH-UPDATE:ARCHIVE:END -->
