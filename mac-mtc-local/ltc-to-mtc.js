// ============================================================================
// ltc-to-mtc.js  —  LTC (USB audio) → MTC (MIDI) converter for macOS
// ============================================================================
//
// Captures audio from a USB interface, decodes Linear Timecode (LTC) off one
// channel with the reference `libltc` library, and re-transmits it as MIDI
// Time Code (MTC): continuous quarter-frame messages plus a full-frame SysEx
// on start / seek / resume.
//
// It sends MTC to a MIDI *output* port. If you point it at an IAC Driver bus,
// the existing `server.js` in this folder (which reads MTC from IAC *input*)
// picks it straight up — so the whole chain runs on one Mac:
//
//     USB audio (LTC)  ->  ltc-to-mtc.js  ->  IAC Driver  ->  server.js  ->  dashboard
//
// The same MTC stream also feeds any other consumer on that port (QLab, a DAW,
// a lighting console, etc.).
//
// The MTC-encoding logic (quarter-frame packing, rate codes, full-frame SysEx,
// the auto-increment + resync-on-jump cycle) is ported from
// fiverecords/SuperTimecodeConverter (MtcOutput.h / TimecodeCore.h, MIT).
//
// ---------------------------------------------------------------------------
// Requirements
//   - ffmpeg on PATH        (brew install ffmpeg)  — the audio capture engine
//   - libltc-wrapper + midi  (npm install)          — decode + MIDI out
//     (libltc-wrapper is a native addon; you need Xcode command-line tools:
//      `xcode-select --install`)
//
// Quick start
//   1. List audio inputs:  ffmpeg -f avfoundation -list_devices true -i ""
//      Note the [n] index of your USB interface under "AVFoundation audio".
//   2. Enable an IAC bus in Audio MIDI Setup → MIDI Studio → IAC Driver.
//   3. Run:  AUDIO_INPUT=<n> CHANNELS=<n> LTC_CHANNEL=<i> FPS=<fps> node ltc-to-mtc.js
//   4. In another terminal:  npm start   (server.js — the dashboard)
// ============================================================================

const { spawn } = require('child_process');
const midi = require('midi');
const { LTCDecoder } = require('libltc-wrapper');

// ---- Configuration (override with environment variables) -------------------
const AUDIO_INPUT  = process.env.AUDIO_INPUT  || '0';   // avfoundation audio index (from -list_devices)
const SAMPLE_RATE  = parseInt(process.env.SAMPLE_RATE || '48000', 10);
const CHANNELS     = parseInt(process.env.CHANNELS    || '2', 10);  // channels the interface captures
const LTC_CHANNEL  = parseInt(process.env.LTC_CHANNEL || '0', 10);  // which channel carries LTC (0-indexed)
const FPS          = parseFloat(process.env.FPS       || '30');     // 30, 29.97, 25, 24, 23.976
// Name (substring) of the MIDI OUTPUT port to send MTC to. If none matches,
// a virtual port is created instead (see below).
const MIDI_OUT     = process.env.MIDI_OUT || 'IAC Driver';
// Optional: replace the whole capture command. Must emit raw interleaved
// signed 16-bit little-endian PCM to stdout at SAMPLE_RATE / CHANNELS.
const CAPTURE_CMD  = process.env.CAPTURE_CMD || null;

// ---------------------------------------------------------------------------
// Frame-rate helpers (mirrors TimecodeCore.h)
//   SMPTE rate code:  0 = 24, 1 = 25, 2 = 29.97-df, 3 = 30
// ---------------------------------------------------------------------------
function resolveFps(fpsValue, dropDetected) {
    // Snap the configured FPS to a known rate; the decoder's drop flag can
    // upgrade "30" to "29.97 drop-frame" when the LTC signal says so.
    // Tolerance is tight (0.02) so 30.0 and 29.97 (0.03 apart) don't collide.
    const near = (a, b) => Math.abs(a - b) < 0.02;

    const DF   = { num: 30000 / 1001, maxFrames: 30, rateCode: 2, drop: true,  label: '29.97d' };

    if (near(fpsValue, 25))     return { num: 25.0,         maxFrames: 25, rateCode: 1, drop: false, label: '25'     };
    if (near(fpsValue, 24))     return { num: 24.0,         maxFrames: 24, rateCode: 0, drop: false, label: '24'     };
    if (near(fpsValue, 23.976)) return { num: 24000 / 1001, maxFrames: 24, rateCode: 0, drop: false, label: '23.976' };
    if (near(fpsValue, 29.97))  return DF;
    // FPS reads ~30 but the LTC signal carries the drop-frame flag ⇒ 29.97 df
    if (dropDetected)           return DF;
    return                             { num: 30.0,         maxFrames: 30, rateCode: 3, drop: false, label: '30'     };
}

// Increment a timecode by one frame, wrapping at 24h, honouring 29.97 drop-frame
// (skip frames 0 & 1 at the start of every minute except every 10th). Ported
// from TimecodeCore.h incrementFrame().
function incrementFrame(tc, rate) {
    const max = rate.maxFrames;
    const r = { h: tc.h, m: tc.m, s: tc.s, f: tc.f };

    if (r.f < 0)      r.f = 0;
    if (r.f >= max)   r.f = max - 1;
    if (r.s < 0 || r.s >= 60) r.s = 0;
    if (r.m < 0 || r.m >= 60) r.m = 0;
    if (r.h < 0 || r.h >= 24) r.h = 0;

    r.f++;
    if (r.f >= max) { r.f = 0; r.s++; }
    if (r.s >= 60)  { r.s = 0; r.m++; }
    if (r.m >= 60)  { r.m = 0; r.h++; }
    if (r.h >= 24)  { r.h = 0; }

    if (rate.drop && r.f === 0 && r.s === 0 && (r.m % 10) !== 0)
        r.f = 2;

    return r;
}

function tcToFrameCount(tc, max) {
    return tc.h * 3600 * max + tc.m * 60 * max + tc.s * max + tc.f;
}

// ---------------------------------------------------------------------------
// MtcSender — quarter-frame + full-frame MTC generator on a MIDI output.
// Single-threaded port of SuperTimecodeConverter's MtcOutput.h (no atomics
// needed in Node). Emits QFs at 4× the frame rate with a drift-corrected
// scheduler; auto-increments between decoded LTC frames and resyncs on jumps.
// ---------------------------------------------------------------------------
class MtcSender {
    constructor(output, rate) {
        this.output = output;
        this.rate = rate;

        this.pending = { h: 0, m: 0, s: 0, f: 0 };  // latest value from the LTC decoder
        this.cycle   = { h: 0, m: 0, s: 0, f: 0 };  // value transmitted across the current 8-QF cycle
        this.qfIndex = 0;
        this.seeded  = false;
        this.running = false;

        this.qfInterval = 1000.0 / (rate.num * 4.0);   // ms between quarter-frames
        this.nextQfTime = 0;
        this.timer = null;
        this.lastFrameMs = 0;                          // when we last got LTC (for pause detect)
        this.SOURCE_TIMEOUT_MS = 150;                  // no LTC for this long ⇒ paused
    }

    setRate(rate) {
        this.rate = rate;
        this.qfInterval = 1000.0 / (rate.num * 4.0);
    }

    // Called for every decoded LTC frame.
    updateTimecode(tc) {
        this.pending = tc;
        this.lastFrameMs = performance.now();

        if (!this.running) {
            // Resuming (or first frame): re-sync receivers immediately and
            // restart the quarter-frame cycle from a clean state.
            this.running = true;
            this.seeded = false;
            this.qfIndex = 0;
            this.sendFullFrame();
            this.nextQfTime = performance.now() + this.qfInterval;
            this._schedule();
        }
    }

    start() {
        this.running = false;      // becomes true on first decoded frame
        this.seeded = false;
        this.qfIndex = 0;
    }

    stop() {
        this.running = false;
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    }

    // Full-frame SysEx: authoritative snapshot so receivers lock instantly
    // instead of waiting up to 8 QFs (~2 frames) to reconstruct the position.
    sendFullFrame() {
        const tc = this.pending;
        if (tc.h > 23 || tc.m > 59 || tc.s > 59 || tc.f >= this.rate.maxFrames) return;
        const hr = (tc.h & 0x1F) | (this.rate.rateCode << 5);
        this.output.sendMessage([0xF0, 0x7F, 0x7F, 0x01, 0x01, hr, tc.m, tc.s, tc.f, 0xF7]);
    }

    _sendQuarterFrame(index) {
        const tc = this.cycle;
        let value = 0;
        switch (index) {
            case 0: value =  tc.f        & 0x0F; break;
            case 1: value = (tc.f >> 4)  & 0x01; break;
            case 2: value =  tc.s        & 0x0F; break;
            case 3: value = (tc.s >> 4)  & 0x03; break;
            case 4: value =  tc.m        & 0x0F; break;
            case 5: value = (tc.m >> 4)  & 0x03; break;
            case 6: value =  tc.h        & 0x0F; break;
            case 7: value = ((tc.h >> 4) & 0x01) | (this.rate.rateCode << 1); break;
        }
        const dataByte = ((index << 4) | (value & 0x0F)) & 0x7F;
        this.output.sendMessage([0xF1, dataByte]);
    }

    _schedule() {
        // Drift-corrected loop: advance nextQfTime by exact intervals rather
        // than by wall-clock, and process any QFs already due on each wake.
        const tick = () => {
            if (!this.running) return;

            const now = performance.now();

            // Pause detection: LTC stopped arriving ⇒ suspend QF output.
            // The next decoded frame (updateTimecode) will resume us.
            if (now - this.lastFrameMs > this.SOURCE_TIMEOUT_MS) {
                this.running = false;
                this.timer = null;
                return;
            }

            let guard = 0;   // allow a little catch-up but never a burst
            while (now >= this.nextQfTime && guard < 2) {
                if (this.qfIndex === 0) {
                    if (!this.seeded) {
                        this.cycle = { ...this.pending };
                        this.seeded = true;
                    } else {
                        // Auto-increment by 2 frames (one 8-QF cycle spans two
                        // frame durations), then resync only on a real jump.
                        this.cycle = incrementFrame(incrementFrame(this.cycle, this.rate), this.rate);

                        const max = this.rate.maxFrames;
                        const dayFrames = 24 * 3600 * max;
                        let diff = ((tcToFrameCount(this.pending, max) - tcToFrameCount(this.cycle, max)) % dayFrames + dayFrames) % dayFrames;
                        if (diff > dayFrames / 2) diff = dayFrames - diff;
                        if (diff > 2) this.cycle = { ...this.pending };
                    }
                }

                this._sendQuarterFrame(this.qfIndex);
                this.qfIndex = (this.qfIndex + 1) % 8;

                this.nextQfTime += this.qfInterval;
                guard++;
            }

            // If we fell badly behind (e.g. GC stall), reset the clock.
            if (performance.now() - this.nextQfTime > 50) this.nextQfTime = performance.now();

            const delay = Math.max(0, this.nextQfTime - performance.now());
            this.timer = setTimeout(tick, delay);
        };

        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(tick, Math.max(0, this.nextQfTime - performance.now()));
    }
}

// ---------------------------------------------------------------------------
// Open the MIDI output port (or fall back to a virtual port).
// ---------------------------------------------------------------------------
function openMidiOutput() {
    const output = new midi.Output();
    const count = output.getPortCount();
    let idx = -1;
    for (let i = 0; i < count; i++) {
        const name = output.getPortName(i);
        if (name.includes(MIDI_OUT) || name.includes('Bus 1')) { idx = i; break; }
    }

    if (idx !== -1) {
        console.log(`🎹 Sending MTC to MIDI port: ${output.getPortName(idx)}`);
        output.openPort(idx);
    } else {
        // No matching hardware/IAC port — create our own virtual source so the
        // converter still works. Point your DAW/console at "LTC to MTC", or set
        // MIDI_OUT to a port name that exists (e.g. an enabled IAC bus).
        console.log(`⚠️  No MIDI output matching "${MIDI_OUT}" found — creating virtual port "LTC to MTC".`);
        console.log(`   (server.js looks for "IAC Driver"/"Bus 1"; enable an IAC bus and set MIDI_OUT to use it.)`);
        output.openVirtualPort('LTC to MTC');
    }
    return output;
}

// ---------------------------------------------------------------------------
// De-interleave the LTC channel and feed it to the decoder.
// ---------------------------------------------------------------------------
const decoder = new LTCDecoder(SAMPLE_RATE, FPS, 's16');
const frameBytes = CHANNELS * 2;   // interleaved S16 sample-frame
let residual = Buffer.alloc(0);
let currentRate = resolveFps(FPS, false);

const output = openMidiOutput();
const mtc = new MtcSender(output, currentRate);
mtc.start();

let lastLogged = '';

function processAudio(chunk) {
    const buf = residual.length ? Buffer.concat([residual, chunk]) : chunk;
    const nFrames = Math.floor(buf.length / frameBytes);
    const usable = nFrames * frameBytes;

    // Pull just the LTC channel into a mono S16 buffer.
    const mono = Buffer.allocUnsafe(nFrames * 2);
    for (let i = 0; i < nFrames; i++) {
        const sample = buf.readInt16LE(i * frameBytes + LTC_CHANNEL * 2);
        mono.writeInt16LE(sample, i * 2);
    }
    residual = buf.subarray(usable);

    decoder.write(mono);

    let f;
    while ((f = decoder.read()) !== undefined) {
        // Track drop-frame straight from the signal; update the rate if it changed.
        const rate = resolveFps(FPS, f.drop_frame_format);
        if (rate.rateCode !== currentRate.rateCode) {
            currentRate = rate;
            mtc.setRate(rate);
        }

        const tc = { h: f.hours, m: f.minutes, s: f.seconds, f: f.frames };
        mtc.updateTimecode(tc);

        const line = `${String(tc.h).padStart(2,'0')}:${String(tc.m).padStart(2,'0')}:${String(tc.s).padStart(2,'0')}:${String(tc.f).padStart(2,'0')} @ ${rate.label}${f.reverse ? ' (reverse)' : ''}`;
        if (line !== lastLogged) { process.stdout.write(`\r⏱  ${line}   `); lastLogged = line; }
    }
}

// ---------------------------------------------------------------------------
// Capture audio via ffmpeg / avfoundation (or a custom command).
// ---------------------------------------------------------------------------
function startCapture() {
    let child;
    if (CAPTURE_CMD) {
        console.log(`🎙  Capture via custom command: ${CAPTURE_CMD}`);
        child = spawn('sh', ['-c', CAPTURE_CMD]);
    } else {
        const args = [
            '-hide_banner', '-loglevel', 'error',
            '-f', 'avfoundation',
            '-i', `:${AUDIO_INPUT}`,          // ":n" = audio-only input n
            '-ac', String(CHANNELS),
            '-ar', String(SAMPLE_RATE),
            '-f', 's16le',                    // raw interleaved PCM to stdout
            '-'
        ];
        console.log(`🎙  Capturing: ffmpeg ${args.join(' ')}`);
        console.log(`   Decoding LTC on channel ${LTC_CHANNEL} @ ${FPS} fps → MTC`);
        child = spawn('ffmpeg', args);
    }

    child.stdout.on('data', processAudio);
    child.stderr.on('data', d => process.stderr.write(`[capture] ${d}`));

    child.on('error', err => {
        if (err.code === 'ENOENT') {
            console.error(`\n❌ '${CAPTURE_CMD ? 'sh' : 'ffmpeg'}' not found. Install ffmpeg:  brew install ffmpeg\n`);
        } else {
            console.error('\n❌ Capture process error:', err.message);
        }
    });

    child.on('exit', (code, signal) => {
        console.error(`\n⚠️  Capture exited (code=${code}, signal=${signal}). Restarting in 2s...`);
        residual = Buffer.alloc(0);
        setTimeout(startCapture, 2000);
    });

    return child;
}

console.log('\n==================================================');
console.log('🔁 LTC → MTC converter online');
console.log('==================================================\n');
startCapture();

process.on('SIGINT', () => {
    console.log('\n👋 Stopping...');
    mtc.stop();
    try { output.closePort(); } catch (_) {}
    process.exit(0);
});
