/**
 * STT Service
 *
 * Real-time speech-to-text with speaker diarization.
 * Supports Deepgram (recommended), AssemblyAI, and local Whisper.
 */

const WebSocket = require("ws");
const fetch = require("node-fetch");
const { ConfidenceChecker } = require("../confidence-checker");

class STTService {
  constructor(config) {
    this.config = {
      provider: config.provider || "deepgram",
      deepgramKey: config.deepgramKey,
      assemblyKey: config.assemblyKey,
      whisperModel: config.whisperModel || "base",
      language: config.language || "en-US",
      ...config
    };

    this.connections = new Map();
    this.onTranscript = null;
    this.onVadEvent = null; // Callback for VAD events: { participantId, type: 'speech_started'|'speech_stopped', timestamp }
    this.confidenceChecker = new ConfidenceChecker();
  }

  /**
   * Start streaming transcription for a participant
   */
  async startStreaming(participantId, participantName) {
    switch (this.config.provider) {
      case "deepgram":
        return this.startDeepgramStream(participantId, participantName);
      case "assembly":
        return this.startAssemblyStream(participantId, participantName);
      default:
        console.warn("[STT] No streaming provider configured");
        return null;
    }
  }

  /**
   * Deepgram streaming transcription (recommended)
   */
  async startDeepgramStream(participantId, participantName) {
    // endpointing: ms of silence before finalizing (300ms for faster response)
    // vad_events: enables SpeechStarted/SpeechStopped for better timing
    const ws = new WebSocket(
      `wss://api.deepgram.com/v1/listen?` +
      new URLSearchParams({
        encoding: "linear16",
        sample_rate: "16000",
        channels: 1,
        interim_results: "true",
        punctuate: "true",
        diarize: "true",
        language: this.config.language,
        endpointing: "500",
        vad_events: "true"
      }),
      {
        headers: {
          Authorization: `Token ${this.config.deepgramKey}`
        }
      }
    );

    return new Promise((resolve, reject) => {
      ws.on("open", () => {
        console.log(`[STT:Deepgram] Connected for ${participantName}`);
        this.connections.set(participantId, {
          ws,
          participantName,
          provider: "deepgram"
        });
        resolve();
      });

      ws.on("message", (data) => {
        try {
          const result = JSON.parse(data.toString());

          // Handle VAD events (SpeechStarted / SpeechStopped)
          if (result.type === "SpeechStarted" || result.type === "SpeechStopped") {
            const vadType = result.type === "SpeechStarted" ? "speech_started" : "speech_stopped";
            if (this.onVadEvent) {
              this.onVadEvent({
                participantId,
                participantName,
                type: vadType,
                timestamp: result.timestamp || Date.now() / 1000
              });
            }
            return;
          }

          if (result.type === "Results" && result.channel) {
            const alternatives = result.channel.alternatives;
            if (alternatives && alternatives.length > 0) {
              const transcript = alternatives[0].transcript;
              const isFinal = result.is_final;
              const speaker = alternatives[0].words?.[0]?.speaker || 0;

              if (transcript && transcript.trim()) {
                // Check confidence for interim transcripts
                let shouldProcessAsFinal = isFinal;
                if (!isFinal && this.confidenceChecker) {
                  // Assess if this interim transcript is ready for processing
                  this.confidenceChecker.assessConfidence(transcript).then(result => {
                    if (result.isReady) {
                      console.log(`[STT] Predictive processing: "${transcript}" (${result.confidence.toFixed(2)})`);
                      this.handleTranscript(
                        participantId,
                        participantName,
                        transcript,
                        true, // Treat as final for processing
                        { speaker, confidence: result.confidence, reasoning: result.reasoning }
                      );
                    }
                  }).catch(err => {
                    console.warn('[STT] Confidence check failed:', err.message);
                  });
                }

                // Always handle as normal (interim or final)
                this.handleTranscript(
                  participantId,
                  participantName,
                  transcript,
                  isFinal,
                  { speaker }
                );
              }
            }
          }
        } catch (err) {
          console.error("[STT:Deepgram] Parse error:", err);
        }
      });

      ws.on("error", (err) => {
        console.error(`[STT:Deepgram] Error for ${participantName}:`, err);
        reject(err);
      });

      ws.on("close", () => {
        console.log(`[STT:Deepgram] Connection closed for ${participantName}`);
        this.connections.delete(participantId);
      });
    });
  }

  /**
   * AssemblyAI streaming transcription
   */
  async startAssemblyStream(participantId, participantName) {
    // AssemblyAI requires a temporary token
    const tokenRes = await fetch("https://api.assemblyai.com/v2/realtime/token", {
      method: "POST",
      headers: {
        Authorization: this.config.assemblyKey
      },
      body: JSON.stringify({ expires_in: 3600 })
    });

    const { token } = await tokenRes.json();

    const ws = new WebSocket(
      `wss://api.assemblyai.com/v2/realtime/ws?sample_rate=16000&token=${token}`
    );

    return new Promise((resolve, reject) => {
      ws.on("open", () => {
        console.log(`[STT:Assembly] Connected for ${participantName}`);
        this.connections.set(participantId, {
          ws,
          participantName,
          provider: "assembly"
        });
        resolve();
      });

      ws.on("message", (data) => {
        try {
          const result = JSON.parse(data.toString());

          if (result.message_type === "FinalTranscript" || result.message_type === "PartialTranscript") {
            const transcript = result.text;
            const isFinal = result.message_type === "FinalTranscript";

            if (transcript && transcript.trim()) {
              this.handleTranscript(
                participantId,
                participantName,
                transcript,
                isFinal,
                {}
              );
            }
          }
        } catch (err) {
          console.error("[STT:Assembly] Parse error:", err);
        }
      });

      ws.on("error", (err) => {
        console.error(`[STT:Assembly] Error for ${participantName}:`, err);
        reject(err);
      });

      ws.on("close", () => {
        console.log(`[STT:Assembly] Connection closed for ${participantName}`);
        this.connections.delete(participantId);
      });
    });
  }

  /**
   * Process audio data and send to STT
   */
  processAudio(participantId, audioData) {
    const connection = this.connections.get(participantId);
    if (!connection || !connection.ws) return;

    const { ws, provider } = connection;

    if (ws.readyState === WebSocket.OPEN) {
      // Convert Float32Array to Int16Array for Deepgram/Assembly
      const int16Data = this.floatTo16BitPCM(audioData);

      if (provider === "deepgram" || provider === "assembly") {
        ws.send(int16Data);
      }
    }
  }

  /**
   * Convert Float32 audio to Int16 PCM
   */
  floatTo16BitPCM(float32Array) {
    const buffer = new ArrayBuffer(float32Array.length * 2);
    const view = new DataView(buffer);

    for (let i = 0; i < float32Array.length; i++) {
      let s = Math.max(-1, Math.min(1, float32Array[i]));
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }

    return buffer;
  }

  /**
   * Handle transcript callback
   */
  handleTranscript(participantId, participantName, transcript, isFinal, metadata) {
    if (this.onTranscript) {
      this.onTranscript({
        participantId,
        participantName,
        transcript,
        isFinal,
        timestamp: Date.now(),
        ...metadata
      });
    }
  }

  /**
   * Stop streaming for a participant
   */
  stopStreaming(participantId) {
    const connection = this.connections.get(participantId);
    if (connection && connection.ws) {
      // Send close message for Deepgram
      if (connection.provider === "deepgram") {
        connection.ws.send(JSON.stringify({ type: "CloseStream" }));
      }
      connection.ws.close();
      this.connections.delete(participantId);
    }
  }

  /**
   * Stop all streams
   */
  stopAll() {
    for (const [participantId] of this.connections) {
      this.stopStreaming(participantId);
    }
  }

  /**
   * Local Whisper transcription (non-streaming, for comparison)
   * Requires whisper.cpp or whisper-node
   */
  async transcribeLocal(audioBuffer) {
    // This would use whisper.cpp bindings
    // Placeholder for local transcription
    console.log("[STT:Whisper] Local transcription not implemented");
    return null;
  }
}

module.exports = { STTService };
