const { launch, getStream } = require('puppeteer-stream');
const WebSocket = require('ws');

const JITSI_URL = process.env.JITSI_URL || 'https://meet.jit.si/SocraticFacilitationTest123';
const WS_URL = process.env.WS_URL || 'ws://localhost:3000';
const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let jitsiPage = null; // Module-scoped instead of global

async function main() {
    console.log(`[Bot] Connecting to Socratic WebSocket Server at ${WS_URL}...`);
    const ws = new WebSocket(WS_URL);
    ws.binaryType = 'arraybuffer';

    ws.on('open', () => {
        console.log('[Bot] Connected to Facilitator WebSocket. Joining session...');
        // As a bot, we just create a session or join one.
        ws.send(JSON.stringify({
            type: 'create_session',
            topicId: 'theseus'
        }));
    });

    ws.on('message', async (data) => {
        if (data instanceof ArrayBuffer || Buffer.isBuffer(data)) {
            console.log(`[Bot] Received ${data.byteLength} bytes of TTS audio from Facilitator. Injecting to Jitsi...`);
            if (jitsiPage) {
                try {
                    // Convert binary to base64 so we can inject it into evaluate()
                    const b64 = Buffer.from(data).toString('base64');
                    await jitsiPage.evaluate(async (base64Audio) => {
                        if (window.playTTSAudio) {
                            await window.playTTSAudio(base64Audio);
                        }
                    }, b64);
                } catch (e) {
                    console.error('[Bot] Failed to inject audio:', e.message);
                }
            }
            return;
        }
        let msg;
        try {
            msg = JSON.parse(data);
        } catch (e) { return; }

        if (msg.type === 'session_created') {
            console.log(`[Bot] Session created locally (${msg.sessionId}). Starting discussion.`);
            ws.send(JSON.stringify({ type: 'start_discussion' }));

            console.log(`[Bot] Launching headless browser for Jitsi at ${JITSI_URL}...`);
            await launchJitsiBot(ws, msg.sessionId);
        }
    });
}

async function launchJitsiBot(ws, localSessionId) {
    const browser = await launch({
        headless: false, // Useful for debugging initially
        executablePath: CHROME_PATH,
        args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--disable-web-security',
            '--mute-audio' // Mute tab so we don't hear feedback
        ]
    });

    const page = await browser.newPage();
    jitsiPage = page; // Store in module scope so WS handler can access it

    // Try to bypass the pre-join screen on Jitsi
    await page.goto(`${JITSI_URL}#config.prejoinPageEnabled=false`, { waitUntil: 'domcontentloaded' });

    console.log('[Bot] Successfully loaded Jitsi Meet.');

    // Type bot name if prompted
    try {
        const inputSelector = 'input.field.focused';
        await page.waitForSelector(inputSelector, { timeout: 5000 });
        await page.type(inputSelector, 'Socratic AI');
        await page.keyboard.press('Enter');
    } catch (e) { }

    console.log('[Bot] Bot has joined the Jitsi room!');

    // Extract Audio from Jitsi
    // The stream returned by getStream captures tab audio
    try {
        const stream = await getStream(page, { audio: true, video: false });
        stream.on('data', chunk => {
            // Send the raw PCM/Webm stream captured by puppeteer-stream directly to our WS
            // Vosk JS expects PCM 16-bit 16kHz or 44.1kHz.
            // Puppeteer-stream outputs WebM by default, which may need ffmpeg conversion.
            // For now, we forward it to the server.
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(chunk);
            }
        });
    } catch (e) {
        console.log("[Bot] Note: puppeteer-stream getStream failed or unsupported. (Requires Chrome, not standard headless Chromium).");
    }

    // Inject logic into Jitsi page to handle playing TTS Audio back as the Bot's microphone!
    await page.evaluate(() => {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const dest = audioCtx.createMediaStreamDestination();

        // Attempt to swap Jitsi's local audio track with our dest.stream
        // Check if Jitsi API is loaded
        if (window.APP && window.APP.conference) {
            // This might not be enough, as Jitsi might re-initialize its audio track.
            // We'll also try dynamic replacement below.
            window.APP.conference.localAudio.stream = dest.stream;
        }

        // Expose TTS player globally in page
        window.playTTSAudio = async (base64Audio) => {
            const binaryString = window.atob(base64Audio);
            const len = binaryString.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }

            const audioBuffer = await audioCtx.decodeAudioData(bytes.buffer);
            const source = audioCtx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(dest); // Connect to our virtual microphone stream
            source.start(0);

            // Also try to replace the track dynamically if the API exists
            if (window.JitsiMeetJS && window.APP && window.APP.conference) {
                try {
                    // Create a new JitsiLocalTrack from our destination stream
                    const newAudioTrack = new window.JitsiMeetJS.createLocalTrack('audio', dest.stream.getAudioTracks()[0]);

                    // Replace the current local audio track with the new one
                    // This will effectively make the audio from `dest` stream into Jitsi
                    await window.APP.conference.replaceLocalTrack(window.APP.conference.getLocalAudioTrack(), newAudioTrack);

                    // Store the new track as the current local audio track
                    window.APP.conference.localAudio = newAudioTrack;

                } catch (e) {
                    console.error("Failed to dynamically replace Jitsi audio track:", e);
                }
            }
        };
    });
}

main().catch(console.error);
