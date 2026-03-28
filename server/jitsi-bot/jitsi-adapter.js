/**
 * Jitsi Adapter
 *
 * Handles connection to Jitsi Meet via lib-jitsi-meet.
 * Creates a bot participant that can receive/send audio streams.
 */

const { JitsiMeetJS } = require("@jitsi/lib-jitsi-meet");

class JitsiAdapter {
  constructor(config) {
    this.config = {
      domain: config.domain || "meet.jit.si",
      roomName: config.roomName,
      botName: config.botName || "Facilitator",
      ...config
    };

    this.connection = null;
    this.room = null;
    this.localAudioTrack = null;
    this.participants = new Map();
    this.audioMixer = null;
  }

  /**
   * Initialize connection to Jitsi server
   */
  async connect() {
    return new Promise((resolve, reject) => {
      // Initialize JitsiMeetJS
      JitsiMeetJS.init({
        disableAudioLevels: false,
        stereo: false
      });

      // Set log level
      JitsiMeetJS.setLogLevel(JitsiMeetJS.logLevels.ERROR);

      // Create connection
      this.connection = new JitsiMeetJS.JitsiConnection(
        null, // app ID (not needed for public Jitsi)
        null, // token (not needed for public Jitsi)
        {
          hosts: {
            domain: this.config.domain,
            muc: `conference.${this.config.domain}`
          },
          bosh: `https://${this.config.domain}/http-bind`,
          clientNode: "https://jitsi.org/jitsi-meet/"
        }
      );

      this.connection.addEventListener(
        JitsiMeetJS.events.connection.CONNECTION_ESTABLISHED,
        () => {
          console.log("[JitsiAdapter] Connection established");
          resolve();
        }
      );

      this.connection.addEventListener(
        JitsiMeetJS.events.connection.CONNECTION_FAILED,
        (err) => {
          console.error("[JitsiAdapter] Connection failed:", err);
          reject(err);
        }
      );

      this.connection.addEventListener(
        JitsiMeetJS.events.connection.CONNECTION_DISCONNECTED,
        () => {
          console.log("[JitsiAdapter] Connection disconnected");
        }
      );

      this.connection.connect();
    });
  }

  /**
   * Join a room as the bot
   */
  async joinRoom() {
    return new Promise((resolve, reject) => {
      this.room = this.connection.initJitsiConference(
        this.config.roomName,
        {
          openBridgeChannel: true
        }
      );

      // Track participant joins
      this.room.addEventListener(
        JitsiMeetJS.events.conference.USER_JOINED,
        (id, participant) => {
          console.log(`[JitsiAdapter] Participant joined: ${participant.getDisplayName()}`);
          this.participants.set(id, {
            id,
            name: participant.getDisplayName() || `Participant ${id.slice(0, 4)}`,
            participant,
            audioTrack: null
          });

          // Get audio track for this participant
          const tracks = participant.getTracks();
          tracks.forEach(track => {
            if (track.getType() === "audio") {
              this.handleAudioTrack(id, track);
            }
          });
        }
      );

      // Track participant leaves
      this.room.addEventListener(
        JitsiMeetJS.events.conference.USER_LEFT,
        (id) => {
          console.log(`[JitsiAdapter] Participant left: ${id}`);
          this.participants.delete(id);
        }
      );

      // Track new tracks being added
      this.room.addEventListener(
        JitsiMeetJS.events.conference.TRACK_ADDED,
        (track) => {
          if (track.isLocal()) return;

          const participantId = track.getParticipantId();
          if (track.getType() === "audio") {
            this.handleAudioTrack(participantId, track);
          }
        }
      );

      // Track removal
      this.room.addEventListener(
        JitsiMeetJS.events.conference.TRACK_REMOVED,
        (track) => {
          if (track.isLocal()) return;
          console.log(`[JitsiAdapter] Track removed: ${track.getType()}`);
        }
      );

      // Conference joined
      this.room.addEventListener(
        JitsiMeetJS.events.conference.CONFERENCE_JOINED,
        () => {
          console.log("[JitsiAdapter] Conference joined");
          resolve();
        }
      );

      // Conference failed
      this.room.addEventListener(
        JitsiMeetJS.events.conference.CONFERENCE_FAILED,
        (err) => {
          console.error("[JitsiAdapter] Conference failed:", err);
          reject(err);
        }
      );

      // Join with bot name
      this.room.setDisplayName(this.config.botName);
      this.room.join();
    });
  }

  /**
   * Handle incoming audio track from a participant
   */
  handleAudioTrack(participantId, track) {
    const participant = this.participants.get(participantId);
    if (!participant) return;

    participant.audioTrack = track;

    // Attach audio element to get the stream
    const audioElement = track.attach();
    const audioContext = new (window.AudioContext || global.AudioContext)();
    const source = audioContext.createMediaStreamSource(audioElement.srcObject);

    // Create script processor for raw audio data
    const processor = audioContext.createScriptProcessor(4096, 1, 1);

    source.connect(processor);
    processor.connect(audioContext.destination);

    processor.onaudioprocess = (event) => {
      const inputData = event.inputBuffer.getChannelData(0);

      // Emit audio data for STT processing
      if (this.onAudioData) {
        this.onAudioData(participantId, inputData);
      }
    };

    participant.audioProcessor = {
      context: audioContext,
      source,
      processor
    };

    console.log(`[JitsiAdapter] Audio track attached for: ${participant.name}`);
  }

  /**
   * Create and add local audio track for TTS output
   */
  async createLocalAudioTrack() {
    try {
      // Create a MediaStreamTrack from audio context
      const audioContext = new (window.AudioContext || global.AudioContext)();
      const oscillator = audioContext.createOscillator();
      const destination = audioContext.createMediaStreamDestination();

      oscillator.connect(destination);
      oscillator.start();

      const track = destination.stream.getAudioTracks()[0];

      // Create Jitsi track
      this.localAudioTrack = await JitsiMeetJS.createLocalTracks({
        devices: ["audio"],
        micDeviceId: track.id
      });

      this.room.addTrack(this.localAudioTrack);
      console.log("[JitsiAdapter] Local audio track created and added");
    } catch (error) {
      console.error("[JitsiAdapter] Failed to create local audio track:", error);
    }
  }

  /**
   * Play audio buffer to the room (TTS output)
   */
  async playAudio(audioBuffer) {
    if (!this.localAudioTrack) {
      console.warn("[JitsiAdapter] No local audio track available");
      return;
    }

    // This would need to be implemented based on the specific audio pipeline
    // For now, this is a placeholder
    console.log("[JitsiAdapter] Playing audio to room");
  }

  /**
   * Leave room and disconnect
   */
  async disconnect() {
    if (this.room) {
      this.room.leave();
      this.room = null;
    }

    if (this.connection) {
      this.connection.disconnect();
      this.connection = null;
    }

    this.participants.clear();
    console.log("[JitsiAdapter] Disconnected");
  }

  /**
   * Get participant info
   */
  getParticipant(participantId) {
    return this.participants.get(participantId);
  }

  /**
   * Get all participants
   */
  getParticipants() {
    return Array.from(this.participants.values());
  }
}

module.exports = { JitsiAdapter };
