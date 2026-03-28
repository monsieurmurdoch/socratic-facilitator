#!/usr/bin/env node
/**
 * Pedagogical Engine Demo — Merged System
 *
 * Runs a synthetic "Ship of Theseus" conversation through the full
 * merged analysis pipeline including:
 * - LLM analysis (with heuristic fallback)
 * - Anchor tracking (heuristic + LLM)
 * - Engagement scoring (recency-weighted)
 * - Claim assessment
 * - Human deference (turn-taking)
 * - Phase tracking
 * - Intervention type routing
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... node server/analysis/demo.js
 *   node server/analysis/demo.js   (runs with heuristic fallback if no key)
 */

require('dotenv').config();
const { ConversationAnalyzer } = require('./conversationAnalyzer');

// ---- Synthetic conversation ----
// Designed to exercise every subsystem:
// - Vague agreement (low specificity)         → message #2
// - Profound question (high profoundness)     → message #1
// - Factual error (7-year cell replacement)   → message #3
// - Repeated references to earlier statement  → messages #5, #7, #10
// - Off-topic drift                           → message #9
// - "Go ahead" invitation                     → message #4
// - Dominance (Jordan speaks a lot)           → 4 of 12 messages

const CONVERSATION = [
  { name: 'Jordan', text: "I think it's still the same ship. Even if you replace all the wood, it's the same ship because people still call it the same name.", delay: 0 },
  { name: 'Alex',   text: "But names are just labels. If I change my name, am I a different person?", delay: 3000 },
  { name: 'Sam',    text: "Yeah, I agree with Alex.", delay: 2000 },
  { name: 'Jordan', text: "That's different though. A person has a mind and memories. A ship is just wood. What makes a person the same person is their memories, not their body. Your cells replace themselves every 7 years, so you're literally a different physical person already.", delay: 5000 },
  { name: 'Alex',   text: "Wait, is that actually true? The 7 year thing? What do you think about that?", delay: 4000 },
  { name: 'Sam',    text: "I heard that too. But going back to what Jordan said about names being just labels — I actually think names matter more than we think. Like, the ship has a history attached to its name. That history doesn't transfer to the new ship made from old planks.", delay: 8000 },
  { name: 'Jordan', text: "Exactly! The history is what makes it the same ship. Not the physical wood.", delay: 2500 },
  { name: 'Alex',   text: "But then what about the second ship — the one built from the old planks? It has the original physical material AND you could argue it has the history too, since those planks were there for the whole journey.", delay: 10000 },
  { name: 'Sam',    text: "Hmm, that's a really interesting point. So there could be two 'real' ships?", delay: 6000 },
  { name: 'Jordan', text: "No way. There can only be one real ship. It's like how you can't have two originals of a painting. Speaking of art, did anyone see that AI art that won the competition? That's kind of related.", delay: 3000 },
  { name: 'Alex',   text: "Going back to what Sam said about history being tied to the name — I think that's the most important idea here. History can't be in two places at once. So whichever ship has the continuous history is the real one.", delay: 12000 },
  { name: 'Sam',    text: "But what does 'continuous' even mean? Jordan's point about the cells replacing — even if the 7-year thing isn't exactly right — the idea is that replacement happens gradually. Does the speed of replacement matter?", delay: 15000 },
];

// ---- Run the demo ----

async function run() {
  const hasKey = !!process.env.ANTHROPIC_API_KEY;

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║       PEDAGOGICAL ENGINE DEMO — Ship of Theseus            ║');
  console.log('║               (Merged System)                              ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`\n  LLM Analysis: ${hasKey ? '✅ Enabled' : '⚠ Disabled (using heuristic fallback)'}`);
  console.log(`  Mode: ${hasKey ? 'Full LLM + heuristic' : 'Heuristic-only'}\n`);

  const analyzer = new ConversationAnalyzer({
    openingQuestion: "If you replace every single part of something, is it still the same thing?",
    topicTitle: "The Ship of Theseus",
    ageProfile: 'middle'
  });

  let fakeTimestamp = Date.now();

  for (let i = 0; i < CONVERSATION.length; i++) {
    const msg = CONVERSATION[i];
    fakeTimestamp += msg.delay;

    console.log(`\n${'─'.repeat(62)}`);
    console.log(`  MSG #${i}: [${msg.name}] "${msg.text.substring(0, 55)}${msg.text.length > 55 ? '...' : ''}"`);
    console.log(`${'─'.repeat(62)}`);

    try {
      const decision = await analyzer.processMessage({
        index: i,
        participantName: msg.name,
        text: msg.text,
        timestamp: fakeTimestamp,
        totalMessages: i + 1,
        dominanceImbalance: computeDominance(CONVERSATION.slice(0, i + 1))
      });

      // Print analysis results
      const analysis = decision.context?.latestAnalysis || {};
      console.log(`\n  📊 Assessment:`);
      console.log(`     Specificity:     ${bar(analysis.specificity)} ${(analysis.specificity ?? 0.5).toFixed(2)}`);
      console.log(`     Profoundness:    ${bar(analysis.profoundness)} ${(analysis.profoundness ?? 0.5).toFixed(2)}`);
      console.log(`     Coherence:       ${bar(analysis.coherence)} ${(analysis.coherence ?? 0.5).toFixed(2)}`);
      console.log(`     Topic relevance: ${bar(analysis.topicRelevance)} ${(analysis.topicRelevance ?? 0.5).toFixed(2)}`);

      // Print tracker states
      console.log(`\n  📈 Running scores:`);
      console.log(`     Engagement (recency-weighted): ${analyzer.engagement.getEngagementScore().toFixed(3)}`);
      console.log(`     Coherence  (recency-weighted): ${analyzer.engagement.getCoherenceScore().toFixed(3)}`);
      console.log(`     Anchor drift:                  ${analyzer.anchors.computeAnchorDrift(i + 1).toFixed(2)}`);
      console.log(`     Factual error signal:          ${analyzer.claims.getFactualErrorSignal().toFixed(2)}`);
      console.log(`     Phase:                         ${analyzer.phase}`);

      // Print anchors
      const topAnchors = analyzer.anchors.getTopAnchors(3);
      if (topAnchors.length > 0) {
        console.log(`\n  ⚓ Top anchors:`);
        for (const a of topAnchors) {
          console.log(`     [w=${a.weight.toFixed(2)}] "${a.summary}" (refs: ${a.referenceCount})`);
        }
      }

      // Print claims
      if (analysis.claims?.length > 0) {
        console.log(`\n  📋 Claims extracted:`);
        for (const c of analysis.claims) {
          const icon = c.classification === 'factual'
            ? (c.isAccurate === false ? '❌' : '✓')
            : '💭';
          console.log(`     ${icon} [${c.classification}] "${c.text.substring(0, 50)}${c.text.length > 50 ? '...' : ''}"`);
          if (c.isAccurate === false && c.correction) {
            console.log(`       → Correction: ${c.correction}`);
          }
        }
      }

      // Print deference state
      const defState = decision.context?.deferenceState || {};
      if (defState.humanInvitedAI) {
        console.log(`\n  🙋 Human invited AI to speak!`);
      }

      // Print neuron decision
      console.log(`\n  🧠 Neuron: ${decision.reasoning}`);
      if (decision.interventionType) {
        console.log(`     📋 Intervention type: ${decision.interventionType}`);
      }
      console.log(`     ${decision.shouldSpeak ? '🔴 FIRE → FACILITATOR SHOULD SPEAK' : '🟢 QUIET → Stay silent'}`);

    } catch (error) {
      console.error(`  ❌ Error processing message: ${error.message}`);
    }
  }

  // ---- Final summary ----
  console.log(`\n${'═'.repeat(62)}`);
  console.log(`  FINAL STATE`);
  console.log(`${'═'.repeat(62)}`);

  const state = analyzer.getFullState();

  console.log(`\n  Phase:      ${state.phase}`);
  console.log(`  Engagement: ${state.engagement.engagementScore}`);
  console.log(`  Coherence:  ${state.engagement.coherenceScore}`);
  console.log(`  Messages:   ${state.messageCount}`);

  console.log(`\n  Neuron stats:`);
  console.log(`    Total decisions: ${state.neuron.stats.totalDecisions}`);
  console.log(`    Speak count:     ${state.neuron.stats.speakCount}`);
  console.log(`    Silent count:    ${state.neuron.stats.silentCount}`);
  console.log(`    Speak rate:      ${(state.neuron.stats.speakRate * 100).toFixed(0)}%`);
  console.log(`    Avg activation:  ${state.neuron.stats.avgActivation}`);

  console.log(`\n  Anchors: ${state.anchors.totalAnchors} total, ${state.anchors.activeAnchors} active`);
  for (const a of state.anchors.topAnchors) {
    console.log(`    [w=${a.weight}] "${a.summary}" (${a.participantName}, refs: ${a.referenceCount})`);
  }

  console.log(`\n  Claims:  ${state.claims.stats.total}`);
  console.log(`    Factual: ${state.claims.stats.factual}, Normative: ${state.claims.stats.normative}, Mixed: ${state.claims.stats.mixed}`);
  console.log(`    Uncorrected errors: ${state.claims.stats.errors}`);

  console.log(`\n  Per-participant engagement:`);
  for (const [name, data] of Object.entries(state.engagement.perParticipant)) {
    console.log(`    ${name}: score=${data.score} (${data.messageCount} messages)`);
  }

  console.log(`\n  Deference: ${state.deference.humanInvitedAI ? 'AI invited' : 'No invitation'}`);
  console.log(`  Events: ${state.deference.recentEvents?.length || 0} recorded`);

  console.log('\n✅ Demo complete.\n');
}

// ---- Helpers ----

function bar(value, width = 20) {
  const v = Math.round((value ?? 0.5) * width);
  return '█'.repeat(v) + '░'.repeat(width - v);
}

function computeDominance(messages) {
  const counts = {};
  for (const m of messages) {
    counts[m.name] = (counts[m.name] || 0) + 1;
  }
  const values = Object.values(counts);
  if (values.length <= 1) return 0;
  const max = Math.max(...values);
  const total = values.reduce((a, b) => a + b, 0);
  const ratio = max / total;
  return Math.max(0, (ratio - (1 / values.length)) / (1 - (1 / values.length)));
}

run().catch(error => {
  console.error('Demo failed:', error);
  process.exit(1);
});
