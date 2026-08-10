#!/usr/bin/env bash
# Run as root INSIDE the Linux VM. Installs rtpmidid + the Node timecode server.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
APP_DIR="/opt/timecode"

echo "==> Base packages (Node, build tools, ALSA, Avahi for mDNS discovery)..."
apt-get update
apt-get install -y nodejs npm build-essential python3 pkg-config \
                    alsa-utils avahi-daemon libavahi-client3 wget

echo "==> Enabling ALSA sequencer + Avahi (needed for rtpmidid discovery)..."
modprobe snd-seq || true
echo "snd-seq" > /etc/modules-load.d/snd-seq.conf
systemctl enable --now avahi-daemon

echo "==> Installing rtpmidid..."
# Prefer the distro package if present; otherwise grab the latest .deb release.
if apt-cache show rtpmidid >/dev/null 2>&1; then
    apt-get install -y rtpmidid
else
    ARCH=$(dpkg --print-architecture)
    URL=$(wget -qO- https://api.github.com/repos/davidmoreno/rtpmidid/releases/latest \
          | grep "browser_download_url.*${ARCH}.*\.deb" | cut -d '"' -f4 | head -n1)
    if [ -z "$URL" ]; then
        echo "!! Could not auto-find a rtpmidid .deb for arch ${ARCH}."
        echo "   Check https://github.com/davidmoreno/rtpmidid/releases and install manually."
        exit 1
    fi
    wget -O /tmp/rtpmidid.deb "$URL"
    apt-get install -y /tmp/rtpmidid.deb
fi
systemctl enable --now rtpmidid

echo "==> Node app..."
if [ ! -f "$APP_DIR/server.js" ]; then
    echo "!! $APP_DIR/server.js not found. Copy server.js/index.html/package.json"
    echo "   into $APP_DIR first (e.g. scp from your workstation), then re-run this script."
    exit 1
fi
cd "$APP_DIR"
npm install --omit=dev

echo "==> Installing systemd service..."
install -m 0644 "$APP_DIR/timecode.service" /etc/systemd/system/timecode.service
systemctl daemon-reload
systemctl enable timecode.service
systemctl restart timecode.service

echo
echo "==> rtpmidid status:"
systemctl --no-pager status rtpmidid | head -5
echo
echo "==> ALSA MIDI ports currently visible (run again after the Mac connects):"
which aconnect >/dev/null 2>&1 && aconnect -i || true
echo
echo "Next steps:"
echo "  1. On the Mac: Audio MIDI Setup > MIDI Studio > Network, add this VM"
echo "     (or it should appear automatically via Bonjour/mDNS)."
echo "  2. Point your LTC->MTC source's MIDI output at that Network session."
echo "  3. journalctl -u timecode -f     # confirm frames are arriving"
echo "  4. Open http://<this-vm-ip>:8085 on the dashboard device"
