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

## Files

- `server.js` — HTTP + WebSocket server, reads MTC via `node-midi`.
- `index.html` — dashboard UI, MTC parsing, and the countdown progress bar.
- `package.json` — dependencies (`midi`, `ws`).
