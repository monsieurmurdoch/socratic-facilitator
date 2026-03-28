/**
 * Human Deference System
 *
 * Implements the principle that humans always take precedence.
 *
 * Features:
 * - Detect when humans are speaking (and defer)
 * - Accept "go ahead" signals from humans
 * - Track deferred messages for later delivery
 * - Respect natural conversation turn-taking
 *
 * Designed to be used standalone — no dependency on the main app.
 */

/**
 * Patterns that indicate a human is inviting the AI to speak.
 */
const GO_AHEAD_PATTERNS = [
  /(?:what do you think|your thoughts|any thoughts)\s*[?!.]?$/i,
  /(?:go ahead|please continue|please proceed)/i,
  /(?:facilitator|ai|bot)\s*[,-]?\s*(?:what|how|why)/i,
  /(?:let's hear from|what does) (?:the )?facilitator/i,
  /(?:i('m| am) curious (?:what|about|to hear))/i,
  /(?:anyone else|any other thoughts)/i,  // inclusive invitation
  /(?:what about you|your take|your perspective)/i,
  /(?:jump in|chime in|weigh in)/i,
];

/**
 * Patterns that indicate a human is still talking or about to continue.
 */
const CONTINUATION_PATTERNS = [
  /(?:let me finish|one more thing|also|and another)/i,
  /(?:actually|in fact|wait)\s*[,]/i,
  /(?:i mean|i wanted to say|i was going to add)/i,
  /\b(?:so|um|uh|well|like)\s*$/i,  // trailing filler words
];

/**
 * Patterns that indicate a human wants to speak over the AI.
 */
const INTERRUPTION_PATTERNS = [
  /(?:wait|stop|hold on|hang on)/i,
  /(?:i have something to say|let me speak)/i,
  /(?:can i|may i)(?: just)? (?:say|add|jump in)/i,
];

class HumanDeference {
  constructor() {
    // State tracking
    this.humanSpeakingNow = false;
    this.lastHumanSpeechAt = null;
    this.humanJustFinishedSpeaking = false;
    this.humanInvitedAI = false;

    // Deferred message
    this.deferredMessage = null;
    this.deferredReason = null;
    this.deferredAt = null;

    // Configuration
    this.postSpeechBufferMs = 2500;  // Wait this long after human stops
    this.deferredMessageTTLms = 45000;  // Deferred messages expire after this

    // History for analysis
    this.events = [];
  }

  /**
   * Call when a human starts speaking.
   */
  humanStartedSpeaking(participantName = null) {
    this.humanSpeakingNow = true;
    this.lastHumanSpeechAt = Date.now();
    this.humanInvitedAI = false;
    this.humanJustFinishedSpeaking = false;

    this._log('human_started', { participantName });
  }

  /**
   * Call when a human stops speaking.
   * Optionally pass the message text to detect "go ahead" patterns.
   */
  humanStoppedSpeaking(messageText = null, participantName = null) {
    this.humanSpeakingNow = false;
    this.humanJustFinishedSpeaking = true;
    this.lastHumanSpeechAt = Date.now();

    // Check for "go ahead" invitation
    if (messageText) {
      const invitation = this._detectGoAhead(messageText);
      if (invitation.detected) {
        this.humanInvitedAI = true;
        this._log('go_ahead_detected', { participantName, pattern: invitation.pattern });
      }

      // Check for interruption signal
      const interruption = this._detectInterruption(messageText);
      if (interruption.detected) {
        this.deferredMessage = null;
        this.deferredReason = null;
        this._log('interruption_detected', { participantName });
      }
    }

    this._log('human_stopped', { participantName });
  }

  /**
   * Check if the AI should defer to humans right now.
   */
  shouldDefer() {
    // Human is currently speaking
    if (this.humanSpeakingNow) {
      return { defer: true, reason: 'human_speaking_now' };
    }

    // Human just finished speaking - give them a buffer
    if (this.humanJustFinishedSpeaking) {
      const timeSinceSpeech = Date.now() - this.lastHumanSpeechAt;
      if (timeSinceSpeech < this.postSpeechBufferMs && !this.humanInvitedAI) {
        return { defer: true, reason: 'human_just_finished' };
      }
      this.humanJustFinishedSpeaking = false;
    }

    // No deference needed
    return { defer: false, reason: null };
  }

  /**
   * Check if a human has explicitly invited the AI to speak.
   */
  hasInvitation() {
    return this.humanInvitedAI;
  }

  /**
   * Clear the invitation flag (after using it).
   */
  clearInvitation() {
    this.humanInvitedAI = false;
  }

  /**
   * Defer a message for later delivery.
   */
  deferMessage(message, reason) {
    this.deferredMessage = message;
    this.deferredReason = reason;
    this.deferredAt = Date.now();

    this._log('message_deferred', { reason });
  }

  /**
   * Check if there's a valid deferred message.
   */
  hasDeferredMessage() {
    if (!this.deferredMessage) return false;

    // Check if deferred message has expired
    const age = Date.now() - this.deferredAt;
    if (age > this.deferredMessageTTLms) {
      this._clearDeferred();
      return false;
    }

    return true;
  }

  /**
   * Get the deferred message (if still valid).
   */
  getDeferredMessage() {
    if (!this.hasDeferredMessage()) return null;

    const msg = {
      message: this.deferredMessage,
      reason: this.deferredReason,
      deferredAt: this.deferredAt,
      ageMs: Date.now() - this.deferredAt
    };

    // Clear after retrieval
    this._clearDeferred();

    return msg;
  }

  /**
   * Get the full state for debugging.
   */
  getState() {
    return {
      humanSpeakingNow: this.humanSpeakingNow,
      lastHumanSpeechAt: this.lastHumanSpeechAt,
      msSinceLastHumanSpeech: this.lastHumanSpeechAt
        ? Date.now() - this.lastHumanSpeechAt
        : null,
      humanJustFinishedSpeaking: this.humanJustFinishedSpeaking,
      humanInvitedAI: this.humanInvitedAI,
      hasDeferredMessage: this.hasDeferredMessage(),
      deferredReason: this.deferredReason,
      recentEvents: this.events.slice(-10)
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PRIVATE METHODS
  // ─────────────────────────────────────────────────────────────────────────────

  _detectGoAhead(text) {
    for (const pattern of GO_AHEAD_PATTERNS) {
      if (pattern.test(text)) {
        return { detected: true, pattern: pattern.source };
      }
    }
    return { detected: false, pattern: null };
  }

  _detectInterruption(text) {
    for (const pattern of INTERRUPTION_PATTERNS) {
      if (pattern.test(text)) {
        return { detected: true, pattern: pattern.source };
      }
    }
    return { detected: false, pattern: null };
  }

  _detectContinuation(text) {
    for (const pattern of CONTINUATION_PATTERNS) {
      if (pattern.test(text)) {
        return { detected: true, pattern: pattern.source };
      }
    }
    return { detected: false, pattern: null };
  }

  _clearDeferred() {
    this.deferredMessage = null;
    this.deferredReason = null;
    this.deferredAt = null;
  }

  _log(event, data = {}) {
    this.events.push({
      event,
      ...data,
      timestamp: Date.now()
    });

    // Keep bounded
    if (this.events.length > 100) {
      this.events = this.events.slice(-100);
    }
  }
}

module.exports = { HumanDeference, GO_AHEAD_PATTERNS, INTERRUPTION_PATTERNS };
