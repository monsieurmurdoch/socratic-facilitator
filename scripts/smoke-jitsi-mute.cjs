#!/usr/bin/env node

const path = require('path');
const puppeteer = require('puppeteer');

require('dotenv').config({ path: path.resolve(__dirname, '../.env.test') });
process.env.NODE_ENV = 'test';

const { setupTestServer } = require('../tests/helpers/test-server');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  let testServer;
  let browser;
  const consoleLines = [];

  try {
    testServer = await setupTestServer();
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--autoplay-policy=no-user-gesture-required',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream'
      ]
    });

    const page = await browser.newPage();
    page.on('console', msg => {
      consoleLines.push(`[${msg.type()}] ${msg.text()}`);
    });
    page.on('pageerror', error => {
      consoleLines.push(`[pageerror] ${error.message}`);
    });

    await page.evaluateOnNewDocument(() => {
      const smoke = {
        binaryFrames: 0,
        commands: [],
        contextsClosed: 0,
        frameLog: [],
        isAudioMutedCalls: 0,
        jitsiReady: false,
        mediaRequests: 0,
        nodesDisconnected: 0,
        sttStarts: 0,
        sttStops: 0,
        textSends: [],
        tracksStopped: 0
      };

      Object.defineProperty(window, '__jitsiMuteSmoke', {
        configurable: true,
        value: smoke
      });

      const originalSend = window.WebSocket.prototype.send;
      window.WebSocket.prototype.send = function patchedSend(data) {
        const isBinary =
          data instanceof ArrayBuffer ||
          ArrayBuffer.isView(data) ||
          (typeof Blob !== 'undefined' && data instanceof Blob);

        if (isBinary) {
          smoke.binaryFrames += 1;
          smoke.frameLog.push({
            at: Date.now(),
            muted: smoke.jitsi ? smoke.jitsi.muted : null
          });
        } else {
          try {
            const parsed = JSON.parse(String(data));
            smoke.textSends.push(parsed.type || String(data));
            if (parsed.type === 'stt_start') smoke.sttStarts += 1;
            if (parsed.type === 'stt_stop') smoke.sttStops += 1;
          } catch (_error) {
            smoke.textSends.push(String(data));
          }
        }

        return originalSend.apply(this, arguments);
      };

      class FakeTrack {
        constructor(kind) {
          this.kind = kind;
          this.enabled = true;
          this.readyState = 'live';
        }

        stop() {
          this.readyState = 'ended';
          smoke.tracksStopped += 1;
        }
      }

      class FakeMediaStream {
        constructor(tracks = []) {
          this._tracks = tracks;
        }

        getAudioTracks() {
          return this._tracks.filter(track => track.kind === 'audio');
        }

        getVideoTracks() {
          return this._tracks.filter(track => track.kind === 'video');
        }

        getTracks() {
          return this._tracks;
        }
      }

      window.MediaStream = FakeMediaStream;
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: async constraints => {
            smoke.mediaRequests += 1;
            const tracks = [];
            if (constraints?.audio) tracks.push(new FakeTrack('audio'));
            if (constraints?.video) tracks.push(new FakeTrack('video'));
            return new FakeMediaStream(tracks);
          }
        }
      });

      class FakeAudioNode {
        connect() {
          return this;
        }

        disconnect() {}
      }

      class FakeAudioWorkletNode extends FakeAudioNode {
        constructor() {
          super();
          this.port = { onmessage: null };
          this._interval = setInterval(() => {
            if (this.port.onmessage) {
              this.port.onmessage({ data: new ArrayBuffer(32) });
            }
          }, 40);
        }

        disconnect() {
          if (this._interval) {
            clearInterval(this._interval);
            this._interval = null;
          }
          smoke.nodesDisconnected += 1;
        }
      }

      class FakeAudioContext {
        constructor(options = {}) {
          this.sampleRate = options.sampleRate || 16000;
          this.destination = {};
          this.audioWorklet = {
            addModule: async () => {}
          };
        }

        createMediaStreamSource() {
          return new FakeAudioNode();
        }

        createGain() {
          const node = new FakeAudioNode();
          node.gain = { value: 1 };
          return node;
        }

        close() {
          smoke.contextsClosed += 1;
          return Promise.resolve();
        }
      }

      window.AudioContext = FakeAudioContext;
      window.webkitAudioContext = FakeAudioContext;
      window.AudioWorkletNode = FakeAudioWorkletNode;

      window.JitsiMeetExternalAPI = class FakeJitsiMeetExternalAPI {
        constructor(_domain, options = {}) {
          this.listeners = new Map();
          this.muted = false;
          this.iframe = document.createElement('iframe');
          this.iframe.title = 'Fake Jitsi';
          if (options.parentNode) {
            options.parentNode.appendChild(this.iframe);
          }
          smoke.jitsi = this;
          smoke.jitsiReady = true;
        }

        addEventListener(name, handler) {
          if (!this.listeners.has(name)) this.listeners.set(name, []);
          this.listeners.get(name).push(handler);
        }

        getIFrame() {
          return this.iframe;
        }

        isAudioMuted() {
          smoke.isAudioMutedCalls += 1;
          return Promise.resolve(this.muted);
        }

        dispose() {
          this.iframe.remove();
        }

        executeCommand(command) {
          smoke.commands.push(command);
          if (command === 'toggleAudio') {
            this.setMuted(!this.muted);
          }
        }

        emit(name, payload = {}) {
          for (const handler of this.listeners.get(name) || []) {
            handler(payload);
          }
        }

        setMuted(muted) {
          this.muted = !!muted;
          this.emit('audioMuteStatusChanged', { muted: this.muted });
        }
      };
    });

    await page.setViewport({ width: 1280, height: 720 });
    await page.goto(testServer.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#name-input', { visible: true, timeout: 5000 });
    await page.type('#name-input', 'Smoke Teacher');
    await page.click('#create-btn');

    await page.waitForSelector('#session-title', { visible: true, timeout: 5000 });
    await page.type('#session-title', 'Jitsi mute smoke');
    await page.click('#start-session-btn');

    await page.waitForSelector('#enter-video-btn', { visible: true, timeout: 5000 });
    await page.click('#enter-video-btn');

    await page.waitForFunction(
      () => window.__jitsiMuteSmoke?.jitsiReady === true,
      { timeout: 5000 }
    );
    await page.waitForFunction(
      () => window.__jitsiMuteSmoke?.sttStarts > 0,
      { timeout: 5000 }
    );
    await page.waitForFunction(
      () => window.__jitsiMuteSmoke?.binaryFrames > 0,
      { timeout: 5000 }
    );

    const layout = await page.evaluate(() => {
      const endButton = document.getElementById('video-end-btn')?.getBoundingClientRect();
      const videoScreen = document.getElementById('video-screen')?.getBoundingClientRect();
      const sidebar = document.querySelector('.video-sidebar')?.getBoundingClientRect();
      return {
        bodyScrollHeight: document.body.scrollHeight,
        documentScrollHeight: document.documentElement.scrollHeight,
        endButtonBottom: endButton?.bottom,
        endButtonTop: endButton?.top,
        innerHeight: window.innerHeight,
        sidebarBottom: sidebar?.bottom,
        videoBottom: videoScreen?.bottom
      };
    });

    if (
      layout.endButtonTop < 0 ||
      layout.endButtonBottom > layout.innerHeight ||
      layout.documentScrollHeight > layout.innerHeight + 1 ||
      layout.bodyScrollHeight > layout.innerHeight + 1
    ) {
      throw new Error(`Video controls overflow viewport: ${JSON.stringify(layout)}`);
    }

    const beforeMute = await page.evaluate(() => ({
      frames: window.__jitsiMuteSmoke.binaryFrames,
      sttStarts: window.__jitsiMuteSmoke.sttStarts
    }));

    const appMuteStart = await page.evaluate(() => {
      const framesBeforeMute = window.__jitsiMuteSmoke.binaryFrames;
      document.getElementById('plato-mic-toggle').click();
      return {
        buttonText: document.getElementById('plato-mic-toggle').textContent,
        framesBeforeMute
      };
    });
    await page.waitForFunction(
      () => window.__jitsiMuteSmoke?.sttStops > 0 &&
        window.__jitsiMuteSmoke?.tracksStopped > 0 &&
        window.__jitsiMuteSmoke?.nodesDisconnected > 0,
      { timeout: 5000 }
    );

    const afterMuteStop = await page.evaluate(() => ({
      contextsClosed: window.__jitsiMuteSmoke.contextsClosed,
      frames: window.__jitsiMuteSmoke.binaryFrames,
      isAudioMutedCalls: window.__jitsiMuteSmoke.isAudioMutedCalls,
      nodesDisconnected: window.__jitsiMuteSmoke.nodesDisconnected,
      sttStops: window.__jitsiMuteSmoke.sttStops,
      tracksStopped: window.__jitsiMuteSmoke.tracksStopped
    }));

    await sleep(700);

    const afterAppMutedWait = await page.evaluate(() => ({
      buttonText: document.getElementById('plato-mic-toggle').textContent,
      commands: window.__jitsiMuteSmoke.commands.slice(),
      frames: window.__jitsiMuteSmoke.binaryFrames,
      mutedFrameCount: window.__jitsiMuteSmoke.frameLog.filter(frame => frame.muted === true).length
    }));

    if (afterAppMutedWait.frames !== appMuteStart.framesBeforeMute) {
      throw new Error(`App-muted Plato still sent STT frames (${appMuteStart.framesBeforeMute} -> ${afterAppMutedWait.frames})`);
    }
    if (!afterAppMutedWait.commands.includes('toggleAudio')) {
      throw new Error('App mute did not drive Jitsi audio toggle');
    }

    await page.evaluate(() => document.getElementById('plato-mic-toggle').click());
    await page.waitForFunction(
      previousFrameCount => window.__jitsiMuteSmoke?.binaryFrames > previousFrameCount,
      { timeout: 5000 },
      afterAppMutedWait.frames
    );

    const afterAppUnmute = await page.evaluate(() => ({
      buttonText: document.getElementById('plato-mic-toggle').textContent,
      frames: window.__jitsiMuteSmoke.binaryFrames,
      sttStarts: window.__jitsiMuteSmoke.sttStarts,
      sttStops: window.__jitsiMuteSmoke.sttStops
    }));

    const directJitsiMuteStart = await page.evaluate(() => {
      const framesBeforeMute = window.__jitsiMuteSmoke.binaryFrames;
      window.__jitsiMuteSmoke.jitsi.setMuted(true);
      return { framesBeforeMute };
    });
    await page.waitForFunction(
      stopCount => window.__jitsiMuteSmoke?.sttStops > stopCount,
      { timeout: 5000 },
      afterAppUnmute.sttStops
    );
    await sleep(700);
    const afterDirectJitsiMutedWait = await page.evaluate(() => ({
      buttonText: document.getElementById('plato-mic-toggle').textContent,
      frames: window.__jitsiMuteSmoke.binaryFrames
    }));

    if (afterDirectJitsiMutedWait.frames !== directJitsiMuteStart.framesBeforeMute) {
      throw new Error(`Direct Jitsi mute still sent STT frames (${directJitsiMuteStart.framesBeforeMute} -> ${afterDirectJitsiMutedWait.frames})`);
    }

    await page.evaluate(() => window.__jitsiMuteSmoke.jitsi.setMuted(false));
    await page.waitForFunction(
      previousFrameCount => window.__jitsiMuteSmoke?.binaryFrames > previousFrameCount,
      { timeout: 5000 },
      afterDirectJitsiMutedWait.frames
    );

    const afterDirectJitsiUnmute = await page.evaluate(() => ({
      buttonText: document.getElementById('plato-mic-toggle').textContent,
      frames: window.__jitsiMuteSmoke.binaryFrames,
      sttStarts: window.__jitsiMuteSmoke.sttStarts,
      sttStops: window.__jitsiMuteSmoke.sttStops
    }));

    console.log('Jitsi mute smoke passed');
    console.log(JSON.stringify({
      beforeMute,
      layout,
      appMuteStart,
      afterMuteStop,
      afterAppMutedWait,
      afterAppUnmute,
      directJitsiMuteStart,
      afterDirectJitsiMutedWait,
      afterDirectJitsiUnmute
    }, null, 2));
  } catch (error) {
    console.error('Jitsi mute smoke failed:', error.message);
    if (consoleLines.length) {
      console.error('Browser console tail:');
      for (const line of consoleLines.slice(-40)) {
        console.error(line);
      }
    }
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (testServer) await testServer.close();
  }
}

main();
