"use strict";

const { spawn } = require("child_process");
const path      = require("path");
const fs        = require("fs");
const express   = require("express");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CONFIG_PATH = path.join(__dirname, "../config/default.json");

const DEFAULTS = {
  port:         7171,
  audioBackend: "alsa",
  audioDevice:  "default",
  spotify: { enabled: true,  autostart: true, deviceName: "CipherListen", bitrate: 320, volume: 100 },
  airplay: { enabled: true,  autostart: true, deviceName: "CipherListen", password: "",  port: 1247 },
  cast:    { enabled: true,  autostart: true, deviceName: "CipherListen", port: 8009,    playerPath: "mpv" }
};

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2));
    return DEFAULTS;
  }

  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

  // ── Backward-compat migration ──────────────────────────────────────────
  // The original CipherListen used a flat config with top-level deviceName,
  // bitrate, audioBackend, etc. If we detect that shape, migrate it forward.
  if (raw.deviceName && !raw.spotify) {
    const migrated = {
      port:         raw.port         ?? DEFAULTS.port,
      audioBackend: raw.audioBackend ?? DEFAULTS.audioBackend,
      audioDevice:  raw.audioDevice  ?? DEFAULTS.audioDevice,
      spotify: {
        enabled:    true,
        autostart:  raw.autostart ?? true,
        deviceName: raw.deviceName,
        bitrate:    raw.bitrate   ?? 320,
        volume:     raw.volume    ?? 100
      },
      airplay: { ...DEFAULTS.airplay },
      cast:    { ...DEFAULTS.cast }
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(migrated, null, 2));
    broadcastLog("system", "Config migrated to the current format (multi-protocol).", "info");
    return migrated;
  }

  // Deep-merge with defaults so any new keys added in future updates are picked up.
  return deepMerge(DEFAULTS, raw);
}

function saveConfig(updated) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2));
}

function deepMerge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof base[k] === "object") {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// SSE log bus (all protocol daemons share this)
// ---------------------------------------------------------------------------
const sseClients = new Set();
const logBuffer  = [];                // ring buffer for late-joining clients

function broadcastLog(protocol, message, level = "info") {
  if (!message || !message.trim()) return;
  const entry = { time: new Date().toISOString(), protocol, message: message.trim(), level };
  logBuffer.push(entry);
  if (logBuffer.length > 500) logBuffer.shift();
  const data = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of sseClients) res.write(data);
  const prefix = `[${protocol.toUpperCase().padEnd(7)}] [${level.toUpperCase().padEnd(5)}]`;
  console.log(`${prefix} ${message.trim()}`);
}

// ---------------------------------------------------------------------------
// Process manager factory
// Keeps track of running child processes per protocol and wires up their
// stdout/stderr into the shared SSE log bus.
// ---------------------------------------------------------------------------
const procs = { spotify: null, airplay: null, cast: null };

function spawnDaemon({ protocol, bin, args, onError, env }) {
  if (procs[protocol]) {
    procs[protocol].kill("SIGTERM");
    procs[protocol] = null;
  }

  broadcastLog(protocol, `Starting: ${bin} ${args.join(" ")}`);

  const child = spawn(bin, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env:   env ? { ...process.env, ...env } : undefined
  });

  procs[protocol] = child;

  child.stdout.on("data", (d) => broadcastLog(protocol, d.toString(), "info"));
  child.stderr.on("data", (d) => {
    // shairport-sync writes normal output to stderr, so don't always mark as error
    const msg = d.toString().trim();
    const isErr = msg.toLowerCase().includes("error") || msg.toLowerCase().includes("fail");
    broadcastLog(protocol, msg, isErr ? "error" : "info");
  });

  child.on("exit", (code, signal) => {
    broadcastLog(protocol, `Exited (code=${code} signal=${signal})`, code === 0 ? "info" : "error");
    procs[protocol] = null;
  });

  child.on("error", (err) => {
    const msg = err.code === "ENOENT"
      ? (onError ?? `${bin} not found — check install.sh`)
      : err.message;
    broadcastLog(protocol, msg, "error");
    procs[protocol] = null;
  });

  return child;
}

function killDaemon(protocol) {
  if (procs[protocol]) {
    procs[protocol].kill("SIGTERM");
    procs[protocol] = null;
    broadcastLog(protocol, "Stopped.", "info");
  }
}

// ---------------------------------------------------------------------------
// Spotify Connect — librespot
// ---------------------------------------------------------------------------
function startSpotify() {
  const cfg = loadConfig();
  const sp  = cfg.spotify;
  if (!sp.enabled) { broadcastLog("spotify", "Disabled in config.", "warn"); return; }

  spawnDaemon({
    protocol: "spotify",
    bin:      "librespot",
    args: [
      "--name",           sp.deviceName,
      "--bitrate",        String(sp.bitrate),
      "--backend",        cfg.audioBackend,
      "--device",         cfg.audioDevice,
      "--volume-ctrl",    "linear",
      "--initial-volume", String(sp.volume)
    ],
    onError: "librespot not found — run: sudo apt install librespot"
  });
}

// ---------------------------------------------------------------------------
// AirPlay — shairport-sync
//
// shairport-sync maps backends differently from librespot:
//   ALSA       → --output alsa  (then -- -d <device> after the double-dash)
//   PulseAudio → --output pa
//   PipeWire   → --output pw
// ---------------------------------------------------------------------------
function shairportOutput(cfg) {
  switch (cfg.audioBackend) {
    case "pulseaudio": return { flags: ["--output", "pa"],  extra: [] };
    case "pipewire":   return { flags: ["--output", "pw"],  extra: [] };
    default:
      // ALSA — pass device via the -- separator if it's not "default"
      return {
        flags: ["--output", "alsa"],
        extra: cfg.audioDevice && cfg.audioDevice !== "default"
          ? ["--", "-d", cfg.audioDevice]
          : []
      };
  }
}

function startAirPlay() {
  const cfg = loadConfig();
  const ap  = cfg.airplay;
  if (!ap.enabled) { broadcastLog("airplay", "Disabled in config.", "warn"); return; }

  const out  = shairportOutput(cfg);
  const args = [
    "--name",  ap.deviceName,
    "--port",  String(ap.port || 1247),
    ...out.flags,
    ...(ap.password ? ["--password", ap.password] : []),
    ...out.extra
  ];

  spawnDaemon({
    protocol: "airplay",
    bin:      "shairport-sync",
    args,
    onError:  "shairport-sync not found — run: sudo apt install shairport-sync"
  });
}

// ---------------------------------------------------------------------------
// Google Cast — cast-receiver.js child process
// ---------------------------------------------------------------------------
function startCast() {
  const cfg    = loadConfig();
  const cast   = cfg.cast;
  if (!cast.enabled) { broadcastLog("cast", "Disabled in config.", "warn"); return; }

  const script = path.join(__dirname, "cast-receiver.js");
  if (!fs.existsSync(script)) {
    broadcastLog("cast", "cast-receiver.js missing!", "error");
    return;
  }

  spawnDaemon({
    protocol: "cast",
    bin:      "node",
    args:     [script],
    env: {
      CAST_DEVICE_NAME:  cast.deviceName,
      CAST_PORT:         String(cast.port || 8009),
      CAST_PLAYER:       cast.playerPath || "mpv",
      AUDIO_BACKEND:     cfg.audioBackend,
      AUDIO_DEVICE:      cfg.audioDevice
    },
    onError: "Failed to start Cast receiver (node not found?)"
  });
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// ── SSE endpoint ────────────────────────────────────────────────────────────
app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.flushHeaders();

  // Replay the last 60 log lines so the page isn't blank on (re)load.
  for (const entry of logBuffer.slice(-60)) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

// ── Status ───────────────────────────────────────────────────────────────────
app.get("/api/status", (_req, res) => {
  res.json({
    spotify: { running: !!procs.spotify, pid: procs.spotify?.pid ?? null },
    airplay: { running: !!procs.airplay, pid: procs.airplay?.pid ?? null },
    cast:    { running: !!procs.cast,    pid: procs.cast?.pid    ?? null }
  });
});

// ── Config ───────────────────────────────────────────────────────────────────
app.get("/api/config", (_req, res) => res.json(loadConfig()));

app.post("/api/config", (req, res) => {
  const updated = deepMerge(loadConfig(), req.body);
  saveConfig(updated);
  broadcastLog("system", "Config saved.", "info");
  res.json({ ok: true, config: updated });
});

// ── Per-protocol controls ────────────────────────────────────────────────────
const starters = { spotify: startSpotify, airplay: startAirPlay, cast: startCast };
const stoppers = { spotify: () => killDaemon("spotify"), airplay: () => killDaemon("airplay"), cast: () => killDaemon("cast") };

for (const proto of ["spotify", "airplay", "cast"]) {
  app.post(`/api/${proto}/start`,   (_req, res) => { starters[proto](); res.json({ ok: true }); });
  app.post(`/api/${proto}/stop`,    (_req, res) => { stoppers[proto](); res.json({ ok: true }); });
  app.post(`/api/${proto}/restart`, (_req, res) => {
    stoppers[proto]();
    setTimeout(() => starters[proto](), 400);
    res.json({ ok: true });
  });
}

// ── Legacy endpoints (kept for backward compat with old UI bookmarks) ────────
app.post("/api/restart", (_req, res) => { startSpotify(); res.json({ ok: true }); });
app.post("/api/stop",    (_req, res) => { killDaemon("spotify"); res.json({ ok: true }); });

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const cfg  = loadConfig();
const PORT = cfg.port || 7171;

app.listen(PORT, () => {
  broadcastLog("system", `CipherListen web UI at http://localhost:${PORT}`, "info");
});

if (cfg.spotify?.autostart !== false) startSpotify();
if (cfg.airplay?.autostart !== false) startAirPlay();
if (cfg.cast?.autostart    !== false) startCast();

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
function shutdown(sig) {
  broadcastLog("system", `${sig} received — shutting down all daemons...`, "info");
  for (const proto of Object.keys(procs)) killDaemon(proto);
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
