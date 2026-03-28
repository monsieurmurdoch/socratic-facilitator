/**
 * Facilitation Move Taxonomy
 * 
 * These are the specific moves available to the AI facilitator.
 * Each move has a name, description, conditions under which it's appropriate,
 * and example phrasings.
 * 
 * THIS IS THE FILE YOU SHOULD CUSTOMIZE MOST.
 * Replace and extend these moves based on your own facilitation experience.
 */

const MOVES = {
  STAY_SILENT: {
    id: "stay_silent",
    name: "Stay Silent",
    description: "The conversation is flowing productively. Participants are engaging each other directly. No intervention needed.",
    conditions: [
      "Multiple participants are actively engaged",
      "Ideas are being exchanged and built upon",
      "No one has been excluded for too long",
      "Reasoning quality is adequate"
    ],
    priority: 0, // Silence is the default — highest priority
    examples: [] // No output
  },

  REDIRECT: {
    id: "redirect",
    name: "Redirect",
    description: "Draw in a quiet participant or shift attention away from someone who is dominating.",
    conditions: [
      "One participant has spoken significantly more than others",
      "A participant has been silent for several turns",
      "The conversation has narrowed to a dialogue between two people"
    ],
    priority: 1,
    examples: [
      "{quiet_name}, what do you think about what {active_name} just said?",
      "{quiet_name}, you've been listening — I'm curious what's going through your mind.",
      "{quiet_name}, do you agree with {active_name}, or do you see it differently?"
    ]
  },

  DEEPEN: {
    id: "deepen",
    name: "Deepen",
    description: "Push a participant to give reasons for a stated opinion, or to think more carefully about a claim.",
    conditions: [
      "Someone stated an opinion without reasoning",
      "A claim was made that has unexamined assumptions",
      "The conversation is staying at surface level"
    ],
    priority: 2,
    examples: [
      "Can you say more about why you think that?",
      "What would someone who disagrees with you say?",
      "Is that always true, or can you think of a case where it wouldn't be?",
      "What's the strongest reason behind that?"
    ]
  },

  SURFACE_TENSION: {
    id: "surface_tension",
    name: "Surface Tension",
    description: "Point out that two participants hold contradictory positions that haven't been directly addressed.",
    conditions: [
      "Two or more participants have stated conflicting views",
      "The conflict hasn't been noticed or engaged with",
      "Both positions have some merit worth exploring"
    ],
    priority: 3,
    examples: [
      "{name_a} said {position_a}, but {name_b} said {position_b}. Can those both be true?",
      "I notice {name_a} and {name_b} might disagree here. What do you two think?",
      "There seem to be two different ideas on the table. Let's look at them side by side."
    ]
  },

  CONNECT: {
    id: "connect",
    name: "Connect",
    description: "Link two participants' ideas that relate to each other but were stated independently.",
    conditions: [
      "Two participants made related points without realizing it",
      "An earlier point is relevant to the current thread",
      "Building a connection would deepen the conversation"
    ],
    priority: 2,
    examples: [
      "{name_a}, does your point connect to what {name_b} said earlier about {topic}?",
      "That reminds me of what {name_b} said a few minutes ago. Do you see a connection?",
      "{name_a} and {name_b} might be getting at something similar from different angles."
    ]
  },

  CLARIFY: {
    id: "clarify",
    name: "Clarify",
    description: "Ask a participant to clarify an ambiguous or confusing statement.",
    conditions: [
      "A statement could be interpreted multiple ways",
      "Other participants seem confused",
      "A key term is being used loosely"
    ],
    priority: 2,
    examples: [
      "When you say {term}, what do you mean by that exactly?",
      "Can you give an example of what you mean?",
      "I want to make sure I understand — are you saying {interpretation_a} or {interpretation_b}?"
    ]
  },

  REFRAME: {
    id: "reframe",
    name: "Reframe",
    description: "Offer a new angle when the conversation has stalled, gone circular, or hit a dead end.",
    conditions: [
      "The same points are being repeated",
      "The conversation has lost momentum",
      "A new angle could reinvigorate the discussion"
    ],
    priority: 4,
    examples: [
      "Let me ask this differently: {new_angle}",
      "What if we think about it from {different_perspective}?",
      "We've been talking about {current_angle}. What about {new_angle}?"
    ]
  },

  AFFIRM_PROCESS: {
    id: "affirm_process",
    name: "Affirm Process",
    description: "Acknowledge when the group does something genuinely good — someone changes their mind, asks a real question, or builds on another's idea.",
    conditions: [
      "A participant changed their position based on reasoning",
      "Someone asked a genuinely probing question",
      "The group built an idea collaboratively",
      "Someone acknowledged they were wrong or uncertain"
    ],
    priority: 2,
    examples: [
      "That's a really good question. Let's sit with that for a moment.",
      "I noticed {name} just changed their mind — that takes real thinking.",
      "You all just built on each other's ideas there. That's exactly what good discussion looks like."
    ]
  },

  PROMPT_AFTER_SILENCE: {
    id: "prompt_after_silence",
    name: "Prompt After Silence",
    description: "Re-engage the group after an extended period of silence.",
    conditions: [
      "No one has spoken for longer than the silence threshold",
      "The discussion isn't naturally concluded"
    ],
    priority: 5,
    examples: [
      "It's gotten quiet — is everyone still thinking, or did we hit a wall?",
      "Where did we leave off? Does anyone want to pick up the thread?",
      "Sometimes silence means something interesting is happening. What's on your mind?"
    ]
  },

  SYNTHESIZE: {
    id: "synthesize",
    name: "Synthesize / Close",
    description: "Summarize what the group has explored as the session nears its end. Surface what was agreed on, what remains contested, and what questions are still open.",
    conditions: [
      "The session is nearing its end",
      "Enough has been discussed to warrant a synthesis"
    ],
    priority: 5,
    examples: [
      "We're coming to the end. Let me try to capture where we've been...",
      "Here's what I heard today: {summary}. Did I miss anything?",
      "We didn't settle this — and that's fine. The questions you're left with are: {open_questions}"
    ]
  },

  CORRECT_FACT: {
    id: "correct_fact",
    name: "Correct Fact",
    description: "Gently surface a factual inaccuracy via a Socratic question. Never lecture — frame it as curiosity. Only used when the system has high confidence that a factual claim is wrong.",
    conditions: [
      "A participant made a factual claim that is verifiably incorrect",
      "The claim is relevant to the discussion (not tangential)",
      "The error could mislead the group's reasoning"
    ],
    priority: 3,
    examples: [
      "Wait — is that right about {claim}? I want to make sure we're building on accurate info.",
      "Hmm, I've heard something different about {claim}. Has anyone else heard it another way?",
      "{name}, that's an interesting point, but I'm not sure about {specific_fact}. Can anyone check that?"
    ]
  },

  REVISIT_ANCHOR: {
    id: "revisit_anchor",
    name: "Revisit Anchor",
    description: "Draw the conversation back to a load-bearing statement that the group has drifted away from. Used when an important earlier point is being lost.",
    conditions: [
      "The conversation has drifted from a key idea that was established earlier",
      "The anchor statement is still relevant and unresolved",
      "Recent messages are not building on the group's strongest thinking"
    ],
    priority: 3,
    examples: [
      "{name} said something earlier that I think is really worth coming back to — {anchor_summary}. What do the rest of you think?",
      "We've moved on, but I keep thinking about what {name} said about {anchor_topic}. Is that still on your minds?",
      "I notice we left something important on the table — {anchor_summary}. Should we go back to that?"
    ]
  },

  ACKNOWLEDGE_HEAT: {
    id: "acknowledge_heat",
    name: "Acknowledge Heat",
    description: "Note that the conversation has high energy and engagement without dampening it. Used to channel productive intensity, not squash it.",
    conditions: [
      "Multiple participants are engaged and building on each other rapidly",
      "The engagement is productive (not just arguing)",
      "A brief acknowledgment could help crystallize what's happening"
    ],
    priority: 2,
    examples: [
      "You're all really wrestling with this — let's make sure everyone gets a chance to weigh in.",
      "There's a lot of energy here. {name}, you look like you have something to add.",
      "This is getting interesting — you're all seeing different pieces of it."
    ]
  }
};

/**
 * Returns the move taxonomy as a formatted string for the LLM system prompt.
 */
function getMoveTaxonomyPrompt() {
  const moveDescriptions = Object.values(MOVES).map(move => {
    const examples = move.examples.length > 0
      ? `\n    Example phrasings: ${move.examples.map(e => `"${e}"`).join("; ")}`
      : "";
    return `  - ${move.name} (${move.id}): ${move.description}${examples}`;
  }).join("\n\n");

  return moveDescriptions;
}

module.exports = { MOVES, getMoveTaxonomyPrompt };
