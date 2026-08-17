# LTC → MTC (macOS app)

A double-clickable Mac app that reads **LTC timecode from a USB audio input**,
re-transmits it as **MTC** on a MIDI port, **and** serves the countdown
dashboard to any device on your LAN — all in one app, no separate `server.js`
and no IAC loopback required.

No Terminal for daily use, and no Homebrew, ffmpeg, or `libltc` to install: the
app captures the audio input in-process (Web Audio) and the **LTC decoder is
pure JavaScript**, so there's nothing to compile or download at runtime. You
build the `.app` once; after that it lives in your Applications folder / dock
and opens on double-click.

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

## Clean rebuild recipe (copy/paste)

The full, known-good sequence to build, ad-hoc sign (so it runs without an Apple
Developer ID *and* keeps microphone access), install, and launch — on any Mac
with Node. Works on both Apple Silicon and Intel (universal build).

```bash
git clone https://github.com/btownsdin/LTC-server.git   # or: cd LTC-server && git pull
cd LTC-server/mac-mtc-local/mac-app
npm install
npm run dist
npm run sign "dist/mac-universal/LTC to MTC.app"
rm -rf "/Applications/LTC to MTC.app"
cp -R "dist/mac-universal/LTC to MTC.app" /Applications/
open "/Applications/LTC to MTC.app"
```

- Use whatever folder `ls dist/` actually shows (`mac-universal`, `mac-arm64`,
  or `mac-x64`) in the `sign`/`cp` lines.
- Sign with `npm run sign` — **never** a plain `codesign --deep --sign -`, which
  strips the mic entitlement and stops the app from ever prompting for the
  microphone.
- Copying the built `.app` to another Mac? Clear quarantine there once:
  `xattr -dr com.apple.quarantine "/Applications/LTC to MTC.app"`.
- Running from source in dev instead of building? Use `npm run dev` (it ad-hoc
  signs Electron first so Gatekeeper doesn't trash it).

## Operational gotchas

- **LTC must be on a low channel.** Capture only sees the first couple of
  channels macOS exposes for a device. On a multi-channel interface (e.g.
  Focusrite Scarlett 18i20), route the LTC input to channel 1 in the interface's
  mixer (Focusrite Control), then set **LTC channel** to 0 in the app. LTC on a
  high channel (3, 4, …) won't be seen even though other apps can see it.
- **Run one copy at a time.** The dashboard binds port 8085. A second instance
  auto-moves to 8086 (and 8087, …) rather than crashing — so if the dashboard
  looks wrong, check which port that instance actually bound.
- **First launch asks for the microphone** — approve it. It appears in System
  Settings → Privacy & Security → Microphone as "LTC to MTC" (packaged) or
  "Electron" (dev). If it ever stops prompting: `tccutil reset Microphone com.local.ltctomtc`.
- **Managed/corporate Macs** with endpoint security (CrowdStrike, SentinelOne,
  Jamf Protect) may block or trash the unsigned app regardless of the steps
  above — in that case, have IT whitelist it, or run from source with `npm run dev`.

---

## Using it

1. Launch the app and press **Start** the first time — macOS shows the
   **microphone** prompt (that's how it reads the audio input). Click **Allow**.
   The device list fills in with real names once access is granted.
2. Pick your **Audio input** (your USB interface), set **Channels** and the
   **LTC channel** (0-indexed — which input carries LTC), then Start again.
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

### Tally (TSL 5.0) border

The main dashboard page (`index.html`, not `/minimal`) can frame its edges
with a colored border based on one TSL 5.0 UMD tally source on your LAN —
muted red for program, muted green for preview, red also wins if a source
is in both at once. It's a hard cut with no fade, and it's a border rather
than a full background wash so the countdown text stays exactly as readable
as always. `/minimal` is left alone on purpose, for displays where you just
want the clock with nothing else.

1. In the app, check **Watch a TSL 5.0 tally source**.
2. Set **Port** to whatever UDP port your tally source/vision mixer sends
   UMD data on.
3. Set **Address** to the one tally "INDEX" you want to watch (this is
   whatever address/channel number your tally source assigns to that
   camera/input — check its UMD configuration).
4. Point the tally source's UMD/TSL output at this Mac's LAN IP and that
   port. It only reads TSL 5.0 (UDP); TSL 3.1 isn't supported.

It watches exactly one address — packets for other addresses on the same
feed are ignored. The small dot next to "Tally (TSL 5.0)" in the app shows
the live state (gray = off, green = preview, red = program) so you can
confirm it's receiving before checking the dashboard itself.

---

## Troubleshooting

**"Electron.app … contains malware" / it gets moved to Trash / launch dies with
SIGKILL.** This is *not* real malware — it's Gatekeeper refusing to run the
**unsigned** Electron binary that `npm install` downloads, common on
managed/corporate Macs. Clear quarantine and give Electron an ad-hoc signature
**before** the first launch:

```bash
cd mac-mtc-local/mac-app
rm -rf node_modules/electron          # macOS may have already trashed it
npm install electron@31 --save-dev    # re-download (does not run it)
npm run fix-electron                   # clears quarantine + ad-hoc signs it
npm start
```

Or just `npm run dev`, which runs the fix and launches in one step. Re-run the
fix after any Electron reinstall/update. If it *still* gets killed, your Mac
likely has endpoint security (CrowdStrike / SentinelOne / Jamf Protect) that
removes unsigned apps regardless — build a **signed + notarized** DMG (needs an
Apple Developer ID) or develop on an unmanaged Mac.


**No microphone prompt / empty input list.** The prompt appears when you press
**Start** (that's the getUserMedia call). If you dismissed it before, or you're
running in dev via `npm start`:

1. Open **System Settings → Privacy & Security → Microphone**.
2. Enable the toggle for **LTC to MTC** (packaged app) or **Electron** (dev via
   `npm start`). If it isn't listed, press Start once to make it appear.
3. Quit and reopen, then press Start.

If macOS recorded a silent denial and won't prompt again, reset it once in
Terminal and relaunch: `tccutil reset Microphone`. Device names in the dropdown
stay generic until access is granted, then fill in automatically.

**It runs but never shows "Locked".** The LTC signal isn't decoding. Check the
level meter moves when timecode is playing; if it's low, raise **Input gain**.
Confirm **LTC channel** points at the input actually carrying LTC (it's
0-indexed), and that **Channels** matches your interface.

**Multi-channel interfaces.** macOS audio capture usually exposes the first one
or two channels of a device. If your LTC is on a higher channel that doesn't
show up, route it to input 1 or 2 on the interface, or use a stereo feed with
LTC on left or right. (For deep multi-channel routing, the standalone
`ltc-to-mtc.js` CLI in the folder above uses ffmpeg and can grab any channel.)

## How it works

- **Audio capture** — in the renderer via `getUserMedia` + Web Audio (all DSP
  like echo-cancellation/AGC disabled so the LTC waveform is untouched). No
  ffmpeg, no child process — which is what makes the mic prompt and device list
  behave normally on macOS.
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
