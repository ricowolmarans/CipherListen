#!/usr/bin/env bash
# CipherListen — Install Script
# Installs all dependencies for Spotify Connect, AirPlay, and Google Cast.
# Tested on Raspberry Pi OS (Bullseye / Bookworm), Ubuntu 22+.

set -euo pipefail

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RESET='\033[0m'

info()  { echo -e "${GREEN}[CipherListen]${RESET} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${RESET} $*"; }
step()  { echo -e "\n${BLUE}── $* ──${RESET}"; }

# ── Sanity checks ────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  echo "Please run as root: sudo bash install.sh"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"

info "Installing CipherListen from: $APP_DIR"

# ── System packages ───────────────────────────────────────────────────────────
step "Updating package list"
apt-get update -qq

step "Installing Spotify Connect: librespot (via Raspotify's repo)"
# Plain `apt-get install librespot` fails on Debian/Ubuntu — it isn't packaged
# in their default repos. Raspotify maintains a proper apt repo with prebuilt
# librespot .debs for armhf, arm64, AND amd64 (confirmed — this is not Pi-only
# despite the project name).
if command -v librespot &>/dev/null; then
  info "librespot already installed: $(command -v librespot)"
else
  curl -sL https://dtcooper.github.io/raspotify/install.sh | sh || {
    warn "Raspotify installer failed. Manual install: https://github.com/dtcooper/raspotify"
  }

  # Raspotify ships its OWN systemd service that auto-launches librespot with
  # its own config file (/etc/default/raspotify). CipherListen needs to launch
  # librespot itself so the device name / bitrate / volume set in the web UI
  # actually take effect — so we disable Raspotify's service and just keep the
  # librespot binary it installed.
  if systemctl list-unit-files 2>/dev/null | grep -q raspotify.service; then
    systemctl stop raspotify    2>/dev/null || true
    systemctl disable raspotify 2>/dev/null || true
    info "Disabled raspotify.service — CipherListen will run librespot itself"
  fi
fi

if ! command -v librespot &>/dev/null; then
  warn "librespot still not found. Check https://github.com/dtcooper/raspotify/issues"
fi

step "Installing AirPlay: shairport-sync + avahi-daemon"
# shairport-sync's Debian/Ubuntu package needs Avahi for mDNS advertisement.
# Raspberry Pi OS ships avahi-daemon by default, so this is usually a no-op
# on a Pi — but it's installed/enabled unconditionally here just in case
# (e.g. a minimal/Lite image, or a non-Pi Debian/Ubuntu box). Without it,
# shairport-sync runs fine but is invisible to every AirPlay picker.
apt-get install -y shairport-sync avahi-daemon || warn "shairport-sync/avahi-daemon not found in apt — check your distro repos."
systemctl enable --now avahi-daemon 2>/dev/null || warn "Could not start avahi-daemon — check 'systemctl status avahi-daemon'"

# For AirPlay 2 (multi-room sync, needed by some newer Apple devices), the
# apt package isn't enough — you need to build from source with nqptp:
#   https://github.com/mikebrady/shairport-sync#airplay-2

step "Installing Cast media player: mpv + ffmpeg"
apt-get install -y mpv ffmpeg

step "Installing Node.js (if not present)"
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

step "Installing Node.js dependencies"
cd "$APP_DIR"
npm install --omit=dev

# ── Config directory & cert directory ────────────────────────────────────────
step "Creating config directories"
SERVICE_USER="${SUDO_USER:-pi}"
mkdir -p "$APP_DIR/config/certs"
chown -R "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR/config" 2>/dev/null || true

# ── Write default config if it doesn't exist ─────────────────────────────────
if [[ ! -f "$APP_DIR/config/default.json" ]]; then
  info "Writing default config..."
  cp "$APP_DIR/config/default.json.example" "$APP_DIR/config/default.json" 2>/dev/null || true
fi

# ── systemd service ───────────────────────────────────────────────────────────
step "Installing systemd service"
NODE_BIN="$(command -v node)"

cat > /etc/systemd/system/cipherlisten.service << EOF
[Unit]
Description=CipherListen — Multi-Protocol Audio Streaming Daemon
After=network-online.target sound.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} ${APP_DIR}/src/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

# Give enough time for shairport-sync and the Cast receiver to fully stop
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable cipherlisten

info "Service installed: cipherlisten.service"
info ""
info "Start now with:    sudo systemctl start cipherlisten"
info "Check logs with:   journalctl -u cipherlisten -f"
info "Web UI at:         http://$(hostname -I | awk '{print $1}'):7171"
info ""

# ── Port/firewall reminder ────────────────────────────────────────────────────
echo -e "${YELLOW}━━━ Firewall / Port Notes ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo "  7171/tcp  — CipherListen Web UI"
echo "  1247/tcp  — AirPlay (shairport-sync)"
echo "  8009/tcp  — Google Cast control channel (TLS)"
echo "  5353/udp  — mDNS (device discovery for AirPlay + Cast)"
echo ""
echo -e "  If you run ufw:  ${GREEN}sudo ufw allow 1247,8009/tcp && sudo ufw allow 5353/udp${RESET}"
echo ""
echo -e "${YELLOW}━━━ AirPlay 2 Note ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo "  The apt version of shairport-sync supports AirPlay 1."
echo "  For AirPlay 2 (newer iPhones/Macs), build from source with nqptp:"
echo "    https://github.com/mikebrady/shairport-sync#airplay-2"
echo ""
echo -e "${YELLOW}━━━ Google Cast Note ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo "  The built-in Cast receiver handles HTTP/DASH/HLS audio streams."
echo "  Chrome tab casting (WebRTC peer-to-peer) is not supported."
echo ""
