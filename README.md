# Timecode Countdown Monitor

A LAN dashboard that displays live SMPTE-style timecode as a countdown, with
a progress bar showing time remaining. Devices on the network connect to a
web page over WebSocket and see the numbers update in real time.

There are three variants in this repo, for three different ways of getting
timecode into the server:

| Folder | Timecode source | Runs on |
|---|---|---|
| [`mac-mtc-local`](./mac-mtc-local) | MTC over local/virtual MIDI (e.g. IAC Driver) | macOS |
| [`linux-ltc-audio-vm`](./linux-ltc-audio-vm) | LTC audio straight off a USB interface | Linux VM/LXC (e.g. Proxmox) |
| [`linux-network-mtc-vm`](./linux-network-mtc-vm) | MTC received over the network (rtpMIDI/AppleMIDI) from a Mac that's converting LTC → MTC | Linux VM |

Each folder is self-contained: its own `server.js`, `index.html`,
`package.json`, and (where relevant) a systemd unit and install script.
Pick the one that matches your setup — see that folder's README for exact
setup steps.

## Common to all three

- Node.js server (`server.js`) serves `index.html` and streams timecode to
  connected browsers over WebSocket.
- `index.html` renders large H:M:S digits that turn green while running and
  red when paused, plus (in the countdown-aware variants) a progress bar.
- Open `http://<host-ip>:8085` from any device on the LAN to view it.
