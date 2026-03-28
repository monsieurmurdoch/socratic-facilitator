/**
 * STT Service
 *
 * Real-time speech-to-text with speaker diarization.
 * Supports Deepgram (recommended), AssemblyAI, and local Whisper.
 */

const WebSocket = require("ws");
const fetch = require("node-fetch");

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
    const ws = new WebSocket(
      `wss://api.deepgram.com/v1/listen?` +
      new URLSearchParams({
        encoding: "linear16",
        sample_rate: "16000",
        channels: 1,
        interim_results: "true",
        punctuate: "true",
        diarize: "true",
        language: this.config.language
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

          if (result.type === "Results" && result.channel) {
            const alternatives = result.channel.alternatives;
            if (alternatives && alternatives.length > 0) {
              const transcript = alternatives[0].transcript;
              const isFinal = result.is_final;
              const speaker = alternatives[0].words?.[0]?.speaker || 0;

              if (transcript && transcript.trim()) {
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
