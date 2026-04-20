# Source-Text Comprehension Roadmap

Goal: Plato should follow source material like a human facilitator — quoting accurately when wording diverges, knowing which passages have been covered, and steering the group toward what's been skipped.

Today's baseline ([primer.js](server/content/primer.js), [enhancedFacilitator.js:471](server/enhancedFacilitator.js:471), [materialChunks.js](server/db/repositories/materialChunks.js)):
- Whole-text prime pass produces summary/themes/tensions/angles, stored once at upload time, capped at 80k chars.
- Per-turn grounding does keyword-overlap search across line-based chunks, returns top 4 as `RELEVANT SOURCE EXCERPTS`.
- No semantic retrieval, no coverage tracking, no chunk structure awareness, no theme refresh.

The roadmap below is ordered by impact-per-effort. Each phase is independently shippable — we can stop after any one and have a real product improvement.

---

## Phase 1 — Semantic retrieval + smarter chunking

**Why first:** Single biggest quality win. Most "Plato missed it" complaints will be retrieval failures (paraphrase, synonym, indirect reference). Semantic search fixes that. Better chunks make every later phase work better.

**User-visible change:** Plato quotes the right passage even when participants paraphrase. He cites a premise + its conclusion together instead of one orphaned sentence.

**Mechanism:**
- Add `embedding` column (`vector(1536)` via pgvector, or JSON if we want to defer pgvector install) to `material_chunks`.
- On upload, embed each chunk (Voyage AI `voyage-3-lite` is cheap + strong; OpenAI `text-embedding-3-small` is fine too). Cache; don't re-embed on every session.
- Chunker: replace line-based with paragraph-aware chunking (split on `\n\n`, target 400-800 tokens, prefer not to split mid-sentence). Add ~50-token overlap so argument structure survives.
- Retrieval: embed the query (last participant turn + opening question), cosine top-K=8, then keep best 4 by score.
- Keep keyword overlap as a fallback / hybrid score (BM25-ish boost on rare terms).

**Effort:** ~2-3 days. Embedding API integration + migration + chunker rewrite + query path swap. pgvector is the only infra wrinkle (Railway supports it but needs an extension enable).

**Risks:**
- pgvector extension on Railway — if blocked, fall back to in-memory cosine over a JSON column. Fine up to ~1000 chunks per session.
- Embedding cost: ~$0.0001 per chunk; negligible for our scale, real if we ever index a full curriculum library.

**Decision gate:** Ship it. There's no scenario where we're better off with the current keyword search.

---

## Phase 2 — Coverage tracking ("passages discussed")

**Why second:** Unblocks active steering (Phase 3). On its own it also makes the post-session report dramatically better — "you covered §1-3 but skipped the cave allegory entirely" is the kind of insight a teacher actually wants.

**User-visible change:** The post-session report shows a coverage map. Plato (Phase 3) starts gently surfacing skipped passages.

**Mechanism:**
- New table `chunk_coverage(session_id, chunk_id, first_referenced_at, reference_count, sample_message_id)`.
- After each participant turn (and each Plato turn), reuse the Phase 1 retrieval: any chunk above a similarity threshold (~0.75) gets logged as "referenced."
- Cheap. No extra LLM calls. Piggybacks on the per-turn grounding we're already running.
- Surface in [reportBuilder.js](server/reportBuilder.js): % of source covered, list of unexplored sections with first-line snippets.

**Effort:** ~1 day. New repo + migration + a few lines in the per-turn handler + report renderer additions.

**Risks:** False positives if similarity threshold is too low. Tune on real sessions, not unit tests.

**Decision gate:** Ship if Phase 1 retrieval scores are well-calibrated (i.e. cosine values mean something). If retrieval is noisy, fix that first or coverage will lie.

---

## Phase 3 — Active steering toward unexplored material

**Why third:** Now Plato can actually use the coverage data. This is where "Plato follows along" becomes "Plato teaches with the text."

**User-visible change:** Mid-discussion, Plato says things like "you've all engaged with the prisoner's escape — what about what happens when he returns to the cave?" Done well, this is what makes a facilitator feel present rather than reactive.

**Mechanism:**
- New move type in [enhancedFacilitator.js](server/enhancedFacilitator.js): `surface_unexplored`. Eligible when coverage < 50% AND conversation has stalled OR turn count > 8.
- Move logic: pick highest-importance uncovered chunk (importance from Phase 4 below, or fallback to chunk_index). Inject as `UNEXPLORED PASSAGE` into prompt with explicit "you may bring this in if it serves the inquiry, never force it" guardrail.
- Rate-limit: at most one steering move per ~5 minutes; never two in a row.

**Effort:** ~2 days, mostly prompt iteration. The plumbing is small; getting the prompt to suggest passages without sounding like a checklist is the work.

**Risks:**
- Plato becomes pushy if the steering move triggers too often. Default conservative.
- Off-topic students get yanked back to the text when they've found something interesting on their own. Don't trigger when coherence/engagement is high.

**Decision gate:** Ship behind a teacher-facing toggle ("Let Plato surface unexplored passages: on/off"). Watch for "felt rigid" feedback.

---

## Phase 4 — Structured chunk metadata (importance + role)

**Why fourth:** Phase 3 needs to know which uncovered chunk to surface. Today all chunks are equal. They're not — a thesis sentence matters more than a transitional phrase.

**User-visible change:** Steering picks the *interesting* skipped passage, not the next one in document order.

**Mechanism:**
- During the prime pass, run a second LLM call that scores each chunk on `importance` (0-1) and tags `role` (claim, evidence, example, transition, definition). Cheap with Haiku.
- Store on `material_chunks`. One-time per upload.
- Phase 3 ranking uses `importance × (1 − coverage_penalty)`.

**Effort:** ~1 day. New primer step + schema additions + small UI to surface this in the dashboard if useful.

**Risks:** Adds ~1-3 sec to upload time for long docs. Acceptable. Run async and let the discussion start without it (degrades to chunk_index ordering).

**Decision gate:** Only build if Phase 3 is in production and we observe steering picking boring passages. May not be needed for short texts.

---

## Phase 5 — Long-document handling

**Why fifth:** Today's 80k-char primer cap silently drops material. For book-length texts (which serious instructors will upload), the bird's-eye is built from page 1 only.

**User-visible change:** Instructors can upload 50-page readings without Plato losing the second half.

**Mechanism:**
- Hierarchical primer: chunk → embed → cluster chunks into ~10 sections → summarize each section with Haiku → summarize the summaries with Sonnet.
- Replace the single primer call with: section_summaries + global_summary + themes-pulled-from-sections.
- For per-turn grounding: nothing changes (retrieval already operates at chunk level).

**Effort:** ~2 days. Mostly orchestration + prompt tuning. Cost goes from ~$0.01/upload to ~$0.05/upload for a 100-page text — still trivial.

**Risks:** Failure modes are silent — a bad section summary doesn't crash anything, it just makes Plato vaguer. Worth instrumenting summary quality on a few real inputs.

**Decision gate:** Build when first instructor complains about a long upload, or proactively before pitching to Polygence/Maven where 30+ page readings are common.

---

## Phase 6 — Theme refresh during discussion

**Why last:** Marginal. The primer's themes/tensions are usually correct enough; the real failure mode is retrieval, not stale themes. Build only if we've shipped 1-5 and still see Plato missing emergent angles.

**User-visible change:** When students discover a tension the primer didn't predict, Plato names it back to them coherently instead of treating it as off-topic.

**Mechanism:**
- Every ~10 turns or after a quiet stretch, run a fast Haiku call: "Given the discussion so far + the source, what tensions are emerging that weren't in the original primer?" Append to `primed_context.emergentThemes`.
- Inject into the per-turn prompt the same way other context is injected.

**Effort:** ~1 day.

**Risks:** Adds latency or cost if triggered too often. Cap aggressively.

**Decision gate:** Don't build until Phases 1-3 are shipped and we have evidence of missed-angle complaints in real sessions.

---

## Suggested sequencing

- **Sprint 1 (1 week):** Phase 1. This alone makes Plato meaningfully smarter and is a precondition for everything else.
- **Sprint 2 (1 week):** Phase 2 + Phase 3. They ship together since 3 needs 2's data.
- **Optional Sprint 3:** Phase 4 if 3 picks bad passages; Phase 5 before pitching long-doc instructors; Phase 6 only on evidence.

## Out of scope (for this roadmap)

- DOCX extraction. Already missing ([extractor.js:152](server/content/extractor.js:152)) — track separately, fix when an instructor needs it.
- OCR improvements for scanned PDFs. Existing path in [ocr.js](server/content/ocr.js) is acceptable.
- Multi-document reasoning (compare-and-contrast across uploads). Real but distinct problem; revisit after Phase 3.
- Citations in Plato's spoken output ("as the text says on page 4…"). Possible after Phase 1; skipped here because it's a UX choice more than a comprehension gap.
