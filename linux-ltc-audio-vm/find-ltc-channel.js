// Scans every capture channel of the interface and reports which one carries LTC.
// Usage (inside the container):
//   AUDIO_DEV=plughw:CARD=USB,DEV=0 CHANNELS=18 FPS=29.97 node find-ltc-channel.js
const { spawn } = require('child_process');
const { LTCDecoder } = require('libltc-wrapper');

const AUDIO_DEV   = process.env.AUDIO_DEV   || 'plughw:CARD=USB,DEV=0';
const SAMPLE_RATE = parseInt(process.env.SAMPLE_RATE || '48000', 10);
const CHANNELS    = parseInt(process.env.CHANNELS || '18', 10);
const FPS         = parseFloat(process.env.FPS || '29.97');
const SECONDS     = parseInt(process.env.SCAN_SECONDS || '4', 10);
const CAPTURE_CMD = process.env.CAPTURE_CMD || null;

const decoders = Array.from({ length: CHANNELS }, () => new LTCDecoder(SAMPLE_RATE, FPS, 's16'));
const counts   = new Array(CHANNELS).fill(0);
const last     = new Array(CHANNELS).fill(null);
const frameBytes = CHANNELS * 2;
let residual = Buffer.alloc(0);

function onAudio(chunk) {
    const buf = residual.length ? Buffer.concat([residual, chunk]) : chunk;
    const n = Math.floor(buf.length / frameBytes);
    const mono = Array.from({ length: CHANNELS }, () => Buffer.allocUnsafe(n * 2));
    for (let i = 0; i < n; i++) {
        const base = i * frameBytes;
        for (let c = 0; c < CHANNELS; c++) {
            mono[c].writeInt16LE(buf.readInt16LE(base + c * 2), i * 2);
        }
    }
    residual = buf.subarray(n * frameBytes);
    for (let c = 0; c < CHANNELS; c++) {
        decoders[c].write(mono[c]);
        let f;
        while ((f = decoders[c].read()) !== undefined) { counts[c]++; last[c] = f; }
    }
}

const fmt = f => `${String(f.hours).padStart(2,'0')}:${String(f.minutes).padStart(2,'0')}:` +
                 `${String(f.seconds).padStart(2,'0')}:${String(f.frames).padStart(2,'0')}` +
                 (f.drop_frame_format ? ' (drop-frame)' : '');

console.log(`Scanning ${CHANNELS} channels on ${AUDIO_DEV} for ${SECONDS}s @ ${FPS} fps...\n`);

let child;
if (CAPTURE_CMD) {
    child = spawn('sh', ['-c', CAPTURE_CMD]);
} else {
    child = spawn('arecord', ['-D', AUDIO_DEV, '-f', 'S16_LE', '-c', String(CHANNELS),
                              '-r', String(SAMPLE_RATE), '-t', 'raw', '-d', String(SECONDS), '-q']);
}
child.stdout.on('data', onAudio);
child.stderr.on('data', d => process.stderr.write(`[arecord] ${d}`));
child.on('error', e => {
    if (e.code === 'ENOENT') console.error("\n'arecord' not found: sudo apt-get install alsa-utils\n");
    else console.error('capture error:', e.message);
});
child.on('exit', () => {
    const found = counts.map((c, i) => ({ i, c })).filter(x => x.c > 0).sort((a, b) => b.c - a.c);
    if (!found.length) {
        console.log('No LTC decoded on any channel.');
        console.log('Check: is the source running? gain high enough? correct AUDIO_DEV/CHANNELS?');
        process.exit(1);
    }
    for (const { i, c } of found) {
        console.log(`\u2714 channel ${i}  (physical input ${i + 1}):  ${fmt(last[i])}   [${c} frames]`);
    }
    const best = found[0].i;
    console.log(`\n\u27a4 Set  LTC_CHANNEL=${best}  in timecode.service`);
    process.exit(0);
});
