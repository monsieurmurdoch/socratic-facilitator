/**
 * Text-to-Speech Module
 * Priority: ElevenLabs (cloud, high quality) → Piper (local, free) → silent
 */

const { spawn } = require("child_process");
const { elevenLabsBreaker } = require("../utils/api-breakers");

const PIPER_PATH = process.env.PIPER_PATH || 'server/models/tts/piper/piper';
const PIPER_MODEL_PATH = process.env.PIPER_MODEL_PATH || 'server/models/tts/en_US-lessac-medium.onnx';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // Rachel

/**
 * Generate TTS audio buffer from text
 * @param {string} text - Text to convert to speech
 * @returns {Promise<Buffer>} Audio buffer
 */
async function generateTTS(text) {
  // Try ElevenLabs first (cloud, high quality)
  if (ELEVENLABS_API_KEY) {
    try {
      const audioBuffer = await elevenLabsBreaker.execute(async () => {
        const nodeFetch = require('node-fetch');
        const response = await nodeFetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'xi-api-key': ELEVENLABS_API_KEY
            },
            body: JSON.stringify({
              text,
              model_id: 'eleven_monolingual_v1',
              voice_settings: {
                stability: 0.5,
                similarity_boost: 0.75
              }
            })
          }
        );

        if (!response.ok) {
          const errBody = await response.text();
          throw new Error(`ElevenLabs API returned ${response.status}: ${errBody}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
      });

      console.log(`[TTS:ElevenLabs] Generated ${audioBuffer.length} bytes`);
      return audioBuffer;
    } catch (err) {
      console.warn('[TTS:ElevenLabs] Error:', err.message, '— falling back to Piper');
    }
  }

  // Fall back to Piper (local)
  return new Promise((resolve, reject) => {
    const piper = spawn(PIPER_PATH, [
      '--model', PIPER_MODEL_PATH,
      '--output_file', '-'
    ]);

    let audioData = [];
    piper.stdout.on('data', chunk => audioData.push(chunk));

    piper.on('error', (err) => {
      reject(new Error('TTS not available (no ElevenLabs key, Piper not installed): ' + err.message));
    });

    piper.stdin.write(text);
    piper.stdin.end();

    piper.on('close', code => {
      if (code === 0) {
        console.log(`[TTS:Piper] Generated ${Buffer.concat(audioData).length} bytes`);
        resolve(Buffer.concat(audioData));
      }
      else reject(new Error('Piper TTS failed with code ' + code));
    });
  });
}

module.exports = {
  generateTTS,
  PIPER_PATH,
  PIPER_MODEL_PATH,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID
};
