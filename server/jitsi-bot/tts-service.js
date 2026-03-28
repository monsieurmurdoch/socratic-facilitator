/**
 * TTS Service
 *
 * Text-to-speech with support for ElevenLabs (cloud) and Piper (local).
 * Handles audio generation and streaming for real-time output.
 */

const fetch = require("node-fetch");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

class TTSService {
  constructor(config) {
    this.config = {
      provider: config.provider || "piper",
      elevenLabsKey: config.elevenLabsKey,
      elevenLabsVoice: config.elevenLabsVoice || "21m00Tcm4TlvDq8ikWAM", // Rachel
      piperModel: config.piperModel || "en_US-lessac-medium",
      piperPath: config.piperPath || "piper",
      sampleRate: config.sampleRate || 22050,
      ...config
    };

    this.onAudioReady = null;
    this.isPlaying = false;
    this.audioQueue = [];
  }

  /**
   * Generate speech from text
   */
  async speak(text) {
    if (!text || !text.trim()) return null;

    console.log(`[TTS] Generating speech: "${text.slice(0, 50)}..."`);

    switch (this.config.provider) {
      case "elevenlabs":
        return this.speakWithElevenLabs(text);
      case "say":
        return this.speakWithSay(text);
      case "piper":
      default:
        // Try piper first, fall back to 'say' if it fails
        const piperResult = await this.speakWithPiper(text);
        if (piperResult) return piperResult;
        console.log("[TTS] Piper failed, falling back to macOS 'say'");
        return this.speakWithSay(text);
    }
  }

  /**
   * macOS 'say' command TTS (built-in, always available on macOS)
   */
  async speakWithSay(text) {
    return new Promise((resolve, reject) => {
      const tmpFile = `/tmp/tts-say-${Date.now()}.aiff`;

      // Use macOS 'say' command to generate audio
      const say = spawn("say", [
        "-v", "Samantha",  // Good quality voice
        "-o", tmpFile,
        text
      ], {
        stdio: ["pipe", "pipe", "pipe"]
      });

      say.on("close", (code) => {
        if (code === 0) {
          // Read the generated AIFF file
          fs.readFile(tmpFile, (err, data) => {
            if (err) {
              console.error("[TTS:Say] Error reading file:", err);
              resolve(null);
              return;
            }

            console.log(`[TTS:Say] Generated ${data.length} bytes (AIFF)`);

            // Clean up temp file
            fs.unlink(tmpFile, () => {});

            // Emit audio
            if (this.onAudioReady) {
              this.onAudioReady(data);
            }

            resolve(data);
          });
        } else {
          console.error(`[TTS:Say] Exited with code ${code}`);
          resolve(null);
        }
      });

      say.on("error", (err) => {
        console.error("[TTS:Say] Error:", err);
        resolve(null);
      });
    });
  }

  /**
   * ElevenLabs TTS (cloud, high quality)
   */
  async speakWithElevenLabs(text) {
    const voiceId = this.config.elevenLabsVoice;

    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "xi-api-key": this.config.elevenLabsKey
          },
          body: JSON.stringify({
            text,
            model_id: "eleven_monolingual_v1",
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.75
            }
          })
        }
      );

      if (!response.ok) {
        throw new Error(`ElevenLabs error: ${response.status}`);
      }

      // Get audio buffer
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = Buffer.from(arrayBuffer);

      console.log(`[TTS:ElevenLabs] Generated ${audioBuffer.length} bytes`);

      // Emit audio
      if (this.onAudioReady) {
        this.onAudioReady(audioBuffer);
      }

      return audioBuffer;
    } catch (error) {
      console.error("[TTS:ElevenLabs] Error:", error);
      return null;
    }
  }

  /**
   * Piper TTS (local, fast, free)
   */
  async speakWithPiper(text) {
    return new Promise((resolve, reject) => {
      // Use environment variable or default path
      const modelPath = process.env.PIPER_MODEL_PATH ||
        path.join(__dirname, "models", `${this.config.piperModel}.onnx`);

      const piperPath = process.env.PIPER_PATH || this.config.piperPath;

      console.log(`[TTS:Piper] Using model: ${modelPath}`);
      console.log(`[TTS:Piper] Using binary: ${piperPath}`);

      // Check if model exists
      if (!fs.existsSync(modelPath)) {
        console.error(`[TTS:Piper] Model not found: ${modelPath}`);
        console.log("[TTS:Piper] Download models from: https://github.com/rhasspy/piper/releases");
        resolve(null);
        return;
      }

      // Spawn piper process
      const piper = spawn(piperPath, [
        "--model", modelPath,
        "--output-raw",
        "--quiet"
      ], {
        stdio: ["pipe", "pipe", "pipe"]
      });

      const chunks = [];

      piper.stdout.on("data", (chunk) => {
        chunks.push(chunk);
      });

      piper.stderr.on("data", (data) => {
        console.error(`[TTS:Piper] stderr: ${data}`);
      });

      piper.on("close", (code) => {
        if (code === 0) {
          const audioBuffer = Buffer.concat(chunks);
          console.log(`[TTS:Piper] Generated ${audioBuffer.length} bytes`);

          // Emit audio
          if (this.onAudioReady) {
            this.onAudioReady(audioBuffer);
          }

          resolve(audioBuffer);
        } else {
          console.error(`[TTS:Piper] Exited with code ${code}`);
          resolve(null);
        }
      });

      piper.on("error", (err) => {
        console.error("[TTS:Piper] Error:", err);
        resolve(null);
      });

      // Send text to piper
      piper.stdin.write(text);
      piper.stdin.end();
    });
  }

  /**
   * ElevenLabs streaming TTS (lower latency)
   */
  async streamWithElevenLabs(text, onChunk) {
    const voiceId = this.config.elevenLabsVoice;

    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "xi-api-key": this.config.elevenLabsKey
          },
          body: JSON.stringify({
            text,
            model_id: "eleven_monolingual_v1",
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.75
            },
            optimize_streaming_latency: 3
          })
        }
      );

      if (!response.ok) {
        throw new Error(`ElevenLabs stream error: ${response.status}`);
      }

      // Stream chunks
      const reader = response.body.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (onChunk) {
          onChunk(Buffer.from(value));
        }
      }

      console.log("[TTS:ElevenLabs] Streaming complete");
    } catch (error) {
      console.error("[TTS:ElevenLabs] Stream error:", error);
    }
  }

  /**
   * Queue text for sequential playback
   */
  queueSpeak(text) {
    this.audioQueue.push(text);
    this.processQueue();
  }

  /**
   * Process queued text
   */
  async processQueue() {
    if (this.isPlaying || this.audioQueue.length === 0) return;

    this.isPlaying = true;
    const text = this.audioQueue.shift();

    try {
      await this.speak(text);
    } catch (err) {
      console.error("[TTS] Queue error:", err);
    }

    this.isPlaying = false;

    // Process next item
    if (this.audioQueue.length > 0) {
      setTimeout(() => this.processQueue(), 100);
    }
  }

  /**
   * Clear queue
   */
  clearQueue() {
    this.audioQueue = [];
    this.isPlaying = false;
  }

  /**
   * Convert raw PCM to WAV format
   */
  pcmToWav(pcmBuffer, sampleRate = 22050, channels = 1, bitDepth = 16) {
    const wavBuffer = Buffer.alloc(44 + pcmBuffer.length);

    // RIFF header
    wavBuffer.write("RIFF", 0);
    wavBuffer.writeUInt32LE(36 + pcmBuffer.length, 4);
    wavBuffer.write("WAVE", 8);

    // fmt chunk
    wavBuffer.write("fmt ", 12);
    wavBuffer.writeUInt32LE(16, 16); // chunk size
    wavBuffer.writeUInt16LE(1, 20);  // PCM format
    wavBuffer.writeUInt16LE(channels, 22);
    wavBuffer.writeUInt32LE(sampleRate, 24);
    wavBuffer.writeUInt32LE(sampleRate * channels * bitDepth / 8, 28); // byte rate
    wavBuffer.writeUInt16LE(channels * bitDepth / 8, 32); // block align
    wavBuffer.writeUInt16LE(bitDepth, 34);

    // data chunk
    wavBuffer.write("data", 36);
    wavBuffer.writeUInt32LE(pcmBuffer.length, 40);
    pcmBuffer.copy(wavBuffer, 44);

    return wavBuffer;
  }

  /**
   * Get available ElevenLabs voices
   */
  async getElevenLabsVoices() {
    try {
      const response = await fetch("https://api.elevenlabs.io/v1/voices", {
        headers: {
          "xi-api-key": this.config.elevenLabsKey
        }
      });

      const data = await response.json();
      return data.voices || [];
    } catch (error) {
      console.error("[TTS] Failed to get voices:", error);
      return [];
    }
  }
}

module.exports = { TTSService };
