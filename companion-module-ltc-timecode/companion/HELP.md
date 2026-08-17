## LTC Timecode Monitor

Connects to a btownsdin/LTC-server instance over WebSocket and exposes its
live timecode as variables: `timecode`, `hours`, `minutes`, `seconds`,
`frames`, `fps`, and `status`.

**Config**

- **Server IP / hostname** — the machine running the LTC-server (e.g. the
  Mac running `mac-mtc-local`).
- **Port** — the server's WebSocket port (default `8085`).

**Feedbacks**

- *Timecode is running* — true while timecode is actively counting.
- *Disconnected from LTC-server* — true while the WebSocket link is down.

See the module's README.md for setup details.
