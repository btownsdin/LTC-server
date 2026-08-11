// Generate synthetic biphase-mark LTC audio for a known timecode, feed it to
// the pure-JS decoder, and confirm it recovers the same timecode + fps.
const { LtcDecoder } = require('./ltc-decoder');

const SR = 48000;
const AMP = 8000;

// Build the 80-bit LTC frame for h:m:s:f (bit index k = frame bit k).
function buildFrame(h, m, s, f, drop) {
    const bits = new Array(80).fill(0);
    const setNibble = (start, width, val) => {
        for (let i = 0; i < width; i++) bits[start + i] = (val >> i) & 1;
    };
    // BCD fields at the offsets the decoder reads
    setNibble(0,  4, f % 10);
    setNibble(8,  2, Math.floor(f / 10));
    bits[10] = drop ? 1 : 0;
    setNibble(16, 4, s % 10);
    setNibble(24, 3, Math.floor(s / 10));
    setNibble(32, 4, m % 10);
    setNibble(40, 3, Math.floor(m / 10));
    setNibble(48, 4, h % 10);
    setNibble(56, 2, Math.floor(h / 10));
    // Sync word: bits 64..79 pack (LSB=bit64) to 0xBFFC
    for (let i = 0; i < 16; i++) bits[64 + i] = (0xBFFC >> i) & 1;
    return bits;
}

// Biphase-mark encode one frame's 80 bits into int16 samples.
function encodeFrame(bits, samplesPerBit, state) {
    const out = [];
    const half = Math.round(samplesPerBit / 2);
    for (const bit of bits) {
        state.level = -state.level;             // transition at every bit boundary
        if (bit === 1) {
            for (let i = 0; i < half; i++) out.push(state.level * AMP);
            state.level = -state.level;         // mid-bit transition = '1'
            for (let i = 0; i < samplesPerBit - half; i++) out.push(state.level * AMP);
        } else {
            for (let i = 0; i < samplesPerBit; i++) out.push(state.level * AMP);
        }
    }
    return out;
}

function run(fps, drop, start, nFrames = 12) {
    const samplesPerBit = SR / (fps * 80);
    const state = { level: 1 };
    const decoded = [];
    const dec = new LtcDecoder(SR, fr => decoded.push(fr));

    // Emit nFrames consecutive frames counting up from `start`, exactly like a
    // continuous LTC feed (the decoder needs a few frames of preroll to lock).
    let { h, m, s, f } = start;
    const maxF = drop ? 30 : Math.round(fps);
    const emitted = [];
    for (let n = 0; n < nFrames; n++) {
        emitted.push({ h, m, s, f });
        const audio = encodeFrame(buildFrame(h, m, s, f, drop), samplesPerBit, state);
        dec.process(Int16Array.from(audio));
        f++; if (f >= maxF) { f = 0; s++; }
        if (s >= 60) { s = 0; m++; }
    }
    return { decoded, emitted, dec };
}

function tcEq(a, b) {
    return a.hours === b.h && a.minutes === b.m && a.seconds === b.s && a.frames === b.f;
}

let pass = 0, fail = 0;
function check(label, got, want) {
    const ok = got === want;
    console.log(`${ok ? '✓' : '✗'} ${label}: got ${got}, want ${want}`);
    ok ? pass++ : fail++;
}

// Verify the tail of the decoded stream exactly matches the tail of the
// emitted stream (skips the first couple of startup frames, as real gear does).
function checkStreamMatches(label, decoded, emitted, skip = 3) {
    // decoded[i] corresponds to emitted[i] (decode happens once per frame, in
    // order). The first few may be corrupt during lock; assert on the rest.
    let matched = 0, total = 0;
    for (let i = skip; i < decoded.length; i++) {
        total++;
        if (tcEq(decoded[i], emitted[i])) matched++; else break;
    }
    check(`${label} settled frames match (of ${total})`, matched, total);
}

// --- 30 fps non-drop ---
{
    const { decoded, emitted } = run(30, false, { h: 10, m: 20, s: 30, f: 15 });
    console.log(`\n30fps: decoded ${decoded.length}, last =`, decoded[decoded.length - 1]);
    check('30fps h', decoded[decoded.length - 1].hours, 10);
    check('30fps m', decoded[decoded.length - 1].minutes, 20);
    check('30fps locked fps', decoded[decoded.length - 1].fps, 30);
    checkStreamMatches('30fps', decoded, emitted);
}

// --- 25 fps, crossing a second boundary ---
{
    const { decoded, emitted } = run(25, false, { h: 1, m: 2, s: 3, f: 22 });
    console.log(`\n25fps: decoded ${decoded.length}, last =`, decoded[decoded.length - 1]);
    check('25fps locked fps', decoded[decoded.length - 1].fps, 25);
    // Confirm a second rollover happened somewhere in the settled stream
    const sawRollover = decoded.some(d => d.seconds === 4 && d.frames === 0);
    check('25fps second rollover 03→04', sawRollover, true);
    checkStreamMatches('25fps', decoded, emitted);
}

// --- 29.97 drop-frame flag ---
{
    const { decoded, emitted } = run(29.97, true, { h: 0, m: 5, s: 10, f: 0 });
    console.log(`\n29.97df: decoded ${decoded.length}, last =`, decoded[decoded.length - 1]);
    check('29.97 drop flag', decoded[decoded.length - 1].drop, true);
    check('29.97 locked fps', decoded[decoded.length - 1].fps, 29.97);
    checkStreamMatches('29.97df', decoded, emitted);
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
