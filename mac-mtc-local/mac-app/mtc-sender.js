// ============================================================================
// mtc-sender.js — MIDI Time Code generator
// ============================================================================
// Emits continuous quarter-frame messages plus a full-frame SysEx on
// start/seek/resume. Ported from fiverecords/SuperTimecodeConverter
// (MtcOutput.h / TimecodeCore.h, MIT); single-threaded for Node/Electron.
//
// Construct with a `send(bytesArray)` function (e.g. midiOutput.sendMessage).
// ============================================================================

function resolveFps(fpsValue, dropDetected) {
    const near = (a, b) => Math.abs(a - b) < 0.02;
    const DF = { num: 30000 / 1001, maxFrames: 30, rateCode: 2, drop: true, label: '29.97 DF' };
    if (near(fpsValue, 25))     return { num: 25.0,         maxFrames: 25, rateCode: 1, drop: false, label: '25' };
    if (near(fpsValue, 24))     return { num: 24.0,         maxFrames: 24, rateCode: 0, drop: false, label: '24' };
    if (near(fpsValue, 23.976)) return { num: 24000 / 1001, maxFrames: 24, rateCode: 0, drop: false, label: '23.976' };
    if (near(fpsValue, 29.97))  return DF;
    if (dropDetected)           return DF;
    return                             { num: 30.0,         maxFrames: 30, rateCode: 3, drop: false, label: '30' };
}

function incrementFrame(tc, rate) {
    const max = rate.maxFrames;
    const r = { h: tc.h, m: tc.m, s: tc.s, f: tc.f };
    if (r.f < 0) r.f = 0;
    if (r.f >= max) r.f = max - 1;
    if (r.s < 0 || r.s >= 60) r.s = 0;
    if (r.m < 0 || r.m >= 60) r.m = 0;
    if (r.h < 0 || r.h >= 24) r.h = 0;
    r.f++;
    if (r.f >= max) { r.f = 0; r.s++; }
    if (r.s >= 60)  { r.s = 0; r.m++; }
    if (r.m >= 60)  { r.m = 0; r.h++; }
    if (r.h >= 24)  { r.h = 0; }
    if (rate.drop && r.f === 0 && r.s === 0 && (r.m % 10) !== 0) r.f = 2;
    return r;
}

function tcToFrameCount(tc, max) {
    return tc.h * 3600 * max + tc.m * 60 * max + tc.s * max + tc.f;
}

class MtcSender {
    constructor(send, rate) {
        this.send = send;
        this.rate = rate;
        this.pending = { h: 0, m: 0, s: 0, f: 0 };
        this.cycle   = { h: 0, m: 0, s: 0, f: 0 };
        this.qfIndex = 0;
        this.seeded = false;
        this.running = false;
        this.qfInterval = 1000.0 / (rate.num * 4.0);
        this.nextQfTime = 0;
        this.timer = null;
        this.lastFrameMs = 0;
        this.SOURCE_TIMEOUT_MS = 150;
    }

    setRate(rate) {
        this.rate = rate;
        this.qfInterval = 1000.0 / (rate.num * 4.0);
    }

    updateTimecode(tc) {
        this.pending = tc;
        this.lastFrameMs = performance.now();
        if (!this.running) {
            this.running = true;
            this.seeded = false;
            this.qfIndex = 0;
            this.sendFullFrame();
            this.nextQfTime = performance.now() + this.qfInterval;
            this._schedule();
        }
    }

    start() { this.running = false; this.seeded = false; this.qfIndex = 0; }

    stop() {
        this.running = false;
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    }

    isRunning() { return this.running; }

    sendFullFrame() {
        const tc = this.pending;
        if (tc.h > 23 || tc.m > 59 || tc.s > 59 || tc.f >= this.rate.maxFrames) return;
        const hr = (tc.h & 0x1F) | (this.rate.rateCode << 5);
        this.send([0xF0, 0x7F, 0x7F, 0x01, 0x01, hr, tc.m, tc.s, tc.f, 0xF7]);
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
        this.send([0xF1, dataByte]);
    }

    _schedule() {
        const tick = () => {
            if (!this.running) return;
            const now = performance.now();

            if (now - this.lastFrameMs > this.SOURCE_TIMEOUT_MS) {
                this.running = false;   // source went quiet — pause; resumes on next frame
                this.timer = null;
                return;
            }

            let guard = 0;
            while (now >= this.nextQfTime && guard < 2) {
                if (this.qfIndex === 0) {
                    if (!this.seeded) {
                        this.cycle = { ...this.pending };
                        this.seeded = true;
                    } else {
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

            if (performance.now() - this.nextQfTime > 50) this.nextQfTime = performance.now();
            const delay = Math.max(0, this.nextQfTime - performance.now());
            this.timer = setTimeout(tick, delay);
        };
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(tick, Math.max(0, this.nextQfTime - performance.now()));
    }
}

module.exports = { MtcSender, resolveFps, incrementFrame };
