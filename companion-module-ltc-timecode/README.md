# companion-module-ltc-timecode

A [Bitfocus Companion](https://bitfocus.io/companion) module that connects to a
[btownsdin/LTC-server](https://github.com/btownsdin/LTC-server) instance over
WebSocket and publishes the live timecode as Companion variables, so you can
put `$(ltctimecode:timecode)` on a button, trigger on `$(ltctimecode:status)`,
or color a button while timecode is running.

This pairs with the small `server.js` patch (see below) that makes
`mac-mtc-local` broadcast decoded timecode instead of raw MIDI bytes.

## Variables

| Variable    | Example      | Description                                |
| ----------- | ------------ | ------------------------------------------- |
| `timecode`  | `01:02:03:04`| Full HH:MM:SS:FF string                     |
| `hours`     | `01`         | Zero-padded hours                           |
| `minutes`   | `02`         | Zero-padded minutes                         |
| `seconds`   | `03`         | Zero-padded seconds                         |
| `frames`    | `04`         | Zero-padded frame count                     |
| `fps`       | `30`         | Frame rate label (`24`, `25`, `29.97d`, `30`)|
| `status`    | `Running`    | `Running`, `Paused`, or `Disconnected`      |

Two feedbacks are also included: **Timecode is running** (green by default)
and **Disconnected from LTC-server** (red by default) — drop either onto a
button to get an at-a-glance status light.

## Requirements

- Companion 5.0+ with `@companion-module/base` v2.x (this module uses the
  current default-export entrypoint style, not the older `runEntrypoint()`
  pattern still shown in some templates/tutorials — if you see `runEntrypoint
  is not a function` in the log, that's a module built for the old API, not
  this one)
- The LTC-server `server.js` must broadcast decoded timecode over its
  WebSocket, i.e. messages shaped like:
  ```json
  { "tc": { "h": 1, "m": 2, "s": 3, "f": 4 }, "fps": "30", "running": true, "timecode": "01:02:03:04" }
  ```
  The `mac-mtc-local/server.js` in this repo already does this (decoding
  happens server-side alongside the existing raw `{ bytes }` broadcast, so
  the dashboards keep working unchanged). If you're running one of the other
  two variants, `linux-ltc-audio-vm` already broadcasts a `tc`/`fps` shape
  and will mostly work as-is; `linux-network-mtc-vm` currently only sends
  raw MIDI bytes and would need the same decode patch ported over.

## Installing into Companion (as a local/dev module)

Companion loads modules from a folder without needing npm publish:

1. `cd companion-module-ltc-timecode && npm install` to pull in
   `@companion-module/base` and `ws`.
2. Open Companion → **Settings → Modules**, enable **Developer modules**,
   and point it at the folder containing this module (the parent folder of
   `companion-module-ltc-timecode`, i.e. wherever you put it on disk).
3. Companion will pick it up as "LTC Timecode Monitor" in the connection
   add list. Add a connection, set:
   - **Server IP / hostname**: the IP of the Mac running `mac-mtc-local`
   - **Port**: `8085` (or whatever `PORT` you set for the server)
4. Once connected, the variables above populate under that connection's
   name (e.g. `$(ltctimecode:timecode)`).

If Companion runs on the *same* Mac as the LTC-server, use `127.0.0.1` for
the host.

## How it works

The module opens a plain WebSocket connection to
`ws://<host>:<port>` — the same port your browser dashboard connects to —
and listens for the decoded timecode messages. It reconnects automatically
every 2 seconds if the connection drops, and marks itself "Disconnected" if
no data has arrived for 5 seconds (e.g. the server process died).

See [HELP.md](./companion/HELP.md) and [LICENSE](./LICENSE).
