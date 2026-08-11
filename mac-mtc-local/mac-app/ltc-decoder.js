// ============================================================================
// ltc-decoder.js — pure-JavaScript Linear Timecode (LTC) decoder
// ============================================================================
//
// A dependency-free port of the biphase-mark LTC decoder in
// fiverecords/SuperTimecodeConverter (LtcInput.h, MIT).  Feed it mono signed
// 16-bit PCM samples; it calls onFrame({hours,minutes,seconds,frames,drop,
// reverse,fps}) each time it locks a valid SMPTE frame.
//
// Removing the native `libltc` dependency is what lets the Mac app build and
// install with no Xcode command-line tools.
// ============================================================================

const LTC_SYNC_WORD = 0xBFFC;           // 16-bit sync pattern (bits 64-79 of the frame)
const MASK64 = (1n << 64n) - 1n;

class LtcDecoder {
    // sampleRate: audio sample rate (Hz)
    // onFrame:    callback invoked with a decoded frame object
    constructor(sampleRate, onFrame) {
        this.sampleRate = sampleRate;
        this.onFrame = onFrame || (() => {});
        this.gain = 1.0;
        this.threshold = 0.05 * 32768;  // hysteresis threshold in int16 domain
        this.peak = 0;                  // |sample| peak since last read, for a level meter
        this.reset();
    }

    setGain(g) { this.gain = g; }

    // Peak input level (0..1) since the previous call; resets on read.
    readPeak() {
        const p = this.peak / 32768;
        this.peak = 0;
        return p > 1 ? 1 : p;
    }

    reset() {
        this.signalHigh = false;
        this.samplesSinceEdge = 0;
        this.halfBitPending = false;
        this.firstEdgeAfterReset = true;
        this.shiftRegLow = 0n;          // 64 data bits (BigInt)
        this.shiftRegHigh = 0;          // 16-bit sync register
        this.samplesSinceLastSync = 0;
        this.consecutiveGoodFrames = 0;
        this.detectedFps = null;
        // ~27fps midpoint minimises convergence time across 24-30 fps
        this.bitPeriodEstimate = this.sampleRate / 2160.0;
    }

    // --- Core: process a block of mono int16 samples --------------------------
    // samples: Int16Array (or any array-like of int16 values)
    process(samples) {
        const gain = this.gain;
        const thr = this.threshold;
        for (let i = 0; i < samples.length; i++) {
            const sample = samples[i] * gain;
            const a = sample < 0 ? -sample : sample;
            if (a > this.peak) this.peak = a;

            this.samplesSinceEdge++;
            this.samplesSinceLastSync++;

            let edge = false;
            if (this.signalHigh) {
                if (sample < -thr) { this.signalHigh = false; edge = true; }
            } else {
                if (sample > thr)  { this.signalHigh = true;  edge = true; }
            }

            if (edge) {
                this._onEdge(this.samplesSinceEdge);
                this.samplesSinceEdge = 0;
            }
        }
    }

    // --- Biphase-mark edge timing → bits -------------------------------------
    _onEdge(intervalSamples) {
        if (this.firstEdgeAfterReset) { this.firstEdgeAfterReset = false; return; }

        const interval = intervalSamples;
        const halfBit = this.bitPeriodEstimate * 0.5;
        const threshold = this.bitPeriodEstimate * 0.75;

        if (interval < halfBit * 0.4 || interval > this.bitPeriodEstimate * 1.8) {
            this.halfBitPending = false;   // out of range — resync
            return;
        }

        if (interval < threshold) {
            if (this.halfBitPending) {
                this._pushBit(1);
                this.halfBitPending = false;
                const measured = interval * 2.0;
                this.bitPeriodEstimate = this.bitPeriodEstimate * 0.95 + measured * 0.05;
            } else {
                this.halfBitPending = true;
            }
        } else {
            if (this.halfBitPending) this.halfBitPending = false;
            this._pushBit(0);
            this.bitPeriodEstimate = this.bitPeriodEstimate * 0.95 + interval * 0.05;
        }
    }

    // --- 80-bit shift register + sync detection ------------------------------
    _pushBit(bit) {
        const spill = BigInt(this.shiftRegHigh & 1) << 63n;
        this.shiftRegLow = ((this.shiftRegLow >> 1n) | spill) & MASK64;
        this.shiftRegHigh = ((this.shiftRegHigh >> 1) | ((bit & 1) << 15)) & 0xFFFF;
        if (this.shiftRegHigh === LTC_SYNC_WORD) this._onSync();
    }

    _onSync() {
        const d = this.shiftRegLow;
        const nib = (shift, mask) => Number((d >> shift) & mask);

        const frameUnits = nib(0n,  0x0Fn);
        const frameTens  = nib(8n,  0x03n);
        const dropFrame  = Number((d >> 10n) & 1n) !== 0;
        const secUnits   = nib(16n, 0x0Fn);
        const secTens    = nib(24n, 0x07n);
        const minUnits   = nib(32n, 0x0Fn);
        const minTens    = nib(40n, 0x07n);
        const hourUnits  = nib(48n, 0x0Fn);
        const hourTens   = nib(56n, 0x03n);

        const frames  = frameTens * 10 + frameUnits;
        const seconds = secTens   * 10 + secUnits;
        const minutes = minTens   * 10 + minUnits;
        const hours   = hourTens  * 10 + hourUnits;

        if (hours > 23 || minutes > 59 || seconds > 59 || frames > 29) {
            this.consecutiveGoodFrames = 0;
            this.samplesSinceLastSync = 0;
            return;
        }

        // Frame-rate detection from inter-sync period (only when gap is sane)
        let fps = this.detectedFps;
        if (this.samplesSinceLastSync > 0 &&
            this.samplesSinceLastSync < this.sampleRate * 2.0) {
            const measuredFps = this.sampleRate / this.samplesSinceLastSync;
            let detected;
            if (measuredFps < 24.5)      detected = 24;
            else if (measuredFps < 27.0) detected = 25;
            else if (dropFrame)          detected = 29.97;
            else                         detected = 30;

            this.consecutiveGoodFrames++;
            if (this.consecutiveGoodFrames >= 3) {
                this.detectedFps = detected;
                fps = detected;
            }
        } else {
            this.consecutiveGoodFrames = 1;
        }

        this.samplesSinceLastSync = 0;

        this.onFrame({
            hours, minutes, seconds, frames,
            drop: dropFrame,
            fps: fps,                    // null until locked (>=3 good frames)
        });
    }
}

module.exports = { LtcDecoder };
