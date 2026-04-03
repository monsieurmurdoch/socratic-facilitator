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
    this.messages = [];       // raw utterances (every STT final)
    this.turns = [];          // complete speaker turns (consecutive same-speaker utterances merged)
    this.aiMessages = [];
    this.tensions = [];
    this.connections = [];
    this.totalMessageCount = 0;
    this.turnCount = 0;
    this.aiMessageCount = 0;
    this.lastAIMessageIndex = -1;
    this.lastAIMessageAt = null;
    this.sessionStartedAt = Date.now();
    this.lastActivityAt = Date.now();
    this._currentTurn = null;   // accumulator for current speaker's turn
    this._turnFlushTimer = null; // timer to flush turn on extended silence
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

  async addParticipant(id, name, age, opts = {}) {
    const participant = new ParticipantState(id, name, age);
    // Attach auth metadata if user is logged in
    if (opts.userId) participant.userId = opts.userId;
    if (opts.accountRole) participant.accountRole = opts.accountRole;
    if (opts.sessionRole) participant.sessionRole = opts.sessionRole;
    this.participants.set(id, participant);

    // Persist to database and store the DB-generated ID
    try {
      const dbParticipant = await participantsRepo.add(this.sessionId, {
        name, age,
        role: opts.sessionRole || 'participant',
        userId: opts.userId || null
      });
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

    // ---- Turn tracking ----
    // If same speaker as current turn, append. Otherwise flush and start new turn.
    if (this._currentTurn && this._currentTurn.participantId === participantId) {
      // Same speaker — extend the current turn
      this._currentTurn.utterances.push(text);
      this._currentTurn.text = this._currentTurn.utterances.join(' ');
      this._currentTurn.endTimestamp = timestamp;
      this._currentTurn.lastMessageIndex = message.index;
    } else {
      // Different speaker — flush previous turn, start new one
      this._flushCurrentTurn();
      this._currentTurn = {
        turnIndex: this.turnCount,
        participantId,
        participantName: participant.name,
        utterances: [text],
        text: text,
        startTimestamp: timestamp,
        endTimestamp: timestamp,
        firstMessageIndex: message.index,
        lastMessageIndex: message.index
      };
    }

    // Reset the flush timer — flush turn after 3.2s of silence from this speaker
    clearTimeout(this._turnFlushTimer);
    this._turnFlushTimer = setTimeout(() => this._flushCurrentTurn(), 3200);

    // Persist to database using DB-generated participant ID
    try {
      const dbParticipantId = participant.dbId || participantId;
      await messagesRepo.addParticipantMessage(this.sessionId, dbParticipantId, text);
    } catch (error) {
      console.error('Error saving message to database:', error);
    }

    return message;
  }

  /**
   * Flush the current turn accumulator into the turns array.
   */
  _flushCurrentTurn() {
    if (!this._currentTurn) return;
    this.turns.push(this._currentTurn);
    this.turnCount++;
    this._currentTurn = null;
    clearTimeout(this._turnFlushTimer);
  }

  /**
   * Get the current turn (possibly still accumulating) included with completed turns.
   * Used by analysis to always have the latest state.
   */
  getTurnsIncludingCurrent() {
    if (this._currentTurn) {
      return [...this.turns, this._currentTurn];
    }
    return this.turns;
  }

  async recordAIMessage(text, move, targetParticipantId = null, timestamp = Date.now()) {
    // AI message always flushes any pending human turn
    this._flushCurrentTurn();

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

    // AI messages are always a complete turn
    this.turns.push({
      turnIndex: this.turnCount,
      participantId: "__facilitator__",
      participantName: "Facilitator",
      utterances: [text],
      text,
      startTimestamp: timestamp,
      endTimestamp: timestamp,
      firstMessageIndex: message.index,
      lastMessageIndex: message.index,
      move
    });
    this.turnCount++;

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
      totalTurns: this.turnCount + (this._currentTurn ? 1 : 0),
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
   * Returns recent turns (complete speaker thoughts) formatted for LLM.
   * Preferred over getRecentHistory for analysis — gives coherent ideas
   * instead of sentence fragments.
   */
  getRecentTurns(maxTurns = 20) {
    const allTurns = this.getTurnsIncludingCurrent();
    const recent = allTurns.slice(-maxTurns);
    return recent.map(t => {
      const role = t.participantId === "__facilitator__" ? "Facilitator" : t.participantName;
      return `[${role}]: ${t.text}`;
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
