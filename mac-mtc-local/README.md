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

## Files

- `server.js` — HTTP + WebSocket server, reads MTC via `node-midi`, serves both pages on separate ports.
- `index.html` — dashboard UI, MTC parsing, and the countdown progress bar.
- `minimal.html` — bare full-screen MM:SS view, no other text, on its own port.
- `package.json` — dependencies (`midi`, `ws`).
