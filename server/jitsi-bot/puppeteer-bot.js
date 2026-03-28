/**
 * Puppeteer Jitsi Bot
 *
 * A headless browser that joins a Jitsi meeting as a bot participant.
 * Captures audio from participants and can play TTS audio.
 */

const puppeteer = require("puppeteer");
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");

class PuppeteerJitsiBot extends EventEmitter {
  constructor(config) {
    super();

    this.config = {
      jitsiUrl: config.jitsiUrl || "http://localhost:8443",
      roomName: config.roomName || "test-room",
      botName: config.botName || "Facilitator",
      headless: config.headless !== false, // Default to headless
      ...config
    };

    this.browser = null;
    this.page = null;
    this.isJoined = false;
    this.participants = new Map();
    this.audioContext = null;
  }

  /**
   * Launch browser and join the Jitsi meeting
   */
  async start() {
    console.log(`[PuppeteerBot] Starting...`);
    console.log(`[PuppeteerBot] Room: ${this.config.roomName}`);
    console.log(`[PuppeteerBot] Jitsi URL: ${this.config.jitsiUrl}`);

    // Launch browser
    this.browser = await puppeteer.launch({
      headless: this.config.headless ? "new" : false,
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--disable-web-security",
        "--disable-features=IsolateOrigins,site-per-process",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--enable-experimental-web-platform-features"
      ],
      ignoreDefaultArgs: ["--mute-audio"]
    });

    this.page = await this.browser.newPage();

    // Set viewport
    await this.page.setViewport({ width: 1280, height: 720 });

    // Expose functions to the browser context
    await this.setupExposedFunctions();

    // Navigate to Jitsi
    const roomUrl = `${this.config.jitsiUrl}/${this.config.roomName}`;
    console.log(`[PuppeteerBot] Navigating to: ${roomUrl}`);

    await this.page.goto(roomUrl, { waitUntil: "networkidle2", timeout: 30000 });

    // Wait for and handle the prejoin screen
    await this.handlePrejoin();

    // Setup audio capture
    await this.setupAudioCapture();

    // Setup participant tracking
    await this.setupParticipantTracking();

    this.isJoined = true;
    console.log(`[PuppeteerBot] Successfully joined room`);
    this.emit("joined");

    return true;
  }

  /**
   * Setup functions that can be called from browser context
   */
  async setupExposedFunctions() {
    // Handle incoming audio data from the page
    await this.page.exposeFunction("onAudioData", (participantId, audioData) => {
      this.emit("audio", { participantId, audioData: new Float32Array(audioData) });
    });

    // Handle participant speaking events
    await this.page.exposeFunction("onParticipantSpeaking", (participantId, participantName) => {
      console.log(`[PuppeteerBot] ${participantName} is speaking`);
      this.emit("speaking_start", { participantId, participantName });
    });

    // Handle participant stopped speaking
    await this.page.exposeFunction("onParticipantStoppedSpeaking", (participantId) => {
      this.emit("speaking_stop", { participantId });
    });

    // Handle transcript from Web Speech API (fallback)
    await this.page.exposeFunction("onTranscript", (participantId, transcript, isFinal) => {
      this.emit("transcript", { participantId, transcript, isFinal });
    });
  }

  /**
   * Handle the prejoin screen
   */
  async handlePrejoin() {
    try {
      // Wait for prejoin screen
      await this.page.waitForSelector("#premeeting-name-input", { timeout: 10000 });

      // Enter bot name
      await this.page.type("#premeeting-name-input", this.config.botName);
      console.log(`[PuppeteerBot] Entered name: ${this.config.botName}`);

      // Wait a moment for UI to update
      await this.page.waitForTimeout(500);

      // Click join button (try multiple selectors)
      const joinSelectors = [
        ".prejoin-join-button",
        "button[data-testid='prejoin.joinButton']",
        "button:has-text('Join')"
      ];

      for (const selector of joinSelectors) {
        try {
          const button = await this.page.$(selector);
          if (button) {
            await button.click();
            console.log(`[PuppeteerBot] Clicked join button`);
            break;
          }
        } catch (e) {
          // Try next selector
        }
      }

      // Wait for conference to start
      await this.page.waitForTimeout(3000);

    } catch (error) {
      console.log(`[PuppeteerBot] No prejoin screen or already joined`);
      // Might have auto-joined, that's okay
    }
  }

  /**
   * Setup audio capture from participants
   */
  async setupAudioCapture() {
    await this.page.evaluate(() => {
      console.log("[Bot] Setting up audio capture...");

      // Create audio context for processing
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();

      // Store audio processors for each participant
      window.audioProcessors = new Map();

      // Function to capture audio from a media stream
      window.captureAudioStream = (stream, participantId) => {
        const source = audioContext.createMediaStreamSource(stream);
        const processor = audioContext.createScriptProcessor(4096, 1, 1);

        source.connect(processor);
        processor.connect(audioContext.destination);

        processor.onaudioprocess = (event) => {
          const inputData = event.inputBuffer.getChannelData(0);

          // Convert to regular array for transfer
          const audioArray = Array.from(inputData);

          // Send to Node.js
          if (window.onAudioData) {
            window.onAudioData(participantId, audioArray);
          }
        };

        window.audioProcessors.set(participantId, { source, processor });
        console.log(`[Bot] Audio capture started for ${participantId}`);
      };

      // Monitor for audio tracks
      window.monitorAudioTracks = () => {
        // Get all audio elements on the page
        const audioElements = document.querySelectorAll("audio");

        audioElements.forEach((audio) => {
          const stream = audio.srcObject;
          if (stream && !audio.dataset.captured) {
            const tracks = stream.getAudioTracks();
            if (tracks.length > 0) {
              // Try to get participant ID from the audio element
              const participantId = audio.id || `participant-${Date.now()}`;
              window.captureAudioStream(stream, participantId);
              audio.dataset.captured = "true";
            }
          }
        });
      };

      // Start monitoring
      setInterval(window.monitorAudioTracks, 1000);

      // Also monitor DOM for new audio elements
      const observer = new MutationObserver(() => {
        window.monitorAudioTracks();
      });

      observer.observe(document.body, { childList: true, subtree: true });

      console.log("[Bot] Audio monitoring started");
    });

    console.log(`[PuppeteerBot] Audio capture setup complete`);
  }

  /**
   * Setup participant tracking
   */
  async setupParticipantTracking() {
    await this.page.evaluate(() => {
      window.participants = new Map();

      // Try to access Jitsi Meet internal API
      const checkForAPI = setInterval(() => {
        if (window.JitsiMeetJS || window.APP) {
          clearInterval(checkForAPI);
          console.log("[Bot] Jitsi API detected");

          // If we have access to the internal API
          if (window.APP && window.APP.conference) {
            const conference = window.APP.conference;

            // Listen for participant joins
            conference.addListener(window.JitsiMeetJS.events.conference.USER_JOINED, (id, user) => {
              const name = user.getDisplayName() || `Participant ${id.slice(0, 4)}`;
              window.participants.set(id, { id, name });
              console.log(`[Bot] Participant joined: ${name}`);
            });

            // Listen for participant leaves
            conference.addListener(window.JitsiMeetJS.events.conference.USER_LEFT, (id) => {
              window.participants.delete(id);
              console.log(`[Bot] Participant left: ${id}`);
            });

            // Get existing participants
            const existingParticipants = conference.getParticipants();
            existingParticipants.forEach((user) => {
              const id = user.getId();
              const name = user.getDisplayName() || `Participant ${id.slice(0, 4)}`;
              window.participants.set(id, { id, name });
            });
          }
        }
      }, 500);
    });
  }

  /**
   * Play audio in the meeting (for TTS output)
   */
  async playAudio(audioBuffer) {
    if (!this.page || !this.isJoined) {
      console.warn("[PuppeteerBot] Not joined, cannot play audio");
      return;
    }

    // Convert buffer to base64
    const base64Audio = audioBuffer.toString("base64");

    await this.page.evaluate((base64Audio) => {
      // Create audio element
      const audio = new Audio(`data:audio/wav;base64,${base64Audio}`);

      // Play
      audio.play().catch(e => console.error("[Bot] Audio play error:", e));
    }, base64Audio);

    console.log(`[PuppeteerBot] Played audio (${audioBuffer.length} bytes)`);
  }

  /**
   * Get list of participants
   */
  async getParticipants() {
    if (!this.page) return [];

    const participants = await this.page.evaluate(() => {
      return Array.from(window.participants.values());
    });

    return participants;
  }

  /**
   * Send a message to the chat
   */
  async sendChatMessage(message) {
    if (!this.page || !this.isJoined) return;

    try {
      // Open chat panel
      const chatButton = await this.page.$('[data-testid="toolbox-button-chat"]');
      if (chatButton) {
        await chatButton.click();
        await this.page.waitForTimeout(500);
      }

      // Type message
      const chatInput = await this.page.$("#chat-input, [data-testid='chat-input']");
      if (chatInput) {
        await chatInput.type(message);
        await this.page.keyboard.press("Enter");
        console.log(`[PuppeteerBot] Sent chat message: ${message}`);
      }
    } catch (error) {
      console.error("[PuppeteerBot] Failed to send chat message:", error);
    }
  }

  /**
   * Mute/unmute the bot
   */
  async setMuted(muted) {
    if (!this.page || !this.isJoined) return;

    try {
      const audioButton = await this.page.$('[data-testid="toolbox-button-microphone"]');
      if (audioButton) {
        // Check current state and toggle if needed
        const isMuted = await this.page.evaluate(() => {
          return window.APP?.conference?.isLocalAudioMuted?.() ?? false;
        });

        if (isMuted !== muted) {
          await audioButton.click();
          console.log(`[PuppeteerBot] ${muted ? "Muted" : "Unmuted"}`);
        }
      }
    } catch (error) {
      console.error("[PuppeteerBot] Failed to toggle mute:", error);
    }
  }

  /**
   * Take a screenshot (for debugging)
   */
  async screenshot(filename = "screenshot.png") {
    if (!this.page) return;

    await this.page.screenshot({ path: filename, fullPage: false });
    console.log(`[PuppeteerBot] Screenshot saved: ${filename}`);
  }

  /**
   * Stop the bot and close browser
   */
  async stop() {
    console.log(`[PuppeteerBot] Stopping...`);

    if (this.page) {
      await this.page.close().catch(() => {});
      this.page = null;
    }

    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }

    this.isJoined = false;
    this.emit("stopped");
    console.log(`[PuppeteerBot] Stopped`);
  }
}

module.exports = { PuppeteerJitsiBot };
