/**
 * Session starter for Jitsi bot
 *
 * This module provides a way to launch a Jitsi bot from the main server
 * when a video mode session starts. The bot runs as a child process
 * and communicates back via IPC.
 */

const { spawn } = require('child_process');
const path = require('path');

/**
 * Start a Jitsi bot for a session
 *
 * @param {string} sessionId - The session short code
 * @param {object} config
 * @param {string} config.roomName - Jitsi room name
 * @param {string} config.topic - Discussion topic title
 * @param {number} config.defaultAge - Default participant age
 * @returns {ChildProcess} The bot child process
 */
function startJitsiBot(sessionId, config = {}) {
  const botPath = path.join(__dirname, 'run-bot.js');

  const args = [
    '--room', config.roomName || `socratic-${sessionId}`,
    '--name', 'Plato'
  ];

  if (config.topic) {
    args.push('--topic', config.topic);
  }

  if (config.defaultAge) {
    args.push('--age', String(config.defaultAge));
  }

  // Show browser in development
  if (process.env.NODE_ENV !== 'production') {
    args.push('--headful');
  }

  console.log(`[Jitsi Bot] Launching for session ${sessionId}: node ${botPath} ${args.join(' ')}`);

  const bot = spawn('node', [botPath, ...args], {
    env: { ...process.env },
    cwd: path.join(__dirname, '../..'), // project root so dotenv picks up .env
    stdio: ['pipe', 'inherit', 'inherit']
  });

  bot.on('error', (err) => {
    console.error(`[Jitsi Bot ${sessionId}] Failed to start:`, err);
  });

  bot.on('exit', (code) => {
    console.log(`[Jitsi Bot ${sessionId}] Exited with code ${code}`);
  });

  return bot;
}

/**
 * Stop a Jitsi bot
 */
function stopJitsiBot(bot) {
  if (bot && !bot.killed) {
    bot.kill('SIGTERM');
  }
}

module.exports = { startJitsiBot, stopJitsiBot };
