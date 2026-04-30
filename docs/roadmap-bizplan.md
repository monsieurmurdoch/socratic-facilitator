# Socratic Facilitator Product Board

Updated: 2026-04-30  
Mirror: `~/Documents/Obsidian Vault/Coding/Socratic-Facilitator (Expanse)/roadmap-bizplan.md`

## Operating Thesis

Build the facilitation layer for recurring small-group conversation. The near-term wedge is paid AI-facilitated seminar pods. The long-term asset is consented multiparty conversation data, evals, and product knowledge that make the AI better at helping humans think, include, repair, remember, and return.

The company does not beat Gemini, Claude, or future models on raw intelligence. It competes on group ritual, facilitation policy, trust, memory, curriculum, social continuity, and labeled multiparty eval data.

## Product Goal

Launch a pilot-ready product that can get at least one paying client to run recurring small-group discussions within 3 weeks, then use the next 90 days to validate retention, data quality, and willingness to pay.

## Current Capability Check

### Product Surface

- [x] Basic session creation.
- [x] Live room/session join by code.
- [x] Teacher/class account concepts.
- [x] Parent account concept.
- [x] Source material upload and priming.
- [x] Transcript capture/display.
- [x] Post-session analytics timeline MVP: speaker turns, score lanes, anchors, hover inspector, zoom, local favorites.
- [x] Class room-code direction started.
- [x] Post-session report infrastructure started.
- [ ] Single clean pilot flow: create class -> add reading -> go live -> end -> report.
- [ ] Parent/teacher consent flow before recording/transcription.
- [ ] Clear billing/scheduling path for pilot customers.
- [ ] Demo content and first-run path for homeschool/co-op buyers.

### Backend And Trust

- [x] Express + WebSocket server.
- [x] PostgreSQL persistence.
- [x] Auth/session infrastructure.
- [x] Class, parent, participant, message, material, report tables.
- [x] Retention settings model started.
- [x] Teacher-only WebSocket controls require role/ownership checks.
- [x] Session details/source text/transcripts/material APIs require membership or signed access.
- [x] Late joiners are moved into active discussions.
- [x] Duplicate display names are represented as separate participants.
- [x] Rejoin during disconnect grace window restores the same participant identity.
- [ ] Guest join capability separates easy access from public data access.
- [x] Signed guest/session access tokens for unauthenticated pilots.
- [ ] Sensitive audit events for transcript views, exports, material changes, parent access.
- [ ] Dual-permission parent access: parent can view a child's post-session details only when both teacher and child/student permission are granted.
- [ ] Production-safe defaults for retention and exports.

### AI And Data

- [x] Facilitation move taxonomy.
- [x] "Silence by default" facilitation posture.
- [x] Message assessment, anchor tracking, intervention orchestration.
- [x] Text grounding and source chunk coverage.
- [x] Learner memory/profile direction started.
- [ ] Teacher-controlled question posture: questions-only, mostly questions, balanced, or more directive synthesis.
- [ ] Provider abstraction for Claude/Gemini/task-specific routing.
- [ ] Per-intervention telemetry: model, prompt version, move, latency, cost, source chunks.
- [ ] LLM-assisted label queue with human verification.
- [ ] Baseline eval: prompted model vs Plato policy layer.
- [ ] Consent-aware export format for anonymized eval/training data.

### Testing And Operations

- [x] Pure logic tests exist.
- [x] Targeted pure test subset passes.
- [x] Jest ignores `.claude`, `.local`, generated worktrees, and nested repo copies.
- [x] Focused WebSocket room-control smoke tests cover teacher-only controls, active late join, duplicate names, and rejoin.
- [ ] API/WebSocket tests are split from logic tests.
- [x] Local Postgres test service and deterministic test secrets are documented.
- [x] Full API/WebSocket suite runs against local Postgres.
- [ ] Local dev setup documents required secrets, DB, and port assumptions.
- [ ] Health checks and deployment smoke checks are consistent.
- [ ] Background jobs for priming/reporting/labeling are queued instead of inline.

## Pilot Launch Gates

### Gate A: Multi-Participant Reliability

- [x] Only teacher/session owner can enter-video, start, end, pause, resume, force-speak, set goals, or adjust Plato parameters.
- [x] Participant closing/leaving Jitsi does not end the server session.
- [x] Late joiners enter the live video/discussion state without rebroadcasting warmup commands to everyone.
- [x] Duplicate display names remain distinct participant records.
- [x] Reconnect during the grace window preserves participant identity.
- [ ] 3-client browser smoke: teacher + two students can join, see one another, speak, mute, reconnect, and end only by teacher action.
- [ ] Jitsi mute stops STT locally and resumes cleanly on unmute.
- [ ] No duplicate Jitsi iframe, local stream, remote video, or STT stream after join/rejoin.

Done When:

A messy real class can tolerate late arrivals, duplicate first names, page refreshes, muting, and one student leaving without corrupting the room.

### Gate B: Transcript Truth

- [x] Spoken/typed participant turns persist with DB message IDs.
- [x] Message analytics rows are written from persisted messages.
- [x] Session analytics response includes transcript messages.
- [ ] Live transcript, post-session transcript, and analytics modal show the same turns.
- [ ] Participant message counts match transcript rows.
- [ ] Speaking time is either measured from reliable audio events or labeled clearly as estimated.
- [ ] STT failure, muted mic, and transcript gaps are visible to the teacher.
- [ ] Conversation replay/debug view shows what Plato saw, why it spoke or stayed silent, and which move was selected.

Done When:

No pilot report can show "0s speaking" or "0 messages" when a real conversation happened.

### Gate B2: Facilitation Controls

- [ ] Pre-session Plato posture setting exists.
- [ ] Live teacher control exists for question propensity.
- [ ] Available modes: questions-only, mostly questions, balanced, and synthesis/directive.
- [ ] Mode changes are broadcast to the room and persisted with the session.
- [ ] Plato intervention logs include the active posture mode.
- [ ] Teacher can see the current mode without opening a hidden dashboard.

Done When:

A teacher can tune Plato from "only ask questions" to "occasionally synthesize or direct" before and during a live discussion, and reports can explain which mode was active.

### Gate C: Consent And Data Capture

- [ ] Consent screen appears before mic/transcription starts.
- [ ] Data-use mode is stored per session and participant.
- [ ] Teacher can choose: no retention, report-only retention, or consented research/eval retention.
- [ ] Student/child consent and teacher approval are both required before parent access to child-specific comments, favorites, or transcript-linked analytics.
- [ ] Export/delete path exists for transcripts and participant records.
- [ ] LLM-assisted labeling queue can consume only consented sessions.
- [ ] Data export format includes speaker turns, timestamps, move labels, model metadata, and redaction status.
- [x] Signed session-access tokens allow easy guest joins without reopening raw transcript/material routes by short code alone.

Done When:

The app can collect useful multiparty data without surprising parents, students, teachers, or future institutional buyers.

### Gate D: One Paying Client

- [ ] First ICP is selected and not changed mid-sprint.
- [ ] One-paragraph offer names buyer, user, session format, outcome, price, and schedule.
- [ ] Demo reading/topic is ready.
- [ ] Teacher report preview is ready.
- [ ] 50-prospect list exists.
- [ ] 20 direct messages/calls completed.
- [ ] 5 discovery conversations completed.
- [ ] 1 paid pilot, invoice, or written paid-intent agreement secured.

Done When:

At least one real buyer agrees to pay for a real recurring discussion, not merely watch an AI demo.

## Launch Gates

### Gate 0: Internal Demo Ready

Status: In progress.

- [ ] One happy-path demo class exists.
- [ ] One public-domain reading or prompt is preloaded.
- [ ] Host can create/start/end a session without code changes.
- [ ] At least two participants can join and speak.
- [ ] Plato can generate opening, nudges, and closing.
- [ ] Transcript and report are visible after session.
- [ ] No obviously public transcript/source-material leak remains in demo flow.
- [ ] No participant can accidentally end or control the room.
- [ ] Late join/rejoin demo works without doubled audio/video.

Done When:

The demo can be shown live in under 10 minutes without explaining missing core product pieces.

### Gate 1: Trust-Safe Pilot Ready

Status: Not started.

- [ ] Teacher controls are authorized.
- [ ] Session/material/transcript endpoints are protected.
- [ ] Consent screen exists for participants and parents/guardians where relevant.
- [ ] Data-use mode is stored with session and participant records.
- [ ] Retention default is visible and safe.
- [ ] Parent/teacher report is useful without exposing unnecessary raw transcript by default.
- [ ] Failure states are clear: no mic, no AI key, no live session, ended session, no consent.

Done When:

A real parent, teacher, or co-op organizer can use the product without creating avoidable privacy or control risk.

### Gate 2: First Paid Pilot

Status: Not started.

- [ ] One target segment selected.
- [ ] Pilot offer written in one paragraph.
- [ ] Pricing test selected.
- [ ] 50-prospect list built.
- [ ] 20 direct messages or calls completed.
- [ ] 5 serious conversations completed.
- [ ] 1 pilot scheduled.
- [ ] Payment, invoice, or written paid-intent agreement secured.

Done When:

At least one buyer commits money or a clear paid continuation decision after the first session.

### Gate 3: Repeatable Pilot Loop

Status: Not started.

- [ ] 3 live sessions completed.
- [ ] Participants return for a second session or explicitly request one.
- [ ] Consent rate is measured.
- [ ] Post-session report is delivered.
- [ ] At least 30-60 minutes manually labeled.
- [ ] Baseline model comparison completed.
- [ ] Top 5 product failures logged and prioritized.

Done When:

The product has evidence that the unit works: people show up, talk to each other, value the AI host, and want another session.

## 90-Day Execution Board

### Days 1-7: Pilot Readiness Sprint

- [x] Fix teacher-control WebSocket authorization.
  - Done When: student/guest clients cannot pause, resume, force-speak, start, or end a session.
- [x] Protect transcript/source/material/session APIs.
  - Done When: unauthenticated users cannot view or modify protected session assets with only a short code.
- [x] Fix active-session late join, duplicate-name identity, and reconnect behavior.
  - Done When: targeted WebSocket tests cover each case.
- [x] Fix Jest discovery.
  - Done When: full test run ignores `.claude`, `.local`, nested worktrees, and generated repo copies.
- [ ] Add browser-level 3-client smoke test.
  - Done When: it verifies join, late join, mute/STT, reconnect, transcript visibility, and teacher-only end.
- [ ] Create pilot demo flow.
  - Done When: a new user can run a canned seminar demo from login to report.
- [ ] Draft consent/data-use copy.
  - Done When: a participant sees plain-language choices before transcription/recording.
- [ ] Add Plato question-posture control to setup and live room.
  - Done When: teacher can switch between questions-only, mostly questions, balanced, and synthesis/directive.

### Days 8-21: First Client Sprint

- [ ] Select first ICP.
  - Recommended: homeschool/co-op seminar pods.
- [ ] Write one-page pilot offer.
  - Done When: offer names buyer, user, outcome, price, schedule, and what data is collected.
- [ ] Build 50-prospect list.
  - Done When: list contains contact, segment, reason for fit, and outreach status.
- [ ] Send 20 targeted messages.
  - Done When: each message offers a concrete pilot, not a vague AI demo.
- [ ] Conduct 5 discovery calls.
  - Done When: notes capture willingness to pay, objections, schedule constraints, consent concerns, and ideal format.
- [ ] Schedule 1 live pilot.
  - Done When: date, participants, reading/topic, consent plan, and price/continuation terms are agreed.

### Days 22-30: Live Pilot Sprint

- [ ] Run 3 sessions or 1 recurring group with 3 meetings scheduled.
- [ ] Capture transcripts only with consent.
- [ ] Deliver parent/teacher report after each session.
- [ ] Collect satisfaction and return-intent survey.
- [ ] Label 30-60 minutes using move taxonomy.
- [ ] Compare Plato interventions with baseline model.
- [ ] Decide next sprint priority: sell more, harden product, or improve AI/evals.

### Days 31-60: Repeatability Sprint

- [ ] Convert first pilot into recurring paid use or documented churn reason.
- [ ] Run 10 total sessions.
- [ ] Add payment/invoicing path.
- [ ] Add scheduling/reminders path.
- [ ] Improve reports from buyer feedback.
- [ ] Add per-session cost tracking.
- [ ] Add model-provider abstraction sufficient to test Gemini for multimodal perception.
- [ ] Build first labeled eval set from consented sessions.
- [ ] Evaluate which question-posture mode creates the best human-to-human reply ratio.
- [ ] Run a Gemini multimodal spike only after the core room is reliable.
  - Done When: compare Gemini against current provider on live audio/video perception, intervention timing, cost, and transcript quality.

### Days 61-90: Scale Decision Sprint

- [ ] Reach 3 paying groups or 1 institutional buyer.
- [ ] Reach 25 total completed sessions.
- [ ] Maintain at least 50 percent repeat-session intent or actual return.
- [ ] Produce a data quality report: consent rate, transcript quality, labelability, intervention quality.
- [ ] Decide whether to double down on homeschool/co-op, pivot to cohort instructors, or test social rooms.
- [ ] Prepare investor/partner narrative only if usage, retention, and data quality are real.

## Metrics Checklist

### Product Usage

- [ ] Sessions created.
- [ ] Sessions started.
- [ ] Sessions completed.
- [ ] Average session duration.
- [ ] Participants per session.
- [ ] Participant show-up rate.
- [ ] Return rate by group.
- [ ] Number of groups that request another session.

### Facilitation Quality

- [ ] AI talk ratio.
- [ ] Human-to-human reply ratio.
- [ ] Number of facilitator interventions.
- [ ] Move distribution.
- [ ] Silence/restart handling success.
- [ ] Dominance/inclusion handling success.
- [ ] Parent/teacher quality rating.
- [ ] Participant "AI helped conversation" rating.

### Business

- [ ] Prospects contacted.
- [ ] Discovery calls booked.
- [ ] Pilots scheduled.
- [ ] Paid pilots.
- [ ] Price accepted.
- [ ] Churn or rejection reason.
- [ ] Gross margin per session.
- [ ] LLM/STT cost per session.

### Data And Evals

- [ ] Consent rate.
- [ ] Transcript completeness.
- [ ] Audio/STT quality.
- [ ] Labelable minutes collected.
- [ ] LLM-prelabel accuracy sample.
- [ ] Human verification time per hour.
- [ ] Baseline vs Plato eval score.
- [ ] Edge-case examples collected: silence, dominance, conflict, tenderness, confusion, repair.

### Trust And Safety

- [ ] Unauthorized transcript access attempts blocked.
- [ ] Unauthorized teacher controls blocked.
- [ ] Consent captured.
- [ ] Retention policy applied.
- [ ] Delete/export requests tracked.
- [ ] Parent-safe report mode respected.
- [ ] Parent child-comment access respects dual-permission grants.
- [ ] Incident log maintained.

## Backlog

### Must Do Before Paid Pilot

- [x] WebSocket role checks.
- [x] Protected session/material/transcript routes.
- [x] Active late join and reconnect identity fix.
- [x] Duplicate display-name fix.
- [ ] Consent/data-use mode.
- [ ] Demo seminar flow.
- [x] Jest ignore patterns.
- [ ] Browser-level 3-client smoke test.
- [ ] Transcript truth checks in analytics/report modal.
- [ ] Teacher-facing question-posture control.
- [ ] Parent/teacher report polish.
- [ ] Dual-permission parent access model for child-specific transcript/timeline details.

### Should Do Soon

- [x] Signed guest/session access tokens.
- [ ] Simple manual billing/invoice flow.
- [ ] Scheduling/reminder shell.
- [ ] Per-session cost tracking.
- [ ] Provider abstraction.
- [ ] Labeling queue.
- [ ] Report export.
- [ ] Admin retention controls.
- [ ] Parent/child/teacher permission grants for timeline comments, favorites, and transcript excerpts.
- [ ] Conversation replay/debugger for Plato decisions.
- [ ] Teacher transcript-health indicator.
- [ ] Persisted intervention-mode controls and telemetry.
- [ ] Pilot onboarding checklist: reading, roster, consent, schedule, price.

### Later Product Bets

- [ ] Gemini multimodal experiment for live audio/video perception.
- [ ] Curriculum library.
- [ ] Cohort recurring schedules.
- [ ] Alumni/book-club rooms.
- [ ] Language-learning rooms.
- [ ] Peer-support-adjacent rooms.
- [ ] Social spinout: recurring AI-hosted five-person rooms.

### Deliberately Deprioritized Until Reliability Is Proven

- [ ] Japan social pilot.
- [ ] Healthtech/therapy positioning.
- [ ] Teacher-training simulations.
- [ ] Complex LMS integrations.
- [ ] Broad analytics dashboards beyond what the first paying teacher needs.
- [ ] Consumer social matching beyond a narrow recurring-group experiment.

### Research/Data Partnerships

- [ ] Homeschool/co-op seminar data.
- [ ] Cohort-course discussion data.
- [ ] College seminar data.
- [ ] Alumni/book club data.
- [ ] Language circle data.
- [ ] Group coaching data.
- [ ] Toastmasters/writing workshop data.
- [ ] Japan partner exploration.
- [ ] Game/voice lobby contrast dataset.

## Data Pipeline Scorecard

Use this table for every possible data source.

| Source | Consent | Recurrence | Richness | Audio Quality | Label Cost | Buyer Adjacent | Risk | Scale | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Homeschool seminar pods | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] pursue / wait / kill |
| College seminars | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] pursue / wait / kill |
| Alumni/book clubs | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] pursue / wait / kill |
| Language circles | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] pursue / wait / kill |
| Group coaching | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] pursue / wait / kill |
| Peer support | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] pursue / wait / kill |
| Japanese AI/social pilot | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] pursue / wait / kill |
| Game lobbies | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] pursue / wait / kill |

## Kill Or Pivot Criteria

### Kill/Pivot The Homeschool Wedge If:

- [ ] Fewer than 1 in 10 qualified prospects agrees to a serious pilot conversation.
- [ ] No one will pay anything after 20 serious prospects.
- [ ] Parents like the idea but will not schedule recurring sessions.
- [ ] Students do not want a second session.
- [ ] The AI facilitator is not perceived as meaningfully better than a generic model prompt.

### Kill/Pivot The Data-Moat Thesis If:

- [ ] Consent rates are too low to build a meaningful dataset.
- [ ] Transcript quality is too poor for labeling without expensive cleanup.
- [ ] Labeling one hour costs too much even with LLM prelabeling.
- [ ] Baseline frontier models match the app's facilitation quality after simple prompting.
- [ ] Real edge cases are too rare or too private to collect ethically.

### Kill/Pivot The Social Spinout If:

- [ ] Recurring groups do not reform after initial sessions.
- [ ] Users prefer one-on-one AI companionship to human group rooms.
- [ ] Moderation burden is too high before retention is proven.
- [ ] The product cannot create group continuity without heavy manual curation.
- [ ] The social usage data does not improve the core facilitation model or product.

### Continue/Double Down If:

- [ ] At least one buyer pays or commits to paid continuation.
- [ ] Participants want to meet again.
- [ ] Parent/teacher reports are valued.
- [ ] Consent rates are high enough for eval-building.
- [ ] Labeled data reveals clear failures and improvements versus baseline models.
- [ ] The app gets humans talking to each other more, not merely talking to the AI.

## Weekly Review Template

Copy this block into `status.md` during weekly review or let push snapshots track implementation progress.

```md
## Weekly Review - YYYY-MM-DD

### Shipped
- [ ] 

### Learned
- [ ] 

### Metrics
- Sessions:
- Prospects contacted:
- Discovery calls:
- Pilots scheduled:
- Paid users:
- Consent rate:
- Repeat intent:

### Risks
- [ ] 

### Next Week
- [ ] 
```
