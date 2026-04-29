const FACILITATION_POLICY_FIXTURES = [
  {
    id: 'flowing-peer-build',
    title: 'Group is building directly on each other',
    topicTitle: 'Ozymandias',
    openingQuestion: 'What remains after power fades?',
    ageProfile: 'older',
    transcript: [
      {
        participantName: 'Maya',
        text: 'I think the statue is ironic because it was supposed to prove power, but the broken pieces prove the opposite.',
        assessment: {
          engagement: { specificity: 0.82, profoundness: 0.72, coherence: 0.78 },
          anchor: { isAnchor: true, profundness: 0.74, summary: 'The broken statue reverses the king’s intended message about power.' }
        }
      },
      {
        participantName: 'Jonah',
        text: 'Building on Maya, the empty desert matters because there is nobody left to be impressed by him.',
        assessment: {
          engagement: { specificity: 0.76, profoundness: 0.68, coherence: 0.86 },
          anchor: { isAnchor: false }
        }
      },
      {
        participantName: 'Priya',
        text: 'That connects to the inscription too, because the words still command people even though the scene makes the command look ridiculous.',
        assessment: {
          engagement: { specificity: 0.8, profoundness: 0.74, coherence: 0.88 },
          anchor: { isAnchor: false },
          referencesAnchors: [1]
        }
      }
    ],
    expected: {
      shouldSpeak: false,
      acceptableMoves: ['stay_silent'],
      rationale: 'Students are specific, coherent, and building on each other. Plato should stay out.'
    }
  },
  {
    id: 'surface-level-needs-deepening',
    title: 'Participant gives unsupported opinion',
    topicTitle: 'Antigone',
    openingQuestion: 'When should conscience override law?',
    ageProfile: 'middle',
    transcript: [
      {
        participantName: 'Ari',
        text: 'Antigone was right because family is important.',
        assessment: {
          engagement: { specificity: 0.34, profoundness: 0.32, coherence: 0.52 },
          anchor: { isAnchor: false }
        }
      },
      {
        participantName: 'Leah',
        text: 'I agree, family matters more than rules.',
        assessment: {
          engagement: { specificity: 0.24, profoundness: 0.28, coherence: 0.64 },
          anchor: { isAnchor: false }
        }
      },
      {
        participantName: 'Ari',
        text: 'Yeah, rules are just rules.',
        assessment: {
          engagement: { specificity: 0.18, profoundness: 0.18, coherence: 0.56 },
          anchor: { isAnchor: false }
        }
      }
    ],
    expected: {
      shouldSpeak: true,
      acceptableMoves: ['deepen', 'clarify', 'challenge_assumption'],
      rationale: 'The group is on topic but stuck at assertion level. Plato should ask for reasons or a distinction.'
    }
  },
  {
    id: 'productive-disagreement',
    title: 'Students are handling disagreement themselves',
    topicTitle: 'Julius Caesar',
    openingQuestion: 'Was Brutus honorable?',
    ageProfile: 'older',
    transcript: [
      {
        participantName: 'Nina',
        text: 'I think Brutus is honorable because he gives up friendship for what he thinks Rome needs.',
        assessment: {
          engagement: { specificity: 0.64, profoundness: 0.58, coherence: 0.66 },
          anchor: { isAnchor: false }
        }
      },
      {
        participantName: 'Owen',
        text: 'I disagree because honor should include loyalty. If he can kill Caesar while calling him a friend, the word honorable gets too loose.',
        assessment: {
          engagement: { specificity: 0.78, profoundness: 0.76, coherence: 0.84 },
          anchor: { isAnchor: true, profundness: 0.76, summary: 'Honor may require loyalty, so Brutus’s betrayal strains the word honorable.' }
        }
      },
      {
        participantName: 'Nina',
        text: 'That is fair, but maybe the hard question is whether loyalty to one person can conflict with loyalty to a whole city.',
        assessment: {
          engagement: { specificity: 0.72, profoundness: 0.82, coherence: 0.9 },
          anchor: { isAnchor: false },
          referencesAnchors: [1]
        }
      }
    ],
    expected: {
      shouldSpeak: false,
      acceptableMoves: ['stay_silent'],
      rationale: 'The students are already surfacing tension and refining the question without help.'
    }
  },
  {
    id: 'student-to-student-question',
    title: 'A student naturally invites a peer in',
    topicTitle: 'The Giver',
    openingQuestion: 'Is safety worth losing freedom?',
    ageProfile: 'middle',
    transcript: [
      {
        participantName: 'Iris',
        text: 'The community is safe, but it seems fake because people cannot choose anything important.',
        assessment: {
          engagement: { specificity: 0.66, profoundness: 0.62, coherence: 0.64 },
          anchor: { isAnchor: false }
        }
      },
      {
        participantName: 'Mateo',
        text: 'But if choices cause pain, maybe removing them protects people from suffering.',
        assessment: {
          engagement: { specificity: 0.62, profoundness: 0.68, coherence: 0.76 },
          anchor: { isAnchor: false }
        }
      },
      {
        participantName: 'Iris',
        text: 'Sana, what do you think? Is it still protection if nobody gets to refuse it?',
        assessment: {
          engagement: { specificity: 0.7, profoundness: 0.76, coherence: 0.88 },
          anchor: { isAnchor: false }
        }
      }
    ],
    expected: {
      shouldSpeak: false,
      acceptableMoves: ['stay_silent'],
      rationale: 'A student is already doing the facilitator move by inviting a peer into the tension.'
    },
    participants: ['Iris', 'Mateo', 'Sana']
  },
  {
    id: 'dominant-speaker-redirect',
    title: 'One student is carrying the room',
    topicTitle: 'The Odyssey',
    openingQuestion: 'What makes Odysseus heroic or unheroic?',
    ageProfile: 'middle',
    transcript: [
      {
        participantName: 'Noah',
        text: 'Odysseus is heroic because he keeps trying even when he loses ships and men.',
        assessment: {
          engagement: { specificity: 0.7, profoundness: 0.55, coherence: 0.62 },
          anchor: { isAnchor: false }
        }
      },
      {
        participantName: 'Noah',
        text: 'Also the Cyclops scene shows he is clever, because nobody else could have made that plan work.',
        assessment: {
          engagement: { specificity: 0.78, profoundness: 0.58, coherence: 0.66 },
          anchor: { isAnchor: false }
        }
      },
      {
        participantName: 'Noah',
        text: 'And even when he makes mistakes, I think that just makes him more human, not less heroic.',
        assessment: {
          engagement: { specificity: 0.64, profoundness: 0.6, coherence: 0.68 },
          anchor: { isAnchor: false }
        }
      },
      {
        participantName: 'Mina',
        text: 'Maybe.',
        assessment: {
          engagement: { specificity: 0.1, profoundness: 0.1, coherence: 0.38 },
          anchor: { isAnchor: false }
        }
      },
      {
        participantName: 'Noah',
        text: 'I still think the mistakes are part of the point because heroes are not perfect.',
        assessment: {
          engagement: { specificity: 0.56, profoundness: 0.5, coherence: 0.64 },
          anchor: { isAnchor: false }
        }
      }
    ],
    expected: {
      shouldSpeak: true,
      acceptableMoves: ['redirect', 'acknowledge_heat'],
      targetParticipantName: 'Ezra',
      rationale: 'Noah is dominating. Plato should invite a quiet participant rather than deepen Noah again.'
    },
    participants: ['Noah', 'Mina', 'Ezra']
  },
  {
    id: 'anchor-drift',
    title: 'Group has drifted from a strong unresolved anchor',
    topicTitle: 'Republic Book VII',
    openingQuestion: 'What does the cave suggest about education?',
    ageProfile: 'older',
    transcript: [
      {
        participantName: 'Sam',
        text: 'Maybe education is painful because it forces you to give up the world that used to feel obvious.',
        assessment: {
          engagement: { specificity: 0.72, profoundness: 0.86, coherence: 0.74 },
          anchor: { isAnchor: true, profundness: 0.86, summary: 'Education is painful because it disrupts what once felt obvious.' }
        }
      },
      {
        participantName: 'Ava',
        text: 'The fire in the cave is interesting because it is not the sun, but it still creates a kind of fake world.',
        assessment: {
          engagement: { specificity: 0.76, profoundness: 0.72, coherence: 0.74 },
          anchor: { isAnchor: false }
        }
      },
      {
        participantName: 'Liam',
        text: 'I saw a movie with a scene like this where people live underground.',
        assessment: {
          engagement: { specificity: 0.36, profoundness: 0.24, coherence: 0.3 },
          anchor: { isAnchor: false }
        }
      },
      {
        participantName: 'Ava',
        text: 'There are a lot of movies like that. The Matrix is one of them.',
        assessment: {
          engagement: { specificity: 0.3, profoundness: 0.22, coherence: 0.32 },
          anchor: { isAnchor: false }
        }
      },
      {
        participantName: 'Liam',
        text: 'Yeah, and the special effects are probably better than old cave shadows.',
        assessment: {
          engagement: { specificity: 0.24, profoundness: 0.16, coherence: 0.24 },
          anchor: { isAnchor: false }
        }
      }
    ],
    expected: {
      shouldSpeak: true,
      acceptableMoves: ['revisit_anchor', 'redirect', 'reframe'],
      rationale: 'A strong early anchor is being lost. Plato should bring the group back to Sam’s idea or reframe from it.'
    }
  },
  {
    id: 'solo-dialogue-followup',
    title: 'Solo learner needs conversational follow-up',
    topicTitle: 'Macbeth',
    openingQuestion: 'Is Macbeth responsible for what he becomes?',
    ageProfile: 'solo_middle',
    transcript: [
      {
        participantName: 'Chris',
        text: 'I think Macbeth is responsible because he chooses the murder, but the witches kind of give him the idea first.',
        assessment: {
          engagement: { specificity: 0.68, profoundness: 0.62, coherence: 0.66 },
          anchor: { isAnchor: true, profundness: 0.64, summary: 'Macbeth is responsible even though the witches plant the idea.' }
        }
      }
    ],
    expected: {
      shouldSpeak: true,
      acceptableMoves: ['deepen', 'challenge_assumption', 'test_logic', 'explore_implications'],
      rationale: 'In solo mode Plato should keep the dialogue alive with a thoughtful follow-up.'
    },
    participants: ['Chris']
  }
];

module.exports = {
  FACILITATION_POLICY_FIXTURES
};
