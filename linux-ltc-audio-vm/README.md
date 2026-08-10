# linux-ltc-audio-vm

For when LTC timecode arrives as an **audio** signal directly into a USB
audio interface connected to a Linux VM or LXC container (e.g. on Proxmox).
Captures the interface via ALSA (`arecord`), decodes LTC with the reference
`libltc` library, and serves the countdown dashboard.

> Note: this variant's `index.html` does **not** include the countdown
> progress bar (it predates that feature). If you want it, copy the
> `updateProgress` block from `linux-network-mtc-vm/index.html` — the
> server already sends full `{h,m,s}` per message so the same logic drops in.

## Why a VM/LXC and not passthrough into a full VM audio device

USB audio passthrough into a full VM often produces audio glitches because
of the emulated isochronous USB layer. Running this Node app in a
**privileged LXC container** with `/dev/snd` bind-mounted avoids that
entirely — ALSA runs on the host kernel directly, no USB emulation layer.

## Setup (LXC container)

On the Proxmox **host**, create a privileged container, then add to
`/etc/pve/lxc/<CTID>.conf`:

```
lxc.cgroup2.devices.allow: c 116:* rwm
lxc.mount.entry: /dev/snd dev/snd none bind,optional,create=dir
```

Push the files into the container at `/opt/timecode/`, then inside it:

```bash
bash install-in-lxc.sh
```

This installs Node, ALSA tools, build tools (to compile `libltc-wrapper`),
enables the systemd service, and prints `arecord -l` so you can identify
your interface.

## Finding which channel carries LTC

Don't guess — scan for it:

```bash
AUDIO_DEV=plughw:CARD=USB,DEV=0 CHANNELS=<n> FPS=<fps> node find-ltc-channel.js
```

It captures a few seconds across every channel and reports which one
decodes LTC, e.g. `✔ channel 5 (physical input 6): 01:00:59:20 (drop-frame)`.
Put that index into `LTC_CHANNEL` in `timecode.service`.

## Key environment variables (`timecode.service`)

| Var | Meaning |
|---|---|
| `AUDIO_DEV` | ALSA device, e.g. `plughw:CARD=USB,DEV=0` (from `arecord -l`) |
| `CHANNELS` | total capture channels on the interface |
| `LTC_CHANNEL` | which channel (0-indexed) carries LTC — use the finder above |
| `FPS` | source frame rate, e.g. `30`, `25`, `24`, or `29.97` for drop-frame |
| `SAMPLE_RATE` | capture sample rate, default `48000` |

Drop-frame is auto-detected from the LTC signal itself (the decoder reads
the bit directly) — `FPS` only needs to match closely enough for correct
frame timing.

## Files

- `server.js` — captures audio via `arecord`, decodes LTC via `libltc-wrapper`, broadcasts over WebSocket.
- `index.html` — dashboard UI (consumes `{tc, fps}` messages).
- `find-ltc-channel.js` — one-off utility to identify which channel carries LTC.
- `install-in-lxc.sh` — installs dependencies and the systemd service inside the container.
- `timecode.service` — systemd unit; edit the `Environment=` lines for your hardware.
