# mac-mtc-local

Runs directly on macOS. Reads MTC from a local or virtual MIDI port (e.g.
the IAC Driver bus fed by QLab/your DAW) and serves a countdown dashboard
with a progress bar to your LAN.

## Setup

```bash
npm install
npm start
```

By default it looks for a port named `IAC Driver` or `Bus 1`. Make sure
that bus is enabled in **Audio MIDI Setup → MIDI Studio → IAC Driver**,
and that your DAW/QLab is sending MTC to it.

Open `http://localhost:8085` locally, or `http://<mac-ip>:8085` from other
devices on the LAN (the server prints both on startup).

## Minimal full-screen view

A second, bare page — just large MM:SS digits, no title, labels, or status
text — fills the entire screen and is served on its own port (default
`8086`, or `PORT+1`, or set `MINIMAL_PORT` explicitly). It shows the same
live countdown as the main dashboard, with hours folded into the minutes
count (e.g. 1:05:07 remaining displays as `65:07`, not `05:07`). Useful
for a secondary display that needs to be readable from a distance with no
distractions.

Open `http://<mac-ip>:8086` (or `http://localhost:8086`) to view it.

## Progress bar behavior

The countdown total is captured automatically: the first time value seen
once playback starts is treated as the peak/total, confirmed the moment
the value starts decreasing. The bar then fills as time elapses and stays
visible (frozen, turning red) if playback pauses.

- Loading a new, longer countdown re-arms automatically (an upward jump
  is detected).
- Loading a shorter countdown right after a longer one (with no upward
  jump) needs a manual re-arm: click anywhere on the page, or press **R**.
- A count-*up* source will never show a bar — the total can't be known.

## LTC → MTC conversion (from a USB audio source)

If your timecode arrives as **LTC audio** on a USB interface (not as MTC),
`ltc-to-mtc.js` turns this Mac into an LTC→MTC box. It captures the interface,
decodes LTC with the reference `libltc` library, and re-transmits it as MTC
(quarter-frame messages + a full-frame SysEx on start/seek/resume) to a MIDI
output port.

Point it at an IAC Driver bus and the existing `server.js` above picks it up
with no changes — the whole chain runs on one machine:

```
USB audio (LTC) → ltc-to-mtc.js → IAC Driver → server.js → dashboard
```

The same MTC also feeds any other consumer on that port (QLab, a DAW, a
lighting console, etc.).

### Requirements

- **ffmpeg** on your PATH — the audio capture engine: `brew install ffmpeg`
- **Xcode command-line tools** — `libltc-wrapper` is a native addon that
  compiles on install: `xcode-select --install`
- `npm install` (adds `libltc-wrapper` alongside `midi` and `ws`)

### Setup

1. Find your interface's audio index:

   ```bash
   ffmpeg -f avfoundation -list_devices true -i ""
   ```

   Note the `[n]` under **AVFoundation audio devices** for your USB interface.

2. Enable an IAC bus in **Audio MIDI Setup → MIDI Studio → IAC Driver**
   (the same bus `server.js` reads from).

3. Run the converter:

   ```bash
   AUDIO_INPUT=<n> CHANNELS=<n> LTC_CHANNEL=<i> FPS=<fps> npm run convert
   ```

4. In another terminal, start the dashboard as usual: `npm start`.

### Environment variables

| Var | Meaning | Default |
|---|---|---|
| `AUDIO_INPUT` | avfoundation audio device index (from `-list_devices`) | `0` |
| `CHANNELS` | total channels the interface captures | `2` |
| `LTC_CHANNEL` | which channel (0-indexed) carries LTC | `0` |
| `FPS` | source frame rate: `30`, `29.97`, `25`, `24`, `23.976` | `30` |
| `SAMPLE_RATE` | capture sample rate | `48000` |
| `MIDI_OUT` | substring of the MIDI **output** port to send MTC to | `IAC Driver` |
| `CAPTURE_CMD` | override the whole capture command (must emit raw interleaved S16LE PCM to stdout) | — |

Drop-frame is read directly from the LTC signal, so `FPS` only needs to be
close enough for correct frame timing (e.g. leave it at `30` for a 29.97-df
source — the converter switches to the 29.97 rate code automatically). If no
port matches `MIDI_OUT`, the converter creates a virtual MIDI source named
**"LTC to MTC"** you can subscribe to instead.

## Files

- `server.js` — HTTP + WebSocket server, reads MTC via `node-midi`, serves both pages on separate ports.
- `ltc-to-mtc.js` — LTC-audio → MTC converter: captures USB audio via ffmpeg, decodes LTC via `libltc-wrapper`, transmits MTC out a MIDI port.
- `index.html` — dashboard UI, MTC parsing, and the countdown progress bar.
- `minimal.html` — bare full-screen MM:SS view, no other text, on its own port.
- `package.json` — dependencies (`midi`, `ws`).
