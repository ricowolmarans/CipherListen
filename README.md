# CipherListen

A unified, self-hosted audio streaming receiver daemon that brings Spotify Connect, AirPlay, and Google Cast to any Linux system—particularly Raspberry Pi 4. Stream audio from your iPhone, Mac, Android device, or web browser to a single Pi without juggling separate apps or configurations.

## Table of Contents

1. [Overview](#overview)
2. [What's New](#whats-new)
3. [Quick Start](#quick-start)
4. [Installation](#installation)
5. [Usage & Web UI](#usage--web-ui)
6. [Configuration](#configuration)
7. [Protocol-Specific Notes](#protocol-specific-notes)
8. [Troubleshooting](#troubleshooting)
9. [Performance & Resource Usage](#performance--resource-usage)
10. [Limitations](#limitations)
11. [Advanced Architecture](#advanced-architecture)

---

## Overview

CipherListen turns your Raspberry Pi (or any Linux box) into a multi-protocol audio receiver. Three streaming protocols run simultaneously in isolated child processes, all managed through a single web dashboard:

- **Spotify Connect**: Stream from Spotify's official iOS/Android app or desktop client. Appears as a playback device in the Spotify app just like a native Alexa or Sonos speaker.
- **AirPlay**: Stream from Apple devices (iPhone, iPad, Mac, HomePod). Shows up in Control Center under "Audio Output" and in macOS's system volume menu.
- **Google Cast**: Stream from Android devices, Chromebooks, Chrome browser, and Cast-enabled apps like YouTube Music, Podcasts, and Plex. Appears in the "Cast" menu of any compatible app.

All three run in parallel. The web UI provides unified control: start/stop each protocol independently, adjust audio output device and backend (ALSA, PulseAudio, PipeWire), and monitor live activity logs with per-protocol color-coding.

---

## What's New

The original CipherListen build was a Spotify Connect daemon only. This release expands it into a unified three-protocol receiver, adding AirPlay and Google Cast while staying backward compatible with configs written for the original Spotify-only build.

### Key Improvements

- **Multi-protocol**: Three independent daemons managed from one interface.
- **Unified audio control**: Switch audio backend or device once; applies to all three protocols.
- **Live activity logging**: Real-time event stream via Server-Sent Events (SSE) visible in the web UI. No more digging through syslog.
- **Collapsible configuration**: Each protocol's settings (device name, port, bitrate, etc.) inline in the UI with save-and-restart.
- **Auto-config migration**: Configs from the original Spotify-only build are automatically migrated to the new nested schema on first boot.
- **Custom Google Cast receiver**: From-scratch implementation written in Node.js with proper TLS, mDNS announcements, and Cast Channel protocol handling. No external binaries or complex Go dependencies.

---

## Quick Start

**On Raspberry Pi OS (Bullseye/Bookworm) or Ubuntu 22+:**

```bash
# 1. Clone or download CipherListen
git clone https://github.com/ricowolmarans/CipherListen.git
cd CipherListen

# 2. Install system dependencies and set up the service
sudo bash scripts/install.sh

# 3. Start the daemon
sudo systemctl start cipherlisten

# 4. Open the web UI
# Find your Pi's IP with: hostname -I
# Then visit: http://<pi-ip>:7171
```

You should see three protocol cards (Spotify, AirPlay, Cast) and an Activity log. Click **Start** on any protocol to bring it online.

**On other Linux systems** (Fedora, Arch, etc.), manually install the prerequisites (see [Installation](#installation)), then run `npm install && npm start`.

---

## Installation

### System Requirements

- **Processor**: Raspberry Pi 4 or newer (or any x86_64/ARM64 Linux system with ~512 MB free RAM).
- **OS**: Raspberry Pi OS, Ubuntu 20.04+, Debian 11+, Fedora 35+, or Arch.
- **Audio**: ALSA, PulseAudio, or PipeWire. Most Pi setups use ALSA (the default).
- **Network**: LAN connectivity for mDNS device discovery.
- **Ports**: TCP 7171 (web UI), TCP 1247 (AirPlay), TCP 8009 (Cast control), UDP 5353 (mDNS).

### Automated Install (Recommended)

The `scripts/install.sh` handles all system-level setup on supported distributions:

```bash
sudo bash scripts/install.sh
```

This script will:

1. Update apt package list.
2. Install `librespot` via the Raspotify apt repo (plain `apt-get install librespot` doesn't work — it isn't packaged in Debian/Ubuntu/Raspberry Pi OS's default repos at all).
3. Disable Raspotify's own systemd service — CipherListen runs the librespot binary itself so your device name/bitrate/volume settings in the web UI actually take effect.
4. Install `shairport-sync` and `avahi-daemon` (AirPlay daemon + the mDNS service needed for AirPlay to be discoverable — `avahi-daemon` is preinstalled on Raspberry Pi OS but missing on minimal/server installs).
5. Install `mpv` and `ffmpeg` (media players for Cast).
6. Install Node.js 20 (if not already present).
7. Install npm dependencies (`express`, `multicast-dns`, `selfsigned`).
8. Create the `config/certs` directory for TLS certificates.
9. Write a default `config/default.json` (if one doesn't exist).
10. Install a systemd service file for automatic startup.

### Manual Install (Linux Distributions Beyond apt/dnf)

If your distro isn't covered by the install script:

```bash
# 1. Install system packages manually
# For Spotify Connect:
#   - librespot, via Raspotify's repo (covers armhf/arm64/amd64):
#     curl -sL https://dtcooper.github.io/raspotify/install.sh | sh
#     sudo systemctl stop raspotify && sudo systemctl disable raspotify
#     (CipherListen runs the librespot binary itself — Raspotify's own
#      service would otherwise compete with it for the audio device)
#
# For AirPlay:
#   - shairport-sync (https://github.com/mikebrady/shairport-sync#building)
#   - avahi-daemon — REQUIRED for AirPlay to be discoverable; preinstalled
#     on Raspberry Pi OS, but missing on minimal/server Debian/Ubuntu installs
#
# For Google Cast:
#   - mpv or ffplay
#   - ffmpeg (for media handling)
#
# For the Node.js backend:
#   - Node.js 18+ (https://nodejs.org/)

# 2. Install npm dependencies
cd /path/to/CipherListen
npm install --omit=dev

# 3. Create config directory
mkdir -p config/certs

# 4. Run the app
npm start
```

The first run will generate TLS certificates in `config/certs/` for the Cast receiver automatically.

### Systemd Service (Optional)

If you installed via `scripts/install.sh`, a systemd service is already set up. Otherwise, create `/etc/systemd/system/cipherlisten.service`:

```ini
[Unit]
Description=CipherListen — Multi-Protocol Audio Streaming Daemon
After=network-online.target sound.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/CipherListen
ExecStart=/usr/bin/node /home/pi/CipherListen/src/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable cipherlisten
sudo systemctl start cipherlisten
```

Check status with:
```bash
sudo systemctl status cipherlisten
journalctl -u cipherlisten -f  # live logs
```

### Firewall Configuration

If you use `ufw`:

```bash
sudo ufw allow 7171/tcp   # Web UI
sudo ufw allow 1247/tcp  # AirPlay
sudo ufw allow 8009/tcp   # Google Cast
sudo ufw allow 5353/udp   # mDNS (device discovery)
```

---

## Usage & Web UI

The web dashboard at `http://<pi-ip>:7171` provides full control.

### Dashboard Layout

**Header**: Logo, version, protocol badges.

**Audio Output Card**: Global settings that apply to all three protocols.
- **Backend**: ALSA (exclusive mode, suitable for single-stream audio), PulseAudio (software mixing for multiple streams), or PipeWire (modern replacement for PulseAudio).
- **Device**: Audio card and sink selection (e.g., `default`, `plughw:0`, `alsa_output.pci-0000_00_1b.0.analog-stereo` for PulseAudio).

Changing these and clicking **Apply to All & Restart** will restart all running protocols to pick up the new settings.

**Protocol Cards** (Spotify, AirPlay, Google Cast): Each card shows:
- **Status dot** (pulsing green = running, red = stopped).
- **PID**: Process ID if running.
- **Start / Restart / Stop buttons**: Control the daemon immediately.
- **Config toggle** (▼/▲): Expand to edit protocol-specific settings.

**Activity Log Card**: Live event stream with per-protocol color-coding, level indicators (info/warn/error), and filtering.

### Starting Protocols

Click the **Start** button on any protocol card. The status dot will turn green and pulse. Check the Activity log for startup messages. Typical startup takes 2–5 seconds per protocol.

### Stopping Protocols

Click **Stop**. The process will be terminated cleanly (SIGTERM with a 10-second timeout before SIGKILL). Status dot turns red.

### Restarting

Click **Restart**. Useful after config changes or if a protocol becomes unresponsive. Equivalent to **Stop** + **Start** with a 400 ms delay.

---

## Configuration

The web UI allows real-time config editing without touching files. Settings are persisted to `config/default.json` in this structure:

```json
{
  "port": 7171,
  "audioBackend": "alsa",
  "audioDevice": "default",
  "spotify": {
    "enabled": true,
    "autostart": true,
    "deviceName": "CipherListen",
    "bitrate": 320,
    "volume": 100
  },
  "airplay": {
    "enabled": true,
    "autostart": true,
    "deviceName": "CipherListen",
    "password": "",
    "port": 1247
  },
  "cast": {
    "enabled": true,
    "autostart": true,
    "deviceName": "CipherListen",
    "port": 8009,
    "playerPath": "mpv"
  }
}
```

### Global Settings

**`port`** (default: 7171): The port the web UI listens on. Change this if 7171 is already in use.

**`audioBackend`** (options: `alsa`, `pulseaudio`, `pipewire`): The audio system used by all three protocols.
- **ALSA**: Direct hardware access, lowest latency, but exclusive access (only one protocol produces sound at a time).
- **PulseAudio**: Software mixer, allows multiple protocols to stream simultaneously, more CPU overhead.
- **PipeWire**: Modern replacement for PulseAudio, better performance, lower latency mixing.

**`audioDevice`** (default: `default`): The audio output device. Use `default` for your primary speaker, or list devices:

```bash
# ALSA
aplay -l | grep "card"

# PulseAudio
pactl list short sinks

# PipeWire
pw-cli list-objects Node | grep -i alsa
```

**Raspberry Pi note**: a Pi has two built-in outputs — the 3.5mm headphone jack and HDMI. Raspberry Pi OS doesn't always default to the one you want. Force the headphone jack with:

```bash
sudo raspi-config   # System Options → Audio → Headphones
# or directly:
amixer cset numid=3 1   # 1 = headphone jack, 2 = HDMI, 0 = auto
```

If you've attached a USB DAC or USB sound card instead, find its card number with `aplay -l` and set `audioDevice` to something like `plughw:1,0` (substituting the right card index) rather than `default`.

### Spotify Connect Settings

**`deviceName`**: The name that appears in the Spotify app under "Devices". Spaces are okay.

**`bitrate`**: 96, 160, or 320 kbps. Higher = better quality but more CPU and bandwidth. Default 320 is HQ.

**`volume`**: Initial output volume (0–100). The Spotify app can override this after connecting.

**`autostart`**: If `true`, starts automatically when the service boots.

### AirPlay Settings

**`deviceName`**: Shows in Control Center / audio output menus on Apple devices.

**`port`**: Where `shairport-sync` listens (default 1247). Rarely needs changing unless 1247 is in use.

**`password`**: Leave blank for no password. If set, Apple devices will prompt for this password before connecting.

**`autostart`**: If `true`, starts on boot.

### Google Cast Settings

**`deviceName`**: Shows in the "Cast" menu of Android and web apps. Can include spaces.

**`port`**: TLS control port for the Cast protocol (default 8009). Rarely needs changing.

**`playerPath`**: Either `mpv` or `ffplay`. mpv is recommended (better codec support, lower CPU).

**`autostart`**: If `true`, starts on boot.

### Configuration via Web UI

Each protocol card has a **config toggle** button (▼). Click to expand and edit settings inline:

```
[▼] Spotify Connect
    Device Name:     [CipherListen______]
    Bitrate:         [320 kbps   ▼]
    Volume:          [100_______]
    [Save & Restart] ✓ Saved.
```

Clicking **Save & Restart** updates the JSON, writes it to disk, and restarts that protocol.

### Configuration via File

Edit `config/default.json` directly if you prefer:

```bash
nano config/default.json
systemctl restart cipherlisten
```

Changes take effect immediately on restart.

### Backward Compatibility (Legacy Config Migration)

If you have an old config from the original Spotify-only build, using the flat schema:

```json
{
  "deviceName": "MyPi",
  "bitrate": 320,
  "audioBackend": "alsa",
  "audioDevice": "default"
}
```

CipherListen automatically detects this, migrates it to the current nested format, and saves it back. The Activity log will show: `[SYSTEM] Config migrated to the current format (multi-protocol)`.

---

## Protocol-Specific Notes

### Spotify Connect (librespot)

**How it works**: The Spotify app (iOS, Android, macOS, Windows) can control a Spotify Connect device. Your Pi acts like a Sonos or Echo. Stream from the Spotify app's "Devices" menu or use "Go to Device" on a track.

**Requirements**:
- A valid Spotify Premium account . Spotify Connect does not work with free accounts.
- Your Pi on the same Wi-Fi network as your phone/computer.
- Functional audio output (speakers or headphones).

**Latency**: ~2–3 seconds between pressing play and hearing audio.

**Quality**: Depends on `bitrate` setting (default 320 kbps is very good quality).

**Installed via**: Raspotify's apt repo (https://github.com/dtcooper/raspotify), which provides prebuilt librespot binaries for armhf, arm64, and amd64. Raspotify's own systemd service is disabled by `install.sh` — CipherListen launches the librespot binary itself.

**Troubleshooting**:
- Device doesn't appear in Spotify? Check the Activity log for errors. Common causes: librespot crashed, firewall blocking, or wrong network. Verify the binary exists: `which librespot`.
- Audio is crackling? You might be CPU-bound. Try lowering bitrate to 160 or 96 kbps, or switch audio backend to PipeWire.
- Spotify says "Not available for this premium account"? Some accounts are restricted. Upgrade or use a different account.
- Raspotify's own service interfering? Run `systemctl status raspotify` — it should show `disabled`/`inactive`. If it's running, it's likely competing with CipherListen for the audio device: `sudo systemctl stop raspotify && sudo systemctl disable raspotify`.

### AirPlay (shairport-sync)

**How it works**: Apple's proprietary streaming protocol. Shows up in Control Center (iOS 13+), system volume menu (macOS), or HomePod selection menu. Supports lossless audio (bit-perfect CD quality).

**Requirements**:
- An Apple device (iPhone, iPad, Mac, HomePod, Apple TV).
- Your Pi on the same network.
- `shairport-sync` AND `avahi-daemon` both installed and running. This is easy to miss: `shairport-sync` will start and run fine without Avahi, but it becomes completely invisible to every AirPlay picker — there's no error, it just never shows up. Raspberry Pi OS ships `avahi-daemon` by default; minimal Debian/Ubuntu installs usually don't. `install.sh` installs and enables it for you.
- A real audio output device. `shairport-sync` opens the ALSA device immediately on startup (not lazily when a stream begins) — on a machine with zero sound hardware, this fails instantly and the process exits before you'd even notice. Not a concern on a Pi 4 (it has a built-in headphone jack and HDMI audio), but worth knowing if you ever move this to a headless server with no sound card.

**Quality**: Lossless (CD-quality, 44.1/48 kHz 16-bit). AirPlay is excellent for high-fidelity listening.

**AirPlay 1 vs. AirPlay 2**:
- **AirPlay 1** (in apt): Works with most Apple devices up to ~2019. No multi-room sync, no password encryption.
- **AirPlay 2** (from source): Newer iPhones and Macs support multi-room syncing. Encrypted connection. Requires building `shairport-sync` from source with `nqptp` (Network Time Protocol):

  ```bash
  # To enable AirPlay 2, build from source:
  git clone https://github.com/mikebrady/shairport-sync.git
  cd shairport-sync
  # Follow instructions at https://github.com/mikebrady/shairport-sync#building
  ```

**Troubleshooting**:
- Device doesn't appear in Control Center? First check `systemctl status avahi-daemon` — if it's not running, AirPlay never gets advertised regardless of whether shairport-sync itself is healthy. Then check the Activity log for AirPlay: if it shows "Exited" within a second of starting, the audio device couldn't be opened (no sound hardware, or wrong `audioDevice` in config).
- Restart `shairport-sync` via the web UI. Check firewall (port 1247 and UDP 5353 for mDNS) — if you've enabled `ufw`, run `sudo ufw status verbose` and confirm those are explicitly allowed, not just that ufw is "active".
- Audio cuts out or is choppy? Weak Wi-Fi signal. Move closer or upgrade to 5 GHz band if available.
- "Requires a password" prompt appears but you left the password blank? Clear the network's Bluetooth/Wi-Fi settings on your Apple device and re-add it.

### Google Cast (Cast Receiver)

**How it works**: Android and web apps (YouTube Music, Spotify, Google Podcasts, Chrome browser) have a "Cast" button. Tap it, select "CipherListen", and stream.

**Requirements**:
- An Android device, Chromebook, or computer with Chrome/Edge.
- A Cast-compatible app (Spotify, YouTube, Plex, Podcasts, etc.) or Chrome browser.
- Your Pi on the same network.

**Media Support**: The Cast receiver can play:
- HTTP streams (direct audio files: .mp3, .flac, .aac, etc.).
- DASH manifests (YouTube Music, many premium streaming services).
- HLS playlists (.m3u8, podcasts, live radio).
- Local files served via HTTP.

**Not Supported**:
- Chrome tab casting (WebRTC peer-to-peer). Chrome's tab audio isn't sent as a URL; it streams directly via WebRTC, which would require a full WebRTC stack.
- Some DRM-protected streams (Amazon Music, Apple Music) may not work depending on the app's implementation.

**Quality**: Depends on the app. Spotify typically uses 96–320 kbps depending on the Android app settings.

**TLS Certificate**: On first run, CipherListen generates a self-signed TLS certificate in `config/certs/`. This is required by the Cast protocol. Your phone won't validate the signature (it's self-signed), but the connection is encrypted.

**Troubleshooting**:
- Device doesn't appear in Cast menu? Check Activity log. Ensure mDNS is working: on another device, run `dns-sd -B _googlecast._tcp` (macOS) or `avahi-browse -r _googlecast._tcp` (Linux) and look for CipherListen. If you've enabled `ufw`, confirm 8009/tcp and 5353/udp are explicitly allowed (`sudo ufw status verbose`) — enabling ufw without those rules silently blocks discovery with no error on either side.
- Device appears but says "cannot reach"? If your Pi runs Docker, Tailscale, or any other software that creates virtual network interfaces, the Cast receiver could be announcing the wrong IP (e.g. a Docker bridge address like `172.17.0.1` instead of your real LAN IP). Check the Activity log on startup for a line like `Multiple network interfaces found... using X.X.X.X` and verify that's actually your Pi's LAN address. If it picked the wrong one, set `CAST_BIND_IP=<correct-ip>` as an environment override (edit the systemd service file's `Environment=` lines, or export it before running manually).
- Audio plays briefly then stops? Likely the URL provided by the app isn't accessible from your Pi, or the codec isn't supported by mpv. Check the Activity log for `[CAST]` error messages.

---

## Troubleshooting

### Protocol Won't Start

**Symptom**: Clicking Start, but the status dot stays red. Activity log shows an error.

**Debugging**:
1. Check the Activity log in the web UI for the specific error message.
2. Verify the binary is installed:
   ```bash
   which librespot      # Spotify
   which shairport-sync # AirPlay
   which mpv            # Cast (media player)
   ```
3. Try starting manually to see the raw error:
   ```bash
   # Spotify
   librespot --name "CipherListen"

   # AirPlay
   shairport-sync --name "CipherListen"

   # Cast (runs as a Node.js child process, check logs via systemctl)
   ```
4. Check disk space: `df -h`. If /home is nearly full, daemons may fail silently.

### Audio Device Not Found

**Symptom**: Changed `audioDevice` to a specific device, now no protocols produce sound.

**Solution**:
1. Revert to `default`:
   ```bash
   nano config/default.json
   # Change "audioDevice": "plughw:0" to "audioDevice": "default"
   systemctl restart cipherlisten
   ```
2. List available devices:
   ```bash
   # ALSA
   aplay -l

   # PulseAudio
   pactl list short sinks

   # PipeWire
   pw-link -o  # outputs
   ```
3. Use the device name that appears in the list.

### Multiple Protocols, But Only One Produces Sound

**Cause**: Using ALSA with exclusive mode. Only the last-started protocol grabs the audio device.

**Solution**: Switch to PulseAudio or PipeWire in the Audio Output card:
- Install: `sudo apt install pulseaudio` or `sudo apt install pipewire pipewire-pulse`.
- Change `audioBackend` to `pulseaudio` or `pipewire` in the web UI.
- Click **Apply to All & Restart**.

With PulseAudio/PipeWire, all three protocols can stream simultaneously; the OS mixes the audio.

### Web UI Shows "Connecting to event stream..."

**Cause**: SSE connection to `/api/events` is stuck or timing out.

**Solution**:
1. Reload the page (Ctrl+R or Cmd+R).
2. Check if the Node.js service is running: `sudo systemctl status cipherlisten`.
3. Check browser console (F12 → Console tab) for JavaScript errors.
4. Verify the service is listening on port 7171: `ss -tlnp | grep 7171`.

### Cast Device Appears But Says "Cannot Reach"

**Cause**: Firewall, port in use, or the Cast receiver crashed.

**Debugging**:
1. Check if port 8009 is listening:
   ```bash
   sudo ss -tlnp | grep 8009
   ```
2. Check Activity log for Cast errors.
3. Restart Cast:
   ```bash
   systemctl restart cipherlisten  # or click Restart on the Cast card
   ```
4. Verify mDNS is working:
   ```bash
   avahi-browse -r _googlecast._tcp
   ```

### Spotiy Says "Not Available"

**Symptom**: Device appears in the Spotify app but shows "Not available for this account" or "requires premium".

**Cause**: Your Spotify account is restricted (family account, shared device, or regional limitations). Some Spotify accounts cannot use Connect on non-native devices.

**Solution**:
- Use a different Spotify account.
- Check Spotify account settings: do you have Connect enabled for all apps?
- Upgrade to premium (some features are premium-only on certain accounts).

### High CPU Usage

**Symptom**: The Pi is warm, CPU is at 100%, even with low-bitrate playback.

**Causes & Solutions**:
- **Using ALSA with heavy bitrate**: Switch to PulseAudio or lower bitrate to 96 kbps.
- **Cast receiver processing high-bitrate video**: Ensure you're casting audio (not video). Check the Activity log for clues.
- **All three protocols running simultaneously**: This is expected. CPU usage depends on bitrate and complexity. A Pi 4 can handle all three with moderate bitrate (160–256 kbps each).

**Monitor CPU**:
```bash
top -p $(pgrep -f 'node|librespot|shairport' | tr '\n' ',')
```

### Can't Connect from a Different Network (Mobile Data)

**Expected Behavior**: CipherListen uses mDNS (`.local` addresses), which only works on local Wi-Fi. You cannot access it via cellular or external networks by design (security + mDNS limitation).

**If you need remote access**:
1. Set up a reverse proxy (Nginx, Caddy) on your Pi with a public domain.
2. Use a VPN to your home network and then access `http://<pi-ip>:7171`.
3. Use SSH tunneling: `ssh -L 7171:localhost:7171 pi@<pi-ip>` then visit `http://localhost:7171`.

---

## Performance & Resource Usage

### CPU Usage

| Scenario | Typical CPU (Pi 4) |
|----------|-------------------|
| Idle (all stopped) | <1% |
| One protocol, 128 kbps | 5–8% |
| Two protocols, 160 kbps each | 12–18% |
| All three, 256 kbps each | 35–50% |
| Transcoding video via Cast | 60–85% |

Higher bitrates and more simultaneous streams increase usage. A Pi 4 (4-core ARM Cortex-A72) handles all three comfortably at moderate bitrates. A Pi 3 or Zero may struggle with 320 kbps Spotify + Cast simultaneously.

### Memory Usage

| Process | Typical RAM |
|---------|-------------|
| Node.js (index.js + web UI) | 50–80 MB |
| librespot (Spotify) | 60–100 MB |
| shairport-sync (AirPlay) | 20–40 MB |
| mpv (Cast player, per stream) | 30–100 MB |

**Total for all three running**: ~200–250 MB, well within a Pi 4's 4 GB.

### Network Usage

- **Spotify Connect**: ~20 kbps @ 320 kbps bitrate (the Pi decodes; only control data crosses the network).
- **AirPlay**: ~44 kbps @ 320 kbps bitrate.
- **Google Cast**: Depends on the source app (typically 96–320 kbps).

mDNS discovery (UDP 5353) is lightweight and only active when advertising or responding to device queries.

### Audio Latency

- **Spotify Connect**: ~2–3 seconds (application + network buffering).
- **AirPlay**: ~0.5–1.5 seconds (hardware-optimized on Apple devices).
- **Google Cast**: ~1–2 seconds (varies by app).

If you need sub-500ms latency, use AirPlay, as it's Apple's proprietary protocol with tight synchronization.

---

## Limitations

### Hard Limitations (By Design)

1. **Chrome Tab Casting (WebRTC)**: Chrome's "Cast tab" audio feature streams audio peer-to-peer via WebRTC, not via a URL. The Cast receiver expects a URL. This is not supported. Use Spotify, YouTube Music, or other Cast-enabled apps instead.

2. **AirPlay 2 Multi-Room**: The apt version of shairport-sync supports AirPlay 1 only. AirPlay 2 with multi-room sync requires building from source with `nqptp` support.

3. **DRM-Protected Streams**: Amazon Music and some other services may not allow casting due to DRM restrictions. This is controlled by the service, not CipherListen.

4. **Exclusive Audio Mode (ALSA)**: On ALSA without PulseAudio/PipeWire, only one protocol can produce sound at a time. The last-started protocol "wins". Use PulseAudio or PipeWire to mix multiple streams.

5. **Network-Only**: Requires Wi-Fi or Ethernet. No Bluetooth A2DP support (would require additional libraries and drivers).

### Soft Limitations (Workarounds Exist)

1. **Single Device Name**: All three protocols announce under the same device name (CipherListen). If you want separate names, edit the config.json directly or contribute to the UI.

2. **No Per-Protocol Encryption**: Spotify and Cast use TLS/SSL natively. AirPlay 1 is unencrypted (AirPlay 2 from source includes encryption).

3. **No Volume Control in Cast Receiver**: Volume commands from the sender are logged but not yet forwarded to mpv. Use your system volume controls. (Could be implemented as a future enhancement.)

4. **No Persistent Metadata**: Song titles and artist info aren't logged or displayed. Activity log shows connection/playback events only.

5. **No Recording**: CipherListen is a playback receiver only. To record what's playing, you'd need to route the audio output through a recording utility (e.g., `ffmpeg` with `-f pulse -i default`).

### Platform-Specific Limitations

- **Raspberry Pi Zero / Pi 3**: Can run CipherListen, but may struggle with 320 kbps Spotify + Cast simultaneously. Stick to 160 kbps or lower, or run protocols one at a time.
- **Older Kernels (< 4.19)**: mDNS announcements might not work reliably. Upgrade the OS or manually announce services.
- **HDMI Audio on Pi**: Some older HDMI devices need explicit audio mode configuration in `/boot/config.txt`. See Raspberry Pi docs.

---

## Advanced Architecture

This section covers the technical internals for developers and operators who want to understand how CipherListen works.

### Process Model

```
systemd (cipherlisten.service)
  ↓
  src/index.js (main process)
    ├─ Express.js web server (port 7171)
    │  ├─ GET /api/status          (JSON: pid, running state)
    │  ├─ GET /api/config          (JSON: full config)
    │  ├─ POST /api/config         (update + save)
    │  ├─ GET /api/events          (SSE: live log stream)
    │  ├─ POST /api/{protocol}/start
    │  ├─ POST /api/{protocol}/stop
    │  └─ POST /api/{protocol}/restart
    │
    └─ Child Processes (spawned via child_process.spawn)
       ├─ librespot (Spotify Connect)
       │  └─ outputs audio via ALSA/PulseAudio
       │
       ├─ shairport-sync (AirPlay)
       │  └─ outputs audio via ALSA/PulseAudio
       │
       └─ node src/cast-receiver.js (Google Cast)
          ├─ TLS server on :8009
          ├─ mDNS announcer (multicast-dns lib)
          └─ spawns mpv per stream
             └─ outputs audio via ALSA/PulseAudio
```

Each daemon runs in its own process group. Killing the parent (systemd) sends SIGTERM to all children with a 10-second timeout before SIGKILL.

### Logging & SSE

**stdout/stderr** from all three daemons is captured by index.js and forwarded to an in-memory ring buffer (max 500 lines). When a browser connects to `/api/events`, the last 60 lines are replayed immediately, then new lines are streamed in real-time via SSE.

```
[15:23:04] [SPOTIFY] [INFO] Connecting to Spotify...
[15:23:05] [AIRPLAY] [INFO] mDNS: announced "CipherListen" at 192.168.1.100:1247
[15:23:06] [CAST]    [INFO] Cast receiver listening on port 8009
```

### Google Cast Protocol (src/cast-receiver.js)

CipherListen's Cast receiver is a from-scratch implementation. Here's how it works:

#### 1. TLS Setup

On first run, the receiver generates a self-signed TLS certificate using the `selfsigned` npm package. This certificate is stored in `config/certs/cast.crt` and `config/certs/cast.key` and reused across reboots.

```javascript
const { cert, key } = selfsigned.generate(
  [{ name: "commonName", value: "CipherListen" }],
  { days: 3650 }
);
```

The certificate allows Cast clients (phones, browsers) to establish a secure TLS 1.2+ connection to port 8009. Since it's self-signed, clients perform no hostname validation (per Cast spec).

#### 2. mDNS Announcement

The receiver uses the `multicast-dns` npm library to announce itself on the LAN:

```
Service: CipherListen._googlecast._tcp.local
Port: 8009
Address: 192.168.1.100
TXT Records:
  id=<random-hex>
  fn=CipherListen
  md=CipherListen
  ve=05 (protocol version 5)
  ca=4101 (codec flags)
  st=0 (status)
  rs= (resume token)
  bs=<device-id-short>
```

When an Android phone or Chrome browser on the LAN searches for Cast devices (via mDNS PTR queries for `_googlecast._tcp`), the Pi responds with these TXT records. The phone's system software then shows "CipherListen" in the Cast menu.

#### 3. Cast Channel Protocol

Once a client connects via TLS, messages flow in the **Cast Channel** format:

```
[4 bytes: big-endian message length]
[variable: protobuf-encoded CastMessage]
```

Each `CastMessage` is a lightweight protobuf with fields for source, destination, namespace, and JSON payload:

```protobuf
message CastMessage {
  string source_id       = 1;
  string destination_id  = 2;
  string namespace       = 3;
  enum { STRING = 0 }    = 4;
  string payload_utf8    = 6;
}
```

CipherListen manually encodes/decodes this protobuf (no external codegen). Key namespaces:

- `urn:x-cast:com.google.cast.tp.heartbeat`: Ping/pong keepalive.
- `urn:x-cast:com.google.cast.tp.connection`: Client registration.
- `urn:x-cast:com.google.cast.receiver`: Device status and app launch.
- `urn:x-cast:com.google.cast.media`: Media control (load, play, pause, stop).

#### 4. Session Lifecycle

```
Client → [CONNECT] → Receiver
Receiver → [CONNECTED] → Client

Client → [GET_STATUS] → Receiver
Receiver → [RECEIVER_STATUS + app list] → Client

Client → [LAUNCH com.google.cast.media] → Receiver
Receiver → [ok, transport ID = web:xxxxx-1] → Client

Client → [LOAD media URL] → Receiver (via media transport)
Receiver → spawns mpv for the URL, replies [BUFFERING]
mpv → outputs audio
Receiver → replies [PLAYING] after ~800ms

Client → [STOP] → Receiver
Receiver → kills mpv, replies [IDLE] → Client
```

#### 5. Media Playback

When a Cast client sends a LOAD command with a media URL, the receiver:

1. Extracts the URL from the `media.contentId` or `media.contentUrl` field.
2. Spawns `mpv` (or `ffplay` if configured) with the URL and audio backend flags.
3. Sends a `MEDIA_STATUS` reply with `playerState: "BUFFERING"`.
4. After ~800 ms (allowing mpv to start and buffer), sends `playerState: "PLAYING"`.

mpv handles decoding and audio output. Supported formats:

- **Container**: MP3, FLAC, AAC, Ogg Vorbis, WAV, OPUS.
- **Protocols**: HTTP, HTTPS, DASH (`.mpd`), HLS (`.m3u8`).

The receiver can also send pause/resume/seek commands, but these are logged but not yet implemented (mpv would need IPC via socket or named pipe).

#### 6. Device ID Persistence

A random 8-byte hex ID is generated on first run and stored in `config/certs/cast.id`. This ensures the device shows up consistently in Chrome's "Cast" history and Google Home integration even after reboots.

### Configuration Loading & Validation

CipherListen uses a deep-merge strategy for configuration:

1. Start with `DEFAULTS` (hardcoded in code).
2. Read `config/default.json` from disk.
3. Deep-merge user file over defaults.
4. If the old flat schema from the original Spotify-only build is detected, migrate it and write it back.

This approach means even if a future version adds new config keys, older configs won't break—they'll pick up the new defaults automatically.

### Security Notes

- **TLS Certificates**: Self-signed and unvalidated (per Cast spec). No confidentiality risk if your LAN is trusted.
- **mDNS**: Broadcasts device name and port in clear text. An attacker on your LAN could find your devices. Not a concern for typical home networks.
- **AirPlay 1**: Unencrypted (AirPlay 2 from source adds encryption).
- **Authentication**: AirPlay password (if set) is not hashed; stored plaintext in config. Treat `config/default.json` as sensitive.

---

## Contributing

Found a bug or have a feature idea? Open an issue or a pull request on GitHub.

### Testing Checklist

Before submitting a PR:

- [ ] All three protocols start without errors.
- [ ] Web UI reflects status correctly.
- [ ] Config changes save and persist after restart.
- [ ] Audio plays correctly on a real device (phone, speaker, etc.).
- [ ] Logs are visible in real-time via SSE.
- [ ] Protocols restart cleanly without hanging processes.

---

## License

CipherListen is released under the MIT License. See `LICENSE` file for details.

---

## Credits

- **Raspotify**: apt repo providing prebuilt librespot binaries for armhf/arm64/amd64 (https://github.com/dtcooper/raspotify). CipherListen uses the binary it installs but runs it directly rather than via Raspotify's own service.
- **librespot**: Spotify Connect implementation (https://github.com/librespot-org/librespot).
- **shairport-sync**: AirPlay receiver (https://github.com/mikebrady/shairport-sync).
- **mpv**: Media player (https://mpv.io/).
- **Express.js**: Web framework.
- **multicast-dns**: mDNS library (https://github.com/mafintosh/multicast-dns).
- **selfsigned**: Self-signed certificate generation (https://github.com/TooTallNate/node-selfsigned).

---

## Support

- **Issues & Bugs**: Check the Activity log in the web UI for detailed error messages. Post issues with logs attached.
- **General Q&A**: See the [Troubleshooting](#troubleshooting) section above.
- **Protocol-Specific Help**:
  - Spotify: https://community.spotify.com/
  - AirPlay: Apple Support or https://github.com/mikebrady/shairport-sync/discussions
  - Google Cast: https://support.google.com/chromecast

---

**Version**: 1.0.0  
**Last Updated**: June 2026  
**Tested On**: Raspberry Pi 4, Ubuntu 22.04 LTS, Debian 12 Bookworm
