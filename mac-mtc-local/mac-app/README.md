# LTC → MTC (macOS app)

A double-clickable Mac app that reads **LTC timecode from a USB audio input**,
re-transmits it as **MTC** on a MIDI port, **and** serves the countdown
dashboard to any device on your LAN — all in one app, no separate `server.js`
and no IAC loopback required.

No Terminal for daily use, and no Homebrew / Xcode tools for the person running
the app: **ffmpeg is bundled**, the **LTC decoder is pure JavaScript** (no
`libltc`), and MIDI uses a prebuilt module. You build the `.app` once; after
that it lives in your Applications folder / dock and opens on double-click.

```
                                   ┌─→ MIDI out (IAC / virtual) → QLab · DAW · consoles
USB audio (LTC) → [ LTC → MTC.app ]┤
                                   └─→ LAN dashboard (http://<mac-ip>:8085) → phones · tablets · displays
```

The LAN dashboard is the same countdown + progress-bar page as the rest of the
repo; the app hosts it directly and streams timecode to it over WebSocket. MIDI
out is optional — the dashboard works even with no MIDI port selected.

---

## Build the app (one time)

You need [Node.js](https://nodejs.org) installed to *build*. The person using
the finished app does not.

```bash
cd mac-mtc-local/mac-app
npm install
npm run geticon      # optional: nice dock icon (skips gracefully if it can't)
npm run dist
```

`npm run dist` produces **`dist/LTC to MTC-1.0.0.dmg`** (universal:
Apple-Silicon + Intel). Open the DMG, drag **LTC to MTC** to Applications, done.

> First launch on another Mac: because the app isn't code-signed, right-click →
> **Open** once to get past Gatekeeper (or `xattr -dr com.apple.quarantine "/Applications/LTC to MTC.app"`).
> To distribute widely, sign & notarize with an Apple Developer ID.

### Just want to try it without building a DMG?

```bash
npm install
npm start
```

That runs the exact same app in a dev window.

---

## Using it

1. Launch the app. Grant **microphone/audio** permission when macOS asks
   (that's how it reads the audio input).
2. Pick your **Audio input** (your USB interface), set **Channels** and the
   **LTC channel** (0-indexed — which input carries LTC).
3. Leave **Frame rate** on **Auto** (it reads the rate, incl. drop-frame, from
   the signal) or pin it.
4. Choose the **MIDI output**. For the dashboard, enable an **IAC Driver** bus
   in *Audio MIDI Setup → MIDI Studio* and select it. If nothing matches, the
   app creates a virtual **"LTC to MTC"** port you can target instead.
5. Nudge **Input gain** up if the level meter is low / it won't lock.
6. Hit **Start**. The readout turns green and shows **Locked** with live
   timecode once LTC is present.
7. **Open the LAN dashboard**: click **Open** in the Dashboard panel to view it
   locally, or point phones/tablets/displays at the shown
   `http://<mac-ip>:8085` address (tap **Copy LAN link** to share it). A bare
   full-screen view lives at `http://<mac-ip>:8085/minimal`. The panel shows how
   many viewers are connected. Change the **Port** if 8085 is taken.

Settings are remembered between launches.

---

## How it works

- **Audio capture** — bundled `ffmpeg-static` via avfoundation, raw S16LE to stdout.
- **LTC decode** — `ltc-decoder.js`, a dependency-free biphase-mark decoder
  ported from SuperTimecodeConverter's `LtcInput.h`. Verified end-to-end by
  `npm test` (synthesises LTC audio and decodes it back at 30 / 25 / 29.97 DF).
- **MTC generate** — `mtc-sender.js`: quarter-frame stream at 4× frame rate plus
  full-frame SysEx on start/seek/resume, ported from `MtcOutput.h`. Every byte
  is sent to both the MIDI port and the dashboard.
- **LAN dashboard** — a built-in HTTP server hosts the countdown pages and a
  WebSocket streams the MTC bytes; the pages reconstruct timecode client-side,
  exactly as in the standalone `server.js`.

## Files

- `main.js` — Electron main: capture, decode, MIDI out, dashboard server, settings, IPC.
- `preload.js` — safe IPC bridge to the settings UI.
- `renderer/` — the settings window (HTML/CSS/JS).
- `dashboard/` — the LAN pages served to viewers (`index.html`, `minimal.html`).
- `ltc-decoder.js` — pure-JS LTC decoder.
- `mtc-sender.js` — MTC quarter-frame / full-frame generator.
- `test-decoder.js` — self-contained decoder test (`npm test`).
- `make-icon.sh` — generates `build/icon.icns`.
