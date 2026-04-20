# Jitsi Bot — EXPERIMENTAL / QUARANTINED

**Status: not used in production. Do not enable in a deployed environment.**

This directory contains a Puppeteer-driven headless-Chrome bot that joins a
Jitsi room as a participant, captures the full room audio, and streams it to
Deepgram for STT. It was an early architectural bet on single-stream room
capture; it has been superseded by per-browser STT.

## Why it's quarantined

- It duplicates the production STT path. Every browser already relays its mic
  audio to Deepgram via `server/websocket/handlers.js` (`stt_start` /
  `stt_stop`). The bot adds a second, redundant audio stream.
- It does not run on the production host (Railway / Alpine container) because
  Puppeteer + headless Chrome + audio capture is fragile in slim Linux images.
- Two paths means two test surfaces, two failure modes, and unclear ownership
  when something breaks.

## What it uniquely does (the only reasons to revive it)

- Captures a single room-level audio stream rather than N per-tab streams.
  Useful if we ever need server-side diarization from a unified source instead
  of merging client-side transcripts.
- Lets a "phantom participant" join a Jitsi call without a human host opening
  a browser tab — relevant if we ever want sessions that start without a
  teacher present.

If neither use case is on the near-term roadmap, this code can be deleted.

## How it's gated today

`process.env.ENABLE_JITSI_BOT === 'true'` is required to load the launcher.
In addition, `server/index.js` refuses to load it when `NODE_ENV=production`
unless `JITSI_BOT_ALLOW_IN_PRODUCTION=true` is also set. This is an
intentional friction layer — if you find yourself setting both, stop and
re-read this file.

## If you're tempted to enable it

1. Confirm a use case from the "uniquely does" list above is actually live.
2. Confirm the host can run Puppeteer + Chrome (Alpine cannot; Debian-slim can).
3. Add a regression test for whichever scenario you're enabling it for.
4. Update this file with the date and the reason.

Otherwise: leave it alone. The production STT path is in
`server/websocket/handlers.js` (search for `handleSttStart` /
`handleSttStop` / `deepgramWs`).

---

*Last quarantined: 2026-04-18.*
