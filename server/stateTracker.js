/**
 * Participant State Tracker
 *
 * Maintains live state of participants in conversation.
 * Persists all data to database while keeping in-memory cache for performance.
 */

const messagesRepo = require('./db/repositories/messages');
const participantsRepo = require('./db/repositories/participants');
const conversationStateRepo = require('./db/repositories/conversationState');
const { FACILITATION_PARAMS, getFacilitationParams } = require('./config');

class ParticipantState {
  constructor(id, name, age) {
    this.id = id;
    this.dbId = null; // DB-generated UUID, set after insert
    this.name = name;
    this.age = age;
    this.messageCount = 0;
    this.lastSpokeAt = null;
    this.lastSpokeMessageIndex = -1;
    this.positions = [];
    this.engagementStyle = null;
    this.addressedByAI = 0;
  }
}

class SessionStateTracker {
  constructor(sessionId, session) {
    this.sessionId = sessionId;
    this.session = session;
    this.participants = new Map();
    this.messages = [];
    this.aiMessages = [];
    this.tensions = [];
    this.connections = [];
    this.totalMessageCount = 0;
    this.aiMessageCount = 0;
    this.lastAIMessageIndex = -1;
    this.lastAIMessageAt = null;
    this.sessionStartedAt = Date.now();
    this.lastActivityAt = Date.now();
  }

  /**
   * Load existing state from database (for reconnections)
   */
  async loadFromDatabase() {
    try {
      const dbParticipants = await participantsRepo.getBySession(this.sessionId);
      for (const p of dbParticipants) {
        const state = new ParticipantState(p.id, p.name, p.age);
        this.participants.set(p.id, state);
      }

      const stats = await participantsRepo.getStats(this.sessionId);
      for (const s of stats) {
        const p = this.participants.get(s.id);
        if (p) {
          p.messageCount = parseInt(s.message_count) || 0;
          p.lastSpokeAt = s.last_message_at ? new Date(s.last_message_at) : null;
        }
      }

      const msgStats = await messagesRepo.getFacilitatorStats(this.sessionId);
      this.totalMessageCount = parseInt(msgStats?.total) || 0;
      this.aiMessageCount = parseInt(msgStats?.facilitator_count) || 0;
      this.lastAIMessageAt = msgStats?.last_facilitator_at ? new Date(msgStats.last_facilitator_at) : null;

      if (this.session.started_at) {
        this.sessionStartedAt = new Date(this.session.started_at).getTime();
      }

      console.log(`Loaded session ${this.sessionId} from database: ${this.participants.size} participants, ${this.totalMessageCount} messages`);
    } catch (error) {
      console.error('Error loading session from database:', error);
    }
  }

  async addParticipant(id, name, age) {
    const participant = new ParticipantState(id, name, age);
    this.participants.set(id, participant);

    // Persist to database and store the DB-generated ID
    try {
      const dbParticipant = await participantsRepo.add(this.sessionId, { name, age, role: 'participant' });
      participant.dbId = dbParticipant.id;
    } catch (error) {
      console.error('Error adding participant to database:', error);
    }

    return participant;
  }

  removeParticipant(id) {
    this.participants.delete(id);
  }

  async recordMessage(participantId, text, timestamp = Date.now()) {
    const participant = this.participants.get(participantId);
    if (!participant) return null;

    const message = {
      index: this.totalMessageCount,
      participantId,
      participantName: participant.name,
      text,
      timestamp
    };

    this.messages.push(message);
    this.totalMessageCount++;
    this.lastActivityAt = timestamp;

    // Update in-memory state
    participant.messageCount++;
    participant.lastSpokeAt = timestamp;
    participant.lastSpokeMessageIndex = message.index;

    // Persist to database using DB-generated participant ID
    try {
      const dbParticipantId = participant.dbId || participantId;
      await messagesRepo.addParticipantMessage(this.sessionId, dbParticipantId, text);
    } catch (error) {
      console.error('Error saving message to database:', error);
    }

    return message;
  }

  async recordAIMessage(text, move, targetParticipantId = null, timestamp = Date.now()) {
    const message = {
      index: this.totalMessageCount,
      participantId: "__facilitator__",
      participantName: "Facilitator",
      text,
      move,
      targetParticipantId,
      timestamp
    };

    this.messages.push(message);
    this.aiMessages.push(message);
    this.aiMessageCount++;
    this.totalMessageCount++;
    this.lastAIMessageIndex = message.index;
    this.lastAIMessageAt = timestamp;
    this.lastActivityAt = timestamp;

    if (targetParticipantId) {
      const target = this.participants.get(targetParticipantId);
      if (target) target.addressedByAI++;
    }

    // Persist to database
    try {
      await messagesRepo.addFacilitatorMessage(this.sessionId, text, move, targetParticipantId);
    } catch (error) {
      console.error('Error saving AI message to database:', error);
    }

    return message;
  }

  /**
   * Compute current state snapshot for facilitation engine
   */
  async getStateSnapshot() {
    const now = Date.now();
    const participantList = Array.from(this.participants.values());
    const totalParticipantMessages = participantList.reduce((sum, p) => sum + p.messageCount, 0);

    const participantStates = participantList.map(p => {
      const talkRatio = totalParticipantMessages > 0
        ? p.messageCount / totalParticipantMessages
        : 0;

      const silenceDurationSec = p.lastSpokeAt
        ? (now - new Date(p.lastSpokeAt).getTime()) / 1000
        : (now - this.sessionStartedAt) / 1000;

      const messagesSinceLastSpoke = p.lastSpokeMessageIndex >= 0
        ? this.totalMessageCount - p.lastSpokeMessageIndex - 1
        : this.totalMessageCount;

      return {
        id: p.id,
        name: p.name,
        age: p.age,
        messageCount: p.messageCount,
        talkRatio: Math.round(talkRatio * 100) / 100,
        silenceDurationSec: Math.round(silenceDurationSec),
        messagesSinceLastSpoke,
        positions: p.positions,
        timesAddressedByAI: p.addressedByAI
      };
    });

    const aiTalkRatio = this.totalMessageCount > 0
      ? this.aiMessageCount / this.totalMessageCount
      : 0;

    const messagesSinceLastAI = this.lastAIMessageIndex >= 0
      ? this.totalMessageCount - this.lastAIMessageIndex - 1
      : this.totalMessageCount;

    const silenceSinceLastActivity = (now - this.lastActivityAt) / 1000;
    const sessionDurationMin = (now - this.sessionStartedAt) / 60000;

    return {
      sessionDurationMin: Math.round(sessionDurationMin * 10) / 10,
      totalMessages: this.totalMessageCount,
      participantCount: participantList.length,
      participants: participantStates,
      aiStats: {
        messageCount: this.aiMessageCount,
        talkRatio: Math.round(aiTalkRatio * 100) / 100,
        messagesSinceLastIntervention: messagesSinceLastAI,
        secondsSinceLastIntervention: this.lastAIMessageAt
          ? Math.round((now - new Date(this.lastAIMessageAt).getTime()) / 1000)
          : null
      },
      silenceSinceLastActivitySec: Math.round(silenceSinceLastActivity),
      tensions: this.tensions,
      connections: this.connections
    };
  }

  /**
   * Returns recent conversation history formatted for LLM
   */
  async getRecentHistory(maxMessages = 50) {
    // Try to get from database first (more complete)
    try {
      const dbMessages = await messagesRepo.getRecent(this.sessionId, maxMessages);
      if (dbMessages.length > 0) {
        return messagesRepo.formatForLLM(dbMessages);
      }
    } catch (error) {
      // Fall back to in-memory
    }

    // Fall back to in-memory messages
    const recent = this.messages.slice(-maxMessages);
    return recent.map(m => {
      const role = m.participantId === "__facilitator__" ? "Facilitator" : m.participantName;
      return `[${role}]: ${m.text}`;
    }).join('\n');
  }

  /**
   * Hard constraints check - rules that don't require LLM judgment
   */
  async getHardConstraints(params = null) {
    // Auto-detect solo mode and use appropriate params
    if (!params) {
      params = getFacilitationParams(this.participants.size);
    }
    const snapshot = await this.getStateSnapshot();
    const constraints = {
      canSpeak: true,
      reasons: []
    };

    if (snapshot.aiStats.talkRatio >= params.maxAITalkRatio) {
      constraints.canSpeak = false;
      constraints.reasons.push("AI talk ratio exceeded maximum");
    }

    if (snapshot.aiStats.messagesSinceLastIntervention < params.minMessagesBetweenInterventions) {
      constraints.canSpeak = false;
      constraints.reasons.push("Not enough participant messages since last intervention");
    }

    if (snapshot.aiStats.secondsSinceLastIntervention !== null &&
        snapshot.aiStats.secondsSinceLastIntervention < params.minInterventionGapSec) {
      constraints.canSpeak = false;
      constraints.reasons.push("Too soon since last intervention");
    }

    // Override for extended silence
    if (snapshot.silenceSinceLastActivitySec >= params.silenceTimeoutSec) {
      constraints.canSpeak = true;
      constraints.reasons = ["Extended silence — override to re-engage"];
    }

    return constraints;
  }

  /**
   * Get topic info for facilitation
   */
  get topic() {
    return {
      title: this.session?.title || "Open Discussion",
      openingQuestion: this.session?.opening_question || "",
      passage: this.session?.passage || this.session?.conversation_goal || "",
      followUpAngles: this.session?.followUpAngles || []
    };
  }
}

module.exports = { SessionStateTracker, ParticipantState };
