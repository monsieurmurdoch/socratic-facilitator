const MESSAGE_ASSESSMENT_FIXTURES = [
  {
    id: 'vague-agreement',
    participantName: 'Maya',
    text: 'Yeah, I agree with that.',
    previousText: 'I think the main character is afraid of being alone.',
    topicTitle: 'Frankenstein',
    openingQuestion: 'What makes Victor responsible for what happens?',
    expected: { specificity: 0.12, profoundness: 0.18, coherence: 0.72, isAnchor: false }
  },
  {
    id: 'reasoned-build',
    participantName: 'Jonah',
    text: 'I think Victor is responsible because he chooses to abandon the creature right after bringing him to life, which means the harm starts with neglect instead of the experiment itself.',
    previousText: 'Maybe the experiment is the real mistake.',
    topicTitle: 'Frankenstein',
    openingQuestion: 'What makes Victor responsible for what happens?',
    expected: { specificity: 0.82, profoundness: 0.7, coherence: 0.86, isAnchor: true }
  },
  {
    id: 'topic-drift',
    participantName: 'Chris',
    text: 'This also reminds me that snow days should be longer.',
    previousText: 'The creature wants recognition from Victor.',
    topicTitle: 'Frankenstein',
    openingQuestion: 'What makes Victor responsible for what happens?',
    expected: { specificity: 0.28, profoundness: 0.1, coherence: 0.08, isAnchor: false }
  },
  {
    id: 'tension-question',
    participantName: 'Lena',
    text: 'But if the creature learns cruelty from being rejected, is the story really about evil, or about what happens when a person is never treated like a person?',
    previousText: 'The creature becomes violent later on.',
    topicTitle: 'Frankenstein',
    openingQuestion: 'What makes Victor responsible for what happens?',
    expected: { specificity: 0.68, profoundness: 0.9, coherence: 0.84, isAnchor: true }
  },
  {
    id: 'example-heavy',
    participantName: 'Noah',
    text: 'For example, in chapter 10 the creature asks for compassion before revenge, so the novel gives Victor a specific moment where he could have chosen repair.',
    previousText: 'Victor never gets a second chance.',
    topicTitle: 'Frankenstein',
    openingQuestion: 'What makes Victor responsible for what happens?',
    expected: { specificity: 0.9, profoundness: 0.62, coherence: 0.79, isAnchor: true }
  },
  {
    id: 'surface-restatement',
    participantName: 'Ava',
    text: 'He made the creature and then things got bad.',
    previousText: 'Victor abandons his creation.',
    topicTitle: 'Frankenstein',
    openingQuestion: 'What makes Victor responsible for what happens?',
    expected: { specificity: 0.24, profoundness: 0.2, coherence: 0.61, isAnchor: false }
  },
  {
    id: 'synthesis',
    participantName: 'Eli',
    text: 'I want to combine what Lena and Jonah said: Victor causes the tragedy both by creating life carelessly and by refusing the obligation that comes after creation.',
    previousText: 'Neglect is what turns the creature toward revenge.',
    topicTitle: 'Frankenstein',
    openingQuestion: 'What makes Victor responsible for what happens?',
    expected: { specificity: 0.72, profoundness: 0.84, coherence: 0.95, isAnchor: true }
  },
  {
    id: 'quiet-but-thoughtful',
    participantName: 'Sara',
    text: 'Maybe responsibility here is less about intention and more about what you still owe once you have power over someone weaker than you.',
    previousText: 'Victor did not mean for anyone to die.',
    topicTitle: 'Frankenstein',
    openingQuestion: 'What makes Victor responsible for what happens?',
    expected: { specificity: 0.58, profoundness: 0.86, coherence: 0.76, isAnchor: true }
  },
  {
    id: 'random-opinion',
    participantName: 'Ty',
    text: 'I just do not like Victor at all.',
    previousText: 'He keeps avoiding the consequences.',
    topicTitle: 'Frankenstein',
    openingQuestion: 'What makes Victor responsible for what happens?',
    expected: { specificity: 0.18, profoundness: 0.16, coherence: 0.54, isAnchor: false }
  },
  {
    id: 'anchor-response',
    participantName: 'Zuri',
    text: 'Building on Sara, power matters because Victor controls whether the creature can belong anywhere, and that makes neglect look like a moral choice instead of an accident.',
    previousText: 'Responsibility might be about obligation after power.',
    topicTitle: 'Frankenstein',
    openingQuestion: 'What makes Victor responsible for what happens?',
    expected: { specificity: 0.78, profoundness: 0.82, coherence: 0.92, isAnchor: true }
  },
  {
    id: 'short-question',
    participantName: 'Ben',
    text: 'So is the creature born evil?',
    previousText: 'The creature becomes violent later.',
    topicTitle: 'Frankenstein',
    openingQuestion: 'What makes Victor responsible for what happens?',
    expected: { specificity: 0.36, profoundness: 0.56, coherence: 0.67, isAnchor: false }
  },
  {
    id: 'novel-distinction',
    participantName: 'Nia',
    text: 'There is a difference between causing suffering and being accountable for the conditions that let suffering spread, and the novel keeps pushing Victor into that second category.',
    previousText: 'He did not directly commit every later crime.',
    topicTitle: 'Frankenstein',
    openingQuestion: 'What makes Victor responsible for what happens?',
    expected: { specificity: 0.74, profoundness: 0.88, coherence: 0.8, isAnchor: true }
  }
];

module.exports = {
  MESSAGE_ASSESSMENT_FIXTURES
};
