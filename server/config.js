/**
 * Session Configuration
 * 
 * This is where you define discussion topics, age calibration,
 * and the parameters that control how aggressively the facilitator intervenes.
 */

const DISCUSSION_TOPICS = [
  {
    id: "ship-of-theseus",
    title: "The Ship of Theseus",
    passage: `Imagine a wooden ship that has been sailing for hundreds of years. Over time, every single plank of wood gets replaced with a new one. Eventually, none of the original wood remains. Is it still the same ship? Now imagine someone collected all the old planks and built a second ship from them. Which one is the "real" ship?`,
    openingQuestion: "If you replace every single part of something, is it still the same thing? What do you think — and why?",
    followUpAngles: [
      "Does this apply to people? Your body replaces its cells over time.",
      "What makes something 'the same' — its parts, its shape, its history, or something else?",
      "If both ships exist at the same time, can they both be the 'real' ship?"
    ],
    ageRange: { min: 8, max: 18 }
  },
  {
    id: "fair-unfair",
    title: "What Makes Something Fair?",
    passage: `Three friends find $30 on the ground. Alex says they should split it equally — $10 each. But Jordan says she saw it first, so she should get more. Sam says they should give it to whoever needs it most, because he knows Jordan's family has more money than his. They can't agree.`,
    openingQuestion: "Who do you think is right — Alex, Jordan, or Sam? And what does 'fair' actually mean here?",
    followUpAngles: [
      "Is 'equal' the same as 'fair'?",
      "Does it matter who saw it first? Why or why not?",
      "Should how much money someone already has change what they deserve?"
    ],
    ageRange: { min: 8, max: 14 }
  },
  {
    id: "lying-always-wrong",
    title: "Is Lying Always Wrong?",
    passage: `Your friend shows you a drawing they spent all week on. They're really proud of it and ask what you think. You don't think it's very good. Should you tell the truth? What if your friend is about to enter it in a contest and you know they'll be embarrassed?`,
    openingQuestion: "Is it ever okay to lie? Where do you draw the line?",
    followUpAngles: [
      "Is there a difference between lying and just not saying something?",
      "Does it matter why you're lying?",
      "Would you want someone to lie to protect your feelings?"
    ],
    ageRange: { min: 8, max: 14 }
  },
  {
    id: "ai-and-art",
    title: "Can a Machine Create Art?",
    passage: `A painting made by an AI program recently won first place in an art competition. The person who typed the instructions into the AI said he's the artist. The other competitors, who painted by hand, said it wasn't fair. The judges didn't know it was made by AI when they chose it.`,
    openingQuestion: "Is the AI painting real art? And if so, who's the artist — the machine or the person who gave it instructions?",
    followUpAngles: [
      "What makes something 'art' in the first place?",
      "Does it matter how something was made, or only how it makes you feel?",
      "If the judges liked it before they knew, does knowing change whether it's good?"
    ],
    ageRange: { min: 10, max: 18 }
  },
  {
    id: "allegory-of-cave",
    title: "Plato's Cave",
    passage: `Imagine people who have lived their entire lives chained inside a dark cave, facing a wall. Behind them is a fire, and between the fire and the prisoners, people carry objects that cast shadows on the wall. The prisoners have never seen anything except these shadows, so they believe the shadows are real things. One day, a prisoner breaks free and walks outside into the sunlight. At first the light hurts his eyes, but slowly he sees the real world — trees, animals, the sun. He goes back to tell the others, but they think he's crazy. They don't believe him.`,
    openingQuestion: "Why wouldn't the prisoners believe the one who came back? And how would you know if you were still in the cave?",
    followUpAngles: [
      "Is there anything in your life that might be a 'shadow' — something you think is real but might not be?",
      "Was the freed prisoner right to go back? What would you have done?",
      "Can someone show you the truth, or do you have to discover it yourself?"
    ],
    ageRange: { min: 10, max: 18 }
  }
];

/**
 * Age calibration affects vocabulary, question complexity,
 * and how much patience the system shows.
 */
const AGE_CALIBRATION = {
  young: {    // 8-10
    label: "young",
    vocabLevel: "simple, concrete language. Short sentences. Use examples from everyday life.",
    silenceToleranceSec: 20,
    maxQuestionComplexity: "one-step questions. No hypotheticals stacked on hypotheticals.",
    encouragementFrequency: "higher"
  },
  middle: {   // 11-14
    label: "middle",
    vocabLevel: "moderate vocabulary. Can handle some abstraction but ground it in examples.",
    silenceToleranceSec: 30,
    maxQuestionComplexity: "can handle 'what if' scenarios and comparisons between positions.",
    encouragementFrequency: "moderate"
  },
  older: {    // 15-18
    label: "older",
    vocabLevel: "sophisticated vocabulary is fine. Can handle nuance and ambiguity.",
    silenceToleranceSec: 45,
    maxQuestionComplexity: "multi-layered questions, paradoxes, and challenges to assumptions.",
    encouragementFrequency: "sparing — only when genuinely earned"
  }
};

/**
 * Facilitation parameters — these control how aggressive the AI is.
 * Start conservative (high thresholds, long delays) and tune down.
 */
const FACILITATION_PARAMS = {
  // Minimum seconds between AI interventions
  minInterventionGapSec: 15,

  // Minimum number of participant messages before AI can speak again
  minMessagesBetweenInterventions: 3,

  // After this many seconds of total silence, the AI should prompt
  silenceTimeoutSec: 45,

  // If one person has spoken this % of total messages, redirect
  dominanceThreshold: 0.5,

  // If someone hasn't spoken in this many messages, consider drawing them in
  quietThreshold: 5,

  // Maximum AI messages as a proportion of total messages
  maxAITalkRatio: 0.15,

  // Session duration in minutes
  sessionDurationMin: 25
};

function getAgeCalibration(ages) {
  if (!ages || ages.length === 0) return AGE_CALIBRATION.middle;
  const avg = ages.reduce((a, b) => a + b, 0) / ages.length;
  if (avg <= 10) return AGE_CALIBRATION.young;
  if (avg <= 14) return AGE_CALIBRATION.middle;
  return AGE_CALIBRATION.older;
}

module.exports = {
  DISCUSSION_TOPICS,
  AGE_CALIBRATION,
  FACILITATION_PARAMS,
  getAgeCalibration
};
