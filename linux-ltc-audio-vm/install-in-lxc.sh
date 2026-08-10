#!/usr/bin/env bash
# Run this INSIDE the LXC container, as root.
# Assumes server.js, index.html, package.json, timecode.service are already
# in /opt/timecode (push them from the host with `pct push`, see the guide).
set -euo pipefail

APP_DIR="/opt/timecode"
export DEBIAN_FRONTEND=noninteractive

echo "==> Installing Node.js, build tools, and ALSA utilities..."
apt-get update
apt-get install -y nodejs npm build-essential python3 pkg-config alsa-utils

echo "==> Node version: $(node --version)"

if [ ! -f "$APP_DIR/server.js" ]; then
  echo "!! $APP_DIR/server.js not found."
  echo "   Copy the app files into $APP_DIR first. From the Proxmox HOST, e.g.:"
  echo "     pct push <CTID> server.js       /opt/timecode/server.js"
  echo "     pct push <CTID> index.html      /opt/timecode/index.html"
  echo "     pct push <CTID> package.json    /opt/timecode/package.json"
  echo "     pct push <CTID> timecode.service /opt/timecode/timecode.service"
  echo "     pct push <CTID> find-ltc-channel.js /opt/timecode/find-ltc-channel.js"
  exit 1
fi

echo "==> Installing npm dependencies (this compiles libltc-wrapper)..."
cd "$APP_DIR"
npm install --omit=dev

echo "==> Installing systemd service..."
install -m 0644 "$APP_DIR/timecode.service" /etc/systemd/system/timecode.service
systemctl daemon-reload
systemctl enable timecode.service

echo
echo "==> Audio capture devices visible in this container:"
arecord -l || echo "   (none found — is the interface plugged into the host and is /dev/snd passed in?)"
echo
echo "Almost done. Now:"
echo "  1. Edit /etc/systemd/system/timecode.service"
echo "     -> set AUDIO_DEV, LTC_CHANNEL and FPS to match the list above."
echo "  2. systemctl restart timecode"
echo "  3. journalctl -u timecode -f      # watch it lock onto the timecode"
