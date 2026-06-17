/**
 * CipherListen — Google Cast Receiver
 *
 * Implements a Google Cast-compatible audio receiver that:
 *   1. Announces itself on the LAN via mDNS (_googlecast._tcp) so phones and
 *      browsers see it as a Cast target
 *   2. Accepts incoming Cast control connections over TLS on port 8009 using
 *      the Cast Channel protocol (length-prefixed protobuf messages)
 *   3. Handles connection / heartbeat / receiver / media namespaces
 *   4. When a LOAD command arrives it launches mpv (or ffplay) to play the
 *      stream URL the sender provides
 *
 * Run by index.js as a child process; config arrives via environment variables.
 *
 * Limitations:
 *   - Supports audio-only or video URLs that mpv can handle (HTTP streams,
 *     DASH, HLS, direct files). Apps that stream media directly via WebRTC
 *     rather than sending a URL (e.g. Google Chrome tab casting) will not
 *     produce audio — they need a full WebRTC stack.
 *   - AirPlay 2 multi-room sync is not implemented.
 *   - Volume change commands from the sender are logged but not yet forwarded
 *     to mpv; use the Pi's system volume controls for now.
 */

"use strict";

const tls      = require("tls");
const os       = require("os");
const path     = require("path");
const fs       = require("fs");
const crypto   = require("crypto");
const { spawn } = require("child_process");

// ---------------------------------------------------------------------------
// Config (injected by index.js via env vars)
// ---------------------------------------------------------------------------
const DEVICE_NAME   = process.env.CAST_DEVICE_NAME  || "CipherListen";
const CAST_PORT     = parseInt(process.env.CAST_PORT  || "8009", 10);
const PLAYER        = process.env.CAST_PLAYER        || "mpv";
const AUDIO_BACKEND = process.env.AUDIO_BACKEND      || "alsa";
const AUDIO_DEVICE  = process.env.AUDIO_DEVICE       || "default";

const CERT_DIR  = path.join(__dirname, "../config/certs");
const CERT_FILE = path.join(CERT_DIR, "cast.crt");
const KEY_FILE  = path.join(CERT_DIR, "cast.key");
const ID_FILE   = path.join(CERT_DIR, "cast.id");

const log   = (m) => process.stdout.write(`${m}\n`);
const warn  = (m) => process.stderr.write(`WARN  ${m}\n`);
const error = (m) => process.stderr.write(`ERROR ${m}\n`);

// ---------------------------------------------------------------------------
// TLS certificate (self-signed, generated once and cached)
// ---------------------------------------------------------------------------
function ensureCert() {
  if (!fs.existsSync(CERT_DIR)) fs.mkdirSync(CERT_DIR, { recursive: true });
  if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
    return { key: fs.readFileSync(KEY_FILE), cert: fs.readFileSync(CERT_FILE) };
  }
  log("Generating self-signed TLS certificate for Cast...");
  try {
    const selfsigned = require("selfsigned");
    const attrs = [{ name: "commonName", value: DEVICE_NAME }];
    const pems  = selfsigned.generate(attrs, { days: 3650, keySize: 2048 });
    fs.writeFileSync(KEY_FILE,  pems.private);
    fs.writeFileSync(CERT_FILE, pems.cert);
    log("TLS certificate ready.");
    return { key: pems.private, cert: pems.cert };
  } catch (e) {
    error(`selfsigned package missing — run: npm install\n  ${e.message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Stable device ID (persisted so the Cast target looks the same on reboots)
// ---------------------------------------------------------------------------
function getDeviceId() {
  if (fs.existsSync(ID_FILE)) return fs.readFileSync(ID_FILE, "utf8").trim();
  const id = crypto.randomBytes(8).toString("hex").toUpperCase();
  if (!fs.existsSync(CERT_DIR)) fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(ID_FILE, id);
  return id;
}

const DEVICE_ID = getDeviceId();

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------
function getLocalIP() {
  // Skip virtual/container interfaces (Docker bridges, veth pairs, tunnels,
  // loopback). On a server running Docker — or any VM with virtual NICs —
  // the original "first non-internal IPv4" logic could grab something like
  // docker0's 172.17.0.1, which the announced device is unreachable from
  // any real device on the LAN. This was a real bug, not a config issue.
  const SKIP_PREFIXES = ["docker", "br-", "veth", "tun", "tap", "virbr"];

  const candidates = [];
  for (const [name, ifaces] of Object.entries(os.networkInterfaces())) {
    if (SKIP_PREFIXES.some((p) => name.startsWith(p))) continue;
    for (const i of ifaces) {
      if (i.family === "IPv4" && !i.internal) candidates.push({ name, address: i.address });
    }
  }

  if (candidates.length === 0) return "127.0.0.1";
  if (candidates.length > 1) {
    warn(`Multiple network interfaces found (${candidates.map(c => `${c.name}:${c.address}`).join(", ")}) — using ${candidates[0].address}. Set CAST_BIND_IP env var to override if this is wrong.`);
  }

  return process.env.CAST_BIND_IP || candidates[0].address;
}

const LOCAL_IP    = getLocalIP();
const HOSTNAME    = `${DEVICE_NAME.replace(/\s+/g, "-")}.local`;
const SVC_NAME    = `${DEVICE_NAME}._googlecast._tcp.local`;

// ---------------------------------------------------------------------------
// mDNS announcement
// ---------------------------------------------------------------------------
let mdns = null;

function buildMDNSPacket() {
  return {
    answers: [
      { name: "_googlecast._tcp.local",  type: "PTR", data: SVC_NAME },
      {
        name: SVC_NAME, type: "SRV",
        data: { port: CAST_PORT, target: HOSTNAME, weight: 0, priority: 0 }
      },
      {
        name: SVC_NAME, type: "TXT",
        data: [
          `id=${DEVICE_ID}`,
          `fn=${DEVICE_NAME}`,
          `md=${DEVICE_NAME}`,
          `ve=05`,
          `ca=4101`,
          `st=0`,
          `rs=`,
          `bs=${DEVICE_ID.slice(0, 12)}`
        ]
      },
      { name: HOSTNAME, type: "A", data: LOCAL_IP }
    ]
  };
}

function startMDNS() {
  try {
    mdns = require("multicast-dns")();
  } catch (e) {
    error(`multicast-dns not installed — run: npm install\n  ${e.message}`);
    process.exit(1);
  }

  // Respond to queries
  mdns.on("query", (query) => {
    const relevant = query.questions.some(
      (q) =>
        q.name === "_googlecast._tcp.local" ||
        q.name === SVC_NAME ||
        q.name === HOSTNAME
    );
    if (relevant) mdns.respond(buildMDNSPacket());
  });

  // Initial gratuitous announcement + periodic refresh so the device stays
  // visible in Cast menus without waiting for a query.
  const announce = () => {
    mdns.respond(buildMDNSPacket());
    log(`mDNS: announced "${DEVICE_NAME}" at ${LOCAL_IP}:${CAST_PORT}`);
  };

  announce();
  setInterval(announce, 30_000);
}

// ---------------------------------------------------------------------------
// Minimal protobuf encoder/decoder for CastMessage
//
// CastMessage proto fields:
//   1  source_id       string
//   2  destination_id  string
//   3  namespace       string
//   4  payload_type    enum  (0 = STRING)
//   5  payload_binary  bytes
//   6  payload_utf8    string
// ---------------------------------------------------------------------------
function encodeVarint(n) {
  const bytes = [];
  while (n > 0x7f) { bytes.push((n & 0x7f) | 0x80); n >>>= 7; }
  bytes.push(n & 0x7f);
  return Buffer.from(bytes);
}

function readVarint(buf, off) {
  let result = 0, shift = 0, byte;
  do {
    byte = buf[off++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return { value: result, off };
}

function encodeString(tag, str) {
  const data = Buffer.from(str, "utf8");
  return Buffer.concat([
    Buffer.from([(tag << 3) | 2]),
    encodeVarint(data.length),
    data
  ]);
}

function encodeEnum(tag, val) {
  return Buffer.concat([Buffer.from([(tag << 3) | 0]), encodeVarint(val)]);
}

/** Encode a complete CastMessage ready to send (with 4-byte length prefix). */
function encodeCastMsg(srcId, dstId, ns, payload) {
  const body = Buffer.concat([
    encodeString(1, srcId),
    encodeString(2, dstId),
    encodeString(3, ns),
    encodeEnum(4, 0),                                      // STRING payload
    encodeString(6, typeof payload === "string" ? payload : JSON.stringify(payload))
  ]);
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(body.length, 0);
  return Buffer.concat([len, body]);
}

/** Decode a raw protobuf CastMessage buffer. */
function decodeCastMsg(buf) {
  const f = {};
  let i = 0;
  while (i < buf.length) {
    const tag = readVarint(buf, i);
    const field    = tag.value >> 3;
    const wireType = tag.value & 0x7;
    i = tag.off;
    if (wireType === 2) {
      const len = readVarint(buf, i);
      i = len.off;
      const data = buf.slice(i, i + len.value);
      f[field] = f[field] ? [...f[field], data] : [data];
      i += len.value;
    } else if (wireType === 0) {
      const v = readVarint(buf, i);
      f[field] = v.value;
      i = v.off;
    } else {
      break; // unknown wire type — bail
    }
  }
  return {
    sourceId:      (f[1]?.[0] ?? Buffer.alloc(0)).toString(),
    destinationId: (f[2]?.[0] ?? Buffer.alloc(0)).toString(),
    namespace:     (f[3]?.[0] ?? Buffer.alloc(0)).toString(),
    payloadType:   f[4] ?? 0,
    payload:       ((f[6] ?? f[5])?.[0] ?? Buffer.alloc(0)).toString()
  };
}

// ---------------------------------------------------------------------------
// Media player
// ---------------------------------------------------------------------------
let playerProc = null;

function buildPlayerArgs(url) {
  if (PLAYER === "mpv") {
    const args = ["--no-terminal", "--no-video"];
    if (AUDIO_BACKEND === "alsa") {
      args.push("--ao=alsa", `--alsa-device=${AUDIO_DEVICE}`);
    } else if (AUDIO_BACKEND === "pulseaudio") {
      args.push("--ao=pulse");
    } else if (AUDIO_BACKEND === "pipewire") {
      args.push("--ao=pipewire");
    }
    args.push(url);
    return { bin: "mpv", args };
  }
  // ffplay fallback
  return { bin: "ffplay", args: ["-nodisp", "-autoexit", url] };
}

function playURL(url, contentType) {
  if (playerProc) { playerProc.kill("SIGTERM"); playerProc = null; }

  const isVideo = contentType && !contentType.startsWith("audio/");
  log(`Playing${isVideo ? " (video)" : ""}: ${url}`);

  const { bin, args } = buildPlayerArgs(url);
  // For video content remove --no-video if mpv
  if (isVideo && PLAYER === "mpv") {
    const idx = args.indexOf("--no-video");
    if (idx !== -1) args.splice(idx, 1);
  }

  playerProc = spawn(bin, args, { stdio: "pipe" });

  playerProc.on("error", (e) => {
    const hint = e.code === "ENOENT"
      ? `${bin} not found — run: sudo apt install ${bin}`
      : e.message;
    error(`Player: ${hint}`);
    playerProc = null;
  });

  playerProc.on("exit", (code) => {
    log(`Player exited (code=${code})`);
    playerProc = null;
  });
}

function stopPlayer() {
  if (playerProc) { playerProc.kill("SIGTERM"); playerProc = null; }
}

// ---------------------------------------------------------------------------
// Cast session — one per connected sender (phone/browser)
// ---------------------------------------------------------------------------
class CastSession {
  constructor(socket) {
    this.socket      = socket;
    this.buf         = Buffer.alloc(0);
    this.transportId = `web:${crypto.randomBytes(4).toString("hex")}-1`;
    this.appId       = null;
    this.mediaState  = { status: "IDLE", currentTime: 0 };

    log(`Client connected: ${socket.remoteAddress}`);

    socket.on("data",  (chunk) => this.onData(chunk));
    socket.on("close", ()      => this.onClose());
    socket.on("error", (e)     => warn(`Socket: ${e.message}`));
  }

  // Accumulate data until we have a complete message, then dispatch.
  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 4) {
      const msgLen = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + msgLen) break;
      const raw     = this.buf.slice(4, 4 + msgLen);
      this.buf      = this.buf.slice(4 + msgLen);
      const msg = decodeCastMsg(raw);
      this.dispatch(msg);
    }
  }

  send(dstId, ns, payload) {
    try {
      this.socket.write(encodeCastMsg("CipherListen", dstId, ns, payload));
    } catch (e) {
      warn(`Send failed: ${e.message}`);
    }
  }

  // Route incoming messages to the right handler based on destination and namespace.
  dispatch({ sourceId, destinationId, namespace, payload }) {
    let data = {};
    try { data = JSON.parse(payload); } catch {}

    log(`<< ${namespace.split(".").pop()} [${sourceId}→${destinationId}] ${payload.slice(0, 100)}`);

    const ns = namespace;
    const isRecv      = destinationId === "receiver-0" || destinationId === "*";
    const isTransport = destinationId === this.transportId;

    // Heartbeat and connection management work on any destination.
    if (ns === "urn:x-cast:com.google.cast.tp.heartbeat") {
      if (data.type === "PING") this.send(sourceId, ns, JSON.stringify({ type: "PONG" }));
      return;
    }

    if (ns === "urn:x-cast:com.google.cast.tp.connection") {
      if (data.type === "CONNECT") {
        this.send(sourceId, ns, JSON.stringify({ type: "CONNECTED", gsv: "CipherListen/2.0" }));
      }
      return;
    }

    // Receiver control messages → always addressed to "receiver-0".
    if (isRecv && ns === "urn:x-cast:com.google.cast.receiver") {
      this.handleReceiver(sourceId, data);
      return;
    }

    // Media control messages → addressed to the per-session transport ID.
    if (isTransport && ns === "urn:x-cast:com.google.cast.media") {
      this.handleMedia(sourceId, data);
    }
  }

  // -------- Receiver namespace --------
  handleReceiver(srcId, data) {
    switch (data.type) {
      case "GET_STATUS":
        this.sendReceiverStatus(srcId, data.requestId);
        break;
      case "LAUNCH":
        this.appId = data.appId;
        log(`Launch app: ${this.appId}`);
        this.sendReceiverStatus(srcId, data.requestId, true);
        break;
      case "STOP":
        this.appId = null;
        stopPlayer();
        this.sendReceiverStatus(srcId, data.requestId);
        break;
      case "SET_VOLUME":
        log(`Volume: level=${data.volume?.level} muted=${data.volume?.muted}`);
        this.sendReceiverStatus(srcId, data.requestId);
        break;
    }
  }

  sendReceiverStatus(dstId, requestId, withApp = false) {
    const status = {
      type:      "RECEIVER_STATUS",
      requestId: requestId ?? 0,
      status: {
        volume: { level: 1.0, muted: false },
        applications: withApp && this.appId ? [{
          appId:       this.appId,
          displayName: DEVICE_NAME,
          statusText:  "CipherListen",
          sessionId:   this.transportId,
          transportId: this.transportId,
          namespaces:  [{ name: "urn:x-cast:com.google.cast.media" }]
        }] : []
      }
    };
    this.send(dstId, "urn:x-cast:com.google.cast.receiver", JSON.stringify(status));
  }

  // -------- Media namespace --------
  handleMedia(srcId, data) {
    switch (data.type) {
      case "LOAD": {
        const media = data.media ?? {};
        const url   = media.contentId || media.contentUrl || "";
        if (!url) { warn("LOAD received with no URL"); return; }
        this.mediaState = { status: "BUFFERING", currentTime: data.currentTime ?? 0 };
        this.sendMediaStatus(srcId, data.requestId, "BUFFERING", media);
        playURL(url, media.contentType || "");
        setTimeout(() => {
          this.mediaState.status = "PLAYING";
          this.sendMediaStatus(srcId, data.requestId, "PLAYING", media);
        }, 800);
        break;
      }
      case "STOP":
        stopPlayer();
        this.mediaState.status = "IDLE";
        this.sendMediaStatus(srcId, data.requestId, "IDLE");
        break;
      case "PAUSE":
        // mpv supports SIGSTOP, but most audio streams can't really pause without buffering.
        warn("PAUSE requested (not yet fully implemented)");
        this.sendMediaStatus(srcId, data.requestId, "PAUSED");
        break;
      case "PLAY":
        this.sendMediaStatus(srcId, data.requestId, this.mediaState.status || "PLAYING");
        break;
      case "GET_STATUS":
        this.sendMediaStatus(srcId, data.requestId, this.mediaState.status || "IDLE");
        break;
      case "SEEK":
        this.sendMediaStatus(srcId, data.requestId, this.mediaState.status || "PLAYING");
        break;
    }
  }

  sendMediaStatus(dstId, requestId, playerState, media = {}) {
    const status = {
      type:      "MEDIA_STATUS",
      requestId: requestId ?? 0,
      status: [{
        mediaSessionId:         1,
        playbackRate:           1,
        playerState,
        currentTime:            this.mediaState.currentTime ?? 0,
        supportedMediaCommands: 15,
        volume:                 { level: 1.0, muted: false },
        media:                  { contentId: media.contentId ?? "", contentType: media.contentType ?? "", streamType: "BUFFERED" }
      }]
    };
    this.send(dstId, "urn:x-cast:com.google.cast.media", JSON.stringify(status));
  }

  onClose() {
    log(`Client disconnected: ${this.socket.remoteAddress}`);
    stopPlayer();
  }
}

// ---------------------------------------------------------------------------
// TLS server on port 8009
// ---------------------------------------------------------------------------
function startServer() {
  const { key, cert } = ensureCert();

  const server = tls.createServer(
    { key, cert, rejectUnauthorized: false, requestCert: false },
    (socket) => new CastSession(socket)
  );

  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      error(`Port ${CAST_PORT} already in use. Change cast.port in config/default.json.`);
    } else {
      error(`TLS server: ${e.message}`);
    }
    process.exit(1);
  });

  server.listen(CAST_PORT, "0.0.0.0", () => {
    log(`Cast receiver listening on port ${CAST_PORT}`);
    startMDNS();
  });
}

// ---------------------------------------------------------------------------
// Bootstrap + graceful shutdown
// ---------------------------------------------------------------------------
startServer();

function shutdown() {
  log("Cast receiver shutting down...");
  stopPlayer();
  if (mdns) mdns.destroy();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT",  shutdown);
