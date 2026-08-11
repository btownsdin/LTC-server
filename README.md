# Timecode Countdown Monitor

A LAN dashboard that displays live SMPTE-style timecode as a countdown, with
a progress bar showing time remaining. Devices on the network connect to a
web page over WebSocket and see the numbers update in real time.

There are several variants in this repo, for different ways of getting
timecode into the server:

| Folder | Timecode source | Runs on |
|---|---|---|
| [`mac-mtc-local/mac-app`](./mac-mtc-local/mac-app) ⭐ | **LTC audio off a USB interface** — decodes it, outputs MTC, and serves the dashboard, all in one double-clickable app | macOS |
| [`mac-mtc-local`](./mac-mtc-local) | MTC over local/virtual MIDI (e.g. IAC Driver) | macOS |
| [`linux-ltc-audio-vm`](./linux-ltc-audio-vm) | LTC audio straight off a USB interface | Linux VM/LXC (e.g. Proxmox) |
| [`linux-network-mtc-vm`](./linux-network-mtc-vm) | MTC received over the network (rtpMIDI/AppleMIDI) from a Mac that's converting LTC → MTC | Linux VM |

⭐ **New:** if you just want the simplest possible setup on a Mac with an LTC
audio feed, use [`mac-mtc-local/mac-app`](./mac-mtc-local/mac-app). It's a
self-contained macOS app — no Terminal, no Homebrew, no separate server — that
reads LTC, converts it to MTC (out to IAC/QLab/consoles), and hosts the LAN
dashboard itself. See its [README](./mac-mtc-local/mac-app/README.md) for the
one-time build.

The other three folders are each self-contained the classic way: their own
`server.js`, `index.html`, `package.json`, and (where relevant) a systemd unit
and install script. Pick the one that matches your setup — see that folder's
README for exact setup steps.

## Common to the server variants

- Node.js server (`server.js`) serves `index.html` and streams timecode to
  connected browsers over WebSocket.
- `index.html` renders large H:M:S digits that turn green while running and
  red when paused, plus (in the countdown-aware variants) a progress bar.
- Open `http://<host-ip>:8085` from any device on the LAN to view it.

(The `mac-app` bundles the same dashboard pages and serves them the same way —
it just hosts them from inside the app instead of a standalone `server.js`.)
