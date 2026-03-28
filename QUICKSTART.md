# Quick Start: Voice Facilitator Bot

Get the voice-based Socratic facilitator running locally in 5 minutes.

## Prerequisites

- Docker Desktop (running)
- Node.js 18+
- API Keys:
  - [Anthropic](https://console.anthropic.com) (required)
  - [Deepgram](https://console.deepgram.com) (required - free tier available)

## Setup

### 1. Configure Environment

```bash
# Copy example config
cp .env.example .env

# Edit .env and add your API keys:
# ANTHROPIC_API_KEY=sk-ant-xxxxx
# DEEPGRAM_API_KEY=xxxxx
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Start Jitsi + Bot

```bash
# One command to start everything
npm run local

# Or with a custom room name
npm run local my-discussion-room
```

This will:
1. Download and start local Jitsi (first run only)
2. Start the facilitator bot
3. Print the URL to join

## Usage

1. **Open Jitsi in your browser:** `http://localhost:8443/socratic-discussion`
2. **Enter your name and join**
3. **Start talking!** The bot will listen and facilitate

## Commands

| Command | Description |
|---------|-------------|
| `npm run local` | Start Jitsi + bot |
| `npm run bot` | Start just the bot (Jitsi must be running) |
| `npm run bot:headful` | Start bot with visible browser (debug) |
| `npm run jitsi:start` | Start just Jitsi |
| `npm run jitsi:stop` | Stop Jitsi |
| `npm run jitsi:logs` | View Jitsi logs |

## Bot Options

```bash
node server/jitsi-bot/run-bot.js --help

Options:
  --room, -r <name>    Room name (default: socratic-discussion)
  --name, -n <name>    Bot name (default: Facilitator)
  --jitsi, -j <url>    Jitsi URL (default: http://localhost:8443)
  --topic, -t <topic>  Discussion topic
  --headful, -h        Show browser window
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                 Your Machine                         │
│                                                     │
│  ┌─────────────┐     ┌─────────────────────────┐   │
│  │  Browser    │     │    Bot Server            │   │
│  │  (You)      │◀───▶│  ┌──────────────────┐   │   │
│  │             │     │  │ Puppeteer (Bot)  │   │   │
│  └─────────────┘     │  └────────┬─────────┘   │   │
│        │             │           │             │   │
│        │             │           ▼             │   │
│        │             │  ┌──────────────────┐   │   │
│        │             │  │ Deepgram (STT)   │   │   │
│        │             │  └────────┬─────────┘   │   │
│        │             │           │             │   │
│        │             │           ▼             │   │
│        │             │  ┌──────────────────┐   │   │
│        │             │  │ Claude (AI)      │   │   │
│        │             │  └────────┬─────────┘   │   │
│        │             │           │             │   │
│        │             │           ▼             │   │
│        │             │  ┌──────────────────┐   │   │
│        │             │  │ Piper/ElevenLabs │   │   │
│        │             │  │ (TTS)            │   │   │
│        │             │  └──────────────────┘   │   │
│        │             └─────────────────────────┘   │
│        │                     │                     │
│        ▼                     ▼                     │
│  ┌─────────────────────────────────────────────┐   │
│  │          Local Jitsi (Docker)               │   │
│  │          http://localhost:8443              │   │
│  └─────────────────────────────────────────────┘   │
│                                                     │
└─────────────────────────────────────────────────────┘
```

## Troubleshooting

### "Docker is not running"
Start Docker Desktop and try again.

### "Jitsi not responding"
```bash
# Check Jitsi logs
npm run jitsi:logs

# Restart Jitsi
npm run jitsi:stop
npm run jitsi:start
```

### "Bot can't join room"
- Make sure you're using `http://localhost:8443` (not https)
- Try running with `--headful` to see the browser: `npm run bot:headful`

### "No audio from bot"
- Check that Piper TTS is working (it's built into the Docker image)
- Or set `ELEVENLABS_API_KEY` in `.env` for cloud TTS

### "STT not working"
- Verify `DEEPGRAM_API_KEY` is set correctly
- Check Deepgram console for usage: https://console.deepgram.com

## Testing with Multiple Participants

1. Open multiple browser tabs to `http://localhost:8443/your-room`
2. Join with different names in each tab
3. The bot will track all participants and facilitate

## Next Steps

- Set a topic: `node server/jitsi-bot/run-bot.js --room test --topic "The ethics of AI"`
- Use a custom opening question in `.env`
- Deploy to DigitalOcean for production use (see DEPLOYMENT.md)
