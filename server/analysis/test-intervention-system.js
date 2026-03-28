/**
 * Test: Intervention System Prototype
 *
 * Demonstrates the neural-inspired intervention decision system.
 * Run with: node server/analysis/test-intervention-system.js
 */

// Import subsystems
const { InterventionNeuron, WEIGHT_PROFILES } = require('./interventionNeuron');
const { EngagementTracker } = require('./engagementTracker');
const { AnchorTracker } = require('./anchorTracker');
const { ClaimAssessor } = require('./claimAssessor');
const { HumanDeference } = require('./humanDeference');
const { FacilitationOrchestrator } = require('./facilitationOrchestrator');

console.log('\n========================================');
console.log('  INTERVENTION SYSTEM PROTOTYPE TEST');
console.log('========================================\n');

// ─────────────────────────────────────────────────────────────────────────────
// TEST 1: Intervention Neuron
// ─────────────────────────────────────────────────────────────────────────────

console.log('TEST 1: Intervention Neuron');
console.log('─'.repeat(40));

const neuron = new InterventionNeuron('middle');

// Scenario A: Healthy conversation - should stay silent
const healthySignals = {
  engagementScore: 0.8,
  coherenceScore: 0.75,
  topicRelevance: 0.85,
  anchorDrift: 0.2,
  factualError: 0,
  silenceDepth: 0.1,
  dominanceImbalance: 0.1
};

const decision1 = neuron.decide(healthySignals);
console.log('\nScenario A (healthy conversation):');
console.log(`  → Decision: ${decision1.shouldSpeak ? 'SPEAK' : 'SILENT'}`);
console.log(`  → Activation: ${decision1.activation}`);
console.log(`  → Reasoning: ${decision1.reasoning}`);

// Scenario B: Factual error detected - should speak
const errorSignals = {
  engagementScore: 0.6,
  coherenceScore: 0.5,
  topicRelevance: 0.7,
  anchorDrift: 0.3,
  factualError: 0.9,
  silenceDepth: 0.2,
  dominanceImbalance: 0.1
};

const decision2 = neuron.decide(errorSignals);
console.log('\nScenario B (factual error):');
console.log(`  → Decision: ${decision2.shouldSpeak ? 'SPEAK' : 'SILENT'}`);
console.log(`  → Activation: ${decision2.activation}`);
console.log(`  → Reasoning: ${decision2.reasoning}`);

// Scenario C: Drifting + disengaged - should speak
const driftingSignals = {
  engagementScore: 0.3,
  coherenceScore: 0.35,
  topicRelevance: 0.4,
  anchorDrift: 0.75,
  factualError: 0,
  silenceDepth: 0.6,
  dominanceImbalance: 0.2
};

const decision3 = neuron.decide(driftingSignals);
console.log('\nScenario C (drifting + disengaged):');
console.log(`  → Decision: ${decision3.shouldSpeak ? 'SPEAK' : 'SILENT'}`);
console.log(`  → Activation: ${decision3.activation}`);
console.log(`  → Reasoning: ${decision3.reasoning}`);

console.log('\nNeuron stats:', neuron.getStats());

// ─────────────────────────────────────────────────────────────────────────────
// TEST 2: Engagement Tracker
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n\nTEST 2: Engagement Tracker');
console.log('─'.repeat(40));

const engagement = new EngagementTracker({ decayLambda: 0.12 });

// Simulate a conversation
const messages = [
  { name: 'Maya', text: 'I think the ship is still the same because it has the same captain.', specificity: 0.6, profoundness: 0.5, coherence: 0.5 },
  { name: 'Jordan', text: 'But what if the captain changes too?', specificity: 0.5, profoundness: 0.7, coherence: 0.8 },
  { name: 'Alex', text: "That's a good point - so then nothing is the same?", specificity: 0.6, profoundness: 0.6, coherence: 0.85 },
  { name: 'Sam', text: 'I think identity is about continuity, not the exact parts.', specificity: 0.7, profoundness: 0.8, coherence: 0.7 },
  { name: 'Maya', text: 'But where do you draw the line?', specificity: 0.4, profoundness: 0.75, coherence: 0.9 },
  { name: 'Jordan', text: 'Maybe there is no line - maybe it is a spectrum of "sameness".', specificity: 0.8, profoundness: 0.85, coherence: 0.9 },
];

messages.forEach((msg, i) => {
  engagement.recordAssessment({
    messageIndex: i,
    participantName: msg.name,
    text: msg.text,
    specificity: msg.specificity,
    profoundness: msg.profoundness,
    coherence: msg.coherence,
    timestamp: Date.now() + i * 5000
  });
});

console.log('\nEngagement state:', engagement.getState());

// ─────────────────────────────────────────────────────────────────────────────
// TEST 3: Anchor Tracker
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n\nTEST 3: Anchor Tracker');
console.log('─'.repeat(40));

const anchors = new AnchorTracker();

// Add some anchors
const anchor1 = anchors.addAnchor({
  messageIndex: 3,
  participantName: 'Sam',
  text: 'I think identity is about continuity, not the exact parts.',
  profoundness: 0.8,
  summary: 'Identity is continuity, not parts'
});

const anchor2 = anchors.addAnchor({
  messageIndex: 5,
  participantName: 'Jordan',
  text: 'Maybe there is no line - maybe it is a spectrum of "sameness".',
  profoundness: 0.85,
  summary: 'Sameness is a spectrum'
});

// Record some references
anchors.recordReference(anchor2.id, 7, 'Maya');
anchors.recordReference(anchor2.id, 9, 'Alex');
anchors.recordReference(anchor1.id, 10, 'Jordan');

console.log('\nAnchor state:', anchors.getState());
console.log('\nAnchors formatted for prompt:\n' + anchors.formatForPrompt());
console.log('\nAnchor drift (at msg 12, looking back 8):', anchors.computeAnchorDrift(12, 8));

// ─────────────────────────────────────────────────────────────────────────────
// TEST 4: Claim Assessor
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n\nTEST 4: Claim Assessor');
console.log('─'.repeat(40));

const claims = new ClaimAssessor();

// Record some claims
claims.recordClaims(5, 'Jordan', [
  { text: 'Plato wrote the Allegory of the Cave around 380 BC', classification: 'factual', isAccurate: true, confidence: 0.95 },
  { text: 'The Ship of Theseus is about identity', classification: 'normative', isAccurate: null, confidence: 0.9 },
]);

claims.recordClaims(8, 'Alex', [
  { text: 'Aristotle was Platos student', classification: 'factual', isAccurate: true, confidence: 0.99 },
]);

claims.recordClaims(10, 'Sam', [
  { text: 'The concept of identity was invented in the 17th century', classification: 'factual', isAccurate: false, confidence: 0.85, correction: 'Questions of identity and sameness have been debated since ancient Greek philosophy' },
]);

console.log('\nClaim stats:', claims.getStats());
console.log('\nFactual error signal:', claims.getFactualErrorSignal());
console.log('\nErrors formatted:\n' + claims.formatErrorsForPrompt());

// ─────────────────────────────────────────────────────────────────────────────
// TEST 5: Human Deference
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n\nTEST 5: Human Deference');
console.log('─'.repeat(40));

const deference = new HumanDeference();

// Simulate human speaking
deference.humanStartedSpeaking('Maya');
console.log('\nMaya started speaking');
console.log('Should defer?', deference.shouldDefer());

deference.humanStoppedSpeaking('I think the key question here is what makes something the same over time?', 'Maya');
console.log('\nMaya stopped speaking');
console.log('Should defer?', deference.shouldDefer());
console.log('Has invitation?', deference.hasInvitation());

// Simulate explicit invitation
deference.humanStartedSpeaking('Jordan');
deference.humanStoppedSpeaking("What do you think about this, facilitator?", 'Jordan');
console.log('\nJordan invited the AI');
console.log('Has invitation?', deference.hasInvitation());

// Test deferred message
deference.deferMessage("That's a profound question about identity...", 'human_was_speaking');
console.log('\nDeferred a message');
console.log('Has deferred message?', deference.hasDeferredMessage());
console.log('Deferred message:', deference.getDeferredMessage());

// ─────────────────────────────────────────────────────────────────────────────
// TEST 6: Full Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n\nTEST 6: Full Orchestrator');
console.log('─'.repeat(40));

const orchestrator = new FacilitationOrchestrator({
  ageProfile: 'middle',
  topicTitle: 'The Ship of Theseus',
  openingQuestion: 'If you replace every part of something, is it still the same thing?'
});

// Simulate a conversation flow
const conversation = [
  { participantName: 'Maya', text: 'I think the ship is still the same ship because it serves the same purpose.' },
  { participantName: 'Jordan', text: "But what if the purpose changes? Does it become a different ship?" },
  { participantName: 'Alex', text: "That's a great question. I think purpose matters more than the physical parts." },
  { participantName: 'Sam', text: "But then isn't the 'second' ship also the same ship if it has the same purpose?" },
  { participantName: 'Maya', text: 'Hmm, that creates a paradox. Both ships could claim to be the original.' },
  { participantName: 'Jordan', text: "Maybe 'same' is the wrong word. Maybe we need to think about different kinds of sameness." },
];

console.log('\nProcessing conversation...\n');

for (const msg of conversation) {
  const result = orchestrator.processMessage(msg);
  console.log(`[${msg.participantName}]: "${msg.text.slice(0, 50)}..."`);
  console.log(`   Phase: ${result.phase}`);
  console.log(`   Engagement: ${result.engagement.engagementScore}`);
  console.log(`   Decision: ${result.decision.shouldSpeak ? 'SPEAK' : 'SILENT'} (${result.decision.reason.slice(0, 40)}...)`);
  console.log('');
}

console.log('\nFinal state:');
console.log(JSON.stringify(orchestrator.getState(), null, 2));

// ─────────────────────────────────────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n========================================');
console.log('  PROTOTYPE TEST COMPLETE');
console.log('========================================');
console.log(`
Key findings:

1. INTERVENTION NEURON
   - Uses sigmoid activation with interpretable weights
   - Negative weights on healthy signals (engagement, coherence) suppress intervention
   - Positive weights on problems (drift, errors, silence) trigger intervention
   - Age-calibrated profiles (young/middle/older)

2. ENGAGEMENT TRACKER
   - Recency-weighted with exponential decay
   - Tracks specificity, profoundness, coherence
   - "Money metric": specificity-relative-to-profoundness

3. ANCHOR TRACKER
   - NO recency bias - weight = references × profundness
   - Auto-upgrades profundness when repeatedly referenced
   - Computes anchor drift for intervention signal

4. CLAIM ASSESSOR
   - Classifies claims as factual/normative/mixed
   - Flags factual errors for correction
   - Never corrects normative claims

5. HUMAN DEFERENCE
   - Always defers when humans are speaking
   - Detects "go ahead" invitations
   - Deferred messages with TTL

6. ORCHESTRATOR
   - Coordinates all subsystems
   - Phase tracking (opening/active/highEngagement/struggling/closing)
   - Single entry point for intervention decisions
`);
