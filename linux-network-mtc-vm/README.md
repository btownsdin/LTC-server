# linux-network-mtc-vm

For this chain:

```
Audio interface (LTC in) -> Mac (converts LTC -> MTC) -> Network MIDI
   -> Linux VM (rtpmidid receives it, exposes as an ALSA port)
   -> this server.js -> dashboard with countdown progress bar
```

The Mac does the LTC→MTC conversion and broadcasts it via
**Audio MIDI Setup → MIDI Studio → Network**. The Linux VM runs
[rtpmidid](https://github.com/davidmoreno/rtpmidid), which discovers that
session over mDNS/Bonjour and exposes it as a normal ALSA sequencer port —
which this server reads via `node-midi`, exactly like a local MIDI port.

## Setup

On the VM, as root:

```bash
mkdir -p /opt/timecode
# copy server.js, index.html, package.json, timecode.service into /opt/timecode
bash install-vm.sh
```

This installs Node, ALSA tools, Avahi (mDNS), and `rtpmidid`; enables the
ALSA sequencer kernel module persistently; enables the `rtpmidid` and
`timecode` systemd services (the latter `Requires=` the former).

On the Mac: enable/create a session under **Audio MIDI Setup → MIDI
Studio → Network**, and point your LTC→MTC source's MIDI output at it.
The VM should appear automatically via Bonjour; if it doesn't, add it by
IP address directly in that same Network MIDI panel.

## Verifying the connection

```bash
aconnect -i                  # lists ALSA MIDI ports rtpmidid exposed
journalctl -u timecode -f    # watch for incoming MTC frames
```

If the auto-matching in `server.js` doesn't pick the right port (it looks
for names containing `Network`, `rtpmidid`, `RTP`, `Timecode`, or `MTC`),
copy the exact port name from `aconnect -i` into `MIDI_PORT_NAME=` in
`timecode.service` and restart.

## Network requirements

- VM's network adapter must be **bridged** (its own LAN IP, not NAT) so
  the Mac can open a session to it.
- If a firewall is active on the VM, allow UDP 5004/5005 (RTP-MIDI) and
  UDP 5353 (mDNS).

## Progress bar

Same countdown logic as `mac-mtc-local`: the peak value is captured once
playback starts, confirmed on the first decrease, then used as the total
run time for the progress bar. See that folder's README for the full
behavior notes (re-arming, manual reset with **R**, etc.) — the logic is
identical here.

## Files

- `server.js` — reads MTC from the rtpmidid-exposed ALSA port, broadcasts over WebSocket.
- `index.html` — dashboard UI, MTC parsing, and the countdown progress bar.
- `package.json` — dependencies (`midi`, `ws`).
- `install-vm.sh` — installs rtpmidid + Node app + systemd services.
- `timecode.service` — systemd unit for the Node server; depends on `rtpmidid.service`.
