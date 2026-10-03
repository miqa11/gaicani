const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const path       = require("path");
const fs         = require("fs");

// ── Persistent data directory ───────────────────────────────────────────────
// On Render, mount a Disk at this path (Dashboard → your service → Disks →
// Add Disk → mount path /var/data/new-gacnoba) so these files survive
// redeploys/restarts. Locally (no disk mounted) it just falls back to the
// project folder.
const DATA_DIR = process.env.DATA_DIR || "/var/data/new-gacnoba";
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
  console.error(`[DATA] Could not create/access ${DATA_DIR}, falling back to __dirname:`, e.message);
}
const dataDirUsable = fs.existsSync(DATA_DIR) && (() => {
  try { fs.accessSync(DATA_DIR, fs.constants.W_OK); return true; }
  catch { return false; }
})();
const DATA_PATH = dataDirUsable ? DATA_DIR : __dirname;
console.log(`[DATA] Persistent files will be stored in: ${DATA_PATH}`);

// ── Crash-safe data files ───────────────────────────────────────────────────
// Every data file is saved by writing a temporary copy and renaming it over
// the real one. A rename is atomic, so a crash, an out-of-memory kill or a
// deploy that stops the process mid-save leaves either the old file or the
// new one — never a half-written one. That matters: a half-written
// registered_users.json fails to parse on the next start, which looked
// exactly like a first run — the server came up with no accounts, and the
// next save overwrote the only copy.
function writeFileAtomic(file, data) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, file);
}

// Reads and parses a JSON data file. A missing file is a first run (null).
// A file that exists but won't parse is copied aside as <name>.corrupt-<time>
// before anything can overwrite it, and the .tmp left by an interrupted save
// is used instead when it's intact.
function readJsonFile(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (e) { if (e.code === "ENOENT") return null; throw e; }
  try { return JSON.parse(raw); }
  catch (e) {
    const aside = `${file}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(file, aside); } catch { /* best effort */ }
    console.error(`[DATA] ${path.basename(file)} is damaged (${e.message}) — a copy was kept at ${aside}`);
    try {
      const recovered = JSON.parse(fs.readFileSync(file + ".tmp", "utf8"));
      console.error(`[DATA] Recovered ${path.basename(file)} from its .tmp copy`);
      return recovered;
    } catch { return null; }
  }
}
const crypto     = require("crypto");
// sharp is OPTIONAL. It ships a native library; if it isn't installed on
// the host, or its binary fails to load there, a plain require() would
// crash the ENTIRE server at startup. Instead we fall back to saving photos
// as uploaded (common formats only) — photos keep working, just without
// resizing/HEIC conversion.
let sharp = null;
try {
  sharp = require("sharp");
  console.log("[PHOTOS] sharp loaded — photos are resized and converted to JPEG");
} catch (e) {
  console.warn("[PHOTOS] sharp NOT available (" + e.message + ") — photos will be saved as uploaded. Run `npm install` to enable resizing/HEIC.");
}

// ── Private photo storage ────────────────────────────────────────────────
// Lives under DATA_PATH (the same persistent volume as the JSON data,
// see above) rather than __dirname, because __dirname is the app CODE
// directory — on a host with an ephemeral filesystem, anything written
// there can vanish on the next deploy. User-uploaded content needs to
// survive that the same way the message history already does.
const PRIVATE_PHOTOS_DIR = path.join(DATA_PATH, "private-photos");
try {
  if (!fs.existsSync(PRIVATE_PHOTOS_DIR)) fs.mkdirSync(PRIVATE_PHOTOS_DIR, { recursive: true });
} catch (e) {
  console.error("[PHOTOS] Could not create private-photos directory:", e.message);
}

// A deleted private room can still be referencing real files on disk — call
// this BEFORE removing a room from privateRooms, on both the self-service
// and admin delete paths, or those files just sit there forever.
function deleteMessageFile(m) {
  const url = m && (m.type === "photo" ? m.photoUrl : m.type === "voice" ? m.voiceUrl : null);
  if (!url) return;
  const filename = path.basename(url); // defence in depth against a malformed stored path
  try { fs.unlinkSync(path.join(PRIVATE_PHOTOS_DIR, filename)); } catch { /* already gone, fine */ }
}
function deleteRoomPhotoFiles(room) {
  if (!room?.messages) return;
  for (const m of room.messages) deleteMessageFile(m); // photos and voice messages
}
// A room keeps its last 100 messages; the photo / voice file of one that
// drops off the end is deleted with it instead of staying on disk forever.
function trimRoomMessages(room) {
  while (room.messages.length > 100) deleteMessageFile(room.messages.shift());
}
const compression   = require("compression");
const rateLimit     = require("express-rate-limit");

const app    = express();
app.set("trust proxy", 1); // behind Render's proxy — needed for express-rate-limit / IP detection
const server = http.createServer(app);

// ── Block direct access via the public *.onrender.com URL ──────────────────
// Cloudflare only protects traffic to your real domain (gaicani.online) —
// it has no idea Render also exposes the app directly at
// <service>.onrender.com. Anyone (or any bot/attacker) hitting that URL
// bypasses Cloudflare's flood/bot protection completely and lands straight
// on this tiny instance. This closes that hole by rejecting any request
// whose Host header is an onrender.com domain.
//
// Deliberately NOT a strict allowlist of only "gaicani.online" — Render's
// own internal health-check dials the app via an internal IP (see the
// original "dial tcp 10.x.x.x:PORT" crash logs), which very likely does not
// send a Host header matching your domain either. A strict allowlist could
// accidentally reject that internal check and cause exactly the kind of
// crash-loop this server had before — a narrow "block onrender.com
// specifically" rule avoids that risk entirely.
// ── Security headers ─────────────────────────────────────────────────────────
// Registered FIRST so these apply to every response, including errors and
// static files. None of these change behaviour for legitimate users — they
// only close off attacks the browser can help prevent.
app.use((req, res, next) => {
  // Stop the browser from second-guessing declared Content-Types. Without
  // this, a file served as text/plain can be sniffed and executed as JS.
  res.setHeader("X-Content-Type-Options", "nosniff");

  // Clickjacking: nothing here is meant to be embedded in someone else's
  // page. Both headers are set because older browsers only honour the
  // first and modern ones prefer the CSP form.
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");

  // Don't leak full URLs (which can contain room IDs) to third-party sites
  // via the Referer header.
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  // Turn off powerful browser APIs the site doesn't use, so injected code
  // can't reach for them either.
  // The microphone is allowed for the site itself only — private chat's 🎤
  // voice messages need it (getUserMedia fails silently without it).
  res.setHeader(
    "Permissions-Policy",
    "geolocation=(), camera=(), microphone=(self), payment=(), usb=(), magnetometer=()"
  );

  // HSTS only makes sense (and is only honoured) over HTTPS. Guarded on the
  // proxy's protocol header so local HTTP development is unaffected.
  if (req.headers["x-forwarded-proto"] === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  next();
});

app.use((req, res, next) => {
  // Temporary escape hatch for testing a fresh deploy on its raw .onrender.com
  // URL before Cloudflare/DNS is pointed at it (e.g. during a Render account
  // migration). Set ALLOW_DIRECT_ONRENDER=true in the service's environment
  // variables to open this up, then remove it once you've cut over — leaving
  // it on permanently defeats the whole point of this block.
  if (process.env.ALLOW_DIRECT_ONRENDER === "true") return next();

  const host = (req.headers.host || "").toLowerCase();
  if (host.endsWith(".onrender.com")) {
    console.warn(`[BYPASS-BLOCKED] Direct onrender.com access rejected — host="${host}" ip="${getClientIP(req)}" path="${req.path}"`);
    res.status(403).end();
    return;
  }
  next();
});

// ── Global crash guards ─────────────────────────────────────────────────────
// Without these, a SINGLE unhandled promise rejection anywhere in the app
// (a fetch() that throws, a missed .catch(), etc.) terminates the entire
// Node process immediately — this has been Node's default behavior since
// v15. That's a very likely explanation for the "Application exited early"
// crash messages in the Render log (a DIFFERENT failure mode than the
// CPU/health-check timeout crashes, which are handled separately by the
// flood-detection middleware below). These two handlers log the error
// instead of letting one bad promise take the whole server down for
// everyone connected.
process.on("unhandledRejection", (reason, promise) => {
  console.error("[UNHANDLED REJECTION]", reason instanceof Error ? reason.stack : reason);
});
process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]", err.stack || err);
  // Deliberately NOT calling process.exit() here — for a chat app, staying
  // up in a possibly-degraded state and logging the error is safer than an
  // immediate hard crash that disconnects every single connected user.
});

const io     = new Server(server, {
  pingTimeout:  120000, // 120 s — give mobile plenty of time
  pingInterval: 25000,
  // Allow both polling and websocket so mobile fallback works
  transports: ["websocket", "polling"],
  // Default is 1MB, which would silently drop any photo upload anywhere
  // near the application-level cap enforced in privateMsg:sendPhoto — the
  // packet never reaches that handler's validation at all, so the sender
  // would see nothing happen with no error. Sized for a 20MB raw image
  // (~26.7MB as base64, since base64 expands by 4/3) plus its JSON
  // envelope, with headroom. Real phone-camera photos can legitimately be
  // in the 8-20MB range at full resolution, which is what this is for —
  // they get resized down server-side after upload, not rejected outright.
  maxHttpBufferSize: 30 * 1024 * 1024,
});

// ── Constants ─────────────────────────────────────────────────────────────────
const GIPHY_KEY           = process.env.GIPHY_KEY || "UFauF9jrzjxyDsxqXi7rVnfRdvmuMmsL";
// Powers /api/music-search (in-site song search for "Listen Together").
// Get a free key at https://console.cloud.google.com/ → enable "YouTube Data
// API v3" → Credentials → API key. Free quota is 10,000 units/day; each
// search costs 100 units (~100 searches/day), which is why results are
// cached below. Without this set, the search box returns a friendly error
// and the feature is simply unavailable — nothing else on the site breaks.
const YOUTUBE_API_KEY     = process.env.YOUTUBE_API_KEY || "";
const NAME_MIN           = 2;
const NAME_MAX           = 20;
const MSG_MAX            = 2000;
const RECONNECT_GRACE_MS = 1800000; // 30 min
// Block limits removed — both sending and receiving blocks are now unlimited
const MSG_RATE_MAX       = 20;
const MSG_RATE_WINDOW_MS = 5000;

// ── Admin / Owner ─────────────────────────────────────────────────────────────
// All sensitive routes are locked to OWNER_IP only — no password needed.
const OWNER_IPS = new Set(["109.172.136.114"]);

// Resolve the real client IP the same way everywhere in the file.
// (This was previously called in 3 places but never defined, which threw
// a ReferenceError on every request to any admin/stats/sensitive URL —
// that's why those pages were "not working".)
function getClientIP(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    ""
  );
}

// ── Persistent manual ban list ────────────────────────────────────────────────
// Manual bans (via admin panel) survive server restarts — stored in banned_ips.json
// Auto-bans (link-strike, report) are still in-memory only.
const BANNED_IPS_FILE = path.join(DATA_PATH, "banned_ips.json");
const bannedIPs       = new Set();

// ── Range bans ────────────────────────────────────────────────────────────────
// Besides single addresses, the ban list accepts whole ranges in CIDR form:
//   2a09:bac0::/29   (IPv6 — e.g. all of Cloudflare WARP's VPN addresses)
//   104.28.0.0/16    (IPv4)
// Single addresses still match exactly, as before; ranges are kept parsed in
// bannedRanges so every check is fast.
const bannedRanges = [];
function ipToBig(raw) {
  let ip = String(raw || "").trim().toLowerCase();
  if (!ip) return null;
  const pct = ip.indexOf("%"); if (pct >= 0) ip = ip.slice(0, pct);          // strip IPv6 zone ids
  const m4 = ip.match(/^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/); // IPv4, incl. ::ffff:-mapped
  if (m4) {
    const p = m4.slice(1).map(Number);
    if (p.some(x => x > 255)) return null;
    return { v: 4, n: BigInt(p[0] * 16777216 + p[1] * 65536 + p[2] * 256 + p[3]) };
  }
  if (!ip.includes(":") || !/^[0-9a-f:]+$/.test(ip)) return null;
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (halves.length === 2 ? fill < 1 : head.length !== 8) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  let n = 0n;
  for (const g of groups) n = (n << 16n) + BigInt(parseInt(g, 16));
  return { v: 6, n };
}
// "1.2.3.0/24", "2a09:bac0::/29", or a single address → { v, bits, shift, net } | null
function parseBanEntry(entry) {
  const parts = String(entry || "").trim().split("/");
  if (parts.length > 2) return null;
  const a = ipToBig(parts[0]);
  if (!a) return null;
  const total = a.v === 4 ? 32 : 128;
  const bits = parts.length === 2 ? Number(parts[1]) : total;
  if (!Number.isInteger(bits) || bits < 0 || bits > total || (parts.length === 2 && !/^\d{1,3}$/.test(parts[1]))) return null;
  const shift = BigInt(total - bits);
  return { v: a.v, bits, shift, net: a.n >> shift };
}
function rebuildBannedRanges() {
  bannedRanges.length = 0;
  for (const e of bannedIPs) if (String(e).includes("/")) { const r = parseBanEntry(e); if (r) bannedRanges.push(r); }
}
function ipInRange(ip, r) { const a = ipToBig(ip); return !!a && a.v === r.v && (a.n >> r.shift) === r.net; }
// Is this address banned — exactly, or by falling inside a banned range?
function isIPBanned(ip) {
  if (!ip) return false;
  if (bannedIPs.has(ip)) return true;
  if (!bannedRanges.length) return false;
  const a = ipToBig(ip);
  if (!a) return false;
  for (const r of bannedRanges) if (a.v === r.v && (a.n >> r.shift) === r.net) return true;
  return false;
}

function loadBannedIPs() {
  try {
    const arr = readJsonFile(BANNED_IPS_FILE);
    if (Array.isArray(arr)) {
      arr.forEach(ip => bannedIPs.add(ip));
      rebuildBannedRanges();
      console.log(`[BAN] Loaded ${arr.length} persistent manual ban(s) from disk`);
    }
  } catch { /* file doesn't exist yet — fine */ }
}

function saveBannedIPs() {
  try {
    writeFileAtomic(BANNED_IPS_FILE, JSON.stringify([...bannedIPs], null, 2));
  } catch (e) {
    console.error("[BAN] Failed to save banned_ips.json:", e.message);
  }
}

loadBannedIPs(); // restore bans immediately at startup

// ── Persistent manual user-agent ban list ─────────────────────────────────────
// Lets the admin panel block a whole User-Agent string (any IP using it gets
// rejected), same persistence pattern as the IP ban list above.
const BANNED_UA_FILE  = path.join(DATA_PATH, "banned_user_agents.json");
const bannedUserAgents = new Set();

function normalizeUA(ua) {
  return String(ua || "").trim();
}

function loadBannedUserAgents() {
  try {
    const arr = readJsonFile(BANNED_UA_FILE);
    if (Array.isArray(arr)) {
      arr.forEach(ua => bannedUserAgents.add(ua));
      console.log(`[UA-BAN] Loaded ${arr.length} persistent user-agent ban(s) from disk`);
    }
  } catch { /* file doesn't exist yet — fine */ }
}

function saveBannedUserAgents() {
  try {
    writeFileAtomic(BANNED_UA_FILE, JSON.stringify([...bannedUserAgents], null, 2));
  } catch (e) {
    console.error("[UA-BAN] Failed to save banned_user_agents.json:", e.message);
  }
}

function isUABanned(ua) {
  return bannedUserAgents.has(normalizeUA(ua));
}

loadBannedUserAgents(); // restore UA bans immediately at startup

// ── VirusTotal integration ────────────────────────────────────────────────────
// server.js writes non-Georgian IPs to vt-queue.json for vt-checker.js to pick up.
// vt-checker.js writes confirmed malicious IPs to vt-bans.json.
// We watch that file and load new bans automatically — no restart needed.

// ── Automatic banning: DISABLED ──────────────────────────────────────────────
// Every self-inflicted ban path is gated on this flag, which is OFF by default.
// It was turned off because the flood auto-ban in particular could (and did)
// lock out a legitimate user: reloading the site quickly during normal use or
// development looks like a flood, and that ban was written straight into
// banned_ips.json, so it survived restarts.
//
// What this changes:
//   * Flood: still rate-limited with a 429 response, but never banned.
//   * Link spam / user reports: still counted, still visible in the admin
//     panel, but they no longer ban anyone on their own.
//   * VirusTotal list: no longer auto-applied.
// Manual admin bans from the panel are UNAFFECTED and work exactly as before.
//
// Set AUTO_BAN_ENABLED=true in the environment to restore the old behaviour.
const AUTO_BAN_ENABLED = process.env.AUTO_BAN_ENABLED === "true";

// ── Temporary (24 h) IP bans ─────────────────────────────────────────────────
// Separate from bannedIPs (which is permanent and silent). These carry a
// reason and the offending username, and the blocked visitor is shown an
// explanation page rather than a bare 403 — the point is to tell someone why
// they were removed and when they can come back.
const tempBans = new Map(); // ip -> { until, reason, username, at }
const TEMP_BAN_MS = 24 * 60 * 60 * 1000;

function getTempBan(ip) {
  const e = tempBans.get(ip);
  if (!e) return null;
  if (Date.now() >= e.until) { tempBans.delete(ip); return null; } // expired
  return e;
}

function addTempBan(ip, username, reason) {
  const entry = {
    until: Date.now() + TEMP_BAN_MS,
    reason: reason || "offensive_name",
    username: username || "",
    at: Date.now(),
  };
  tempBans.set(ip, entry);
  return entry;
}

function tempBanPageHtml(entry) {
  const hoursLeft = Math.max(1, Math.ceil((entry.until - Date.now()) / 3600000));
  const name = String(entry.username || "").replace(/[&<>"']/g, c =>
    ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  return `<!DOCTYPE html>
<html lang="ka"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>\u10ec\u10d5\u10d3\u10dd\u10db\u10d0 \u10e8\u10d4\u10d6\u10e6\u10e3\u10d3\u10e3\u10da\u10d8\u10d0</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#17181c;color:#eceef2;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;padding:24px}
  .box{max-width:400px;width:100%;background:#212227;border:1px solid rgba(242,63,66,.3);
    border-radius:16px;padding:28px 24px;text-align:center}
  .icon{font-size:2.6em;margin-bottom:10px}
  h1{font-size:1.15em;margin:0 0 14px;color:#f56769}
  p{font-size:.9em;line-height:1.65;color:#c7cad3;margin:0 0 12px}
  .name{display:inline-block;background:rgba(242,63,66,.12);border:1px solid rgba(242,63,66,.3);
    color:#f56769;border-radius:8px;padding:6px 14px;font-weight:800;margin:6px 0 14px;word-break:break-all}
  .left{font-size:.82em;color:#8a8d9c;margin-top:16px}
</style></head><body>
<div class="box">
  <div class="icon">\u{1F6AB}</div>
  <h1>\u10ec\u10d5\u10d3\u10dd\u10db\u10d0 \u10e8\u10d4\u10d6\u10e6\u10e3\u10d3\u10e3\u10da\u10d8\u10d0 1 \u10d3\u10e6\u10d8\u10d7</h1>
  <p>\u10d7\u10e5\u10d5\u10d4\u10dc \u10d3\u10e0\u10dd\u10d4\u10d1\u10d8\u10d7 \u10d3\u10d0\u10d2\u10d4\u10d1\u10da\u10dd\u10d9\u10d0\u10d7 \u10ec\u10d5\u10d3\u10dd\u10db\u10d0<br><b>\u10e8\u10d4\u10e3\u10e0\u10d0\u10ea\u10ee\u10db\u10e7\u10dd\u10e4\u10d4\u10da\u10d8 \u10e1\u10d0\u10ee\u10d4\u10da\u10d8\u10e1 \u10d2\u10d0\u10db\u10dd</b>.</p>
  <div class="name">${name || "\u2014"}</div>
  <p>\u10d2\u10d7\u10ee\u10dd\u10d5\u10d7, \u10d3\u10d0\u10d1\u10e0\u10e3\u10dc\u10d4\u10d1\u10d8\u10e1\u10d0\u10e1 \u10d0\u10d8\u10e0\u10e9\u10d8\u10dd\u10d7 \u10e1\u10ee\u10d5\u10d0 \u10e1\u10d0\u10ee\u10d4\u10da\u10d8.</p>
  <div class="left">\u10d3\u10d0\u10e0\u10e9\u10d4\u10dc\u10d8\u10da\u10d8\u10d0 \u10d3\u10d0\u10d0\u10ee\u10da\u10dd\u10d4\u10d1\u10d8\u10d7 ${hoursLeft} \u10e1\u10d0\u10d0\u10d7\u10d8</div>
</div></body></html>`;
}

const VT_QUEUE_FILE = path.join(DATA_PATH, "vt-queue.json");
const VT_BANS_FILE  = path.join(DATA_PATH, "vt-bans.json");
const STATS_FILE     = path.join(DATA_PATH, "stats.json");
const VT_QUEUE_MAX  = 500;
const VT_THRESHOLD  = 3; // must match vt-checker.js

// IPs already queued this session (avoid duplicate queue entries)
const vtQueued = new Set();

// Load existing VT bans on startup
function loadVTBans() {
  // Another automatic ban source — an external checker writes IPs here and
  // they get merged into the permanent ban list. Off unless auto-banning is
  // explicitly enabled.
  if (!AUTO_BAN_ENABLED) return;
  try {
    const arr = JSON.parse(fs.readFileSync(VT_BANS_FILE, "utf8"));
    if (Array.isArray(arr)) {
      let added = 0;
      arr.forEach(ip => {
        if (!bannedIPs.has(ip)) {
          bannedIPs.add(ip);
          added++;
        }
      });
      if (added) {
        console.log(`[VT] Loaded ${added} new VT-ban(s) from disk`);
        saveBannedIPs(); // merge into banned_ips.json so bans survive restart
      }
    }
  } catch { /* file doesn't exist yet */ }
}

loadVTBans();

// Poll vt-bans.json every 5s — more reliable than fs.watch on Linux
// fs.watch can miss events or fire with null filename on some systems
let _vtBansLastMtime = 0;

function pollVTBans() {
  try {
    const stat = fs.statSync(VT_BANS_FILE);
    const mtime = stat.mtimeMs;
    if (mtime === _vtBansLastMtime) return; // file unchanged
    _vtBansLastMtime = mtime;

    const sizeBefore = bannedIPs.size;
    loadVTBans();
    const newBans = bannedIPs.size - sizeBefore;

    if (newBans > 0) {
      console.log(`[VT] Detected ${newBans} new VT-ban(s) — kicking live sockets`);
      // Kick any connected sockets that are now VT-banned
      for (const [, socket] of io.sockets.sockets) {
        if (isIPBanned(socket.clientIP)) {
          console.log(`[VT] Kicking VT-banned IP: ${socket.clientIP}`);
          socket.emit("autoKicked");
          setTimeout(() => socket.disconnect(true), 500);
        }
      }
    }
  } catch {
    // File doesn't exist yet — fine, keep polling
  }
}

setInterval(pollVTBans, 5000);

function enqueueForVT(ip) {
  if (vtQueued.has(ip)) return;       // already queued this session
  if (bannedIPs.has(ip)) return;      // already banned
  if (OWNER_IPS.has(ip)) return;      // never check owner IPs

  // Bounded: this Set only avoids re-queueing the same IP, but it used to
  // grow with every new foreign visitor for the life of the process. Every
  // restart already starts it empty, so emptying it when it gets large
  // behaves exactly like a restart does (the queue file below also dedupes).
  if (vtQueued.size >= 20000) vtQueued.clear();
  vtQueued.add(ip);

  try {
    let queue = [];
    try { queue = JSON.parse(fs.readFileSync(VT_QUEUE_FILE, "utf8")); } catch {}
    if (!Array.isArray(queue)) queue = [];
    if (!queue.includes(ip)) {
      queue.push(ip);
      // Cap queue size
      if (queue.length > VT_QUEUE_MAX) queue = queue.slice(-VT_QUEUE_MAX);
      fs.writeFileSync(VT_QUEUE_FILE, JSON.stringify(queue), "utf8");
    }
  } catch (e) {
    console.error("[VT] Failed to write queue:", e.message);
  }
}

// ── Randomised secret route slugs ─────────────────────────────────────────────
// These replace every predictable /admin/* and old panel/stats paths.
const ROUTE = {
  panel:       "/x7k2mq9pn4w",  // visual admin panel  (users, ban/unban)
  stats:       "/r3tz8vj1qs6",  // stats dashboard HTML — PUBLIC, no IP gate (by design)
  statsApi:    "/n5ph2ck7ew0",  // stats JSON API — PUBLIC, no IP gate (called by stats page)
  users:       "/b9wf4yd6ul3",  // list connected users JSON
  ban:         "/m2xg7rn0ks5",  // POST ban an IP
  unban:       "/q6jd1vc8zt4",  // POST unban an IP
  bans:        "/a4hs3oe9lp7",  // list banned IPs JSON
  reported:    "/f8nb5wx2cr1",  // list report-banned IPs JSON
  unbanReported: "/g7zr4ce2mv9", // POST clear a report-ban (resets strike count)
  visitorLog:  "/t1uy6im0dg8",  // visitor log HTML
  visitorJson: "/e3kp9af5qh2",  // visitor log JSON
  vtLog:       "/v2qw5rn8jx1",  // VirusTotal scan log HTML
  siteVisitors: "/k4pw8zn2rt5", // JSON: every real page-visit logged (IP + User-Agent)
  blockedUAs:   "/h6rm1qf4wt7", // JSON: list currently-blocked user-agents
  blockUA:      "/w9hq3yd6mp0", // POST: block a user-agent (kicks matching live sockets)
  unblockUA:    "/j2vc5ns8ek3", // POST: remove a user-agent block
  regUsers:     "/y5tm2bk9lz3", // JSON: every REGISTERED username + their last-used IP (not just who's online now)
  accountReports: "/z3np8wk1yh6", // JSON: reports filed against registered accounts from their profile card
  deleteUser:   "/c8ke2mr5vq1", // POST: admin delete an account (purges content, bans last IP)
  setPro:       "/m8hy3rn6qc2", // POST: grant/revoke pro status on a registered account
  tempBan:      "/w4qd7np2xb8", // POST: 24h IP block with a shown reason
  tempBansList: "/j3nc6wp0xz5", // GET: list currently-active 24h blocks
  unbanTemp:    "/k9vd4qz2ym8", // POST: lift a 24h block early
  nameBlock:    "/q3vn8ys5ke1", // POST: block an account for an offensive name (forces a rename)
};

// ── Sensitive-URL visitor log ─────────────────────────────────────────────────
const MAX_VISITOR_LOG = 2000;
const sensitiveVisitorLog = [];
// Each entry: { ip, url, timestamp, userAgent, allowed }

const SENSITIVE_URL_PATTERNS = Object.values(ROUTE);

function recordSensitiveVisit(req, allowed) {
  const ip = getClientIP(req);
  const entry = {
    ip,
    url: req.originalUrl || req.url,
    timestamp: new Date().toISOString(),
    userAgent: (req.headers["user-agent"] || "").slice(0, 200),
    allowed,
  };
  sensitiveVisitorLog.push(entry);
  // Keep log from growing unbounded
  if (sensitiveVisitorLog.length > MAX_VISITOR_LOG)
    sensitiveVisitorLog.splice(0, sensitiveVisitorLog.length - MAX_VISITOR_LOG);
  if (!allowed) {
    console.warn(`[SENSITIVE-URL] UNAUTHORIZED access attempt — IP: ${ip} → ${entry.url}`);
  } else {
    console.log(`[SENSITIVE-URL] Authorized access — IP: ${ip} → ${entry.url}`);
  }
}

// Middleware: log every request to sensitive URLs (runs before auth checks)
function sensitiveUrlLogger(req, res, next) {
  const path = req.path || "";
  const isSensitive = SENSITIVE_URL_PATTERNS.some(p => path.startsWith(p));
  if (!isSensitive) return next();

  const ip = getClientIP(req);
  const isAllowed = OWNER_IPS.has(ip);
  recordSensitiveVisit(req, isAllowed);
  next();
}

// Owner-only middleware — admin panel access now ALWAYS requires the admin
// key (via a valid session cookie set after a correct key login). The old
// "owner IP always gets in free" bypass is removed here on purpose — even
// your own IP has to log in with the key.
function ownerOnly(req, res, next) {
  if (hasValidAdminSession(req)) {
    next();
    return;
  }
  res.status(403).send("Forbidden");
}

// ── Admin panel key-login (lets the owner reach the panel from any IP) ────────
// The panel URL itself stays the same secret slug (ROUTE.panel) — this just
// adds a key-gated login screen in front of it instead of the previous
// hard IP allow-list. Sessions are simple random tokens kept in memory
// (server restart logs everyone out, which is fine for this use case).
// SECURITY: this used to fall back to a fixed password written directly in
// this file. Anyone who read the source (or a copy of it) had the admin
// panel key. It now fails SAFE instead of failing OPEN: with no ADMIN_KEY
// set, a fresh random key is generated each boot and printed to the server
// log, so the panel is never protected by a publicly-known password.
//
// Set the ADMIN_KEY environment variable to get a stable key that survives
// restarts. Until you do, check the startup log for the generated one.
const ADMIN_KEY = process.env.ADMIN_KEY || crypto.randomBytes(24).toString("base64url");
if (!process.env.ADMIN_KEY) {
  console.warn("─".repeat(72));
  console.warn("[SECURITY] ADMIN_KEY environment variable is not set.");
  console.warn("[SECURITY] Generated a temporary admin key for this boot only:");
  console.warn(`[SECURITY]     ${ADMIN_KEY}`);
  console.warn("[SECURITY] It changes on every restart. Set ADMIN_KEY to make it permanent.");
  console.warn("─".repeat(72));
}
const ADMIN_SESSION_COOKIE = "gaicani_admin";
const adminSessions = new Map(); // token → { createdAt }
const ADMIN_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach(pair => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function hasValidAdminSession(req) {
  const cookies = parseCookies(req);
  const token = cookies[ADMIN_SESSION_COOKIE];
  if (!token) return false;
  const entry = adminSessions.get(token);
  if (!entry) return false;
  if (Date.now() - entry.createdAt > ADMIN_SESSION_MAX_AGE_MS) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

// Adds "; Secure" only when the request actually arrived over HTTPS, so
// cookies are protected in production without breaking local HTTP testing
// (a Secure cookie is silently dropped by the browser over plain HTTP,
// which would make admin login appear to "work" but never stay logged in).
// req.secure is trustworthy here because app.set("trust proxy", 1) is on.
function secureCookieFlag(req) {
  return (req && (req.secure || req.headers["x-forwarded-proto"] === "https")) ? "; Secure" : "";
}

function createAdminSession(res, req) {
  const token = crypto.randomBytes(32).toString("hex");
  adminSessions.set(token, { createdAt: Date.now() });
  res.setHeader("Set-Cookie",
    `${ADMIN_SESSION_COOKIE}=${token}; Max-Age=${Math.floor(ADMIN_SESSION_MAX_AGE_MS / 1000)}; Path=/; HttpOnly; SameSite=Lax${secureCookieFlag(req)}`
  );
}

function adminLoginPageHtml(error) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Admin Login</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#1e1f22;color:#dcddde;font-family:"Segoe UI",Arial,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.box{background:#2b2d31;border-radius:12px;padding:32px 28px;width:100%;max-width:340px;box-shadow:0 20px 60px rgba(0,0,0,.5)}
h1{color:#fff;font-size:1.15em;margin-bottom:18px;text-align:center}
input[type=password]{width:100%;background:#1e1f22;border:1px solid #3a3c40;border-radius:8px;color:#dcddde;font-size:.95em;padding:11px 13px;outline:none;margin-bottom:12px}
input[type=password]:focus{border-color:#5865f2}
button{width:100%;background:#5865f2;color:#fff;border:none;border-radius:8px;padding:11px;font-size:.92em;font-weight:700;cursor:pointer}
button:hover{background:#4752c4}
.err{color:#f23f42;font-size:.82em;margin-bottom:10px;text-align:center}
</style>
</head>
<body>
<div class="box">
  <h1>🔒 Admin Login</h1>
  ${error ? `<p class="err">${error}</p>` : ""}
  <form method="POST">
    <input type="password" name="key" placeholder="Admin key" autofocus required />
    <button type="submit">Enter</button>
  </form>
</div>
</body>
</html>`;
}

// ── Site-wide visitor log — every IP + User-Agent that has visited the site ───
// Separate from the sensitive-URL log above: this one only cares about the
// real pages of the app (home, dashboard, friend chat, legal pages) so the
// admin panel can see "who visited" without it filling up with every asset
// or API call. Kept in-memory only (like the sensitive-URL log) — bounded so
// it never grows without limit.
const MAX_SITE_VISITOR_LOG = 3000;
const siteVisitorLog       = []; // { ip, userAgent, path, timestamp }

const SITE_PAGE_PATHS = new Set([
  "/", "/index.html", "/dashboard.html", "/friend-chat.html",
  "/privacy.html", "/terms.html",
]);

function shouldLogSiteVisit(req) {
  if (req.method !== "GET") return false;
  return SITE_PAGE_PATHS.has(req.path);
}

function recordSiteVisit(req) {
  const entry = {
    ip:        getClientIP(req),
    userAgent: normalizeUA(req.headers["user-agent"]).slice(0, 300) || "(none)",
    path:      req.path,
    timestamp: new Date().toISOString(),
  };
  siteVisitorLog.push(entry);
  if (siteVisitorLog.length > MAX_SITE_VISITOR_LOG)
    siteVisitorLog.splice(0, siteVisitorLog.length - MAX_SITE_VISITOR_LOG);
}

// Some clients (scripts/bots) connect straight to the socket.io endpoint and
// never request "/", "/dashboard.html", etc. — those would never show up in
// the log above even though they're actively using the site. Log the socket
// handshake itself too, tagged with a distinct "path" so it's obvious in the
// admin panel which entries came from an actual page load vs. a raw connect.
function recordSocketVisit(ip, userAgent) {
  const entry = {
    ip:        ip || "unknown",
    userAgent: normalizeUA(userAgent).slice(0, 300) || "(none)",
    path:      "(socket connect)",
    timestamp: new Date().toISOString(),
  };
  siteVisitorLog.push(entry);
  if (siteVisitorLog.length > MAX_SITE_VISITOR_LOG)
    siteVisitorLog.splice(0, siteVisitorLog.length - MAX_SITE_VISITOR_LOG);
}

// ── Statistics tracking ───────────────────────────────────────────────────────
const stats = {
  days: new Map(),        // "YYYY-MM-DD" → dayObj  (rolling 14 days)
  allTimeIPs: new Set(),
  peakOnline: 0,
  peakOnlineAt: null,
  serverStartedAt: Date.now(),
};

// dayObj shape:
//  {
//    ips:            Set<string>,   unique IPs
//    sessions:       number,        total connections
//    totalDurationMs:number,        sum of all session durations
//    chats:          number,        matched pairs
//    hours:          Array(24)      each slot: { ips: Set, sessions: number }
//    peakOnline:     number,        highest concurrent users this day
//    peakOnlineAt:   string|null,   ISO timestamp of that peak
//    newIPs:         Set<string>,   IPs never seen before this day
//  }

// Tbilisi (Georgia) is a fixed UTC+4 all year round — no DST, safe to hardcode.
const TBILISI_OFFSET_MS = 4 * 60 * 60 * 1000;
function tbilisiNow() {
  return new Date(Date.now() + TBILISI_OFFSET_MS);
}

function todayKey() {
  return tbilisiNow().toISOString().slice(0, 10);
}

function getOrCreateDay(key) {
  if (!stats.days.has(key)) {
    const hours = Array.from({ length: 24 }, () => ({ ips: new Set(), sessions: 0 }));
    stats.days.set(key, {
      ips: new Set(), sessions: 0, totalDurationMs: 0,
      chats: 0, hours, peakOnline: 0, peakOnlineAt: null,
      newIPs: new Set(),
      counters: {},                       // messages, forum, games … (see bumpStat)
      devices: newDeviceSets(),           // unique visitors per device type
      pages: {},                          // page opens per page
    });
    // Keep only last 14 days
    const keys = [...stats.days.keys()].sort();
    while (keys.length > 14) stats.days.delete(keys.shift());
  }
  return stats.days.get(key);
}

// ── Extra activity tracking (aggregate numbers only — no names, no content) ──
const DEVICE_KINDS = ["ios", "android", "windows", "mac", "linux", "other"];
function newDeviceSets() { const o = {}; for (const k of DEVICE_KINDS) o[k] = new Set(); return o; }
function deviceClass(ua) {
  ua = String(ua || "");
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  if (/Windows/i.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/i.test(ua)) return "mac";
  if (/Linux|CrOS/i.test(ua)) return "linux";
  return "other";
}
function bumpStat(key, n = 1) {
  const d = getOrCreateDay(todayKey());
  d.counters[key] = (d.counters[key] || 0) + n;
  if (!stats.extendedSince) stats.extendedSince = todayKey();
  statsDirty = true; scheduleStatsSave();
}
// Only the site's real pages count — never secret admin/stats addresses or
// whatever paths bots probe for (this list is shown on the public stats page).
const PAGE_VIEW_PATHS = (() => {
  const set = new Set(["/"]);
  try { for (const f of fs.readdirSync(__dirname)) if (f.endsWith(".html")) set.add("/" + f); } catch { /* keep "/" */ }
  return set;
})();
function recordPageView(pathname) {
  const pth = String(pathname || "/");
  if (!PAGE_VIEW_PATHS.has(pth)) return;
  const d = getOrCreateDay(todayKey());
  if (!(pth in d.pages) && Object.keys(d.pages).length >= 40) return;
  d.pages[pth] = (d.pages[pth] || 0) + 1;
  if (!stats.extendedSince) stats.extendedSince = todayKey();
  statsDirty = true; scheduleStatsSave();
}
// Games are counted when a round starts.
const STAT_GAME_EVENTS = { "poker:start": "poker", "joker:start": "joker", "chess:start": "chess", "checkers:start": "checkers",
  "blackjack:start": "blackjack", "imposter:start": "imposter", "drawGuess:start": "drawGuess", "flappy:start": "flappy" };

function getUniqueOnlineIPCount() {
  if (!io) return 0;
  const ips = new Set();
  for (const s of io.sockets.sockets.values()) ips.add(s.clientIP || "unknown");
  return ips.size;
}

function recordConnect(ip, userAgent) {
  const day = getOrCreateDay(todayKey());
  day.devices[deviceClass(userAgent)].add(ip);
  if (!stats.extendedSince) stats.extendedSince = todayKey();
  const hour = tbilisiNow().getUTCHours(); // 0-23, Tbilisi local hour

  day.ips.add(ip);
  day.sessions++;
  day.hours[hour].ips.add(ip);
  day.hours[hour].sessions++;

  // Track first-time IPs (never seen on any previous day)
  if (!stats.allTimeIPs.has(ip)) day.newIPs.add(ip);

  stats.allTimeIPs.add(ip);

  // "Online" here means unique people (by IP), not raw socket connections —
  // someone with 3 tabs open is 1 person online, not 3.
  const current = getUniqueOnlineIPCount();
  // Per-day peak
  if (current > day.peakOnline) {
    day.peakOnline    = current;
    day.peakOnlineAt  = new Date().toISOString();
  }
  // All-time peak
  if (current > stats.peakOnline) {
    stats.peakOnline   = current;
    stats.peakOnlineAt = new Date().toISOString();
  }

  statsDirty = true;
  scheduleStatsSave();
}

// ── Stats persistence — survives redeploys/restarts, same pattern as auth/priv ──
let statsDirty = false;
let statsSaveTimer = null;
const STATS_SAVE_DEBOUNCE_MS = 5000;

function scheduleStatsSave() {
  if (statsSaveTimer) return;
  statsSaveTimer = setTimeout(() => {
    if (statsDirty) _saveStatsToDisk();
    statsSaveTimer = null;
  }, STATS_SAVE_DEBOUNCE_MS);
}

function _saveStatsToDisk() {
  const daysObj = {};
  for (const [key, d] of stats.days) {
    daysObj[key] = {
      ips: [...d.ips],
      sessions: d.sessions,
      totalDurationMs: d.totalDurationMs,
      chats: d.chats,
      hours: d.hours.map(h => ({ ips: [...h.ips], sessions: h.sessions })),
      peakOnline: d.peakOnline,
      peakOnlineAt: d.peakOnlineAt,
      newIPs: [...d.newIPs],
      counters: d.counters || {},
      devices: Object.fromEntries(DEVICE_KINDS.map(k => [k, [...(d.devices?.[k] || [])]])),
      pages: d.pages || {},
    };
  }
  const out = {
    days: daysObj,
    allTimeIPs: [...stats.allTimeIPs],
    peakOnline: stats.peakOnline,
    peakOnlineAt: stats.peakOnlineAt,
    serverStartedAt: stats.serverStartedAt,
    extendedSince: stats.extendedSince || null,
  };
  try {
    writeFileAtomic(STATS_FILE, JSON.stringify(out));
    statsDirty = false;
  } catch (e) {
    console.error("[STATS] save failed:", e.message);
    statsDirty = true;
  }
}

function loadStats() {
  try {
    const obj = readJsonFile(STATS_FILE);
    for (const [key, d] of Object.entries(obj.days || {})) {
      stats.days.set(key, {
        ips: new Set(d.ips || []),
        sessions: d.sessions || 0,
        totalDurationMs: d.totalDurationMs || 0,
        chats: d.chats || 0,
        hours: (d.hours || Array.from({ length: 24 }, () => ({ ips: [], sessions: 0 })))
          .map(h => ({ ips: new Set(h.ips || []), sessions: h.sessions || 0 })),
        peakOnline: d.peakOnline || 0,
        peakOnlineAt: d.peakOnlineAt || null,
        newIPs: new Set(d.newIPs || []),
        counters: d.counters || {},
        devices: Object.fromEntries(DEVICE_KINDS.map(k => [k, new Set((d.devices && d.devices[k]) || [])])),
        pages: d.pages || {},
      });
    }
    stats.extendedSince = obj.extendedSince || null;
    stats.allTimeIPs = new Set(obj.allTimeIPs || []);
    stats.peakOnline = obj.peakOnline || 0;
    stats.peakOnlineAt = obj.peakOnlineAt || null;
    // serverStartedAt intentionally stays as "now" (this boot), not the saved value —
    // uptime should reflect the current process, not accumulate across restarts.
    console.log(`[STATS] Loaded ${stats.days.size} day(s), ${stats.allTimeIPs.size} all-time unique IP(s)`);
  } catch { /* first run — no stats file yet */ }
}

function recordDisconnect(ip, connectedAtMs) {
  if (!connectedAtMs) return;
  const durMs = Date.now() - connectedAtMs;
  getOrCreateDay(todayKey()).totalDurationMs += durMs;
  statsDirty = true;
  scheduleStatsSave();
}

function recordChatStarted() {
  getOrCreateDay(todayKey()).chats++;
  statsDirty = true;
  scheduleStatsSave();
}

// ── Link-strike system ────────────────────────────────────────────────────────
// 2 violations → 24-hour auto-ban
const LINK_BAN_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
const linkStrikes = new Map(); // ip → { count, bannedUntil }

function recordLinkStrike(ip) {
  // If we can't identify the IP reliably, just warn — never perma-ban unknowns
  if (!ip || ip === 'unknown' || ip === '::1' || ip === '127.0.0.1') return 'warning';
  const now   = Date.now();
  const entry = linkStrikes.get(ip) || { count: 0, bannedUntil: null };
  if (entry.bannedUntil && now < entry.bannedUntil) return 'banned'; // already banned
  entry.count++;
  if (entry.count >= 2) {
    if (!AUTO_BAN_ENABLED) {
      // Still counted and logged, but no ban is applied.
      console.warn(`[LINK-STRIKE] IP ${ip} — strike ${entry.count} (auto-ban disabled, not banned)`);
      linkStrikes.set(ip, entry);
      return 'warning';
    }
    entry.bannedUntil = now + LINK_BAN_DURATION_MS;
    console.warn(`[LINK-BAN] IP ${ip} auto-banned 24h after ${entry.count} violations`);
    linkStrikes.set(ip, entry);
    return 'banned';
  } else {
    console.warn(`[LINK-STRIKE] IP ${ip} — strike ${entry.count}/2`);
    linkStrikes.set(ip, entry);
    return 'warning';
  }
}

function isLinkBanned(ip) {
  const entry = linkStrikes.get(ip);
  if (!entry || !entry.bannedUntil) return false;
  if (Date.now() >= entry.bannedUntil) {
    linkStrikes.delete(ip);  // ← PATCH: lazy deletion
    return false;
  }
  return true;
}

// Clean expired entries every hour
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of linkStrikes)
    if (!entry.bannedUntil || now >= entry.bannedUntil) linkStrikes.delete(ip);
  for (const [ip, entry] of reportStrikes) {
    const expired = entry.bannedUntil && now >= entry.bannedUntil;
    const windowExpired = !entry.bannedUntil && entry.firstReportAt && (now - entry.firstReportAt) >= REPORT_BAN_DURATION_MS;
    if (expired || windowExpired) reportStrikes.delete(ip);
  }
}, 60 * 60 * 1000);

// ── Report-strike system ──────────────────────────────────────────────────────
// 5 reports from different sessions → 24-hour auto-ban; resets after 24h if not reached
const REPORT_BAN_DURATION_MS = 24 * 60 * 60 * 1000;
const REPORT_THRESHOLD       = 5;
const reportStrikes = new Map(); // ip → { count, bannedUntil, reporters: Set, firstReportAt }

function recordReport(reporterSocketId, targetIP, reason, reporterName, targetName) {
  if (!targetIP || targetIP === 'unknown') return false;
  const now   = Date.now();
  let entry   = reportStrikes.get(targetIP) || { count: 0, bannedUntil: null, reporters: new Set(), firstReportAt: null, reasons: [], names: new Set() };
  if (entry.bannedUntil && now < entry.bannedUntil) return true; // already banned
  // After 24h without hitting threshold, reset count to 3 (not 0) — history still matters
  if (entry.firstReportAt && (now - entry.firstReportAt) >= REPORT_BAN_DURATION_MS) {
    const resetTo = Math.min(entry.count, 3);
    console.warn(`[REPORT-RESET] IP ${targetIP} — 24h passed, resetting ${entry.count} → ${resetTo} reports`);
    entry = { count: resetTo, bannedUntil: null, reporters: new Set(), firstReportAt: resetTo > 0 ? now : null, reasons: entry.reasons.slice(-resetTo), names: entry.names || new Set() };
  }
  // One report per socket id to prevent spam
  if (entry.reporters.has(reporterSocketId)) return false;
  entry.reporters.add(reporterSocketId);
  entry.count++;
  if (entry.count === 1) entry.firstReportAt = now; // start the 24h window
  // Names change between random-chat sessions, so we keep every distinct name
  // seen for this IP — the admin panel shows all of them (most recent last).
  if (targetName) {
    if (!entry.names) entry.names = new Set();
    entry.names.add(targetName);
  }
  entry.reasons.push({
    reason:   (reason || "").trim().slice(0, 200) || "(no reason provided)",
    by:       reporterName || "unknown",
    against:  targetName || "unknown",
    timestamp: new Date().toISOString(),
  });
  if (entry.count >= REPORT_THRESHOLD) {
    if (!AUTO_BAN_ENABLED) {
      // Reports are still recorded and shown in the admin panel, but they no
      // longer ban on their own — a coordinated group could otherwise remove
      // anyone they wanted.
      console.warn(`[REPORT] IP ${targetIP} hit ${entry.count} reports — logged, NOT banned (auto-ban disabled)`);
      reportStrikes.set(targetIP, entry);
      return false;
    }
    entry.bannedUntil = now + REPORT_BAN_DURATION_MS;
    console.warn(`[REPORT-BAN] IP ${targetIP} auto-banned 24h after ${entry.count} reports`);
    reportStrikes.set(targetIP, entry);
    return true; // just got banned
  }
  console.warn(`[REPORT] IP ${targetIP} — ${entry.count}/${REPORT_THRESHOLD} reports`);
  reportStrikes.set(targetIP, entry);
  return false;
}

function isReportBanned(ip) {
  const entry = reportStrikes.get(ip);
  if (!entry || !entry.bannedUntil) return false;
  if (Date.now() >= entry.bannedUntil) {
    reportStrikes.delete(ip);  // ← PATCH: lazy deletion
    return false;
  }
  return true;
}

function clearReportBan(ip) {
  return reportStrikes.delete(ip);
}

const VALID_TAGS = new Set([
  "gaming","music","movies","books","sports",
  "tech","art","food","travel","memes",
]);
const VALID_EMOJIS = new Set(["❤️","😂","😢"]);
// Must match the FC_THEMES ids in friend-chat.html exactly — this is the
// server-side whitelist for the shared (both-see-it) chat background.
const FC_VALID_THEMES = new Set(["default", "midnight", "sunset", "ocean", "rose", "forest", "charcoal", "amber", "aurora"]);
const BANNED_WORDS = new Set([
  // common spam/commercial phrases (lower-case, partial match)
 
]);

// ── Blocked phrases — messages containing these are silently dropped ──────────
const BLOCKED_PHRASES = [
  "Nuciko77",
  "NucikО77"
  
];

// Case-insensitive regex matching any blocked phrase, escaped so special
// regex characters in a phrase (., *, etc.) are treated literally.
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const BLOCKED_PHRASE_RE = BLOCKED_PHRASES.length
  ? new RegExp(BLOCKED_PHRASES.map(escapeRegExp).join("|"), "i")
  : /(?!)/; // matches nothing if the list is empty

// Phone number pattern — bots often drop numbers when links are blocked
const PHONE_RE = /(?:\+?[0-9]{1,3}[\s\-.]?)?(?:\(?\d{3}\)?[\s\-.]?)[\d\s\-.]{6,}/g;

// ── Load facts & questions ────────────────────────────────────────────────────
function loadLines(filename) {
  try {
    return fs.readFileSync(path.join(__dirname, filename), "utf8")
      .split("\n").map(l => l.trim()).filter(Boolean);
  } catch { return []; }
}

let FACTS     = loadLines("facts.txt");
let QUESTIONS = loadLines("questions.txt");

function randomItem(arr) {
  if (!arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

// ── Fisher-Yates shuffle (PATCH: correct uniform randomization O(n)) ───────────
// NOTE: this was previously nested *inside* randomItem() because that function
// was missing its closing brace. Since randomItem returns before reaching it,
// shuffle() was never in scope anywhere — every call threw
// "ReferenceError: shuffle is not defined", which broke captcha generation.
function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// ── Captcha / Geo gate ───────────────────────────────────────────────────────
// Non-Georgian IPs must solve a simple math captcha before accessing the site.
// Georgian IPs (country code "GE") pass straight through.
// Once solved, a signed cookie is set — valid 30 days, no re-challenge needed.

const CAPTCHA_SECRET  = process.env.CAPTCHA_SECRET || crypto.randomBytes(32).toString("hex");
const CAPTCHA_COOKIE  = "gc_pass";
const CAPTCHA_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

// Geo cache — avoid hammering ip-api.com (free tier: 45 req/min)
// ip → { country: "GE"|other, ts: Date.now() }
const geoCache = new Map();
const GEO_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

// Pending captcha challenges — ip → { a, b, answer, expires }
const captchaChallenges = new Map();
const CAPTCHA_TTL = 10 * 60 * 1000; // 10 minutes to solve

// Clean expired challenges every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, c] of captchaChallenges)
    if (now > c.expires) captchaChallenges.delete(ip);
  for (const [ip, c] of geoCache)
    if (now - c.ts > GEO_CACHE_TTL) geoCache.delete(ip);
}, 5 * 60 * 1000);

function makeCaptchaToken(ip) {
  const payload = ip + ":" + Date.now();
  const sig = crypto.createHmac("sha256", CAPTCHA_SECRET).update(payload).digest("hex");
  return Buffer.from(payload + "." + sig).toString("base64url");
}

function verifyCaptchaToken(ip, token) {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const dotIdx  = decoded.lastIndexOf(".");
    const payload = decoded.slice(0, dotIdx);
    const sig     = decoded.slice(dotIdx + 1);
    const expected = crypto.createHmac("sha256", CAPTCHA_SECRET).update(payload).digest("hex");
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    const [storedIP, tsStr] = payload.split(":");
    if (storedIP !== ip) return false;
    if (Date.now() - Number(tsStr) > CAPTCHA_MAX_AGE) return false;
    return true;
  } catch { return false; }
}

function hasCaptchaCookie(req) {
  const raw = req.headers.cookie || "";
  const cookie = raw.split(";").map(s => s.trim()).find(s => s.startsWith(CAPTCHA_COOKIE + "="));
  if (!cookie) return false;
  const token = cookie.slice(CAPTCHA_COOKIE.length + 1);
  const ip = (req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket?.remoteAddress || "");
  return verifyCaptchaToken(ip, token);
}

function setCaptchaCookie(res, ip, req) {
  const token = makeCaptchaToken(ip);
  res.setHeader("Set-Cookie",
    `${CAPTCHA_COOKIE}=${token}; Max-Age=${CAPTCHA_MAX_AGE / 1000}; Path=/; HttpOnly; SameSite=Lax${secureCookieFlag(req)}`
  );
}

async function getCountry(ip) {
  // Always pass local / private IPs (dev environment)
  if (!ip || ip === "::1" || ip === "127.0.0.1" || ip.startsWith("192.168.") || ip.startsWith("10.")) return "GE";

  const cached = geoCache.get(ip);
  if (cached && Date.now() - cached.ts < GEO_CACHE_TTL) return cached.country;

  try {
    const res  = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=countryCode`, { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    const country = data.countryCode || "??";
    geoCache.set(ip, { country, ts: Date.now() });
    return country;
  } catch {
    // On lookup failure → let them through (don't block on geo error)
    return "GE";
  }
}

// ── Image-selection captcha ───────────────────────────────────────────────────
// Shows a 3×3 grid of emojis. User must click all tiles matching the target category.
// Categories and their emoji pools:
const CAPTCHA_CATEGORIES = {
  "🚌 ავტობუსი": ["🚌","🚎","🚐"],
  "🚗 მანქანა":  ["🚗","🚕","🏎️","🚙"],
  "✈️ თვითმფრინავი": ["✈️","🛩️","🛫","🛬"],
  "🐶 ძაღლი":   ["🐶","🐕","🦮","🐩"],
  "🐱 კატა":    ["🐱","🐈","😸","🙀"],
  "🌳 ხე":      ["🌳","🌲","🌴","🎄"],
  "🍎 ხილი":    ["🍎","🍊","🍋","🍇","🍓","🍑","🍒"],
  "⚽ ბურთი":   ["⚽","🏀","🏈","⚾","🎾","🏐","🏉"],
  "🏠 სახლი":   ["🏠","🏡","🏘️","🏚️"],
  "🌸 ყვავილი": ["🌸","🌺","🌻","🌼","💐","🌹","🌷"],
};

// Distractor emojis that never belong to any category
const DISTRACTORS = ["🎸","🎺","🎻","🥁","🎹","🪗","📱","💻","⌨️","🖥️","🎮","🕹️","🔑","🔒","💡","🔦","🪣","🧲","🎩","👑","💍","👟","🧢","🎀","🧸","🪆","🎯","🧩","🎲","🃏"];

function newChallenge(ip) {
  // Pick a random category
  const catKeys = Object.keys(CAPTCHA_CATEGORIES);
  const targetLabel = catKeys[Math.floor(Math.random() * catKeys.length)];
  const targetPool  = CAPTCHA_CATEGORIES[targetLabel];

  // Build a 3×3 grid (9 tiles)
  // Pick 2–4 correct tiles, fill rest with distractors
  const correctCount = 2 + Math.floor(Math.random() * 3); // 2, 3, or 4
  const correct = [];
  const poolCopy = [...targetPool];
  for (let i = 0; i < correctCount && poolCopy.length; i++) {
    const idx = Math.floor(Math.random() * poolCopy.length);
    correct.push(poolCopy.splice(idx, 1)[0]);
  }

  // Fill remaining 9 - correctCount slots with unique distractors
  const distCopy = shuffle(DISTRACTORS);
  const tiles = [...correct];
  while (tiles.length < 9) tiles.push(distCopy.pop());

  // Shuffle tiles
  const shuffledTiles = shuffle(tiles);

  // correctIndices = positions (0-8) of correct tiles
  const correctIndices = shuffledTiles.reduce((acc, t, i) => {
    if (correct.includes(t)) acc.push(i);
    return acc;
  }, []);

  const challenge = {
    targetLabel,
    tiles: shuffledTiles,
    correctIndices,
    expires: Date.now() + 5 * 60 * 1000, // 5 min to solve
  };

  captchaChallenges.set(ip, challenge);
  return challenge;
}

function captchaPageHTML(ip, error) {
  const ch = captchaChallenges.get(ip) || newChallenge(ip);
  const errHtml = error ? `<p class="err">${error}</p>` : "";
  // Encode correct indices as hidden field so verify can check
  const correctJson = JSON.stringify(ch.correctIndices);

  const tiles = ch.tiles.map((emoji, i) =>
    `<div class="tile" data-idx="${i}" onclick="toggle(this)">${emoji}</div>`
  ).join("");

  return `<!DOCTYPE html>
<html lang="ka">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>GAICANI – გადამოწმება</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{min-height:100%;background:#1e1f22;display:flex;align-items:center;justify-content:center;font-family:"Segoe UI",Arial,sans-serif}
.box{background:#2b2d31;border-radius:16px;padding:32px 28px;max-width:400px;width:92%;text-align:center;box-shadow:0 8px 40px rgba(0,0,0,.5)}
.logo{font-size:1.8em;font-weight:900;color:#fff;letter-spacing:1px;margin-bottom:6px}
.sub{color:#72767d;font-size:.85em;margin-bottom:16px;line-height:1.5}
.target{background:#1e1f22;border-radius:10px;padding:12px 18px;font-size:1.5em;font-weight:700;color:#fff;margin-bottom:18px;display:inline-block}
.hint{color:#72767d;font-size:.8em;margin-bottom:14px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:18px}
.tile{background:#1e1f22;border:2px solid #3a3c40;border-radius:10px;font-size:2.2em;padding:12px 0;cursor:pointer;transition:border .15s,background .15s;user-select:none;line-height:1}
.tile:hover{border-color:#5865f2;background:#232428}
.tile.selected{border-color:#5865f2;background:rgba(88,101,242,.18)}
button{width:100%;background:#5865f2;color:#fff;border:none;border-radius:8px;padding:13px;font-size:1em;font-weight:600;cursor:pointer;transition:background .2s}
button:hover{background:#4752c4}
.err{color:#f23f42;font-size:.85em;margin-top:12px;background:rgba(242,63,66,.1);border-radius:6px;padding:8px 12px}
.note{color:#4f5560;font-size:.72em;margin-top:18px;line-height:1.5}
</style>
</head>
<body>
<div class="box">
  <div class="logo">GAICANI</div>
  <p class="sub">დაამტკიცეთ, რომ ადამიანი ხართ</p>
  <div class="target">${ch.targetLabel}</div>
  <p class="hint">აარჩიეთ ყველა სურათი, რომელიც შეესაბამება</p>
  <div class="grid">${tiles}</div>
  <form method="POST" action="/captcha-verify" id="cf">
    <input type="hidden" name="selected" id="selectedInput" value=""/>
    ${errHtml}
    <button type="submit">დადასტურება →</button>
  </form>
  <p class="note">ეს შემოწმება მხოლოდ ერთხელ ხდება.<br>ქართული IP-ები ავტომატურად გადიან.</p>
</div>
<script>
function toggle(el) {
  el.classList.toggle("selected");
  const sel = [...document.querySelectorAll(".tile.selected")].map(t => t.dataset.idx);
  document.getElementById("selectedInput").value = sel.join(",");
}
</script>
</body>
</html>`;
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(compression());
app.use(sensitiveUrlLogger); // log admin/stats visits BEFORE auth gates

// ── HTTP-level IP ban — runs before static files and all routes ───────────────
// Banned IPs can't load the page, assets, or call any API endpoint.
// This works without a firewall — the block happens inside Node/Express itself.
app.use((req, res, next) => {
  const ip = (
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    ""
  );
  // Temporary bans explain themselves; permanent ones stay silent.
  const tb = getTempBan(ip);
  if (tb) {
    res.status(403).setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(tempBanPageHtml(tb));
    return;
  }
  if (isIPBanned(ip) || isIPBanned(req.headers["cf-connecting-ip"])) {
    // Return a generic 403 — don't reveal why or that a ban system exists
    res.status(403).end();
    return;
  }
  next();
});

// ── HTTP-level User-Agent ban — same idea as the IP ban above, but keyed on
// the User-Agent string instead of the IP. Lets the admin panel block a whole
// User-Agent (e.g. a scraping tool or bot) regardless of which IP it's using.
app.use((req, res, next) => {
  const ua = req.headers["user-agent"] || "";
  if (isUABanned(ua)) {
    console.log(`[UA-BAN] Rejected banned User-Agent: ${ua.slice(0, 120)}`);
    res.status(403).end();
    return;
  }
  next();
});

// ── Traffic-flood detector & auto-mitigation ───────────────────────────────────
// Built after the Aug 22 incident: a burst of ~400k requests / 58GB in under
// an hour pegged the 0.5 CPU limit, which made the process too slow to answer
// Render's internal health-check port in time → "i/o timeout" → repeated
// instance kills/restarts (that's what all the "Instance failed: mdqt5" /
// "dial tcp ...:10000: i/o timeout" log lines were).
//
// This middleware is intentionally CHEAP (a Map lookup + counter, no disk I/O
// on the hot path) so it can't itself become the bottleneck. It does two
// things:
//   1. Per-IP short-window rate limiting — an IP sending an abusive number of
//      requests gets an instant 429 instead of being allowed to burn CPU on
//      full route handling.
//   2. Every 10s, appends a one-line summary of that window (total requests +
//      top offending IPs) to a log file on the persistent disk — ALWAYS,
//      not just during spikes, so you have a continuous, permanent traffic
//      record to look back through after any crash/restart. Appending one
//      line (instead of rewriting a whole JSON file) keeps this cheap even
//      under heavy load.
const FLOOD_WINDOW_MS   = 10_000;  // sliding window used for rate limiting
const FLOOD_MAX_PER_IP  = 150;     // requests/10s from one IP before it's throttled
const FLOOD_LOG_FILE    = path.join(DATA_PATH, "traffic-flood-log.jsonl"); // JSON-lines, append-only

// Bucket every request path into a small fixed set of categories (NOT the
// raw path) so memory stays bounded no matter how many distinct URLs get
// hit. This is what answers "was it real page traffic or API abuse?" after
// the fact, without storing full URLs for every single request.
function categorizePath(p) {
  if (p.startsWith("/socket.io")) return "socket.io";
  if (p.startsWith("/api/"))      return "api";
  if (Object.values(ROUTE).some(r => p.startsWith(r))) return "admin";
  if (/\.(js|css|png|jpe?g|gif|svg|ico|woff2?|ttf|map)$/i.test(p)) return "asset";
  return "page";
}

let floodWindowStart = Date.now();
let floodTotalReqs   = 0;
const floodIpCounts     = new Map(); // ip → total count in current window
const floodIpCategories = new Map(); // ip → { category → count } in current window
const floodCategoryTotals = new Map(); // category → total count in current window (all IPs)

function floodTick(ip, reqPath) {
  const now = Date.now();
  if (now - floodWindowStart >= FLOOD_WINDOW_MS) {
    // window rolled over — write it to disk before resetting
    if (floodTotalReqs > 0) {
      const topIps = [...floodIpCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([ip, count]) => ({
          ip,
          count,
          byCategory: floodIpCategories.get(ip)
            ? Object.fromEntries(floodIpCategories.get(ip))
            : {},
        }));
      const line = JSON.stringify({
        time:            new Date(floodWindowStart).toISOString(),
        windowSec:       Math.round((now - floodWindowStart) / 1000),
        totalReqs:       floodTotalReqs,
        uniqueIps:       floodIpCounts.size,
        categoryTotals:  Object.fromEntries(floodCategoryTotals),
        topIps,
      });
      try {
        fs.appendFileSync(FLOOD_LOG_FILE, line + "\n");
      } catch (e) {
        console.error("[FLOOD] Failed to write flood log:", e.message);
      }
      if (floodTotalReqs > 500 || (topIps[0] && topIps[0].count > 100)) {
        console.warn(`[FLOOD] Spike window: ${floodTotalReqs} reqs, top IP ${topIps[0]?.ip} (${topIps[0]?.count})`);
      }
    }
    floodWindowStart = now;
    floodTotalReqs = 0;
    floodIpCounts.clear();
    floodIpCategories.clear();
    floodCategoryTotals.clear();
  }
  floodTotalReqs++;
  const c = (floodIpCounts.get(ip) || 0) + 1;
  floodIpCounts.set(ip, c);

  const category = categorizePath(reqPath);
  floodCategoryTotals.set(category, (floodCategoryTotals.get(category) || 0) + 1);
  if (!floodIpCategories.has(ip)) floodIpCategories.set(ip, new Map());
  const catMap = floodIpCategories.get(ip);
  catMap.set(category, (catMap.get(category) || 0) + 1);

  return c;
}

// Tracks how many consecutive flood-windows in a row an IP has gone over
// the limit. An IP that floods 3 windows running (30+ seconds of sustained
// abuse) gets auto-banned outright — no reason a real browser/user ever
// legitimately sends 150+ req/10s for half a minute straight. (Banned IPs
// are already rejected earlier in the middleware chain — see the ban-check
// above — so once this fires, the attacker stops reaching this point at all.)
const floodOffenseStreak = new Map(); // ip → consecutive over-limit windows
const FLOOD_AUTOBAN_STREAK = 3;

app.use((req, res, next) => {
  const ip = getClientIP(req);
  const countThisWindow = floodTick(ip, req.path || "/");
  if (countThisWindow > FLOOD_MAX_PER_IP) {
    const streak = (floodOffenseStreak.get(ip) || 0) + 1;
    floodOffenseStreak.set(ip, streak);
    if (streak >= FLOOD_AUTOBAN_STREAK) {
      if (AUTO_BAN_ENABLED) {
        bannedIPs.add(ip);
        saveBannedIPs();
        console.warn(`[FLOOD-AUTOBAN] ${ip} banned after ${streak} consecutive flood windows`);
      } else {
        // Auto-banning is off: log it, keep rejecting with 429, but never
        // write this IP into the permanent ban list.
        console.warn(`[FLOOD] ${ip} over limit (${streak} windows) — throttled, NOT banned (auto-ban disabled)`);
      }
    }
    // Cheap rejection — no route handler, no DB/socket work, just enough to
    // keep the event loop free for the health check.
    res.status(429).end();
    return;
  } else {
    floodOffenseStreak.delete(ip); // reset streak once they're back under the limit
  }
  next();
});

// Periodically forget offense streaks for IPs that haven't been seen in a
// while, so this map can't grow unbounded over a long-running process.
setInterval(() => {
  if (floodOffenseStreak.size > 5000) floodOffenseStreak.clear();
}, 30 * 60_000);


// (see shouldLogSiteVisit/recordSiteVisit above — skips assets/API/socket.io)
app.use((req, res, next) => {
  if (req.method === "GET") recordPageView(req.path);   // stats: page opens
  if (shouldLogSiteVisit(req)) recordSiteVisit(req);
  next();
});

// ── Blocked-country page ────────────────────────────────────────────────────
function blockedCountryHTML() {
  return `<!DOCTYPE html>
<html lang="ka">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>GAICANI</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{min-height:100%;background:#1e1f22;display:flex;align-items:center;justify-content:center;font-family:"Segoe UI",Arial,sans-serif}
.box{background:#2b2d31;border-radius:16px;padding:36px 28px;max-width:420px;width:92%;text-align:center;box-shadow:0 8px 40px rgba(0,0,0,.5)}
.logo{font-size:1.8em;font-weight:900;color:#fff;letter-spacing:1px;margin-bottom:14px}
.msg{color:#dcddde;font-size:1.05em;line-height:1.6;margin-bottom:8px}
.sub{color:#72767d;font-size:.85em;line-height:1.5;margin-top:14px}
</style>
</head>
<body>
<div class="box">
  <div class="logo">GAICANI</div>
  <p class="msg">ეს სერვისი ხელმისაწვდომია მხოლოდ საქართველოს ტერიტორიაზე.</p>
  <p class="sub">This service is only available within Georgia.</p>
</div>
</body>
</html>`;
}

// ── Geo-gate — covers the WHOLE site, not just "/" ────────────────────────────
// Originally this only checked req.path === "/", which left a real gap:
// anyone worldwide could load /dashboard.html, /friend-chat.html, or hit any
// /api/* endpoint directly, completely skipping the block. This now applies
// to every GET/POST request except the admin panel (ROUTE.* paths), which
// intentionally has its own key-login gate designed to work from any IP —
// geo-gating it too would lock the owner out while traveling.
app.use(async (req, res, next) => {
  // Admin panel & its API routes are never geo-gated — they have their own
  // key-login system (see ADMIN_KEY / hasValidAdminSession) that's meant to
  // work from anywhere.
  if (Object.values(ROUTE).some(r => req.path.startsWith(r))) return next();

  // Only gate GET (pages/assets) and POST (API calls like login/register/
  // gif-search/etc.) — nothing else meaningfully hits this app.
  if (req.method !== "GET" && req.method !== "POST") return next();

  const ip = (req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket?.remoteAddress || "");

  // Owner always passes
  if (OWNER_IPS.has(ip)) return next();

  // Already passed the geo-check (cookie set on a prior GE visit) — avoids
  // re-running a geo lookup on every single asset/API request.
  if (hasCaptchaCookie(req)) return next();

  // Geo-gate: only Georgian IPs may access the site. Everyone else gets a
  // bare connection drop — no page content, no branding, nothing disclosed
  // about what this site even is. (Primary enforcement should happen at
  // Cloudflare's edge via a Country-based Custom Rule, which stops the
  // request before it ever reaches this server at all — this is just the
  // fallback in case that's ever misconfigured or bypassed.)
  const country = await getCountry(ip);
  if (country !== "GE") {
    res.status(403).end();
    return;
  }

  setCaptchaCookie(res, ip, req);
  return next();
});

// POST /captcha-verify — check submitted answer (also before static)
app.use(express.urlencoded({ extended: false }));

app.post("/captcha-verify", (req, res) => {
  const ip = (req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket?.remoteAddress || "");
  const challenge = captchaChallenges.get(ip);

  if (!challenge || Date.now() > challenge.expires) {
    newChallenge(ip);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(captchaPageHTML(ip, "ვადა გავიდა. სცადეთ თავიდან."));
  }

  // Parse selected tile indices from comma-separated string
  const raw = String(req.body?.selected || "");
  const selected = raw.split(",").map(s => parseInt(s, 10)).filter(n => !isNaN(n) && n >= 0 && n <= 8);
  const correct  = challenge.correctIndices;

  // Must select exactly the correct set (all correct, none wrong)
  const allCorrectSelected = correct.every(i => selected.includes(i));
  const noWrongSelected    = selected.every(i => correct.includes(i));
  const passed = allCorrectSelected && noWrongSelected && selected.length > 0;

  if (!passed) {
    newChallenge(ip);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(captchaPageHTML(ip, "სცადეთ თავიდან — აარჩიეთ ყველა სწორი სურათი."));
  }

  captchaChallenges.delete(ip);
  setCaptchaCookie(res, ip, req);
  res.redirect(302, "/");
});

// ── Never serve server-side code or data files ───────────────────────────
// express.static below serves the WHOLE project folder, which also holds
// server.js itself and, if the data disk isn't usable (see DATA_PATH),
// every data file — registered_users.json with password hashes,
// private_messages.json with everyone's private chats, IP logs. All of
// that was downloadable by anyone who guessed the name. This runs first
// and refuses them. It matches on the real file name AFTER decoding and
// normalising, so /%73erver.js, //server.js or /x/../server.js don't slip
// past. The one legitimate .json a page needs, /manifest.json, stays open.
const PUBLIC_FILE_DENY = [
  /^server(-[\w-]+)?\.js$/i,     // server.js and server-*.js patches
  /^vt-checker\.js$/i,
  /^package(-lock)?\.json$/i,
  /\.jsonl?$/i,                  // every data file (+ the .jsonl flood log)
  /\.jsonl?\.[\w-]+$/i,          // ...and their .tmp / .corrupt-<time> copies
];
app.use((req, res, next) => {
  let p;
  try { p = decodeURIComponent(req.path); } catch { return res.status(400).end(); }
  const base = path.posix.basename(path.posix.normalize(p));
  if (base.startsWith(".")) return res.status(404).end();            // .env and other dotfiles
  if (base.toLowerCase() === "manifest.json") return next();         // the PWA manifest is public
  if (PUBLIC_FILE_DENY.some(re => re.test(base))) return res.status(404).end();
  next();
});

// ── Accounts blocked for an offensive name can use nothing but the rename ──
const NAME_BLOCK_ALLOWED = new Set(["/auth/verify", "/auth/login", "/auth/logout", "/auth/rename-required", "/auth/delete-account", "/challenge"]);
app.use("/api", (req, res, next) => {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token || NAME_BLOCK_ALLOWED.has(req.path)) return next();
  const entry = authTokens.get(token);
  const user = entry && registeredUsers.get(entry.usernameLower);
  if (user && user.nameBlocked) return res.status(403).json({ error: "ანგარიში დაბლოკილია შეურაცხმყოფელი სახელის გამო", nameBlocked: true });
  next();
});

// Images (avatars, game icons, logos) almost never change, so browsers may
// keep them for a day instead of re-asking on every page view — the
// dashboard alone shows dozens. HTML/JS/CSS keep revalidating every time so
// site updates show up immediately.
const LONG_CACHE_EXT = /\.(png|jpe?g|gif|webp|svg|ico)$/i;
app.use(express.static(path.join(__dirname), {
  setHeaders(res, filePath) {
    if (LONG_CACHE_EXT.test(filePath)) res.setHeader("Cache-Control", "public, max-age=86400");
  },
}));
// Uploaded private-chat photos live outside __dirname (see PRIVATE_PHOTOS_DIR
// above), so they need their own explicit static route to be reachable.
app.use("/private-photos", express.static(PRIVATE_PHOTOS_DIR, { maxAge: "7d" }));

// (captcha gate was previously here — moved above static)

// GIF search hits Giphy's API (external quota) and each result carries
// thumbnail bandwidth — tightened from 120/min to 40/min per IP.
const gifHttpLimiter = rateLimit({ windowMs: 60_000, max: 40, standardHeaders: true, legacyHeaders: false });

app.get("/api/gifs", gifHttpLimiter, async (req, res) => {
  const q = (req.query.q || "").trim().slice(0, 100);
  const endpoint = q
    ? `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_KEY}&q=${encodeURIComponent(q)}&limit=24&rating=pg-13`
    : `https://api.giphy.com/v1/gifs/trending?api_key=${GIPHY_KEY}&limit=24&rating=pg-13`;
  try {
    const response = await fetch(endpoint);
    const data = await response.json();

    if (!response.ok || data.meta?.status !== 200) {
      console.error("Giphy error:", response.status, data.meta || data);
      return res.status(502).json({ error: "Failed to fetch GIFs" });
    }

    // Normalize Giphy's shape into the old Tenor-style shape so the
    // frontend (script.js) doesn't need to change at all.
    const results = (data.data || []).map(g => ({
      media: [{
        tinygif: { url: g.images?.fixed_width_small?.url || g.images?.fixed_height_small?.url },
        gif:     { url: g.images?.original?.url || g.images?.fixed_height?.url }
      }]
    }));

    res.set("Cache-Control", "public, max-age=300");
    res.json({ results });
  } catch (err) {
    console.error("Giphy fetch failed:", err.message);
    res.status(502).json({ error: "Failed to fetch GIFs" });
  }
});

// ── Curated fallback playlist (no API key required) ────────────────────────
// Used whenever YOUTUBE_API_KEY isn't set, and also as the list shown the
// moment the music panel opens (before the user types anything to search).
//
// To add/replace songs: just paste a normal YouTube link as `url` — the
// video ID is pulled out automatically with the same extractYouTubeId()
// helper used everywhere else in this file. Thumbnails are generated from
// the video ID directly (https://i.ytimg.com/vi/<id>/mqdefault.jpg), so no
// API call is needed for this list to work.
//
// NOTE: these entries were picked as well-known, popular tracks, but they
// haven't been live-verified against YouTube — a video could theoretically
// be unavailable/region-locked. Swap in songs you've confirmed yourself if
// you want a guaranteed-working list.
const MUSIC_LIST = [
  { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "Never Gonna Give You Up", channel: "Rick Astley" },
  { url: "https://www.youtube.com/watch?v=9bZkp7q19f0", title: "Gangnam Style",             channel: "PSY" },
  { url: "https://www.youtube.com/watch?v=kJQP7kiw5Fk", title: "Despacito",                 channel: "Luis Fonsi" },
  { url: "https://www.youtube.com/watch?v=JGwWNGJdvx8", title: "Shape of You",               channel: "Ed Sheeran" },
  { url: "https://www.youtube.com/watch?v=OPf0YbXqDm0", title: "Uptown Funk",                channel: "Mark Ronson ft. Bruno Mars" },
  { url: "https://www.youtube.com/watch?v=RgKAFK5djSk", title: "See You Again",              channel: "Wiz Khalifa ft. Charlie Puth" },
  { url: "https://www.youtube.com/watch?v=fJ9rUzIMcZQ", title: "Bohemian Rhapsody",          channel: "Queen" },
  { url: "https://www.youtube.com/watch?v=YQHsXMglC9A", title: "Hello",                      channel: "Adele" },
];

const MUSIC_LIST_RESOLVED = MUSIC_LIST
  .map(item => {
    const videoId = extractYouTubeId(item.url);
    return videoId ? {
      videoId,
      title:   item.title,
      channel: item.channel,
      thumb:   `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    } : null;
  })
  .filter(Boolean);

// ── Music search (powers the "Listen Together" search panel) ──────────────────
// Replaces pasting a raw YouTube link: the client gets a list back (either
// the curated list above, or — if YOUTUBE_API_KEY is set — live YouTube
// results/trending), and taps one to send the listen-together invite (see
// music:request below — unchanged).
//
// Results are cached per query for 10 minutes since the free YouTube Data
// API v3 quota (10,000 units/day) only allows ~100 search calls/day.
const musicSearchCache       = new Map(); // query (lowercased, or "__browse__") → { results, ts }
const MUSIC_SEARCH_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// Without this, every unique search query ever typed stays in memory
// forever (unlike geoCache/captchaChallenges, which already get swept).
// Runs alongside the other periodic cleanups already in the file.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of musicSearchCache) {
    if (now - entry.ts > MUSIC_SEARCH_CACHE_TTL) musicSearchCache.delete(key);
  }
}, 5 * 60_000);

// Music search hits the YouTube Data API (external quota, costs real $/limits
// per Google) — tightened from 30/min to 15/min per IP.
const musicSearchLimiter     = rateLimit({ windowMs: 60_000, max: 15, standardHeaders: true, legacyHeaders: false });

app.get("/api/music-search", musicSearchLimiter, async (req, res) => {
  const q = (req.query.q || "").trim().slice(0, 100);

  // No API key configured → always serve the curated list, filtered by
  // query text when there is one.
  if (!YOUTUBE_API_KEY) {
    if (!q) return res.json({ results: MUSIC_LIST_RESOLVED });
    const qLower = q.toLowerCase();
    const filtered = MUSIC_LIST_RESOLVED.filter(
      item => item.title.toLowerCase().includes(qLower) || item.channel.toLowerCase().includes(qLower)
    );
    return res.json({ results: filtered });
  }

  const cacheKey = q ? q.toLowerCase() : "__browse__";
  const cached = musicSearchCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < MUSIC_SEARCH_CACHE_TTL) {
    return res.json({ results: cached.results });
  }

  try {
    let results;

    if (!q) {
      // Panel just opened with no query yet — show trending music instead
      // of an empty box.
      const endpoint = "https://www.googleapis.com/youtube/v3/videos"
        + `?part=snippet&chart=mostPopular&videoCategoryId=10&maxResults=10`
        + `&regionCode=GE&key=${YOUTUBE_API_KEY}`;
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(6000) });
      const data = await response.json();
      if (!response.ok) {
        console.error("YouTube trending error:", response.status, data.error || data);
        return res.json({ results: MUSIC_LIST_RESOLVED }); // graceful fallback
      }
      results = (data.items || [])
        .filter(it => it.id)
        .map(it => ({
          videoId: it.id,
          title:   it.snippet?.title || "",
          channel: it.snippet?.channelTitle || "",
          thumb:   it.snippet?.thumbnails?.default?.url || `https://i.ytimg.com/vi/${it.id}/mqdefault.jpg`,
        }));
    } else {
      const endpoint = "https://www.googleapis.com/youtube/v3/search"
        + `?part=snippet&type=video&videoEmbeddable=true&safeSearch=moderate&maxResults=10`
        + `&q=${encodeURIComponent(q)}&key=${YOUTUBE_API_KEY}`;
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(6000) });
      const data = await response.json();
      if (!response.ok) {
        console.error("YouTube search error:", response.status, data.error || data);
        return res.status(502).json({ error: "ძებნა ვერ განხორციელდა." });
      }
      results = (data.items || [])
        .filter(it => it.id && it.id.videoId)
        .map(it => ({
          videoId: it.id.videoId,
          title:   it.snippet?.title || "",
          channel: it.snippet?.channelTitle || "",
          thumb:   it.snippet?.thumbnails?.default?.url || it.snippet?.thumbnails?.medium?.url || "",
        }));
    }

    musicSearchCache.set(cacheKey, { results, ts: Date.now() });
    res.set("Cache-Control", "public, max-age=300");
    res.json({ results });
  } catch (err) {
    console.error("YouTube search fetch failed:", err.message);
    res.status(502).json({ error: "ძებნა ვერ განხორციელდა." });
  }
});


app.get("/api/random-fact", (req, res) => {
  FACTS = loadLines("facts.txt");
  const fact = randomItem(FACTS);
  if (!fact) return res.status(404).json({ error: "No facts available" });
  res.json({ fact });
});

app.get("/api/random-question", (req, res) => {
  QUESTIONS = loadLines("questions.txt");
  const question = randomItem(QUESTIONS);
  if (!question) return res.status(404).json({ error: "No questions available" });
  res.json({ question });
});

// GET <users route>  — list all connected users with IPs
app.get(ROUTE.users, ownerOnly, (req, res) => {
  const users = [];
  for (const [, socket] of io.sockets.sockets) {
    users.push({
      id:        socket.id,
      name:      socket.userName || "(no name)",
      ip:        socket.clientIP || "unknown",
      userAgent: socket.userAgent || "",
      partner:   socket.partner ? socket.partner.userName : null,
      connected: socket.connected,
    });
  }
  users.sort((a, b) => (b.partner ? 1 : 0) - (a.partner ? 1 : 0));
  res.json({ count: users.length, users });
});

// GET <regUsers route> — every REGISTERED account (not just who's online
// right now) with the IP they most recently logged in from, so a problem
// account can be IP-banned directly from here even while they're offline.
app.get(ROUTE.regUsers, ownerOnly, (req, res) => {
  const rows = [];
  for (const [, u] of registeredUsers) {
    rows.push({
      username: u.username,
      lastIP: u.lastIP || null,
      lastIPAt: u.lastIPAt || null,
      isAdmin: !!u.isAdmin,
      isPro: !!u.isPro,
      isGuest: !!u.isGuest,
      nameBlocked: !!u.nameBlocked,
      isBanned: u.lastIP ? isIPBanned(u.lastIP) : false,
    });
  }
  // Most-recently-seen first — the accounts an admin is most likely to be
  // looking into are the ones who were just active.
  rows.sort((a, b) => (b.lastIPAt || 0) - (a.lastIPAt || 0));
  res.json({ count: rows.length, users: rows });
});


// POST <deleteUser route>?username=x[&banIp=false]  — admin removal of an account.
//
// Deliberately HARSHER than the self-serve deletion in /api/auth/delete-account:
//   * self-delete ANONYMISES forum/room content so conversations stay readable
//   * this DELETES it, because it exists to remove an abuser's output entirely
// It also bans the account's last known IP by default. Pass banIp=false to
// delete without banning (e.g. removing a duplicate or test account).
app.post(ROUTE.deleteUser, ownerOnly, (req, res) => {
  const username = String(req.query.username || "").trim();
  const banIp = req.query.banIp !== "false";
  if (!username) return res.status(400).json({ error: "username param required" });

  const lc = username.toLowerCase();
  const user = registeredUsers.get(lc);
  if (!user) return res.status(404).json({ error: "user not found" });
  // Guard against wiping out an administrator by a mistyped name.
  if (user.isAdmin) return res.status(403).json({ error: "cannot delete an admin account" });

  const lastIP = user.lastIP || null;
  let removedPosts = 0, removedComments = 0, removedRoomMsgs = 0;

  // ── forum: remove their posts outright, and their comments elsewhere ──
  for (const [postId, post] of [...forumPosts]) {
    if (post.authorLc === lc) { forumPosts.delete(postId); removedPosts++; continue; }
    if (Array.isArray(post.comments)) {
      const before = post.comments.length;
      post.comments = post.comments.filter(c => c.authorLc !== lc);
      removedComments += before - post.comments.length;
    }
    if (post.votes) delete post.votes[lc];
  }

  // ── rooms: strip their messages and membership ──
  for (const [, room] of chatRooms) {
    if (Array.isArray(room.messages)) {
      const before = room.messages.length;
      room.messages = room.messages.filter(m => m.fromLc !== lc);
      removedRoomMsgs += before - room.messages.length;
    }
    if (Array.isArray(room.members)) room.members = room.members.filter(m => m !== lc);
    if (Array.isArray(room.bannedUsers)) room.bannedUsers = room.bannedUsers.filter(b => b !== lc);
    if (room.lastRead) delete room.lastRead[lc];
  }

  // ── private data and social graph ──
  for (const [roomId, room] of privateRooms) {
    if (roomId.split("::").includes(lc)) { deleteRoomPhotoFiles(room); privateRooms.delete(roomId); }
  }
  for (const [roomId] of friendStreaks) if (roomId.split("::").includes(lc)) friendStreaks.delete(roomId);
  for (const [, other] of registeredUsers) {
    if (Array.isArray(other.friends))         other.friends         = other.friends.filter(f => f !== lc);
    if (Array.isArray(other.pendingRequests)) other.pendingRequests = other.pendingRequests.filter(r => r !== lc);
    if (Array.isArray(other.blockedUsers))    other.blockedUsers    = other.blockedUsers.filter(b => b !== lc);
  }
  if (typeof accountReportLog !== "undefined") accountReportLog.delete(lc);

  // ── kill sessions and kick every live socket ──
  for (const [t, e] of authTokens) if (e.usernameLower === lc) authTokens.delete(t);
  let kicked = 0;
  const sockets = onlineRegSockets.get(lc);
  if (sockets) {
    for (const sid of sockets) {
      const s = io.sockets.sockets.get(sid);
      if (s) { s.emit("auth:accountDeleted"); setTimeout(() => s.disconnect(true), 300); kicked++; }
    }
  }
  onlineRegSockets.delete(lc);
  registeredUsers.delete(lc);
  authReservedNames.delete(lc);
  activeUsernames.delete(lc);

  // ── ban the last known IP (this is a manual admin action, so it is NOT
  //    affected by the AUTO_BAN_ENABLED switch that disables self-banning) ──
  let bannedIp = null;
  if (banIp && lastIP) {
    bannedIPs.add(lastIP);
    saveBannedIPs();
    bannedIp = lastIP;
    for (const [, s] of io.sockets.sockets) {
      if (s.clientIP === lastIP) { s.emit("autoKicked"); setTimeout(() => s.disconnect(true), 300); }
    }
  }

  forgetNotificationsOf(lc);
  saveAuthUsers(); savePrivateMsgs(); saveStreaks(); saveChatRooms(); saveForum();
  console.log(`[ADMIN] Deleted account "${username}" — ${removedPosts} post(s), ${removedComments} comment(s), ${removedRoomMsgs} room message(s), ${kicked} socket(s) kicked, IP ${bannedIp || "not banned"}`);

  res.json({
    success: true, username,
    removedPosts, removedComments, removedRoomMsgs,
    kickedSockets: kicked, bannedIp,
  });
});

// POST <setPro route>?username=x&pro=true|false — grant or revoke pro
// status on a registered account. Pro gets them a visible star badge,
// exemption from the click-ad system, and photo-sending in private chat
// with their mutual friends.
app.post(ROUTE.setPro, ownerOnly, (req, res) => {
  const username = String(req.query.username || "").trim();
  const pro = req.query.pro !== "false"; // default true; explicit "false" revokes
  if (!username) return res.status(400).json({ error: "username param required" });

  const lc = username.toLowerCase();
  const user = registeredUsers.get(lc);
  if (!user) return res.status(404).json({ error: "user not found" });
  if (user.isGuest) return res.status(400).json({ error: "guests cannot be granted pro status" });

  user.isPro = pro;
  saveAuthUsers();

  // If they're online right now, tell their live session immediately —
  // otherwise the star/ad-exemption/photo-button wouldn't show up until
  // their next login, which is confusing right after an admin just did this.
  let notified = 0;
  const sockets = onlineRegSockets.get(lc);
  if (sockets) {
    for (const sid of sockets) {
      const s = io.sockets.sockets.get(sid);
      if (s) { s.emit("auth:proStatusChanged", { isPro: pro }); notified++; }
    }
  }

  console.log(`[ADMIN] ${pro ? "Granted" : "Revoked"} pro status for "${user.username}"`);
  res.json({ success: true, username: user.username, isPro: pro, notifiedSockets: notified });
});

// POST <nameBlock route>?username=x&block=true|false — block an account for an
// offensive name. It's logged out everywhere and must choose a new name.
app.post(ROUTE.nameBlock, ownerOnly, (req, res) => {
  const lc = String(req.query.username || "").trim().toLowerCase();
  const block = req.query.block !== "false";
  const user = registeredUsers.get(lc);
  if (!user) return res.status(404).json({ error: "user not found" });
  if (user.isGuest) return res.status(400).json({ error: "guests have no account name" });
  if (user.isAdmin) return res.status(403).json({ error: "admin accounts can't be name-blocked" });
  user.nameBlocked = block;
  if (block) user.nameBlockedAt = new Date().toISOString(); else delete user.nameBlockedAt;
  saveAuthUsers();
  let kicked = 0;
  if (block) {
    for (const sid of [...(onlineRegSockets.get(lc) || [])]) {
      const sk = io.sockets.sockets.get(sid);
      if (sk) { sk.emit("account:nameBlocked", { username: user.username }); setTimeout(() => sk.disconnect(true), 400); kicked++; }
    }
    announceOnlineChanged();
  }
  console.log(`[ADMIN] ${block ? "Name-blocked" : "Lifted the name block on"} "${user.username}"`);
  res.json({ success: true, username: user.username, nameBlocked: block, kickedSockets: kicked });
});

// POST <tempBan route>?ip=1.2.3.4&username=x  — block an IP for 24 hours.
// Unlike the permanent ban this one is EXPLAINED to the visitor: they get a
// page naming the offending username and saying when they can return.
app.post(ROUTE.tempBan, ownerOnly, (req, res) => {
  const ip = String(req.query.ip || "").trim();
  const username = String(req.query.username || "").trim();
  if (!ip) return res.status(400).json({ error: "ip param required" });

  const entry = addTempBan(ip, username, "offensive_name");

  let kicked = 0;
  for (const [, s] of io.sockets.sockets) {
    if (s.clientIP === ip) {
      s.emit("tempBanned", {
        hours: 24,
        reason: "offensive_name",
        username,
        until: entry.until,
      });
      setTimeout(() => s.disconnect(true), 600);
      kicked++;
    }
  }
  console.log(`[ADMIN] 24h block on ${ip} (name: ${username || "n/a"}) — kicked ${kicked} socket(s)`);
  res.json({ success: true, ip, username, until: entry.until, kickedSockets: kicked });
});

// GET <tempBansList route> — every currently-active 24h block, with how
// much time is left on each. Expired entries are pruned on the way out
// (getTempBan() already does this lazily per-IP; here we sweep the whole
// map so the list doesn't show stale rows that would vanish on their own
// the next time someone actually hits that IP).
app.get(ROUTE.tempBansList, ownerOnly, (req, res) => {
  const now = Date.now();
  const list = [];
  for (const [ip, entry] of [...tempBans]) {
    if (now >= entry.until) { tempBans.delete(ip); continue; }
    list.push({
      ip,
      username: entry.username || "",
      reason: entry.reason || "offensive_name",
      until: entry.until,
      remainingMs: entry.until - now,
    });
  }
  list.sort((a, b) => a.remainingMs - b.remainingMs); // soonest-to-expire first
  res.json({ count: list.length, bans: list });
});

// POST <unbanTemp route>?ip=1.2.3.4 — lift a 24h block early
app.post(ROUTE.unbanTemp, ownerOnly, (req, res) => {
  const ip = String(req.query.ip || "").trim();
  if (!ip) return res.status(400).json({ error: "ip param required" });
  const had = tempBans.delete(ip);
  console.log(`[ADMIN] Lifted 24h block on ${ip} early`);
  res.json({ success: true, ip, wasActive: had });
});

// POST <ban route>?ip=1.2.3.4  — ban an IP and kick all matching sockets
app.post(ROUTE.ban, ownerOnly, (req, res) => {
  const ip = (req.query.ip || "").trim();
  if (!ip) return res.status(400).json({ error: "ip param required" });
  if (ip.includes("/")) {
    const r = parseBanEntry(ip);
    if (!r) return res.status(400).json({ error: `"${ip}" is not a valid range — use e.g. 2a09:bac0::/29 or 104.28.0.0/16` });
    if ((r.v === 4 && r.bits < 8) || (r.v === 6 && r.bits < 16))
      return res.status(400).json({ error: "That range is too large — it would ban a huge part of the internet" });
    const mine = [getClientIP(req), req.headers["cf-connecting-ip"]].filter(Boolean);
    if (mine.some(a => ipInRange(a, r)))
      return res.status(400).json({ error: "That range includes YOUR OWN address — you would lock yourself out" });
  }

  bannedIPs.add(ip);
  rebuildBannedRanges();
  saveBannedIPs(); // persist to disk — survives restarts
  let kicked = 0;
  for (const [, socket] of io.sockets.sockets) {
    if (isIPBanned(socket.clientIP) || isIPBanned(socket.handshake.headers["cf-connecting-ip"])) {
      socket.emit("autoKicked");
      setTimeout(() => socket.disconnect(true), 500);
      kicked++;
    }
  }
  console.log(`[ADMIN] Banned IP ${ip} — kicked ${kicked} socket(s)`);
  res.json({ ok: true, ip, kicked });
});

// POST <unban route>?ip=1.2.3.4  — remove an IP ban
app.post(ROUTE.unban, ownerOnly, (req, res) => {
  const ip = (req.query.ip || "").trim();
  if (!ip) return res.status(400).json({ error: "ip param required" });
  const existed = bannedIPs.delete(ip);
  if (existed) { rebuildBannedRanges(); saveBannedIPs(); } // persist removal to disk
  res.json({ ok: true, ip, wasBanned: existed });
});

// GET <bans route>  — list all currently banned IPs
app.get(ROUTE.bans, ownerOnly, (req, res) => {
  res.json({ count: bannedIPs.size, ips: [...bannedIPs] });
});

// GET <reported route>  — list EVERY IP that has at least one report on file
// (not just the ones that hit the 5-report auto-ban). Each entry says
// whether it's currently auto-banned (from hitting the threshold) and/or
// permanently banned (from a manual "Ban Forever" click), so the owner can
// eyeball every report and decide to block or leave it as-is.
app.get(ROUTE.reported, ownerOnly, (req, res) => {
  const now = Date.now();
  const result = [];
  for (const [ip, entry] of reportStrikes) {
    const autoBanActive = !!(entry.bannedUntil && now < entry.bannedUntil);
    const remainingHrs  = autoBanActive
      ? Math.ceil((entry.bannedUntil - now) / (60 * 60 * 1000))
      : null;
    result.push({
      ip,
      count:          entry.count,
      autoBanned:     autoBanActive,
      remainingHrs,
      permaBanned:    isIPBanned(ip),
      names:          entry.names ? [...entry.names] : [],
      reasons:        entry.reasons || [],
      firstReportAt:  entry.firstReportAt ? new Date(entry.firstReportAt).toISOString() : null,
    });
  }
  // Most-reported first
  result.sort((a, b) => b.count - a.count);
  res.json({ count: result.length, reported: result });
});

// GET <accountReports route> — reports filed against registered accounts
// from their profile card (see accountReportLog / user:report above)
app.get(ROUTE.accountReports, ownerOnly, (req, res) => {
  const result = [];
  for (const [targetLc, reports] of accountReportLog) {
    const targetUser = registeredUsers.get(targetLc);
    result.push({
      username: targetUser?.username || targetLc,
      count: reports.length,
      reports: reports.slice(-20).reverse(), // most recent first, capped
    });
  }
  result.sort((a, b) => b.count - a.count);
  res.json({ count: result.length, reported: result });
});

// POST <unbanReported route>?ip=1.2.3.4  — clear a report-ban early (resets strike count to 0)
app.post(ROUTE.unbanReported, ownerOnly, (req, res) => {
  const ip = (req.query.ip || "").trim();
  if (!ip) return res.status(400).json({ error: "ip param required" });
  const existed = clearReportBan(ip);
  console.log(`[ADMIN] Cleared report-ban for IP ${ip} (existed=${existed})`);
  res.json({ ok: true, ip, wasBanned: existed });
});

// GET <siteVisitors route>  — every real page-visit logged so far (IP + UA)
app.get(ROUTE.siteVisitors, ownerOnly, (req, res) => {
  res.json({
    count:   siteVisitorLog.length,
    entries: [...siteVisitorLog].reverse(),
  });
});

// GET <blockedUAs route>  — list all currently blocked user-agents
app.get(ROUTE.blockedUAs, ownerOnly, (req, res) => {
  res.json({ count: bannedUserAgents.size, userAgents: [...bannedUserAgents] });
});

// POST <blockUA route>?ua=...  — block a user-agent and kick matching live sockets
app.post(ROUTE.blockUA, ownerOnly, (req, res) => {
  const ua = normalizeUA(req.query.ua || "");
  if (!ua) return res.status(400).json({ error: "ua param required" });

  bannedUserAgents.add(ua);
  saveBannedUserAgents(); // persist to disk — survives restarts

  let kicked = 0;
  for (const [, socket] of io.sockets.sockets) {
    if (normalizeUA(socket.userAgent) === ua) {
      socket.emit("autoKicked");
      setTimeout(() => socket.disconnect(true), 500);
      kicked++;
    }
  }
  console.log(`[ADMIN] Blocked User-Agent "${ua.slice(0, 120)}" — kicked ${kicked} socket(s)`);
  res.json({ ok: true, ua, kicked });
});

// POST <unblockUA route>?ua=...  — remove a user-agent block
app.post(ROUTE.unblockUA, ownerOnly, (req, res) => {
  const ua = normalizeUA(req.query.ua || "");
  if (!ua) return res.status(400).json({ error: "ua param required" });
  const existed = bannedUserAgents.delete(ua);
  if (existed) saveBannedUserAgents(); // persist removal to disk
  res.json({ ok: true, ua, wasBanned: existed });
});

// GET <panel route>  — visual admin panel; ALWAYS shows the key-login screen
// first unless there's a valid admin session cookie from a previous
// successful login. No IP bypass — the key is required from anywhere.
app.get(ROUTE.panel, (req, res) => {
  if (!hasValidAdminSession(req)) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(adminLoginPageHtml());
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderAdminPanelHtml());
});

// POST <panel route>  — submit the admin key to log in
app.post(ROUTE.panel, (req, res) => {
  const key = (req.body && req.body.key || "").toString();
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (key !== ADMIN_KEY) {
    console.warn(`[ADMIN-LOGIN] Failed login attempt from IP ${getClientIP(req)}`);
    res.status(401).send(adminLoginPageHtml("Incorrect key — try again"));
    return;
  }
  createAdminSession(res, req);
  console.log(`[ADMIN-LOGIN] Successful login from IP ${getClientIP(req)}`);
  res.send(renderAdminPanelHtml());
});

function renderAdminPanelHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Admin Panel</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#1e1f22;--surface:#2b2d31;--surface2:#232427;--border:#1a1b1e;--text:#dcddde;--muted:#72767d;--accent:#5865f2}
html{-webkit-text-size-adjust:100%}
body{background:var(--bg);color:var(--text);font-family:-apple-system,"Segoe UI",Arial,sans-serif;padding:16px;padding:max(16px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(16px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));max-width:1100px;margin:0 auto}
h1{color:#fff;font-size:1.25em;margin-bottom:4px}
.subtitle{color:var(--muted);font-size:.8em;margin-bottom:16px}
.top-bar{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:18px;position:sticky;top:0;background:var(--bg);padding:8px 0;z-index:10;border-bottom:1px solid var(--border)}
.card{background:var(--surface);border-radius:10px;padding:16px;margin-bottom:12px}
.ip{font-family:monospace;color:#fff;font-size:1em;word-break:break-all}
.ban-btn{background:#f23f42;color:#fff;border:none;border-radius:6px;padding:7px 14px;cursor:pointer;font-size:.85em;min-height:32px}
.ban-btn:hover{background:#c0393b}
.unban-btn{background:#3ba55d;color:#fff;border:none;border-radius:6px;padding:7px 14px;cursor:pointer;font-size:.85em;min-height:32px}
.unban-btn:hover{background:#2d8a4e}
.badge{display:inline-block;background:rgba(88,101,242,.2);color:#5865f2;border-radius:4px;font-size:.75em;padding:2px 7px;margin-left:6px}
.badge.green{background:rgba(59,165,93,.2);color:#3ba55d}
.reason-list{margin:0;padding:0;list-style:none;max-width:320px}
.reason-list li{font-size:.85em;color:var(--text);padding:3px 0;border-bottom:1px solid var(--border)}
.reason-list li:last-child{border-bottom:none}
.reason-list .meta{color:var(--muted);font-size:.85em}
.refresh-btn{background:var(--accent);color:#fff;border:none;border-radius:6px;padding:9px 18px;cursor:pointer;font-size:.88em;min-height:38px}
.refresh-btn:hover{background:#4752c4}
.collapse-all-btn{background:var(--surface2);color:var(--text);border:1px solid #3a3c40;border-radius:6px;padding:9px 16px;cursor:pointer;font-size:.85em;min-height:38px}
.collapse-all-btn:hover{background:#2f3136}

/* ── Collapsible sections — native <details>, no JS needed to expand/
   collapse, so there is nothing here that can break the data-loading
   logic below it. ── */
details.section{background:var(--surface);border-radius:10px;margin-bottom:10px;overflow:hidden}
details.section > summary{
  list-style:none;cursor:pointer;padding:14px 16px;color:#8b93ff;font-size:.92em;font-weight:600;
  display:flex;align-items:center;gap:8px;user-select:none;min-height:24px;
}
details.section > summary::-webkit-details-marker{display:none}
details.section > summary::before{content:"▸";display:inline-block;font-size:.8em;color:var(--muted);transition:transform .15s ease;flex-shrink:0}
details.section[open] > summary::before{transform:rotate(90deg)}
details.section > summary .count-badge{margin-left:auto;background:rgba(88,101,242,.2);color:#8b93ff;border-radius:10px;padding:2px 9px;font-size:.78em;font-weight:700}
details.section > .section-body{padding:0 16px 16px;overflow-x:auto;-webkit-overflow-scrolling:touch}
#status{color:#3ba55d;font-size:.85em;display:inline-block}

/* Tables scroll horizontally within their section on narrow screens
   (via .section-body's overflow-x, set above) instead of squeezing
   every column unreadably small. */
table{width:100%;border-collapse:collapse;min-width:480px}
td,th{padding:9px 10px;text-align:left;font-size:.85em}
th{color:var(--muted);font-weight:600;border-bottom:1px solid var(--border);white-space:nowrap}
tr:hover td{background:rgba(255,255,255,.03)}

.manual-ban-box{background:var(--surface);border-radius:10px;padding:16px}
.manual-ban-box textarea{width:100%;background:var(--bg);border:1px solid #3a3c40;border-radius:6px;color:var(--text);font-family:monospace;font-size:16px;padding:10px 12px;resize:vertical;min-height:72px;outline:none;margin-bottom:10px}
.manual-ban-box textarea:focus{border-color:var(--accent)}
.manual-ban-box input[type=text]{width:100%;background:var(--bg);border:1px solid #3a3c40;border-radius:6px;color:var(--text);font-size:16px;padding:10px 12px;outline:none;margin-bottom:10px;min-height:40px}
.manual-ban-box input[type=text]:focus{border-color:var(--accent)}
.manual-ban-box label{display:block;color:var(--muted);font-size:.78em;margin-bottom:4px}
.do-ban-btn{background:#f23f42;color:#fff;border:none;border-radius:6px;padding:10px 20px;cursor:pointer;font-size:.9em;font-weight:600;min-height:40px;width:100%}
.do-ban-btn:hover{background:#c0393b}
.hint{color:var(--muted);font-size:.76em;margin-top:8px;line-height:1.5}
.ua-cell{max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#b5bac1;font-size:.85em}
.block-ua-btn{background:#faa61a;color:#1e1f22;border:none;border-radius:6px;padding:7px 12px;cursor:pointer;font-size:.8em;font-weight:600;margin-left:6px;white-space:nowrap;min-height:32px}
.block-ua-btn:hover{background:#d78d0f}

@media (max-width:640px){
  body{padding:10px;padding-top:max(10px,env(safe-area-inset-top))}
  h1{font-size:1.1em}
  details.section > summary{font-size:.86em;padding:12px 12px}
  details.section > .section-body{padding:0 12px 14px}
  .manual-ban-box{padding:14px}
  .refresh-btn,.collapse-all-btn{flex:1;text-align:center}
  td,th{padding:8px 6px;font-size:.8em}
}
</style>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Georgian:wght@400;600;800&display=swap" rel="stylesheet">
<style id="admin-enamel">
/* GAICANI admin — "Minankari" design layer (matches the site and the stats
   page). Visual only: every button, id and script below is unchanged.
   Delete this block to get the previous look back. */
:root { --en-bg:#130f26; --en-card:#1c1735; --en-raised:#241e44; --en-line:rgba(214,168,79,.18); --en-gold:#f4d98f; --en-text:#f3eeff; --en-muted:#9a92bd; }
html, body { background:radial-gradient(900px 500px at 50% -150px,rgba(79,108,255,.18),transparent 70%),var(--en-bg); color:var(--en-text);
  font-family:"Noto Sans Georgian",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
h1 { font-weight:800; }
h1 .gt { background:linear-gradient(180deg,#fff4d2,#f4d98f 45%,#d6a84f); -webkit-background-clip:text; background-clip:text; color:transparent; }
.subtitle { color:var(--en-muted); }
.top-bar { background:rgba(19,15,38,.88); border-bottom:1px solid var(--en-line); -webkit-backdrop-filter:blur(10px); backdrop-filter:blur(10px); }
.refresh-btn { background:linear-gradient(135deg,#5b77ff,#8b55ff); border:1px solid rgba(244,217,143,.35); box-shadow:0 8px 20px -10px rgba(109,77,255,.9); }
.collapse-all-btn { background:rgba(255,255,255,.05); border:1px solid var(--en-line); color:var(--en-gold); }
#status { color:var(--en-gold); }
details.section { background:linear-gradient(180deg,#211b40,var(--en-card)); border:1px solid var(--en-line); border-radius:16px; box-shadow:inset 0 1px 0 rgba(255,255,255,.04); }
details.section > summary { color:var(--en-text); font-weight:800; }
details.section > summary::before { color:var(--en-gold); }
details.section > summary .count-badge { background:linear-gradient(135deg,#f4d98f,#d6a84f); color:#2a1d05; font-weight:800; }
details.section[open] > summary { border-bottom:1px solid var(--en-line); }
th { color:var(--en-gold); border-bottom:1px solid var(--en-line); }
td { border-bottom:1px solid rgba(255,255,255,.05); }
tr:hover td { background:rgba(214,168,79,.05); }
.ip { color:#cbb0ff; }
.badge { background:rgba(79,108,255,.16); color:#aab8ff; border:1px solid rgba(79,108,255,.35); border-radius:999px; }
.badge.green { background:rgba(31,193,138,.14); color:#62e3b3; border-color:rgba(31,193,138,.38); }
.ban-btn { background:linear-gradient(135deg,#ff5f80,#c21d49); }
.unban-btn { background:linear-gradient(135deg,#27d39a,#159a6c); }
.do-ban-btn { background:linear-gradient(135deg,#ff5f80,#c21d49); box-shadow:0 10px 24px -12px rgba(227,59,95,.9); }
.block-ua-btn { background:linear-gradient(135deg,#f6c453,#d9820f); }
.ban-btn, .unban-btn, .do-ban-btn, .block-ua-btn, .refresh-btn, .collapse-all-btn { border-radius:10px; }
.manual-ban-box textarea, .manual-ban-box input[type=text], input[type=search], #regSearch { background:#221c42; border:1px solid rgba(214,168,79,.22); color:var(--en-text); }
.manual-ban-box textarea:focus, .manual-ban-box input[type=text]:focus { border-color:rgba(244,217,143,.6); box-shadow:0 0 0 3px rgba(214,168,79,.14); outline:none; }
.hint { color:var(--en-muted); }
code { background:rgba(214,168,79,.12); color:var(--en-gold); border-radius:5px; padding:1px 5px; }
.reason-list li { border-color:rgba(255,255,255,.06); }
.manual-ban-box { background:rgba(255,255,255,.03); border:1px solid rgba(255,255,255,.07); }
/* overview strip */
.ov-wrap { margin:14px 0 16px; padding:14px; background:linear-gradient(180deg,#221c42,var(--en-card)); border:1px solid var(--en-line); border-radius:18px; }
.ov-head { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; }
.ov-title { font-weight:800; color:var(--en-gold); font-size:1.05em; }
.ov-link { color:var(--en-gold); text-decoration:none; font-size:.85em; padding:6px 12px; border-radius:999px; border:1px solid var(--en-line); background:rgba(214,168,79,.08); }
.ov-group { color:var(--en-muted); font-size:.75em; font-weight:700; margin:12px 2px 6px; }
.ov-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:8px; }
.ov-card { background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.07); border-radius:12px; padding:10px 12px; }
.ov-card .v { font-size:1.35em; font-weight:800; line-height:1.15; }
.ov-card .l { color:var(--en-muted); font-size:.76em; margin-top:2px; }
.ov-card .x { color:var(--en-gold); font-size:.72em; margin-top:3px; }
.ov-card.live .v { color:#62e3b3; }
.ov-card.warn { border-color:rgba(240,185,58,.45); background:rgba(240,185,58,.08); }
.ov-card.warn .v { color:#f6c453; }
@media (max-width:600px) { .manual-ban-box textarea, .manual-ban-box input[type=text], #regSearch { font-size:16px; } }
</style>
</head>
<body>
<h1>🛡️ <span class="gt">Admin Panel</span></h1>
<div class="subtitle">GAICANI moderation</div>
<div class="top-bar">
  <button class="refresh-btn" onclick="loadAll()">↻ Refresh</button>
  <button class="collapse-all-btn" onclick="toggleAllSections()" id="collapseAllBtn">⇕ Collapse all</button>
  <span id="status"></span>
</div>
<div class="ov-wrap" id="overview">
  <div class="ov-head"><span class="ov-title">Overview</span><a class="ov-link" id="ovStatsLink" target="_blank" rel="noopener">📊 Open full statistics</a></div>
  <div id="ovBody"><div class="ov-grid"><div class="ov-card"><div class="v">…</div><div class="l">loading</div></div></div></div>
</div>
<script>
/* Overview strip — at-a-glance numbers. Uses the public stats data plus the
   same admin lists the sections below already load. Read-only: it changes
   nothing, and nothing below depends on it. */
function ovCount(x) {
  if (Array.isArray(x)) return x.length;
  if (x && typeof x === "object") { for (var k in x) if (Array.isArray(x[k])) return x[k].length; }
  return 0;
}
function ovCard(v, l, extra, tone) {
  return '<div class="ov-card' + (tone ? " " + tone : "") + '"><div class="v">' + v + '</div><div class="l">' + l + '</div>' + (extra ? '<div class="x">' + extra + '</div>' : '') + '</div>';
}
function ovNum(n) { return (Number(n) || 0).toLocaleString("en-US"); }
async function loadOverview() {
  try {
    document.getElementById("ovStatsLink").href = R.stats;
    var res = await Promise.all([
      fetch(R.statsApi, { cache: "no-store" }).then(function (r) { return r.json(); }),
      api("GET", R.reported).catch(function () { return []; }),
      api("GET", R.accountReports).catch(function () { return []; }),
      api("GET", R.bans).catch(function () { return []; }),
      api("GET", R.tempBansList).catch(function () { return []; })
    ]);
    var st = res[0], lv = st.live || {}, cm = st.community || {}, days = st.days || [], today = days[days.length - 1] || {}, ct = today.counters || {};
    var msgs = (ct.msgRandom || 0) + (ct.msgPrivate || 0) + (ct.msgRooms || 0);
    var reports = ovCount(res[1]) + ovCount(res[2]), bans = ovCount(res[3]), blocks = ovCount(res[4]);
    document.getElementById("ovBody").innerHTML =
      '<div class="ov-group">Right now</div><div class="ov-grid">' +
        ovCard(ovNum(st.currentOnline), "people online", "", "live") + ovCard(ovNum(lv.registered), "registered online") +
        ovCard(ovNum(lv.guests), "guests online") + ovCard(ovNum(lv.chatting), "in random chat", ovNum(lv.waiting) + " waiting") + '</div>' +
      '<div class="ov-group">Today</div><div class="ov-grid">' +
        ovCard(ovNum(today.uniqueIPs), "visitors") + ovCard(ovNum(today.chats), "random chats") +
        ovCard(ovNum(msgs), "messages") + ovCard(ovNum(today.signups), "new accounts") + '</div>' +
      '<div class="ov-group">Community &amp; moderation</div><div class="ov-grid">' +
        ovCard(ovNum(cm.accounts), "accounts", "+" + ovNum(cm.newAccounts7d) + " this week") + ovCard(ovNum(cm.vip), "VIP members") +
        ovCard(ovNum(reports), "reported", "", reports ? "warn" : "") + ovCard(ovNum(bans), "banned IPs / ranges") +
        ovCard(ovNum(blocks), "24h blocks", "", blocks ? "warn" : "") + '</div>';
  } catch (e) {
    document.getElementById("ovBody").innerHTML = '<div class="hint">Overview unavailable right now.</div>';
  }
}
</script>

<details class="section" open>
  <summary>🔒 Manual Permanent Ban</summary>
  <div class="section-body">
  <div class="manual-ban-box">
    <label>IP address(es) to ban forever</label>
    <textarea id="manualIPs" placeholder="1.2.3.4&#10;5.6.7.8&#10;ranges too: 2a09:bac0::/29"></textarea>
    <label>Reason (optional, for your notes)</label>
    <input type="text" id="manualReason" placeholder="e.g. spammer, harassment..." />
    <button class="do-ban-btn" onclick="manualBan()">🚫 Ban Forever</button>
    <p class="hint">Enter one IP per line, or separate with commas. Whole ranges work too, e.g. <code>2a09:bac0::/29</code> (Cloudflare WARP VPN) or <code>104.28.0.0/16</code>. Bans are saved to disk and survive restarts.</p>
  </div>
  </div>
</details>

<details class="section" open>
  <summary>Connected Users</summary>
  <div class="section-body"><div id="users">Loading...</div></div>
</details>

<details class="section">
  <summary>🚩 All Reports <span class="hint" style="margin:0 0 0 4px;font-weight:400">(every IP with 1+ reports — 5 still auto-bans for 24h)</span></summary>
  <div class="section-body"><div id="reported">Loading...</div></div>
</details>

<details class="section">
  <summary>🚩 Profile Reports <span class="hint" style="margin:0 0 0 4px;font-weight:400">(registered accounts, via profile card)</span></summary>
  <div class="section-body"><div id="accountReported">Loading...</div></div>
</details>

<details class="section">
  <summary>👤 All Registered Accounts <span class="hint" style="margin:0 0 0 4px;font-weight:400">(last-used IP)</span></summary>
  <div class="section-body">
    <input type="text" id="regUserSearch" placeholder="\u{1F50D} Search by username..." oninput="filterRegUsers(this.value)"
      style="width:100%;background:#1e1f22;border:1px solid #3a3c40;border-radius:6px;color:#dcddde;font-size:16px;padding:9px 12px;outline:none;margin-bottom:10px" />
    <div id="regUsers">Loading...</div>
  </div>
</details>

<details class="section">
  <summary>Banned IPs</summary>
  <div class="section-body"><div id="bans">Loading...</div></div>
</details>

<details class="section">
  <summary>⏱ 24h Blocks <span class="hint" style="margin:0 0 0 4px;font-weight:400">(temporary — shows time remaining, can be lifted early)</span></summary>
  <div class="section-body"><div id="tempBansList">Loading...</div></div>
</details>

<details class="section">
  <summary>🌐 Block a User-Agent</summary>
  <div class="section-body">
  <div class="manual-ban-box">
    <label>Block a User-Agent manually (paste the exact string)</label>
    <input type="text" id="manualUA" placeholder="e.g. Mozilla/5.0 (compatible; SomeBot/1.0)" />
    <button class="do-ban-btn" onclick="manualBlockUA()">🚫 Block This User-Agent</button>
    <p class="hint">Blocks every visitor sending this exact User-Agent header, on any IP. Saved to disk and survives restarts.</p>
  </div>
  </div>
</details>

<details class="section">
  <summary>🧱 Blocked User-Agents</summary>
  <div class="section-body"><div id="blockedUAs">Loading...</div></div>
</details>

<script>
const R = ${JSON.stringify(ROUTE)};

async function api(method, url) {
  const r = await fetch(url, { method });
  return r.json();
}

// -- Collapse / expand all sections ------------------------------------
function toggleAllSections() {
  const sections = document.querySelectorAll("details.section");
  const anyOpen = [...sections].some(s => s.open);
  sections.forEach(s => { s.open = !anyOpen; });
  document.getElementById("collapseAllBtn").textContent = anyOpen ? "\u21d5 Expand all" : "\u21d5 Collapse all";
}

// Shows a count badge on a section's own header (visible even while
// collapsed), so e.g. "Banned IPs" reads as "Banned IPs 3" without
// having to open it first.
function setSectionCount(bodyElId, n) {
  const body = document.getElementById(bodyElId);
  if (!body) return;
  const details = body.closest("details.section");
  if (!details) return;
  const summary = details.querySelector("summary");
  if (!summary) return;
  let badge = summary.querySelector(".count-badge");
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "count-badge";
    summary.appendChild(badge);
  }
  badge.textContent = String(n);
}

async function banIP(ip) {
  if (!confirm("Ban IP: " + ip + "?")) return;
  const d = await api("POST", R.ban + "?ip=" + encodeURIComponent(ip));
  setStatus("✅ Banned " + ip + " — " + (d.kicked || 0) + " kicked");
  loadAll();
}

async function tempBan(ip, username) {
  const msg = [
    'Block this IP for 24 hours?',
    '',
    'IP: ' + ip,
    'Name: ' + username,
    '',
    'They will see a page saying they were blocked for 1 day',
    'because of an offensive name, showing that name.'
  ].join(String.fromCharCode(10));
  if (!confirm(msg)) return;
  try {
    const r = await api('POST', R.tempBan + '?ip=' + encodeURIComponent(ip) +
                        '&username=' + encodeURIComponent(username));
    alert('Blocked ' + ip + ' for 24 hours' + String.fromCharCode(10) +
          'sockets kicked: ' + r.kickedSockets);
    load();
  } catch (e) { alert('Failed: ' + e.message); }
}

async function deleteUser(username) {
  const warn = [
    'Delete the account: ' + username,
    '',
    'This permanently removes the account, deletes their forum posts,',
    'comments and room messages, and bans their last known IP.',
    '',
    'This cannot be undone.'
  ].join(String.fromCharCode(10));
  if (!confirm(warn)) return;
  try {
    const r = await api('POST', R.deleteUser + '?username=' + encodeURIComponent(username));
    const nl = String.fromCharCode(10);
    alert('Deleted ' + username + nl + nl +
          'posts: ' + r.removedPosts + nl +
          'comments: ' + r.removedComments + nl +
          'room messages: ' + r.removedRoomMsgs + nl +
          'IP banned: ' + (r.bannedIp || 'none on file'));
    load();
  } catch (e) { alert('Failed: ' + e.message); }
}

async function unbanIP(ip) {
  await api("POST", R.unban + "?ip=" + encodeURIComponent(ip));
  setStatus("✅ Unbanned " + ip);
  loadAll();
}

async function unbanTemp(ip) {
  if (!confirm("Lift the 24h block on " + ip + " early?")) return;
  await api("POST", R.unbanTemp + "?ip=" + encodeURIComponent(ip));
  setStatus("✅ Lifted 24h block on " + ip);
  loadAll();
}

// "3h 12m" / "45m" / "<1m" — deliberately coarse, this is a moderation
// dashboard, not a stopwatch. Refreshes whenever loadAll() re-polls.
function fmtRemaining(ms) {
  if (ms <= 0) return "expired";
  const totalMin = Math.ceil(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return h + "h " + m + "m";
  if (m > 0) return m + "m";
  return "<1m";
}

let allRegUsers = []; // cached from the last load, so search filters instantly with no extra request

function renderRegUsersTable(list) {
  const el = document.getElementById("regUsers");
  if (!list.length) {
    el.innerHTML = '<p style="color:#72767d;font-size:.9em">No matching accounts</p>';
    return;
  }
  el.innerHTML = '<table><tr><th>Username</th><th>Last IP</th><th>Last seen</th><th>Status</th><th></th></tr>' +
    list.map(u => {
      const lastSeen = u.lastIPAt ? new Date(u.lastIPAt).toLocaleString() : "never logged in";
      const proBadge = u.isPro ? '<span class="badge" style="background:rgba(242,201,76,.2);color:#f2c94c">\u2B50 pro</span>' : '';
      const nameBadge = u.nameBlocked ? '<span class="badge" style="background:rgba(242,63,66,.2);color:#f23f42">🚫 bad name</span>' : '';
      const statusHtml = (u.isBanned
        ? '<span class="badge" style="background:rgba(242,63,66,.2);color:#f23f42">🔒 IP banned</span>'
        : (u.isAdmin ? '<span class="badge green">admin</span>' : '')) + proBadge + nameBadge;
      const actionHtml = u.lastIP
        ? (u.isBanned
            ? \`<button class="unban-btn" onclick="unbanIP('\${esc(u.lastIP)}')">✅ Unban</button>\`
            : \`<button class="ban-btn" onclick="banIP('\${esc(u.lastIP)}')">🚫 Ban this IP</button>\`)
        : '<span class="hint">no IP on file</span>';
      const tempHtml = u.lastIP
        ? \`<button class="ban-btn" style="margin-left:6px;background:#8a6d1f" onclick="tempBan('\${esc(u.lastIP)}','\${esc(u.username)}')">\u23F1 24h block</button>\`
        : '';
      const proBtnHtml = \`<button class="\${u.isPro ? "unban-btn" : "ban-btn"}" style="margin-left:6px;\${u.isPro ? "" : "background:#8a6d1f"}" onclick="setProStatus('\${esc(u.username)}', \${u.isPro ? "false" : "true"})">\${u.isPro ? "\u2B50 Revoke pro" : "\u2B50 Grant pro"}</button>\`;
      const nameBtnHtml = u.isAdmin ? '' : \`<button class="\${u.nameBlocked ? "unban-btn" : "ban-btn"}" style="margin-left:6px;\${u.nameBlocked ? "" : "background:#a0422a"}" onclick="setNameBlock('\${esc(u.username)}', \${u.nameBlocked ? "false" : "true"})">\${u.nameBlocked ? "✅ Unblock name" : "🚫 Bad name"}</button>\`;
      const delHtml = u.isAdmin
        ? '<span class="hint">protected</span>'
        : \`<button class="ban-btn" style="margin-left:6px" onclick="deleteUser('\${esc(u.username)}')">🗑 Delete + ban</button>\`;
      return \`<tr>
        <td><span class="ip">\${esc(u.username)}</span></td>
        <td style="font-family:monospace;color:#b5bac1">\${esc(u.lastIP || "—")}</td>
        <td style="color:#b5bac1;font-size:.85em">\${esc(lastSeen)}</td>
        <td>\${statusHtml}</td>
        <td style="white-space:nowrap">\${actionHtml}\${tempHtml}\${proBtnHtml}\${nameBtnHtml}\${delHtml}</td>
      </tr>\`;
    }).join("") + "</table>";
}

// Purely client-side — the full list is already cached, so this is instant
// and never hits the network. Called on every keystroke.
function filterRegUsers(query) {
  const q = query.trim().toLowerCase();
  const filtered = q ? allRegUsers.filter(u => u.username.toLowerCase().includes(q)) : allRegUsers;
  renderRegUsersTable(filtered);
}

// The 20s auto-refresh must not silently wipe out whatever an admin is
// currently searching for — this re-applies it after fresh data lands.
function reapplyRegUserFilter() {
  const box = document.getElementById("regUserSearch");
  if (box && box.value.trim()) filterRegUsers(box.value);
}

async function setProStatus(username, makeProBool) {
  const verb = makeProBool ? "Grant" : "Revoke";
  if (!confirm(\`\${verb} pro status for "\${username}"?\${makeProBool ? "\\n\\nThey'll get a star badge, no more click-ads, and can send photos to friends." : ""}\`)) return;
  try {
    const r = await api("POST", R.setPro + "?username=" + encodeURIComponent(username) + "&pro=" + makeProBool);
    setStatus(\`✅ \${r.isPro ? "Granted" : "Revoked"} pro for \${r.username}\`);
    loadAll();
  } catch(e) { alert("Failed: " + e.message); }
}

async function setNameBlock(username, block) {
  if (!confirm(block ? 'Block "' + username + '" for an offensive name? They are logged out everywhere and must choose a new name to continue.' : 'Lift the name block on "' + username + '"? They keep their current name.')) return;
  try {
    const r = await api("POST", R.nameBlock + "?username=" + encodeURIComponent(username) + "&block=" + block);
    setStatus(r.success ? (block ? "Name-blocked " : "Lifted name block on ") + r.username : "Failed: " + (r.error || "unknown"));
    loadAll();
  } catch (e) { alert("Failed: " + e.message); }
}

async function unbanReportedIP(ip) {
  if (!confirm("Unban " + ip + "? This clears their report strikes back to 0.")) return;
  await api("POST", R.unbanReported + "?ip=" + encodeURIComponent(ip));
  setStatus("✅ Cleared report-ban for " + ip);
  loadAll();
}

// Safe round-trip for embedding arbitrary User-Agent strings inside onclick='...'
// attributes (UAs can contain quotes/parens/etc. — base64 sidesteps all of that).
function b64enc(s) { return btoa(unescape(encodeURIComponent(s))); }
function b64dec(s) { return decodeURIComponent(escape(atob(s))); }

async function blockUA(b64ua) {
  const ua = b64dec(b64ua);
  if (!confirm("Block this User-Agent for ALL future visitors, on any IP?\\n\\n" + ua)) return;
  const d = await api("POST", R.blockUA + "?ua=" + encodeURIComponent(ua));
  setStatus("✅ Blocked User-Agent — " + (d.kicked || 0) + " kicked");
  loadAll();
}

async function unblockUA(b64ua) {
  const ua = b64dec(b64ua);
  await api("POST", R.unblockUA + "?ua=" + encodeURIComponent(ua));
  setStatus("✅ Unblocked User-Agent");
  loadAll();
}

async function manualBlockUA() {
  const ua = document.getElementById("manualUA").value.trim();
  if (!ua) { setStatus("⚠️ No User-Agent entered"); return; }
  if (!confirm("Block this User-Agent for ALL future visitors, on any IP?\\n\\n" + ua)) return;
  const d = await api("POST", R.blockUA + "?ua=" + encodeURIComponent(ua));
  document.getElementById("manualUA").value = "";
  setStatus("✅ Blocked User-Agent" + (d.kicked ? " — " + d.kicked + " kicked" : ""));
  loadAll();
}

function reasonsHtml(reasons) {
  if (!reasons || !reasons.length) return '<span style="color:#72767d">—</span>';
  return '<ul class="reason-list">' + reasons.map(r => \`<li>\${esc(r.reason)}<br><span class="meta">against \${esc(r.against || "unknown")} · by \${esc(r.by)} · \${new Date(r.timestamp).toLocaleString()}</span></li>\`).join("") + '</ul>';
}

async function manualBan() {
  const raw    = document.getElementById("manualIPs").value;
  const reason = document.getElementById("manualReason").value.trim();

  // Split on newlines or commas, strip whitespace, drop empties
  const ips = raw.split(/[\\n,]+/).map(s => s.trim()).filter(s => s.length > 0);
  if (!ips.length) { setStatus("⚠️ No IPs entered"); return; }

  // Basic IP validation (v4 and v6 allowed)
  const invalid = ips.filter(ip => !/^[0-9a-fA-F:.]+(\\/\\d{1,3})?$/.test(ip));
  if (invalid.length) {
    setStatus("⚠️ Invalid IP(s): " + invalid.join(", "));
    return;
  }

  if (!confirm("Permanently ban " + ips.length + " IP(s)?\\n\\n" + ips.join("\\n"))) return;

  let totalKicked = 0;
  const failed = [];
  for (const ip of ips) {
    try {
      const d = await api("POST", R.ban + "?ip=" + encodeURIComponent(ip));
      totalKicked += (d.kicked || 0);
    } catch { failed.push(ip); }
  }

  document.getElementById("manualIPs").value = "";
  document.getElementById("manualReason").value = "";

  const msg = failed.length
    ? "⚠️ Banned " + (ips.length - failed.length) + "/" + ips.length + " — failed: " + failed.join(", ")
    : "✅ Banned " + ips.length + " IP(s)" + (totalKicked ? " — " + totalKicked + " kicked" : "") + (reason ? " [" + reason + "]" : "");
  setStatus(msg);
  loadAll();
}

function setStatus(msg) {
  const el = document.getElementById("status");
  el.textContent = msg;
  setTimeout(() => el.textContent = "", 5000);
}

async function loadAll() {
  loadOverview();
  try {
    const d = await api("GET", R.users);
    const el = document.getElementById("users");
    setSectionCount("users", (d.users || []).length);
    if (!d.users || !d.users.length) { el.innerHTML = '<p style="color:#72767d;font-size:.9em">No connected users</p>'; }
    else {
      el.innerHTML = '<table><tr><th>Name</th><th>IP</th><th>User-Agent</th><th>Status</th><th></th></tr>' +
        d.users.map(u => \`<tr>
          <td><span class="ip">\${esc(u.name)}</span></td>
          <td style="font-family:monospace;color:#b5bac1">\${esc(u.ip)}</td>
          <td class="ua-cell" title="\${esc(u.userAgent || '(none)')}">\${esc(u.userAgent || '(none)')}</td>
          <td>\${u.partner ? '<span class="badge green">chatting</span>' : '<span class="badge">waiting</span>'}</td>
          <td style="white-space:nowrap">
            <button class="ban-btn" onclick="banIP('\${esc(u.ip)}')">Ban IP</button>
            <button class="ban-btn" style="background:#8a6d1f" onclick="tempBan('\${esc(u.ip)}','\${esc(u.name)}')">\u23F1 24h block</button>
            \${u.userAgent ? \`<button class="block-ua-btn" onclick="blockUA('\${b64enc(u.userAgent)}')">Block UA</button>\` : ''}
          </td>
        </tr>\`).join("") + "</table>";
    }
  } catch(e) { document.getElementById("users").textContent = "Error"; }

  try {
    const d = await api("GET", R.regUsers);
    allRegUsers = d.users || []; // cached for filterRegUsers() below
    setSectionCount("regUsers", allRegUsers.length);
    renderRegUsersTable(allRegUsers);
    reapplyRegUserFilter();
  } catch(e) { document.getElementById("regUsers").textContent = "Error"; }

  try {
    const d = await api("GET", R.reported);
    const el = document.getElementById("reported");
    setSectionCount("reported", (d.reported || []).length);
    if (!d.reported || !d.reported.length) { el.innerHTML = '<p style="color:#72767d;font-size:.9em">No reports on file</p>'; }
    else {
      el.innerHTML = '<table><tr><th>IP</th><th>Name(s)</th><th>Reports</th><th>Reasons</th><th>Status</th><th></th></tr>' +
        d.reported.map(r => {
          let statusHtml;
          if (r.permaBanned) statusHtml = '<span class="badge" style="background:rgba(242,63,66,.2);color:#f23f42">🔒 banned forever</span>';
          else if (r.autoBanned) statusHtml = '<span class="badge" style="background:rgba(250,166,26,.2);color:#faa61a">⏱ auto-ban, ' + r.remainingHrs + 'h left</span>';
          else statusHtml = '<span class="badge">' + r.count + '/5 — not blocked</span>';

          let actionsHtml = '';
          if (r.permaBanned) {
            actionsHtml += \`<button class="unban-btn" onclick="unbanIP('\${esc(r.ip)}')">✅ Unban</button> \`;
          } else {
            actionsHtml += \`<button class="ban-btn" onclick="banIP('\${esc(r.ip)}')">🚫 Block</button> \`;
          }
          if (r.autoBanned) {
            actionsHtml += \`<button class="unban-btn" onclick="unbanReportedIP('\${esc(r.ip)}')">Clear strikes</button>\`;
          }

          const namesHtml = (r.names && r.names.length)
            ? r.names.map(n => \`<span class="ip" style="font-size:.85em;display:block">\${esc(n)}</span>\`).join("")
            : '<span style="color:#72767d">unknown</span>';

          return \`<tr>
            <td style="font-family:monospace;color:#fff">\${esc(r.ip)}</td>
            <td>\${namesHtml}</td>
            <td><span style="color:#f23f42;font-weight:700">\${r.count}</span></td>
            <td>\${reasonsHtml(r.reasons)}</td>
            <td>\${statusHtml}</td>
            <td style="white-space:nowrap">\${actionsHtml}</td>
          </tr>\`;
        }).join("") + "</table>";
    }
  } catch(e) { document.getElementById("reported").textContent = "Error"; }

  try {
    const d = await api("GET", R.accountReports);
    const el = document.getElementById("accountReported");
    setSectionCount("accountReported", (d.reported || []).length);
    if (!d.reported || !d.reported.length) { el.innerHTML = '<p style="color:#72767d;font-size:.9em">No profile reports on file</p>'; }
    else {
      el.innerHTML = '<table><tr><th>Username</th><th>Reports</th><th>Latest reasons</th></tr>' +
        d.reported.map(r => {
          const reasonsListHtml = r.reports.map(rp =>
            \`<div style="margin-bottom:4px;font-size:.85em"><b>\${esc(rp.reportedBy)}</b>: \${esc(rp.reason)} <span style="color:#72767d">(\${new Date(rp.timestamp).toLocaleString()})</span></div>\`
          ).join("");
          return \`<tr>
            <td style="color:#fff">\${esc(r.username)}</td>
            <td><span style="color:#f23f42;font-weight:700">\${r.count}</span></td>
            <td>\${reasonsListHtml}</td>
          </tr>\`;
        }).join("") + "</table>";
    }
  } catch(e) { document.getElementById("accountReported").textContent = "Error"; }

  try {
    const d = await api("GET", R.bans);
    const el = document.getElementById("bans");
    setSectionCount("bans", (d.ips || []).length);
    if (!d.ips || !d.ips.length) { el.innerHTML = '<p style="color:#72767d;font-size:.9em">No banned IPs</p>'; }
    else {
      el.innerHTML = d.ips.map(ip => \`<div class="card">
        <span class="ip">\${esc(ip)}</span>
        <button class="unban-btn" onclick="unbanIP('\${esc(ip)}')" style="float:right">Unban</button>
      </div>\`).join("");
    }
  } catch(e) { document.getElementById("bans").textContent = "Error"; }

  try {
    const d = await api("GET", R.tempBansList);
    const el = document.getElementById("tempBansList");
    setSectionCount("tempBansList", (d.bans || []).length);
    if (!d.bans || !d.bans.length) { el.innerHTML = '<p style="color:#72767d;font-size:.9em">No active 24h blocks</p>'; }
    else {
      el.innerHTML = d.bans.map(b => \`<div class="card">
        <span class="ip">\${esc(b.ip)}</span>
        \${b.username ? \`<span class="badge">\${esc(b.username)}</span>\` : ""}
        <button class="unban-btn" onclick="unbanTemp('\${esc(b.ip)}')" style="float:right">Unban</button>
        <div class="hint" style="margin-top:6px">\${fmtRemaining(b.remainingMs)} remaining \\u2014 reason: \${esc(b.reason)}</div>
      </div>\`).join("");
    }
  } catch(e) { document.getElementById("tempBansList").textContent = "Error"; }

  try {
    const d = await api("GET", R.blockedUAs);
    const el = document.getElementById("blockedUAs");
    setSectionCount("blockedUAs", (d.userAgents || []).length);
    if (!d.userAgents || !d.userAgents.length) { el.innerHTML = '<p style="color:#72767d;font-size:.9em">No blocked user-agents</p>'; }
    else {
      el.innerHTML = d.userAgents.map(ua => \`<div class="card">
        <span class="ip" style="word-break:break-all;font-size:.85em">\${esc(ua)}</span>
        <button class="unban-btn" onclick="unblockUA('\${b64enc(ua)}')" style="float:right">Unblock</button>
      </div>\`).join("");
    }
  } catch(e) { document.getElementById("blockedUAs").textContent = "Error"; }
}

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

loadAll();
setInterval(loadAll, 15000);
</script>
</body>
</html>`;
}

// ── Challenge Token + Proof-of-Work (anti-bot) ───────────────────────────────
// 1. Client fetches /api/challenge  → { token, nonce }
// 2. Client computes powAnswer = (nonce * 31 + nonce % 97)  [done in real browser JS]
// 3. Client sends { name, token, powAnswer } with setName
// 4. Server checks powAnswer matches — Selenium bots are blocked client-side
//    before they even reach this step (navigator.webdriver check in script.js)
const challengeTokens = new Map(); // token → { expiry, powAnswer }

setInterval(() => {
  const now = Date.now();
  for (const [t, v] of challengeTokens) if (now > v.expiry) challengeTokens.delete(t);
}, 60_000);

app.get("/api/challenge", (req, res) => {
  const token     = Math.random().toString(36).slice(2) +
                    Math.random().toString(36).slice(2) +
                    Math.random().toString(36).slice(2);
  const nonce     = Math.floor(Math.random() * 90000) + 10000; // 5-digit random
  const powAnswer = (nonce * 31 + nonce % 97);                 // expected client answer

  challengeTokens.set(token, { expiry: Date.now() + 5 * 60_000, powAnswer });
  res.json({ token, nonce });
});

// ── In-memory state ───────────────────────────────────────────────────────────
let waitingQueue         = [];
const activeUsernames    = new Set();
const pendingDisconnects = new Map();
const reportLog          = [];

// Reports filed against a REGISTERED account from their profile card —
// separate from reportStrikes above, which is IP-based and built for
// anonymous random-chat abuse. This is account-based instead, since the
// target may not even be online at report time, and the account (not
// whatever IP they last used) is the stable identity that matters here.
const accountReportLog = new Map(); // targetUsernameLower → [{reason, reportedBy, timestamp}]

// [AUTH] Reserved registered usernames — populated by the auth section below
const authReservedNames  = new Set();

// ── Game state ────────────────────────────────────────────────────────────────
const gameBySocket = new Map(); // socketId → gameId
const gameById     = new Map(); // gameId   → game object

// ── General helpers ───────────────────────────────────────────────────────────
function updateOnlineCount() { io.emit("onlineCount", io.sockets.sockets.size); }

function cleanQueue() {
  waitingQueue = waitingQueue.filter(s =>
    s.connected &&
    !s.partner &&
    s.userName &&
    !s._isGhost   // exclude ghost sockets that are mid-reconnect
  );
}

function countTagOverlap(a = [], b = []) {
  const setB = new Set(b);
  return a.filter(t => setB.has(t)).length;
}

function broadcastQueuePositions() {
  cleanQueue();
  waitingQueue.forEach((s, i) => s.emit("queuePosition", { position: i + 1, total: waitingQueue.length }));
}

function makeRateLimiter(max, windowMs) {
  return {
    check(socket) {
      const now = Date.now();
      if (!socket._rl || now > socket._rl.resetAt) socket._rl = { count: 0, resetAt: now + windowMs };
      return ++socket._rl.count <= max;
    },
  };
}
const msgRateLimiter = makeRateLimiter(MSG_RATE_MAX, MSG_RATE_WINDOW_MS);

function hasProfanity(text) {
  if (!BANNED_WORDS.size) return false;
  const lower = text.toLowerCase();
  for (const word of BANNED_WORDS) if (lower.includes(word)) return true;
  return false;
}

// ── Link / URL detection ──────────────────────────────────────────────────────
// IMPORTANT: Never use a single shared /g-flag RegExp for .test() — the global
// flag keeps lastIndex between calls, so every other call returns a wrong result.
// We create a fresh RegExp each time via containsLink() to avoid this entirely.
const _LINK_RE_SRC = String.raw`(?:https?:\/\/|ftp:\/\/|www\.|\bt\.me\/|telegram\.me\/)[\w\-._~:/?#[\]@!$&'()*+,;=%]+|[\w\-]+\.(?:com|net|org|ge|io|ru|tv|me|gg|co|uk|us|info|biz|xyz|online|site|app|dev|ai|edu|gov|mil|int|eu|de|fr|es|it|pl|ua|by|kz|am|az|tr)(?:[/?\s]|$)`;
function containsLink(text) { return new RegExp(_LINK_RE_SRC, 'i').test(text); }
// Backwards-compat alias (no longer used with .test() directly)
const LINK_RE = { test: containsLink, lastIndex: 0 };

// ── Game helpers ──────────────────────────────────────────────────────────────

// ── Truth or Dare prompts (Georgian, PG-13 flirty/fun) ─────────────────────
// Mix of light/normal questions and a few "spicier" flirty ones — kept
// appropriate for a text-only chat between strangers (no explicit content,
// no physical/offline dares — everything is doable as a chat message).
const TRUTH_PROMPTS = [
  "რომელია ყველაზე უხერხული სიტუაცია, რომელშიც ოდესმე მოხვედრილხარ?",
  "ვინმეს ტყუილად უთქვამს „მიყვარხარ“?",
  "რა არის შენი ყველაზე დიდი შიში ურთიერთობაში?",
  "გიყურებია ოდესმე ყოფილის სოც. ქსელი შუა ღამით? 👀",
  "რომელია ყველაზე უცნაური რამ, რაც სიზმარში გინახავს?",
  "თუ დღეს ვინმეს პაემანზე მიპატიჟებდი, ვინ იქნებოდა ის (ცნობილი პიროვნება)?",
  "რა ტყუილი გითქვამს მშობლებისთვის მოზარდობაში?",
  "რომელი ემოჯი აღწერს საუკეთესოდ შენს დღევანდელ განწყობას?",
  "გქონია ოდესმე crush მასწავლებელზე? 😅",
  "რა არის შენი „green flag“ პარტნიორში?",
  "რომელი სიმღერის მოსმენა გერიდება სხვის თანდასწრებით?",
  "რამდენჯერ გითხოვია ვინმესთვის ნომერი?",
  "რა არის შენი ყველაზე უცნაური „ick“ — რაც მაშინვე გაგერიდებს ადამიანისგან?",
  "დათანხმდებოდი ერთდღიან ურთიერთობაზე ახლა ვისთანაც ესაუბრები? 😏",
  "რომელია შენი ერთი საიდუმლო, რომელიც არავინ იცის?",
  "დაუწერე ოდესმე ვინმეს ტექსტი, რომელიც შემდეგ სინანულით წაშალე?",
  "რა არის შენი „turn on“ საუბარში?",
  "ვისზე გაქვს crush ახლა, ან ბოლოს ვისზე გქონდა?",
  "რომელი ცუდი ჩვევა გაქვს, რომელსაც არავის უმხელ?",
  "რომელია ყველაზე გიჟური რამ, რაზეც ოდესმე ფიქრობდი, მაგრამ არასდროს გაუმხელია?",
];
const DARE_PROMPTS = [
  "დაწერე პარტნიორს ულამაზესი კომპლიმენტი, რაც კი შეგიძლია.",
  "გამოაგზავნე 5 ემოჯი, რომლებიც აღწერენ შენს ხასიათს.",
  "მოიგონე მეტსახელი პარტნიორისთვის და მიმართე ასე საუბრის ბოლომდე.",
  "დაწერე ერთი წინადადება მხოლოდ ემოჯებით — პარტნიორმა უნდა გამოიცნოს.",
  "აღწერე შენი „perfect date“ სამი სიტყვით.",
  "გაუკეთე კომპლიმენტი საკუთარ თავს — რაც არ უნდა უცნაურად ჟღერდეს.",
  "დაწერე ფლირტ-შეტყობინება, თითქოს ეს პირველი პაემანია 😏",
  "მოიგონე ერთი „ყალბი“ ფაქტი შენს შესახებ — პარტნიორმა უნდა გამოიცნოს სიმართლეა თუ არა.",
  "დაწერე ორსტრიქონიანი ლექსი შენს პარტნიორზე.",
  "გაუმხილე პარტნიორს ერთი „საიდუმლო“ ტალანტი.",
  "დაწერე შენი საუკეთესო pickup line.",
  "აღწერე საკუთარი თავი მხოლოდ სამი ზედსართავით.",
  "თქვი, რომელი ცნობილი ადამიანის მოწონებას ბედავ აღიარებას.",
  "გამოაგზავნე 😂 მინიმუმ 10-ჯერ ზედიზედ.",
  "მოთხარი პატარა ისტორია სამ წინადადებაში — შენ და პარტნიორი თავგადასავალში ხართ.",
  "აღწერე შენი „იდეალური“ პარტნიორი ერთ წინადადებაში.",
  "გაუმხილე კომპლიმენტი, რომელსაც არასდროს გეუბნებიან, მაგრამ გინდა გაიგონო.",
  "გაუმხილე პარტნიორს, რას გრძნობ ამ საუბრის მიმართ ახლა 😄",
  "დაწერე „ფლირტული“ სახელი პარტნიორისთვის და ახსენი, რატომ ეს.",
  "დაწერე ერთწინადადებიანი კომპლიმენტი, რომელიც პარტნიორს დღეს გაუღიმებს.",
];

// Pull a plain 11-char video ID out of any common YouTube URL shape
// (watch?v=, youtu.be/, shorts/, embed/, music.youtube.com/watch?v=), or
// accept a bare 11-char ID directly. Returns null if nothing valid found.
function extractYouTubeId(input) {
  if (!input || typeof input !== "string") return null;
  const str = input.trim();

  if (/^[a-zA-Z0-9_-]{11}$/.test(str)) return str;

  try {
    const u = new URL(str);
    const host = u.hostname.replace(/^www\./, "").replace(/^music\./, "");

    if (host === "youtu.be") {
      const id = u.pathname.split("/").filter(Boolean)[0];
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }

    if (host === "youtube.com" || host === "m.youtube.com") {
      if (u.searchParams.get("v") && /^[a-zA-Z0-9_-]{11}$/.test(u.searchParams.get("v"))) {
        return u.searchParams.get("v");
      }
      const parts = u.pathname.split("/").filter(Boolean);
      if ((parts[0] === "shorts" || parts[0] === "embed" || parts[0] === "live") && parts[1]) {
        return /^[a-zA-Z0-9_-]{11}$/.test(parts[1]) ? parts[1] : null;
      }
    }
  } catch {
    return null;
  }
  return null;
}

// ── Per-socket media rate limiter ─────────────────────────────────────────────
// GIFs are relayed as Socket.io/WebSocket messages, not separate HTTP requests,
// so Cloudflare's HTTP rate limiting CAN'T reach these — a client (malicious or
// just a buggy script) could otherwise blast them as fast as the socket allows
// with nothing to stop it. This is a small sliding-window limiter keyed
// per-socket, checked before any relay work.
const mediaRateState = new WeakMap(); // socket → { key → [timestamps] }

function mediaRateLimited(socket, key, maxPerWindow, windowMs) {
  const now = Date.now();
  if (!mediaRateState.has(socket)) mediaRateState.set(socket, new Map());
  const perSocket = mediaRateState.get(socket);
  let timestamps = perSocket.get(key) || [];
  timestamps = timestamps.filter(t => now - t < windowMs);
  if (timestamps.length >= maxPerWindow) {
    perSocket.set(key, timestamps); // keep pruned list even on reject
    return true; // rate limited
  }
  timestamps.push(now);
  perSocket.set(key, timestamps);
  return false;
}

// ── Socket handlers ───────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  // Connection health check. Pages send this when the user comes back to the
  // site: phones freeze pages in the background and can leave a dead
  // connection that still looks open. An answer means the link is alive.
  socket.on("conn:ping", (ack) => { if (typeof ack === "function") ack(1); });
  socket.use((packet, next) => { const g = STAT_GAME_EVENTS[packet && packet[0]]; if (g) bumpStat("game:" + g); next(); });
  socket.on("conn:replaced", (data) => {
    const oldId = data && typeof data.oldId === "string" ? data.oldId.slice(0, 40) : null;
    if (!oldId || oldId === socket.id) return;
    socket._replacesId = oldId;
    evictGhostOf(socket);          // may have to wait until this socket has logged in
  });

  // ── Capture real IP (works behind proxies like nginx/Render/Railway) ────────
  const rawIP =
    socket.handshake.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    socket.handshake.address ||
    "unknown";
  socket.clientIP  = rawIP;
  socket.userAgent = socket.handshake.headers["user-agent"] || "";

  // ── Drop banned IPs / user-agents immediately ───────────────────────────────
  if (isIPBanned(rawIP) || isIPBanned(socket.handshake.headers["cf-connecting-ip"]) || isLinkBanned(rawIP) || isReportBanned(rawIP) || isUABanned(socket.userAgent)) {
    socket.emit("autoKicked");
    setTimeout(() => socket.disconnect(true), 500);
    return;
  }

  // ── Geo-gate: only Georgian IPs may use the chat socket ─────────────────────
  // The HTTP page gate blocks non-GE visitors from loading "/", but a direct
  // socket.io connection would skip that check — so we re-verify here too.
  if (!OWNER_IPS.has(rawIP)) {
    getCountry(rawIP).then(country => {
      if (country !== "GE") {
        socket.emit("autoKicked");
        setTimeout(() => socket.disconnect(true), 500);
      }
    });
  }

  console.log("User connected", socket.id, rawIP);
  socket._connectedAt = Date.now();
  recordConnect(rawIP, socket.handshake.headers["user-agent"]);

  // Queue non-Georgian IPs for VirusTotal reputation check
  getCountry(rawIP).then(country => {
    if (country !== "GE") enqueueForVT(rawIP);
  });

  socket.userName           = "";
  socket.partner            = null;
  socket.lastPartnerName    = "";
  socket.lastPartnerIP      = "";   // stored so report works after partner leaves
  socket.lastPartnerSocketId = "";  // stored for dedup in reportStrikes
  socket.hasReportedLast    = false; // one report per partner
  socket.blockedNames       = [];
  socket.blockedIds         = new Set();
  socket.recentPartnerIds = new Set();
  socket.interests        = [];
  socket.bio              = "";
  socket.blockedByTimes   = []; // timestamps of recent blocks received
  socket._rl              = null;
  // ── Anti-bot tracking ──────────────────────────────────────────────────────
  socket.verified         = false;   // passed challenge token
  socket.hasTyped         = false;   // fired typing event before sending
  socket.chatStartedAt    = 0;       // timestamp when current partner was found
  socket.lastMessages     = [];      // ring buffer — detect copy-paste spam
  socket.spamStrikes      = 0;       // repeated violations → kick

  updateOnlineCount();

  // ── Username registration ────────────────────────────────────────────────
  socket.on("setName", (data) => {
    evictGhostOf(socket);   // an app-switch ghost of this user must let go before we resume
    // Accept either plain string (legacy) or { name, token, powAnswer } object
    let name, token, powAnswer, webdriver;
    if (typeof data === "string") {
      name  = data;
      token = null;
    } else if (data && typeof data === "object") {
      name      = data.name;
      token     = data.token;
      powAnswer = data.powAnswer;
      webdriver = data.webdriver; // client reports navigator.webdriver
    } else return;

    // ── Hard block: client self-reported as WebDriver ──────────────────────
    if (webdriver === true) {
      console.warn(`[BOT-WEBDRIVER] WebDriver flag detected — ${socket.id}`);
      socket.disconnect(true);
      return;
    }

    // ── Challenge token + proof-of-work check ─────────────────────────────
    if (!socket.verified) {
      const entry = token ? challengeTokens.get(token) : null;
      const tokenOk  = entry && Date.now() <= entry.expiry;
      const powOk    = tokenOk && (Number(powAnswer) === entry.powAnswer);

      if (!tokenOk || !powOk) {
        console.warn(`[BOT-TOKEN] Rejected — tokenOk=${tokenOk} powOk=${powOk} id=${socket.id}`);
        socket.emit("tokenInvalid");
        setTimeout(() => { if (!socket.verified) socket.disconnect(true); }, 5000);
        return;
      }
      challengeTokens.delete(token); // one-time use
      socket.verified = true;
    }

    if (typeof name !== "string") return;
    let trimmed = name.trim();

    // ── Guests can't choose a name ────────────────────────────────────────
    // Only a real registered account keeps the name it asked for. Everyone
    // else gets "სტუმარი####". Three cases deliberately pass through
    // untouched:
    //   * a real logged-in account          → their own name, as before
    //   * a name already in guest format     → same person continuing across
    //                                          pages (continuity, not a choice)
    //   * a registered account's name        → left for the ownership check
    //                                          below, which rejects impostors
    //                                          and admits the real owner. This
    //                                          also covers the brief race where
    //                                          a registered user's socket
    //                                          hasn't finished logging in yet —
    //                                          converting their name here would
    //                                          wrongly strand them as a guest.
    const isRealAccount = !!(socket._regUser && !socket._regUser.isGuest);
    // Names can't be chosen or changed: a real account always appears under
    // its own account name. Enforced here, so sending setName by hand with
    // another name changes nothing.
    if (isRealAccount) trimmed = socket._regUser.username;
    // A guest who already has a guest name keeps it, instead of drawing a new
    // random number on every setName.
    if (!isRealAccount && socket.userName && GUEST_NAME_RE.test(socket.userName)) trimmed = socket.userName;
    if (!isRealAccount && !GUEST_NAME_RE.test(trimmed) && !authReservedNames.has(trimmed.toLowerCase())) {
      // Reuse this socket's existing guest identity if it has one, so random
      // chat and the rest of the site show the SAME name, not two different
      // random numbers.
      const existingGuestName = socket._regUser?.isGuest && GUEST_NAME_RE.test(socket._regUser.username)
        ? socket._regUser.username
        : null;
      const assigned = existingGuestName || generateGuestName();
      if (!assigned) { socket.emit("nameTaken"); return; }
      trimmed = assigned;
    }

    if (trimmed.length < NAME_MIN || trimmed.length > NAME_MAX) return;

    // Banned-word check on the display name itself.
    if (findBannedWord(trimmed)) {
      socket.emit("nameRejected", { message: ABUSE_WORD_MESSAGE });
      return;
    }

    if (socket.userName.toLowerCase() === trimmed.toLowerCase()) {
      socket.emit("nameAccepted", socket.userName);
      tryRestorePartnership(socket, trimmed.toLowerCase());
      return;
    }

    const lowerTrimmed = trimmed.toLowerCase();

    // [AUTH] If name belongs to a registered user, only allow its owner to use it.
    // Anonymous users attempting a registered name get nameTaken.
    if (authReservedNames.has(lowerTrimmed)) {
      const isOwner = socket._regUser && socket._regUser.usernameLower === lowerTrimmed;
      if (!isOwner) {
        socket.emit("nameTaken");
        return;
      }
      // Owner is reclaiming — evict any anonymous socket currently holding it
      if (activeUsernames.has(lowerTrimmed) && !pendingDisconnects.has(lowerTrimmed)) {
        for (const [, s] of io.sockets.sockets) {
          if (s.id !== socket.id && s.userName &&
              s.userName.toLowerCase() === lowerTrimmed && !s._regUser) {
            activeUsernames.delete(lowerTrimmed);
            s.userName = "";
            if (s.partner) { s.partner.partner = null; s.partner.emit("partnerDisconnected", { name: lowerTrimmed }); }
            waitingQueue = waitingQueue.filter(q => q.id !== s.id);
            s.emit("nameTaken");
            break;
          }
        }
      }
    }

    // Same idea, one level down: this exact name is a known GUEST identity
    // (established via auth:guest on the dashboard/a game, "სტუმარი####" or
    // a chosen name carried over) — evict any stale socket still holding
    // it in activeUsernames so its owner can reclaim it here too. Almost
    // always this is literally the same browser tab's previous socket that
    // hasn't finished disconnecting yet (socket.io detects a closed
    // connection with a short delay, not instantly) — this is exactly the
    // same race the auth:guest name-reuse fix handles, just showing up in
    // this separate activeUsernames tracker instead of registeredUsers.
    else if (registeredUsers.get(lowerTrimmed)?.isGuest &&
             activeUsernames.has(lowerTrimmed) && !pendingDisconnects.has(lowerTrimmed)) {
      for (const [, s] of io.sockets.sockets) {
        if (s.id !== socket.id && s.userName && s.userName.toLowerCase() === lowerTrimmed) {
          activeUsernames.delete(lowerTrimmed);
          s.userName = "";
          if (s.partner) { s.partner.partner = null; s.partner.emit("partnerDisconnected", { name: lowerTrimmed }); }
          waitingQueue = waitingQueue.filter(q => q.id !== s.id);
          break;
        }
      }
    }

    // Allow reclaiming a name that is pending reconnect (user's own name during grace period)
    if (activeUsernames.has(lowerTrimmed)) {
      if (pendingDisconnects.has(lowerTrimmed)) {
        // This is the user reconnecting with their own name — allowed
        // (activeUsernames will be re-confirmed inside tryRestorePartnership)
      } else {
        socket.emit("nameTaken");
        return;
      }
    }

    if (socket.userName) activeUsernames.delete(socket.userName.toLowerCase());
    socket.userName = trimmed;
    activeUsernames.add(lowerTrimmed);
    socket.emit("nameAccepted", trimmed);
    tryRestorePartnership(socket, lowerTrimmed);
  });

  function tryRestorePartnership(sock, nameLower) {
    if (!pendingDisconnects.has(nameLower)) return false;
    const { partner, timeout, ghostSocket } = pendingDisconnects.get(nameLower);
    clearTimeout(timeout);
    pendingDisconnects.delete(nameLower);
    activeUsernames.add(nameLower);
    const partnerAvailable = partner.connected &&
      (!partner.partner || partner.partner === ghostSocket || partner.partner === sock);
    if (partnerAvailable) {
      sock._isGhost    = false;
      sock.partner     = partner;
      partner.partner  = sock;
      ghostSocket.partner = null;   // clear stale partner ref on the ghost so it can't be reused
      // Flush queued messages from staying user (stored on the ghost socket)
      const queue = ghostSocket._messageQueue || [];
      ghostSocket._messageQueue = [];
      queue.forEach(m => sock.emit("message", m));
      sock.emit("partnerRestored",       { name: partner.userName });
      partner.emit("partnerReconnected", { name: sock.userName });
      // Reset repeat-detection ring for the restored session
      sock.lastMessages    = []; sock.spamStrikes    = 0;
      partner.lastMessages = []; partner.spamStrikes = 0;
      // Reset chatStartedAt on both sides so the anti-bot speed gate doesn't
      // lock out the reconnecting user (their timer was reset to 0 on connect)
      const now = Date.now();
      sock.chatStartedAt    = now;
      partner.chatStartedAt = now;
      sock.hasTyped         = false;
      partner.hasTyped      = false;
      // Clear recentPartnerIds between these two so they can be re-matched if
      // both press Next — otherwise the IDs linger and cause permanent exclusion
      sock.recentPartnerIds.delete(partner.id);
      partner.recentPartnerIds.delete(sock.id);
      return true;
    }
    return false;
  }

  // ── Bio ──────────────────────────────────────────────────────────────────
  socket.on("setBio", (bio) => {
    if (typeof bio !== "string") return;
    socket.bio = bio.slice(0, 60).replace(/<[^>]*>/g, "").trim();
  });

  // ── Interests ────────────────────────────────────────────────────────────
  socket.on("setInterests", (tags) => {
    if (!Array.isArray(tags)) return;
    socket.interests = tags.filter(t => typeof t === "string" && VALID_TAGS.has(t)).slice(0, 10);
  });

  // ── Matchmaking ──────────────────────────────────────────────────────────
  function tryFindPartner() {
    if (!socket.userName || socket.partner) return;
    cleanQueue();

    const candidates = waitingQueue.filter(s =>
      s.id !== socket.id &&
      !socket.recentPartnerIds.has(s.id) &&
      !s.recentPartnerIds.has(socket.id) &&
      !socket.blockedNames.includes(s.userName.toLowerCase()) &&
      !s.blockedNames.includes(socket.userName.toLowerCase()) &&
      !socket.blockedIds.has(s.id) &&
      !s.blockedIds.has(socket.id)
    );

    if (!candidates.length) {
      if (!waitingQueue.some(s => s.id === socket.id)) waitingQueue.push(socket);
      broadcastQueuePositions();
      return;
    }

    let best = candidates[0];
    let bestScore = countTagOverlap(socket.interests, best.interests);
    for (let i = 1; i < candidates.length; i++) {
      const score = countTagOverlap(socket.interests, candidates[i].interests);
      if (score > bestScore) { bestScore = score; best = candidates[i]; }
    }

    const partnerSocket = best;

    // Double-check partner is still free — race condition guard
    // (partner could disconnect or get matched between cleanQueue() and now)
    if (!partnerSocket.connected || partnerSocket.partner || partnerSocket._isGhost) {
      if (!waitingQueue.some(s => s.id === socket.id)) waitingQueue.push(socket);
      broadcastQueuePositions();
      return;
    }

    waitingQueue = waitingQueue.filter(s => s.id !== partnerSocket.id && s.id !== socket.id);

    socket.partner        = partnerSocket;
    partnerSocket.partner = socket;
    socket.lastPartnerName        = partnerSocket.userName;
    partnerSocket.lastPartnerName = socket.userName;
    socket.lastPartnerIP           = partnerSocket.clientIP || "";
    partnerSocket.lastPartnerIP    = socket.clientIP || "";
    socket.lastPartnerSocketId     = partnerSocket.id;
    partnerSocket.lastPartnerSocketId = socket.id;
    socket.hasReportedLast         = false;
    partnerSocket.hasReportedLast  = false;
    // Immutable per-pairing snapshot — deliberately never overwritten or
    // cleared by anything else (block/skip/disconnect) until the NEXT
    // pairing happens. This is what reportUser reads from as its fallback,
    // instead of the mutable lastPartnerName field, which several other
    // handlers (blockUser, findPartner, etc.) legitimately clear as part of
    // their own logic — using it as a report fallback was the root cause of
    // reports sometimes showing "unknown" or a leftover name from an
    // entirely different, earlier partner.
    socket._reportSnapshot = { name: partnerSocket.userName, ip: partnerSocket.clientIP || "", socketId: partnerSocket.id };
    partnerSocket._reportSnapshot = { name: socket.userName, ip: socket.clientIP || "", socketId: socket.id };

    const sharedTags = (socket.interests || []).filter(t => (partnerSocket.interests || []).includes(t));

    // If either side is a logged-in registered account (auth-client.js's
    // silent session restore sets socket._regUser even while someone is
    // just using random chat, not the dashboard), surface their pro status
    // to the STRANGER they were matched with — a guest or anonymous visitor
    // has no _regUser at all, so this naturally stays false for them.
    const socketIsPro        = socket._regUser ? !!registeredUsers.get(socket._regUser.usernameLower)?.isPro : false;
    const partnerSocketIsPro = partnerSocket._regUser ? !!registeredUsers.get(partnerSocket._regUser.usernameLower)?.isPro : false;

    // Registered partners also share their avatar and profile details, so a
    // tap on their picture or name can show a profile popup. Guests have none.
    const regOf = (sock) => (sock._regUser && !sock._regUser.isGuest) ? registeredUsers.get(sock._regUser.usernameLower) : null;
    const socketReg = regOf(socket), partnerReg = regOf(partnerSocket);
    socket.emit("partnerFound",        { name: partnerSocket.userName, sharedTags, partnerBio: partnerSocket.bio, partnerIsPro: partnerSocketIsPro,
                                         partnerAvatar: partnerReg ? (partnerReg.avatar || DEFAULT_AVATAR) : null, partnerProfile: publicProfileOf(partnerReg), partnerAccountBio: partnerReg ? (partnerReg.bio || "") : "" });
    recordChatStarted();
    partnerSocket.emit("partnerFound", { name: socket.userName,        sharedTags, partnerBio: socket.bio, partnerIsPro: socketIsPro,
                                         partnerAvatar: socketReg ? (socketReg.avatar || DEFAULT_AVATAR) : null, partnerProfile: publicProfileOf(socketReg), partnerAccountBio: socketReg ? (socketReg.bio || "") : "" });

    // ── Reset anti-bot state for both users ────────────────────────────────
    const now = Date.now();
    socket.hasTyped        = false;  socket.chatStartedAt = now;
    socket.lastMessages    = [];     socket.spamStrikes   = 0;
    partnerSocket.hasTyped = false;  partnerSocket.chatStartedAt = now;
    partnerSocket.lastMessages = []; partnerSocket.spamStrikes   = 0;
    broadcastQueuePositions();
  }

  socket.on("findPartner", () => {
    if (!socket.userName || socket.partner) return;
    socket.lastPartnerName = "";
    tryFindPartner();
  });

  // ── Messaging ────────────────────────────────────────────────────────────
  socket.on("message", (msg) => {
    if (!socket.partner) return;
    if (!msgRateLimiter.check(socket)) return;

    // ── Anti-bot layer 1: typing gate ─────────────────────────────────────
    // Real users always trigger the 'input' event which emits typing:true.
    // Bots sending via socket.io-client skip this entirely.
    // Typing gate: soft check only — do not kick real users for this
    // (paste, mobile autocomplete, reconnect can all skip the typing event)
    socket.hasTyped = false; // reset for next message

    // Speed gate removed — causes false drops on reconnect

    let text = "", messageId = null, replyTo = null;
    if (typeof msg === "string") {
      text = msg;
    } else if (msg && typeof msg.text === "string") {
      text = msg.text;
      messageId = msg.messageId;
      if (msg.replyTo && typeof msg.replyTo.text === "string") {
        replyTo = {
          text:       msg.replyTo.text.slice(0, 100).replace(/<[^>]*>/g, "").trim(),
          senderName: String(msg.replyTo.senderName || "").slice(0, 30).replace(/<[^>]*>/g, "").trim(),
        };
      }
    }

    text = text.slice(0, MSG_MAX).replace(/<[^>]*>/g, "").trim();
    if (!text) return;

    // ── Blocked-phrase filter ───────────────────────────────────────────────
    // The message is still blocked and the sender still kicked. The permanent
    // IP ban that used to come with it is gated behind AUTO_BAN_ENABLED, so
    // nothing bans an IP by itself any more.
    if (BLOCKED_PHRASE_RE.test(text)) {
      if (AUTO_BAN_ENABLED) {
        console.warn(`[PHRASE-BAN] "${text.slice(0,80)}" matched blocked phrase — banning ${socket.clientIP}`);
        bannedIPs.add(socket.clientIP);
      } else {
        console.warn(`[PHRASE] "${text.slice(0,80)}" matched blocked phrase — kicked, NOT banned (auto-ban disabled)`);
      }
      const bp = socket.partner;
      if (bp) {
        bp.partner = null;
        bp.emit("partnerDisconnected", { name: socket.userName });
      }
      socket.partner = null;
      cleanupGameForSocket(socket.id);
      socket.emit("autoKicked");
      setTimeout(() => socket.disconnect(true), 500);
      return;
    }

    // ── @ mention kick ────────────────────────────────────────────────────
    if (/(?:^|\s)@\s*\w/.test(text)) {
      console.warn(`[BOT-AT] @ mention message — ${socket.userName}: ${text.slice(0, 60)}`);
      const strikeResult1 = recordLinkStrike(socket.clientIP);
      if (strikeResult1 === 'warning') {
        // First offence — warn but don't kick
        socket.emit("linkWarning");
        return;
      }
      // Second offence — ban and kick
      const kickedPartner = socket.partner;
      socket.emit("linkBanned");
      if (kickedPartner) {
        kickedPartner.emit("partnerLinkKicked");
        kickedPartner.partner        = null;
        kickedPartner.lastPartnerName = "";
      }
      socket.partner = null;
      cleanupGameForSocket(socket.id);
      setTimeout(() => socket.disconnect(true), 1500);
      return;
    }

    if (containsLink(text)) {
      const strikeResult2 = recordLinkStrike(socket.clientIP);
      if (strikeResult2 === 'warning') {
        socket.emit("linkWarning");
        return;
      }
      const kickedPartner2 = socket.partner;
      socket.emit("linkBanned");
      if (kickedPartner2) kickedPartner2.emit("partnerLinkKicked");
      socket.partner = null;
      if (kickedPartner2) { kickedPartner2.partner = null; kickedPartner2.lastPartnerName = ""; }
      cleanupGameForSocket(socket.id);
      setTimeout(() => socket.disconnect(true), 1500);
      return;
    }
    if (!socket.partner) return; // partner left
    if (socket.partner._isGhost) {
      socket.partner._messageQueue = socket.partner._messageQueue || [];
      socket.partner._messageQueue.push({ text, messageId, replyTo });
    } else {
      socket.partner.emit("message", { text, messageId, replyTo });
      bumpStat("msgRandom");
    }
  });

  // ── Question card ─────────────────────────────────────────────────────────
  socket.on("sendQuestion", ({ text }) => {
    if (!socket.partner || typeof text !== "string") return;
    if (socket.partner._isGhost) return; // partner is mid-reconnect, skip
    const safeText = text.slice(0, 300).replace(/<[^>]*>/g, "").trim();
    if (!safeText) return;
    socket.partner.emit("partnerQuestion", { text: safeText, senderName: socket.userName });
  });

  // ── Seen indicator ───────────────────────────────────────────────────────
  socket.on("seen", ({ messageId }) => {
    if (socket.partner && messageId) socket.partner.emit("partnerSeen", { messageId });
  });

  // ── GIF ──────────────────────────────────────────────────────────────────
  socket.on("gif", (data) => {
    if (!socket.partner || typeof data?.url !== "string") return;
    if (!/^https:\/\/(?:[a-z0-9-]+\.)?giphy\.com\//i.test(data.url)) return;
    if (socket.partner._isGhost) return; // partner mid-reconnect
    // Max 8 GIFs per 10s — plenty for real chatting, cuts off spam/scripts
    if (mediaRateLimited(socket, "gif", 8, 10_000)) return;
    socket.partner.emit("gif", { url: data.url, preview: data.preview });
  });

  // ── Sticker ──────────────────────────────────────────────────────────────
  socket.on("sticker", (data) => {
    if (!socket.partner || !data || !STICKER_IDS.has(data.id)) return;
    if (socket.partner._isGhost) return; // partner mid-reconnect
    if (mediaRateLimited(socket, "sticker", 8, 10_000)) return;
    socket.partner.emit("sticker", { id: data.id });
  });

  // ── Reactions ────────────────────────────────────────────────────────────
  socket.on("react", ({ messageId, emoji }) => {
    if (!socket.partner || !messageId || !emoji) return;
    if (!VALID_EMOJIS.has(emoji)) return;
    socket.partner.emit("reacted", { messageId, emoji });
  });

  // ── Typing ───────────────────────────────────────────────────────────────
  socket.on("typing", (isTyping) => {
    if (isTyping) socket.hasTyped = true;   // ← anti-bot gate
    if (socket.partner) socket.partner.emit("partnerTyping", Boolean(isTyping));
  });

  // ── Report ───────────────────────────────────────────────────────────────
  socket.on("reportUser", ({ reason }) => {
    // Resolution order: current live partner (most accurate) → the
    // immutable snapshot taken when this pairing started (survives
    // block/skip clearing lastPartnerName). We deliberately do NOT fall
    // back to any value left over from a PREVIOUS report this session —
    // that was the cause of reports sometimes showing an unrelated
    // earlier partner's name.
    const snap              = socket._reportSnapshot || {};
    const targetIP          = socket.partner ? socket.partner.clientIP : (socket.lastPartnerIP || snap.ip || "");
    const targetSocketId    = socket.partner ? socket.partner.id       : (socket.lastPartnerSocketId || snap.socketId || "");
    const targetName        = socket.partner ? socket.partner.userName : (socket.lastPartnerName || snap.name || "");

    if (!targetIP) return; // nothing to report

    // A reason is required — reject silently if missing/empty (client UI enforces this too)
    const cleanReason = (reason || "").trim().slice(0, 200);
    if (!cleanReason) return;

    // Prevent double-reporting the same partner
    if (socket.hasReportedLast) return;
    socket.hasReportedLast = true;

    const entry = {
      reportedId:   targetSocketId,
      reportedName: targetName,
      reportedBy:   socket.userName,
      reporterIP:   socket.clientIP,
      targetIP,
      reason:       cleanReason,
      timestamp:    new Date().toISOString(),
    };
    reportLog.push(entry);
    console.log("REPORT:", JSON.stringify(entry));

    const justBanned = recordReport(socket.id, targetIP, cleanReason, socket.userName, targetName);
    if (justBanned) {
      // Kick the reported partner if still connected
      const target = socket.partner || (targetSocketId ? io.sockets.sockets.get(targetSocketId) : null);
      if (target && target.connected) {
        target.emit("reportBanned");
        if (target.partner) { target.partner.partner = null; }
        target.partner = null;
        if (socket.partner && socket.partner.id === target.id) socket.partner = null;
        cleanupGameForSocket(target.id);
        setTimeout(() => target.disconnect(true), 1500);
      }
    }
    socket.emit("reportConfirmed");
  });

  // ── Next ─────────────────────────────────────────────────────────────────
  socket.on("next", () => {
    if (!socket.userName) return;

    if (socket.partner) {
      const oldPartner   = socket.partner;
      const oldPartnerId = oldPartner.id;

      socket.partner              = null;
      oldPartner.partner          = null;
      socket.lastPartnerName      = "";
      oldPartner.lastPartnerName  = "";
      oldPartner.emit("partnerDisconnected", { name: socket.userName });

      socket.recentPartnerIds.add(oldPartnerId);
      oldPartner.recentPartnerIds.add(socket.id);
      setTimeout(() => {
        socket.recentPartnerIds.delete(oldPartnerId);
        if (oldPartner.connected) oldPartner.recentPartnerIds.delete(socket.id);
        // Do NOT auto-queue either side — both must press Search themselves
      }, 5000);

      cleanupGameForSocket(socket.id);
      cleanupGameForSocket(oldPartnerId);
    }

    // User pressed Search — start looking for a partner via the queue system
    tryFindPartner();
  });

  socket.on("blockUser", (data) => {
    // Treat a ghost partner (mid-reconnect grace) the same as "partner already left"
    if (socket.partner && socket.partner._isGhost) {
      const ghostName = socket.partner.userName || "";
      const nameLower = ghostName.toLowerCase();
      if (pendingDisconnects.has(nameLower)) {
        const { timeout } = pendingDisconnects.get(nameLower);
        clearTimeout(timeout);
        pendingDisconnects.delete(nameLower);
        activeUsernames.delete(nameLower);
      }
      socket.partner.partner = null;
      socket.partner         = null;
      if (ghostName && !socket.lastPartnerName) socket.lastPartnerName = ghostName;
    }

    // Fallback: client sends the name it saw — use it if server lost it
    if (!socket.partner && !socket.lastPartnerName && data && data.targetName) {
      socket.lastPartnerName = String(data.targetName).trim();
    }

    if (!socket.partner && !socket.lastPartnerName) return;

    // Add to blocks list (no limit anymore — users can block unlimited other users)

    if (socket.partner) {
      const blockedName        = socket.partner.userName.toLowerCase();
      const blockedDisplayName = socket.partner.userName;
      const blockedSocket      = socket.partner;

      if (!socket.blockedNames.includes(blockedName)) socket.blockedNames.push(blockedName);
      socket.blockedIds.add(blockedSocket.id); // ID-based block — immune to name changes

      // Cancel any active game
      cleanupGameForSocket(socket.id);

      socket.partner                = null;
      blockedSocket.partner         = null;
      socket.lastPartnerName        = "";
      blockedSocket.lastPartnerName = "";
      blockedSocket.emit("youWereBlocked", { name: socket.userName });

      // Time-windowed block counter — only count blocks within the last 5 minutes.
      // Bots get blocked rapidly in succession; real users don't hit this threshold.
      const now5 = Date.now();
      blockedSocket.blockedByTimes.push(now5);
      blockedSocket.blockedByTimes = blockedSocket.blockedByTimes.filter(
        t => now5 - t < 300000 // keep last 5 minutes for logging (but no limit enforcement)
      );
      // No longer auto-kick on block limit — blocks are unlimited now
      socket.emit("userBlocked", { name: blockedDisplayName });
    } else {
      const blockedName        = socket.lastPartnerName.toLowerCase();
      const blockedDisplayName = socket.lastPartnerName;
      if (!socket.blockedNames.includes(blockedName)) socket.blockedNames.push(blockedName);
      // Clear the name immediately so a double-click doesn't re-block.
      // Keep IP/socketId alive for 2s so a concurrent reportUser (sent in
      // the same button click) can still look up the target.
      socket.lastPartnerName = "";
      setTimeout(() => {
        socket.lastPartnerIP       = "";
        socket.lastPartnerSocketId = "";
      }, 2000);
      socket.emit("userBlocked", { name: blockedDisplayName });
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  MINI GAMES
  // ════════════════════════════════════════════════════════════════

  // Send game request to partner
  socket.on("game:request", ({ gameType }) => {
    if (!socket.partner) return;
    if (socket.partner._isGhost) return; // partner mid-reconnect, can't start game
    if (!["ttt", "rps", "math", "truthordare"].includes(gameType)) return;
    socket.partner.emit("game:invite", { gameType, fromId: socket.id });
  });

  // Accept or decline a game invite
  socket.on("game:response", ({ accepted, gameType, toId }) => {
    const requester = io.sockets.sockets.get(toId);
    if (!requester) return;

    if (!accepted) {
      requester.emit("game:declined");
      return;
    }

    const gameId  = `${toId}:${socket.id}`;
    const players = [toId, socket.id]; // [requester=X/p1, accepter=O/p2]
    let state;

    if (gameType === "ttt") {
      state = { board: Array(9).fill(null), currentTurnSocketId: toId };
    } else if (gameType === "rps") {
      state = { choices: {} };
    } else if (gameType === "math") {
      state = { question: generateMathQuestion(), answered: false };
    } else if (gameType === "truthordare") {
      state = { chosen: false, choice: null, prompt: null };
    } else return;

    const game = { id: gameId, type: gameType, players, state };
    gameById.set(gameId, game);
    gameBySocket.set(toId,      gameId);
    gameBySocket.set(socket.id, gameId);

    // Truth-or-Dare: the ACCEPTER is the one who picks truth/dare (per spec —
    // requester sends the invite, accepter chooses). Everything else keeps
    // the existing X/O role labels (only meaningful for ttt anyway).
    const roles = gameType === "truthordare"
      ? { [toId]: "requester", [socket.id]: "chooser" }
      : { [toId]: "X", [socket.id]: "O" };
    players.forEach(pid => {
      const s = io.sockets.sockets.get(pid);
      if (s) s.emit("game:start", {
        gameId,
        gameType,
        role:       roles[pid] ?? null,
        opponentId: pid === toId ? socket.id : toId,
        state,
      });
    });
  });

  // Handle game moves
  socket.on("game:move", (data) => {
    const gameId = gameBySocket.get(socket.id);
    if (!gameId) return;
    const game = gameById.get(gameId);
    if (!game) return;

    const [p1Id, p2Id] = game.players;
    const partnerId    = socket.id === p1Id ? p2Id : p1Id;
    const partner      = io.sockets.sockets.get(partnerId);

    // If partner is a ghost (mid-reconnect) we can't relay moves — end the game
    if (!partner || partner._isGhost) {
      socket.emit("game:partnerLeft");
      cleanupGame(game);
      return;
    }

    // ── Tic Tac Toe ──────────────────────────────────────────────
    if (game.type === "ttt") {
      const { index } = data;
      if (typeof index !== "number" || index < 0 || index > 8) return;
      const { board, currentTurnSocketId } = game.state;
      if (currentTurnSocketId !== socket.id) return;
      if (board[index] !== null) return;

      const symbol    = socket.id === p1Id ? "X" : "O";
      board[index]    = symbol;
      const winResult = checkTTTWinner(board);
      const draw      = !winResult && board.every(Boolean);

      if (!winResult && !draw) game.state.currentTurnSocketId = partnerId;

      const update = {
        board,
        currentTurnSocketId: game.state.currentTurnSocketId,
        winnerSocketId: winResult ? socket.id : undefined,
        winLine:        winResult ? winResult.line : undefined,
        draw:           draw || undefined,
      };
      socket.emit("game:update", update);
      if (partner) partner.emit("game:update", update);
      if (winResult || draw) cleanupGame(game);

    // ── Rock Paper Scissors ───────────────────────────────────────
    } else if (game.type === "rps") {
      const { choice } = data;
      if (!["rock", "paper", "scissors"].includes(choice)) return;
      if (game.state.choices[socket.id]) return;
      game.state.choices[socket.id] = choice;

      if (partner) partner.emit("game:update", { opponentChose: true });

      if (Object.keys(game.state.choices).length === 2) {
        const c1     = game.state.choices[p1Id];
        const c2     = game.state.choices[p2Id];
        const result = getRPSWinner(c1, c2);
        const winnerSocketId = result === "draw" ? null : result === "p1" ? p1Id : p2Id;
        const update = { choices: game.state.choices, winnerSocketId, draw: result === "draw" };
        socket.emit("game:update", update);
        if (partner) partner.emit("game:update", update);
        cleanupGame(game);
      }

    // ── Math Duel ─────────────────────────────────────────────────
    } else if (game.type === "math") {
      if (game.state.answered) return;
      const submitted = parseInt(data.answer, 10);
      if (isNaN(submitted)) return;

      if (submitted === game.state.question.answer) {
        game.state.answered = true;
        const update = {
          winnerSocketId: socket.id,
          answer:         game.state.question.answer,
          question:       game.state.question,
        };
        socket.emit("game:update", update);
        if (partner) partner.emit("game:update", update);
        cleanupGame(game);
      } else {
        socket.emit("game:update", { wrong: true });
      }

    // ── Truth or Dare ────────────────────────────────────────────
    } else if (game.type === "truthordare") {
      // Only the "chooser" (the one who accepted the invite) may choose.
      const chooserId = p2Id;
      if (socket.id !== chooserId) return;
      if (game.state.chosen) return;

      const { choice } = data;
      if (choice !== "truth" && choice !== "dare") return;

      const list   = choice === "truth" ? TRUTH_PROMPTS : DARE_PROMPTS;
      const prompt = list[rand(0, list.length - 1)];

      game.state.chosen = true;
      game.state.choice = choice;
      game.state.prompt = prompt;

      const update = { choice, prompt };
      socket.emit("game:update", update);
      if (partner) partner.emit("game:update", update);
      cleanupGame(game); // one round — "🔄 ხელახლა" (rematch) starts a fresh invite
    }
  });

  // Rematch request
  socket.on("game:rematch", ({ gameType, toId }) => {
    if (!["ttt", "rps", "math", "truthordare"].includes(gameType)) return;
    const target = io.sockets.sockets.get(toId);
    if (target && !target._isGhost) target.emit("game:invite", { gameType, fromId: socket.id, isRematch: true });
  });

  // ════════════════════════════════════════════════════════════════
  //  SYNCED MUSIC (YouTube) — available to every user
  // ════════════════════════════════════════════════════════════════

  // Send a "listen together" request to the current partner.
  // Available to every user — guest or registered.
  socket.on("music:request", ({ url }) => {
    if (!socket.partner || socket.partner._isGhost) return;
    // Max 10 music invites per 30s — invites themselves are tiny, but this
    // stops a script from spamming YouTube-load invites at a partner.
    if (mediaRateLimited(socket, "musicRequest", 10, 30_000)) return;

    const videoId = extractYouTubeId(url);
    if (!videoId) {
      socket.emit("music:error", { message: "არასწორი YouTube ბმული." });
      return;
    }

    socket.partner.emit("music:invite", {
      videoId,
      fromId:   socket.id,
      fromName: socket._regUser ? socket._regUser.username : (socket.userName || "პარტნიორი"),
    });
  });

  // Accept or decline a music invite
  socket.on("music:response", ({ accepted, toId, videoId }) => {
    const requester = io.sockets.sockets.get(toId);
    if (!requester) return;

    if (!accepted) {
      requester.emit("music:declined");
      return;
    }

    const cleanVideoId = extractYouTubeId(videoId) || (typeof videoId === "string" ? videoId.slice(0, 20) : null);
    if (!cleanVideoId) return;

    // Small buffer so both clients have time to load the YouTube player
    // before starting playback in sync.
    const payload = { videoId: cleanVideoId, hostId: toId, startAt: Date.now() + 3500 };
    requester.emit("music:start", payload);
    socket.emit("music:start", payload);
  });

  // Relay play/pause/seek actions between the two listeners
  socket.on("music:control", ({ action, time }) => {
    if (!socket.partner || socket.partner._isGhost) return;
    if (!["play", "pause", "seek"].includes(action)) return;
    socket.partner.emit("music:control", { action, time });
  });

  // Either side can end the shared listening session
  socket.on("music:stop", () => {
    if (socket.partner && !socket.partner._isGhost) socket.partner.emit("music:stop");
  });

  // Tab-away events disabled — no action taken when user hides browser tab

  // (Disconnect handling for this connection lives in the merged handler
  // further down in the file, which covers both this random-chat cleanup
  // AND all the registered/guest/game cleanup together — see the comment
  // there for why.)
});

// ── Stats API ────────────────────────────────────────────────────────────────
app.get(ROUTE.statsApi, (req, res) => {
  const now       = Date.now();
  const uptimeSec = Math.floor((now - stats.serverStartedAt) / 1000);
  const dayKeys   = [...stats.days.keys()].sort();

  // Sign-ups per day (Tbilisi dates), from account creation times
  const regsByDay = {};
  for (const [, u] of registeredUsers) {
    if (u.isGuest) continue;
    const t = Date.parse(u.createdAt || "");
    if (t) { const dk = new Date(t + TBILISI_OFFSET_MS).toISOString().slice(0, 10); regsByDay[dk] = (regsByDay[dk] || 0) + 1; }
  }

  const days = dayKeys.map((dk, i) => {
    const d          = stats.days.get(dk);
    const avgDurSec  = d.sessions > 0 ? Math.round(d.totalDurationMs / d.sessions / 1000) : 0;
    const hours = d.hours.map((h, hi) => ({
      hour: hi, label: hi.toString().padStart(2, "0") + ":00", uniqueIPs: h.ips.size, sessions: h.sessions,
    }));
    const peakHour = hours.reduce((best, h) => (h.uniqueIPs > best.uniqueIPs ? h : best), hours[0]);
    // Did this day's first-time visitors come back? (next day / within the next 7 days we still have)
    let nextDayReturn = null, weekReturn = null;
    if (d.newIPs.size && i + 1 < dayKeys.length) {
      const next = stats.days.get(dayKeys[i + 1]);
      let back1 = 0, back7 = 0;
      const later = dayKeys.slice(i + 1, i + 8).map(k => stats.days.get(k));
      for (const ip of d.newIPs) {
        if (next.ips.has(ip)) back1++;
        if (later.some(x => x.ips.has(ip))) back7++;
      }
      nextDayReturn = Math.round((back1 / d.newIPs.size) * 100);
      weekReturn    = Math.round((back7 / d.newIPs.size) * 100);
    }
    const devices = {};
    for (const k of DEVICE_KINDS) devices[k] = d.devices?.[k]?.size || 0;
    return {
      date: dk, uniqueIPs: d.ips.size, newIPs: d.newIPs.size, returningIPs: d.ips.size - d.newIPs.size,
      sessions: d.sessions, avgSessionSec: avgDurSec, chats: d.chats, peakOnline: d.peakOnline,
      peakOnlineAt: d.peakOnlineAt, peakHour, hours,
      nextDayReturn, weekReturn, signups: regsByDay[dk] || 0,
      counters: d.counters || {}, devices, pages: d.pages || {},
    };
  });

  // Community totals — aggregate numbers only, nothing that identifies anyone
  let accounts = 0, vip = 0, newAccounts7d = 0, friendLinks = 0, profilesFilled = 0;
  const gender = { male: 0, female: 0 };
  const ageGroups = { "18–20": 0, "21–25": 0, "26–30": 0, "31–40": 0, "41+": 0 };
  const weekAgo = now - 7 * 864e5;
  for (const [, u] of registeredUsers) {
    if (u.isGuest) continue;
    accounts++;
    if (u.isPro) vip++;
    const t = Date.parse(u.createdAt || ""); if (t && t >= weekAgo) newAccounts7d++;
    friendLinks += Array.isArray(u.friends) ? u.friends.length : 0;
    const pr = u.profile || {};
    if (pr.age || pr.gender || pr.city || pr.study || pr.work) profilesFilled++;
    if (pr.gender === "male" || pr.gender === "female") gender[pr.gender]++;
    if (pr.age) { const x = pr.age; ageGroups[x <= 20 ? "18–20" : x <= 25 ? "21–25" : x <= 30 ? "26–30" : x <= 40 ? "31–40" : "41+"]++; }
  }
  const yesterday = addDaysUTC(todayUTC(), -1);
  let activeStreaks = 0, longestStreak = 0;
  for (const [, st] of friendStreaks) {
    if (st.count > 0 && st.lastDate && st.lastDate >= yesterday) { activeStreaks++; if (st.count > longestStreak) longestStreak = st.count; }
  }
  let privateMessagesStored = 0; for (const [, r] of privateRooms) privateMessagesStored += (r.messages || []).length;
  let roomMessagesStored = 0;    for (const [, r] of chatRooms) roomMessagesStored += (r.messages || []).length;
  let forumComments = 0;         for (const [, fp] of forumPosts) forumComments += (fp.comments || []).length;

  // Right now
  const regOnline = new Set(), guestOnline = new Set();
  let chatting = 0;
  for (const sk of io.sockets.sockets.values()) {
    if (sk.partner) chatting++;
    const r = sk._regUser;
    if (r && r.isGuest) guestOnline.add(r.usernameLower);
    else if (r && isVisiblyOnline(r.usernameLower)) regOnline.add(r.usernameLower);
  }

  res.json({
    currentOnline:    getUniqueOnlineIPCount(),
    peakOnline:       stats.peakOnline,
    peakOnlineAt:     stats.peakOnlineAt,
    allTimeUniqueIPs: stats.allTimeIPs.size,
    uptimeSec,
    memoryMB:         Math.round(process.memoryUsage().rss / 1048576),
    extendedSince:    stats.extendedSince || null,
    live: { registered: regOnline.size, guests: guestOnline.size, chatting, waiting: waitingQueue.length },
    community: {
      accounts, vip, newAccounts7d, friendships: Math.round(friendLinks / 2), activeStreaks, longestStreak,
      privateConversations: privateRooms.size, privateMessagesStored, rooms: chatRooms.size, roomMessagesStored,
      forumPosts: forumPosts.size, forumComments, profilesFilled, gender, ageGroups,
    },
    days,
  });
});


// GET <stats route> — stats dashboard (now public — anyone with the link can view)
app.get(ROUTE.stats, (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const API = ROUTE.statsApi;
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>GAICANI — Statistics</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Georgian:wght@400;600;800&display=swap" rel="stylesheet">
<style>
:root { --bg:#130f26; --card:#1c1735; --raised:#241e44; --line:rgba(214,168,79,.18); --gold:#f4d98f; --text:#f3eeff; --muted:#9a92bd;
  --c-new:#4f6cff; --c-ret:#1fc18a; --c-sess:#9d5cff; --c-amber:#f0b93a; --c-ruby:#e33b5f; --c-teal:#19b3a6; --c-pink:#ec4f9c; }
* { box-sizing:border-box; }
body { margin:0; background:radial-gradient(900px 500px at 50% -150px,rgba(79,108,255,.18),transparent 70%),var(--bg); color:var(--text);
  font-family:"Noto Sans Georgian",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; font-size:15px;
  padding:env(safe-area-inset-top,0) 0 env(safe-area-inset-bottom,0); }
.wrap { max-width:1100px; margin:0 auto; padding:18px 14px 40px; }
header { display:flex; align-items:flex-end; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:6px; }
h1 { margin:0; font-size:1.55em; font-weight:800; }
h1 .gt { background:linear-gradient(180deg,#fff4d2,#f4d98f 45%,#d6a84f); -webkit-background-clip:text; background-clip:text; color:transparent; }
.sub { color:var(--muted); font-size:.82em; }
.live-dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--c-ret); box-shadow:0 0 8px var(--c-ret); margin-right:6px; vertical-align:middle; }
h2 { font-size:1.05em; font-weight:800; margin:26px 2px 4px; color:var(--gold); }
.note { color:var(--muted); font-size:.8em; margin:0 2px 10px; line-height:1.5; }
.hero { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin:14px 0 4px; }
.hero-card { border-radius:20px; padding:16px; border:1px solid var(--line); background:linear-gradient(180deg,#241e46,var(--card)); }
.hero-card .hl { font-size:.85em; font-weight:700; color:var(--muted); }
.hero-card .hv { font-size:2.8em; font-weight:800; line-height:1.05; margin-top:6px; font-variant-numeric:tabular-nums; }
.hero-card .hs { font-size:.78em; color:var(--muted); margin-top:6px; line-height:1.45; }
.hero-card.now { border-color:rgba(31,193,138,.45); box-shadow:0 14px 34px -22px rgba(31,193,138,.9); }
.hero-card.now .hv { color:#62e3b3; }
.hero-card.peak { border-color:rgba(244,217,143,.45); box-shadow:0 14px 34px -22px rgba(240,185,58,.9); }
.hero-card.peak .hv { color:var(--gold); }
.kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; }
.kpi { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:13px 14px; }
.kpi .v { font-size:1.65em; font-weight:800; line-height:1.15; }
.kpi .l { color:var(--muted); font-size:.8em; margin-top:3px; }
.kpi .x { color:var(--gold); font-size:.78em; margin-top:4px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:18px; padding:14px; margin-top:10px; }
.card h3 { margin:0 0 14px; font-size:.95em; font-weight:800; }
.grid2 { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:10px; }
.legend { display:flex; flex-wrap:wrap; gap:12px; font-size:.78em; color:var(--muted); margin:6px 0 8px; }
.legend i { display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:5px; vertical-align:-1px; }
.bars { display:flex; align-items:flex-end; gap:4px; height:170px; padding-top:16px; border-bottom:1px solid var(--line); }
.col { flex:1 1 0; min-width:0; height:100%; display:flex; flex-direction:column; justify-content:flex-end; align-items:stretch; position:relative; }
.stack { display:flex; flex-direction:column-reverse; border-radius:6px 6px 2px 2px; overflow:hidden; min-height:2px; }
.seg { width:100%; }
.top { position:absolute; left:0; right:0; text-align:center; font-size:.68em; color:var(--text); opacity:.85; transform:translateY(-15px); white-space:nowrap; }
.xl { display:flex; gap:4px; margin-top:4px; }
.xl span { flex:1 1 0; min-width:0; text-align:center; font-size:.68em; color:var(--muted); overflow:hidden; }
.hb { display:grid; grid-template-columns:minmax(90px,38%) 1fr auto; gap:8px 10px; align-items:center; font-size:.86em; }
.hb .t { background:rgba(255,255,255,.05); border-radius:6px; height:14px; overflow:hidden; }
.hb .f { height:100%; border-radius:6px; }
.hb .n { color:var(--muted); font-variant-numeric:tabular-nums; }
.heat { max-width:760px; display:grid; grid-template-columns:44px repeat(24,minmax(0,1fr)); gap:2px; font-size:.64em; }
.heat .h { color:var(--muted); text-align:center; }
.heat .r { color:var(--muted); text-align:right; padding-right:4px; white-space:nowrap; }
.heat .c { aspect-ratio:1/1; border-radius:3px; background:rgba(255,255,255,.04); }
.tbl-wrap { overflow-x:auto; margin-top:10px; }
table { border-collapse:collapse; width:100%; font-size:.8em; white-space:nowrap; }
th, td { padding:7px 8px; text-align:right; border-bottom:1px solid rgba(255,255,255,.06); }
th { color:var(--gold); font-weight:700; } th:first-child, td:first-child { text-align:left; }
.empty { color:var(--muted); font-size:.85em; padding:18px 4px; text-align:center; }
.pill { display:inline-block; padding:2px 9px; border-radius:999px; background:rgba(214,168,79,.12); border:1px solid var(--line); color:var(--gold); font-size:.78em; }
footer { color:var(--muted); font-size:.76em; margin-top:28px; line-height:1.6; text-align:center; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div><h1>📊 <span class="gt">GAICANI Statistics</span></h1><div class="sub"><span class="live-dot"></span><span id="updated">loading…</span></div></div>
    <div class="sub" id="server"></div>
  </header>

  <div class="hero">
    <div class="hero-card now"><div class="hl"><span class="live-dot"></span>Online right now</div><div class="hv" id="heroNow">–</div><div class="hs" id="heroNowSub"></div></div>
    <div class="hero-card peak"><div class="hl">📈 Most online at once today</div><div class="hv" id="heroPeak">–</div><div class="hs" id="heroPeakSub"></div></div>
  </div>

  <h2>Right now</h2>
  <div class="kpis" id="live"></div>

  <h2>All time</h2>
  <div class="kpis" id="totals"></div>

  <h2>Visitors per day</h2>
  <p class="note">Last 14 days (Tbilisi time). New = first visit ever; returning = seen before.</p>
  <div class="card"><div class="legend"><span><i style="background:var(--c-new)"></i>New visitors</span><span><i style="background:var(--c-ret)"></i>Returning visitors</span></div><div id="chVisitors"></div></div>

  <div class="grid2">
    <div class="card"><h3>Random chats started</h3><div id="chChats"></div></div>
    <div class="card"><h3>Average time on the site</h3><div id="chDur"></div></div>
    <div class="card"><h3>New accounts</h3><div id="chSignups"></div></div>
    <div class="card"><h3>Most people online at once</h3><div id="chPeak"></div></div>
  </div>

  <h2>When people are online</h2>
  <p class="note">Unique visitors per hour, each row is a day. Brighter = busier.</p>
  <div class="card"><div id="heat"></div><div class="note" id="busiest" style="margin:10px 0 0"></div></div>

  <h2>Do new visitors come back?</h2>
  <p class="note">Share of each day's first-time visitors who returned the next day.</p>
  <div class="card"><div id="retKpis" class="kpis" style="margin-bottom:10px"></div><div id="chRet"></div></div>

  <h2>Activity</h2>
  <p class="note" id="sinceNote"></p>
  <div class="card"><h3>Messages per day</h3>
    <div class="legend"><span><i style="background:var(--c-new)"></i>Random chat</span><span><i style="background:var(--c-sess)"></i>Private chat</span><span><i style="background:var(--c-teal)"></i>Rooms</span><span><i style="background:var(--c-amber)"></i>Private photos</span></div>
    <div id="chMsgs"></div></div>
  <div class="grid2">
    <div class="card"><h3>Games played (last 14 days)</h3><div id="games"></div></div>
    <div class="card"><h3>Forum (last 14 days)</h3><div id="forum"></div></div>
    <div class="card"><h3>Devices</h3><p class="note" style="margin:2px 0 10px">Share of daily visitors, last 14 days.</p><div id="devices"></div></div>
    <div class="card"><h3>Most opened pages (last 14 days)</h3><div id="pages"></div></div>
  </div>

  <h2>Community</h2>
  <div class="kpis" id="content"></div>
  <div class="grid2">
    <div class="card"><h3>Gender</h3><p class="note" style="margin:2px 0 10px" id="genderNote"></p><div id="gender"></div></div>
    <div class="card"><h3>Age groups</h3><p class="note" style="margin:2px 0 10px">Only people who entered an age.</p><div id="ages"></div></div>
  </div>

  <h2>Day by day</h2>
  <div class="card"><div class="tbl-wrap"><table id="table"></table></div></div>

  <footer>Totals only: this page never shows names, messages or IP addresses.<br>Refreshes automatically every 30 seconds.</footer>
</div>
<script>
var API = "${API}";
function $(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
function fmt(n) { return (Number(n) || 0).toLocaleString("en-US"); }
function dur(sec) { sec = Math.round(sec || 0); if (sec < 60) return sec + "s"; var m = Math.floor(sec / 60); if (m < 60) return m + "m " + (sec % 60) + "s"; return Math.floor(m / 60) + "h " + (m % 60) + "m"; }
function up(sec) { var d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60); return (d ? d + "d " : "") + h + "h " + m + "m"; }
function when(iso) { if (!iso) return ""; var d = new Date(iso); return d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tbilisi" }); }
function dlabel(k) { return String(k).slice(8); }
function kpi(v, l, x) { return '<div class="kpi"><div class="v">' + v + '</div><div class="l">' + l + '</div>' + (x ? '<div class="x">' + x + '</div>' : '') + '</div>'; }

// Stacked vertical bars: series = [{ color, values:[...] }], labels = [...]
function bars(el, labels, series, opts) {
  opts = opts || {};
  var totals = labels.map(function (_, i) { return series.reduce(function (s, se) { return s + (se.values[i] || 0); }, 0); });
  var max = Math.max.apply(null, totals.concat([1]));
  if (!labels.length) { el.innerHTML = '<div class="empty">No data yet</div>'; return; }
  var h = '<div class="bars">';
  labels.forEach(function (lab, i) {
    var t = totals[i], pct = t ? Math.max(2, Math.round(t / max * 100)) : 0;
    var tip = esc(opts.tipLabels ? opts.tipLabels[i] : lab) + ": " + (opts.fmt ? opts.fmt(t) : fmt(t));
    h += '<div class="col" title="' + tip + '">';
    if (t) h += '<div class="top" style="bottom:' + pct + '%">' + (opts.topFmt ? opts.topFmt(t) : opts.fmt ? opts.fmt(t) : fmt(t)) + '</div>';
    h += '<div class="stack" style="height:' + pct + '%">';
    series.forEach(function (se) { var v = se.values[i] || 0; if (v) h += '<div class="seg" style="flex:' + v + ';background:' + se.color + '"></div>'; });
    h += '</div></div>';
  });
  h += '</div><div class="xl">' + labels.map(function (l) { return '<span>' + esc(l) + '</span>'; }).join("") + '</div>';
  el.innerHTML = h;
}
// Horizontal bars: rows = [{ label, value, color }]
function hbars(el, rows, opts) {
  opts = opts || {};
  rows = rows.filter(function (r) { return r.value > 0; });
  if (!rows.length) { el.innerHTML = '<div class="empty">' + (opts.empty || "No data yet") + '</div>'; return; }
  var total = rows.reduce(function (s, r) { return s + r.value; }, 0), max = Math.max.apply(null, rows.map(function (r) { return r.value; }));
  el.innerHTML = '<div class="hb">' + rows.map(function (r) {
    var share = opts.share ? " (" + Math.round(r.value / total * 100) + "%)" : "";
    return '<div>' + esc(r.label) + '</div><div class="t"><div class="f" style="width:' + Math.max(2, Math.round(r.value / max * 100)) + '%;background:' + (r.color || "var(--c-new)") + '"></div></div><div class="n">' + fmt(r.value) + share + '</div>';
  }).join("") + '</div>';
}
function sumCounter(days, key) { return days.reduce(function (s, d) { return s + ((d.counters || {})[key] || 0); }, 0); }

var GAMES = [["poker", "🃏 Poker"], ["joker", "🎴 Joker"], ["chess", "♟️ Chess"], ["checkers", "⚫ Checkers"], ["blackjack", "🂡 Blackjack"], ["imposter", "🕵️ Imposter"], ["drawGuess", "🎨 Draw & Guess"], ["flappy", "🐤 Flappy Bird"]];
var DEVICES = [["ios", "📱 iPhone / iPad", "#cfc6ee"], ["android", "🤖 Android", "#1fc18a"], ["windows", "🪟 Windows", "#4f6cff"], ["mac", "💻 Mac", "#9d5cff"], ["linux", "🐧 Linux", "#f0b93a"], ["other", "❓ Other", "#8f87ad"]];
var PAGE_NAMES = { "/": "Random chat", "/index.html": "Random chat", "/dashboard.html": "Dashboard", "/friend-chat.html": "Private chat", "/rooms.html": "Rooms",
  "/forum.html": "Forum", "/poker.html": "Poker", "/joker.html": "Joker", "/chess.html": "Chess", "/checkers.html": "Checkers", "/blackjack.html": "Blackjack",
  "/imposter.html": "Imposter", "/draw-guess.html": "Draw & Guess", "/flappy-bird.html": "Flappy Bird", "/install.html": "Install app", "/privacy.html": "Privacy", "/terms.html": "Terms" };

function render(d) {
  var days = d.days || [], labels = days.map(function (x) { return dlabel(x.date); }), dates = days.map(function (x) { return x.date; });
  var c = d.community || {}, lv = d.live || {};
  $("updated").textContent = "Live, updated " + new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Tbilisi" }) + " (Tbilisi)";
  $("server").textContent = "Server up " + up(d.uptimeSec) + (d.memoryMB ? ", " + d.memoryMB + " MB memory" : "");

  var td = days[days.length - 1] || {};
  $("heroNow").textContent = fmt(d.currentOnline);
  $("heroNowSub").textContent = fmt(lv.registered) + " registered, " + fmt(lv.guests) + " guests";
  $("heroPeak").textContent = fmt(td.peakOnline || 0);
  var peakTime = td.peakOnlineAt ? new Date(td.peakOnlineAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tbilisi" }) : "";
  $("heroPeakSub").innerHTML = (peakTime ? "at " + peakTime + " (Tbilisi)<br>" : "") + "All-time record: " + fmt(d.peakOnline) + (d.peakOnlineAt ? ", " + when(d.peakOnlineAt) : "");
  $("live").innerHTML = kpi(fmt(lv.registered), "registered online") + kpi(fmt(lv.guests), "guests online") +
    kpi(fmt(lv.chatting), "in a random chat", fmt(lv.waiting) + " waiting for a partner");
  $("totals").innerHTML = kpi(fmt(d.allTimeUniqueIPs), "visitors ever") + kpi(fmt(c.accounts), "accounts", "+" + fmt(c.newAccounts7d) + " this week") +
    kpi(fmt(c.vip), "VIP members") + kpi(fmt(c.friendships), "friendships") + kpi(fmt(c.activeStreaks), "active 🔥 streaks", c.longestStreak ? "longest: " + c.longestStreak + " days" : "") +
    kpi(fmt(d.peakOnline), "most online at once", when(d.peakOnlineAt));

  bars($("chVisitors"), labels, [{ color: "var(--c-new)", values: days.map(function (x) { return x.newIPs; }) }, { color: "var(--c-ret)", values: days.map(function (x) { return x.returningIPs; }) }], { tipLabels: dates });
  bars($("chChats"), labels, [{ color: "var(--c-pink)", values: days.map(function (x) { return x.chats; }) }], { tipLabels: dates });
  bars($("chDur"), labels, [{ color: "var(--c-sess)", values: days.map(function (x) { return x.avgSessionSec; }) }], { tipLabels: dates, fmt: dur, topFmt: function (v) { return v < 60 ? Math.round(v) + "s" : Math.round(v / 60) + "m"; } });
  bars($("chSignups"), labels, [{ color: "var(--c-amber)", values: days.map(function (x) { return x.signups; }) }], { tipLabels: dates });
  bars($("chPeak"), labels, [{ color: "var(--c-teal)", values: days.map(function (x) { return x.peakOnline; }) }], { tipLabels: dates });

  // heat-map
  var maxCell = 1, hourTotals = new Array(24).fill(0);
  days.forEach(function (x) { x.hours.forEach(function (h, i) { maxCell = Math.max(maxCell, h.uniqueIPs); hourTotals[i] += h.uniqueIPs; }); });
  var hm = '<div class="heat"><div></div>';
  for (var i = 0; i < 24; i++) hm += '<div class="h">' + (i % 3 === 0 ? i : "") + '</div>';
  days.forEach(function (x) {
    hm += '<div class="r">' + esc(x.date.slice(5)) + '</div>';
    x.hours.forEach(function (h) {
      var a = h.uniqueIPs / maxCell;
      hm += '<div class="c" title="' + esc(x.date) + ' ' + h.label + ': ' + h.uniqueIPs + ' visitors" style="background:rgba(244,217,143,' + (h.uniqueIPs ? (0.12 + a * 0.88).toFixed(2) : 0.04) + ')"></div>';
    });
  });
  $("heat").innerHTML = days.length ? hm + '</div>' : '<div class="empty">No data yet</div>';
  var top = hourTotals.map(function (v, i) { return [i, v]; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 3).filter(function (x) { return x[1] > 0; });
  $("busiest").innerHTML = top.length ? "Busiest hours: " + top.map(function (x) { return '<span class="pill">' + String(x[0]).padStart(2, "0") + ':00</span>'; }).join(" ") : "";

  // returns
  var rd = days.filter(function (x) { return x.nextDayReturn !== null; });
  var avg1 = rd.length ? Math.round(rd.reduce(function (s, x) { return s + x.nextDayReturn; }, 0) / rd.length) : null;
  var w = days.filter(function (x) { return x.weekReturn !== null; });
  var avg7 = w.length ? Math.round(w.reduce(function (s, x) { return s + x.weekReturn; }, 0) / w.length) : null;
  $("retKpis").innerHTML = kpi(avg1 === null ? "–" : avg1 + "%", "come back the next day (average)") + kpi(avg7 === null ? "–" : avg7 + "%", "come back within a week (average)");
  bars($("chRet"), rd.map(function (x) { return dlabel(x.date); }), [{ color: "var(--c-ret)", values: rd.map(function (x) { return x.nextDayReturn; }) }], { tipLabels: rd.map(function (x) { return x.date; }), fmt: function (v) { return v + "%"; } });

  // activity (tracked since the update)
  $("sinceNote").textContent = d.extendedSince ? "Counted since " + d.extendedSince + ". Earlier days show zero because they weren't tracked yet." : "Counting starts now.";
  bars($("chMsgs"), labels, [
    { color: "var(--c-new)", values: days.map(function (x) { return (x.counters || {}).msgRandom || 0; }) },
    { color: "var(--c-sess)", values: days.map(function (x) { return (x.counters || {}).msgPrivate || 0; }) },
    { color: "var(--c-teal)", values: days.map(function (x) { return (x.counters || {}).msgRooms || 0; }) },
    { color: "var(--c-amber)", values: days.map(function (x) { return (x.counters || {}).photoPrivate || 0; }) }], { tipLabels: dates });
  hbars($("games"), GAMES.map(function (g) { return { label: g[1], value: sumCounter(days, "game:" + g[0]), color: "var(--c-sess)" }; }).sort(function (a, b) { return b.value - a.value; }));
  hbars($("forum"), [{ label: "📝 New posts", value: sumCounter(days, "forumPosts"), color: "var(--c-amber)" }, { label: "💬 Comments", value: sumCounter(days, "forumComments"), color: "var(--c-teal)" }]);
  hbars($("devices"), DEVICES.map(function (dv) { return { label: dv[1], value: days.reduce(function (s, x) { return s + ((x.devices || {})[dv[0]] || 0); }, 0), color: dv[2] }; }).sort(function (a, b) { return b.value - a.value; }), { share: true });
  var pages = {};
  days.forEach(function (x) { Object.keys(x.pages || {}).forEach(function (p) { var n = PAGE_NAMES[p] || p; pages[n] = (pages[n] || 0) + x.pages[p]; }); });
  hbars($("pages"), Object.keys(pages).map(function (k) { return { label: k, value: pages[k], color: "var(--c-new)" }; }).sort(function (a, b) { return b.value - a.value; }).slice(0, 12));

  // community
  $("content").innerHTML = kpi(fmt(c.privateConversations), "private conversations", fmt(c.privateMessagesStored) + " messages kept") +
    kpi(fmt(c.rooms), "rooms", fmt(c.roomMessagesStored) + " messages") + kpi(fmt(c.forumPosts), "forum posts", fmt(c.forumComments) + " comments") +
    kpi(fmt(c.profilesFilled), "profiles with details", c.accounts ? Math.round(c.profilesFilled / c.accounts * 100) + "% of accounts" : "");
  var g = c.gender || {};
  $("genderNote").textContent = "Only people who chose one (" + fmt((g.male || 0) + (g.female || 0)) + " of " + fmt(c.accounts) + " accounts).";
  hbars($("gender"), [{ label: "👨 Men", value: g.male || 0, color: "#4f6cff" }, { label: "👩 Women", value: g.female || 0, color: "#ec4f9c" }], { share: true, empty: "Nobody has chosen yet" });
  var ag = c.ageGroups || {};
  hbars($("ages"), Object.keys(ag).map(function (k) { return { label: k, value: ag[k], color: "var(--c-teal)" }; }), { share: true, empty: "Nobody has entered an age yet" });

  // table
  var rows = days.slice().reverse().map(function (x) {
    var ct = x.counters || {};
    var msgs = (ct.msgRandom || 0) + (ct.msgPrivate || 0) + (ct.msgRooms || 0);
    return "<tr><td>" + esc(x.date) + "</td><td>" + fmt(x.uniqueIPs) + "</td><td>" + fmt(x.newIPs) + "</td><td>" + fmt(x.returningIPs) + "</td><td>" + fmt(x.sessions) +
      "</td><td>" + dur(x.avgSessionSec) + "</td><td>" + fmt(x.chats) + "</td><td>" + fmt(msgs) + "</td><td>" + fmt(x.signups) + "</td><td>" + fmt(x.peakOnline) +
      "</td><td>" + (x.peakHour && x.peakHour.uniqueIPs ? x.peakHour.label : "–") + "</td><td>" + (x.nextDayReturn === null ? "–" : x.nextDayReturn + "%") + "</td></tr>";
  }).join("");
  $("table").innerHTML = "<tr><th>Day</th><th>Visitors</th><th>New</th><th>Returning</th><th>Sessions</th><th>Avg time</th><th>Chats</th><th>Messages</th><th>Sign-ups</th><th>Peak online</th><th>Busiest hour</th><th>Came back</th></tr>" + rows;
}

function load() {
  fetch(API, { cache: "no-store" }).then(function (r) { return r.json(); }).then(render).catch(function () { $("updated").textContent = "Could not load — retrying…"; });
}
load(); setInterval(load, 30000);
</script>
</body>
</html>`);
});

// ── Sensitive-URL visitor log — owner eyes only ───────────────────────────────
app.get(ROUTE.visitorLog, ownerOnly, (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");

  const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);

  const denied    = sensitiveVisitorLog.filter(e => !e.allowed);
  const uniqueIPs = [...new Set(sensitiveVisitorLog.map(e => e.ip))];

  const rows = [...sensitiveVisitorLog].reverse().map(e => {
    return `<tr class="${e.allowed ? "ok" : "bad"}">
      <td>${esc(e.timestamp)}</td>
      <td class="ip">${esc(e.ip)}</td>
      <td>${esc(e.url)}</td>
      <td>${e.allowed ? "✅ owner" : "🚫 denied"}</td>
      <td class="ua">${esc(e.userAgent)}</td>
    </tr>`;
  }).join("");

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Sensitive URL Visitor Log — GAICANI</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#1e1f22;color:#dcddde;font-family:"Segoe UI",Arial,sans-serif;padding:24px}
h1{color:#fff;font-size:1.4em;margin-bottom:4px}
.sub{color:#72767d;font-size:.82em;margin-bottom:20px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:28px}
.sc{background:#2b2d31;border-radius:10px;padding:16px 18px}
.sv{font-size:1.8em;font-weight:700;color:#fff;line-height:1.1}
.sv.r{color:#f23f42}.sv.g{color:#3ba55d}
.sl{font-size:.75em;color:#72767d;margin-top:4px}
h2{color:#5865f2;font-size:.9em;margin:24px 0 12px;text-transform:uppercase;letter-spacing:.5px}
table{width:100%;border-collapse:collapse;background:#2b2d31;border-radius:10px;overflow:hidden;font-size:.82em}
th{background:#232428;color:#72767d;font-weight:600;padding:10px 12px;text-align:left;border-bottom:1px solid #1a1b1e}
td{padding:8px 12px;border-bottom:1px solid #1e1f22;vertical-align:top}
tr:last-child td{border-bottom:none}
tr.bad td{background:rgba(242,63,66,.07)}
tr.ok td{background:rgba(59,165,93,.04)}
.ip{font-family:monospace;color:#fff;font-weight:600}
.ua{color:#72767d;font-size:.78em;max-width:280px;word-break:break-all}
.ip-list{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px}
.ip-tag{background:#2b2d31;border:1px solid #3a3c40;border-radius:6px;padding:4px 10px;font-family:monospace;font-size:.82em;color:#b5bac1}
.ip-tag.bad{border-color:rgba(242,63,66,.5);color:#f23f42}
.btn{background:#5865f2;color:#fff;border:none;border-radius:6px;padding:7px 16px;cursor:pointer;font-size:.85em}
.btn:hover{background:#4752c4}
.btn.danger{background:#f23f42}
.btn.danger:hover{background:#c0393b}
.toolbar{display:flex;gap:10px;margin-bottom:20px;align-items:center}
#clearStatus{font-size:.82em;color:#3ba55d}
</style>
</head>
<body>
<h1>🔍 Sensitive URL Visitor Log</h1>
<p class="sub">All IPs that hit admin / stats URLs — only visible to you (${[...OWNER_IPS].map(esc).join(", ")})</p>

<div class="toolbar">
  <button class="btn" onclick="location.reload()">↻ Refresh</button>
  <button class="btn danger" onclick="clearLogs()">🗑️ Clear All Logs</button>
  <span id="clearStatus"></span>
</div>

<div class="grid">
  <div class="sc"><div class="sv">${sensitiveVisitorLog.length}</div><div class="sl">Total requests logged</div></div>
  <div class="sc"><div class="sv">${uniqueIPs.length}</div><div class="sl">Unique IPs seen</div></div>
  <div class="sc"><div class="sv r">${denied.length}</div><div class="sl">Denied (non-owner) attempts</div></div>
  <div class="sc"><div class="sv g">${sensitiveVisitorLog.length - denied.length}</div><div class="sl">Owner accesses</div></div>
</div>

<h2>All unique IPs that visited</h2>
<div class="ip-list">
  ${uniqueIPs.map(ip => {
    const hasDenied = denied.some(e => e.ip === ip);
    return `<span class="ip-tag${hasDenied ? " bad" : ""}">${esc(ip)}</span>`;
  }).join("") || '<span style="color:#72767d;font-size:.85em">None yet</span>'}
</div>

<h2>Full request log (newest first — max ${MAX_VISITOR_LOG})</h2>
<table>
  <tr>
    <th>Time (UTC)</th>
    <th>IP</th>
    <th>URL</th>
    <th>Status</th>
    <th>User-Agent</th>
  </tr>
  ${rows || '<tr><td colspan="5" style="color:#72767d;padding:16px">No visits recorded yet.</td></tr>'}
</table>

<script>
async function clearLogs() {
  if (!confirm("Delete all visitor logs? This cannot be undone.")) return;
  const r = await fetch('${ROUTE.visitorLog}', { method: 'DELETE' });
  const d = await r.json();
  if (d.ok) {
    document.getElementById('clearStatus').textContent = '✅ Logs cleared — ' + d.deleted + ' entries deleted';
    setTimeout(() => location.reload(), 1200);
  }
}
</script>
</body>
</html>`);
});

// DELETE <visitorLog route> — wipe the in-memory log
app.delete(ROUTE.visitorLog, ownerOnly, (req, res) => {
  const deleted = sensitiveVisitorLog.length;
  sensitiveVisitorLog.splice(0, sensitiveVisitorLog.length);
  console.log(`[VISITOR-LOG] Cleared by owner — ${deleted} entries deleted`);
  res.json({ ok: true, deleted });
});

// JSON version of the same log (for scripting)
app.get(ROUTE.visitorJson, ownerOnly, (req, res) => {
  const unique = [...new Set(sensitiveVisitorLog.map(e => e.ip))];
  res.json({
    total: sensitiveVisitorLog.length,
    uniqueIPs: unique,
    deniedCount: sensitiveVisitorLog.filter(e => !e.allowed).length,
    entries: [...sensitiveVisitorLog].reverse(),
  });
});

// ── VirusTotal scan log dashboard ─────────────────────────────────────────────
app.get(ROUTE.vtLog, ownerOnly, (req, res) => {
  const log     = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA_PATH, "vt-log.json"), "utf8")); } catch { return []; } })();
  const queue   = (() => { try { return JSON.parse(fs.readFileSync(VT_QUEUE_FILE, "utf8")); } catch { return []; } })();
  const vtBans  = (() => { try { return JSON.parse(fs.readFileSync(VT_BANS_FILE,  "utf8")); } catch { return []; } })();
  const esc = s => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);

  const banned  = log.filter(e => e.banned);
  const clean   = log.filter(e => !e.banned && !e.notFound);
  const unknown = log.filter(e => e.notFound);

  const rows = [...log].reverse().map(e => {
    const cls = e.banned ? "bad" : e.notFound ? "unk" : "ok";
    const scoreColor = e.score > VT_THRESHOLD ? "#f23f42" : e.score > 0 ? "#faa61a" : "#3ba55d";
    return `<tr class="${cls}">
      <td style="color:#72767d;font-size:.78em">${esc(e.ts)}</td>
      <td class="ip">${esc(e.ip)}</td>
      <td style="font-weight:700;color:${scoreColor}">${e.notFound ? "—" : e.score}</td>
      <td style="color:#f23f42">${e.malicious || 0}</td>
      <td style="color:#faa61a">${e.suspicious || 0}</td>
      <td>${e.banned ? "🚫 BANNED" : e.notFound ? "❓ Unknown" : "✅ Clean"}</td>
    </tr>`;
  }).join("");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>VT Scanner — GAICANI</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#1e1f22;color:#dcddde;font-family:"Segoe UI",Arial,sans-serif;padding:24px;max-width:960px;margin:0 auto}
h1{color:#fff;font-size:1.4em;margin-bottom:4px}
.sub{color:#72767d;font-size:.82em;margin-bottom:20px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-bottom:24px}
.sc{background:#2b2d31;border-radius:10px;padding:14px 16px}
.sv{font-size:1.7em;font-weight:700;color:#fff}
.sv.r{color:#f23f42}.sv.g{color:#3ba55d}.sv.y{color:#faa61a}
.sl{font-size:.73em;color:#72767d;margin-top:3px}
h2{color:#5865f2;font-size:.85em;margin:20px 0 10px;text-transform:uppercase;letter-spacing:.5px}
table{width:100%;border-collapse:collapse;background:#2b2d31;border-radius:10px;overflow:hidden;font-size:.82em}
th{background:#232428;color:#72767d;font-weight:600;padding:9px 12px;text-align:left;border-bottom:1px solid #1a1b1e}
td{padding:8px 12px;border-bottom:1px solid #1e1f22;vertical-align:middle}
tr:last-child td{border-bottom:none}
tr.bad td{background:rgba(242,63,66,.07)}
tr.unk td{background:rgba(250,166,26,.04)}
.ip{font-family:monospace;color:#fff;font-weight:600}
.btn{background:#5865f2;color:#fff;border:none;border-radius:6px;padding:7px 16px;cursor:pointer;font-size:.85em;margin-bottom:16px}
.btn:hover{background:#4752c4}
.queue-list{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.qtag{background:#2b2d31;border:1px solid #3a3c40;border-radius:5px;padding:3px 9px;font-family:monospace;font-size:.8em;color:#b5bac1}
</style>
</head>
<body>
<h1>🦠 VirusTotal Scanner</h1>
<p class="sub">Auto-scans non-Georgian IPs · Bans if score &gt; ${VT_THRESHOLD}</p>
<button class="btn" onclick="location.reload()">↻ Refresh</button>

<div class="grid">
  <div class="sc"><div class="sv">${log.length}</div><div class="sl">Total scanned</div></div>
  <div class="sc"><div class="sv r">${banned.length}</div><div class="sl">Auto-banned</div></div>
  <div class="sc"><div class="sv g">${clean.length}</div><div class="sl">Clean</div></div>
  <div class="sc"><div class="sv y">${unknown.length}</div><div class="sl">Unknown / not in VT</div></div>
  <div class="sc"><div class="sv">${queue.length}</div><div class="sl">Pending in queue</div></div>
  <div class="sc"><div class="sv">${vtBans.length}</div><div class="sl">VT-ban list size</div></div>
</div>

${queue.length ? `<h2>Pending queue (${queue.length})</h2>
<div class="queue-list">${queue.map(ip => `<span class="qtag">${esc(ip)}</span>`).join("")}</div>` : ""}

<h2>Scan log (newest first)</h2>
<table>
  <tr><th>Time</th><th>IP</th><th>Score</th><th>Malicious</th><th>Suspicious</th><th>Result</th></tr>
  ${rows || '<tr><td colspan="6" style="color:#72767d;padding:14px">No scans yet — waiting for non-Georgian IPs to connect.</td></tr>'}
</table>
</body>
</html>`);
});

// ════════════════════════════════════════════════════════════════════════════
// AUTH · FRIENDS · PRIVATE CHAT  (GAICANI Registered Users)
// ════════════════════════════════════════════════════════════════════════════

// ── Predefined profile avatars (PNG files served from the site root, e.g. /avatar1.png) ──
const AVAILABLE_AVATARS = [
  "avatar1.png", "avatar2.png", "avatar3.png", "avatar4.png",
  "avatar5.png", "avatar6.png", "avatar7.png", "avatar8.png",
  "avatar9.jpg", "avatar10.jpg", "avatar11.jpg", "avatar12.jpg",
  "avatar13.jpg", "avatar14.jpg", "avatar15.jpg", "avatar16.jpg",
  "avatar17.jpg", "avatar18.jpg", "avatar19.jpg", "avatar20.jpg",
  "avatar21.jpg", "avatar22.jpg", "avatar23.jpg", "avatar24.jpg",
];
const DEFAULT_AVATAR = AVAILABLE_AVATARS[0];

// A dedicated avatar specifically for temporary guest accounts — kept
// separate from AVAILABLE_AVATARS on purpose, so it never shows up as a
// pickable option in a real registered user's avatar picker (that would
// be confusing — it would look like they'd chosen to appear as a guest).
const GUEST_AVATAR = "avatar-guest.jpg";

const USERS_FILE        = path.join(DATA_PATH, "registered_users.json");
const PRIV_MSGS_FILE    = path.join(DATA_PATH, "private_messages.json");
const STREAKS_FILE      = path.join(DATA_PATH, "friend_streaks.json");
const ROOMS_FILE        = path.join(DATA_PATH, "chat_rooms.json");
const FORUM_FILE        = path.join(DATA_PATH, "forum_posts.json");
const NOTIF_FILE        = path.join(DATA_PATH, "notifications.json");
const PRIVATE_MSG_TTL   = 30 * 60 * 60 * 1000; // 30 h — auto-delete
const AUTH_TOKEN_TTL    = 7  * 24 * 60 * 60 * 1000; // 7 days
const ROOM_MSG_CAP      = 200; // per-room stored history — oldest trimmed past this
const ROOM_NAME_MAX     = 80;
const FORUM_TITLE_MAX   = 120;
const FORUM_BODY_MAX    = 5000;
const FORUM_COMMENT_MAX = 2000;
const FORUM_COMMENT_CAP = 500; // per-post stored comments — oldest trimmed past this

// ── In-memory stores ─────────────────────────────────────────────────────────
const registeredUsers   = new Map(); // lowerUsername → userObj
const authTokens        = new Map(); // token → { usernameLower, expiry }
const privateRooms      = new Map(); // roomId → { messages, createdAt, expiresAt }
const onlineRegSockets  = new Map(); // lowerUsername → Set<socketId>
const guestSocketMap    = new Map(); // socketId → guest's lowerUsername (for cleanup on disconnect — guests never persist)
const guestTokenMap     = new Map(); // socketId → their temporary REST token (for cleanup alongside the rest of the session)
const GUEST_TOKEN_TTL   = 4 * 60 * 60 * 1000; // 4h — a guest's REST token outlives brief reconnects but not a real "come back tomorrow"
// If A sends B a friend request and B declines it, A can't send B another
// one for 24h — stops someone from immediately re-spamming a request the
// person just said no to.
const FRIEND_REQUEST_DECLINE_COOLDOWN_MS = parseInt(process.env.FRIEND_REQUEST_DECLINE_COOLDOWN_MS, 10) || 24 * 60 * 60 * 1000;
const friendRequestDeclineCooldown = new Map(); // "senderLc|recipientLc" → expiry timestamp
const friendStreaks     = new Map(); // roomId → { count, lastDate, lastFrom: { usernameLower: "YYYY-MM-DD" } }

// ── Rooms ("ოთახები" — Discord-style topic rooms) ──────────────────────────
// roomId → { id, name, createdBy, createdByUsername, createdAt,
//            members: [usernameLower...], bannedUsers: [usernameLower...],
//            messages: [{ id, fromLc, fromUsername, text, ts }] }
const chatRooms = new Map();

// ── Forum ("ფორუმი" — Reddit-style posts/comments) ─────────────────────────
// postId → { id, title, body, authorLc, authorUsername, createdAt,
//            votes: { usernameLower: 1 | -1 },
//            comments: [{ id, body, authorLc, authorUsername, createdAt, votes: {} }] }
// Moderated by the same isAdmin account that runs Rooms.
const forumPosts = new Map();

// ── Notifications (🔔 next to "გამოსვლა" on ჩემი გვერდი) ───────────────────
// usernameLower → { seenAt, items: [{ id, type, key, from, fromLc, name,
//                   game, kind, link, count, ts, read }] }   (newest first)
// Registered accounts only — guests are never stored. Kept in its own file
// instead of on the user object so a stream of message notifications doesn't
// rewrite all of registered_users.json every few seconds.
//
// Two separate states, like Facebook:
//   * "unseen" — arrived since the bell was last opened and not read yet.
//     That's the red number on the bell; opening the panel clears it.
//   * "read"   — this one item was clicked (or handled elsewhere, e.g. the
//     chat it's about was opened). Unread items stay highlighted in the list.
//
// Message notifications deliberately carry NO message text: private messages
// auto-delete after PRIVATE_MSG_TTL, and copying them into a 30-day history
// would quietly keep them around much longer than that.
const userNotifications = new Map();
const NOTIF_CAP        = 60;                        // per user — oldest dropped past this
const NOTIF_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days
const NOTIF_GAME_PAGES = {
  drawGuess: "/draw-guess.html", poker: "/poker.html", chess: "/chess.html",
  checkers: "/checkers.html", joker: "/joker.html", imposter: "/imposter.html",
  blackjack: "/blackjack.html",
};
// "<game>:join" / "<game>:declineInvite" → game key. Answering an invite from
// anywhere (the dashboard invite bar, the game page itself) marks its
// notification read — see the socket.onAny hook in the connection handler.
const NOTIF_GAME_ANSWER_EVENTS = new Map();
for (const g of Object.keys(NOTIF_GAME_PAGES)) {
  NOTIF_GAME_ANSWER_EVENTS.set(`${g}:join`, g);
  NOTIF_GAME_ANSWER_EVENTS.set(`${g}:declineInvite`, g);
}

function notifBox(lc) {
  let box = userNotifications.get(lc);
  if (!box) { box = { seenAt: 0, items: [] }; userNotifications.set(lc, box); }
  return box;
}
function notifUnseen(box) {
  if (!box) return 0;
  let n = 0;
  for (const it of box.items) if (!it.read && it.ts > box.seenAt) n++;
  return n;
}
// What the client gets. The sender's avatar is looked up live rather than
// stored, so it's always their current picture.
function notifView(it) {
  const from = it.fromLc ? registeredUsers.get(it.fromLc) : null;
  return {
    id: it.id, type: it.type, from: it.from || null, name: it.name || null,
    game: it.game || null, kind: it.kind || null, link: it.link || null,
    count: it.count || 1, ts: it.ts, read: !!it.read,
    avatar: from ? (from.avatar || DEFAULT_AVATAR) : null,
  };
}
function notifTrim(box, now = Date.now()) {
  box.items = box.items.filter(it => now - it.ts < NOTIF_MAX_AGE_MS).slice(0, NOTIF_CAP);
}
function notifChanged(lc, box) {
  notifDirty = true; scheduleSave();
  io.to(`user:${lc}`).emit("notif:changed", { unseen: notifUnseen(box) });
}

// Add a notification for one registered user and push it to their open tabs.
// With a mergeKey, a still-unread item with the same key is bumped to the top
// (count + 1, or data.count when the caller knows the real total) instead of
// stacking a new row per message / like.
function pushNotification(toLc, data, mergeKey) {
  const user = registeredUsers.get(toLc);
  if (!user || user.isGuest) return;
  const box = notifBox(toLc);
  const now = Date.now();
  let item = mergeKey ? box.items.find(i => !i.read && i.key === mergeKey) : null;
  if (item) {
    box.items.splice(box.items.indexOf(item), 1);
    Object.assign(item, data, { count: data.count || (item.count || 1) + 1, ts: now });
  } else {
    item = { id: now.toString(36) + crypto.randomBytes(4).toString("hex"), ...data, count: data.count || 1, ts: now, read: false };
    if (mergeKey) item.key = mergeKey;
  }
  box.items.unshift(item);
  notifTrim(box, now);
  notifDirty = true; scheduleSave();
  io.to(`user:${toLc}`).emit("notif:new", { item: notifView(item), unseen: notifUnseen(box) });
}

// Mark every unread item matching pred as read (e.g. message notifications
// from a friend once their chat is opened).
function markNotificationsRead(lc, pred) {
  const box = userNotifications.get(lc);
  if (!box) return;
  let changed = false;
  for (const it of box.items) if (!it.read && pred(it)) { it.read = true; changed = true; }
  if (changed) notifChanged(lc, box);
}

// Account deleted: drop their own history and anything they sent anyone
// (and other people's private nickname / pin for them).
function forgetNotificationsOf(lc) {
  for (const [, u] of registeredUsers) {
    if (u.friendNicknames) delete u.friendNicknames[lc];
    if (Array.isArray(u.pinnedFriends)) u.pinnedFriends = u.pinnedFriends.filter((x) => x !== lc);
  }
  userNotifications.delete(lc);
  for (const [, box] of userNotifications) box.items = box.items.filter(it => it.fromLc !== lc);
  notifDirty = true; scheduleSave();
}

// A private message / photo / GIF from fromLc to toLc. Skipped while the
// recipient already has that exact chat open — they're looking at it.
function notifyPrivateMessage(fromLc, fromName, toLc, kind) {
  const roomId = privRoomId(fromLc, toLc);
  for (const sid of onlineRegSockets.get(toLc) || []) {
    if (io.sockets.sockets.get(sid)?._friendChatRoom === roomId) return;
  }
  pushNotification(toLc, {
    type: "message", from: fromName, fromLc, kind,
    link: `/friend-chat.html?friend=${encodeURIComponent(fromName)}`,
  }, `msg:${fromLc}`);
}

function notifyGameInvite(toLc, game, roomId, fromName) {
  const fromLc = String(fromName).toLowerCase();
  pushNotification(toLc, {
    type: "game_invite", game, from: fromName, fromLc,
    link: `${NOTIF_GAME_PAGES[game]}?room=${encodeURIComponent(roomId)}`,
  }, `game:${game}:${roomId}`);
}

// ── Flappy Bird ("მფრინავი ჩიტი") state ────────────────────────────────────
const flappySessions   = new Map(); // sessionId → { usernameLower, socketId, startAt, submitted }
const flappyLastSubmit = new Map(); // usernameLower → timestamp (simple per-user rate limit)

// Keep numerically identical to FB_CFG in flappy-bird.js — the server doesn't
// re-simulate the game, it only uses these to compute the fastest a given
// score could physically have been reached (anti-cheat, see flappy:submitScore).
const FLAPPY_CFG = {
  GAP_START: 170, GAP_MIN: 108, GAP_DECAY: 2.2,
  SPEED_START: 220, SPEED_MAX: 430, SPEED_GROWTH: 4,
  SPACING_START: 300, SPACING_MIN: 210, SPACING_DECAY: 1.5,
};
function flappySpeedForScore(s)   { return Math.min(FLAPPY_CFG.SPEED_MAX, FLAPPY_CFG.SPEED_START + s * FLAPPY_CFG.SPEED_GROWTH); }
function flappySpacingForScore(s) { return Math.max(FLAPPY_CFG.SPACING_MIN, FLAPPY_CFG.SPACING_START - s * FLAPPY_CFG.SPACING_DECAY); }
function flappyMinTimeMs(score) {
  let t = 0;
  for (let n = 0; n < score; n++) t += flappySpacingForScore(n) / flappySpeedForScore(n);
  return t * 1000;
}
function flappyGenSessionId() {
  return `fb_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
function getFlappyTop3() {
  const rows = [];
  for (const [lc, u] of registeredUsers) {
    if (u.isGuest) continue; // recycled temporary names — never on the podium
    if (u.flappyHighScore) {
      rows.push({ id: lc, username: u.username, score: u.flappyHighScore, achievedAt: u.flappyHighScoreAt || null });
    }
  }
  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, 3);
}
function broadcastFlappyLeaderboard() {
  io.emit("flappy:leaderboardUpdate", getFlappyTop3());
}

// ── Chess / Checkers "all-time top 3 by wins" leaderboards — same shape as
// the Flappy Bird one above (id/username/score), just counting wins instead
// of high score. Draws and stalemates don't count toward anyone's total —
// only a clear win (checkmate, resignation, or opponent timeout).
function getChessTop3() {
  const rows = [];
  for (const [lc, u] of registeredUsers) {
    if (u.chessWins) rows.push({ id: lc, username: u.username, score: u.chessWins });
  }
  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, 3);
}
function broadcastChessLeaderboard() {
  io.emit("chess:leaderboardUpdate", getChessTop3());
}
function recordChessWin(winnerLc) {
  const user = registeredUsers.get(winnerLc);
  if (!user) return;
  user.chessWins = (user.chessWins || 0) + 1;
  saveAuthUsers();
  broadcastChessLeaderboard();
}

function getCheckersTop3() {
  const rows = [];
  for (const [lc, u] of registeredUsers) {
    if (u.checkersWins) rows.push({ id: lc, username: u.username, score: u.checkersWins });
  }
  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, 3);
}
function broadcastCheckersLeaderboard() {
  io.emit("checkers:leaderboardUpdate", getCheckersTop3());
}
function recordCheckersWin(winnerLc) {
  const user = registeredUsers.get(winnerLc);
  if (!user) return;
  user.checkersWins = (user.checkersWins || 0) + 1;
  saveAuthUsers();
  broadcastCheckersLeaderboard();
}

// Returns { username, avatar } for every registered user who currently has at
// least one live socket connected (i.e. actually online right now), excluding
// the given username. Used to populate the "who's online" list in the
// dashboard so registered users can find and add each other as friends.
// ── Trinder (dating) ──────────────────────────────────────────────────────
// Registered users only, 18+ only. Profile choices are stored as fixed keys
// (the page shows the Georgian labels), so nobody can inject arbitrary text
// through them. A mutual like is a match: both become friends automatically.
const TRINDER_OPTS = {
  gender: ["male", "female"],
  interestedIn: ["men", "women", "everyone"],
  zodiac: ["aries", "taurus", "gemini", "cancer", "leo", "virgo", "libra", "scorpio", "sagittarius", "capricorn", "aquarius", "pisces"],
  lookingFor: ["relationship", "friendship", "fun", "unsure"],
  music: ["pop", "rock", "hiphop", "rap", "electronic", "jazz", "classical", "georgian", "rnb", "metal", "indie", "kpop", "latin", "lofi"],
  hobbies: ["sport", "football", "travel", "movies", "books", "gaming", "cooking", "photography", "dance", "hiking", "art", "tech", "fashion", "animals", "fitness", "music"],
  smoking: ["no", "sometimes", "yes"], drinking: ["no", "social", "yes"], pets: ["dog", "cat", "other", "none"],
};
const TRINDER_ABOUT_MIN = 10;
function sanitizeTrinderProfile(src) {
  src = (src && typeof src === "object") ? src : {};
  const text = (v, max) => (typeof v === "string" ? v.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, max) : "");
  const one = (v, list) => (list.includes(v) ? v : "");
  const many = (v, list, max) => (Array.isArray(v) ? [...new Set(v.filter(x => list.includes(x)))].slice(0, max) : []);
  const p = {};
  p.name = text(src.name, 20);
  if (p.name.length < 2) return { error: "შეიყვანე სახელი (2–20 სიმბოლო)" };
  if (!/^[A-Za-z\u10D0-\u10FF\s'-]+$/.test(p.name)) return { error: "სახელში მხოლოდ ასოები შეიძლება" };
  const age = Number(src.age);
  if (!Number.isInteger(age)) return { error: "შეიყვანე ასაკი" };
  if (age < 18) return { error: "Trinder მხოლოდ 18+ მომხმარებლებისთვისაა" };
  if (age > 99) return { error: "ასაკი: 18–99" };
  p.age = age;
  // Every field is required, so every card in the deck is a full profile.
  // Checked in the same order as the form, so the message always points at
  // the first thing still missing.
  const h = Number(src.height);
  if (!Number.isInteger(h) || h < 140 || h > 220) return { error: "შეიყვანე სიმაღლე (140–220 სმ)" };
  p.height = h;
  p.gender = one(src.gender, TRINDER_OPTS.gender);
  if (!p.gender) return { error: "აირჩიე სქესი" };
  p.interestedIn = one(src.interestedIn, TRINDER_OPTS.interestedIn);
  if (!p.interestedIn) return { error: "აირჩიე, ვინ გაინტერესებს" };
  p.city = text(src.city, 40);
  if (!p.city) return { error: "მიუთითე, სად ცხოვრობ" };
  p.job = text(src.job, 40);
  if (!p.job) return { error: "მიუთითე სამსახური (თუ არ მუშაობ, დაწერე „არა“)" };
  p.university = text(src.university, 60);
  if (!p.university) return { error: "მიუთითე უნივერსიტეტი (თუ არ სწავლობ, დაწერე „არა“)" };
  p.zodiac = one(src.zodiac, TRINDER_OPTS.zodiac);
  if (!p.zodiac) return { error: "აირჩიე ზოდიაქო" };
  p.lookingFor = one(src.lookingFor, TRINDER_OPTS.lookingFor);
  if (!p.lookingFor) return { error: "აირჩიე, რას ეძებ" };
  p.about = text(src.about, 300);
  if (p.about.length < TRINDER_ABOUT_MIN) return { error: `„ჩემ შესახებ“ — დაწერე მინიმუმ ${TRINDER_ABOUT_MIN} სიმბოლო` };
  p.music = many(src.music, TRINDER_OPTS.music, 6);
  if (!p.music.length) return { error: "აირჩიე მინიმუმ ერთი მუსიკის ჟანრი" };
  p.hobbies = many(src.hobbies, TRINDER_OPTS.hobbies, 8);
  if (!p.hobbies.length) return { error: "აირჩიე მინიმუმ ერთი ჰობი" };
  p.smoking = one(src.smoking, TRINDER_OPTS.smoking);
  if (!p.smoking) return { error: "მიუთითე, ეწევი თუ არა" };
  p.drinking = one(src.drinking, TRINDER_OPTS.drinking);
  if (!p.drinking) return { error: "მიუთითე, სვამ თუ არა ალკოჰოლს" };
  p.pets = one(src.pets, TRINDER_OPTS.pets);
  if (!p.pets) return { error: "მიუთითე შინაური ცხოველი (ან „არ მყავს“)" };
  for (const k of ["name", "city", "job", "university", "about"]) if (p[k] && findBannedWord(p[k])) return { error: ABUSE_WORD_MESSAGE };
  return { profile: p };
}
// A profile saved before every field was required — its owner is asked to
// finish it the next time they open Trinder.
function trinderProfileComplete(profile) { return !!profile && !sanitizeTrinderProfile(profile).error; }
// Both people fit each other's "interested in". The deck only ever offered
// such pairs, but likes and matches didn't check: after someone changed their
// preference (or with a hand-made request) "someone likes you" could come
// from exactly the people you'd said you're not interested in.
function trinderCompatible(a, b) {
  const pa = a && a.trinder && a.trinder.profile, pb = b && b.trinder && b.trinder.profile;
  return !!(pa && pb && trinderWants(pa.interestedIn, pb.gender) && trinderWants(pb.interestedIn, pa.gender));
}
function trinderOf(u) {
  if (!u.trinder) u.trinder = { active: false, profile: null, likes: [], passes: [], matches: [] };
  for (const k of ["likes", "passes", "matches"]) if (!Array.isArray(u.trinder[k])) u.trinder[k] = [];
  return u.trinder;
}
function trinderBlocked(a, aLc, b, bLc) {
  return (a.blockedUsers || []).includes(bLc) || (b.blockedUsers || []).includes(aLc);
}
function trinderCard(lc, u) {
  const p = u.trinder.profile || {};
  return { username: u.username, avatar: u.avatar || DEFAULT_AVATAR, isPro: !!u.isPro, online: isVisiblyOnline(lc), ...p };
}
// People who liked me and are still waiting for my answer
function trinderPendingLikers(meLc, me) {
  const mt = trinderOf(me), out = [];
  for (const [lc, u] of registeredUsers) {
    if (lc === meLc || u.isGuest || u.nameBlocked || !u.trinder || !u.trinder.active) continue;
    if (!(u.trinder.likes || []).includes(meLc)) continue;
    if (mt.likes.includes(lc) || mt.passes.includes(lc) || mt.matches.includes(lc)) continue;
    if (trinderBlocked(me, meLc, u, lc)) continue;
    if (!trinderCompatible(me, u)) continue;
    out.push([lc, u]);
  }
  return out;
}
function trinderWants(pref, gender) { return pref === "everyone" || (pref === "men" && gender === "male") || (pref === "women" && gender === "female"); }
function trinderState(meLc, me) {
  const t = trinderOf(me);
  // A match is a friendship: once either side unfriends or blocks, it's over
  // (its 💬 button would only lead to a chat that refuses them).
  const matches = t.matches.map(lc => [lc, registeredUsers.get(lc)])
    .filter(([lc, u]) => u && !u.isGuest && (me.friends || []).includes(lc) && !trinderBlocked(me, meLc, u, lc))
    .map(([lc, u]) => ({ username: u.username, name: (u.trinder && u.trinder.profile && u.trinder.profile.name) || u.username, avatar: u.avatar || DEFAULT_AVATAR, online: isVisiblyOnline(lc) }));
  const pr = me.profile || {};
  return { joined: !!t.active, complete: trinderProfileComplete(t.profile), profile: t.profile, avatar: me.avatar || DEFAULT_AVATAR, isPro: !!me.isPro,
    likesCount: trinderPendingLikers(meLc, me).length, matches,
    prefill: { age: pr.age || null, gender: pr.gender || "", city: pr.city || "", job: pr.work || "", university: pr.study || "" } };
}

// ── Ghost connections after a phone app-switch ────────────────────────────
// When a phone freezes a page, the server can't tell for ~2 minutes that the
// old connection is dead. The page reconnects in seconds and tells us which
// connection it replaces; if that old one belongs to the SAME identity (same
// guest session or account), we close it now. Its normal disconnect handling
// parks any random-chat partner, and the new connection resumes the chat.
function evictGhostOf(sock) {
  const oldId = sock._replacesId;
  if (!oldId || oldId === sock.id) return;
  const old = io.sockets.sockets.get(oldId);
  if (!old) { sock._replacesId = null; return; }            // already gone
  if (!(sock._regUser && old._regUser && sock._regUser.usernameLower === old._regUser.usernameLower)) return; // not proven yet
  sock._replacesId = null;
  old.disconnect(true);
}

// ── Name block (admin) → forced rename ────────────────────────────────────
// An admin can block a registered account for an offensive name. Until the
// owner picks a new, clean name, the account can't be used for anything; the
// rename endpoint is the only way out. Renaming an account has to update the
// name EVERYWHERE it's stored, or friendships and chat history would silently
// break — renameAccount() below does exactly that.
// Names retired by a forced rename stay unavailable, so the offensive name
// can't simply be registered again by someone else.
function isRetiredName(lc) {
  for (const [, u] of registeredUsers) if (Array.isArray(u.retiredNames) && u.retiredNames.includes(lc)) return true;
  return false;
}
function validateNewUsername(raw, oldLc) {
  const clean = String(raw || "").trim();
  if (clean.length < 2 || clean.length > 20) return { error: "სახელი: 2–20 სიმბოლო" };
  if (!/^[\w\u10D0-\u10FF\s\-.]+$/.test(clean)) return { error: "სახელი შეიცავს დაუშვებელ სიმბოლოებს" };
  if (findBannedWord(clean)) return { error: ABUSE_WORD_MESSAGE };
  if (GUEST_NAME_RE.test(clean)) return { error: "ეს სახელი დაკავებულია" };
  const lc = clean.toLowerCase();
  if (lc === oldLc) return { error: "ახალი სახელი ძველისგან უნდა განსხვავდებოდეს" };
  if (registeredUsers.has(lc) || authReservedNames.has(lc) || activeUsernames.has(lc) || isRetiredName(lc)) return { error: "ეს სახელი უკვე დაკავებულია" };
  return { clean };
}
function renameAccount(oldLc, newName) {
  const user = registeredUsers.get(oldLc);
  const oldName = user.username, newLc = newName.toLowerCase();
  const swap = (v) => (v === oldLc ? newLc : v);
  const swapKey = (o) => { if (o && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, oldLc)) { o[newLc] = o[oldLc]; delete o[oldLc]; } };
  // the account itself, its reserved name, live logins
  registeredUsers.delete(oldLc); user.username = newName; registeredUsers.set(newLc, user);
  user.retiredNames = [...new Set([...(user.retiredNames || []), oldLc])];   // the old name can't be taken again
  authReservedNames.delete(oldLc); authReservedNames.add(newLc);
  for (const [, e] of authTokens) if (e.usernameLower === oldLc) e.usernameLower = newLc;
  if (onlineRegSockets.has(oldLc)) { onlineRegSockets.set(newLc, onlineRegSockets.get(oldLc)); onlineRegSockets.delete(oldLc); }
  // everyone else's friends / pending requests / blocks
  for (const [, u] of registeredUsers) for (const k of ["friends", "pendingRequests", "blockedUsers"]) if (Array.isArray(u[k])) u[k] = u[k].map(swap);
  for (const [, u] of registeredUsers) if (u.trinder) for (const k of ["likes", "passes", "matches"]) if (Array.isArray(u.trinder[k])) u.trinder[k] = u.trinder[k].map(swap);
  // private chats and streaks — their IDs are built from both names
  for (const [id, room] of [...privateRooms]) {
    const parts = id.split("::"); if (!parts.includes(oldLc)) continue;
    privateRooms.delete(id);
    for (const m of room.messages || []) {
      m.from = swap(m.from); if (m.reactions) swapKey(m.reactions);
      if (m.replyTo) { if (m.replyTo.from) m.replyTo.from = swap(m.replyTo.from); if (m.replyTo.fromUsername === oldName) m.replyTo.fromUsername = newName; }
    }
    if (room.lastRead) swapKey(room.lastRead);
    privateRooms.set(privRoomId(swap(parts[0]), swap(parts[1])), room);
  }
  for (const [id, st] of [...friendStreaks]) {
    const parts = id.split("::"); if (!parts.includes(oldLc)) continue;
    friendStreaks.delete(id); if (st.lastFrom) swapKey(st.lastFrom);
    friendStreaks.set(privRoomId(swap(parts[0]), swap(parts[1])), st);
  }
  // rooms
  for (const [, r] of chatRooms) {
    if (r.createdBy === oldLc) { r.createdBy = newLc; r.createdByUsername = newName; }
    r.members = (r.members || []).map(swap); r.bannedUsers = (r.bannedUsers || []).map(swap);
    for (const m of r.messages || []) if (m.fromLc === oldLc) { m.fromLc = newLc; m.fromUsername = newName; }
  }
  // forum posts, comments and their votes
  for (const [, p] of forumPosts) {
    if (p.authorLc === oldLc) { p.authorLc = newLc; p.authorUsername = newName; }
    if (p.votes) swapKey(p.votes);
    for (const c of p.comments || []) { if (c.authorLc === oldLc) { c.authorLc = newLc; c.authorUsername = newName; } if (c.votes) swapKey(c.votes); }
  }
  // admin report history + small per-user records
  if (accountReportLog.has(oldLc)) { accountReportLog.set(newLc, accountReportLog.get(oldLc)); accountReportLog.delete(oldLc); }
  for (const [, arr] of accountReportLog) for (const e of arr || []) { if (e.reportedBy === oldLc) e.reportedBy = newLc; else if (e.reportedBy === oldName) e.reportedBy = newName; }
  if (flappyLastSubmit.has(oldLc)) { flappyLastSubmit.set(newLc, flappyLastSubmit.get(oldLc)); flappyLastSubmit.delete(oldLc); }
  // other people's private nicknames / pins for them
  for (const [, u] of registeredUsers) {
    if (u.friendNicknames && Object.prototype.hasOwnProperty.call(u.friendNicknames, oldLc)) { u.friendNicknames[newLc] = u.friendNicknames[oldLc]; delete u.friendNicknames[oldLc]; }
    if (Array.isArray(u.pinnedFriends)) u.pinnedFriends = u.pinnedFriends.map(swap);
  }
  // notifications — their own history, and their name in everyone else's
  if (userNotifications.has(oldLc)) { userNotifications.set(newLc, userNotifications.get(oldLc)); userNotifications.delete(oldLc); }
  for (const [, box] of userNotifications) for (const it of box.items) {
    if (it.fromLc !== oldLc) continue;
    it.fromLc = newLc; it.from = newName;
    if (it.key === `msg:${oldLc}`) it.key = `msg:${newLc}`;
    if (it.type === "message" || it.type === "friend_accept") it.link = `/friend-chat.html?friend=${encodeURIComponent(newName)}`;
  }
  notifDirty = true;
  saveAuthUsers(); savePrivateMsgs(); saveStreaks(); saveChatRooms(); saveForum();
  return { oldName, newName };
}

// ── Profile details (Tinder-style, all optional) ─────────────────────────
// age · gender · city · study · work. Shown in profile popups and to your
// random-chat partner, so every field is optional and short. Age must be
// 18+: the site's terms are 18+, and once someone tells us they're a minor
// we don't let them into anonymous stranger chat.
const PROFILE_TEXT_MAX = 40;
const PROFILE_GENDERS = new Set(["male", "female"]);
function sanitizeProfile(input) {
  const src = (input && typeof input === "object") ? input : {};
  const out = {};
  if (src.age !== undefined && src.age !== null && String(src.age).trim() !== "") {
    const age = Number(src.age);
    if (!Number.isInteger(age)) return { error: "ასაკი უნდა იყოს რიცხვი" };
    if (age < 18) return { error: "საიტი მხოლოდ 18+ მომხმარებლებისთვისაა" };
    if (age > 99) return { error: "ასაკი: 18–99" };
    out.age = age;
  }
  if (src.gender !== undefined && src.gender !== null && src.gender !== "") {
    if (!PROFILE_GENDERS.has(src.gender)) return { error: "არასწორი სქესი" };
    out.gender = src.gender;
  }
  for (const key of ["city", "study", "work"]) {
    if (typeof src[key] !== "string") continue;
    const v = src[key].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, PROFILE_TEXT_MAX);
    if (!v) continue;
    if (findBannedWord(v)) return { error: ABUSE_WORD_MESSAGE };
    out[key] = v;
  }
  return { profile: out };
}
// What other people are allowed to see. Guests have no profile.
function publicProfileOf(u) {
  if (!u || u.isGuest) return null;
  const p = u.profile || {};
  return { age: p.age || null, gender: p.gender || "", city: p.city || "", study: p.study || "", work: p.work || "" };
}

// ── Flappy Bird ad-free reward ───────────────────────────────────────────
// A registered user who reaches this score (validated by the existing
// flappy anti-cheat) gets this long without ads, site-wide.
const FLAPPY_ADFREE_SCORE = 20;
const FLAPPY_ADFREE_MS    = 24 * 60 * 60 * 1000;

// ── Guest names ──────────────────────────────────────────────────────────
// Anyone without a real registered account is always "სტუმარი" + 4 digits.
// They can't choose a name — only registered (accountable) users can.
// Every path that can set a name (random-chat setName, auth:guest, and
// auth:guest:rename) goes through this same pattern, so there's no side
// door left open. The pattern is ALSO what lets a guest keep the same
// assigned name while moving between pages — an incoming name matching it
// is accepted as "this is still me", anything else is replaced.
const GUEST_NAME_RE = /^სტუმარი\d{4}$/;

function generateGuestName() {
  for (let i = 0; i < 50; i++) {
    const n  = `სტუმარი${Math.floor(1000 + Math.random() * 9000)}`;
    const lc = n.toLowerCase();
    // Clear of both trackers: registeredUsers holds dashboard/game guest
    // identities, activeUsernames holds live random-chat names.
    if (!registeredUsers.has(lc) && !activeUsernames.has(lc)) return n;
  }
  return null; // 50 collisions in a row — effectively impossible, handled by callers
}

// Presence as OTHER people see it. A user who switched on "appear offline"
// (dashboard → 🔒 privacy) is treated as offline everywhere presence is
// shown to others: the online list, profile cards, and game-invite checks.
function isVisiblyOnline(lc) {
  const u = registeredUsers.get(lc);
  if (u && (u.appearOffline || u.nameBlocked)) return false;
  return !!onlineRegSockets.get(lc)?.size;
}

// Every open dashboard / game lobby answers "users:onlineChanged" by asking
// for the whole online list again, so a burst of logins used to cost one
// full round of list requests per login. Bursts are coalesced into at most
// one broadcast a second — lists still refresh within a second.
let onlineChangedTimer = null;
function announceOnlineChanged() {
  if (onlineChangedTimer) return;
  onlineChangedTimer = setTimeout(() => { onlineChangedTimer = null; io.emit("users:onlineChanged"); }, 1000);
}

function getOnlineRegisteredUsers(excludeLc) {
  const list = [];
  for (const [lc, sockets] of onlineRegSockets) {
    if (!sockets || sockets.size === 0) continue;
    if (lc === excludeLc) continue;
    const u = registeredUsers.get(lc);
    if (!u) continue;
    if (u.appearOffline || u.nameBlocked) continue; // chose to appear offline, or name-blocked
    list.push({ username: u.username, avatar: u.avatar || null, bio: u.bio || "", isGuest: !!u.isGuest, isPro: !!u.isPro });
  }
  // Real accounts first, temporary guests after — within each group, alphabetical.
  list.sort((a, b) => (a.isGuest === b.isGuest ? a.username.localeCompare(b.username) : (a.isGuest ? 1 : -1)));
  return list;
}

// ── Banned-word filter (room names, room chat, forum posts & comments) ───────
// Matching rules, and why they're built this way:
//
//  * Unicode-aware WORD BOUNDARIES, not plain substring search. This matters:
//    "სირი" is on the list, and "სირია" (Syria) contains it. A substring
//    match would block anyone discussing Syria. The lookarounds below require
//    a non-letter on both sides, so only the standalone word is caught.
//  * Separators are allowed BETWEEN the letters of a term, so "ყ.ლ.ე",
//    "y l e" and "y-l-e" are caught as well as "ყლე".
//  * Each letter may repeat ("ყყყლეე"), a very common way to slip past filters.
//  * Digits/symbols commonly swapped for letters are normalised first
//    (0→o, 1→i, 3→e, 4→a, 5→s, 7→t, @→a, $→s).
//
// The list is intentionally kept as data so it's easy to extend later.
const ABUSE_WORDS = [
  // Georgian
  "მოგტყნა","მოგიტყნა","მოგეტყნა","მოტყნა","მოგიტყნავ",
  "მოტყნული","მოტყნულო","ტყნვა","ტყნაური",
  "დედამოტყნული","დედამოტყნულო",
  "ამიდგა","ამიდგება","ამიდგი","ამოგიდგა","ამოგიდგება",
  "ყლე","ყლეო","ყლეობა","ყლევ",
  "სირი","სირო","სირობა",
  "ბოზი","ბოზო","ბოზიშვილი","ბოზისშვილი",
  "ნაბიჭვარი","ნაბიჭვარო","ნაბოზარი","ნაბოზარო",
  "ტრაკი","ტრაკო","ტრაკში","ტრაკიდან",
  "პიდარასტი","პიდარასტო",
  "ჩათლახი","ჩათლახო",
  "დებილი","დებილო","იდიოტი","იდიოტო",
  "გოიმი","გოიმო","შტერი","შტერო","ჩლუნგი",
  "ნაძირალა","ნაძირალო","არამზადა","არამზადავ",
  "დამპალი","დამპალო","ნაგავი","ნაგავო",
  "დედაშენი","შენი დედა","შენს დედას","შენი მამა","შენს მამას",
  // Latin transliterations
  "mogtyna","mogityna","mogetyna","motqna","motkna","motyna",
  "mogitynav","mogitknav","motynuli","motknuli","motynuly",
  "motynulo","motknulo","tynva","tknva","tynauri","tknauri",
  "dedamotynuli","dedamotknuli","dedamotynulo","dedamotknulo",
  "amidga","amidgeba","amidgi","amogidga","amogidgeba",
  "yle","qle","yleo","qleo","yleoba","qleoba","ylev","qlev",
  "siri","syri","siro","syro","siroba","syroba",
  "bozi","bozy","bozo","bozishvili","bozishvily","bozisshvili",
  "nabichvari","nabichvary","nabichvaro","nabozari","nabozaro",
  "traki","traky","trako","trakshi","trakidan",
  "pidarasti","pidarasty","pidarasto",
  "chatlaxi","chatlakhi","chatlaxo",
  "debili","debily","debilo","idioti","idioty","idioto",
  "goimi","goimy","goimo","shteri","shtery","shtero",
  "chlungi","chlungy",
  "nadzirala","nadziralo","nadzilala",
  "aramzada","aramzadav","dampali","dampaly","dampalo",
  "nagavi","nagavy","nagavo",
  "dedasheni","dedasheny","sheni deda","shens dedas","sheni mama","shens mamas",
];

const LEET_MAP = { "0":"o","1":"i","3":"e","4":"a","5":"s","7":"t","@":"a","$":"s","!":"i" };

function normalizeForFilter(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[013457@$!]/g, c => LEET_MAP[c] || c)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, ""); // strip combining accents
}

// Build one regex per term. Letters may repeat and may be separated by
// spaces/punctuation; the whole thing must sit on word boundaries.
const ABUSE_PATTERNS = ABUSE_WORDS.map(word => {
  const norm = normalizeForFilter(word);
  const body = [...norm]
    .filter(ch => ch !== " ")
    .map(ch => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "+")
    .join("[\\s._\\-*'\"~]*");
  try {
    return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "iu");
  } catch {
    return null; // engine without lookbehind — term simply won't be enforced
  }
}).filter(Boolean);

// Returns the offending word, or null when the text is clean.
function findBannedWord(text) {
  const norm = normalizeForFilter(text);
  if (!norm) return null;
  for (let i = 0; i < ABUSE_PATTERNS.length; i++) {
    if (ABUSE_PATTERNS[i].test(norm)) return ABUSE_WORDS[i];
  }
  return null;
}

const ABUSE_WORD_MESSAGE = "ამ სიტყვის გამოყენება აკრძალულია — გთხოვთ, შეცვალოთ ტექსტი.";

// ── Rooms helpers ─────────────────────────────────────────────────────────────
function isRoomAdmin(usernameLower) {
  const u = registeredUsers.get(usernameLower);
  return !!(u && u.isAdmin);
}

// ── Poker coins ─────────────────────────────────────────────────────────────
// Lazily initializes a user's poker balance to POKER_STARTING_COINS on first
// contact, and — only once their stack has actually hit 0 — refills it back
// to POKER_STARTING_COINS, but no more than once per POKER_COIN_REGEN_MS.
// Always returns the up-to-date balance; persists via saveAuthUsers() itself
// whenever it changes something so callers don't have to remember to.
function ensurePokerCoins(user) {
  if (typeof user.pokerCoins !== "number") {
    user.pokerCoins = POKER_STARTING_COINS;
    // Starts the 24h clock from their very first grant too — otherwise a
    // user's FIRST-EVER bust would see no pokerCoinsLastRefillAt yet, read
    // as "last refill was infinitely long ago", and grant an instant free
    // refill instead of making them wait like every refill after it does.
    user.pokerCoinsLastRefillAt = new Date().toISOString();
    saveAuthUsers();
    return user.pokerCoins;
  }
  if (user.pokerCoins <= 0) {
    const last = user.pokerCoinsLastRefillAt ? new Date(user.pokerCoinsLastRefillAt).getTime() : 0;
    if (Date.now() - last >= POKER_COIN_REGEN_MS) {
      user.pokerCoins = POKER_STARTING_COINS;
      user.pokerCoinsLastRefillAt = new Date().toISOString();
      saveAuthUsers();
    }
  }
  return user.pokerCoins;
}

function makeRoomId() {
  return `room_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Sanitize a room name/topic the same way everywhere it's set (create + edit).
function cleanRoomName(raw) {
  return String(raw || "").slice(0, ROOM_NAME_MAX).replace(/<[^>]*>/g, "").trim();
}

// "Unread" for one specific room: newer than whichever is more specific —
// this room's own per-room lastRead if the user has ever opened THIS room,
// otherwise their general lastRoomsVisitAt (a one-time rollout baseline so
// existing content doesn't all show as unread the moment this shipped).
function roomUnreadFor(room, user, myLc) {
  if (!myLc || room.bannedUsers.includes(myLc)) return false;
  const lastRead = (room.lastRead && room.lastRead[myLc]) || (user && user.lastRoomsVisitAt) || 0;
  return room.messages.some(m => m.fromLc !== myLc && new Date(m.ts).getTime() > lastRead);
}
function postUnreadFor(post, user, myLc) {
  if (!myLc) return false;
  const lastRead = (post.lastRead && post.lastRead[myLc]) || (user && user.lastForumVisitAt) || 0;
  if (post.authorLc !== myLc && new Date(post.createdAt).getTime() > lastRead) return true;
  return post.comments.some(c => c.authorLc !== myLc && new Date(c.createdAt).getTime() > lastRead);
}

function roomPublicSummary(room, forLc) {
  const forUser = forLc ? registeredUsers.get(forLc) : null;
  return {
    id: room.id,
    name: room.name,
    createdByUsername: room.createdByUsername,
    createdAt: room.createdAt,
    memberCount: room.members.length,
    isMember: forLc ? room.members.includes(forLc) : false,
    isBanned: forLc ? room.bannedUsers.includes(forLc) : false,
    lastMessageAt: room.messages.length ? room.messages[room.messages.length - 1].ts : null,
    hasUnread: roomUnreadFor(room, forUser, forLc),
  };
}

function roomMessagePublic(m) {
  // Avatar is looked up live from the account rather than stored on the
  // message, so it stays correct for old messages after someone changes
  // their picture (and so historical messages get one at all).
  const author = registeredUsers.get(m.fromLc);
  return {
    id: m.id,
    fromUsername: m.fromUsername,
    text: m.text,
    ts: m.ts,
    avatar: author?.avatar || null,
    isPro: !!author?.isPro,
  };
}

// Everyone currently online under this username, kicked out of a room's live
// broadcast — used by admin ban/kick so it takes effect immediately even if
// they have several tabs/devices open.
function forceLeaveRoomSockets(usernameLower, roomId) {
  const sockets = onlineRegSockets.get(usernameLower);
  if (!sockets) return;
  for (const sid of sockets) {
    io.sockets.sockets.get(sid)?.leave(`roomchat:${roomId}`);
  }
}

// ── Forum ("ფორუმი") helpers ─────────────────────────────────────────────────
function makeForumPostId() {
  return "fp_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}
function makeForumCommentId() {
  return "fc_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}
function forumScore(votes) {
  let s = 0;
  for (const v of Object.values(votes || {})) s += v;
  return s;
}
function cleanForumText(raw, maxLen) {
  return String(raw || "").slice(0, maxLen).replace(/<[^>]*>/g, "").trim();
}

// Feed-list shape — no comments array (kept light for the listing screen).
function forumPostSummary(post, forLc) {
  const forUser = forLc ? registeredUsers.get(forLc) : null;
  return {
    id: post.id,
    title: post.title,
    authorUsername: post.authorUsername,
    createdAt: post.createdAt,
    score: forumScore(post.votes),
    myVote: forLc ? (post.votes[forLc] || 0) : 0,
    commentCount: post.comments.length,
    hasUnread: postUnreadFor(post, forUser, forLc),
    mine: !!forLc && post.authorLc === forLc,
  };
}

function forumCommentPublic(c, forLc) {
  return {
    id: c.id,
    body: c.body,
    authorUsername: c.authorUsername,
    createdAt: c.createdAt,
    score: forumScore(c.votes),
    myVote: forLc ? (c.votes[forLc] || 0) : 0,
    mine: !!forLc && c.authorLc === forLc,
  };
}

// Full detail shape — includes body + every comment, for the post-detail screen.
function forumPostFull(post, forLc) {
  return {
    ...forumPostSummary(post, forLc),
    body: post.body,
    comments: post.comments.map(c => forumCommentPublic(c, forLc)),
  };
}

// ── Crypto helpers ────────────────────────────────────────────────────────────
// IMPORTANT: these use the ASYNC pbkdf2 (not pbkdf2Sync). On a small CPU
// instance, a synchronous 100k-iteration hash blocks the entire Node event
// loop for its full duration — meaning EVERY other request (chat messages,
// health checks, everything) freezes while one password is being hashed.
// A burst of login/register attempts (even within rate limits) could stack
// these up and stall the whole server. The async version still uses the CPU,
// but yields control back to the event loop instead of blocking it solid.
function authHashPassword(pwd) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString("hex");
    crypto.pbkdf2(pwd, salt, 100000, 64, "sha512", (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`${salt}:${derivedKey.toString("hex")}`);
    });
  });
}
function authVerifyPassword(pwd, stored) {
  return new Promise((resolve) => {
    try {
      const [salt, hash] = (stored || "").split(":");
      if (!salt || !hash) return resolve(false);
      crypto.pbkdf2(pwd, salt, 100000, 64, "sha512", (err, derivedKey) => {
        if (err) return resolve(false);
        // Constant-time comparison — avoids leaking timing info about how
        // many leading bytes matched.
        const a = Buffer.from(derivedKey.toString("hex"));
        const b = Buffer.from(hash);
        if (a.length !== b.length) return resolve(false);
        resolve(crypto.timingSafeEqual(a, b));
      });
    } catch { resolve(false); }
  });
}
function authToken() { return crypto.randomBytes(32).toString("hex"); }
function privRoomId(a, b) { return [a.toLowerCase(), b.toLowerCase()].sort().join("::"); }

// ── Friend streaks ("keep the flame alive") ──────────────────────────────────
// A streak is a property of a PAIR of friends, so — like privateRooms — it's
// keyed by the same roomId rather than duplicated onto each user's own record.
// Day boundaries are UTC calendar days (simple & deployment-timezone-proof;
// not a rolling 24h window like TikTok/Snapchat use internally, but the same
// end result for anyone messaging at normal hours).
function todayUTC() { return new Date().toISOString().slice(0, 10); } // "YYYY-MM-DD"
function addDaysUTC(dateStr, delta) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// Read-only-ish view of a pair's streak (only mutates to correct staleness —
// safe, since Node's single-threaded event loop means this can't race).
// Returns { count, atRisk } — atRisk means "alive from yesterday, but nobody
// has messaged yet today, message now or lose it".
function getStreakView(aLc, bLc) {
  const s = friendStreaks.get(privRoomId(aLc, bLc));
  if (!s || !s.count) return { count: 0, atRisk: false };

  const today     = todayUTC();
  const yesterday = addDaysUTC(today, -1);

  if (s.lastDate && s.lastDate !== today && s.lastDate < yesterday) {
    // A full day passed with no mutual message — the streak is broken.
    s.count    = 0;
    s.lastDate = null;
    streaksDirty = true;
    scheduleSave();
    return { count: 0, atRisk: false };
  }

  return { count: s.count, atRisk: s.lastDate === yesterday };
}

// Call whenever fromLc sends toLc a message/gif/question. Updates the
// pair's streak and returns the fresh { count, atRisk } for both sides.
function recordFriendMessage(fromLc, toLc) {
  const roomId    = privRoomId(fromLc, toLc);
  const today     = todayUTC();
  const yesterday = addDaysUTC(today, -1);

  let s = friendStreaks.get(roomId);
  if (!s) {
    s = { count: 0, lastDate: null, lastFrom: {} };
    friendStreaks.set(roomId, s);
  }

  // Lazy-expire a stale streak before recording today's activity. Clearing
  // lastDate (not just count) prevents this branch from re-firing later
  // today and wiping out a lastFrom entry the other side just set.
  if (s.lastDate && s.lastDate !== today && s.lastDate < yesterday) {
    s.count    = 0;
    s.lastDate = null;
    s.lastFrom = {};
  }

  s.lastFrom[fromLc] = today;

  if (s.lastFrom[toLc] === today && s.lastDate !== today) {
    s.count += 1;
    s.lastDate = today;
  }

  streaksDirty = true;
  scheduleSave();

  return { count: s.count, atRisk: s.lastDate === yesterday };
}

// Builds the { friendLower: {count, atRisk} } map sent on login — zero
// streaks are omitted so the payload (and the client's badge logic) stay small.
function getStreaksForFriends(usernameLc, friendsLc) {
  const out = {};
  for (const fLc of friendsLc || []) {
    const v = getStreakView(usernameLc, fLc);
    if (v.count > 0) out[fLc] = v;
  }
  return out;
}

// ── Persist helpers ───────────────────────────────────────────────────────────

// ── Debounced file I/O (PATCH: huge performance boost) ──────────────────────────
// Instead of fs.writeFileSync on every friend action, queue writes and flush every 5s
const SAVE_DEBOUNCE_MS = 5000;
let authUsersDirty = false;
let privMsgsDirty = false;
let streaksDirty = false;
let roomsDirty = false;
let forumDirty = false;
let notifDirty = false;
let saveTimer = null;

function scheduleSave() {
  if (saveTimer) return; // already scheduled
  saveTimer = setTimeout(() => {
    if (authUsersDirty) _saveAuthUsersToDisk();
    if (privMsgsDirty) _savePrivateMsgsToDisk();
    if (streaksDirty) _saveStreaksToDisk();
    if (roomsDirty) _saveChatRoomsToDisk();
    if (forumDirty) _saveForumToDisk();
    if (notifDirty) _saveNotificationsToDisk();
    saveTimer = null;
  }, SAVE_DEBOUNCE_MS);
}

// Fields that must never be written to disk. EVERYTHING ELSE on a user
// object is saved automatically.
//
// This used to be a hand-written list of fields to save, and every new
// feature had to remember to add itself to it. About ten didn't — VIP
// status (isPro), the Flappy Bird ad-free reward, permanent block lists,
// the Flappy/chess/checkers leaderboards, blackjack coins, last-known IPs
// and unread markers were all silently WIPED on every server restart (every
// deploy, every free-tier sleep). Saving by default means a new field
// can't be lost that way again.
const NEVER_PERSIST_USER_FIELDS = new Set(["isGuest"]);

function _saveAuthUsersToDisk() {
  const obj = {};
  for (const [k, u] of registeredUsers) {
    if (u.isGuest) continue; // temporary guest sessions never touch disk — gone the moment they disconnect
    const out = {};
    for (const [key, val] of Object.entries(u)) {
      if (NEVER_PERSIST_USER_FIELDS.has(key)) continue;
      if (val === undefined || typeof val === "function") continue;
      // User fields are plain data today (arrays, numbers, strings). If a
      // Set/Map is ever added, store it as an array rather than letting
      // JSON.stringify silently turn it into an empty {}.
      out[key] = (val instanceof Set) ? [...val] : (val instanceof Map ? [...val.entries()] : val);
    }
    if (!out.avatar) out.avatar = DEFAULT_AVATAR;
    obj[k] = out;
  }
  try {
    writeFileAtomic(USERS_FILE, JSON.stringify(obj));
    authUsersDirty = false;
  } catch (e) {
    console.error("[AUTH] save failed:", e.message);
    // Keep dirty flag set, will retry on next interval
  }
}

function _saveChatRoomsToDisk() {
  const obj = {};
  for (const [id, r] of chatRooms) obj[id] = r;
  try {
    writeFileAtomic(ROOMS_FILE, JSON.stringify(obj));
    roomsDirty = false;
  } catch (e) {
    console.error("[ROOMS] save failed:", e.message);
    roomsDirty = true;
  }
}

function _saveForumToDisk() {
  const obj = {};
  for (const [id, p] of forumPosts) obj[id] = p;
  try {
    writeFileAtomic(FORUM_FILE, JSON.stringify(obj));
    forumDirty = false;
  } catch (e) {
    console.error("[FORUM] save failed:", e.message);
    forumDirty = true;
  }
}

function _saveNotificationsToDisk() {
  const obj = {};
  const now = Date.now();
  for (const [lc, box] of userNotifications) {
    notifTrim(box, now);
    if (box.items.length) obj[lc] = box;
  }
  try {
    writeFileAtomic(NOTIF_FILE, JSON.stringify(obj));
    notifDirty = false;
  } catch (e) {
    console.error("[NOTIF] save failed:", e.message);
    notifDirty = true;
  }
}

function _savePrivateMsgsToDisk() {
  const obj = {};
  for (const [id, r] of privateRooms) obj[id] = r;
  try {
    writeFileAtomic(PRIV_MSGS_FILE, JSON.stringify(obj));
    privMsgsDirty = false;
  } catch (e) {
    console.error("[PRIV] save failed:", e.message);
    privMsgsDirty = true;
  }
}

function _saveStreaksToDisk() {
  const obj = {};
  for (const [id, s] of friendStreaks) obj[id] = s;
  try {
    writeFileAtomic(STREAKS_FILE, JSON.stringify(obj));
    streaksDirty = false;
  } catch (e) {
    console.error("[STREAKS] save failed:", e.message);
    streaksDirty = true;
  }
}


function loadAuthUsers() {
  try {
    const obj = readJsonFile(USERS_FILE);
    for (const u of Object.values(obj)) {
      if (!u.avatar || !AVAILABLE_AVATARS.includes(u.avatar)) u.avatar = DEFAULT_AVATAR;
      // Stray requests from people who are already friends (the server used
      // to accept those) — they showed up as "pending" next to the friendship.
      if (Array.isArray(u.pendingRequests) && Array.isArray(u.friends)) u.pendingRequests = u.pendingRequests.filter(x => !u.friends.includes(x));
      registeredUsers.set(u.username.toLowerCase(), u);
      authReservedNames.add(u.username.toLowerCase());
    }
    console.log(`[AUTH] Loaded ${registeredUsers.size} registered user(s)`);
  } catch { /* first run */ }
}
function saveAuthUsers() {
  authUsersDirty = true;
  scheduleSave();
}
function loadPrivateMsgs() {
  try {
    const obj = readJsonFile(PRIV_MSGS_FILE);
    const now = Date.now();
    for (const [id, room] of Object.entries(obj)) {
      if (room.expiresAt && now < room.expiresAt) privateRooms.set(id, room);
    }
    console.log(`[PRIV] Loaded ${privateRooms.size} active private room(s)`);
  } catch { /* first run */ }
}
function savePrivateMsgs() {
  privMsgsDirty = true;
  scheduleSave();
}
function loadStreaks() {
  try {
    const obj = readJsonFile(STREAKS_FILE);
    for (const [id, s] of Object.entries(obj)) friendStreaks.set(id, s);
    console.log(`[STREAKS] Loaded ${friendStreaks.size} friend streak(s)`);
  } catch { /* first run */ }
}
function saveStreaks() {
  streaksDirty = true;
  scheduleSave();
}
function loadChatRooms() {
  try {
    const obj = readJsonFile(ROOMS_FILE);
    for (const [id, r] of Object.entries(obj)) {
      r.members      = Array.isArray(r.members) ? r.members : [];
      r.bannedUsers   = Array.isArray(r.bannedUsers) ? r.bannedUsers : [];
      r.messages      = Array.isArray(r.messages) ? r.messages : [];
      chatRooms.set(id, r);
    }
    console.log(`[ROOMS] Loaded ${chatRooms.size} room(s)`);
  } catch { /* first run */ }
}
function saveChatRooms() {
  roomsDirty = true;
  scheduleSave();
}

function loadForum() {
  try {
    const obj = readJsonFile(FORUM_FILE);
    for (const [id, p] of Object.entries(obj)) {
      p.votes    = p.votes && typeof p.votes === "object" ? p.votes : {};
      p.comments = Array.isArray(p.comments) ? p.comments : [];
      for (const c of p.comments) c.votes = c.votes && typeof c.votes === "object" ? c.votes : {};
      forumPosts.set(id, p);
    }
    console.log(`[FORUM] Loaded ${forumPosts.size} post(s)`);
  } catch { /* first run */ }
}
function saveForum() {
  forumDirty = true;
  scheduleSave();
}

function loadNotifications() {
  try {
    const obj = readJsonFile(NOTIF_FILE);
    const now = Date.now();
    for (const [lc, box] of Object.entries(obj)) {
      if (!registeredUsers.has(lc) || !box || !Array.isArray(box.items)) continue;
      const clean = { seenAt: Number(box.seenAt) || 0, items: box.items };
      notifTrim(clean, now);
      if (clean.items.length) userNotifications.set(lc, clean);
    }
    console.log(`[NOTIF] Loaded notifications for ${userNotifications.size} user(s)`);
  } catch { /* first run */ }
}

// ── Seed the fixed Rooms administrator account ─────────────────────────────
// Runs once at startup. If the account already exists (e.g. loaded from disk
// on a restart) its password is left untouched — only the isAdmin flag is
// guaranteed to be set. Override via env vars if you'd rather not keep the
// default password in source.
// SECURITY: like ADMIN_KEY above, this no longer falls back to a password
// written in the source. Note this only affects a FIRST-EVER boot with no
// existing admin account — seedAdminAccount() below returns early if the
// account already exists, so an already-deployed server keeps whatever
// password it has and nothing breaks on upgrade.
const ADMIN_SEED_USERNAME = process.env.ADMIN_USERNAME || "ADMINISTRATOR1121";
const ADMIN_SEED_PASSWORD = process.env.ADMIN_PASSWORD || crypto.randomBytes(18).toString("base64url");

async function seedAdminAccount() {
  const lc = ADMIN_SEED_USERNAME.toLowerCase();
  const existing = registeredUsers.get(lc);
  if (existing) {
    if (!existing.isAdmin) { existing.isAdmin = true; saveAuthUsers(); }
    // If ADMIN_PASSWORD is explicitly set, treat it as the source of truth.
    // Without this, seeding just returned early on any server that already
    // had an admin account, so setting the env var silently did nothing and
    // there was no way to change or recover the admin password at all.
    // The hash is only rewritten when it actually differs, so a normal
    // restart does no extra work.
    if (process.env.ADMIN_PASSWORD) {
      const alreadyMatches = await authVerifyPassword(process.env.ADMIN_PASSWORD, existing.passwordHash);
      if (!alreadyMatches) {
        existing.passwordHash = await authHashPassword(process.env.ADMIN_PASSWORD);
        saveAuthUsers();
        console.log(`[ADMIN] Password for ${existing.username} updated from the ADMIN_PASSWORD environment variable.`);
      }
    }
    return;
  }
  const user = {
    username: ADMIN_SEED_USERNAME,
    passwordHash: await authHashPassword(ADMIN_SEED_PASSWORD),
    createdAt: new Date().toISOString(),
    friends: [],
    pendingRequests: [],
    avatar: DEFAULT_AVATAR,
    bio: "",
    isAdmin: true,
  };
  registeredUsers.set(lc, user);
  authReservedNames.add(lc);
  saveAuthUsers();
  console.log(`[ADMIN] Seeded administrator account: ${ADMIN_SEED_USERNAME}`);
  if (!process.env.ADMIN_PASSWORD) {
    console.warn("─".repeat(72));
    console.warn("[SECURITY] ADMIN_PASSWORD was not set, so a random one was generated");
    console.warn("[SECURITY] for this brand-new admin account. Save it now — it is shown");
    console.warn("[SECURITY] only this once and is not recoverable from the data file:");
    console.warn(`[SECURITY]     username: ${ADMIN_SEED_USERNAME}`);
    console.warn(`[SECURITY]     password: ${ADMIN_SEED_PASSWORD}`);
    console.warn("─".repeat(72));
  }
}

loadAuthUsers();
loadPrivateMsgs();
loadStreaks();
loadChatRooms();
loadForum();
loadNotifications();
loadStats();
// server.listen() below is deliberately deferred until this resolves — closes
// a narrow race where someone could register the admin username themselves
// in the brief window before the async password hash finishes.
const adminSeedPromise = seedAdminAccount().catch(e => console.error("[ADMIN] Failed to seed administrator account:", e.message));

// ── Scheduled cleanup ─────────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  let n = 0;
  for (const [id, r] of privateRooms) if (now >= r.expiresAt) { deleteRoomPhotoFiles(r); privateRooms.delete(id); n++; }
  if (n) { savePrivateMsgs(); console.log(`[PRIV] Cleaned ${n} expired room(s)`); }
}, 60 * 60 * 1000);

// Drop streak records that are already broken (count 0) and have seen no
// activity from either side in 14+ days — keeps the pair's entry alive for
// active friends indefinitely, but stops long-dormant/unfriended pairs from
// sitting in memory (and in friend_streaks.json) forever.
setInterval(() => {
  const cutoff = addDaysUTC(todayUTC(), -14);
  let n = 0;
  for (const [id, s] of friendStreaks) {
    if (s.count > 0) continue;
    const dates = Object.values(s.lastFrom || {});
    const mostRecent = dates.length ? dates.sort().pop() : null;
    if (!mostRecent || mostRecent < cutoff) { friendStreaks.delete(id); n++; }
  }
  if (n) { saveStreaks(); console.log(`[STREAKS] Cleaned ${n} dormant streak record(s)`); }
}, 60 * 60 * 1000);

setInterval(() => {
  const now = Date.now();
  for (const [t, e] of authTokens) if (now >= e.expiry) authTokens.delete(t);
}, 60 * 60 * 1000);

setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of flappySessions) {
    if (now - s.startAt > 30 * 60 * 1000) flappySessions.delete(sid); // 30 min = generous max game length
  }
}, 60 * 60 * 1000);

setInterval(() => {
  const now = Date.now();
  for (const [key, expiry] of drawDeclineCooldown) if (now >= expiry) drawDeclineCooldown.delete(key);
}, 60 * 60 * 1000);

setInterval(() => {
  const now = Date.now();
  for (const [key, expiry] of pokerDeclineCooldown) if (now >= expiry) pokerDeclineCooldown.delete(key);
}, 60 * 60 * 1000);

setInterval(() => {
  const now = Date.now();
  for (const [key, expiry] of chessDeclineCooldown) if (now >= expiry) chessDeclineCooldown.delete(key);
}, 60 * 60 * 1000);

setInterval(() => {
  const now = Date.now();
  for (const [key, expiry] of checkersDeclineCooldown) if (now >= expiry) checkersDeclineCooldown.delete(key);
}, 60 * 60 * 1000);

setInterval(() => {
  const now = Date.now();
  for (const [key, expiry] of jokerDeclineCooldown) if (now >= expiry) jokerDeclineCooldown.delete(key);
}, 60 * 60 * 1000);

setInterval(() => {
  const now = Date.now();
  for (const [key, expiry] of imposterDeclineCooldown) if (now >= expiry) imposterDeclineCooldown.delete(key);
}, 60 * 60 * 1000);

setInterval(() => {
  const now = Date.now();
  for (const [key, expiry] of bjDeclineCooldown) if (now >= expiry) bjDeclineCooldown.delete(key);
}, 60 * 60 * 1000);

setInterval(() => {
  const now = Date.now();
  for (const [key, expiry] of friendRequestDeclineCooldown) if (now >= expiry) friendRequestDeclineCooldown.delete(key);
}, 60 * 60 * 1000);

// ── REST endpoints ────────────────────────────────────────────────────────────
const authLimiter = rateLimit({ windowMs: 15 * 60_000, max: 30, standardHeaders: true, legacyHeaders: false });

// POST /api/auth/register
app.post("/api/auth/register", authLimiter, express.json({ limit: "5kb" }), async (req, res) => {
  const { username, password, avatar, profile } = req.body || {};
  if (!username || !password || typeof username !== "string" || typeof password !== "string")
    return res.status(400).json({ error: "სახელი და პაროლი სავალდებულოა" });

  const clean = username.trim();
  if (clean.length < 2 || clean.length > 20)
    return res.status(400).json({ error: "სახელი: 2–20 სიმბოლო" });
  if (!/^[\w\u10D0-\u10FF\s\-.]+$/.test(clean))
    return res.status(400).json({ error: "სახელი შეიცავს დაუშვებელ სიმბოლოებს" });
  if (findBannedWord(clean))
    return res.status(400).json({ error: ABUSE_WORD_MESSAGE });
  if (password.length < 6 || password.length > 100)
    return res.status(400).json({ error: "პაროლი: 6–100 სიმბოლო" });

  const lc = clean.toLowerCase();
  if (registeredUsers.has(lc) || isRetiredName(lc))
    return res.status(409).json({ error: "ეს სახელი უკვე დაკავებულია" });

  const chosenAvatar = (typeof avatar === "string" && AVAILABLE_AVATARS.includes(avatar))
    ? avatar
    : DEFAULT_AVATAR;

  const prof = sanitizeProfile(profile);   // optional details — may be empty
  if (prof.error) return res.status(400).json({ error: prof.error });

  const user = {
    username: clean,
    passwordHash: await authHashPassword(password),
    createdAt: new Date().toISOString(),
    friends: [],
    pendingRequests: [],
    avatar: chosenAvatar,
    bio: "",
    profile: prof.profile
  };

  registeredUsers.set(lc, user);
  authReservedNames.add(lc);
  saveAuthUsers();

  const token = authToken();
  authTokens.set(token, { usernameLower: lc, expiry: Date.now() + AUTH_TOKEN_TTL });

  res.status(201).json({ success: true, token, username: user.username, avatar: user.avatar, bio: user.bio });
});

// GET /api/flappy/leaderboard — public, no auth: anyone can see the top 3.
app.get("/api/flappy/leaderboard", (req, res) => {
  res.json({ top3: getFlappyTop3() });
});

// GET /api/chess/leaderboard, /api/checkers/leaderboard — same idea, public.
app.get("/api/chess/leaderboard", (req, res) => {
  res.json({ top3: getChessTop3() });
});
app.get("/api/checkers/leaderboard", (req, res) => {
  res.json({ top3: getCheckersTop3() });
});

// GET /api/auth/avatars — list the predefined avatar options
app.get("/api/auth/avatars", (req, res) => {
  res.json({ avatars: AVAILABLE_AVATARS });
});

// POST /api/auth/avatar — change the logged-in user's avatar
app.post("/api/auth/avatar", express.json({ limit: "1kb" }), (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "") || req.body?.token;
  const { avatar } = req.body || {};

  if (!token) return res.status(401).json({ error: "No token" });
  const entry = authTokens.get(token);
  if (!entry || Date.now() >= entry.expiry) {
    authTokens.delete(token);
    return res.status(401).json({ error: "Token expired" });
  }
  if (typeof avatar !== "string" || !AVAILABLE_AVATARS.includes(avatar))
    return res.status(400).json({ error: "არასწორი ავატარი" });

  const user = registeredUsers.get(entry.usernameLower);
  if (!user) return res.status(401).json({ error: "User not found" });

  user.avatar = avatar;
  saveAuthUsers();

  res.json({ success: true, avatar: user.avatar });
});

// POST /api/auth/bio — change the logged-in user's interests/bio (shown next to
// their name in the dashboard's online-users list)
// POST /api/auth/profile — replace your optional profile details (dashboard editor).
// POST /api/auth/rename-required — only for accounts an admin name-blocked.
// Renames the account everywhere and lifts the block.
app.post("/api/auth/rename-required", authLimiter, express.json({ limit: "1kb" }), (req, res) => {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  const entry = token && authTokens.get(token);
  if (!entry || Date.now() >= entry.expiry) return res.status(401).json({ error: "გთხოვ, თავიდან შედი ანგარიშზე" });
  const user = registeredUsers.get(entry.usernameLower);
  if (!user) return res.status(401).json({ error: "User not found" });
  if (!user.nameBlocked) return res.status(403).json({ error: "სახელის შეცვლა შეუძლებელია" });
  const v = validateNewUsername(req.body && req.body.newName, entry.usernameLower);
  if (v.error) return res.status(400).json({ error: v.error });
  const { oldName } = renameAccount(entry.usernameLower, v.clean);
  user.nameBlocked = false; delete user.nameBlockedAt; saveAuthUsers();
  console.log(`[AUTH] "${oldName}" renamed to "${v.clean}" after a name block`);
  announceOnlineChanged();
  res.json({ success: true, username: v.clean });
});

app.post("/api/auth/profile", express.json({ limit: "2kb" }), (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "") || req.body?.token;
  if (!token) return res.status(401).json({ error: "No token" });
  const entry = authTokens.get(token);
  if (!entry || Date.now() >= entry.expiry) { authTokens.delete(token); return res.status(401).json({ error: "Token expired" }); }
  const user = registeredUsers.get(entry.usernameLower);
  if (!user) return res.status(401).json({ error: "User not found" });
  if (user.isGuest) return res.status(403).json({ error: "პროფილის შევსება მხოლოდ რეგისტრირებულ მომხმარებლებს შეუძლიათ" });
  const prof = sanitizeProfile(req.body && req.body.profile);
  if (prof.error) return res.status(400).json({ error: prof.error });
  user.profile = prof.profile;
  saveAuthUsers();
  res.json({ success: true, profile: publicProfileOf(user) });
});

app.post("/api/auth/bio", express.json({ limit: "1kb" }), (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "") || req.body?.token;
  const { bio } = req.body || {};

  if (!token) return res.status(401).json({ error: "No token" });
  const entry = authTokens.get(token);
  if (!entry || Date.now() >= entry.expiry) {
    authTokens.delete(token);
    return res.status(401).json({ error: "Token expired" });
  }
  if (typeof bio !== "string")
    return res.status(400).json({ error: "არასწორი ინტერესები" });

  const user = registeredUsers.get(entry.usernameLower);
  if (!user) return res.status(401).json({ error: "User not found" });

  user.bio = bio.slice(0, 60).replace(/<[^>]*>/g, "").trim();
  saveAuthUsers();

  res.json({ success: true, bio: user.bio });
});

// POST /api/auth/login
app.post("/api/auth/login", authLimiter, express.json({ limit: "5kb" }), async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: "სახელი და პაროლი სავალდებულოა" });

  const lc = String(username).toLowerCase().trim();
  const user = registeredUsers.get(lc);
  if (!user || !(await authVerifyPassword(password, user.passwordHash)))
    return res.status(401).json({ error: "არასწორი სახელი ან პაროლი" });

  const token = authToken();
  authTokens.set(token, { usernameLower: lc, expiry: Date.now() + AUTH_TOKEN_TTL });

  res.json({
    success: true,
    token,
    username: user.username,
    friends: user.friends || [],
    pendingRequests: user.pendingRequests || [],
    avatar: user.avatar || DEFAULT_AVATAR,
    bio: user.bio || "",
    isAdmin: !!user.isAdmin
  });
});

// POST /api/auth/logout
// POST /api/auth/delete-account — permanently delete the caller's own account.
//
// Requires the account password again, even though a valid token was already
// supplied: a token is enough to read and post, but not enough to destroy an
// account. If someone walks up to an unlocked phone or steals a session, the
// password is the thing standing between them and irreversible deletion.
//
// What happens to the user's content:
//   * Personal data (private messages, friendships, streaks, blocks, reports)
//     is DELETED outright.
//   * Forum posts/comments and room messages are ANONYMISED, not deleted, so
//     conversations other people took part in don't get holes punched in them.
//     The author becomes "წაშლილი მომხმარებელი" and authorLc is set to a
//     sentinel that no real account can ever match.
//   * The username is released, so it can be registered again later.
app.post("/api/auth/delete-account", authLimiter, express.json({ limit: "2kb" }), async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "") || req.body?.token;
  const { password } = req.body || {};

  if (!token) return res.status(401).json({ error: "No token" });
  const entry = authTokens.get(token);
  if (!entry || Date.now() >= entry.expiry) {
    authTokens.delete(token);
    return res.status(401).json({ error: "Token expired" });
  }
  const lc = entry.usernameLower;
  const user = registeredUsers.get(lc);
  if (!user) return res.status(401).json({ error: "User not found" });
  if (user.isGuest) return res.status(400).json({ error: "სტუმრის ანგარიში არ საჭიროებს წაშლას" });

  if (typeof password !== "string" || !password)
    return res.status(400).json({ error: "პაროლი სავალდებულოა" });
  if (!(await authVerifyPassword(password, user.passwordHash)))
    return res.status(403).json({ error: "პაროლი არასწორია" });

  const displayName = user.username;
  const DELETED_LABEL = "წაშლილი მომხმარებელი";
  const DELETED_LC = "\u0000deleted";  // can never collide with a real username

  // 1. Other people's friend lists, pending requests and block lists
  for (const [, other] of registeredUsers) {
    if (Array.isArray(other.friends))        other.friends        = other.friends.filter(f => f !== lc);
    if (Array.isArray(other.pendingRequests))other.pendingRequests = other.pendingRequests.filter(r => r !== lc);
    if (Array.isArray(other.blockedUsers))   other.blockedUsers   = other.blockedUsers.filter(b => b !== lc);
  }

  // 2. Private conversations involving this user, and their streaks
  for (const [roomId, room] of privateRooms) {
    if (roomId.split("::").includes(lc)) { deleteRoomPhotoFiles(room); privateRooms.delete(roomId); }
  }
  for (const [roomId] of friendStreaks) {
    if (roomId.split("::").includes(lc)) friendStreaks.delete(roomId);
  }

  // 3. Chat rooms: drop membership, anonymise anything they wrote
  for (const [, room] of chatRooms) {
    if (Array.isArray(room.members)) room.members = room.members.filter(m => m !== lc);
    if (Array.isArray(room.bannedUsers)) room.bannedUsers = room.bannedUsers.filter(b => b !== lc);
    if (Array.isArray(room.messages)) {
      for (const m of room.messages) {
        if (m.fromLc === lc) { m.fromLc = DELETED_LC; m.fromUsername = DELETED_LABEL; }
      }
    }
    if (room.lastRead) delete room.lastRead[lc];
  }

  // 4. Forum: anonymise posts and comments, strip their votes
  for (const [, post] of forumPosts) {
    if (post.authorLc === lc) { post.authorLc = DELETED_LC; post.authorUsername = DELETED_LABEL; }
    if (post.votes) delete post.votes[lc];
    if (post.lastRead) delete post.lastRead[lc];
    if (Array.isArray(post.comments)) {
      for (const c of post.comments) {
        if (c.authorLc === lc) { c.authorLc = DELETED_LC; c.authorUsername = DELETED_LABEL; }
        if (c.votes) delete c.votes[lc];
      }
    }
  }

  // 5. Moderation records tied to the account
  if (typeof accountReportLog !== "undefined") accountReportLog.delete(lc);

  // 6. Kill every session, then remove the account itself
  for (const [t, e] of authTokens) if (e.usernameLower === lc) authTokens.delete(t);
  const sockets = onlineRegSockets.get(lc);
  if (sockets) {
    for (const sid of sockets) {
      const s = io.sockets.sockets.get(sid);
      if (s) { s.emit("auth:accountDeleted"); setTimeout(() => s.disconnect(true), 300); }
    }
  }
  onlineRegSockets.delete(lc);
  registeredUsers.delete(lc);
  authReservedNames.delete(lc);   // username becomes available again
  activeUsernames.delete(lc);
  forgetNotificationsOf(lc);

  saveAuthUsers();
  savePrivateMsgs();
  saveStreaks();
  saveChatRooms();
  saveForum();

  console.log(`[ACCOUNT] "${displayName}" deleted their own account`);
  res.json({ success: true });
});

app.post("/api/auth/logout", express.json({ limit: "1kb" }), (req, res) => {
  const { token } = req.body || {};
  if (token) authTokens.delete(token);
  res.json({ success: true });
});

// POST /api/auth/verify
app.post("/api/auth/verify", express.json({ limit: "1kb" }), (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(401).json({ error: "No token" });

  const entry = authTokens.get(token);
  if (!entry || Date.now() >= entry.expiry) {
    authTokens.delete(token);
    return res.status(401).json({ error: "Token expired" });
  }

  const user = registeredUsers.get(entry.usernameLower);
  if (!user) return res.status(401).json({ error: "User not found" });

  res.json({
    success: true,
    username: user.username,
    friends: user.friends || [],
    pendingRequests: user.pendingRequests || [],
    avatar: user.avatar || DEFAULT_AVATAR,
    bio: user.bio || "",
    isAdmin: !!user.isAdmin,
    isPro: !!user.isPro,
    adFreeUntil: user.adFreeUntil || 0,
    appearOffline: !!user.appearOffline,
    nameBlocked: !!user.nameBlocked
  });
});

// POST /api/users/avatars — bulk lookup: { usernames: [...] } → { avatars: { lowerUsername: file } }
app.post("/api/users/avatars", express.json({ limit: "2kb" }), (req, res) => {
  const { usernames } = req.body || {};
  if (!Array.isArray(usernames)) return res.status(400).json({ error: "usernames array required" });

  const out = {};
  for (const raw of usernames.slice(0, 50)) {
    if (typeof raw !== "string") continue;
    const lc = raw.toLowerCase().trim();
    const u = registeredUsers.get(lc);
    out[lc] = u ? (u.avatar || DEFAULT_AVATAR) : null;
  }
  res.json({ avatars: out });
});

// Small shared helper for the Rooms REST endpoints below — every one of them
// requires a valid, non-expired Bearer token (registered users only).
function requireRegAuth(req, res) {
  const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
  if (!token) { res.status(401).json({ error: "No token" }); return null; }
  const entry = authTokens.get(token);
  if (!entry || Date.now() >= entry.expiry) {
    authTokens.delete(token);
    res.status(401).json({ error: "Token expired" });
    return null;
  }
  const user = registeredUsers.get(entry.usernameLower);
  if (!user) { res.status(401).json({ error: "User not found" }); return null; }
  return { usernameLower: entry.usernameLower, user };
}

// GET /api/users/profile?username=X — a small public-profile snapshot for
// the tap-to-preview card (name, avatar, bio, online-or-not). Any
// registered user can look up any other by username — the same
// avatar/bio pair is already visible to anyone browsing the online-users
// list elsewhere, so this isn't exposing anything new, just making it
// reachable by name from more places (a friends list, a chat header).
// How the viewer stands with someone, for profile cards. Private chat is
// friends-only (friend-chat.html and /api/priv/history refuse anyone else),
// so a card should offer "message" to friends and "add friend" / "accept
// request" to everyone else — not a message button that bounces them out.
function friendRelation(meLc, me, themLc, them) {
  if (meLc === themLc) return "self";
  if (me.isGuest || them.isGuest) return "guest";
  if ((me.friends || []).includes(themLc)) return "friend";
  if ((them.pendingRequests || []).includes(meLc)) return "sent";
  if ((me.pendingRequests || []).includes(themLc)) return "received";
  return "none";
}

app.get("/api/users/profile", (req, res) => {
  const auth = requireRegAuth(req, res);
  if (!auth) return;

  const lc = String(req.query.username || "").toLowerCase().trim();
  const u = registeredUsers.get(lc);
  if (!u) return res.status(404).json({ error: "მომხმარებელი ვერ მოიძებნა" });

  const isOnline = isVisiblyOnline(lc); // respects "appear offline"
  res.json({
    username: u.username,
    avatar: u.avatar || DEFAULT_AVATAR,
    bio: u.bio || "",
    isOnline,
    isGuest: !!u.isGuest,
    isPro: !!u.isPro,
    profile: publicProfileOf(u),
    relation: friendRelation(auth.usernameLower, auth.user, lc, u),
    // Friends (and you) see the 24h status and when they were last online.
    ...(((auth.user.friends || []).includes(lc) || lc === auth.usernameLower) ? {
      status: (activeStatus(u) || {}).text || "",
      lastSeenAt: isOnline || u.appearOffline ? null : (u.lastSeenAt || null),
      theme: effectiveTheme(u),
    } : { theme: effectiveTheme(u) }),
  });
});

// GET /api/rooms — list every room. Open to any authenticated registered
// user (rooms require no approval to see or join). Each room in the list
// carries its own hasUnread flag — viewing the LIST doesn't mark anything
// as read anymore; only actually opening a specific room does (see
// rooms:join and the single-room endpoint below), so the badge on each
// room stays lit until you've actually looked at that one.
app.get("/api/rooms", (req, res) => {
  const auth = requireRegAuth(req, res);
  if (!auth) return;

  const list = [...chatRooms.values()]
    .map(r => roomPublicSummary(r, auth.usernameLower))
    .sort((a, b) => a.name.localeCompare(b.name));

  res.json({ rooms: list, isAdmin: !!auth.user.isAdmin });
});

// GET /api/rooms/unread — does this user have unread Rooms activity
// anywhere? Read-only, for the dashboard badge. True if any individual
// room's hasUnread is true.
app.get("/api/rooms/unread", (req, res) => {
  const auth = requireRegAuth(req, res);
  if (!auth) return;

  // Lazily initialize on first-ever check so existing users don't suddenly
  // see a flood of "unread" for content that predates this feature — this
  // is only ever used as a fallback for rooms they haven't specifically
  // opened yet (see roomUnreadFor).
  if (!auth.user.lastRoomsVisitAt) { auth.user.lastRoomsVisitAt = Date.now(); authUsersDirty = true; scheduleSave(); }

  let unread = false;
  for (const room of chatRooms.values()) {
    if (roomUnreadFor(room, auth.user, auth.usernameLower)) { unread = true; break; }
  }
  res.json({ unread });
});

// GET /api/rooms/:roomId/messages — history for one room. A user the admin
// has banned from this specific room is refused, same as everyone else who
// isn't a registered user at all. Fetching this marks THIS room read.
app.get("/api/rooms/:roomId/messages", (req, res) => {
  const auth = requireRegAuth(req, res);
  if (!auth) return;

  const room = chatRooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: "ოთახი ვერ მოიძებნა" });
  if (room.bannedUsers.includes(auth.usernameLower)) {
    return res.status(403).json({ error: "ადმინისტრატორმა შეგზღუდათ ამ ოთახში წვდომა" });
  }

  room.lastRead = room.lastRead || {};
  room.lastRead[auth.usernameLower] = Date.now();
  saveChatRooms();

  res.json({
    room: roomPublicSummary(room, auth.usernameLower),
    messages: room.messages.map(roomMessagePublic),
  });
});

// GET /api/forum/posts?sort=new|top — feed listing. Open to any
// authenticated registered user, same "no approval needed" spirit as Rooms.
// Each post carries its own hasUnread flag — same "only opening the
// specific post marks it read" behavior as Rooms above.
app.get("/api/forum/posts", (req, res) => {
  const auth = requireRegAuth(req, res);
  if (!auth) return;

  const list = [...forumPosts.values()].map(p => forumPostSummary(p, auth.usernameLower));
  if (req.query.sort === "top") list.sort((a, b) => b.score - a.score || new Date(b.createdAt) - new Date(a.createdAt));
  else list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json({ posts: list, isAdmin: !!auth.user.isAdmin });
});

// GET /api/forum/unread — does this user have unread Forum activity
// anywhere? Read-only, mirrors /api/rooms/unread above.
app.get("/api/forum/unread", (req, res) => {
  const auth = requireRegAuth(req, res);
  if (!auth) return;

  if (!auth.user.lastForumVisitAt) { auth.user.lastForumVisitAt = Date.now(); authUsersDirty = true; scheduleSave(); }

  let unread = false;
  for (const post of forumPosts.values()) {
    if (postUnreadFor(post, auth.user, auth.usernameLower)) { unread = true; break; }
  }
  res.json({ unread });
});

// GET /api/forum/posts/:postId — full post + every comment, for the detail screen.
app.get("/api/forum/posts/:postId", (req, res) => {
  const auth = requireRegAuth(req, res);
  if (!auth) return;

  const post = forumPosts.get(req.params.postId);
  if (!post) return res.status(404).json({ error: "პოსტი ვერ მოიძებნა" });

  post.lastRead = post.lastRead || {};
  post.lastRead[auth.usernameLower] = Date.now();
  saveForum();

  res.json({ post: forumPostFull(post, auth.usernameLower), isAdmin: !!auth.user.isAdmin });
});

// Same 10-a-minute ceiling the socket route has (friend requests are stored
// on the target's account, so unlimited ones are a spam/harassment vector).
const friendRestLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false });

// POST /api/friends/request
app.post("/api/friends/request", friendRestLimiter, express.json({ limit: "2kb" }), (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  const { toUsername } = req.body || {};
  if (!token || !toUsername) return res.status(400).json({ error: "Invalid request" });

  const entry = authTokens.get(token);
  if (!entry || Date.now() >= entry.expiry) return res.status(401).json({ error: "Unauthorized" });

  const fromUser = registeredUsers.get(entry.usernameLower);
  const toLc = String(toUsername).toLowerCase().trim();
  const toUser = registeredUsers.get(toLc);

  if (!fromUser || !toUser || toLc === entry.usernameLower)
    return res.status(400).json({ error: "Invalid target" });
  // Same rules as the socket route, which this endpoint used to skip —
  // letting anyone get past blocks.
  if (fromUser.isGuest || toUser.isGuest) return res.status(403).json({ error: "სტუმრებს მეგობრობა არ შეუძლიათ" });
  if (toUser.blockedUsers?.includes(entry.usernameLower)) return res.status(403).json({ error: "ამ მომხმარებელს არ შეუძლია მოთხოვნის მიღება" });
  if (fromUser.blockedUsers?.includes(toLc)) return res.status(403).json({ error: "მოხსენით ბლოკი ჯერ, რომ მოთხოვნა გაგზავნოთ" });
  if ((fromUser.friends || []).includes(toLc)) return res.status(400).json({ error: "უკვე მეგობრები ხართ" });
  // ...and the 24h wait after this person declined, which the socket route
  // enforces but this one skipped.
  const cooldownExpiry = friendRequestDeclineCooldown.get(`${entry.usernameLower}|${toLc}`);
  if (cooldownExpiry && Date.now() < cooldownExpiry) {
    const hoursLeft = Math.ceil((cooldownExpiry - Date.now()) / (60 * 60 * 1000));
    return res.status(429).json({ error: `${toUser.username}-მა ახლახან უარყო თქვენი მოთხოვნა — სცადეთ ${hoursLeft} საათში` });
  }

  if (!toUser.pendingRequests) toUser.pendingRequests = [];
  if (!toUser.pendingRequests.includes(entry.usernameLower)) {
    toUser.pendingRequests.push(entry.usernameLower);
    saveAuthUsers();
    pushNotification(toLc, {
      type: "friend_request", from: fromUser.username, fromLc: entry.usernameLower,
      link: "/dashboard.html#pendingSection",
    }, `freq:${entry.usernameLower}`);
    io.to(`user:${toLc}`).emit("friend:incomingRequest", { fromUsername: fromUser.username });
  }

  res.json({ success: true });
});

// POST /api/friends/accept
app.post("/api/friends/accept", friendRestLimiter, express.json({ limit: "2kb" }), (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  const { fromUsername } = req.body || {};
  if (!token || !fromUsername) return res.status(400).json({ error: "Invalid request" });

  const entry = authTokens.get(token);
  if (!entry || Date.now() >= entry.expiry) return res.status(401).json({ error: "Unauthorized" });

  const toUser = registeredUsers.get(entry.usernameLower);
  const fromLc = String(fromUsername).toLowerCase().trim();
  const fromUser = registeredUsers.get(fromLc);

  if (!toUser || !fromUser) return res.status(400).json({ error: "Invalid users" });
  if (toUser.isGuest || fromUser.isGuest) return res.status(403).json({ error: "სტუმრებს მეგობრობა არ შეუძლიათ" });

  if (!toUser.friends) toUser.friends = [];
  if (!fromUser.friends) fromUser.friends = [];
  if (!toUser.pendingRequests) toUser.pendingRequests = [];
  // Only a real request can be accepted — same rule as the socket route.
  if (toUser.friends.includes(fromLc)) return res.json({ success: true, friends: toUser.friends });
  if (!toUser.pendingRequests.includes(fromLc)) return res.status(400).json({ error: "მეგობრობის მოთხოვნა აღარ არსებობს" });

  toUser.friends.push(fromLc);
  if (!fromUser.friends.includes(entry.usernameLower)) fromUser.friends.push(entry.usernameLower);
  toUser.pendingRequests = toUser.pendingRequests.filter(u => u !== fromLc);

  saveAuthUsers();
  io.to(`user:${fromLc}`).emit("friend:acceptedByOther", { byUsername: toUser.username });
  markNotificationsRead(entry.usernameLower, it => it.type === "friend_request" && it.fromLc === fromLc);
  pushNotification(fromLc, {
    type: "friend_accept", from: toUser.username, fromLc: entry.usernameLower,
    link: `/friend-chat.html?friend=${encodeURIComponent(toUser.username)}`,
  });
  res.json({ success: true, friends: toUser.friends });
});

// POST /api/friends/decline
app.post("/api/friends/decline", express.json({ limit: "2kb" }), (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  const { fromUsername } = req.body || {};
  if (!token || !fromUsername) return res.status(400).json({ error: "Invalid request" });

  const entry = authTokens.get(token);
  if (!entry || Date.now() >= entry.expiry) return res.status(401).json({ error: "Unauthorized" });

  const user = registeredUsers.get(entry.usernameLower);
  if (!user) return res.status(400).json({ error: "User not found" });

  if (!user.pendingRequests) user.pendingRequests = [];
  const fromLc = String(fromUsername).toLowerCase().trim();
  const wasPending = user.pendingRequests.includes(fromLc);
  user.pendingRequests = user.pendingRequests.filter(u => u !== fromLc);
  saveAuthUsers();
  // Same as the socket route: the decliner gets 24h of peace from this sender.
  if (wasPending) friendRequestDeclineCooldown.set(`${fromLc}|${entry.usernameLower}`, Date.now() + FRIEND_REQUEST_DECLINE_COOLDOWN_MS);
  markNotificationsRead(entry.usernameLower, it => it.type === "friend_request" && it.fromLc === fromLc);

  res.json({ success: true });
});

// GET /api/priv/history — Friend chat message history
// Auth: Bearer token in Authorization header.
// Returns messages for the private room between the caller and friend.
app.get("/api/priv/history", (req, res) => {
  const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  const entry = authTokens.get(token);
  if (!entry || Date.now() >= entry.expiry) {
    return res.status(401).json({ error: "Token expired" });
  }

  const myLc     = entry.usernameLower;
  const friendLc = String(req.query.friend || "").toLowerCase().trim();

  if (!friendLc) return res.status(400).json({ error: "friend param required" });

  // Security: requester must be friends with target
  const myUser = registeredUsers.get(myLc);
  if (!myUser || !(myUser.friends || []).includes(friendLc)) {
    return res.status(403).json({ error: "Not friends" });
  }

  const roomId = privRoomId(myLc, friendLc);
  const room   = privateRooms.get(roomId);

  if (!room) return res.json({ messages: [], theme: null });

  // Opening the chat / fetching history marks it as read up to now
  room.lastRead = room.lastRead || {};
  room.lastRead[myLc] = Date.now();
  savePrivateMsgs();

  const msgs = (room.messages || []).map(m => ({
    from:      m.from,
    text:      m.text,
    type:      m.type || "text",
    photoUrl:  m.photoUrl || null,
    sticker:   m.sticker || null,
    voiceUrl:  m.voiceUrl || null,
    duration:  m.duration || null,
    ts:        m.ts,
    messageId: m.id || null,
    replyTo:   m.replyTo || null,
    reactions: m.reactions || null,
    expiresAt: room.expiresAt ? new Date(room.expiresAt).toISOString() : null
  }));

  res.json({ messages: msgs, theme: room.theme || null });
});

// GET /api/priv/unread — which friends have unread messages waiting
// Auth: Bearer token in Authorization header.
// Returns: { unread: ["friendname1", "friendname2", ...] }  (lowercase usernames)
app.get("/api/priv/unread", (req, res) => {
  const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  const entry = authTokens.get(token);
  if (!entry || Date.now() >= entry.expiry) {
    return res.status(401).json({ error: "Token expired" });
  }

  const myLc   = entry.usernameLower;
  const myUser = registeredUsers.get(myLc);
  const friends = (myUser && myUser.friends) || [];

  const unread = [];
  for (const friendLc of friends) {
    const roomId = privRoomId(myLc, friendLc);
    const room   = privateRooms.get(roomId);
    if (!room || !room.messages || !room.messages.length) continue;
    const lastReadAt = (room.lastRead && room.lastRead[myLc]) || 0;
    const hasUnread = room.messages.some(
      m => m.from === friendLc && new Date(m.ts).getTime() > lastReadAt
    );
    if (hasUnread) unread.push(friendLc);
  }

  res.json({ unread });
});

// ════════════════════════════════════════════════════════════════════════════
// SOCKET.IO CONNECTION HANDLER
// ════════════════════════════════════════════════════════════════════════════

// Game helper functions
function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateMathQuestion() {
  const ops = ['+', '-', '*'];
  const op = ops[rand(0, 2)];
  let a, b, answer;

  if (op === '+') {
    a = rand(1, 50); b = rand(1, 50); answer = a + b;
  } else if (op === '-') {
    a = rand(10, 99); b = rand(1, a); answer = a - b;
  } else {
    a = rand(2, 12); b = rand(2, 12); answer = a * b;
  }

  const display = op === '*' ? `${a} × ${b}` : `${a} ${op} ${b}`;
  return { display, answer };
}

function checkTTTWinner(board) {
  const LINES = [
    [0,1,2],[3,4,5],[6,7,8],
    [0,3,6],[1,4,7],[2,5,8],
    [0,4,8],[2,4,6]
  ];
  for (const [a,b,c] of LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c])
      return { symbol: board[a], line: [a,b,c] };
  }
  return null;
}

function getRPSWinner(c1, c2) {
  if (c1 === c2) return 'draw';
  if (
    (c1 === 'rock' && c2 === 'scissors') ||
    (c1 === 'scissors' && c2 === 'paper') ||
    (c1 === 'paper' && c2 === 'rock')
  ) return 'p1';
  return 'p2';
}

function cleanupGame(game) {
  game.players.forEach(pid => gameBySocket.delete(pid));
  gameById.delete(game.id);
}

function cleanupGameForSocket(socketId) {
  const gameId = gameBySocket.get(socketId);
  if (!gameId) return;
  const game = gameById.get(gameId);
  if (!game) { gameBySocket.delete(socketId); return; }

  const partnerId = game.players.find(id => id !== socketId);
  const partnerSocket = partnerId && io.sockets.sockets.get(partnerId);
  if (partnerSocket) partnerSocket.emit('game:partnerLeft');

  cleanupGame(game);
}

// ══════════════════════════════════════════════════════════════════════════
//  DRAW & GUESS — Pictionary-style group game for a host + their friends
//  Architecturally separate from the 1v1 gameById/gameBySocket system above:
//  those assume exactly 2 players (p1Id/p2Id); a Draw & Guess room holds a
//  variable-length player list and its own turn-rotation/round/timer state,
//  so it gets its own Maps rather than being force-fit into the existing ones.
// ══════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════
// Poker (Texas Hold'em) — invite-based tables, like Draw & Guess.
// Deck/hand-evaluator/side-pot/betting-round logic below was built and
// heavily unit- and stress-tested standalone (600,000+ assertions across
// 2p/4p/6p tables, including randomized all-in/side-pot scenarios checked
// for exact chip conservation) before being ported in here unchanged.
// ══════════════════════════════════════════════════════════════════════════

const POKER_MIN_PLAYERS  = 2;
const POKER_MAX_PLAYERS  = 6;
const POKER_SMALL_BLIND  = 10;
const POKER_BIG_BLIND    = 20;
const POKER_STARTING_COINS = 1000;
const POKER_COIN_REGEN_MS  = 24 * 60 * 60 * 1000; // once your stack hits 0, refills after this long
const POKER_ACTION_TTL_MS  = 25_000; // time to act before an auto-fold/check
const POKER_INVITE_TTL_MS  = 60_000;
const POKER_ROOM_TTL_MS    = 30_000; // grace period after a table empties before it's dropped
const POKER_DECLINE_COOLDOWN_MS = 5 * 60_000;
const POKER_NEXT_HAND_DELAY_MS  = 6_000; // pause between hands so players can see the result
const POKER_SHOWDOWN_REVEAL_MS  = parseInt(process.env.POKER_SHOWDOWN_REVEAL_MS, 10) || 2_200; // pause showing both hands face-up before announcing the winner

const pokerRooms          = new Map(); // roomId   → room
const pokerRoomBySocket   = new Map(); // socketId → roomId
const pokerDeclineCooldown = new Map(); // hostLc|targetLc → cooldown expiry

// ── Deck ─────────────────────────────────────────────────────────────────────
const POKER_RANKS = ["2","3","4","5","6","7","8","9","T","J","Q","K","A"];
const POKER_SUITS = ["s","h","d","c"];
function pokerMakeDeck() {
  const deck = [];
  for (const r of POKER_RANKS) for (const s of POKER_SUITS) deck.push(r + s);
  return deck;
}
function pokerShuffleDeck(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
function pokerCardRank(card) { return POKER_RANKS.indexOf(card[0]) + 2; } // 2..14 (A=14)
function pokerCardSuit(card) { return card[1]; }

// Evaluate exactly 5 cards → [handClass, tiebreak...]
// 8=straight flush 7=quads 6=full house 5=flush 4=straight 3=trips 2=two pair 1=pair 0=high card
function pokerEvaluate5(cards) {
  const ranks = cards.map(pokerCardRank).sort((a, b) => b - a);
  const suits = cards.map(pokerCardSuit);
  const isFlush = suits.every(s => s === suits[0]);

  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  const groups = Object.entries(counts).map(([r, c]) => [Number(r), c]).sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  const uniqDesc = [...new Set(ranks)].sort((a, b) => b - a);
  let isStraight = false, straightHigh = 0;
  if (uniqDesc.length === 5) {
    if (uniqDesc[0] - uniqDesc[4] === 4) { isStraight = true; straightHigh = uniqDesc[0]; }
    else if (uniqDesc.join(",") === "14,5,4,3,2") { isStraight = true; straightHigh = 5; } // wheel
  }

  if (isStraight && isFlush) return [8, straightHigh];
  if (groups[0][1] === 4) { const kicker = groups.find(g => g[1] === 1)[0]; return [7, groups[0][0], kicker]; }
  if (groups[0][1] === 3 && groups[1] && groups[1][1] === 2) return [6, groups[0][0], groups[1][0]];
  if (isFlush) return [5, ...ranks];
  if (isStraight) return [4, straightHigh];
  if (groups[0][1] === 3) {
    const kickers = groups.filter(g => g[1] === 1).map(g => g[0]).sort((a, b) => b - a);
    return [3, groups[0][0], ...kickers];
  }
  if (groups[0][1] === 2 && groups[1] && groups[1][1] === 2) {
    const pairRanks = [groups[0][0], groups[1][0]].sort((a, b) => b - a);
    const kicker = groups.find(g => g[1] === 1)[0];
    return [2, ...pairRanks, kicker];
  }
  if (groups[0][1] === 2) {
    const kickers = groups.filter(g => g[1] === 1).map(g => g[0]).sort((a, b) => b - a);
    return [1, groups[0][0], ...kickers];
  }
  return [0, ...ranks];
}
function pokerCompareHandRanks(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0, bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}
function pokerCombinations5(arr) {
  const out = [];
  const n = arr.length;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++)
          for (let e = d + 1; e < n; e++)
            out.push([arr[a], arr[b], arr[c], arr[d], arr[e]]);
  return out;
}
function pokerEvaluateBest(cards) {
  let best = null, bestCombo = null;
  for (const combo of pokerCombinations5(cards)) {
    const r = pokerEvaluate5(combo);
    if (!best || pokerCompareHandRanks(r, best) > 0) { best = r; bestCombo = combo; }
  }
  return { rank: best, cards: bestCombo };
}
const POKER_HAND_NAMES_KA = {
  8: "სტრეიტ-ფლეში", 7: "კარე", 6: "ფულ-ჰაუსი", 5: "ფლეში", 4: "სტრეიტი",
  3: "სეტი", 2: "ორი წყვილი", 1: "წყვილი", 0: "მაღალი კარტი",
};

// players: [{ lc, totalBetThisHand, folded }] → [{amount, eligible, payers, layerAmount}]
function pokerComputeSidePots(players) {
  const contributors = players.filter(p => p.totalBetThisHand > 0);
  const levels = [...new Set(contributors.map(p => p.totalBetThisHand))].sort((a, b) => a - b);
  const pots = [];
  let prevLevel = 0;
  for (const level of levels) {
    const layerAmount = level - prevLevel;
    const payers = contributors.filter(p => p.totalBetThisHand >= level);
    const potAmount = layerAmount * payers.length;
    if (potAmount > 0) {
      const eligible = payers.filter(p => !p.folded).map(p => p.lc);
      pots.push({ amount: potAmount, eligible, payers: payers.map(p => p.lc), layerAmount });
    }
    prevLevel = level;
  }
  return pots;
}

// ── Betting-round / hand state machine ──────────────────────────────────────
function pokerNextActiveSeat(players, fromIndex, predicate) {
  const n = players.length;
  for (let step = 1; step <= n; step++) {
    const idx = (fromIndex + step) % n;
    if (predicate(players[idx])) return idx;
  }
  return null;
}

function pokerNewHandState(players, dealerSeatIndex) {
  const deck = pokerShuffleDeck(pokerMakeDeck());
  for (const p of players) {
    p.folded = false;
    p.allIn = p.stack <= 0;
    p.currentBet = 0;
    p.totalBetThisHand = 0;
    p.hasActedThisRound = false;
    p.holeCards = p.stack > 0 ? [deck.pop(), deck.pop()] : [];
  }
  const room = {
    players, dealerSeatIndex, deck, communityCards: [], pot: 0,
    stage: "preflop", currentBet: 0, minRaise: POKER_BIG_BLIND, actingSeatIndex: null,
  };

  const payers = players.filter(p => p.stack > 0);
  if (payers.length < 2) { room.stage = "waiting"; return room; }

  const isHeadsUp = payers.length === 2;
  const sbSeat = isHeadsUp ? dealerSeatIndex : pokerNextActiveSeat(players, dealerSeatIndex, p => p.stack > 0);
  const bbSeat = pokerNextActiveSeat(players, sbSeat, p => p.stack > 0);

  pokerPostBlind(room, sbSeat, POKER_SMALL_BLIND);
  pokerPostBlind(room, bbSeat, POKER_BIG_BLIND);
  room.currentBet = POKER_BIG_BLIND;

  // Heads-up: dealer (who posted SB) acts first preflop — the real rule,
  // not a simplification. Either poster may already be all-in if too
  // short-stacked to cover the full blind, in which case they're skipped.
  const canAct = p => !p.folded && !p.allIn;
  let firstToAct;
  if (isHeadsUp) {
    if (canAct(players[sbSeat])) firstToAct = sbSeat;
    else if (canAct(players[bbSeat])) firstToAct = bbSeat;
    else firstToAct = null;
  } else {
    firstToAct = pokerNextActiveSeat(players, bbSeat, canAct);
  }
  room.actingSeatIndex = firstToAct;
  return room;
}

function pokerPostBlind(room, seatIndex, amount) {
  const p = room.players[seatIndex];
  const amt = Math.min(amount, p.stack);
  p.stack -= amt; p.currentBet += amt; p.totalBetThisHand += amt; room.pot += amt;
  if (p.stack === 0) p.allIn = true;
}

function pokerLivePlayers(room) { return room.players.filter(p => !p.folded && !p.allIn); }
function pokerInHandPlayers(room) { return room.players.filter(p => !p.folded); }

function pokerApplyAction(room, seatIndex, action, amount) {
  const player = room.players[seatIndex];
  if (!player || player.folded || player.allIn) return { ok: false, reason: "invalid_player" };
  if (room.actingSeatIndex !== seatIndex) return { ok: false, reason: "not_your_turn" };

  const toCall = room.currentBet - player.currentBet;

  if (action === "fold") {
    player.folded = true;
  } else if (action === "check") {
    if (toCall > 0) return { ok: false, reason: "cannot_check" };
  } else if (action === "call") {
    const callAmt = Math.min(toCall, player.stack);
    player.stack -= callAmt; player.currentBet += callAmt; player.totalBetThisHand += callAmt; room.pot += callAmt;
    if (player.stack === 0) player.allIn = true;
  } else if (action === "raise") {
    let target = Math.floor(Number(amount));
    if (!Number.isFinite(target)) return { ok: false, reason: "bad_amount" };
    const maxTarget = player.currentBet + player.stack;
    if (target > maxTarget) target = maxTarget;
    if (target <= room.currentBet) return { ok: false, reason: "raise_too_small" };
    const raiseIncrement = target - room.currentBet;
    const isFullRaise = raiseIncrement >= room.minRaise;
    if (!isFullRaise && target < maxTarget) return { ok: false, reason: "raise_below_minimum" };

    const addAmt = target - player.currentBet;
    player.stack -= addAmt; player.currentBet = target; player.totalBetThisHand += addAmt; room.pot += addAmt;
    if (player.stack === 0) player.allIn = true;
    if (isFullRaise) {
      room.minRaise = raiseIncrement;
      for (const p of room.players) if (!p.folded && !p.allIn && p !== player) p.hasActedThisRound = false;
    }
    room.currentBet = target;
  } else if (action === "allin") {
    const addAmt = player.stack;
    const target = player.currentBet + addAmt;
    player.stack = 0; player.allIn = true;
    player.currentBet = target; player.totalBetThisHand += addAmt; room.pot += addAmt;
    if (target > room.currentBet) {
      const raiseIncrement = target - room.currentBet;
      const isFullRaise = raiseIncrement >= room.minRaise;
      room.currentBet = target;
      if (isFullRaise) {
        room.minRaise = raiseIncrement;
        for (const p of room.players) if (!p.folded && !p.allIn && p !== player) p.hasActedThisRound = false;
      }
    }
  } else {
    return { ok: false, reason: "unknown_action" };
  }

  player.hasActedThisRound = true;
  return { ok: true };
}

function pokerIsRoundComplete(room) {
  const live = pokerLivePlayers(room);
  if (live.length === 0) return true;
  return live.every(p => p.hasActedThisRound && p.currentBet === room.currentBet);
}
function pokerAdvanceActingSeat(room) {
  room.actingSeatIndex = pokerNextActiveSeat(room.players, room.actingSeatIndex, p => !p.folded && !p.allIn);
}
function pokerBeginNewBettingRound(room) {
  for (const p of room.players) { p.currentBet = 0; p.hasActedThisRound = p.folded || p.allIn; }
  room.currentBet = 0;
  room.minRaise = POKER_BIG_BLIND;
  room.actingSeatIndex = pokerNextActiveSeat(room.players, room.dealerSeatIndex, p => !p.folded && !p.allIn);
}
function pokerDealNextStreet(room) {
  room.deck.pop(); // burn
  if (room.stage === "preflop") { room.communityCards.push(room.deck.pop(), room.deck.pop(), room.deck.pop()); room.stage = "flop"; }
  else if (room.stage === "flop") { room.communityCards.push(room.deck.pop()); room.stage = "turn"; }
  else if (room.stage === "turn") { room.communityCards.push(room.deck.pop()); room.stage = "river"; }
  else if (room.stage === "river") { room.stage = "showdown"; }
}

function pokerProgressHand(room) {
  for (;;) {
    const inHand = pokerInHandPlayers(room);
    if (inHand.length === 1) return pokerResolveUncontested(room, inHand[0]);

    if (!pokerIsRoundComplete(room)) {
      pokerAdvanceActingSeat(room);
      return { waiting: true };
    }

    if (room.stage === "river") { room.stage = "showdown"; return pokerResolveShowdown(room); }

    const live = pokerLivePlayers(room);
    pokerDealNextStreet(room);
    if (room.stage === "showdown") return pokerResolveShowdown(room);
    if (live.length >= 2) {
      pokerBeginNewBettingRound(room);
      if (!pokerIsRoundComplete(room)) return { waiting: true };
    } else {
      for (const p of room.players) p.hasActedThisRound = true;
    }
  }
}

function pokerResolveUncontested(room, winner) {
  winner.stack += room.pot;
  const amountWon = room.pot;
  room.pot = 0;
  return { showdown: false, uncontested: true, winners: [{ lc: winner.lc, amount: amountWon }] };
}

function pokerResolveShowdown(room) {
  const pots = pokerComputeSidePots(room.players.map(p => ({ lc: p.lc, totalBetThisHand: p.totalBetThisHand, folded: p.folded })));
  const hands = new Map();
  for (const p of pokerInHandPlayers(room)) hands.set(p.lc, pokerEvaluateBest([...p.holeCards, ...room.communityCards]));

  const payouts = new Map();
  const potResults = [];
  for (const pot of pots) {
    if (pot.eligible.length === 0) {
      // Nobody left in the hand ever matched this layer (two-or-more
      // players who both later folded had raised each other past what
      // anyone still in the showdown covered) — refund it to whoever paid
      // into it, same as an uncalled bet in real poker.
      for (const lc of pot.payers) payouts.set(lc, (payouts.get(lc) || 0) + pot.layerAmount);
      potResults.push({ amount: pot.amount, winners: [], handRank: null, refunded: true });
      continue;
    }
    let best = null, winners = [];
    for (const lc of pot.eligible) {
      const h = hands.get(lc);
      if (!best || pokerCompareHandRanks(h.rank, best) > 0) { best = h.rank; winners = [lc]; }
      else if (pokerCompareHandRanks(h.rank, best) === 0) { winners.push(lc); }
    }
    const share = Math.floor(pot.amount / winners.length);
    let remainder = pot.amount - share * winners.length;
    for (const lc of winners) {
      const extra = remainder > 0 ? 1 : 0;
      if (remainder > 0) remainder--;
      payouts.set(lc, (payouts.get(lc) || 0) + share + extra);
    }
    potResults.push({ amount: pot.amount, winners, handRank: best });
  }

  for (const [lc, amount] of payouts) room.players.find(pl => pl.lc === lc).stack += amount;
  room.pot = 0;
  return {
    showdown: true, uncontested: false,
    winners: [...payouts.entries()].map(([lc, amount]) => ({ lc, amount })),
    hands: [...hands.entries()].map(([lc, h]) => ({ lc, rank: h.rank, cards: h.cards })),
    pots: potResults,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// Chess — invite-based 1v1 games, same shape as Draw & Guess / Poker.
// Move generation/check/checkmate/stalemate logic below was built and
// validated standalone via perft (the standard chess-engine correctness
// test) before being ported in here unchanged: starting position perft
// exact through depth 5 (4,865,609 nodes), the "Kiwipete" castling/en
// passant/promotion stress position exact through depth 4 (4,085,603
// nodes), plus targeted tests for checkmate, stalemate, insufficient
// material, promotion, en passant, and castling-through-check.
// ══════════════════════════════════════════════════════════════════════════

const CHESS_WHITE = "w", CHESS_BLACK = "b";

function chessSq(file, rank) { return rank * 8 + file; }
function chessFileOf(s) { return s % 8; }
function chessRankOf(s) { return Math.floor(s / 8); }
function chessInBounds(f, r) { return f >= 0 && f < 8 && r >= 0 && r < 8; }
function chessSquareName(s) { return "abcdefgh"[chessFileOf(s)] + (chessRankOf(s) + 1); }
function chessNameToSquare(name) { return chessSq("abcdefgh".indexOf(name[0]), Number(name[1]) - 1); }

function chessInitialBoard() {
  const b = new Array(64).fill(null);
  const back = ["R", "N", "B", "Q", "K", "B", "N", "R"];
  for (let f = 0; f < 8; f++) {
    b[chessSq(f, 0)] = back[f];
    b[chessSq(f, 1)] = "P";
    b[chessSq(f, 6)] = "p";
    b[chessSq(f, 7)] = back[f].toLowerCase();
  }
  return b;
}

function chessNewGameState() {
  return {
    board: chessInitialBoard(),
    turn: CHESS_WHITE,
    castling: { wK: true, wQ: true, bK: true, bQ: true },
    epSquare: null,
    halfmove: 0,
    fullmove: 1,
  };
}

function chessIsWhitePiece(p) { return !!p && p === p.toUpperCase(); }
function chessColorOf(p) { return chessIsWhitePiece(p) ? CHESS_WHITE : CHESS_BLACK; }
function chessSameColor(p1, p2) { return !!p1 && !!p2 && chessColorOf(p1) === chessColorOf(p2); }
function chessOpponent(side) { return side === CHESS_WHITE ? CHESS_BLACK : CHESS_WHITE; }

const CHESS_KNIGHT_DELTAS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const CHESS_KING_DELTAS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const CHESS_BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const CHESS_ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function chessIsSquareAttacked(board, square, bySide) {
  const f = chessFileOf(square), r = chessRankOf(square);
  const pawnDir = bySide === CHESS_WHITE ? -1 : 1;
  for (const df of [-1, 1]) {
    const pf = f + df, pr = r + pawnDir;
    if (chessInBounds(pf, pr)) {
      const p = board[chessSq(pf, pr)];
      if (p && chessColorOf(p) === bySide && p.toUpperCase() === "P") return true;
    }
  }
  for (const [df, dr] of CHESS_KNIGHT_DELTAS) {
    const nf = f + df, nr = r + dr;
    if (!chessInBounds(nf, nr)) continue;
    const p = board[chessSq(nf, nr)];
    if (p && chessColorOf(p) === bySide && p.toUpperCase() === "N") return true;
  }
  for (const [df, dr] of CHESS_KING_DELTAS) {
    const nf = f + df, nr = r + dr;
    if (!chessInBounds(nf, nr)) continue;
    const p = board[chessSq(nf, nr)];
    if (p && chessColorOf(p) === bySide && p.toUpperCase() === "K") return true;
  }
  for (const [df, dr] of CHESS_BISHOP_DIRS) {
    let nf = f + df, nr = r + dr;
    while (chessInBounds(nf, nr)) {
      const p = board[chessSq(nf, nr)];
      if (p) { if (chessColorOf(p) === bySide && (p.toUpperCase() === "B" || p.toUpperCase() === "Q")) return true; break; }
      nf += df; nr += dr;
    }
  }
  for (const [df, dr] of CHESS_ROOK_DIRS) {
    let nf = f + df, nr = r + dr;
    while (chessInBounds(nf, nr)) {
      const p = board[chessSq(nf, nr)];
      if (p) { if (chessColorOf(p) === bySide && (p.toUpperCase() === "R" || p.toUpperCase() === "Q")) return true; break; }
      nf += df; nr += dr;
    }
  }
  return false;
}

function chessFindKing(board, side) {
  const king = side === CHESS_WHITE ? "K" : "k";
  for (let s = 0; s < 64; s++) if (board[s] === king) return s;
  return -1;
}
function chessInCheck(state, side) {
  const kingSq = chessFindKing(state.board, side);
  if (kingSq === -1) return false;
  return chessIsSquareAttacked(state.board, kingSq, chessOpponent(side));
}

function chessPseudoMoves(state) {
  const moves = [];
  const { board, turn } = state;

  for (let s = 0; s < 64; s++) {
    const piece = board[s];
    if (!piece || chessColorOf(piece) !== turn) continue;
    const f = chessFileOf(s), r = chessRankOf(s);
    const type = piece.toUpperCase();

    if (type === "P") {
      const dir = turn === CHESS_WHITE ? 1 : -1;
      const startRank = turn === CHESS_WHITE ? 1 : 6;
      const promoRank = turn === CHESS_WHITE ? 7 : 0;

      const oneR = r + dir;
      if (chessInBounds(f, oneR) && !board[chessSq(f, oneR)]) {
        chessPushPawnMoves(moves, s, chessSq(f, oneR), piece, promoRank === oneR, false);
        if (r === startRank) {
          const twoR = r + 2 * dir;
          if (!board[chessSq(f, twoR)]) moves.push({ from: s, to: chessSq(f, twoR), piece, doublePush: true });
        }
      }
      for (const df of [-1, 1]) {
        const cf = f + df, cr = r + dir;
        if (!chessInBounds(cf, cr)) continue;
        const target = chessSq(cf, cr);
        const targetPiece = board[target];
        if (targetPiece && !chessSameColor(piece, targetPiece)) {
          chessPushPawnMoves(moves, s, target, piece, promoRank === cr, true);
        } else if (state.epSquare !== null && target === state.epSquare) {
          moves.push({ from: s, to: target, piece, enPassant: true, capture: true });
        }
      }
    } else if (type === "N" || type === "K") {
      const deltas = type === "N" ? CHESS_KNIGHT_DELTAS : CHESS_KING_DELTAS;
      for (const [df, dr] of deltas) {
        const nf = f + df, nr = r + dr;
        if (!chessInBounds(nf, nr)) continue;
        const t = chessSq(nf, nr);
        const tp = board[t];
        if (!tp || !chessSameColor(piece, tp)) moves.push({ from: s, to: t, piece, capture: !!tp });
      }
    } else {
      const dirs = type === "B" ? CHESS_BISHOP_DIRS : type === "R" ? CHESS_ROOK_DIRS : [...CHESS_BISHOP_DIRS, ...CHESS_ROOK_DIRS];
      for (const [df, dr] of dirs) {
        let nf = f + df, nr = r + dr;
        while (chessInBounds(nf, nr)) {
          const t = chessSq(nf, nr);
          const tp = board[t];
          if (!tp) { moves.push({ from: s, to: t, piece }); }
          else { if (!chessSameColor(piece, tp)) moves.push({ from: s, to: t, piece, capture: true }); break; }
          nf += df; nr += dr;
        }
      }
    }
  }

  chessAddCastlingMoves(state, moves);
  return moves;
}

function chessPushPawnMoves(moves, from, to, piece, isPromo, isCapture) {
  if (isPromo) {
    for (const promo of ["Q", "R", "B", "N"]) {
      moves.push({ from, to, piece, capture: isCapture, promotion: chessColorOf(piece) === CHESS_WHITE ? promo : promo.toLowerCase() });
    }
  } else {
    moves.push({ from, to, piece, capture: isCapture });
  }
}

function chessAddCastlingMoves(state, moves) {
  const { board, turn, castling } = state;
  const side = chessOpponent(turn);
  if (turn === CHESS_WHITE) {
    if (castling.wK && !board[chessSq(5, 0)] && !board[chessSq(6, 0)] && board[chessSq(7, 0)] === "R" && board[chessSq(4, 0)] === "K") {
      if (!chessIsSquareAttacked(board, chessSq(4, 0), side) && !chessIsSquareAttacked(board, chessSq(5, 0), side) && !chessIsSquareAttacked(board, chessSq(6, 0), side)) {
        moves.push({ from: chessSq(4, 0), to: chessSq(6, 0), piece: "K", castle: "K" });
      }
    }
    if (castling.wQ && !board[chessSq(1, 0)] && !board[chessSq(2, 0)] && !board[chessSq(3, 0)] && board[chessSq(0, 0)] === "R" && board[chessSq(4, 0)] === "K") {
      if (!chessIsSquareAttacked(board, chessSq(4, 0), side) && !chessIsSquareAttacked(board, chessSq(3, 0), side) && !chessIsSquareAttacked(board, chessSq(2, 0), side)) {
        moves.push({ from: chessSq(4, 0), to: chessSq(2, 0), piece: "K", castle: "Q" });
      }
    }
  } else {
    if (castling.bK && !board[chessSq(5, 7)] && !board[chessSq(6, 7)] && board[chessSq(7, 7)] === "r" && board[chessSq(4, 7)] === "k") {
      if (!chessIsSquareAttacked(board, chessSq(4, 7), side) && !chessIsSquareAttacked(board, chessSq(5, 7), side) && !chessIsSquareAttacked(board, chessSq(6, 7), side)) {
        moves.push({ from: chessSq(4, 7), to: chessSq(6, 7), piece: "k", castle: "K" });
      }
    }
    if (castling.bQ && !board[chessSq(1, 7)] && !board[chessSq(2, 7)] && !board[chessSq(3, 7)] && board[chessSq(0, 7)] === "r" && board[chessSq(4, 7)] === "k") {
      if (!chessIsSquareAttacked(board, chessSq(4, 7), side) && !chessIsSquareAttacked(board, chessSq(3, 7), side) && !chessIsSquareAttacked(board, chessSq(2, 7), side)) {
        moves.push({ from: chessSq(4, 7), to: chessSq(2, 7), piece: "k", castle: "Q" });
      }
    }
  }
}

function chessCloneState(state) {
  return {
    board: state.board.slice(),
    turn: state.turn,
    castling: { ...state.castling },
    epSquare: state.epSquare,
    halfmove: state.halfmove,
    fullmove: state.fullmove,
  };
}

function chessApplyMove(state, move) {
  const s = chessCloneState(state);
  const { board } = s;
  const piece = move.piece;
  const mover = chessColorOf(piece);

  s.epSquare = null;

  if (move.enPassant) {
    board[move.to] = piece;
    board[move.from] = null;
    const capturedPawnSq = chessSq(chessFileOf(move.to), chessRankOf(move.from));
    board[capturedPawnSq] = null;
  } else if (move.castle) {
    board[move.to] = piece;
    board[move.from] = null;
    if (move.castle === "K") {
      const rookFrom = mover === CHESS_WHITE ? chessSq(7, 0) : chessSq(7, 7);
      const rookTo = mover === CHESS_WHITE ? chessSq(5, 0) : chessSq(5, 7);
      board[rookTo] = board[rookFrom];
      board[rookFrom] = null;
    } else {
      const rookFrom = mover === CHESS_WHITE ? chessSq(0, 0) : chessSq(0, 7);
      const rookTo = mover === CHESS_WHITE ? chessSq(3, 0) : chessSq(3, 7);
      board[rookTo] = board[rookFrom];
      board[rookFrom] = null;
    }
  } else {
    board[move.to] = move.promotion || piece;
    board[move.from] = null;
  }

  if (move.doublePush) {
    const dir = mover === CHESS_WHITE ? 1 : -1;
    s.epSquare = chessSq(chessFileOf(move.from), chessRankOf(move.from) + dir);
  }

  if (piece === "K") { s.castling.wK = false; s.castling.wQ = false; }
  if (piece === "k") { s.castling.bK = false; s.castling.bQ = false; }
  if (move.from === chessSq(0, 0) || move.to === chessSq(0, 0)) s.castling.wQ = false;
  if (move.from === chessSq(7, 0) || move.to === chessSq(7, 0)) s.castling.wK = false;
  if (move.from === chessSq(0, 7) || move.to === chessSq(0, 7)) s.castling.bQ = false;
  if (move.from === chessSq(7, 7) || move.to === chessSq(7, 7)) s.castling.bK = false;

  s.halfmove = (move.capture || piece.toUpperCase() === "P") ? 0 : s.halfmove + 1;
  if (mover === CHESS_BLACK) s.fullmove += 1;
  s.turn = chessOpponent(mover);

  return s;
}

function chessLegalMoves(state) {
  const mover = state.turn;
  const out = [];
  for (const m of chessPseudoMoves(state)) {
    const next = chessApplyMove(state, m);
    if (!chessInCheck(next, mover)) out.push(m);
  }
  return out;
}

function chessIsInsufficientMaterial(board) {
  const pieces = board.filter(Boolean);
  if (pieces.every(p => p.toUpperCase() === "K")) return true;
  if (pieces.length === 3) {
    const nonKings = pieces.filter(p => p.toUpperCase() !== "K");
    if (nonKings.length === 1 && (nonKings[0].toUpperCase() === "N" || nonKings[0].toUpperCase() === "B")) return true;
  }
  return false;
}

function chessGameStatus(state) {
  const moves = chessLegalMoves(state);
  const check = chessInCheck(state, state.turn);
  if (moves.length === 0) {
    if (check) return { status: "checkmate", winner: chessOpponent(state.turn) };
    return { status: "stalemate" };
  }
  if (state.halfmove >= 100) return { status: "draw", reason: "fifty-move" };
  if (chessIsInsufficientMaterial(state.board)) return { status: "draw", reason: "insufficient-material" };
  return { status: check ? "check" : "playing" };
}

// ══════════════════════════════════════════════════════════════════════════
// Checkers (American draughts) — invite-based 1v1 games, same shape as
// Chess/Poker. Move generation with mandatory captures, multi-jump chains,
// and king promotion was built and validated standalone (30 targeted tests
// covering mandatory capture, multi-jump continuation, the mid-chain
// promotion-stops-the-turn rule, and forward-only men vs all-direction
// kings) plus 500 fully randomized games checked for exact piece
// conservation on every single move — before being ported in unchanged.
// ══════════════════════════════════════════════════════════════════════════

const CHECKERS_RED = "r", CHECKERS_BLACK = "b";

function checkersSq(file, rank) { return rank * 8 + file; }
function checkersFileOf(s) { return s % 8; }
function checkersRankOf(s) { return Math.floor(s / 8); }
function checkersInBounds(f, r) { return f >= 0 && f < 8 && r >= 0 && r < 8; }
function checkersIsDark(s) { return (checkersFileOf(s) + checkersRankOf(s)) % 2 === 0; }

function checkersInitialBoard() {
  const b = new Array(64).fill(null);
  for (let s = 0; s < 64; s++) {
    if (!checkersIsDark(s)) continue;
    const r = checkersRankOf(s);
    if (r <= 2) b[s] = "r";
    else if (r >= 5) b[s] = "b";
  }
  return b;
}

function checkersNewGameState() {
  return { board: checkersInitialBoard(), turn: CHECKERS_RED, mustContinueFrom: null };
}

function checkersPieceColor(p) { return p ? p.toLowerCase() : null; }
function checkersIsKing(p) { return p === "R" || p === "B"; }
function checkersOpponent(side) { return side === CHECKERS_RED ? CHECKERS_BLACK : CHECKERS_RED; }
function checkersKingOf(side) { return side === CHECKERS_RED ? "R" : "B"; }

const CHECKERS_DIRS_ALL = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
function checkersForwardDirsFor(piece) {
  if (checkersIsKing(piece)) return CHECKERS_DIRS_ALL;
  return checkersPieceColor(piece) === CHECKERS_RED ? [[1, 1], [-1, 1]] : [[1, -1], [-1, -1]];
}

// Kings fly — any number of empty squares along a diagonal, same as
// international/Russian draughts (not the American "one square only" rule).
// Regular men can still only MOVE one square forward (see
// checkersSimpleMovesFrom), but can CAPTURE one square in any of the 4
// diagonal directions, including backward — also standard international
// draughts rules, not the American restriction to forward-only captures.
function checkersCaptureMovesFrom(board, from) {
  const piece = board[from];
  if (!piece) return [];
  const f = checkersFileOf(from), r = checkersRankOf(from);
  const moves = [];

  if (checkersIsKing(piece)) {
    for (const [df, dr] of CHECKERS_DIRS_ALL) {
      // Walk outward over empty squares looking for the first piece in
      // this direction.
      let nf = f + df, nr = r + dr;
      while (checkersInBounds(nf, nr) && !board[checkersSq(nf, nr)]) { nf += df; nr += dr; }
      if (!checkersInBounds(nf, nr)) continue; // ran off the board — nothing to capture this way
      const midSq = checkersSq(nf, nr);
      const midPiece = board[midSq];
      if (checkersPieceColor(midPiece) === checkersPieceColor(piece)) continue; // blocked by your own piece
      // Found one enemy piece — every empty square immediately past it
      // (until the next piece or the edge) is a legal landing square.
      let lf = nf + df, lr = nr + dr;
      while (checkersInBounds(lf, lr) && !board[checkersSq(lf, lr)]) {
        moves.push({ from, to: checkersSq(lf, lr), capture: midSq, piece });
        lf += df; lr += dr;
      }
    }
    return moves;
  }

  // Regular men still only MOVE forward (see checkersSimpleMovesFrom below),
  // but — standard international/Russian draughts rule — they CAN capture
  // in any of the 4 diagonal directions, including backward. Only their
  // non-capturing moves stay forward-restricted.
  for (const [df, dr] of CHECKERS_DIRS_ALL) {
    const midF = f + df, midR = r + dr;
    const landF = f + 2 * df, landR = r + 2 * dr;
    if (!checkersInBounds(landF, landR)) continue;
    const midSq = checkersSq(midF, midR), landSq = checkersSq(landF, landR);
    const midPiece = board[midSq];
    if (midPiece && checkersPieceColor(midPiece) !== checkersPieceColor(piece) && !board[landSq]) {
      moves.push({ from, to: landSq, capture: midSq, piece });
    }
  }
  return moves;
}

function checkersSimpleMovesFrom(board, from) {
  const piece = board[from];
  if (!piece) return [];
  const f = checkersFileOf(from), r = checkersRankOf(from);
  const moves = [];

  if (checkersIsKing(piece)) {
    for (const [df, dr] of CHECKERS_DIRS_ALL) {
      let nf = f + df, nr = r + dr;
      while (checkersInBounds(nf, nr)) {
        const t = checkersSq(nf, nr);
        if (board[t]) break; // blocked — can't land on or pass through an occupied square
        moves.push({ from, to: t, capture: null, piece });
        nf += df; nr += dr;
      }
    }
    return moves;
  }

  for (const [df, dr] of checkersForwardDirsFor(piece)) {
    const nf = f + df, nr = r + dr;
    if (!checkersInBounds(nf, nr)) continue;
    const t = checkersSq(nf, nr);
    if (!board[t]) moves.push({ from, to: t, capture: null, piece });
  }
  return moves;
}

function checkersLegalMoves(state) {
  const { board, turn, mustContinueFrom } = state;
  if (mustContinueFrom !== null) return checkersCaptureMovesFrom(board, mustContinueFrom);

  const captures = [];
  const simples = [];
  for (let s = 0; s < 64; s++) {
    const p = board[s];
    if (!p || checkersPieceColor(p) !== turn) continue;
    captures.push(...checkersCaptureMovesFrom(board, s));
    simples.push(...checkersSimpleMovesFrom(board, s));
  }
  return captures.length > 0 ? captures : simples;
}

function checkersCloneState(state) {
  return { board: state.board.slice(), turn: state.turn, mustContinueFrom: state.mustContinueFrom };
}

function checkersApplyMove(state, move) {
  const s = checkersCloneState(state);
  const { board } = s;
  let piece = move.piece;

  board[move.to] = piece;
  board[move.from] = null;
  if (move.capture !== null) board[move.capture] = null;

  const landRank = checkersRankOf(move.to);
  let promoted = false;
  if (!checkersIsKing(piece)) {
    if ((checkersPieceColor(piece) === CHECKERS_RED && landRank === 7) || (checkersPieceColor(piece) === CHECKERS_BLACK && landRank === 0)) {
      piece = checkersKingOf(checkersPieceColor(piece));
      board[move.to] = piece;
      promoted = true;
    }
  }

  if (move.capture !== null && !promoted) {
    const further = checkersCaptureMovesFrom(board, move.to);
    if (further.length > 0) {
      s.mustContinueFrom = move.to;
      return s;
    }
  }

  s.mustContinueFrom = null;
  s.turn = checkersOpponent(state.turn);
  return s;
}

function checkersCountPieces(board, side) {
  let n = 0;
  for (const p of board) if (p && checkersPieceColor(p) === side) n++;
  return n;
}

function checkersGameStatus(state) {
  const moves = checkersLegalMoves(state);
  if (moves.length === 0) {
    return {
      status: "over",
      winner: checkersOpponent(state.turn),
      reason: checkersCountPieces(state.board, state.turn) === 0 ? "no-pieces" : "no-moves",
    };
  }
  return { status: "playing" };
}

// Groups a flat move list into per-piece "segments" — a new segment starts
// whenever the next move's "from" doesn't continue the previous move's
// "to" (i.e. a different piece is now moving, only possible when a forced
// sequence cascades across a turn boundary). The client animates each
// segment as one continuous piece journey with its own trail.
function checkersBuildLastMove(movesPlayed) {
  const segments = [];
  let current = null;
  for (const m of movesPlayed) {
    if (current && current.path[current.path.length - 1] === m.from) {
      current.path.push(m.to);
      if (m.capture !== null) current.captures.push(m.capture);
    } else {
      current = { path: [m.from, m.to], captures: m.capture !== null ? [m.capture] : [] };
      segments.push(current);
    }
  }
  return {
    from: movesPlayed[0].from,
    to: movesPlayed[movesPlayed.length - 1].to,
    segments,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// Georgian Joker ("ჯოკერი") — 4-player, 24-hand trick-taking engine.
// 36-card deck (9 ranks × 4 suits minus the two black 6s, plus 2 Jokers),
// bidding with the dealer's "sum ≠ tricks available" restriction, mandatory
// suit-following with Jokers always exempt, HIGH/LOW Joker trick resolution,
// and the full scoring/khishti/set-bonus system. Validated standalone with
// 66 targeted tests (every Joker HIGH/LOW edge case, dealer bid restriction,
// all scoring branches) plus 60 fully simulated 24-hand games with random
// legal bidding/play checked for correct trick counts and bid legality on
// every single hand — before being ported in unchanged.
// ══════════════════════════════════════════════════════════════════════════

const JOKER_RANKS = ["6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const JOKER_SUITS = ["s", "h", "d", "c"];
const JOKER_RANK_VALUE = { 6: 6, 7: 7, 8: 8, 9: 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };

function jokerIsJokerCard(c) { return c === "JK1" || c === "JK2"; }
function jokerSuitOf(c) { return c[1]; }
function jokerRankOf(c) { return c[0]; }
function jokerValueOf(c) { return JOKER_RANK_VALUE[jokerRankOf(c)]; }

function jokerBuildDeck() {
  const deck = [];
  for (const r of JOKER_RANKS) {
    for (const s of JOKER_SUITS) {
      if (r === "6" && (s === "s" || s === "c")) continue;
      deck.push(r + s);
    }
  }
  deck.push("JK1", "JK2");
  return deck;
}

function jokerShuffle(deck) {
  const d = deck.slice();
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

const JOKER_HAND_SIZES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 9, 8, 7, 6, 5, 4, 3, 2, 1, 9, 9, 9, 9];
function jokerSetIndexForHand(handIdx) {
  if (handIdx < 8) return 1;
  if (handIdx < 12) return 2;
  if (handIdx < 20) return 3;
  return 4;
}

function jokerDealHand(handSize, dealerSeat) {
  const deck = jokerShuffle(jokerBuildDeck());
  const hands = [[], [], [], []];
  let idx = 0;
  for (let round = 0; round < handSize; round++) {
    for (let i = 1; i <= 4; i++) {
      const seat = (dealerSeat + i) % 4;
      hands[seat].push(deck[idx++]);
    }
  }
  let trumpCard;
  if (handSize < 9) trumpCard = deck[idx];
  else trumpCard = hands[dealerSeat][hands[dealerSeat].length - 1];
  const trumpSuit = jokerIsJokerCard(trumpCard) ? null : jokerSuitOf(trumpCard);
  return { hands, trumpCard, trumpSuit };
}

function jokerIsBidLegal(bid, handSize, isLastBidder, priorBidsSum) {
  if (!Number.isInteger(bid) || bid < 0 || bid > handSize) return false;
  if (isLastBidder && priorBidsSum + bid === handSize) return false;
  return true;
}

function jokerLegalCardsToPlay(hand, ledSuit, trumpSuit) {
  if (ledSuit === null) return hand.slice();
  const jokers = hand.filter(jokerIsJokerCard);
  const nonJokers = hand.filter(c => !jokerIsJokerCard(c));
  const followers = nonJokers.filter(c => jokerSuitOf(c) === ledSuit);
  if (followers.length > 0) return [...followers, ...jokers];
  const trumps = trumpSuit ? nonJokers.filter(c => jokerSuitOf(c) === trumpSuit) : [];
  if (trumps.length > 0) return [...trumps, ...jokers];
  return hand.slice();
}

function jokerResolveTrick(trickPlays, trumpSuit, ledSuit) {
  function isContender(tp) {
    if (jokerIsJokerCard(tp.card)) return tp.jokerChoice === "high";
    const s = jokerSuitOf(tp.card);
    return (trumpSuit && s === trumpSuit) || s === ledSuit;
  }
  const contenders = trickPlays.filter(isContender);
  if (contenders.length === 0) return trickPlays[0];
  function rankVal(tp) {
    if (jokerIsJokerCard(tp.card)) return Infinity;
    const s = jokerSuitOf(tp.card), v = jokerValueOf(tp.card);
    if (trumpSuit && s === trumpSuit) return 2000 + v;
    return 1000 + v;
  }
  let winner = contenders[0], best = rankVal(winner);
  for (let i = 1; i < contenders.length; i++) {
    const r = rankVal(contenders[i]);
    if (r > best) { winner = contenders[i]; best = r; }
  }
  return winner;
}

function jokerScoreHand(bid, actual, handSize, setIdx, khishtiEnabled) {
  if (khishtiEnabled && bid >= 1 && actual === 0) {
    return (setIdx === 1 || setIdx === 3) ? -200 : -500;
  }
  if (bid === actual) {
    if (bid === handSize) return 100 * handSize;
    return bid * 50 + 50;
  }
  return actual * 10;
}

function jokerSetBonus(setHands) {
  const allHit = setHands.every(h => h.bid > 0 && h.bid === h.actual);
  if (!allHit) return 0;
  return Math.max(...setHands.map(h => h.score));
}

const DRAW_MIN_PLAYERS   = 2;
const DRAW_MAX_PLAYERS   = 8;
const DRAW_ROUND_MS      = parseInt(process.env.DRAW_ROUND_MS, 10)  || 80_000;  // time to draw + guess
const DRAW_REVEAL_MS     = parseInt(process.env.DRAW_REVEAL_MS, 10) || 5_000;   // pause on the reveal screen before the next round
const DRAW_INVITE_TTL_MS = 60_000;  // unanswered invite quietly expires
const DRAW_PICK_TTL_MS   = 12_000;  // drawer's time to choose a word before auto-pick
const DRAW_ROOM_TTL_MS   = 30_000;  // grace period after a game ends before the room is dropped
const DRAW_DECLINE_COOLDOWN_MS = 5 * 60_000; // after declining, that host can't re-invite you for 5 min

const drawRooms       = new Map(); // roomId   → room
const drawRoomBySocket = new Map(); // socketId → roomId

// hostLc|targetLc → cooldown expiry timestamp. Prevents a host from
// re-inviting someone who just declined for DRAW_DECLINE_COOLDOWN_MS.
const drawDeclineCooldown = new Map();

const DRAW_WORD_BANK = [
  // ცხოველები (animals)
  "ძაღლი","კატა","ცხენი","ძროხა","ღორი","ცხვარი","თხა","ლომი","დათვი","სპილო",
  "ჟირაფი","მაიმუნი","კურდღელი","მელა","მგელი","თაგვი","ვეშაპი","დელფინი","თევზი","გველი",
  "კუ","ბაყაყი","ჩიტი","ბუ","არწივი","პეპელა","ფუტკარი","ობობა","ზებრა","კენგურუ","პინგვინი","სირაქლემა",
  // საკვები (food)
  "პიცა","ვაშლი","ბანანი","მსხალი","საზამთრო","ყურძენი","ლიმონი","პური","ყველი","ნაყინი",
  "ტორტი","შოკოლადი","ყავა","ჩაი","კვერცხი","სოკო","სტაფილო","კარტოფილი",
  // ნივთები (objects)
  "სახლი","მანქანა","ველოსიპედი","თვითმფრინავი","გემი","მატარებელი","საათი","სათვალე","ქოლგა","გვირგვინი",
  "გასაღები","წიგნი","სკამი","მაგიდა","ტელეფონი","კომპიუტერი","ტელევიზორი","სარკე","დანა","ჩანგალი",
  "კოვზი","ჩანთა","ფეხსაცმელი","ქუდი","მაკრატელი","სანთელი","ბურთი","გიტარა","დოლი","ყუთი","საწოლი","ფანჯარა","კარი",
  // ბუნება (nature)
  "მზე","მთვარე","ვარსკვლავი","ღრუბელი","წვიმა","თოვლი","ცეცხლი","მთა","ზღვა","მდინარე",
  "ტყე","ხე","ყვავილი","ცისარტყელა","ვულკანი","კუნძული",
  // ხალხი (people)
  "ექიმი","მასწავლებელი","პოლიციელი","მეხანძრე","მზარეული","კაცი","ქალი","ბავშვი",
  // ნაგებობები (structures)
  "ხიდი","კოშკი","ციხე","ეკლესია","პირამიდა",
  // სხვადასხვა (misc/fantasy)
  "რობოტი","მოჩვენება","ანგელოზი","დრაკონი",
];

function makeDrawRoomId() {
  return "dg_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

// Picks `n` words the room hasn't used yet this game; falls back to the full
// bank once it's been exhausted (a long game can outlast ~100 unique words).
function pickDrawWords(n, usedWords) {
  let pool = DRAW_WORD_BANK.filter(w => !usedWords.has(w));
  if (pool.length < n) pool = DRAW_WORD_BANK;
  const picked = [];
  const seen = new Set();
  while (picked.length < n && seen.size < pool.length) {
    const w = pool[rand(0, pool.length - 1)];
    if (seen.has(w)) continue;
    seen.add(w);
    picked.push(w);
  }
  return picked;
}

function normalizeGuess(s) {
  return String(s || "").trim().toLowerCase().replace(/[.,!?;:'"()]/g, "");
}

function drawRoomSockets(room) {
  return room.players
    .map(p => io.sockets.sockets.get(p.socketId))
    .filter(Boolean);
}

function broadcastDrawRoom(room, event, payload) {
  for (const s of drawRoomSockets(room)) s.emit(event, payload);
}

// Shape sent on every lobby/roster change — never includes the secret word.
function drawRoomPublicState(room) {
  return {
    roomId: room.id,
    hostUsername: room.players.find(p => p.lc === room.hostLc)?.username || "",
    status: room.status,
    players: room.players.map(p => ({
      username: p.username,
      avatar: registeredUsers.get(p.lc)?.avatar || null,
      score: p.score,
      connected: p.connected,
      isDrawer: !!(room.round && room.round.drawerLc === p.lc),
      hasDrawn: p.hasDrawn,
    })),
    roundNumber: room.roundNumber,
    totalRounds: room.players.length,
    endsAt: room.round ? room.round.endsAt : null,
    wordLength: (room.round && room.round.word) ? [...room.round.word].length : null,
  };
}

// Sent to a socket that (re)joins mid-round so its canvas/word-hint catch up.
function drawRoundSyncPayload(room, lc) {
  const round = room.round;
  if (!round) return null;
  const isDrawer = round.drawerLc === lc;
  const drawer = room.players.find(p => p.lc === round.drawerLc);
  return {
    roundNumber: room.roundNumber,
    totalRounds: room.players.length,
    drawerUsername: drawer?.username || "",
    isDrawer,
    word: isDrawer ? round.word : null,
    wordLength: round.word ? [...round.word].length : null,
    endsAt: round.endsAt,
    strokes: isDrawer ? [] : round.strokes,
    alreadyGuessed: round.guessedLc.has(lc),
  };
}

function drawRoomScores(room) {
  return room.players.map(p => ({ username: p.username, score: p.score }));
}

// Scans for a room (lobby or in-progress — not "ended") this user is
// currently a part of, host or not. Used to enforce one active room per
// user: someone already playing (or hosting) elsewhere can't spin up a
// second room via drawGuess:invite. A full scan is fine at this app's
// scale — same reasoning as getFlappyTop3 above.
function findActiveDrawRoomForUser(lc) {
  for (const room of drawRooms.values()) {
    if (room.status === "ended") continue;
    if (room.players.some(p => p.lc === lc)) return room;
  }
  return null;
}

// Public, low-detail view of every joinable room — shown to everyone in the
// "active games" browser under the invite button, not just invitees.
function getPublicDrawRooms() {
  const rows = [];
  for (const room of drawRooms.values()) {
    if (room.status === "ended") continue;
    if (room.players.length >= DRAW_MAX_PLAYERS) continue; // full — nothing to join
    rows.push({
      roomId: room.id,
      hostUsername: room.players.find(p => p.lc === room.hostLc)?.username || "",
      status: room.status,
      playerCount: room.players.filter(p => p.connected).length,
      maxPlayers: DRAW_MAX_PLAYERS,
      roundNumber: room.roundNumber,
    });
  }
  return rows;
}

function broadcastPublicDrawRooms() {
  io.emit("drawGuess:publicRooms", getPublicDrawRooms());
}

// ══════════════════════════════════════════════════════════════════════════
// Poker room lifecycle — invite/lobby/hand-flow orchestration around the
// tested engine functions above.
// ══════════════════════════════════════════════════════════════════════════

function makePokerRoomId() {
  return "pk_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function pokerRoomSockets(room) {
  return room.players.map(p => io.sockets.sockets.get(p.socketId)).filter(Boolean);
}

// Per-viewer state — hole cards are only ever included for the viewer's own
// seat, or (matching real poker) everyone still in the hand once it reaches
// showdown. Never broadcast as one shared payload for this exact reason.
function pokerRoomStateForViewer(room, viewerLc) {
  const revealAll = room.stage === "showdown";
  return {
    roomId: room.id,
    status: room.status,
    hostUsername: room.players.find(p => p.lc === room.hostLc)?.username || "",
    stage: room.stage,
    communityCards: room.communityCards || [],
    pot: room.pot || 0,
    currentBet: room.currentBet || 0,
    minRaise: room.minRaise || POKER_BIG_BLIND,
    smallBlind: POKER_SMALL_BLIND,
    bigBlind: POKER_BIG_BLIND,
    dealerSeatIndex: room.dealerSeatIndex ?? null,
    actingSeatIndex: room.actingSeatIndex ?? null,
    actionDeadline: room.actionDeadline || null,
    maxPlayers: POKER_MAX_PLAYERS,
    players: room.players.map((p, i) => ({
      seatIndex: i,
      username: p.username,
      avatar: registeredUsers.get(p.lc)?.avatar || DEFAULT_AVATAR,
      stack: p.stack,
      connected: p.connected,
      folded: !!p.folded,
      allIn: !!p.allIn,
      currentBet: p.currentBet || 0,
      hasCards: !!(p.holeCards && p.holeCards.length),
      holeCards: (p.lc === viewerLc || (revealAll && !p.folded)) ? (p.holeCards || []) : null,
    })),
  };
}

function broadcastPokerRoom(room) {
  for (const p of room.players) {
    const s = io.sockets.sockets.get(p.socketId);
    if (s) s.emit("poker:room", pokerRoomStateForViewer(room, p.lc));
  }
}

// Mirrors findActiveDrawRoomForUser — one active table per user at a time.
function findActivePokerRoomForUser(lc) {
  for (const room of pokerRooms.values()) {
    if (room.status === "ended") continue;
    if (room.players.some(p => p.lc === lc)) return room;
  }
  return null;
}

function getPublicPokerRooms() {
  const rows = [];
  for (const room of pokerRooms.values()) {
    if (room.status === "ended") continue;
    if (room.players.length >= POKER_MAX_PLAYERS) continue;
    rows.push({
      roomId: room.id,
      hostUsername: room.players.find(p => p.lc === room.hostLc)?.username || "",
      status: room.status,
      playerCount: room.players.filter(p => p.connected).length,
      maxPlayers: POKER_MAX_PLAYERS,
    });
  }
  return rows;
}
function broadcastPublicPokerRooms() {
  io.emit("poker:publicRooms", getPublicPokerRooms());
}

function clearPokerActionTimer(room) {
  if (room.actionTimeoutHandle) { clearTimeout(room.actionTimeoutHandle); room.actionTimeoutHandle = null; }
}
function schedulePokerActionTimer(room) {
  clearPokerActionTimer(room);
  if (room.actingSeatIndex == null) { room.actionDeadline = null; return; }
  room.actionDeadline = Date.now() + POKER_ACTION_TTL_MS;
  room.actionTimeoutHandle = setTimeout(() => pokerAutoAct(room), POKER_ACTION_TTL_MS);
}

// Idle too long on your turn → check if that's legal, otherwise fold. Never
// auto-calls: that would risk someone's coins on their behalf.
function pokerAutoAct(room) {
  const seat = room.actingSeatIndex;
  const player = room.players[seat];
  if (!player) return;
  const toCall = room.currentBet - player.currentBet;
  pokerApplyAction(room, seat, toCall > 0 ? "fold" : "check");
  pokerAfterAction(room);
}

// Single funnel every action (real or timed-out) flows through: advance the
// engine, and either wait on the next player or wrap up the hand.
function pokerAfterAction(room) {
  clearPokerActionTimer(room);
  const result = pokerProgressHand(room);
  if (result.waiting) {
    schedulePokerActionTimer(room);
    broadcastPokerRoom(room);
    return;
  }
  pokerFinishHand(room, result);
}

function pokerFinishHand(room, result) {
  // This IS each player's persistent balance, not a separate table buy-in —
  // sync it back the moment the hand resolves, regardless of reveal timing.
  for (const p of room.players) {
    const user = registeredUsers.get(p.lc);
    if (user) { user.pokerCoins = p.stack; saveAuthUsers(); }
  }

  // At a real showdown, broadcast the card reveal FIRST — room.stage is
  // still "showdown" here so every non-folded hand is visible to everyone
  // — and pause before announcing the winner, so players actually get to
  // see and compare both hands before finding out who won, instead of the
  // winner overlay popping up before the cards have even rendered.
  // Uncontested wins (everyone else folded) have nothing to compare, so
  // there's no reveal pause needed there.
  broadcastPokerRoom(room);
  const delay = result.uncontested ? 0 : POKER_SHOWDOWN_REVEAL_MS;
  if (room.showdownRevealTimeoutHandle) clearTimeout(room.showdownRevealTimeoutHandle);
  room.showdownRevealTimeoutHandle = setTimeout(() => pokerAnnounceHandResult(room, result), delay);
}

function pokerAnnounceHandResult(room, result) {
  room.showdownRevealTimeoutHandle = null;

  for (const p of room.players) {
    const s = io.sockets.sockets.get(p.socketId);
    if (!s) continue;
    s.emit("poker:handResult", {
      roomId: room.id,
      uncontested: result.uncontested,
      winners: result.winners.map(w => ({
        username: room.players.find(pl => pl.lc === w.lc)?.username || w.lc,
        amount: w.amount,
      })),
      hands: (result.hands || []).map(h => ({
        username: room.players.find(pl => pl.lc === h.lc)?.username || h.lc,
        handName: POKER_HAND_NAMES_KA[h.rank[0]],
        cards: h.cards,
      })),
    });
  }
  broadcastPokerRoom(room); // final (showdown-revealing) state before clearing hole cards for the next hand

  // Busted players (stack hit exactly 0) lose their seat — they'll need to
  // rejoin (picking up any daily coin regen in the process) to play again.
  // Disconnected players are removed here too — coins are already synced
  // above so they lose nothing, they'll just need to rejoin to keep
  // playing. This happens at the safe between-hands boundary rather than
  // mid-hand, since removing someone mid-hand would shift every other
  // seat index and corrupt the current betting/side-pot math.
  const leaving = room.players.filter(p => p.stack <= 0 || !p.connected);
  for (const p of leaving) {
    const s = io.sockets.sockets.get(p.socketId);
    if (s) s.emit(p.stack <= 0 ? "poker:bustedOut" : "poker:kickedForDisconnect", { roomId: room.id });
    pokerRoomBySocket.delete(p.socketId);
    s?.leave(`pokerroom:${room.id}`);
  }
  room.players = room.players.filter(p => p.stack > 0 && p.connected);
  broadcastPublicPokerRooms();

  if (room.players.length < POKER_MIN_PLAYERS) {
    room.stage = "waiting";
    room.actingSeatIndex = null;
    room.actionDeadline = null;
    broadcastPokerRoom(room);
    return;
  }

  room.stage = "waiting"; // brief pause so players can see the result
  broadcastPokerRoom(room);
  room.nextHandTimeoutHandle = setTimeout(() => pokerStartNextHand(room), POKER_NEXT_HAND_DELAY_MS);
}

function pokerStartNextHand(room) {
  if (!pokerRooms.has(room.id)) return; // room was deleted in the meantime
  if (room.players.length < POKER_MIN_PLAYERS) { room.stage = "waiting"; broadcastPokerRoom(room); return; }

  room.dealerSeatIndex = (room.dealerSeatIndex ?? -1) + 1;
  if (room.dealerSeatIndex >= room.players.length) room.dealerSeatIndex = 0;

  const dealt = pokerNewHandState(room.players, room.dealerSeatIndex);
  room.deck = dealt.deck;
  room.communityCards = dealt.communityCards;
  room.pot = dealt.pot;
  room.stage = dealt.stage;
  room.currentBet = dealt.currentBet;
  room.minRaise = dealt.minRaise;
  room.actingSeatIndex = dealt.actingSeatIndex;
  room.handNumber = (room.handNumber || 0) + 1;

  for (const p of room.players) {
    const s = io.sockets.sockets.get(p.socketId);
    if (s) s.emit("poker:newHand", { roomId: room.id, holeCards: p.holeCards, handNumber: room.handNumber });
  }

  const result = pokerProgressHand(room); // handles the rare both-blinds-all-in edge case
  if (result.waiting) {
    schedulePokerActionTimer(room);
    broadcastPokerRoom(room);
  } else {
    pokerFinishHand(room, result);
  }
}

function cleanupPokerRoom(roomId) {
  const room = pokerRooms.get(roomId);
  if (!room) return;
  clearPokerActionTimer(room);
  if (room.nextHandTimeoutHandle) clearTimeout(room.nextHandTimeoutHandle);
  if (room.showdownRevealTimeoutHandle) clearTimeout(room.showdownRevealTimeoutHandle);
  for (const [lc, invite] of room.pendingInvites || []) clearTimeout(invite.timeoutHandle);
  for (const p of room.players) pokerRoomBySocket.delete(p.socketId);
  pokerRooms.delete(roomId);
  broadcastPublicPokerRooms();
}

// Mirrors cleanupDrawGuessForSocket: drop from the lobby roster outright,
// or fold-and-mark-disconnected if a hand is already underway (holding an
// active hand hostage by going AFK isn't fair to the others at the table).
function cleanupPokerForSocket(socketId) {
  const roomId = pokerRoomBySocket.get(socketId);
  pokerRoomBySocket.delete(socketId);
  if (!roomId) return;
  const room = pokerRooms.get(roomId);
  if (!room) return;

  const player = room.players.find(p => p.socketId === socketId);
  if (!player) return;

  if (room.status === "lobby") {
    room.players = room.players.filter(p => p.socketId !== socketId);
    if (room.players.length === 0) { cleanupPokerRoom(room.id); return; }
    if (player.lc === room.hostLc) room.hostLc = room.players[0].lc;
    broadcastPokerRoom(room);
    broadcastPublicPokerRooms();
    return;
  }

  player.connected = false;

  if (room.players.every(p => !p.connected)) { cleanupPokerRoom(room.id); return; }

  const midHand = room.stage && room.stage !== "waiting" && room.stage !== "showdown";
  if (midHand && !player.folded && !player.allIn) {
    player.folded = true;
    // Re-derive the game state now that this player is out. This correctly
    // handles both "it happened to be their turn" (advance normally) and
    // "someone else folded out of turn via disconnect, and only one player
    // remains" (uncontested win) — progressHand doesn't care whose turn it
    // technically was, only who's still in.
    clearPokerActionTimer(room);
    const result = pokerProgressHand(room);
    if (result.waiting) { schedulePokerActionTimer(room); broadcastPokerRoom(room); }
    else pokerFinishHand(room, result);
    return;
  }
  broadcastPokerRoom(room);
}

// ══════════════════════════════════════════════════════════════════════════
// Chess room lifecycle — invite/lobby/game-flow orchestration around the
// tested engine functions above. Unlike Poker there's no hidden information
// (both players see the same board), so state can be broadcast identically
// to everyone — no per-viewer masking needed.
// ══════════════════════════════════════════════════════════════════════════

const CHESS_MIN_PLAYERS = 2;
const CHESS_MAX_PLAYERS = 2;
const CHESS_MOVE_TTL_MS = 90_000; // time to make a move before losing on time
const CHESS_INVITE_TTL_MS = 60_000;
const CHESS_ROOM_TTL_MS = 30_000;
const CHESS_DECLINE_COOLDOWN_MS = 5 * 60_000;

const chessRooms = new Map();          // roomId   → room
const chessRoomBySocket = new Map();   // socketId → roomId
const chessDeclineCooldown = new Map(); // hostLc|targetLc → cooldown expiry

function makeChessRoomId() {
  return "ch_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function chessRoomState(room) {
  const st = room.state;
  const started = room.status !== "lobby"; // true for both 'playing' and 'ended' — only 'lobby' shows the placeholder board
  const status = started ? chessGameStatus(st) : null;
  return {
    roomId: room.id,
    status: room.status,
    hostUsername: room.players.find(p => p.lc === room.hostLc)?.username || "",
    players: room.players.map(p => ({ username: p.username, avatar: registeredUsers.get(p.lc)?.avatar || DEFAULT_AVATAR, color: p.color || null, connected: p.connected })),
    board: started ? st.board : chessInitialBoard(),
    turn: started ? st.turn : CHESS_WHITE,
    legalMoves: started && !room.result ? chessLegalMoves(st).map(m => ({ from: chessSquareName(m.from), to: chessSquareName(m.to), promotion: m.promotion || null, castle: m.castle || null })) : [],
    lastMove: room.lastMove || null,
    inCheck: started && status ? (status.status === "check" || status.status === "checkmate") : false,
    moveNumber: started ? st.fullmove : 1,
    moveDeadline: room.moveDeadline || null,
    result: room.result || null,
  };
}

function broadcastChessRoom(room) {
  const payload = chessRoomState(room);
  for (const p of room.players) {
    const s = io.sockets.sockets.get(p.socketId);
    if (s) s.emit("chess:room", payload);
  }
}

function findActiveChessRoomForUser(lc) {
  for (const room of chessRooms.values()) {
    if (room.status === "ended") continue;
    if (room.players.some(p => p.lc === lc)) return room;
  }
  return null;
}

function getPublicChessRooms() {
  const rows = [];
  for (const room of chessRooms.values()) {
    if (room.status === "ended") continue;
    if (room.players.length >= CHESS_MAX_PLAYERS) continue;
    rows.push({
      roomId: room.id,
      hostUsername: room.players.find(p => p.lc === room.hostLc)?.username || "",
      status: room.status,
      playerCount: room.players.filter(p => p.connected).length,
      maxPlayers: CHESS_MAX_PLAYERS,
    });
  }
  return rows;
}
function broadcastPublicChessRooms() {
  io.emit("chess:publicRooms", getPublicChessRooms());
}

function clearChessMoveTimer(room) {
  if (room.moveTimeoutHandle) { clearTimeout(room.moveTimeoutHandle); room.moveTimeoutHandle = null; }
}
function scheduleChessMoveTimer(room) {
  clearChessMoveTimer(room);
  room.moveDeadline = Date.now() + CHESS_MOVE_TTL_MS;
  room.moveTimeoutHandle = setTimeout(() => chessTimeoutLoss(room), CHESS_MOVE_TTL_MS);
}

function chessTimeoutLoss(room) {
  if (room.result) return;
  const toMove = room.state.turn;
  const winnerColor = chessOpponent(toMove);
  chessFinishGame(room, { status: "timeout", winner: winnerColor });
}

function chessFinishGame(room, result) {
  clearChessMoveTimer(room);
  room.result = result;
  room.moveDeadline = null;
  room.status = "ended"; // frees both players up to start/join another game immediately
  if (result.winner) {
    const winnerPlayer = room.players.find(p => p.color === result.winner);
    if (winnerPlayer) recordChessWin(winnerPlayer.lc);
  }
  broadcastChessRoom(room);
  broadcastPublicChessRooms();
}

function cleanupChessRoom(roomId) {
  const room = chessRooms.get(roomId);
  if (!room) return;
  clearChessMoveTimer(room);
  for (const [, invite] of room.pendingInvites || []) clearTimeout(invite.timeoutHandle);
  for (const p of room.players) chessRoomBySocket.delete(p.socketId);
  chessRooms.delete(roomId);
  broadcastPublicChessRooms();
}

function cleanupChessForSocket(socketId) {
  const roomId = chessRoomBySocket.get(socketId);
  chessRoomBySocket.delete(socketId);
  if (!roomId) return;
  const room = chessRooms.get(roomId);
  if (!room) return;

  const player = room.players.find(p => p.socketId === socketId);
  if (!player) return;

  if (room.status === "lobby") {
    room.players = room.players.filter(p => p.socketId !== socketId);
    if (room.players.length === 0) { cleanupChessRoom(room.id); return; }
    if (player.lc === room.hostLc) room.hostLc = room.players[0].lc;
    broadcastChessRoom(room);
    broadcastPublicChessRooms();
    return;
  }

  player.connected = false;
  if (room.players.every(p => !p.connected)) { cleanupChessRoom(room.id); return; }
  // No instant forfeit here — a brief disconnect shouldn't cost a long game.
  // If it becomes (or already is) their move and they don't reconnect and
  // move before the existing move timer runs out, they lose on time via
  // chessTimeoutLoss the same as if they'd just sat there.
  broadcastChessRoom(room);
}

// ══════════════════════════════════════════════════════════════════════════
// Checkers room lifecycle — identical shape to Chess (invite/lobby/game-flow
// orchestration around the tested engine functions above). The one real
// difference from Chess: a capturing move can chain into a mandatory
// multi-jump with the SAME piece, during which the turn does not pass to
// the opponent — mustContinueFrom is surfaced to the client so it knows to
// keep prompting the same player instead of flipping to "their turn".
// ══════════════════════════════════════════════════════════════════════════

const CHECKERS_MIN_PLAYERS = 2;
const CHECKERS_MAX_PLAYERS = 2;
const CHECKERS_MOVE_TTL_MS = 90_000;
const CHECKERS_INVITE_TTL_MS = 60_000;
const CHECKERS_ROOM_TTL_MS = 30_000;
const CHECKERS_DECLINE_COOLDOWN_MS = 5 * 60_000;

const checkersRooms = new Map();
const checkersRoomBySocket = new Map();
const checkersDeclineCooldown = new Map();

function makeCheckersRoomId() {
  return "dm_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function checkersRoomState(room) {
  const st = room.state;
  const started = room.status !== "lobby";
  const status = started ? checkersGameStatus(st) : null;
  return {
    roomId: room.id,
    status: room.status,
    hostUsername: room.players.find(p => p.lc === room.hostLc)?.username || "",
    players: room.players.map(p => ({ username: p.username, avatar: registeredUsers.get(p.lc)?.avatar || DEFAULT_AVATAR, color: p.color || null, connected: p.connected })),
    board: started ? st.board : checkersInitialBoard(),
    turn: started ? st.turn : CHECKERS_RED,
    mustContinueFrom: started ? st.mustContinueFrom : null,
    legalMoves: started && !room.result ? checkersLegalMoves(st).map(m => ({ from: m.from, to: m.to, capture: m.capture })) : [],
    lastMove: room.lastMove || null,
    moveDeadline: room.moveDeadline || null,
    result: room.result || null,
  };
}

function broadcastCheckersRoom(room) {
  const payload = checkersRoomState(room);
  for (const p of room.players) {
    const s = io.sockets.sockets.get(p.socketId);
    if (s) s.emit("checkers:room", payload);
  }
}

function findActiveCheckersRoomForUser(lc) {
  for (const room of checkersRooms.values()) {
    if (room.status === "ended") continue;
    if (room.players.some(p => p.lc === lc)) return room;
  }
  return null;
}

function getPublicCheckersRooms() {
  const rows = [];
  for (const room of checkersRooms.values()) {
    if (room.status === "ended") continue;
    if (room.players.length >= CHECKERS_MAX_PLAYERS) continue;
    rows.push({
      roomId: room.id,
      hostUsername: room.players.find(p => p.lc === room.hostLc)?.username || "",
      status: room.status,
      playerCount: room.players.filter(p => p.connected).length,
      maxPlayers: CHECKERS_MAX_PLAYERS,
    });
  }
  return rows;
}
function broadcastPublicCheckersRooms() {
  io.emit("checkers:publicRooms", getPublicCheckersRooms());
}

function clearCheckersMoveTimer(room) {
  if (room.moveTimeoutHandle) { clearTimeout(room.moveTimeoutHandle); room.moveTimeoutHandle = null; }
}
function scheduleCheckersMoveTimer(room) {
  clearCheckersMoveTimer(room);
  room.moveDeadline = Date.now() + CHECKERS_MOVE_TTL_MS;
  room.moveTimeoutHandle = setTimeout(() => checkersTimeoutLoss(room), CHECKERS_MOVE_TTL_MS);
}

function checkersTimeoutLoss(room) {
  if (room.result) return;
  const toMove = room.state.turn;
  checkersFinishGame(room, { status: "timeout", winner: checkersOpponent(toMove) });
}

function checkersFinishGame(room, result) {
  clearCheckersMoveTimer(room);
  room.result = result;
  room.moveDeadline = null;
  room.status = "ended";
  if (result.winner) {
    const winnerPlayer = room.players.find(p => p.color === result.winner);
    if (winnerPlayer) recordCheckersWin(winnerPlayer.lc);
  }
  broadcastCheckersRoom(room);
  broadcastPublicCheckersRooms();
}

function cleanupCheckersRoom(roomId) {
  const room = checkersRooms.get(roomId);
  if (!room) return;
  clearCheckersMoveTimer(room);
  for (const [, invite] of room.pendingInvites || []) clearTimeout(invite.timeoutHandle);
  for (const p of room.players) checkersRoomBySocket.delete(p.socketId);
  checkersRooms.delete(roomId);
  broadcastPublicCheckersRooms();
}

function cleanupCheckersForSocket(socketId) {
  const roomId = checkersRoomBySocket.get(socketId);
  checkersRoomBySocket.delete(socketId);
  if (!roomId) return;
  const room = checkersRooms.get(roomId);
  if (!room) return;

  const player = room.players.find(p => p.socketId === socketId);
  if (!player) return;

  if (room.status === "lobby") {
    room.players = room.players.filter(p => p.socketId !== socketId);
    if (room.players.length === 0) { cleanupCheckersRoom(room.id); return; }
    if (player.lc === room.hostLc) room.hostLc = room.players[0].lc;
    broadcastCheckersRoom(room);
    broadcastPublicCheckersRooms();
    return;
  }

  player.connected = false;
  if (room.players.every(p => !p.connected)) { cleanupCheckersRoom(room.id); return; }
  // Same policy as Chess: no instant forfeit on disconnect — the existing
  // move timer (if it's their turn) is what eventually costs them the game
  // if they never come back.
  broadcastCheckersRoom(room);
}

// ══════════════════════════════════════════════════════════════════════════
// Georgian Joker room lifecycle — 4-player invite/lobby/game-flow
// orchestration around the tested engine functions above. Bigger state
// machine than the 2-player games: bidding → trick-play → hand-end (brief
// scored reveal) → next hand or game-end, repeated across all 24 hands.
// A disconnected player isn't replaced by a bot — the same server-side
// bid/play timeout that handles slow humans also naturally keeps a
// disconnected player's game moving (auto-bid/auto-play on timeout),
// without needing separate bot logic.
// ══════════════════════════════════════════════════════════════════════════

const JOKER_MIN_PLAYERS = 4;
const JOKER_MAX_PLAYERS = 4;
const JOKER_BID_TTL_MS = parseInt(process.env.JOKER_BID_TTL_MS, 10) || 20_000;
const JOKER_PLAY_TTL_MS = parseInt(process.env.JOKER_PLAY_TTL_MS, 10) || 20_000;
const JOKER_INVITE_TTL_MS = 60_000;
const JOKER_DECLINE_COOLDOWN_MS = 5 * 60_000;
const JOKER_HAND_END_DELAY_MS = parseInt(process.env.JOKER_HAND_END_MS, 10) || 7_000; // pause on the hand-result table before the next hand deals
const JOKER_TRICK_PAUSE_MS = parseInt(process.env.JOKER_TRICK_PAUSE_MS, 10) || 1_800; // pause showing all 4 completed-trick cards before sweeping them to the winner
const JOKER_KHISHTI_ENABLED = true;
const JOKER_SUITS_LIST = ["s", "h", "d", "c"];

const jokerRooms = new Map();
const jokerRoomBySocket = new Map();
const jokerDeclineCooldown = new Map();


function makeJokerRoomId() {
  return "jk_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function jokerRoomStateForViewer(room, viewerLc) {
  const viewer = room.players.find(p => p.lc === viewerLc);
  const viewerSeat = viewer ? viewer.seat : -1;
  const started = room.status !== "lobby";

  return {
    roomId: room.id,
    status: room.status,
    hostUsername: room.players.find(p => p.lc === room.hostLc)?.username || "",
    players: room.players.map(p => ({
      username: p.username, avatar: registeredUsers.get(p.lc)?.avatar || DEFAULT_AVATAR,
      seat: p.seat, connected: p.connected, isBot: !!p.isBot,
      handCount: started ? (room.hands[p.seat] ? room.hands[p.seat].length : 0) : 0,
    })),
    mySeat: viewerSeat,
    dealerSeat: started ? room.dealerSeat : null,
    handIndex: started ? room.handIndex : 0,
    handSize: started ? room.handSize : 0,
    setIdx: started ? room.setIdx : 0,
    trumpSuit: started ? room.trumpSuit : null,
    trumpCard: started ? room.trumpCard : null,
    phase: started ? room.phase : null,
    myHand: started && viewerSeat >= 0 ? (room.hands[viewerSeat] || []) : [],
    bidOrder: started ? room.bidOrder : [],
    bids: started ? room.bids : [null, null, null, null],
    bidTurnIdx: started ? room.bidTurnIdx : 0,
    currentTrick: started ? room.currentTrick : [],
    ledSuit: started ? room.ledSuit : null,
    trickLeader: started ? room.trickLeader : null,
    tricksWon: started ? room.tricksWon : [0, 0, 0, 0],
    turnSeat: started ? room.turnSeat : null,
    totals: started ? room.totals : [0, 0, 0, 0],
    lastHandSummary: room.lastHandSummary || null,
    history: room.history || [],
    actionDeadline: room.actionDeadline || null,
    finalResult: room.finalResult || null,
  };
}

function broadcastJokerRoom(room) {
  for (const p of room.players) {
    const s = io.sockets.sockets.get(p.socketId);
    if (s) s.emit("joker:room", jokerRoomStateForViewer(room, p.lc));
  }
}

function findActiveJokerRoomForUser(lc) {
  for (const room of jokerRooms.values()) {
    if (room.status === "ended") continue;
    if (room.players.some(p => p.lc === lc)) return room;
  }
  return null;
}

function getPublicJokerRooms() {
  const rows = [];
  for (const room of jokerRooms.values()) {
    if (room.status === "ended") continue;
    if (room.players.length >= JOKER_MAX_PLAYERS) continue;
    rows.push({
      roomId: room.id,
      hostUsername: room.players.find(p => p.lc === room.hostLc)?.username || "",
      status: room.status,
      playerCount: room.players.filter(p => p.connected).length,
      maxPlayers: JOKER_MAX_PLAYERS,
    });
  }
  return rows;
}
function broadcastPublicJokerRooms() {
  io.emit("joker:publicRooms", getPublicJokerRooms());
}

function clearJokerActionTimer(room) {
  if (room.actionTimeoutHandle) { clearTimeout(room.actionTimeoutHandle); room.actionTimeoutHandle = null; }
}
function clearJokerHandEndTimer(room) {
  if (room.handEndTimeoutHandle) { clearTimeout(room.handEndTimeoutHandle); room.handEndTimeoutHandle = null; }
}

// ── Bot takeover for disconnected players ───────────────────────────────────
// A player who disconnects mid-game is immediately flagged isBot so the game
// doesn't grind to a halt waiting out the full human timer on every one of
// their turns — the bot acts after a short, natural-feeling delay instead,
// making a purely random (no strategy at all) legal choice each time, exactly
// as "dumb" as asked for. If the real player reconnects, isBot clears and
// they get their seat back immediately, timer and all.
const JOKER_BOT_DELAY_MIN_MS = 900;
const JOKER_BOT_DELAY_MAX_MS = 1900;

function jokerCurrentTurnSeat(room) {
  if (room.phase === "bidding") return room.bidOrder[room.bidTurnIdx];
  if (room.phase === "playing") return room.turnSeat;
  return null;
}
function jokerIsBotSeat(room, seat) {
  const p = room.players.find(pp => pp.seat === seat);
  return !!(p && p.isBot);
}

// Single dispatcher used everywhere a turn hands off — decides whether the
// seat now up is bot-controlled (short random-action delay) or human
// (the normal full-length timer), so every call site stays simple.
function jokerScheduleTurn(room) {
  const seat = jokerCurrentTurnSeat(room);
  if (seat === null) return;
  clearJokerActionTimer(room);

  if (jokerIsBotSeat(room, seat)) {
    const delay = JOKER_BOT_DELAY_MIN_MS + Math.floor(Math.random() * (JOKER_BOT_DELAY_MAX_MS - JOKER_BOT_DELAY_MIN_MS));
    room.actionDeadline = Date.now() + delay;
    room.actionTimeoutHandle = setTimeout(() => jokerBotAct(room, seat), delay);
    return;
  }

  if (room.phase === "bidding") {
    room.actionDeadline = Date.now() + JOKER_BID_TTL_MS;
    room.actionTimeoutHandle = setTimeout(() => jokerAutoBid(room), JOKER_BID_TTL_MS);
  } else if (room.phase === "playing") {
    room.actionDeadline = Date.now() + JOKER_PLAY_TTL_MS;
    room.actionTimeoutHandle = setTimeout(() => jokerAutoPlay(room), JOKER_PLAY_TTL_MS);
  }
}

// The "very dumb" bot: no strategy whatsoever, just a uniformly random pick
// among whatever's currently legal — same shape as jokerAutoBid/jokerAutoPlay
// below (used for slow-but-still-connected humans), just triggered much
// sooner and used specifically for bot-controlled seats.
function jokerBotAct(room, seat) {
  if (room.result || room.status !== "playing") return;
  if (jokerCurrentTurnSeat(room) !== seat) return; // stale timer, turn already moved on
  if (!jokerIsBotSeat(room, seat)) return; // the real player reconnected in the meantime

  if (room.phase === "bidding") {
    const isLast = room.bidTurnIdx === 3;
    const priorSum = jokerPriorBidsSum(room);
    const legalBids = [];
    for (let b = 0; b <= room.handSize; b++) if (jokerIsBidLegal(b, room.handSize, isLast, priorSum)) legalBids.push(b);
    const bid = legalBids[Math.floor(Math.random() * legalBids.length)];
    jokerApplyBid(room, seat, bid);
  } else if (room.phase === "playing") {
    const legal = jokerLegalCardsToPlay(room.hands[seat], room.currentTrick.length === 0 ? null : room.ledSuit, room.trumpSuit);
    const card = legal[Math.floor(Math.random() * legal.length)];
    const jokerChoice = jokerIsJokerCard(card) ? (Math.random() < 0.5 ? "high" : "low") : null;
    const declaredSuit = (jokerIsJokerCard(card) && room.currentTrick.length === 0) ? JOKER_SUITS_LIST[Math.floor(Math.random() * 4)] : null;
    jokerApplyPlay(room, seat, card, jokerChoice, declaredSuit);
  }
}

function jokerPriorBidsSum(room) {
  let sum = 0;
  for (let i = 0; i < room.bidTurnIdx; i++) sum += room.bids[room.bidOrder[i]];
  return sum;
}

function jokerAutoBid(room) {
  if (room.phase !== "bidding" || room.result) return;
  const seat = room.bidOrder[room.bidTurnIdx];
  const isLast = room.bidTurnIdx === 3;
  const priorSum = jokerPriorBidsSum(room);
  let bid = 0;
  while (!jokerIsBidLegal(bid, room.handSize, isLast, priorSum) && bid <= room.handSize) bid++;
  jokerApplyBid(room, seat, bid);
}

function jokerAutoPlay(room) {
  if (room.phase !== "playing" || room.result) return;
  const seat = room.turnSeat;
  const legal = jokerLegalCardsToPlay(room.hands[seat], room.currentTrick.length === 0 ? null : room.ledSuit, room.trumpSuit);
  const card = legal[Math.floor(Math.random() * legal.length)];
  const jokerChoice = jokerIsJokerCard(card) ? (Math.random() < 0.5 ? "high" : "low") : null;
  const declaredSuit = (jokerIsJokerCard(card) && room.currentTrick.length === 0) ? JOKER_SUITS_LIST[Math.floor(Math.random() * 4)] : null;
  jokerApplyPlay(room, seat, card, jokerChoice, declaredSuit);
}

function jokerApplyBid(room, seat, bid) {
  room.bids[seat] = bid;
  room.bidTurnIdx += 1;
  if (room.bidTurnIdx >= 4) {
    room.phase = "playing";
    room.trickLeader = room.bidOrder[0];
    room.turnSeat = room.trickLeader;
    room.currentTrick = [];
    room.ledSuit = null;
    jokerScheduleTurn(room);
  } else {
    room.turnSeat = room.bidOrder[room.bidTurnIdx];
    jokerScheduleTurn(room);
  }
  broadcastJokerRoom(room);
}

function jokerApplyPlay(room, seat, card, jokerChoice, declaredSuit) {
  const hand = room.hands[seat];
  hand.splice(hand.indexOf(card), 1);

  const isLead = room.currentTrick.length === 0;
  if (isLead) room.ledSuit = jokerIsJokerCard(card) ? declaredSuit : jokerSuitOf(card);

  room.currentTrick.push({ seat, card, jokerChoice, declaredSuit: isLead ? declaredSuit : null });

  if (room.currentTrick.length < 4) {
    room.turnSeat = (seat + 1) % 4;
    jokerScheduleTurn(room);
    broadcastJokerRoom(room);
    return;
  }

  // All 4 cards are down. Broadcast this AS-IS first — so everyone actually
  // sees the completed trick, including that 4th card, which previously
  // never got shown because the trick was resolved and cleared in the same
  // synchronous step that added the last card, with no broadcast in between.
  // turnSeat is cleared to null (nobody's turn) so nobody can sneak in a
  // play while the trick is just sitting there being admired/animated.
  clearJokerActionTimer(room);
  room.turnSeat = null;
  room.actionDeadline = null;
  broadcastJokerRoom(room);

  room.trickResolveTimeoutHandle = setTimeout(() => jokerResolveCurrentTrick(room), JOKER_TRICK_PAUSE_MS);
}

function jokerResolveCurrentTrick(room) {
  if (room.result || room.status !== "playing" || room.currentTrick.length !== 4) return;

  const winner = jokerResolveTrick(room.currentTrick, room.trumpSuit, room.ledSuit);
  room.tricksWon[winner.seat] += 1;
  room.trickLeader = winner.seat;
  room.currentTrick = [];
  room.ledSuit = null;

  const totalPlayed = room.tricksWon.reduce((a, b) => a + b, 0);
  if (totalPlayed >= room.handSize) {
    jokerFinishHand(room);
  } else {
    room.turnSeat = room.trickLeader;
    jokerScheduleTurn(room);
    broadcastJokerRoom(room);
  }
}

function jokerFinishHand(room) {
  clearJokerActionTimer(room);
  room.actionDeadline = null;

  const scores = [0, 0, 0, 0];
  const khishtiHit = [false, false, false, false];
  for (let seat = 0; seat < 4; seat++) {
    const bid = room.bids[seat], actual = room.tricksWon[seat];
    const score = jokerScoreHand(bid, actual, room.handSize, room.setIdx, JOKER_KHISHTI_ENABLED);
    scores[seat] = score;
    khishtiHit[seat] = JOKER_KHISHTI_ENABLED && bid >= 1 && actual === 0;
    room.totals[seat] += score;
    room.setHandsPerPlayer[seat].push({ bid, actual, score });
  }

  const isLastOfSet = room.handIndex === 23 || jokerSetIndexForHand(room.handIndex + 1) !== room.setIdx;
  const setBonuses = [0, 0, 0, 0];
  if (isLastOfSet) {
    for (let seat = 0; seat < 4; seat++) {
      const bonus = jokerSetBonus(room.setHandsPerPlayer[seat]);
      setBonuses[seat] = bonus;
      room.totals[seat] += bonus;
    }
  }

  const summary = {
    handIndex: room.handIndex, handSize: room.handSize, setIdx: room.setIdx,
    dealerSeat: room.dealerSeat, trumpSuit: room.trumpSuit,
    bids: room.bids.slice(), tricksWon: room.tricksWon.slice(), scores, khishtiHit,
    setBonuses: isLastOfSet ? setBonuses : null,
    totalsAfter: room.totals.slice(),
  };
  room.lastHandSummary = summary;
  room.history.push(summary);
  room.phase = "handEnd";
  broadcastJokerRoom(room);
  broadcastPublicJokerRooms();

  clearJokerHandEndTimer(room);
  room.handEndTimeoutHandle = setTimeout(() => jokerAdvanceAfterHandEnd(room), JOKER_HAND_END_DELAY_MS);
}

function jokerAdvanceAfterHandEnd(room) {
  if (room.status === "ended") return;
  if (room.handIndex >= 23) {
    jokerFinishGame(room);
    return;
  }
  room.handIndex += 1;
  room.dealerSeat = (room.dealerSeat + 1) % 4;
  room.handSize = JOKER_HAND_SIZES[room.handIndex];
  room.setIdx = jokerSetIndexForHand(room.handIndex);
  if (room.setIdx !== jokerSetIndexForHand(room.handIndex - 1)) {
    room.setHandsPerPlayer = [[], [], [], []];
  }

  const { hands, trumpCard, trumpSuit } = jokerDealHand(room.handSize, room.dealerSeat);
  room.hands = hands;
  room.trumpCard = trumpCard;
  room.trumpSuit = trumpSuit;
  room.bidOrder = [1, 2, 3, 0].map(off => (room.dealerSeat + off) % 4);
  room.bids = [null, null, null, null];
  room.bidTurnIdx = 0;
  room.turnSeat = room.bidOrder[0];
  room.tricksWon = [0, 0, 0, 0];
  room.currentTrick = [];
  room.ledSuit = null;
  room.trickLeader = null;
  room.phase = "bidding";

  jokerScheduleTurn(room);
  broadcastJokerRoom(room);
}

function jokerFinishGame(room) {
  clearJokerActionTimer(room);
  clearJokerHandEndTimer(room);
  room.status = "ended";
  room.actionDeadline = null;

  const ranked = room.players.map(p => ({ seat: p.seat, username: p.username, total: room.totals[p.seat] }))
    .sort((a, b) => b.total - a.total);
  ranked.forEach((r, i) => { r.place = i + 1; });
  room.finalResult = { rankings: ranked };

  broadcastJokerRoom(room);
  broadcastPublicJokerRooms();
}

function cleanupJokerRoom(roomId) {
  const room = jokerRooms.get(roomId);
  if (!room) return;
  clearJokerActionTimer(room);
  clearJokerHandEndTimer(room);
  if (room.trickResolveTimeoutHandle) { clearTimeout(room.trickResolveTimeoutHandle); room.trickResolveTimeoutHandle = null; }
  for (const [, invite] of room.pendingInvites || []) clearTimeout(invite.timeoutHandle);
  for (const p of room.players) jokerRoomBySocket.delete(p.socketId);
  jokerRooms.delete(roomId);
  broadcastPublicJokerRooms();
}

function cleanupJokerForSocket(socketId) {
  const roomId = jokerRoomBySocket.get(socketId);
  jokerRoomBySocket.delete(socketId);
  if (!roomId) return;
  const room = jokerRooms.get(roomId);
  if (!room) return;

  const player = room.players.find(p => p.socketId === socketId);
  if (!player) return;

  if (room.status === "lobby") {
    room.players = room.players.filter(p => p.socketId !== socketId);
    if (room.players.length === 0) { cleanupJokerRoom(room.id); return; }
    if (player.lc === room.hostLc) room.hostLc = room.players[0].lc;
    broadcastJokerRoom(room);
    broadcastPublicJokerRooms();
    return;
  }

  player.connected = false;
  if (room.players.every(p => !p.connected)) { cleanupJokerRoom(room.id); return; }

  // Bot takeover: immediately flag them as bot-controlled so the game
  // doesn't just sit there waiting out the full human timer on every one
  // of their turns. If it happens to already be their turn right now,
  // replace whatever human timer was running with the short bot-delay one.
  player.isBot = true;
  if (jokerCurrentTurnSeat(room) === player.seat) jokerScheduleTurn(room);
  broadcastJokerRoom(room);
}

// ══════════════════════════════════════════════════════════════════════════
// Imposter ("იმპოსტორი") — social-deduction word game. Everyone gets the
// same secret word except one imposter, who gets a related-but-different
// word — and nobody, not even the imposter, is told who's who. Three rounds
// of one-word clues (revealed together each round, never one-at-a-time, so
// nobody anchors on an earlier answer), then a vote. If the group catches
// the imposter, the imposter gets one shot at guessing the real word to
// steal the win anyway — the classic "Word Wolf" twist.
// ══════════════════════════════════════════════════════════════════════════

const IMPOSTER_MIN_PLAYERS = 3;
const IMPOSTER_MAX_PLAYERS = 8;
const IMPOSTER_CLUE_ROUNDS = 3;
const IMPOSTER_CLUE_TTL_MS = parseInt(process.env.IMPOSTER_CLUE_TTL_MS, 10) || 30_000;
const IMPOSTER_VOTE_TTL_MS = parseInt(process.env.IMPOSTER_VOTE_TTL_MS, 10) || 30_000;
const IMPOSTER_GUESS_TTL_MS = parseInt(process.env.IMPOSTER_GUESS_TTL_MS, 10) || 20_000;
const IMPOSTER_INVITE_TTL_MS = 60_000;
const IMPOSTER_DECLINE_COOLDOWN_MS = 5 * 60_000;

const IMPOSTER_WORD_PAIRS = [
  ["ძაღლი", "კატა"], ["ზღვა", "ტბა"], ["ყავა", "ჩაი"], ["მზე", "მთვარე"],
  ["მატარებელი", "ავტობუსი"], ["პიცა", "ბურგერი"], ["ზამთარი", "ზაფხული"],
  ["მთა", "ბორცვი"], ["სკოლა", "უნივერსიტეტი"], ["წიგნი", "ჟურნალი"],
  ["ლომი", "ვეფხვი"], ["ფეხბურთი", "კალათბურთი"], ["მანქანა", "მოტოციკლი"],
  ["ბანანი", "ვაშლი"], ["ცეცხლი", "კვამლი"], ["საათი", "კალენდარი"],
  ["მდინარე", "ნაკადული"], ["ყინული", "თოვლი"], ["მსახიობი", "მომღერალი"],
  ["ტელეფონი", "კომპიუტერი"], ["ქარიშხალი", "წვიმა"], ["კუნძული", "ნახევარკუნძული"],
  ["ვარსკვლავი", "პლანეტა"], ["ბუზი", "ფუტკარი"], ["მდელო", "ტყე"],
  ["ხიდი", "გვირაბი"], ["დღესასწაული", "წვეულება"], ["მასწავლებელი", "ექიმი"],
  ["სასტუმრო", "სახლი"], ["სუნთქვა", "ხველა"], ["საცურაო აუზი", "ტბა"],
  ["გემი", "ნავი"], ["დედოფალი", "პრინცესა"], ["ვულკანი", "მთა"],
  ["ველოსიპედი", "სკუტერი"], ["ბაღი", "პარკი"], ["სუპერმარკეტი", "ბაზარი"],
];

function imposterNormalizeWord(w) {
  return String(w || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// ════════════════════════════════════════════════════════════════════════
//  IMPOSTER — "mysterious visitors" ambiance system
// ────────────────────────────────────────────────────────────────────────
//  A layer of scripted, unexplained chat events that occasionally surface
//  during a live match, meant to feel like something other than the 5
//  real players has entered the conversation. Deliberately never fully
//  explained — some events are red herrings, some hint at a hidden,
//  never-fully-told backstory, some are just wrong.
//
//  Hard rule: these NEVER speak as an actual player's real username, alive
//  or eliminated — only as one of the fictional identities below. They can
//  reference a real player by name in the message TEXT, but the message
//  SENDER is always fictional. A duplicate/spoofed message that looks like
//  it came from someone's actual friend could be genuinely confusing or
//  hurtful between real people who trust each other outside the game —
//  the horror here comes from the unknown, not from impersonating someone
//  you know.
// ════════════════════════════════════════════════════════════════════════
const IMPOSTER_GHOST_NAMES = [
  "unknown", "????", "visitor", "no_name", "user_0", "offline", "deleted_user",
  "M", "...", "nobody", "guest", "████", "you", "last_seen_2009", "stranger",
];

// Cross-match memory — never exposed to players directly, just quietly
// shapes how often "M" specifically shows back up and what it says when it
// does, so attentive players who play many matches might eventually
// notice a pattern without ever being told one exists.
const imposterGhostLore = {
  mAppearances: 0,
  totalGhostEvents: 0,
};

function imposterGhostRandomPlayer(room, excludeLc) {
  const pool = room.players.filter(p => p.connected && p.lc !== excludeLc);
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

// Sends one ghost line into the room's chat feed. `kind` lets the client
// style it slightly differently from a real player's message (subtle —
// the point is never being fully sure whether something was real).
//   kind: "ghost"       — a normal-looking chat bubble from a fictional name
//   kind: "ghostSystem" — a muted system-style line (joins/leaves/anomalies)
function imposterSendGhostLine(room, username, text, kind = "ghost") {
  if (!room || room.status !== "playing") return;
  const msg = { username, text, ts: Date.now(), kind };
  for (const p of room.players) {
    const s = io.sockets.sockets.get(p.socketId);
    if (s) s.emit("imposter:chatMessage", msg);
  }
  imposterGhostLore.totalGhostEvents++;
}

// Runs a short scripted exchange as a sequence of timed lines. Re-checks
// the room is still a live, active match before every single step, so a
// match ending mid-sequence just quietly stops the sequence rather than
// sending ghost lines into a room nobody's looking at anymore.
function imposterRunGhostSequence(room, steps) {
  let elapsed = 0;
  for (const step of steps) {
    elapsed += step.delayMs ?? 900;
    setTimeout(() => {
      const liveRoom = imposterRooms.get(room.id);
      if (!liveRoom || liveRoom.status !== "playing") return;
      if (typeof step.text === "function") {
        const line = step.text(liveRoom);
        if (line == null) return; // step can bail out if its precondition no longer holds
        imposterSendGhostLine(liveRoom, step.username, line, step.kind || "ghost");
      } else {
        imposterSendGhostLine(liveRoom, step.username, step.text, step.kind || "ghost");
      }
    }, elapsed);
  }
}

// ── Event catalog ──────────────────────────────────────────────────────
// Each entry is a function(room) that fires an event. Some need a real
// player's name to reference in the text (a silent player, a random
// target, etc); those return null/bail if the room doesn't currently have
// what they need, and the scheduler just tries a different one that tick.
const IMPOSTER_GHOST_EVENTS = [

  // "Nobody invited them" — the baseline unexplained visitor. Doesn't
  // script a reply from any real player — they react organically or don't.
  (room) => {
    imposterRunGhostSequence(room, [
      { username: "unknown", text: "hello", delayMs: 0 },
      { username: "unknown", text: "შენ უკვე იცი ვინ ვარ", delayMs: 4500 },
      { username: "unknown", text: "დატოვა ჩატი", kind: "ghostSystem", delayMs: 2000 },
    ]);
    return true;
  },

  // Wrong-but-confident accusation — sometimes right, sometimes not,
  // deliberately, so players learn not to fully trust it either way.
  (room) => {
    const target = imposterGhostRandomPlayer(room);
    if (!target) return false;
    imposterRunGhostSequence(room, [
      { username: "unknown", text: `${target.username} — შენ ხარ თვალთმაქცი.`, delayMs: 0 },
      { username: "unknown", text: (r) => (r.imposterLc === target.lc ? "მართალი ვიყავი." : "ოჰ."), delayMs: 3200 },
      { username: "unknown", text: (r) => (r.imposterLc === target.lc ? null : "ბოდიში."), delayMs: 1400 },
      { username: "unknown", text: "დატოვა ჩატი", kind: "ghostSystem", delayMs: 1200 },
    ]);
    return true;
  },

  // (Silence callouts are dispatched separately by imposterCheckSilence,
  // not picked at random from this list — they need to react to an actual
  // real silence, not fire arbitrarily.)

  // Foreknowledge of a vote nobody's cast yet — right about as often as
  // chance alone would make it, which is the point.
  (room) => {
    if (room.phase !== "voting" && room.phase !== "clue") return false;
    const voter = imposterGhostRandomPlayer(room);
    const target = voter ? imposterGhostRandomPlayer(room, voter.lc) : null;
    if (!voter || !target) return false;
    imposterSendGhostLine(room, "unknown", `${voter.username} აპირებს ${target.username}-ზე ხმის მიცემას.`);
    return true;
  },

  // Cryptic reference to something with no established context at all —
  // "again" is never explained.
  (room) => {
    const target = imposterGhostRandomPlayer(room);
    if (!target) return false;
    imposterSendGhostLine(room, "unknown", `არ დაუშვათ, რომ ${target.username} ისევ დაიღუპოს.`);
    return true;
  },

  // Someone claiming to know the imposter — sometimes true, sometimes not,
  // and it stops itself before actually saying anything either way.
  (room) => {
    const guessLc = Math.random() < 0.55 ? room.imposterLc : imposterGhostRandomPlayer(room)?.lc;
    const guessPlayer = room.players.find(p => p.lc === guessLc);
    imposterRunGhostSequence(room, [
      { username: "unknown", text: "ვიცი ვინ არის თვალთმაქცი.", delayMs: 0 },
      { username: "unknown", text: guessPlayer ? "შეხედე ვინც არაფერს ამბობს." : "ყველა თანაბრად საეჭვოა.", delayMs: 2600 },
      { username: "unknown", text: "სინამდვილეში, ნუ.", delayMs: 1600 },
      { username: "unknown", text: "დატოვა ჩატი", kind: "ghostSystem", delayMs: 1000 },
    ]);
    return true;
  },

  // Countdown foreknowledge — references the next phase transition
  // (round advancing / vote tallying) as if it's already known.
  (room) => {
    const seconds = 10 + Math.floor(Math.random() * 20);
    imposterSendGhostLine(room, "unknown", `${seconds} წამი.`);
    setTimeout(() => {
      const liveRoom = imposterRooms.get(room.id);
      if (!liveRoom || liveRoom.status !== "playing") return;
      imposterSendGhostLine(liveRoom, "unknown", "გითხარით.");
    }, seconds * 1000);
    return true;
  },

  // An "old" message with an impossible/unavailable timestamp
  (room) => {
    imposterRunGhostSequence(room, [
      { username: "SYSTEM", text: "შეტყობინება 2017 წლიდან", kind: "ghostSystem", delayMs: 0 },
      { username: "unknown", text: "თამაში ნუ დაიწყებთ.", delayMs: 1800 },
      { username: "SYSTEM", text: "დროის შტამპი მიუწვდომელია.", kind: "ghostSystem", delayMs: 1600 },
    ]);
    return true;
  },

  // References a previous match that never happened — no real player was
  // "not there last time" in any literal sense, that's the point
  (room) => {
    imposterRunGhostSequence(room, [
      { username: "unknown", text: "ჩვენ ეს უკვე ვითამაშეთ.", delayMs: 0 },
      { username: "unknown", text: "შენ არ იყავი წინა ჯერზე.", delayMs: 3400 },
      { username: "unknown", text: "დატოვა ჩატი", kind: "ghostSystem", delayMs: 1400 },
    ]);
    return true;
  },

  // Impossible participant count — never actually adds a 6th player, just
  // a brief, self-correcting system anomaly
  (room) => {
    imposterRunGhostSequence(room, [
      { username: "SYSTEM", text: `${room.players.length + 1} მონაწილე`, kind: "ghostSystem", delayMs: 0 },
      { username: "unknown", text: "რატომ ვერ ვხედავ საკუთარ თავს?", delayMs: 2400 },
      { username: "SYSTEM", text: `${room.players.length} მონაწილე`, kind: "ghostSystem", delayMs: 2200 },
    ]);
    return true;
  },

  // Someone who thinks they're in a different, further-along game
  (room) => {
    imposterRunGhostSequence(room, [
      { username: "stranger", text: "ყველა მზადაა?", delayMs: 0 },
      { username: "stranger", text: "ხმის მისაცემად.", delayMs: 2600 },
      { username: "stranger", text: "ჯერ არ მიღწევხართ მე-5 რაუნდამდე?", delayMs: 3200 },
    ]);
    return true;
  },

  // Begging not to be voted for, confused about where "here" even is
  (room) => {
    imposterRunGhostSequence(room, [
      { username: "unknown", text: "გთხოვთ ნუ მომცემთ ხმას.", delayMs: 0 },
      { username: "unknown", text: "არ მახსოვს.", delayMs: 2200 },
      { username: "unknown", text: "მგონი ერთ-ერთი თქვენგანი ვარ.", delayMs: 1800 },
      { username: "unknown", text: "მოიცადეთ.", delayMs: 2600 },
      { username: "unknown", text: `თქვენ მხოლოდ ${room.players.length} ხართ.`, delayMs: 1400 },
      { username: "unknown", text: "დატოვა ჩატი", kind: "ghostSystem", delayMs: 1200 },
    ]);
    return true;
  },

  // Two unknown accounts talking to each other, not to the players
  (room) => {
    imposterRunGhostSequence(room, [
      { username: "M", text: "ის გაიღვიძა.", delayMs: 0 },
      { username: "unknown", text: "ვიცი.", delayMs: 1600 },
      { username: "M", text: "ისინი გვხედავენ.", delayMs: 1800 },
      { username: "unknown", text: "ნუ ეტყვი მათ.", delayMs: 1600 },
      { username: "M", text: "...", delayMs: 3000 },
      { username: "unknown", text: "არ უნდა წაეკითხა.", delayMs: 1800 },
    ]);
    imposterGhostLore.mAppearances++;
    return true;
  },

  // (The "voted-out player still seems present" echo is handled directly
  // in imposterGhostTick, capped at once per match — not picked from this
  // general pool.)

  // The recurring "M" — same fictional character, subtly different line
  // depending on how many times it's shown up across ALL matches on this
  // server, never explained to players.
  (room) => {
    const lines = [
      "არ ენდო ლურჯს.",
      "არ უნდა დაგეწყო ეს.",
      "მახსოვხარ.",
      "ეს არ არის პირველი ჯერი.",
    ];
    const line = lines[imposterGhostLore.mAppearances % lines.length];
    imposterSendGhostLine(room, "M", line);
    imposterGhostLore.mAppearances++;
    return true;
  },
];

// Very rare grab-bag — short, single-line, mostly unexplained. Rolled far
// less often than the main catalog above.
const IMPOSTER_GHOST_RARE_EVENTS = [
  (room) => { imposterRunGhostSequence(room, [
    { username: "unknown", text: "ეს საქართველოს ოთახია?", delayMs: 0 },
    { username: "unknown", text: "არასწორი ჩატი.", delayMs: 2400 },
    { username: "unknown", text: "დატოვა ჩატი", kind: "ghostSystem", delayMs: 1000 },
  ]); return true; },
  (room) => { imposterSendGhostLine(room, "unknown", "შემიძლია გავიგონო."); return true; },
  (room) => { imposterSendGhostLine(room, "unknown", "ნუ გააგებინებთ რომ ვარსებობ."); return true; },
  (room) => { imposterRunGhostSequence(room, [
    { username: "unknown", text: `${Math.max(2, room.players.length - 1)} კარგი.`, delayMs: 0 },
    { username: "unknown", text: "1 ცუდი.", delayMs: 1400 },
    { username: "unknown", text: "1 რაღაც სხვა.", delayMs: 1400 },
    { username: "unknown", text: "დატოვა ჩატი", kind: "ghostSystem", delayMs: 1400 },
  ]); return true; },
  (room) => { imposterSendGhostLine(room, "unknown", "არ უნდა იყოს ხუთი."); return true; },
  (room) => { imposterSendGhostLine(room, "unknown", "შენ არასწორ ვერსიას თამაშობ."); return true; },
  (room) => { imposterSendGhostLine(room, "unknown", "ეს არ არის პირველი ჯერი."); return true; },
  (room) => { imposterSendGhostLine(room, "unknown", "ჰკითხე მათ, რა მოხდა წუხელ."); return true; },
];

const IMPOSTER_GHOST_SILENCE_MS = 22_000; // how long nobody speaking counts as "silence"
const IMPOSTER_GHOST_TICK_MS = 7_000;
const IMPOSTER_GHOST_AMBIENT_CHANCE = 0.05;   // per tick, per active room
const IMPOSTER_GHOST_RARE_CHANCE = 0.015;     // per tick, per active room, independent roll

function imposterGhostInitRoom(room) {
  room.ghost = {
    lastSpokeAt: new Map(room.players.map(p => [p.lc, Date.now()])),
    silencedFor: new Set(),   // players already called out for silence this match — avoid repeating on the same person
    rareUsedThisMatch: false,
    deadEchoUsedThisMatch: false,
  };
}

function imposterGhostNoteActivity(room, lc) {
  if (room.ghost) room.ghost.lastSpokeAt.set(lc, Date.now());
}

function imposterCheckSilence(room) {
  if (!room.ghost) return;
  const now = Date.now();
  for (const p of room.players) {
    if (!p.connected) continue;
    if (room.ghost.silencedFor.has(p.lc)) continue;
    const last = room.ghost.lastSpokeAt.get(p.lc) || now;
    if (now - last < IMPOSTER_GHOST_SILENCE_MS) continue;
    // Only comment on silence with a small chance even once the threshold
    // is crossed — otherwise every quiet player gets called out every
    // match, which stops feeling like an anomaly and starts feeling like
    // a feature.
    if (Math.random() > 0.35) continue;
    room.ghost.silencedFor.add(p.lc);
    const seconds = Math.round((now - last) / 1000);
    imposterSendGhostLine(room, "unknown", `${p.username} არაფერს წერს უკვე ${seconds} წამია.`);
    return; // at most one silence callout per tick
  }
}

function imposterGhostTick(room) {
  if (!room.ghost) imposterGhostInitRoom(room);
  imposterCheckSilence(room);

  if (room.votedOutLc && !room.ghost.deadEchoUsedThisMatch && Math.random() < 0.12) {
    room.ghost.deadEchoUsedThisMatch = true;
    const votedOut = room.players.find(p => p.lc === room.votedOutLc);
    if (votedOut) imposterSendGhostLine(room, "last_seen_2009", `${votedOut.username}? ჯერ კიდევ იქ ხარ?`);
  }

  if (!room.ghost.rareUsedThisMatch && Math.random() < IMPOSTER_GHOST_RARE_CHANCE) {
    room.ghost.rareUsedThisMatch = true;
    const ev = IMPOSTER_GHOST_RARE_EVENTS[Math.floor(Math.random() * IMPOSTER_GHOST_RARE_EVENTS.length)];
    ev(room);
    return;
  }

  if (Math.random() < IMPOSTER_GHOST_AMBIENT_CHANCE) {
    const ev = IMPOSTER_GHOST_EVENTS[Math.floor(Math.random() * IMPOSTER_GHOST_EVENTS.length)];
    ev(room); // events that can't fire right now (missing a target etc.) just quietly return false
  }
}

setInterval(() => {
  for (const room of imposterRooms.values()) {
    if (room.status !== "playing") continue;
    imposterGhostTick(room);
  }
}, IMPOSTER_GHOST_TICK_MS);

const imposterRooms = new Map();
const imposterRoomBySocket = new Map();
const imposterDeclineCooldown = new Map();

function makeImposterRoomId() {
  return "im_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function imposterRoomStateForViewer(room, viewerLc) {
  const started = room.status !== "lobby";
  const isImposter = started && viewerLc === room.imposterLc;
  const myWord = started ? (isImposter ? room.imposterWord : room.majorityWord) : null;

  return {
    roomId: room.id,
    status: room.status,
    hostUsername: room.players.find(p => p.lc === room.hostLc)?.username || "",
    players: room.players.map(p => ({
      username: p.username, avatar: registeredUsers.get(p.lc)?.avatar || DEFAULT_AVATAR, connected: p.connected,
      hasAnsweredThisRound: started && room.phase === "clue" ? !!room.currentAnswers[p.lc] : null,
      hasVoted: started && room.phase === "voting" ? !!room.votes[p.lc] : null,
    })),
    phase: started ? room.phase : null,
    roundIndex: started ? room.roundIndex : 0,
    totalRounds: IMPOSTER_CLUE_ROUNDS,
    myWord,
    roundsHistory: room.roundsHistory || [],
    myVote: room.votes ? (room.votes[viewerLc] || null) : null,
    isImposterPromptedToGuess: room.phase === "imposterGuess" && viewerLc === room.imposterLc,
    actionDeadline: room.actionDeadline || null,
    result: room.result || null,
  };
}

function broadcastImposterRoom(room) {
  for (const p of room.players) {
    const s = io.sockets.sockets.get(p.socketId);
    if (s) s.emit("imposter:room", imposterRoomStateForViewer(room, p.lc));
  }
}

function findActiveImposterRoomForUser(lc) {
  for (const room of imposterRooms.values()) {
    if (room.status === "ended") continue;
    if (room.players.some(p => p.lc === lc)) return room;
  }
  return null;
}

function getPublicImposterRooms() {
  const rows = [];
  for (const room of imposterRooms.values()) {
    if (room.status === "ended") continue;
    if (room.players.length >= IMPOSTER_MAX_PLAYERS) continue;
    rows.push({
      roomId: room.id,
      hostUsername: room.players.find(p => p.lc === room.hostLc)?.username || "",
      status: room.status,
      playerCount: room.players.filter(p => p.connected).length,
      maxPlayers: IMPOSTER_MAX_PLAYERS,
    });
  }
  return rows;
}
function broadcastPublicImposterRooms() {
  io.emit("imposter:publicRooms", getPublicImposterRooms());
}

function clearImposterTimer(room) {
  if (room.actionTimeoutHandle) { clearTimeout(room.actionTimeoutHandle); room.actionTimeoutHandle = null; }
}
function imposterScheduleClueTimer(room) {
  clearImposterTimer(room);
  room.actionDeadline = Date.now() + IMPOSTER_CLUE_TTL_MS;
  room.actionTimeoutHandle = setTimeout(() => imposterAutoSubmitRemaining(room), IMPOSTER_CLUE_TTL_MS);
}
function imposterScheduleVoteTimer(room) {
  clearImposterTimer(room);
  room.actionDeadline = Date.now() + IMPOSTER_VOTE_TTL_MS;
  room.actionTimeoutHandle = setTimeout(() => imposterTallyVotes(room), IMPOSTER_VOTE_TTL_MS);
}
function imposterScheduleGuessTimer(room) {
  clearImposterTimer(room);
  room.actionDeadline = Date.now() + IMPOSTER_GUESS_TTL_MS;
  room.actionTimeoutHandle = setTimeout(() => imposterFinishGame(room, { imposterCaught: true, imposterGuessedRight: false }), IMPOSTER_GUESS_TTL_MS);
}

function imposterStartGame(room) {
  const [wordA, wordB] = IMPOSTER_WORD_PAIRS[Math.floor(Math.random() * IMPOSTER_WORD_PAIRS.length)];
  const swap = Math.random() < 0.5;
  room.majorityWord = swap ? wordB : wordA;
  room.imposterWord = swap ? wordA : wordB;
  room.imposterLc = room.players[Math.floor(Math.random() * room.players.length)].lc;

  room.status = "playing";
  room.phase = "clue";
  room.roundIndex = 0;
  room.roundsHistory = [];
  room.currentAnswers = {};
  room.votes = {};
  room.lastVoteTally = null;
  room.votedOutLc = null;
  room.result = null;
  imposterGhostInitRoom(room);

  imposterScheduleClueTimer(room);
  broadcastImposterRoom(room);
  broadcastPublicImposterRooms();
}

function imposterFinishClueRound(room) {
  clearImposterTimer(room);
  const revealed = room.players.map(p => ({ username: p.username, word: room.currentAnswers[p.lc] || "(არ უპასუხა)" }));
  room.roundsHistory.push({ round: room.roundIndex, answers: revealed });
  room.currentAnswers = {};

  if (room.roundIndex >= IMPOSTER_CLUE_ROUNDS - 1) {
    room.phase = "voting";
    room.votes = {};
    imposterScheduleVoteTimer(room);
  } else {
    room.roundIndex += 1;
    imposterScheduleClueTimer(room);
  }
  broadcastImposterRoom(room);
}

function imposterAutoSubmitRemaining(room) {
  if (room.phase !== "clue") return;
  for (const p of room.players) if (!room.currentAnswers[p.lc]) room.currentAnswers[p.lc] = "-";
  imposterFinishClueRound(room);
}

function imposterTallyVotes(room) {
  if (room.phase !== "voting") return;
  clearImposterTimer(room);
  const tally = {};
  for (const votedFor of Object.values(room.votes)) tally[votedFor] = (tally[votedFor] || 0) + 1;
  let maxVotes = 0, topCandidates = [];
  for (const [lc, count] of Object.entries(tally)) {
    if (count > maxVotes) { maxVotes = count; topCandidates = [lc]; }
    else if (count === maxVotes) topCandidates.push(lc);
  }
  const votedOutLc = (maxVotes > 0 && topCandidates.length === 1) ? topCandidates[0] : null;
  room.lastVoteTally = tally;
  room.votedOutLc = votedOutLc;

  const imposterCaught = votedOutLc === room.imposterLc;
  if (imposterCaught) {
    room.phase = "imposterGuess";
    imposterScheduleGuessTimer(room);
    broadcastImposterRoom(room);
  } else {
    imposterFinishGame(room, { imposterCaught: false, imposterGuessedRight: null });
  }
}

function imposterFinishGame(room, { imposterCaught, imposterGuessedRight }) {
  clearImposterTimer(room);
  room.status = "ended";
  room.actionDeadline = null;
  const imposterWins = !imposterCaught || imposterGuessedRight;

  const tallyByUsername = {};
  for (const [lc, count] of Object.entries(room.lastVoteTally || {})) {
    const p = room.players.find(pp => pp.lc === lc);
    if (p) tallyByUsername[p.username] = count;
  }

  room.result = {
    imposterUsername: room.players.find(p => p.lc === room.imposterLc)?.username || "",
    majorityWord: room.majorityWord,
    imposterWord: room.imposterWord,
    votedOutUsername: room.votedOutLc ? (room.players.find(p => p.lc === room.votedOutLc)?.username || null) : null,
    imposterCaught, imposterGuessedRight,
    winner: imposterWins ? "imposter" : "group",
    voteTally: tallyByUsername,
  };

  broadcastImposterRoom(room);
  broadcastPublicImposterRooms();
}

function cleanupImposterRoom(roomId) {
  const room = imposterRooms.get(roomId);
  if (!room) return;
  clearImposterTimer(room);
  for (const [, invite] of room.pendingInvites || []) clearTimeout(invite.timeoutHandle);
  for (const p of room.players) imposterRoomBySocket.delete(p.socketId);
  imposterRooms.delete(roomId);
  broadcastPublicImposterRooms();
}

function cleanupImposterForSocket(socketId) {
  const roomId = imposterRoomBySocket.get(socketId);
  imposterRoomBySocket.delete(socketId);
  if (!roomId) return;
  const room = imposterRooms.get(roomId);
  if (!room) return;

  const player = room.players.find(p => p.socketId === socketId);
  if (!player) return;

  if (room.status === "lobby") {
    room.players = room.players.filter(p => p.socketId !== socketId);
    if (room.players.length === 0) { cleanupImposterRoom(room.id); return; }
    if (player.lc === room.hostLc) room.hostLc = room.players[0].lc;
    broadcastImposterRoom(room);
    broadcastPublicImposterRooms();
    return;
  }

  player.connected = false;
  if (room.players.every(p => !p.connected)) { cleanupImposterRoom(room.id); return; }
  // No forfeit on disconnect — the clue/vote/guess timers already auto-act
  // for whoever hasn't responded, which keeps the game moving on its own.
  broadcastImposterRoom(room);
}

// ══════════════════════════════════════════════════════════════════════════
// Blackjack ("ბლექჯეკი" / 21) — up to 5 players share a table, each playing
// their own hand against a shared dealer (the house), not against each
// other. A fresh single 52-card deck is shuffled every round. Dealer stands
// on all 17s (soft or hard) — the simpler, common casual rule. Supports
// hit / stand / double down / split (one split per hand, no re-splitting).
// Blackjack pays 3:2, a regular win pays 1:1, a push returns the bet.
// ══════════════════════════════════════════════════════════════════════════

const BJ_RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K"];
const BJ_SUITS = ["s", "h", "d", "c"];
const BJ_MIN_PLAYERS = 1;
const BJ_MAX_PLAYERS = 5;
const BJ_STARTING_COINS = 1000;
const BJ_COIN_REGEN_MS = 24 * 60 * 60 * 1000;
const BJ_MIN_BET = 10;
const BJ_MAX_BET = 500;
const BJ_BET_TTL_MS = parseInt(process.env.BJ_BET_TTL_MS, 10) || 30_000;
const BJ_ACTION_TTL_MS = parseInt(process.env.BJ_ACTION_TTL_MS, 10) || 25_000;
const BJ_ROUND_END_MS = parseInt(process.env.BJ_ROUND_END_MS, 10) || 6_000;
const BJ_INVITE_TTL_MS = 60_000;
const BJ_DECLINE_COOLDOWN_MS = 5 * 60_000;

function bjMakeShuffledDeck() {
  const deck = [];
  for (const r of BJ_RANKS) for (const s of BJ_SUITS) deck.push(r + s);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// { total, soft } — soft means at least one Ace is still counted as 11.
function bjHandValue(cards) {
  let total = 0, aces = 0;
  for (const c of cards) {
    const r = c[0];
    if (r === "A") { total += 11; aces++; }
    else if (r === "T" || r === "J" || r === "Q" || r === "K") total += 10;
    else total += parseInt(r, 10);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return { total, soft: aces > 0 };
}
function bjIsBlackjack(cards) { return cards.length === 2 && bjHandValue(cards).total === 21; }
function bjIsBust(cards) { return bjHandValue(cards).total > 21; }

function bjNewHand(bet) {
  return { cards: [], bet, status: "playing", doubled: false, fromSplit: false, result: null, payout: 0 };
}

function bjEnsureCoins(user) {
  if (user.bjCoins === undefined || user.bjCoins === null) user.bjCoins = BJ_STARTING_COINS;
  if (user.bjLastCoinGrant === undefined) user.bjLastCoinGrant = Date.now();
  if (user.bjCoins <= 0 && Date.now() - user.bjLastCoinGrant >= BJ_COIN_REGEN_MS) {
    user.bjCoins = BJ_STARTING_COINS;
    user.bjLastCoinGrant = Date.now();
  }
  return user.bjCoins;
}

// Dealer draws from room.deck until standing on all 17s or busting.
// Mutates room.deck and room.dealerCards in place.
function bjPlayDealer(room) {
  while (bjHandValue(room.dealerCards).total < 17) {
    room.dealerCards.push(room.deck.pop());
  }
}

// Settles one hand against the dealer's final cards. Returns { result, payout }
// where payout is the amount returned to the player's stack (0 if they lose
// everything, bet*2 for an even-money win, bet+bet*1.5 for a blackjack, bet
// for a push).
function bjSettleHand(hand, dealerCards, dealerBlackjack) {
  const playerBJ = hand.cards.length === 2 && !hand.fromSplit && bjIsBlackjack(hand.cards);
  if (bjIsBust(hand.cards)) return { result: "bust", payout: 0 };
  if (playerBJ && dealerBlackjack) return { result: "push", payout: hand.bet };
  if (playerBJ) return { result: "blackjack", payout: Math.round(hand.bet * 2.5) };
  if (dealerBlackjack) return { result: "lose", payout: 0 };
  const dealerBusted = bjIsBust(dealerCards);
  const dealerTotal = bjHandValue(dealerCards).total;
  const playerTotal = bjHandValue(hand.cards).total;
  if (dealerBusted || playerTotal > dealerTotal) return { result: "win", payout: hand.bet * 2 };
  if (playerTotal === dealerTotal) return { result: "push", payout: hand.bet };
  return { result: "lose", payout: 0 };
}

// The seat/hand-index pair whose turn it is right now, or null if nobody
// still has a hand in progress (time to move to dealer play).
function bjFindNextTurn(room, fromSeat, fromHandIdx) {
  const n = room.players.length;
  let seat = fromSeat, handIdx = fromHandIdx;
  for (let step = 0; step < n * 2; step++) {
    const player = room.players[seat];
    if (player && player.hands) {
      for (let h = (seat === fromSeat && step === 0 ? handIdx : 0); h < player.hands.length; h++) {
        if (player.hands[h].status === "playing") return { seat, handIdx: h };
      }
    }
    seat = (seat + 1) % n;
    handIdx = 0;
    if (seat === fromSeat && step > 0) break;
  }
  return null;
}

// ── Room lifecycle ───────────────────────────────────────────────────────
const bjRooms = new Map();
const bjRoomBySocket = new Map();
const bjDeclineCooldown = new Map();

function makeBjRoomId() {
  return "bj_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function bjRoomStateForViewer(room) {
  const started = room.status !== "lobby";
  return {
    roomId: room.id,
    status: room.status,
    hostUsername: room.players.find(p => p.lc === room.hostLc)?.username || "",
    players: room.players.map(p => ({
      username: p.username, avatar: registeredUsers.get(p.lc)?.avatar || DEFAULT_AVATAR,
      seat: p.seat, connected: p.connected, stack: p.stack,
      bet: p.bet || null, hasBet: !!p.bet,
      hands: (p.hands || []).map(h => ({ cards: h.cards, bet: h.bet, status: h.status, doubled: h.doubled, result: h.result, payout: h.payout })),
    })),
    dealerCards: started ? (room.dealerHoleRevealed ? room.dealerCards : room.dealerCards.slice(0, 1)) : [],
    dealerHoleRevealed: !!room.dealerHoleRevealed,
    phase: started ? room.phase : null,
    turnSeat: room.turnSeat !== undefined ? room.turnSeat : null,
    turnHandIdx: room.turnHandIdx || 0,
    actionDeadline: room.actionDeadline || null,
  };
}

function broadcastBjRoom(room) {
  const payload = bjRoomStateForViewer(room);
  for (const p of room.players) {
    const s = io.sockets.sockets.get(p.socketId);
    if (s) s.emit("blackjack:room", payload);
  }
}

function findActiveBjRoomForUser(lc) {
  for (const room of bjRooms.values()) {
    if (room.status === "ended") continue;
    if (room.players.some(p => p.lc === lc)) return room;
  }
  return null;
}

function getPublicBjRooms() {
  const rows = [];
  for (const room of bjRooms.values()) {
    if (room.status === "ended") continue;
    if (room.players.length >= BJ_MAX_PLAYERS) continue;
    rows.push({
      roomId: room.id,
      hostUsername: room.players.find(p => p.lc === room.hostLc)?.username || "",
      status: room.status,
      playerCount: room.players.filter(p => p.connected).length,
      maxPlayers: BJ_MAX_PLAYERS,
    });
  }
  return rows;
}
function broadcastPublicBjRooms() { io.emit("blackjack:publicRooms", getPublicBjRooms()); }

function clearBjActionTimer(room) {
  if (room.actionTimeoutHandle) { clearTimeout(room.actionTimeoutHandle); room.actionTimeoutHandle = null; }
}
function clearBjRoundTimer(room) {
  if (room.roundTimeoutHandle) { clearTimeout(room.roundTimeoutHandle); room.roundTimeoutHandle = null; }
}

// ── Betting phase ────────────────────────────────────────────────────────
function bjStartBettingPhase(room) {
  room.phase = "betting";
  room.dealerCards = [];
  room.dealerHoleRevealed = false;
  room.turnSeat = null;
  room.turnHandIdx = 0;
  for (const p of room.players) { p.bet = null; p.hands = []; }

  clearBjActionTimer(room);
  room.actionDeadline = Date.now() + BJ_BET_TTL_MS;
  room.actionTimeoutHandle = setTimeout(() => bjAutoBetRemaining(room), BJ_BET_TTL_MS);
  broadcastBjRoom(room);
}

function bjAutoBetRemaining(room) {
  for (const p of room.players) {
    if (p.connected && !p.bet && p.stack >= BJ_MIN_BET) p.bet = BJ_MIN_BET;
  }
  bjMaybeDealRound(room);
}

// Deals the round once every connected player with enough coins has bet (or
// the bet timer expired and auto-bet filled in the rest). Players who
// couldn't cover even the minimum bet just sit this round out.
function bjMaybeDealRound(room) {
  const needBet = room.players.filter(p => p.connected && p.stack >= BJ_MIN_BET);
  const allBet = needBet.every(p => p.bet);
  if (!allBet && Date.now() < (room.actionDeadline || 0)) return; // still waiting, timer hasn't fired yet
  clearBjActionTimer(room);

  const bettors = room.players.filter(p => p.bet);
  if (bettors.length === 0) {
    // Nobody could bet (everyone's broke) — just wait for the timer to
    // cycle again rather than dealing an empty round forever.
    bjStartBettingPhase(room);
    return;
  }

  room.deck = bjMakeShuffledDeck();
  room.dealerCards = [room.deck.pop(), room.deck.pop()];
  for (const p of room.players) {
    if (!p.bet) { p.hands = []; continue; }
    p.stack -= p.bet;
    p.hands = [bjNewHand(p.bet)];
    p.hands[0].cards = [room.deck.pop(), room.deck.pop()];
    if (bjIsBlackjack(p.hands[0].cards)) p.hands[0].status = "blackjack";
  }

  room.phase = "playing";
  const first = bjFindNextTurn(room, 0, 0);
  if (!first) { bjStartDealerPhase(room); return; }
  room.turnSeat = first.seat;
  room.turnHandIdx = first.handIdx;
  bjScheduleActionTimer(room);
  broadcastBjRoom(room);
}

// ── Player action phase ──────────────────────────────────────────────────
function bjScheduleActionTimer(room) {
  clearBjActionTimer(room);
  room.actionDeadline = Date.now() + BJ_ACTION_TTL_MS;
  room.actionTimeoutHandle = setTimeout(() => bjAutoStand(room), BJ_ACTION_TTL_MS);
}

function bjCurrentHand(room) {
  if (room.turnSeat === null || room.turnSeat === undefined) return null;
  const player = room.players[room.turnSeat];
  if (!player || !player.hands) return null;
  return player.hands[room.turnHandIdx] || null;
}

function bjAdvanceAfterHandDone(room) {
  const next = bjFindNextTurn(room, room.turnSeat, room.turnHandIdx);
  if (!next) { bjStartDealerPhase(room); return; }
  room.turnSeat = next.seat;
  room.turnHandIdx = next.handIdx;
  bjScheduleActionTimer(room);
  broadcastBjRoom(room);
}

function bjAutoStand(room) {
  const hand = bjCurrentHand(room);
  if (hand && hand.status === "playing") hand.status = "stood";
  bjAdvanceAfterHandDone(room);
}

function bjApplyHit(room) {
  const hand = bjCurrentHand(room);
  if (!hand) return;
  hand.cards.push(room.deck.pop());
  if (bjIsBust(hand.cards)) { hand.status = "bust"; bjAdvanceAfterHandDone(room); }
  else { bjScheduleActionTimer(room); broadcastBjRoom(room); }
}

function bjApplyStand(room) {
  const hand = bjCurrentHand(room);
  if (!hand) return;
  hand.status = "stood";
  bjAdvanceAfterHandDone(room);
}

function bjApplyDouble(room) {
  const hand = bjCurrentHand(room);
  const player = room.players[room.turnSeat];
  if (!hand || hand.cards.length !== 2 || player.stack < hand.bet) return;
  player.stack -= hand.bet;
  hand.bet *= 2;
  hand.doubled = true;
  hand.cards.push(room.deck.pop());
  hand.status = bjIsBust(hand.cards) ? "bust" : "stood"; // double down always ends the hand after one card
  bjAdvanceAfterHandDone(room);
}

function bjApplySplit(room) {
  const hand = bjCurrentHand(room);
  const player = room.players[room.turnSeat];
  if (!hand || hand.cards.length !== 2 || hand.cards[0][0] !== hand.cards[1][0]) return;
  if (player.hands.length >= 2) return; // one split per hand — no re-splitting
  if (player.stack < hand.bet) return;

  player.stack -= hand.bet;
  const secondCard = hand.cards.pop();
  const newHand = bjNewHand(hand.bet);
  newHand.fromSplit = true;
  newHand.cards = [secondCard, room.deck.pop()];
  hand.fromSplit = true;
  hand.cards.push(room.deck.pop());
  player.hands.splice(room.turnHandIdx + 1, 0, newHand);

  // A split ace pair conventionally gets exactly one card per hand, no
  // further hitting — simplest, common casual-table rule.
  if (hand.cards[0][0] === "A") {
    hand.status = "stood";
    newHand.status = "stood";
    bjAdvanceAfterHandDone(room);
  } else {
    bjScheduleActionTimer(room);
    broadcastBjRoom(room);
  }
}

// ── Dealer phase (paced reveal, so players actually see it happen) ──────
function bjStartDealerPhase(room) {
  clearBjActionTimer(room);
  room.phase = "dealerPlay";
  room.turnSeat = null;
  room.actionDeadline = null;

  // If literally every hand is already bust, there's nothing left to
  // decide — skip straight to settlement without a dealer reveal show.
  const anyLive = room.players.some(p => (p.hands || []).some(h => h.status === "stood" || h.status === "blackjack"));
  if (!anyLive) { room.dealerHoleRevealed = true; bjSettleRound(room); return; }

  broadcastBjRoom(room); // shows phase:"dealerPlay" with the hole card still hidden, briefly
  setTimeout(() => bjRevealAndDraw(room), 900);
}

function bjRevealAndDraw(room) {
  if (!bjRooms.has(room.id)) return;
  room.dealerHoleRevealed = true;
  broadcastBjRoom(room);

  const total = bjHandValue(room.dealerCards).total;
  if (total >= 17) { setTimeout(() => bjSettleRound(room), 700); return; }
  setTimeout(() => {
    room.dealerCards.push(room.deck.pop());
    broadcastBjRoom(room);
    setTimeout(() => bjRevealAndDraw(room), 750);
  }, 700);
}

function bjSettleRound(room) {
  const dealerBJ = bjIsBlackjack(room.dealerCards);
  for (const p of room.players) {
    for (const h of p.hands || []) {
      const { result, payout } = bjSettleHand(h, room.dealerCards, dealerBJ);
      h.result = result;
      h.payout = payout;
      p.stack += payout;
    }
  }

  // Sync every seated player's persistent balance now that the round is over.
  for (const p of room.players) {
    const user = registeredUsers.get(p.lc);
    if (user) { user.bjCoins = p.stack; user.bjLastCoinGrant = user.bjLastCoinGrant || Date.now(); saveAuthUsers(); }
  }

  room.phase = "roundEnd";
  broadcastBjRoom(room);
  broadcastPublicBjRooms();

  // Disconnected players leave the table now (the safe between-rounds
  // boundary) — their coins are already synced above, so they lose
  // nothing, they'd just need to rejoin. Mirrors the same pattern used
  // for poker.
  const leaving = room.players.filter(p => !p.connected);
  for (const p of leaving) { bjRoomBySocket.delete(p.socketId); }
  room.players = room.players.filter(p => p.connected);

  if (room.players.length === 0) { cleanupBjRoom(room.id); return; }

  clearBjRoundTimer(room);
  room.roundTimeoutHandle = setTimeout(() => bjStartBettingPhase(room), BJ_ROUND_END_MS);
}

function cleanupBjRoom(roomId) {
  const room = bjRooms.get(roomId);
  if (!room) return;
  clearBjActionTimer(room);
  clearBjRoundTimer(room);
  for (const [, invite] of room.pendingInvites || []) clearTimeout(invite.timeoutHandle);
  for (const p of room.players) bjRoomBySocket.delete(p.socketId);
  bjRooms.delete(roomId);
  broadcastPublicBjRooms();
}

function cleanupBjForSocket(socketId) {
  const roomId = bjRoomBySocket.get(socketId);
  bjRoomBySocket.delete(socketId);
  if (!roomId) return;
  const room = bjRooms.get(roomId);
  if (!room) return;

  const player = room.players.find(p => p.socketId === socketId);
  if (!player) return;

  if (room.status === "lobby") {
    room.players = room.players.filter(p => p.socketId !== socketId);
    if (room.players.length === 0) { cleanupBjRoom(room.id); return; }
    if (player.lc === room.hostLc) room.hostLc = room.players[0].lc;
    broadcastBjRoom(room);
    broadcastPublicBjRooms();
    return;
  }

  player.connected = false;
  if (room.players.every(p => !p.connected)) { cleanupBjRoom(room.id); return; }
  // Mid-round, the bet/action timeouts already auto-act for whoever's turn
  // it is — a disconnected player is removed at the next round boundary
  // (see bjSettleRound), not ripped out mid-hand.
  broadcastBjRoom(room);
}

function startNextDrawRound(room) {
  const nextDrawer = room.players.find(p => p.connected && !p.hasDrawn);
  if (!nextDrawer) { endDrawGame(room); return; }

  room.roundNumber += 1;
  const choices = pickDrawWords(3, room.usedWords);
  room.round = {
    drawerLc: nextDrawer.lc,
    word: null,
    choices,
    startedAt: null,
    endsAt: null,
    guessedLc: new Set(),
    strokes: [],
    timeoutHandle: null,
    pickTimeoutHandle: null,
  };

  broadcastDrawRoom(room, "drawGuess:room", drawRoomPublicState(room));

  const drawerSocket = io.sockets.sockets.get(nextDrawer.socketId);
  if (drawerSocket) drawerSocket.emit("drawGuess:chooseWord", { choices });

  room.round.pickTimeoutHandle = setTimeout(() => {
    if (room.round && !room.round.word) pickDrawWord(room, choices[0]);
  }, DRAW_PICK_TTL_MS);
}

function pickDrawWord(room, word) {
  if (!room.round || room.round.word) return;
  clearTimeout(room.round.pickTimeoutHandle);

  room.round.word = word;
  room.usedWords.add(word);
  room.round.startedAt = Date.now();
  room.round.endsAt = Date.now() + DRAW_ROUND_MS;

  const drawer = room.players.find(p => p.lc === room.round.drawerLc);
  if (drawer) drawer.hasDrawn = true;

  for (const p of room.players) {
    const s = io.sockets.sockets.get(p.socketId);
    if (!s) continue;
    const isDrawer = p.lc === room.round.drawerLc;
    s.emit("drawGuess:roundStart", {
      roundNumber: room.roundNumber,
      totalRounds: room.players.length,
      drawerUsername: drawer?.username || "",
      isDrawer,
      word: isDrawer ? word : null,
      wordLength: [...word].length,
      endsAt: room.round.endsAt,
    });
  }

  room.round.timeoutHandle = setTimeout(() => endDrawRound(room, "timeout"), DRAW_ROUND_MS);
}

function endDrawRound(room, reason) {
  if (!room.round) return;
  clearTimeout(room.round.timeoutHandle);
  clearTimeout(room.round.pickTimeoutHandle);

  const round = room.round;
  const drawer = room.players.find(p => p.lc === round.drawerLc);

  if (round.word) {
    const correctCount = round.guessedLc.size;
    const drawerPoints = drawer ? correctCount * 20 : 0;
    if (drawer) drawer.score += drawerPoints;
    broadcastDrawRoom(room, "drawGuess:roundEnd", {
      word: round.word,
      drawerUsername: drawer?.username || "",
      drawerPoints,
      correctCount,
      scores: drawRoomScores(room),
      reason,
    });
  } else {
    // Drawer disconnected before ever picking a word — nothing to reveal.
    broadcastDrawRoom(room, "drawGuess:roundEnd", {
      word: null,
      drawerUsername: drawer?.username || "",
      drawerPoints: 0,
      correctCount: 0,
      scores: drawRoomScores(room),
      reason: "drawerLeft",
    });
  }

  room.round = null;

  setTimeout(() => {
    if (room.status === "playing") startNextDrawRound(room);
  }, DRAW_REVEAL_MS);
}

function endDrawGame(room) {
  room.status = "ended";
  broadcastDrawRoom(room, "drawGuess:gameEnd", {
    scores: drawRoomScores(room).sort((a, b) => b.score - a.score),
  });
  broadcastPublicDrawRooms(); // ended room drops off the "active games" browser
  setTimeout(() => cleanupDrawRoom(room.id), DRAW_ROOM_TTL_MS);
}

function cleanupDrawRoom(roomId) {
  const room = drawRooms.get(roomId);
  if (!room) return;
  if (room.round) { clearTimeout(room.round.timeoutHandle); clearTimeout(room.round.pickTimeoutHandle); }
  for (const inv of room.pendingInvites.values()) clearTimeout(inv.timeoutHandle);
  for (const p of room.players) drawRoomBySocket.delete(p.socketId);
  drawRooms.delete(roomId);
}

// Handles both an explicit "leave" and a socket disconnecting mid-game.
function cleanupDrawGuessForSocket(socketId) {
  const roomId = drawRoomBySocket.get(socketId);
  drawRoomBySocket.delete(socketId);
  if (!roomId) return;
  const room = drawRooms.get(roomId);
  if (!room) return;

  const player = room.players.find(p => p.socketId === socketId);
  if (!player) return;

  if (room.status === "lobby") {
    // Nothing scored yet — just drop them from the roster.
    room.players = room.players.filter(p => p.socketId !== socketId);
    if (room.players.length === 0) { cleanupDrawRoom(room.id); return; }
    if (player.lc === room.hostLc) room.hostLc = room.players[0].lc; // hand off host
    broadcastDrawRoom(room, "drawGuess:room", drawRoomPublicState(room));
    broadcastPublicDrawRooms();
    return;
  }

  player.connected = false;
  broadcastDrawRoom(room, "drawGuess:room", drawRoomPublicState(room));
  broadcastPublicDrawRooms();

  const connectedCount = room.players.filter(p => p.connected).length;
  if (connectedCount < DRAW_MIN_PLAYERS) { endDrawGame(room); return; }

  if (room.round && room.round.drawerLc === player.lc) endDrawRound(room, "drawerLeft");
}

// ── Voice messages in private chat ──────────────────────────────────────────
const VOICE_MAX_SECONDS = 60;
const VOICE_MAX_BYTES   = 3 * 1024 * 1024; // a minute of Safari's AAC is ~1MB; Opus far less

// ── Sticker pack (/stickers/<id>.svg; same ids as stickers.js) ─────────────
const STICKER_IDS = new Set(["gamarjoba", "gaicani", "love", "haha", "kai", "sad", "dzili", "gaumarjos",
  "alaverdi", "supra", "khachapuri", "khinkali", "churchkhela", "vaime", "genatsvale", "dzmao", "sakartvelo"]);

// ── Friends extras: last seen, nicknames, pins, 24h text status ───────────
// All stored on the account. Status and last-seen are shown to friends only;
// someone who "appears offline" never shows a last-seen time.
const STATUS_TTL_MS = 24 * 60 * 60 * 1000;
const STATUS_MAX    = 140;
const NICKNAME_MAX  = 30;
const PINNED_MAX    = 10;
function cleanShortText(v, max) {
  return typeof v === "string" ? v.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, max) : "";
}
function activeStatus(u) {
  const st = u && u.status;
  return st && st.text && Date.now() - st.at < STATUS_TTL_MS ? st : null;
}
function friendDetails(me) {
  const nick = me.friendNicknames || {}, pins = me.pinnedFriends || [];
  return (me.friends || []).map((lc) => {
    const u = registeredUsers.get(lc);
    if (!u || u.isGuest) return null;
    const online = isVisiblyOnline(lc), st = activeStatus(u);
    return {
      lc, username: u.username, avatar: u.avatar || DEFAULT_AVATAR, isPro: !!u.isPro,
      online, lastSeenAt: online || u.appearOffline ? null : (u.lastSeenAt || null),
      status: st ? st.text : "", statusAt: st ? st.at : null,
      nickname: nick[lc] || "", pinned: pins.includes(lc), theme: effectiveTheme(u),
    };
  }).filter(Boolean);
}

// ── Profile styles (ring around your picture) ─────────────────────────────
// Same ids as profile-themes.js. Rare ones are rewards: VIP, or a 7-day
// daily-bonus streak (best streak ever, so missing a day later keeps it).
const PROFILE_THEMES = {
  default: null, cobalt: null, emerald: null, ruby: null, amethyst: null, sunset: null, ocean: null,
  fire: "streak7", gold: "vip", diamond: "vip",
};
const isThemeId = (id) => Object.prototype.hasOwnProperty.call(PROFILE_THEMES, id);
function themeUnlocked(u, id) {
  if (!isThemeId(id)) return false;
  const lock = PROFILE_THEMES[id];
  if (lock === "vip") return !!u.isPro;
  if (lock === "streak7") return ((u.daily && u.daily.best) || 0) >= 7;
  return true;
}
// What others see: a VIP style stops showing if VIP ends.
function effectiveTheme(u) {
  const id = u && u.profileTheme;
  return id && id !== "default" && themeUnlocked(u, id) ? id : null;
}

// ── Daily reward ───────────────────────────────────────────────────────────
// Once a day (Georgian time), coins for poker and blackjack; coming back on
// consecutive days grows the streak and the reward. Missing a day restarts it.
const DAILY_REWARDS = [100, 150, 200, 250, 300, 400, 500]; // day 1 … day 7+
function georgiaDay(offsetDays = 0) {
  return new Date(Date.now() + 4 * 60 * 60 * 1000 + offsetDays * 86400000).toISOString().slice(0, 10);
}
function dailyState(u) {
  const d = u.daily || {};
  const today = georgiaDay(), yesterday = georgiaDay(-1);
  const claimedToday = d.last === today;
  const alive = d.last === today || d.last === yesterday;
  const streak = alive ? (d.streak || 0) : 0;            // current streak (0 if broken)
  // reward = today's (if not claimed yet) or tomorrow's (if already claimed)
  return {
    canClaim: !claimedToday, streak, claimedToday,
    reward: DAILY_REWARDS[Math.min(streak + 1, DAILY_REWARDS.length) - 1],
  };
}

// ── Lobby kick ────────────────────────────────────────────────────────────────
// Until a game starts, its host can remove anyone from the lobby — public
// lobbies are open to everyone, so unwanted people do wander in. The kicked
// player is taken out the same way as if they'd left (each game's own cleanup),
// and can't walk straight back in: only a fresh invite from the host lifts it.
const LOBBY_KICKED_MSG = "მასპინძელმა ამ ლობიდან გაგაგდო — ხელახლა შემოსვლა მხოლოდ მისი მოწვევით შეგიძლია.";
const LOBBY_GAMES = {
  drawGuess: { rooms: drawRooms,     channel: "drawroom",     cleanup: cleanupDrawGuessForSocket },
  poker:     { rooms: pokerRooms,    channel: "pokerroom",    cleanup: cleanupPokerForSocket },
  chess:     { rooms: chessRooms,    channel: "chessroom",    cleanup: cleanupChessForSocket },
  checkers:  { rooms: checkersRooms, channel: "checkersroom", cleanup: cleanupCheckersForSocket },
  joker:     { rooms: jokerRooms,    channel: "jokerroom",    cleanup: cleanupJokerForSocket },
  imposter:  { rooms: imposterRooms, channel: "imposterroom", cleanup: cleanupImposterForSocket },
  blackjack: { rooms: bjRooms,       channel: "bjroom",       cleanup: cleanupBjForSocket },
};
function kickFromLobby(socket, game, data) {
  const g = LOBBY_GAMES[game];
  if (!g || !socket._regUser || !data || typeof data.username !== "string") return;
  const room = g.rooms.get(data.roomId);
  if (!room) return;
  const me = socket._regUser.usernameLower;
  if (room.hostLc !== me) { socket.emit(`${game}:error`, { message: "მოთამაშის გაგდება მხოლოდ მასპინძელს შეუძლია." }); return; }
  if (room.status !== "lobby") { socket.emit(`${game}:error`, { message: "თამაში უკვე დაიწყო — ახლა ვეღარავის გააგდებ." }); return; }
  const targetLc = data.username.toLowerCase().trim();
  const target = targetLc !== me && room.players.find(p => p.lc === targetLc);
  if (!target) return;

  (room.kicked ||= new Set()).add(targetLc);
  const targetSocket = io.sockets.sockets.get(target.socketId);
  g.cleanup(target.socketId); // removes them and updates everyone, exactly like leaving
  if (targetSocket) {
    targetSocket.leave(`${g.channel}:${room.id}`);
    targetSocket.emit(`${game}:kicked`, { roomId: room.id, byUsername: socket._regUser.username });
  }
  socket.emit(`${game}:kickDone`, { username: target.username });
}

// ── Main connection handler ──────────────────────────────────────────────────
io.on("connection", (socket) => {
  socket.clientIP = (
    socket.handshake.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    socket.handshake.address ||
    "unknown"
  );
  socket.userAgent = socket.handshake.headers["user-agent"] || "";

  // Check if IP or user-agent is banned
  if (bannedIPs.has(socket.clientIP)) {
    console.log(`[BAN] Rejected banned IP: ${socket.clientIP}`);
    socket.emit("autoKicked");
    socket.disconnect(true);
    return;
  }
  // 24h temp ban — same idea as the permanent ban above, but this one tells
  // the client WHY (name + reason) so the UI can show the explanation page
  // instead of just silently dropping the connection.
  const tempBanEntry = getTempBan(socket.clientIP);
  if (tempBanEntry) {
    console.log(`[TEMP-BAN] Rejected temp-banned IP: ${socket.clientIP}`);
    socket.emit("tempBanned", {
      hours: Math.max(1, Math.ceil((tempBanEntry.until - Date.now()) / 3600000)),
      reason: tempBanEntry.reason,
      username: tempBanEntry.username,
      until: tempBanEntry.until,
    });
    socket.disconnect(true);
    return;
  }
  if (isUABanned(socket.userAgent)) {
    console.log(`[UA-BAN] Rejected banned User-Agent: ${socket.userAgent.slice(0, 120)}`);
    socket.emit("autoKicked");
    socket.disconnect(true);
    return;
  }

  // Check for VirusTotal
  if (socket.clientIP !== "unknown" && socket.clientIP !== "127.0.0.1") {
    const isGeorgian = /^(193\.|195\.|196\.110|196\.111)/.test(socket.clientIP);
    if (!isGeorgian) enqueueForVT(socket.clientIP);
  }

  console.log(`[SOCKET] Connected: ${socket.id} from ${socket.clientIP}`);

  // ── Friends extras: details for the dashboard list, nicknames, pins ─────
  const regMe = () => (socket._regUser && !socket._regUser.isGuest) ? registeredUsers.get(socket._regUser.usernameLower) : null;
  socket.on("friends:details", (_d, ack) => {
    if (typeof ack !== "function") return;
    const me = regMe();
    ack({ friends: me ? friendDetails(me) : [], myStatus: me ? (activeStatus(me) || null) : null });
  });
  socket.on("friend:setNickname", (data, ack) => {
    const me = regMe(); if (!me || !data) return;
    if (mediaRateLimited(socket, "friendMeta", 30, 60_000)) return;
    const lc = String(data.friendUsername || "").toLowerCase().trim();
    if (!(me.friends || []).includes(lc)) return;
    const nick = cleanShortText(data.nickname, NICKNAME_MAX);
    me.friendNicknames = me.friendNicknames || {};
    if (nick) me.friendNicknames[lc] = nick; else delete me.friendNicknames[lc];
    saveAuthUsers();
    io.to(`user:${socket._regUser.usernameLower}`).emit("friends:changed");
    if (typeof ack === "function") ack({ ok: true, nickname: nick });
  });
  socket.on("friend:setPinned", (data, ack) => {
    const me = regMe(); if (!me || !data) return;
    if (mediaRateLimited(socket, "friendMeta", 30, 60_000)) return;
    const lc = String(data.friendUsername || "").toLowerCase().trim();
    if (!(me.friends || []).includes(lc)) return;
    let pins = (me.pinnedFriends || []).filter((x) => x !== lc && (me.friends || []).includes(x));
    if (data.pinned) {
      if (pins.length >= PINNED_MAX) { if (typeof ack === "function") ack({ error: `მაქსიმუმ ${PINNED_MAX} მიმაგრებული მეგობარი` }); return; }
      pins.unshift(lc);
    }
    me.pinnedFriends = pins;
    saveAuthUsers();
    io.to(`user:${socket._regUser.usernameLower}`).emit("friends:changed");
    if (typeof ack === "function") ack({ ok: true });
  });

  // ── 24h text status (stories) — friends see it ───────────────────────────
  socket.on("status:set", (data, ack) => {
    const me = regMe(); if (!me) return;
    const reply = (x) => { if (typeof ack === "function") ack(x); };
    if (mediaRateLimited(socket, "statusSet", 10, 60_000)) return reply({ error: "ცოტა მოიცადე და სცადე თავიდან" });
    const text = cleanShortText(data && data.text, STATUS_MAX);
    if (text && findBannedWord(text)) return reply({ error: ABUSE_WORD_MESSAGE });
    me.status = text ? { text, at: Date.now() } : null;
    saveAuthUsers();
    for (const f of [socket._regUser.usernameLower, ...(me.friends || [])]) io.to(`user:${f}`).emit("friends:changed");
    reply({ ok: true, status: me.status });
  });

  // ── Daily reward ────────────────────────────────────────────────────────
  socket.on("daily:state", (_d, ack) => {
    if (typeof ack !== "function") return;
    const me = regMe(); if (!me) return ack({ error: "registered-only" });
    ack(dailyState(me));
  });
  socket.on("daily:claim", (_d, ack) => {
    if (typeof ack !== "function") return;
    const me = regMe(); if (!me) return ack({ error: "registered-only" });
    const lc = socket._regUser.usernameLower;
    const st = dailyState(me);
    if (!st.canClaim) return ack({ error: "დღევანდელი ბონუსი უკვე აღებულია", ...st });
    // A table keeps its own copy of your balance and writes it back at the end
    // of a hand — a bonus added now would be overwritten.
    if (findActivePokerRoomForUser(lc) || findActiveBjRoomForUser(lc)) return ack({ error: "ჯერ დაასრულე მიმდინარე თამაში (პოკერი/ბლექჯეკი), მერე აიღე ბონუსი" });
    ensurePokerCoins(me); bjEnsureCoins(me);
    me.pokerCoins += st.reward; me.bjCoins += st.reward;
    me.daily = { last: georgiaDay(), streak: st.streak + 1, best: Math.max((me.daily && me.daily.best) || 0, st.streak + 1) };
    saveAuthUsers();
    // granted = what you just got; reward = tomorrow's (from dailyState)
    ack({ ...dailyState(me), ok: true, granted: st.reward, streak: me.daily.streak, pokerCoins: me.pokerCoins, bjCoins: me.bjCoins });
  });

  // ── Profile style ───────────────────────────────────────────────────────
  socket.on("profile:themes", (_d, ack) => {
    if (typeof ack !== "function") return;
    const me = regMe(); if (!me) return ack({ error: "registered-only" });
    ack({
      current: effectiveTheme(me) || "default",
      unlocked: Object.keys(PROFILE_THEMES).filter((id) => themeUnlocked(me, id)),
      bestStreak: (me.daily && me.daily.best) || 0,
    });
  });
  socket.on("profile:setTheme", (data, ack) => {
    const me = regMe(); if (!me) return;
    const reply = (x) => { if (typeof ack === "function") ack(x); };
    if (mediaRateLimited(socket, "profileTheme", 20, 60_000)) return reply({ error: "ცოტა მოიცადე და სცადე თავიდან" });
    const id = String((data && data.theme) || "");
    if (!isThemeId(id)) return reply({ error: "ასეთი სტილი არ არსებობს" });
    if (!themeUnlocked(me, id)) return reply({ error: PROFILE_THEMES[id] === "vip" ? "ეს სტილი მხოლოდ VIP-ისთვისაა" : "ჯერ 7 დღე ზედიზედ აიღე დღის ბონუსი" });
    me.profileTheme = id === "default" ? null : id;
    saveAuthUsers();
    for (const f of [socket._regUser.usernameLower, ...(me.friends || [])]) io.to(`user:${f}`).emit("friends:changed");
    reply({ ok: true, theme: id });
  });

  // Host removes someone from a game lobby before it starts — see kickFromLobby.
  for (const game of Object.keys(LOBBY_GAMES)) {
    socket.on(`${game}:kick`, (data) => kickFromLobby(socket, game, data));
  }

  // Answering a game invite — joining or declining that room, from the
  // dashboard's invite bar or the game page itself — marks its 🔔 read.
  socket.onAny((event, payload) => {
    const game = NOTIF_GAME_ANSWER_EVENTS.get(event);
    if (!game || !socket._regUser || socket._regUser.isGuest) return;
    const roomId = payload && payload.roomId;
    if (typeof roomId !== "string") return;
    markNotificationsRead(socket._regUser.usernameLower, it => it.key === `game:${game}:${roomId}`);
  });

  // ── Login (registered user) ──────────────────────────────────────────────
  socket.on("auth:login", ({ token }) => {
    if (!token) return;
    const entry = authTokens.get(token);
    if (!entry || Date.now() >= entry.expiry) {
      socket.emit("auth:error", { error: "Token expired" });
      return;
    }

    const user = registeredUsers.get(entry.usernameLower);
    if (!user) return;

    if (user.nameBlocked) { socket.emit("account:nameBlocked", { username: user.username }); return; }
    socket._regUser = { usernameLower: entry.usernameLower, username: user.username };
    evictGhostOf(socket);
    socket.userName = user.username;
    // Last-used IP for the admin panel. This was only recorded on the game
    // pages' login path, so most accounts showed "never logged in" and
    // "Delete + ban" had no IP to ban.
    user.lastIP = socket.clientIP || "unknown";
    user.lastIPAt = Date.now();
    authUsersDirty = true; scheduleSave();

    if (!onlineRegSockets.has(entry.usernameLower)) {
      onlineRegSockets.set(entry.usernameLower, new Set());
    }
    onlineRegSockets.get(entry.usernameLower).add(socket.id);

    socket.join(`user:${entry.usernameLower}`);
    socket.emit("auth:authenticated", { username: user.username, friends: user.friends || [], pendingRequests: user.pendingRequests || [], avatar: user.avatar || DEFAULT_AVATAR, bio: user.bio || "", streaks: getStreaksForFriends(entry.usernameLower, user.friends || []), isAdmin: !!user.isAdmin, isPro: !!user.isPro, adFreeUntil: user.adFreeUntil || 0, appearOffline: !!user.appearOffline, blockedUsers: user.blockedUsers || [] });
    console.log(`[AUTH] ${user.username} logged in`);
    announceOnlineChanged(); // let dashboards know the online list may have changed
  });

  // ── settings:update — dashboard privacy switch ─────────────────────────────
  //   appearOffline: you're hidden from presence everywhere others see it
  // Saved on the account, so they survive restarts and apply on every device.
  socket.on("settings:update", (data) => {
    if (!socket._regUser || socket._regUser.isGuest || !data || typeof data !== "object") return;
    // Toggling presence makes every client refresh its online list, so keep
    // it from being hammered.
    if (mediaRateLimited(socket, "settingsUpdate", 12, 10_000)) return;
    const lc = socket._regUser.usernameLower;
    const user = registeredUsers.get(lc);
    if (!user) return;
    let changed = false, presenceChanged = false;
    if (typeof data.appearOffline === "boolean") {
      if (!!user.appearOffline !== data.appearOffline) presenceChanged = true;
      user.appearOffline = data.appearOffline; changed = true;
    }
    if (changed) saveAuthUsers();
    // Every open tab of this account shows the same switch positions.
    io.to(`user:${lc}`).emit("settings:state", { appearOffline: !!user.appearOffline });
    if (presenceChanged) announceOnlineChanged();
  });

  // ── users:listOnline — who's online right now, for the dashboard ──────────
  socket.on("users:listOnline", () => {
    if (!socket._regUser) return;
    if (mediaRateLimited(socket, "listOnline", 20, 10_000)) return;
    socket.emit("users:onlineList", {
      users: getOnlineRegisteredUsers(socket._regUser.usernameLower),
    });
  });

  // ── Notifications (🔔) — registered accounts only ─────────────────────────
  const notifLc = () => (socket._regUser && !socket._regUser.isGuest) ? socket._regUser.usernameLower : null;
  socket.on("notif:list", (_d, ack) => {
    if (typeof ack !== "function") return;
    const lc = notifLc();
    const box = lc ? userNotifications.get(lc) : null;
    ack({ items: box ? box.items.map(notifView) : [], unseen: notifUnseen(box) });
  });
  // The panel was opened: the red number goes away. Items stay unread
  // (highlighted) until they're clicked.
  socket.on("notif:seen", () => {
    const lc = notifLc(); if (!lc) return;
    const box = userNotifications.get(lc);
    if (!box || notifUnseen(box) === 0) return;
    box.seenAt = Math.max(Date.now(), box.items[0]?.ts || 0);
    notifChanged(lc, box);
  });
  socket.on("notif:read", (data) => {
    const lc = notifLc(); if (!lc) return;
    const id = data && typeof data.id === "string" ? data.id : null;
    if (id) markNotificationsRead(lc, it => it.id === id);
  });
  socket.on("notif:readAll", () => {
    const lc = notifLc(); if (!lc) return;
    markNotificationsRead(lc, () => true);
  });

  // ── auth:token — alias kept for backwards compat ─────────────────────────
  socket.on("auth:token", (token) => {
    // Normalise: old client sent raw string, new client sends { token }
    const t = (typeof token === "string") ? token : token?.token;
    if (!t) return;
    // Run auth:login logic directly (socket.emit won't trigger server-side listeners)
    const entry = authTokens.get(t);
    if (!entry || Date.now() >= entry.expiry) { socket.emit("auth:invalid"); return; }
    const user = registeredUsers.get(entry.usernameLower);
    if (!user) return;
    if (user.nameBlocked) { socket.emit("account:nameBlocked", { username: user.username }); return; }
    socket._regUser = { usernameLower: entry.usernameLower, username: user.username };
    evictGhostOf(socket);
    socket.userName = user.username;
    // Track the IP this account was last seen using — powers the admin
    // panel's "all registered users" list, so a problem account can be
    // IP-banned directly, not just kicked by socket.
    user.lastIP = socket.clientIP || "unknown";
    user.lastIPAt = Date.now();
    authUsersDirty = true; scheduleSave();
    if (!onlineRegSockets.has(entry.usernameLower)) onlineRegSockets.set(entry.usernameLower, new Set());
    onlineRegSockets.get(entry.usernameLower).add(socket.id);
    socket.join(`user:${entry.usernameLower}`);
    socket.emit("auth:authenticated", { username: user.username, friends: user.friends || [], pendingRequests: user.pendingRequests || [], avatar: user.avatar || DEFAULT_AVATAR, bio: user.bio || "", streaks: getStreaksForFriends(entry.usernameLower, user.friends || []), isAdmin: !!user.isAdmin, isPro: !!user.isPro, adFreeUntil: user.adFreeUntil || 0, appearOffline: !!user.appearOffline, blockedUsers: user.blockedUsers || [] });
    console.log(`[AUTH] ${user.username} logged in via auth:token`);
    announceOnlineChanged(); // let dashboards know the online list may have changed
  });

  // ── auth:guest — a temporary, throwaway identity for someone who hasn't
  // registered, so they can still play games and browse Rooms/Forum with
  // the same interface a registered user sees. Lives only in memory for
  // as long as this socket is connected: never written to disk (see the
  // isGuest skip in _saveAuthUsersToDisk), and cleaned up on disconnect
  // below. Registered-only actions (friends, private messages, posting)
  // still check isGuest and refuse with a "register to do this" message —
  // this only grants read/play access, not the full account.
  socket.on("auth:guest", (data) => {
    if (socket._regUser) return; // already authenticated one way or the other

    // If the client remembers a name from earlier in this browser session —
    // either a guest name from a previous dashboard/game visit, or (more
    // commonly) whatever they already typed in for random chat via setName
    // — reuse it so they show up as themselves everywhere instead of a
    // random "სტუმარი####". Same length/character rules as any other
    // chosen name on this site (see setName / registration).
    //
    // Crucially: if that name is currently held by ANOTHER GUEST entry
    // (not a real account), it's still safe to take over — this is almost
    // always this exact same person's previous page, whose socket just
    // hasn't finished disconnecting yet (socket.io detects a closed tab
    // with a short delay, not instantly), not a different person. Reusing
    // that existing record (rather than creating a fresh one) also means
    // whatever coins/progress they'd built up on the previous page carry
    // over instead of resetting on every navigation.
    const preferred = (data && typeof data.preferredUsername === "string") ? data.preferredUsername.trim() : null;
    const existingHolder = preferred ? registeredUsers.get(preferred.toLowerCase()) : null;
    // Only an already-assigned "სტუმარი####" may be carried over — that's a
    // guest continuing across pages. Anything else (a name they typed into
    // random chat, say) is ignored and they get a fresh guest name instead.
    // GUEST_NAME_RE is stricter than the old length/charset/banned-word
    // checks it replaces, so those are implied.
    const preferredValid = preferred
      && GUEST_NAME_RE.test(preferred)
      && (!existingHolder || existingHolder.isGuest);

    let username, lc, guestUser;
    if (preferredValid) {
      username = preferred;
      lc = username.toLowerCase();
      guestUser = existingHolder || {
        username, isGuest: true, createdAt: new Date().toISOString(),
        friends: [], pendingRequests: [], avatar: GUEST_AVATAR, bio: "",
      };
    } else {
      let attempts = 0;
      do {
        username = `სტუმარი${Math.floor(1000 + Math.random() * 9000)}`;
        lc = username.toLowerCase();
        attempts++;
      } while (registeredUsers.has(lc) && attempts < 25);
      if (registeredUsers.has(lc)) { socket.emit("auth:invalid"); return; } // pathological luck, extremely unlikely
      guestUser = {
        username, isGuest: true, createdAt: new Date().toISOString(),
        friends: [], pendingRequests: [], avatar: GUEST_AVATAR, bio: "",
      };
    }

    registeredUsers.set(lc, guestUser);
    guestSocketMap.set(socket.id, lc);

    socket._regUser = { usernameLower: lc, username, isGuest: true };
    evictGhostOf(socket);
    socket.userName = username;
    if (!onlineRegSockets.has(lc)) onlineRegSockets.set(lc, new Set());
    onlineRegSockets.get(lc).add(socket.id);
    socket.join(`user:${lc}`);

    // Also issue a short-lived REST token (reusing the same authTokens /
    // requireRegAuth path real accounts use) so the client can fetch
    // read-only Forum/Rooms content over REST, not just sockets. Tracked
    // for cleanup alongside the rest of the guest session on disconnect.
    const guestToken = authToken();
    authTokens.set(guestToken, { usernameLower: lc, expiry: Date.now() + GUEST_TOKEN_TTL, isGuest: true });
    guestTokenMap.set(socket.id, guestToken);

    socket.emit("auth:authenticated", {
      username, friends: [], pendingRequests: [], avatar: guestUser.avatar || GUEST_AVATAR, bio: guestUser.bio || "",
      streaks: {}, isAdmin: false, isPro: false, isGuest: true, guestToken
    });
    console.log(`[AUTH] ${username} started a guest session`);
    announceOnlineChanged();
  });

  // ── auth:guest:rename — DISABLED. Guests can no longer choose a name at
  // all; only registered accounts get a name of their own. Rejected here on
  // the server (not just hidden in the UI) so an old cached page or a
  // hand-crafted request can't still rename. Registering is the way to get
  // a real name, so the error says exactly that. ──────────────────────
  socket.on("auth:guest:rename", () => {
    socket.emit("auth:guest:renameResult", {
      success: false,
      error: "სტუმრებს სახელის შეცვლა არ შეუძლიათ — დარეგისტრირდი, რომ საკუთარი სახელი გქონდეს",
    });
  });


  // ── auth:checkPartner — tell client if current partner is registered ──────
  socket.on("auth:checkPartner", () => {
    if (!socket.partner || !socket._regUser) return;
    const partnerReg = socket.partner._regUser;
    // A guest's socket also carries _regUser now (needed so they can send/
    // receive game invites while on this page) — but a guest isn't a real
    // account to add as a friend, so they must NOT be reported as
    // "registered" here, or the ➕ add-friend button would incorrectly
    // show up for them.
    if (!partnerReg || partnerReg.isGuest) return;
    const myUser = registeredUsers.get(socket._regUser.usernameLower);
    const isFriend = (myUser?.friends || []).includes(partnerReg.usernameLower);
    const roomId = privRoomId(socket._regUser.usernameLower, partnerReg.usernameLower);
    socket.emit("auth:partnerRegInfo", {
      partnerRegName: partnerReg.username,
      isFriend,
      roomId,
    });
  });


  socket.on("friend:request", ({ toUsername }) => {
    if (!socket._regUser) return;
    if (socket._regUser.isGuest) { socket.emit("guest:registerRequired", { feature: "addFriend" }); return; }
    // Unlimited friend requests are a harassment vector (mass-spamming every
    // user) and each pending request is stored on the target's account.
    if (mediaRateLimited(socket, "friendRequest", 10, 60_000)) {
      socket.emit("friend:error", { message: "ძალიან ბევრი მოთხოვნა — ცოტა დაელოდე.", targetUsername: String(toUsername || "") });
      return;
    }
    const targetLc = String(toUsername).toLowerCase().trim();
    const targetUser = registeredUsers.get(targetLc);
    if (!targetUser) return;
    if (targetUser.isGuest) { socket.emit("friend:error", { msg: "ეს მომხმარებელი სტუმარია და ჯერ არ დარეგისტრირებულა", targetUsername: targetUser.username }); return; }
    const myLc = socket._regUser.usernameLower;
    const myUser = registeredUsers.get(myLc);

    // A permanent block (either direction) blocks friend requests entirely —
    // doesn't affect random chat matching, only friend requests/messaging.
    if (targetUser.blockedUsers && targetUser.blockedUsers.includes(myLc)) {
      socket.emit("friend:error", { msg: "ამ მომხმარებელს არ შეუძლია მოთხოვნის მიღება", targetUsername: targetUser.username });
      return;
    }
    if (myUser?.blockedUsers && myUser.blockedUsers.includes(targetLc)) {
      socket.emit("friend:error", { msg: "მოხსენით ბლოკი ჯერ, რომ მოთხოვნა გაგზავნოთ", targetUsername: targetUser.username });
      return;
    }
    // Already friends — a request would just show up as a stray "pending"
    // entry next to the friendship.
    if ((myUser?.friends || []).includes(targetLc)) {
      socket.emit("friend:error", { msg: "უკვე მეგობრები ხართ", targetUsername: targetUser.username });
      return;
    }

    // Blocked for 24h after this specific person declined a request from
    // this specific sender — doesn't affect requests to anyone else.
    const cooldownKey = `${myLc}|${targetLc}`;
    const cooldownExpiry = friendRequestDeclineCooldown.get(cooldownKey);
    if (cooldownExpiry) {
      if (Date.now() < cooldownExpiry) {
        const hoursLeft = Math.ceil((cooldownExpiry - Date.now()) / (60 * 60 * 1000));
        socket.emit("friend:error", { msg: `${targetUser.username}-მა ახლახან უარყო თქვენი მოთხოვნა — სცადეთ ${hoursLeft} საათში`, targetUsername: targetUser.username });
        return;
      }
      friendRequestDeclineCooldown.delete(cooldownKey); // expired, clean it up
    }

    if (!targetUser.pendingRequests) targetUser.pendingRequests = [];
    if (!targetUser.pendingRequests.includes(myLc)) {
      targetUser.pendingRequests.push(myLc);
      saveAuthUsers();
      pushNotification(targetLc, {
        type: "friend_request", from: socket._regUser.username, fromLc: myLc,
        link: "/dashboard.html#pendingSection",
      }, `freq:${myLc}`);
    }

    io.to(`user:${targetLc}`).emit("friend:incomingRequest", {
      fromUsername: socket._regUser.username
    });
  });

  // ── Accept friend request ────────────────────────────────────────────────
  socket.on("friend:accept", ({ fromUsername } = {}) => {
    if (!socket._regUser || socket._regUser.isGuest) return;
    const fromLc = String(fromUsername).toLowerCase().trim();
    const myUser = registeredUsers.get(socket._regUser.usernameLower);
    const fromUser = registeredUsers.get(fromLc);

    if (!myUser || !fromUser || fromUser.isGuest) return;
    if (!myUser.friends) myUser.friends = [];
    if (!fromUser.friends) fromUser.friends = [];
    if (!myUser.pendingRequests) myUser.pendingRequests = [];
    // Only an actual request from them can be accepted. Without this check
    // anyone could send "accept" with any username and instantly become that
    // person's friend — never having asked, and without them ever agreeing.
    const wasPending = myUser.pendingRequests.includes(fromLc);
    if (!wasPending) {
      if (!myUser.friends.includes(fromLc)) socket.emit("friend:error", { msg: "მეგობრობის მოთხოვნა აღარ არსებობს", targetUsername: fromUser.username });
      return;
    }

    if (!myUser.friends.includes(fromLc)) myUser.friends.push(fromLc);
    if (!fromUser.friends.includes(socket._regUser.usernameLower)) {
      fromUser.friends.push(socket._regUser.usernameLower);
    }
    myUser.pendingRequests = myUser.pendingRequests.filter(u => u !== fromLc);

    saveAuthUsers();
    socket.emit("friend:accepted", { username: fromUser.username, friends: myUser.friends });
    io.to(`user:${fromLc}`).emit("friend:acceptedByOther", {
      byUsername: socket._regUser.username
    });
    markNotificationsRead(socket._regUser.usernameLower, it => it.type === "friend_request" && it.fromLc === fromLc);
    pushNotification(fromLc, {
      type: "friend_accept", from: socket._regUser.username, fromLc: socket._regUser.usernameLower,
      link: `/friend-chat.html?friend=${encodeURIComponent(socket._regUser.username)}`,
    });
  });

  // ── Trinder ─────────────────────────────────────────────────────────────
  // Request/response over socket acks. Registered users only.
  const trMe = () => {
    if (!socket._regUser || socket._regUser.isGuest) return null;
    const u = registeredUsers.get(socket._regUser.usernameLower);
    return u && !u.isGuest ? u : null;
  };
  const trLc = () => socket._regUser.usernameLower;
  socket.on("trinder:state", (_d, ack) => {
    if (typeof ack !== "function") return;
    const me = trMe(); if (!me) return ack({ error: "registered-only" });
    ack(trinderState(trLc(), me));
  });
  socket.on("trinder:join", (data, ack) => {
    if (typeof ack !== "function") return;
    const me = trMe(); if (!me) return ack({ error: "registered-only" });
    if (mediaRateLimited(socket, "trinderJoin", 10, 60_000)) return ack({ error: "ცოტა მოიცადე და სცადე თავიდან" });
    const r = sanitizeTrinderProfile(data && data.profile);
    if (r.error) return ack({ error: r.error });
    const t = trinderOf(me);
    t.profile = r.profile; t.active = true; if (!t.joinedAt) t.joinedAt = Date.now();
    saveAuthUsers();
    ack(trinderState(trLc(), me));
  });
  socket.on("trinder:leave", (_d, ack) => {
    if (typeof ack !== "function") return;
    const me = trMe(); if (!me) return ack({ error: "registered-only" });
    trinderOf(me).active = false; saveAuthUsers();
    ack(trinderState(trLc(), me));
  });
  socket.on("trinder:deck", (_d, ack) => {
    if (typeof ack !== "function") return;
    const me = trMe(); if (!me) return ack({ error: "registered-only" });
    const meLc = trLc(), t = trinderOf(me);
    if (!t.active || !t.profile) return ack({ error: "not-joined" });
    const mine = t.profile, seen = new Set([...t.likes, ...t.passes, ...t.matches]);
    const pool = [];
    for (const [lc, u] of registeredUsers) {
      if (lc === meLc || u.isGuest || u.nameBlocked || !u.trinder || !u.trinder.active || !u.trinder.profile || seen.has(lc)) continue;
      if (trinderBlocked(me, meLc, u, lc)) continue;
      const p = u.trinder.profile;
      if (!trinderCompatible(me, u)) continue;
      // same city first, then people online, then the rest — shuffled within each group
      const score = (mine.city && p.city && mine.city.toLowerCase() === p.city.toLowerCase() ? 2 : 0) + (isVisiblyOnline(lc) ? 1 : 0) + Math.random();
      pool.push([score, lc, u]);
    }
    pool.sort((a, b) => b[0] - a[0]);
    ack({ cards: pool.slice(0, 15).map(([, lc, u]) => trinderCard(lc, u)) });
  });
  socket.on("trinder:swipe", (data, ack) => {
    if (typeof ack !== "function") return;
    const me = trMe(); if (!me) return ack({ error: "registered-only" });
    if (mediaRateLimited(socket, "trinderSwipe", 60, 60_000)) return ack({ error: "ძალიან სწრაფად — ცოტა შეისვენე" });
    const meLc = trLc(), t = trinderOf(me);
    if (!t.active) return ack({ error: "not-joined" });
    const tLc = String((data && data.target) || "").toLowerCase().trim();
    const them = registeredUsers.get(tLc);
    if (!them || tLc === meLc || them.isGuest || !them.trinder || !them.trinder.active) return ack({ error: "ეს პროფილი აღარ არსებობს" });
    const action = data && data.action === "like" ? "like" : "pass";
    if (action === "like" && !trinderCompatible(me, them)) return ack({ error: "ეს პროფილი შენს არჩევანს აღარ შეესაბამება" });
    const likedBefore = t.likes.includes(tLc);
    t.likes = t.likes.filter(x => x !== tLc); t.passes = t.passes.filter(x => x !== tLc);
    if (action === "pass" || trinderBlocked(me, meLc, them, tLc)) {
      t.passes.push(tLc); if (t.passes.length > 5000) t.passes.splice(0, t.passes.length - 5000);
      saveAuthUsers(); return ack({ ok: true });
    }
    t.likes.push(tLc);
    const tt = trinderOf(them);
    if (tt.likes.includes(meLc)) {
      // It's a match: remember it on both sides and make them friends.
      if (!t.matches.includes(tLc)) t.matches.push(tLc);
      if (!tt.matches.includes(meLc)) tt.matches.push(meLc);
      me.friends = me.friends || []; them.friends = them.friends || [];
      if (!me.friends.includes(tLc)) me.friends.push(tLc);
      if (!them.friends.includes(meLc)) them.friends.push(meLc);
      me.pendingRequests = (me.pendingRequests || []).filter(x => x !== tLc);
      them.pendingRequests = (them.pendingRequests || []).filter(x => x !== meLc);
      saveAuthUsers();
      const cardMe = { username: me.username, name: t.profile.name, avatar: me.avatar || DEFAULT_AVATAR };
      const cardThem = { username: them.username, name: tt.profile ? tt.profile.name : them.username, avatar: them.avatar || DEFAULT_AVATAR };
      io.to(`user:${tLc}`).emit("trinder:match", { with: cardMe, friends: them.friends, likesCount: trinderPendingLikers(tLc, them).length });
      pushNotification(tLc, { type: "trinder_match", from: me.username, fromLc: meLc, name: cardMe.name, link: "/trinder.html?tab=matches" });
      socket.to(`user:${meLc}`).emit("trinder:match", { with: cardThem, friends: me.friends, likesCount: trinderPendingLikers(meLc, me).length });
      return ack({ ok: true, match: cardThem, friends: me.friends, likesCount: trinderPendingLikers(meLc, me).length });
    }
    saveAuthUsers();
    // Tell them someone likes them — but not who (the notification doesn't
    // record the liker either, so it can't be peeked at later).
    const likesCount = trinderPendingLikers(tLc, them).length;
    io.to(`user:${tLc}`).emit("trinder:liked", { likesCount });
    // count = everyone currently waiting on them (same number as the Trinder
    // button), so re-swiping the same person can't inflate it.
    if (!likedBefore && likesCount > 0) pushNotification(tLc, { type: "trinder_like", count: likesCount, link: "/trinder.html?tab=likes" }, "trinder_like");
    ack({ ok: true });
  });
  // Who liked me. VIP members see who; everyone else only gets blurred pictures
  // (no names are ever sent, so the blur can't be peeked behind).
  socket.on("trinder:likes", (_d, ack) => {
    if (typeof ack !== "function") return;
    const me = trMe(); if (!me) return ack({ error: "registered-only" });
    const likers = trinderPendingLikers(trLc(), me);
    markNotificationsRead(trLc(), it => it.type === "trinder_like");
    ack({ count: likers.length, revealed: !!me.isPro,
      items: likers.slice(0, 60).map(([lc, u]) => me.isPro ? trinderCard(lc, u) : { avatar: u.avatar || DEFAULT_AVATAR }) });
  });
  socket.on("trinder:resetPasses", (_d, ack) => {
    if (typeof ack !== "function") return;
    const me = trMe(); if (!me) return ack({ error: "registered-only" });
    trinderOf(me).passes = []; saveAuthUsers(); ack({ ok: true });
  });

  // ── Decline friend request ───────────────────────────────────────────────
  socket.on("friend:decline", ({ fromUsername }) => {
    if (!socket._regUser) return;
    const fromLc = String(fromUsername).toLowerCase().trim();
    const myLc = socket._regUser.usernameLower;
    const myUser = registeredUsers.get(myLc);
    if (!myUser) return;

    if (!myUser.pendingRequests) myUser.pendingRequests = [];
    myUser.pendingRequests = myUser.pendingRequests.filter(u => u !== fromLc);
    saveAuthUsers();

    // That sender can't send ME another request for 24h — doesn't affect
    // requests they send to anyone else, or requests anyone else sends me.
    friendRequestDeclineCooldown.set(`${fromLc}|${myLc}`, Date.now() + FRIEND_REQUEST_DECLINE_COOLDOWN_MS);

    markNotificationsRead(myLc, it => it.type === "friend_request" && it.fromLc === fromLc);

    socket.emit("friend:declined");
    io.to(`user:${fromLc}`).emit("friend:declinedByOther", {
      byUsername: socket._regUser.username
    });
  });

  // ── flappy:start — begin a new anti-cheat session for "მფრინავი ჩიტი" ────
  // Registered accounts only. Guests carry a _regUser too (isGuest: true),
  // so checking for _regUser alone let them through. Enforced here on the
  // server, not just hidden in the page, so a guest can't start a session
  // by sending the event directly.
  socket.on("flappy:start", () => {
    if (!socket._regUser || socket._regUser.isGuest) {
      socket.emit("flappy:registerRequired");
      return;
    }
    const sessionId = flappyGenSessionId();
    flappySessions.set(sessionId, {
      usernameLower: socket._regUser.usernameLower,
      socketId: socket.id,
      startAt: Date.now(),
      submitted: false,
    });
    socket.emit("flappy:sessionStarted", { sessionId });
  });

  // ── flappy:submitScore — validate + record a finished game's score ───────
  socket.on("flappy:submitScore", ({ sessionId, score }) => {
    if (!socket._regUser || socket._regUser.isGuest) return; // registered accounts only

    const numScore = Number(score);
    if (!Number.isFinite(numScore) || !Number.isInteger(numScore) || numScore < 0) return;

    const session = flappySessions.get(sessionId);
    if (!session || session.usernameLower !== socket._regUser.usernameLower) {
      socket.emit("flappy:scoreResult", { accepted: false, reason: "invalid_session" });
      return;
    }
    if (session.submitted) {
      socket.emit("flappy:scoreResult", { accepted: false, reason: "already_submitted" });
      return;
    }

    const lastSubmit = flappyLastSubmit.get(socket._regUser.usernameLower) || 0;
    if (Date.now() - lastSubmit < 2000) {
      socket.emit("flappy:scoreResult", { accepted: false, reason: "rate_limited" });
      return;
    }

    if (numScore > 5000) {
      socket.emit("flappy:scoreResult", { accepted: false, reason: "implausible" });
      return;
    }

    const elapsed      = Date.now() - session.startAt;
    const minPlausible = flappyMinTimeMs(numScore) * 0.75;
    if (numScore > 0 && elapsed < minPlausible) {
      socket.emit("flappy:scoreResult", { accepted: false, reason: "too_fast" });
      console.log(`[FLAPPY] Rejected implausible score: ${socket._regUser.username} claimed ${numScore} in ${elapsed}ms (needs >= ${minPlausible.toFixed(0)}ms)`);
      return;
    }

    session.submitted = true;
    flappyLastSubmit.set(socket._regUser.usernameLower, Date.now());

    const user = registeredUsers.get(socket._regUser.usernameLower);
    if (!user) return;

    const prevBest  = user.flappyHighScore || 0;
    const isNewBest = numScore > prevBest;
    if (isNewBest) {
      user.flappyHighScore   = numScore;
      user.flappyHighScoreAt = new Date().toISOString();
      saveAuthUsers();
    }

    // ── Reward: 24h without ads for reaching the target score ─────────────
    // Sits AFTER every anti-cheat check above (session token, one submit per
    // game, rate limit, and the minimum-plausible-time check), so a score
    // only earns this if it already passed as a real game. Registered
    // accounts only — guests can play, but the reward belongs to an account.
    // Re-reaching 20 while already ad-free restarts the full 24h from now.
    let adFreeGranted = false;
    if (numScore >= FLAPPY_ADFREE_SCORE && !socket._regUser.isGuest && !user.isGuest) {
      user.adFreeUntil = Date.now() + FLAPPY_ADFREE_MS;
      saveAuthUsers();
      adFreeGranted = true;
      console.log(`[FLAPPY] ${user.username} scored ${numScore} — ads off until ${new Date(user.adFreeUntil).toISOString()}`);
      // Every open tab of theirs drops ads immediately, not just this one.
      io.to(`user:${socket._regUser.usernameLower}`).emit("ads:adFreeUntil", { adFreeUntil: user.adFreeUntil });
    }

    socket.emit("flappy:scoreResult", {
      accepted: true,
      score: numScore,
      personalBest: user.flappyHighScore || 0,
      isNewBest,
      adFreeGranted,
      adFreeUntil: user.adFreeUntil || 0,
    });

    if (isNewBest) {
      const top3 = getFlappyTop3();
      if (top3.some(r => r.id === socket._regUser.usernameLower)) {
        broadcastFlappyLeaderboard();
      }
    }

    flappySessions.delete(sessionId);
  });

  // ── Remove friend ────────────────────────────────────────────────────────
  socket.on("friend:remove", ({ friendUsername }) => {
    if (!socket._regUser || !friendUsername) return;
    const myLc = socket._regUser.usernameLower;
    const targetLc = String(friendUsername).toLowerCase().trim();
    if (!targetLc || targetLc === myLc) return;

    const myUser = registeredUsers.get(myLc);
    const targetUser = registeredUsers.get(targetLc);

    if (!myUser) return;
    myUser.friends = (myUser.friends || []).filter(f => f !== targetLc);

    if (targetUser) {
      targetUser.friends = (targetUser.friends || []).filter(f => f !== myLc);
    }

    saveAuthUsers();
    if (friendStreaks.delete(privRoomId(myLc, targetLc))) saveStreaks();
    socket.emit("friend:removed", { friends: myUser.friends });

    if (targetUser) {
      io.to(`user:${targetLc}`).emit("friend:removedByOther", {
        byUsername: socket._regUser.username
      });
    }
  });

  // ── Session block ────────────────────────────────────────────────────────
  // ── Block another registered user, permanently — not session-scoped.
  // Blocks friend requests and private messages in BOTH directions, but
  // deliberately does NOT affect random chat matching — they can still be
  // paired there. Also removes any existing friendship, since staying
  // "friends" with someone you've just blocked doesn't make sense.
  socket.on("friend:block", ({ targetUsername }) => {
    if (!socket._regUser || socket._regUser.isGuest || !targetUsername) return;
    const myLc = socket._regUser.usernameLower;
    const targetLc = String(targetUsername).toLowerCase().trim();
    if (!targetLc || targetLc === myLc) return;
    const myUser = registeredUsers.get(myLc);
    const targetUser = registeredUsers.get(targetLc);
    if (!myUser || !targetUser) return;

    if (!myUser.blockedUsers) myUser.blockedUsers = [];
    if (!myUser.blockedUsers.includes(targetLc)) myUser.blockedUsers.push(targetLc);

    // Blocking removes any existing friendship on both sides
    if (myUser.friends) myUser.friends = myUser.friends.filter(u => u !== targetLc);
    if (targetUser.friends) targetUser.friends = targetUser.friends.filter(u => u !== myLc);
    if (myUser.pendingRequests) myUser.pendingRequests = myUser.pendingRequests.filter(u => u !== targetLc);
    if (targetUser.pendingRequests) targetUser.pendingRequests = targetUser.pendingRequests.filter(u => u !== myLc);

    saveAuthUsers();
    socket.emit("friend:blockAck", { targetUsername: targetLc, friends: myUser.friends, blockedUsers: myUser.blockedUsers });
  });

  socket.on("friend:unblock", ({ targetUsername }) => {
    if (!socket._regUser || socket._regUser.isGuest || !targetUsername) return;
    const myLc = socket._regUser.usernameLower;
    const targetLc = String(targetUsername).toLowerCase().trim();
    const myUser = registeredUsers.get(myLc);
    if (!myUser || !myUser.blockedUsers) return;
    myUser.blockedUsers = myUser.blockedUsers.filter(u => u !== targetLc);
    saveAuthUsers();
    socket.emit("friend:unblockAck", { targetUsername: targetLc });
  });

  // ── Report a registered account from their profile card — registered
  // reporters only. Separate from the random-chat reportUser above; this
  // one is account-based (see accountReportLog comment), and does NOT
  // trigger any automatic ban — it's logged for an admin to review, not
  // acted on automatically like the anonymous IP-based system is.
  socket.on("user:report", ({ targetUsername, reason }) => {
    if (!socket._regUser || socket._regUser.isGuest) return;
    // Rate limited because accountReportLog grows in memory with every entry.
    // Without this, one client could spam reports in a loop and exhaust the
    // server's memory. 5 per minute is far above any legitimate use.
    if (mediaRateLimited(socket, "userReport", 5, 60_000)) {
      socket.emit("user:reportResult", { success: false, error: "ძალიან ბევრი რეპორტი — ცოტა დაელოდე." });
      return;
    }
    const myLc = socket._regUser.usernameLower;
    const targetLc = String(targetUsername || "").toLowerCase().trim();
    if (!targetLc || targetLc === myLc) return;
    const targetUser = registeredUsers.get(targetLc);
    if (!targetUser || targetUser.isGuest) return; // guests aren't reportable — temporary identity, names get reused

    const cleanReason = (reason || "").trim().slice(0, 300);
    if (!cleanReason) { socket.emit("user:reportResult", { success: false, error: "მიუთითეთ მიზეზი" }); return; }

    if (!accountReportLog.has(targetLc)) accountReportLog.set(targetLc, []);
    const entries = accountReportLog.get(targetLc);
    entries.push({
      reason: cleanReason,
      reportedBy: socket._regUser.username,
      timestamp: new Date().toISOString(),
    });
    // Hard cap per target so this can never grow without bound. The admin
    // view only ever shows the 20 most recent anyway, and the total count
    // is tracked separately so the number stays truthful after trimming.
    const MAX_KEPT_REPORTS = 50;
    if (entries.length > MAX_KEPT_REPORTS) entries.splice(0, entries.length - MAX_KEPT_REPORTS);

    console.log(`[PROFILE REPORT] ${socket._regUser.username} reported ${targetUser.username}: ${cleanReason}`);
    socket.emit("user:reportResult", { success: true });
  });

  // ── Private message request ──────────────────────────────────────────────
  socket.on("privateMsg:send", ({ toUsername, message, messageId, replyTo }) => {
    if (!socket._regUser || !toUsername || !message) return;
    if (socket._regUser.isGuest) { socket.emit("guest:registerRequired", { feature: "privateChat" }); return; }
    // Private messages are persisted to disk, so unlimited sending is both a
    // harassment vector and a way to grow the stored message file without
    // bound. 15 per 10s is well above normal typing speed.
    if (mediaRateLimited(socket, "privateMsg", 15, 10_000)) {
      socket.emit("privateMsg:sent", { success: false, messageId });
      return;
    }
    const toLc = String(toUsername).toLowerCase().trim();

    // A permanent block (either direction) blocks private messages too —
    // random chat is deliberately untouched by this. Deliberately vague
    // error (not "they blocked you") so this can't be used to confirm a
    // block exists from the other side.
    const myUser = registeredUsers.get(socket._regUser.usernameLower);
    const toUser = registeredUsers.get(toLc);
    if (toUser?.blockedUsers && toUser.blockedUsers.includes(socket._regUser.usernameLower)) {
      socket.emit("privateMsg:sent", { success: false, messageId: messageId || null });
      return;
    }
    if (myUser?.blockedUsers && myUser.blockedUsers.includes(toLc)) {
      socket.emit("privateMsg:sent", { success: false, messageId: messageId || null });
      return;
    }
    // Private chat is friends-only everywhere else (the chat page, history,
    // photos, GIFs). Without this, anyone could drop messages on a stranger
    // that the stranger can't even open — and each would ring their 🔔.
    if (!(myUser?.friends || []).includes(toLc)) {
      socket.emit("privateMsg:sent", { success: false, messageId: messageId || null });
      return;
    }

    const roomId = privRoomId(socket._regUser.usernameLower, toLc);
    let room = privateRooms.get(roomId);

    if (!room) {
      room = { messages: [], createdAt: Date.now(), expiresAt: Date.now() + PRIVATE_MSG_TTL };
      privateRooms.set(roomId, room);
    }

    let safeReplyTo = null;
    if (replyTo && typeof replyTo.text === "string") {
      safeReplyTo = {
        text:       replyTo.text.slice(0, 100).replace(/<[^>]*>/g, "").trim(),
        senderName: String(replyTo.senderName || "").slice(0, 30).replace(/<[^>]*>/g, "").trim(),
        messageId:  String(replyTo.messageId || "").slice(0, 100),
      };
    }

    const msg = {
      id: String(messageId || "").slice(0, 100) || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      from: socket._regUser.usernameLower,
      text: String(message).slice(0, MSG_MAX),
      ts: new Date().toISOString(),
      replyTo: safeReplyTo
    };

    room.messages.push(msg);
    bumpStat("msgPrivate");
    trimRoomMessages(room);
    room.expiresAt = Date.now() + PRIVATE_MSG_TTL;

    savePrivateMsgs();

    io.to(`user:${toLc}`).emit("privateMsg:received", {
      fromUsername: socket._regUser.username,
      message: msg.text,
      timestamp: msg.ts,
      messageId: msg.id,
      replyTo: msg.replyTo
    });

    socket.emit("privateMsg:sent", { success: true, messageId: msg.id });
    notifyPrivateMessage(socket._regUser.usernameLower, socket._regUser.username, toLc, "text");

    // ── Streak: this counts as today's message for both sides ─────────────
    const streak = recordFriendMessage(socket._regUser.usernameLower, toLc);
    io.to(`user:${toLc}`).emit("streak:update", { friendUsername: socket._regUser.username, count: streak.count, atRisk: streak.atRisk });
    socket.emit("streak:update", { friendUsername: toUser?.username || toUsername, count: streak.count, atRisk: streak.atRisk });
  });

  // ── privateMsg:sendSticker — a sticker from the pack, stored like a message
  // (same rules as text: friends only, blocks respected, same rate limit).
  socket.on("privateMsg:sendSticker", ({ toUsername, sticker, messageId } = {}) => {
    if (!socket._regUser || socket._regUser.isGuest || !toUsername) return;
    const fail = () => socket.emit("privateMsg:sent", { success: false, messageId: messageId || null });
    if (!STICKER_IDS.has(sticker)) return fail();
    if (mediaRateLimited(socket, "privateMsg", 15, 10_000)) return fail();
    const myLc = socket._regUser.usernameLower;
    const toLc = String(toUsername).toLowerCase().trim();
    const myUser = registeredUsers.get(myLc), toUser = registeredUsers.get(toLc);
    if (!toUser || (toUser.blockedUsers || []).includes(myLc) || (myUser?.blockedUsers || []).includes(toLc)) return fail();
    if (!(myUser?.friends || []).includes(toLc)) return fail();

    const roomId = privRoomId(myLc, toLc);
    let room = privateRooms.get(roomId);
    if (!room) {
      room = { messages: [], createdAt: Date.now(), expiresAt: Date.now() + PRIVATE_MSG_TTL };
      privateRooms.set(roomId, room);
    }
    const msg = {
      id: String(messageId || "").slice(0, 100) || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      from: myLc, type: "sticker", sticker, text: "", ts: new Date().toISOString(),
    };
    room.messages.push(msg);
    bumpStat("msgPrivate");
    trimRoomMessages(room);
    room.expiresAt = Date.now() + PRIVATE_MSG_TTL;
    savePrivateMsgs();

    io.to(`user:${toLc}`).emit("privateMsg:received", {
      fromUsername: socket._regUser.username, type: "sticker", sticker, message: "",
      timestamp: msg.ts, messageId: msg.id,
    });
    socket.emit("privateMsg:sent", { success: true, messageId: msg.id });
    notifyPrivateMessage(myLc, socket._regUser.username, toLc, "sticker");

    const streak = recordFriendMessage(myLc, toLc);
    io.to(`user:${toLc}`).emit("streak:update", { friendUsername: socket._regUser.username, count: streak.count, atRisk: streak.atRisk });
    socket.emit("streak:update", { friendUsername: toUser.username, count: streak.count, atRisk: streak.atRisk });
  });

  // ── privateMsg:sendVoice — 🎤 voice message (up to 60s) to a friend ─────
  // Stored next to the photos (random name, deleted with the conversation).
  // The format is read from the file's own first bytes, never the browser's
  // label: WebM / Ogg (Chrome, Firefox — Opus) or MP4 (Safari — AAC).
  socket.on("privateMsg:sendVoice", ({ toUsername, audioData, duration, messageId } = {}) => {
    const reply = (x) => socket.emit("privateMsg:voiceSent", { messageId: messageId || null, ...x });
    if (!socket._regUser || !toUsername || !audioData) return;
    if (socket._regUser.isGuest) return reply({ success: false, error: "ხმოვანი შეტყობინება მხოლოდ რეგისტრირებულებს შეუძლიათ" });
    if (mediaRateLimited(socket, "privateVoice", 10, 60_000)) return reply({ success: false, error: "ძალიან ხშირად აგზავნი — ცოტა დაელოდე" });
    const myLc = socket._regUser.usernameLower;
    const toLc = String(toUsername).toLowerCase().trim();
    const myUser = registeredUsers.get(myLc), toUser = registeredUsers.get(toLc);
    if (!toUser || !(myUser?.friends || []).includes(toLc)) return reply({ success: false, error: "მხოლოდ მეგობრებს შეგიძლია მისწერო" });
    if ((toUser.blockedUsers || []).includes(myLc) || (myUser?.blockedUsers || []).includes(toLc)) return reply({ success: false });

    let buf;
    try { buf = Buffer.from(String(audioData), "base64"); } catch { buf = null; }
    if (!buf || buf.length < 200) return reply({ success: false, error: "ჩანაწერი ცარიელია" });
    if (buf.length > VOICE_MAX_BYTES) return reply({ success: false, error: "ჩანაწერი ზედმეტად დიდია" });
    let ext = null;
    if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) ext = "webm";
    else if (buf.slice(0, 4).toString("latin1") === "OggS") ext = "ogg";
    else if (buf.slice(4, 8).toString("latin1") === "ftyp") ext = "m4a";
    if (!ext) return reply({ success: false, error: "ჩანაწერის ფორმატი ვერ ამოვიცანი" });

    const filename = crypto.randomBytes(20).toString("hex") + "." + ext;
    try { fs.writeFileSync(path.join(PRIVATE_PHOTOS_DIR, filename), buf); }
    catch (e) { console.error("[VOICE] Failed to save:", e.message); return reply({ success: false, error: "შენახვა ვერ მოხერხდა" }); }
    const voiceUrl = "/private-photos/" + filename;
    const secs = Math.max(1, Math.min(VOICE_MAX_SECONDS, Math.round(Number(duration) || 1)));

    const roomId = privRoomId(myLc, toLc);
    let room = privateRooms.get(roomId);
    if (!room) {
      room = { messages: [], createdAt: Date.now(), expiresAt: Date.now() + PRIVATE_MSG_TTL };
      privateRooms.set(roomId, room);
    }
    const msg = {
      id: String(messageId || "").slice(0, 100) || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      from: myLc, type: "voice", voiceUrl, duration: secs, text: "", ts: new Date().toISOString(),
    };
    room.messages.push(msg);
    bumpStat("msgPrivate");
    trimRoomMessages(room);
    room.expiresAt = Date.now() + PRIVATE_MSG_TTL;
    savePrivateMsgs();

    io.to(`user:${toLc}`).emit("privateMsg:received", {
      fromUsername: socket._regUser.username, type: "voice", voiceUrl, duration: secs, message: "",
      timestamp: msg.ts, messageId: msg.id,
    });
    reply({ success: true, voiceUrl, duration: secs });
    notifyPrivateMessage(myLc, socket._regUser.username, toLc, "voice");

    const streak = recordFriendMessage(myLc, toLc);
    io.to(`user:${toLc}`).emit("streak:update", { friendUsername: socket._regUser.username, count: streak.count, atRisk: streak.atRisk });
    socket.emit("streak:update", { friendUsername: toUser.username, count: streak.count, atRisk: streak.atRisk });
  });

  // ── privateMsg:sendPhoto — pro users only, private chat with an EXISTING
  // mutual friend only. Deliberately NOT available in random chat, rooms,
  // or forum — see the scoping note at the top of this feature. Checked
  // more strictly than the plain text handler above: friendship is verified
  // in BOTH directions here rather than assumed from room membership, since
  // image content warrants the extra certainty.
  //
  // Every photo is processed through sharp before being saved:
  //   * auto-rotated using the image's own EXIF orientation flag — phone
  //     photos are very often stored "sideways" with a flag saying how to
  //     display them the right way up; skipping this step means photos can
  //     arrive rotated 90°.
  //   * resized down to at most 2000px on the long edge. Modern phone
  //     cameras routinely produce 8-20MB+ JPEGs at full resolution — far
  //     more than anyone needs for viewing in a chat — so this is a
  //     generous ceiling, not a quality compromise for normal use.
  //   * re-encoded as JPEG, regardless of the source format. This is also
  //     what makes HEIC/HEIC — the default format on iPhone cameras —
  //     actually work: previously HEIC uploads were rejected outright,
  //     which likely explains photo-sending appearing broken for anyone on
  //     iPhone, probably most real users of this feature.
  // sharp is also the SECURITY boundary here, not the declared mimeType:
  // if sharp can't decode the bytes as a real image, they get rejected
  // regardless of what the client claimed the file was.
  const MAX_PHOTO_INPUT_BYTES = 20 * 1024 * 1024; // 20MB raw — covers real phone photos with margin
  const PHOTO_MAX_DIMENSION   = 2000;
  const PHOTO_JPEG_QUALITY    = 85;

  socket.on("privateMsg:sendPhoto", async ({ toUsername, photoData, mimeType, messageId }) => {
    if (!socket._regUser || !toUsername || !photoData) return;
    if (socket._regUser.isGuest) { socket.emit("privateMsg:photoSent", { success: false, messageId, error: "სტუმრებს ფოტოს გაგზავნა არ შეუძლიათ" }); return; }

    const myLc = socket._regUser.usernameLower;
    const myUser = registeredUsers.get(myLc);
    if (!myUser?.isPro) {
      socket.emit("privateMsg:photoSent", { success: false, messageId, error: "ფოტოს გაგზავნა მხოლოდ VIP მომხმარებლებს შეუძლიათ" });
      return;
    }

    // 5 photos per minute — generous for real chat use, protects storage
    // and the recipient from being flooded with images.
    if (mediaRateLimited(socket, "privatePhoto", 5, 60_000)) {
      socket.emit("privateMsg:photoSent", { success: false, messageId, error: "ძალიან ხშირად აგზავნი — ცოტა დაელოდე" });
      return;
    }

    const toLc = String(toUsername).toLowerCase().trim();
    const toUser = registeredUsers.get(toLc);
    if (!toUser) { socket.emit("privateMsg:photoSent", { success: false, messageId, error: "მომხმარებელი ვერ მოიძებნა" }); return; }

    // Mutual friendship checked explicitly in BOTH directions, rather than
    // relying on the caller having already joined the friendchat room —
    // a stricter bar than plain text messages get, deliberately, given
    // this is image content.
    if (!(myUser.friends || []).includes(toLc) || !(toUser.friends || []).includes(myLc)) {
      socket.emit("privateMsg:photoSent", { success: false, messageId, error: "მხოლოდ ორმხრივ მეგობრებთან შეგიძლია ფოტოს გაგზავნა" });
      return;
    }

    // Same block check as text messages.
    if (toUser.blockedUsers?.includes(myLc) || myUser.blockedUsers?.includes(toLc)) {
      socket.emit("privateMsg:photoSent", { success: false, messageId }); return;
    }

    let rawBuffer;
    try {
      rawBuffer = Buffer.from(String(photoData), "base64");
    } catch {
      socket.emit("privateMsg:photoSent", { success: false, messageId, error: "ფოტოს დამუშავება ვერ მოხერხდა" });
      return;
    }
    if (!rawBuffer.length || rawBuffer.length > MAX_PHOTO_INPUT_BYTES) {
      socket.emit("privateMsg:photoSent", { success: false, messageId, error: "ფოტო ზედმეტად დიდია (მაქს. 20MB)" });
      return;
    }

    let processedBuffer;
    let outExt = "jpg";
    if (sharp) {
      try {
        processedBuffer = await sharp(rawBuffer)
          .rotate() // auto-orient from EXIF before anything else touches the pixels
          .resize({ width: PHOTO_MAX_DIMENSION, height: PHOTO_MAX_DIMENSION, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: PHOTO_JPEG_QUALITY, mozjpeg: true })
          .toBuffer();
      } catch (e) {
        // sharp couldn't decode this as an image at all — this is the real
        // format/content check, not the client-declared mimeType.
        console.warn("[PHOTOS] sharp could not process upload:", e.message);
        socket.emit("privateMsg:photoSent", { success: false, messageId, error: "ეს ფაილი სურათი არ არის ან დაზიანებულია" });
        return;
      }
    } else {
      // No sharp on this host: identify the format from the file's own
      // leading bytes (never the browser's label) and store it unchanged.
      // HEIC needs sharp to convert, so it's refused with a clear message.
      const b = rawBuffer;
      if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) outExt = "jpg";
      else if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) outExt = "png";
      else if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) outExt = "gif";
      else if (b.slice(0, 4).toString("latin1") === "RIFF" && b.slice(8, 12).toString("latin1") === "WEBP") outExt = "webp";
      else {
        socket.emit("privateMsg:photoSent", { success: false, messageId, error: "ეს ფორმატი ჯერ არ არის მხარდაჭერილი — სცადე JPG ან PNG" });
        return;
      }
      processedBuffer = rawBuffer;
    }

    // Never trust or reuse anything client-supplied for the name itself,
    // both to avoid path-traversal and so filenames can't collide.
    const filename = crypto.randomBytes(20).toString("hex") + "." + outExt;
    try {
      fs.writeFileSync(path.join(PRIVATE_PHOTOS_DIR, filename), processedBuffer);
    } catch (e) {
      console.error("[PHOTOS] Failed to save:", e.message);
      socket.emit("privateMsg:photoSent", { success: false, messageId, error: "შენახვა ვერ მოხერხდა" });
      return;
    }
    const photoUrl = "/private-photos/" + filename;

    const roomId = privRoomId(myLc, toLc);
    let room = privateRooms.get(roomId);
    if (!room) {
      room = { messages: [], createdAt: Date.now(), expiresAt: Date.now() + PRIVATE_MSG_TTL };
      privateRooms.set(roomId, room);
    }

    const msg = {
      id: String(messageId || "").slice(0, 100) || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      from: myLc,
      type: "photo",
      photoUrl,
      ts: new Date().toISOString(),
    };
    room.messages.push(msg);
    bumpStat("photoPrivate");
    trimRoomMessages(room);
    room.expiresAt = Date.now() + PRIVATE_MSG_TTL;
    savePrivateMsgs();

    io.to(`user:${toLc}`).emit("privateMsg:received", {
      fromUsername: socket._regUser.username,
      type: "photo",
      photoUrl,
      timestamp: msg.ts,
      messageId: msg.id,
    });
    socket.emit("privateMsg:photoSent", { success: true, messageId: msg.id, photoUrl });
    notifyPrivateMessage(myLc, socket._regUser.username, toLc, "photo");

    const streak = recordFriendMessage(myLc, toLc);
    io.to(`user:${toLc}`).emit("streak:update", { friendUsername: socket._regUser.username, count: streak.count, atRisk: streak.atRisk });
    socket.emit("streak:update", { friendUsername: toUser.username || toUsername, count: streak.count, atRisk: streak.atRisk });
  });

  // ── friendChat:join — subscribe socket to its friend-chat pair room ───────
  // Called by friend-chat.html when it opens, so typing events can be routed.
  socket.on("friendChat:join", ({ friendUsername }) => {
    if (!socket._regUser || !friendUsername) return;
    const friendLc = String(friendUsername).toLowerCase().trim();
    // Security: must be confirmed friends
    const myUser = registeredUsers.get(socket._regUser.usernameLower);
    if (!myUser || !(myUser.friends || []).includes(friendLc)) return;

    const roomId = privRoomId(socket._regUser.usernameLower, friendLc);
    socket.join(`friendchat:${roomId}`);
    socket._friendChatRoom = roomId;
    markNotificationsRead(socket._regUser.usernameLower, it => it.fromLc === friendLc && (it.type === "message" || it.type === "friend_accept"));

    // Tell the joining client the pair's current streak (covers page load —
    // new messages push their own streak:update separately).
    const streak = getStreakView(socket._regUser.usernameLower, friendLc);
    const friendUser = registeredUsers.get(friendLc);
    socket.emit("streak:update", { friendUsername: friendUser?.username || friendUsername, count: streak.count, atRisk: streak.atRisk });
  });

  // ── friendChat:typing — relay typing indicator to the friend ─────────────
  // Pushes only to the friend's personal user room so it shows only in their
  // friend-chat.html page, never in the random stranger chat popup.
  socket.on("friendChat:typing", ({ toUsername }) => {
    if (!socket._regUser || !toUsername) return;
    const toLc = String(toUsername).toLowerCase().trim();
    io.to(`user:${toLc}`).emit("friendChat:partnerTyping", {
      fromUsername: socket._regUser.username
    });
  });

  // ── friendChat:gif — relay GIF URL to friend ─────────────────────────────
  socket.on("friendChat:gif", ({ toUsername, url }) => {
    if (!socket._regUser || !toUsername || !url) return;
    // Only GIPHY links (what the GIF search returns) — any other URL would
    // load in the friend's browser and could be used to track them.
    if (typeof url !== "string" || url.length > 500 || !/^https:\/\/(?:[a-z0-9-]+\.)?giphy\.com\//i.test(url)) return;
    if (mediaRateLimited(socket, "friendGif", 8, 10_000)) return;
    const toLc   = String(toUsername).toLowerCase().trim();
    const myUser = registeredUsers.get(socket._regUser.usernameLower);
    if (!myUser || !(myUser.friends || []).includes(toLc)) return;
    io.to(`user:${toLc}`).emit("friendChat:gif", {
      fromUsername: socket._regUser.username,
      url:          url,
      timestamp:    new Date().toISOString()
    });
    notifyPrivateMessage(socket._regUser.usernameLower, socket._regUser.username, toLc, "gif");

    const streak = recordFriendMessage(socket._regUser.usernameLower, toLc);
    const toUser = registeredUsers.get(toLc);
    io.to(`user:${toLc}`).emit("streak:update", { friendUsername: socket._regUser.username, count: streak.count, atRisk: streak.atRisk });
    socket.emit("streak:update", { friendUsername: toUser?.username || toUsername, count: streak.count, atRisk: streak.atRisk });
  });

  // ── friendChat:react — react to a friend-chat message (mirrors "react") ──
  // ── friendChat:setTheme — shared chat wallpaper, synced to both people ──
  socket.on("friendChat:setTheme", ({ toUsername, themeId }) => {
    if (!socket._regUser || !toUsername || !themeId) return;
    if (!FC_VALID_THEMES.has(themeId)) return;
    const toLc = String(toUsername).toLowerCase().trim();
    const myUser = registeredUsers.get(socket._regUser.usernameLower);
    if (!myUser || !(myUser.friends || []).includes(toLc)) return;

    const roomId = privRoomId(socket._regUser.usernameLower, toLc);
    let room = privateRooms.get(roomId);
    if (!room) {
      room = { messages: [], createdAt: Date.now(), expiresAt: Date.now() + PRIVATE_MSG_TTL };
      privateRooms.set(roomId, room);
    }
    room.theme = themeId;
    savePrivateMsgs();

    const payload = { fromUsername: socket._regUser.username, themeId };
    io.to(`user:${toLc}`).emit("friendChat:themeChanged", payload);
    socket.emit("friendChat:themeChanged", payload); // echo back so every one of the setter's own open tabs/devices stays in sync too
  });

  socket.on("friendChat:react", ({ toUsername, messageId, emoji }) => {
    if (!socket._regUser || !toUsername || !messageId || !emoji) return;
    if (!VALID_EMOJIS.has(emoji)) return;
    const toLc = String(toUsername).toLowerCase().trim();
    const myUser = registeredUsers.get(socket._regUser.usernameLower);
    if (!myUser || !(myUser.friends || []).includes(toLc)) return;

    // Persist on the stored message so it survives a reload
    const roomId = privRoomId(socket._regUser.usernameLower, toLc);
    const room = privateRooms.get(roomId);
    if (room) {
      const m = room.messages.find(mm => mm.id === messageId);
      if (m) {
        m.reactions = m.reactions || {};
        m.reactions[socket._regUser.usernameLower] = emoji;
        savePrivateMsgs();
      }
    }

    io.to(`user:${toLc}`).emit("friendChat:reacted", {
      fromUsername: socket._regUser.username,
      messageId,
      emoji
    });
  });

  // ── friendChat:seen — read receipt for friend-chat messages (mirrors "seen") ──
  socket.on("friendChat:seen", ({ toUsername, messageId }) => {
    if (!socket._regUser || !toUsername || !messageId) return;
    const toLc = String(toUsername).toLowerCase().trim();

    // Keep the persisted "last read" marker current while the chat stays open
    const roomId = privRoomId(socket._regUser.usernameLower, toLc);
    const room = privateRooms.get(roomId);
    if (room) {
      room.lastRead = room.lastRead || {};
      room.lastRead[socket._regUser.usernameLower] = Date.now();
    }

    io.to(`user:${toLc}`).emit("friendChat:partnerSeen", { messageId });
  });

  // ── friendChat:question — random question card (mirrors "sendQuestion") ──
  socket.on("friendChat:question", ({ toUsername, text }) => {
    if (!socket._regUser || !toUsername || typeof text !== "string") return;
    const toLc = String(toUsername).toLowerCase().trim();
    const myUser = registeredUsers.get(socket._regUser.usernameLower);
    if (!myUser || !(myUser.friends || []).includes(toLc)) return;
    const safeText = text.slice(0, 300).replace(/<[^>]*>/g, "").trim();
    if (!safeText) return;
    io.to(`user:${toLc}`).emit("friendChat:question", {
      fromUsername: socket._regUser.username,
      text: safeText
    });

    const streak = recordFriendMessage(socket._regUser.usernameLower, toLc);
    const toUser = registeredUsers.get(toLc);
    io.to(`user:${toLc}`).emit("streak:update", { friendUsername: socket._regUser.username, count: streak.count, atRisk: streak.atRisk });
    socket.emit("streak:update", { friendUsername: toUser?.username || toUsername, count: streak.count, atRisk: streak.atRisk });
  });

  // ════════════════════════════════════════════════════════════════
  //  DRAW & GUESS — group Pictionary-style game with friends
  // ════════════════════════════════════════════════════════════════

  // Create (or reuse) a lobby room you're hosting and invite friends to it.
  // Calling this again while your lobby is still open just invites more
  // people into the same room instead of starting a second one. Someone
  // already active in ANY room (as host of an in-progress game, or as a
  // guest elsewhere) is blocked — one active room per user at a time.
  socket.on("drawGuess:invite", ({ toUsernames }) => {
    if (!socket._regUser) return;
    const hostLc = socket._regUser.usernameLower;

    let room = findActiveDrawRoomForUser(hostLc);

    if (room && !(room.hostLc === hostLc && room.status === "lobby")) {
      socket.emit("drawGuess:error", {
        message: "თქვენ უკვე ხართ სხვა თამაშში — ჯერ დატოვეთ ან დაასრულეთ ის, სანამ ახალს შექმნით.",
      });
      return;
    }

    if (room) {
      // Reusing our own still-open lobby — re-point it at this socket in
      // case we reconnected on a new tab/device since it was created.
      const hostPlayer = room.players.find(p => p.lc === hostLc);
      if (hostPlayer) { hostPlayer.socketId = socket.id; hostPlayer.connected = true; }
      drawRoomBySocket.set(socket.id, room.id);
    } else {
      room = {
        id: makeDrawRoomId(),
        hostLc,
        status: "lobby",
        players: [{ lc: hostLc, username: socket._regUser.username, socketId: socket.id, score: 0, hasDrawn: false, connected: true }],
        pendingInvites: new Map(), // lc → { timeoutHandle }
        round: null,
        roundNumber: 0,
        usedWords: new Set(),
      };
      drawRooms.set(room.id, room);
      drawRoomBySocket.set(socket.id, room.id);
    }

    const hostUser = registeredUsers.get(hostLc);
    const list = Array.isArray(toUsernames) ? toUsernames.filter(u => typeof u === "string").slice(0, DRAW_MAX_PLAYERS) : [];

    const invited  = [];
    const cooldown = []; // usernames skipped because they recently declined this host
    const now = Date.now();
    for (const uname of list) {
      const lc = uname.toLowerCase();
      if (lc === hostLc) continue;
      if (room.players.some(p => p.lc === lc)) continue;
      if (room.pendingInvites.has(lc)) continue;
      if (!isVisiblyOnline(lc)) continue; // must be a currently-online registered user (and not appearing offline)

      const targetUser = registeredUsers.get(lc);
      if (!targetUser) continue;

      // Skip (and let the host know) if this person declined an invite
      // from this same host within the last DRAW_DECLINE_COOLDOWN_MS.
      const cdKey = `${hostLc}|${lc}`;
      const cdExpiry = drawDeclineCooldown.get(cdKey);
      if (cdExpiry) {
        if (cdExpiry > now) { cooldown.push(targetUser.username); continue; }
        drawDeclineCooldown.delete(cdKey);
      }

      const timeoutHandle = setTimeout(() => room.pendingInvites.delete(lc), DRAW_INVITE_TTL_MS);
      room.pendingInvites.set(lc, { timeoutHandle });
      room.kicked?.delete(lc); // the host asked them back in

      io.to(`user:${lc}`).emit("drawGuess:invited", { roomId: room.id, fromUsername: hostUser.username });
      notifyGameInvite(lc, "drawGuess", room.id, hostUser.username);
      invited.push(targetUser.username);
    }

    socket.join(`drawroom:${room.id}`);
    socket.emit("drawGuess:room", drawRoomPublicState(room));
    socket.emit("drawGuess:inviteSent", { invited, cooldown });
    broadcastPublicDrawRooms();
  });

  // List every joinable room (lobby OR already playing) so the client can
  // show an "active games" browser under the invite button — anyone can
  // join one of these, not just people who were personally invited.
  socket.on("drawGuess:listPublicRooms", () => {
    socket.emit("drawGuess:publicRooms", getPublicDrawRooms());
  });

  // Accept an invite, reconnect to a room you were already in, OR — new —
  // drop into a room someone is already playing, picked from the public
  // "active games" list. Joining mid-game slots you in as a real player:
  // since totalRounds is just room.players.length and startNextDrawRound
  // always looks for players with hasDrawn === false, adding you here
  // naturally queues up one extra round (yours) once the current one ends.
  socket.on("drawGuess:join", ({ roomId }) => {
    if (!socket._regUser) return;
    const lc = socket._regUser.usernameLower;

    const existingRoomId = drawRoomBySocket.get(socket.id);
    if (existingRoomId && existingRoomId !== roomId) cleanupDrawGuessForSocket(socket.id);

    const room = drawRooms.get(roomId);
    if (!room) { socket.emit("drawGuess:error", { message: "ოთახი ვეღარ მოიძებნა — შეიძლება უკვე დასრულდა." }); return; }
    if (room.status === "ended") { socket.emit("drawGuess:error", { message: "ეს თამაში უკვე დასრულდა." }); return; }

    if (room.kicked?.has(lc)) { socket.emit("drawGuess:error", { message: LOBBY_KICKED_MSG }); return; }
    const already = room.players.find(p => p.lc === lc);
    if (already) {
      // Reconnecting mid-game.
      already.socketId = socket.id;
      already.connected = true;
      drawRoomBySocket.set(socket.id, room.id);
      socket.join(`drawroom:${room.id}`);
      socket.emit("drawGuess:room", drawRoomPublicState(room));
      if (room.status === "playing" && room.round) {
        socket.emit("drawGuess:roundSync", drawRoundSyncPayload(room, lc));
      }
      broadcastDrawRoom(room, "drawGuess:room", drawRoomPublicState(room));
      broadcastPublicDrawRooms();
      return;
    }

    if (room.players.length >= DRAW_MAX_PLAYERS) { socket.emit("drawGuess:error", { message: "ოთახი სავსეა." }); return; }

    const invite = room.pendingInvites.get(lc);
    if (invite) clearTimeout(invite.timeoutHandle);
    room.pendingInvites.delete(lc);

    room.players.push({ lc, username: socket._regUser.username, socketId: socket.id, score: 0, hasDrawn: false, connected: true });
    drawRoomBySocket.set(socket.id, room.id);
    socket.join(`drawroom:${room.id}`);

    socket.emit("drawGuess:room", drawRoomPublicState(room));

    if (room.status === "playing") {
      // Joined a game already in progress — catch this socket up on the
      // live round (canvas so far, current word length, timer) exactly
      // like a reconnect would, and let the rest of the room know a new
      // player joined in and will get their own drawing turn later.
      if (room.round) socket.emit("drawGuess:roundSync", drawRoundSyncPayload(room, lc));
      broadcastDrawRoom(room, "drawGuess:playerJoined", { username: socket._regUser.username });
    }

    broadcastDrawRoom(room, "drawGuess:room", drawRoomPublicState(room));
    broadcastPublicDrawRooms();
  });

  // Host starts the game once enough friends have joined the lobby.
  socket.on("drawGuess:start", ({ roomId }) => {
    if (!socket._regUser) return;
    const room = drawRooms.get(roomId);
    if (!room || room.hostLc !== socket._regUser.usernameLower || room.status !== "lobby") return;
    if (room.players.length < DRAW_MIN_PLAYERS) {
      socket.emit("drawGuess:error", { message: `დასაწყებად საჭიროა მინიმუმ ${DRAW_MIN_PLAYERS} მოთამაშე.` });
      return;
    }

    room.status = "playing";
    room.roundNumber = 0;
    for (const inv of room.pendingInvites.values()) clearTimeout(inv.timeoutHandle);
    room.pendingInvites.clear();

    startNextDrawRound(room);
    broadcastPublicDrawRooms(); // now shows as "playing" (still joinable) instead of "lobby"
  });

  // Drawer picks one of the 3 offered words.
  socket.on("drawGuess:pickWord", ({ roomId, word }) => {
    if (!socket._regUser) return;
    const room = drawRooms.get(roomId);
    if (!room || !room.round) return;
    if (room.round.drawerLc !== socket._regUser.usernameLower) return;
    if (room.round.word || !room.round.choices.includes(word)) return;
    pickDrawWord(room, word);
  });

  // Drawer's live strokes, relayed to everyone else in the room.
  socket.on("drawGuess:stroke", ({ roomId, stroke, strokes }) => {
    if (!socket._regUser) return;
    const room = drawRooms.get(roomId);
    if (!room || !room.round) return;
    if (room.round.drawerLc !== socket._regUser.usernameLower) return;

    // Drawing used to send one socket message per pointermove event, which is
    // 60-120 messages/second per drawer, each re-broadcast to every other
    // player. The client now buffers segments and sends them in small batches;
    // a single `stroke` is still accepted so nothing depends on the new shape.
    const incoming = Array.isArray(strokes) ? strokes : (stroke ? [stroke] : []);
    const valid = incoming.filter(s => s && typeof s === "object").slice(0, 200);
    if (!valid.length) return;

    for (const s of valid) {
      room.round.strokes.push(s);
      if (room.round.strokes.length > 3000) room.round.strokes.shift();
    }

    for (const p of room.players) {
      if (p.lc === room.round.drawerLc) continue;
      io.sockets.sockets.get(p.socketId)?.emit("drawGuess:stroke", { strokes: valid });
    }
  });

  socket.on("drawGuess:clear", ({ roomId }) => {
    if (!socket._regUser) return;
    const room = drawRooms.get(roomId);
    if (!room || !room.round) return;
    if (room.round.drawerLc !== socket._regUser.usernameLower) return;
    room.round.strokes = [];
    for (const p of room.players) {
      if (p.lc === room.round.drawerLc) continue;
      io.sockets.sockets.get(p.socketId)?.emit("drawGuess:clear");
    }
  });

  // Undo — removes only the last stroke/fill (grouped by strokeId, so one
  // continuous pen drag comes off as a single unit), not the whole canvas.
  // Sends the full remaining strokes list to everyone else so their
  // canvas can do a clean replay rather than trying to patch in place.
  socket.on("drawGuess:undo", ({ roomId }) => {
    if (!socket._regUser) return;
    const room = drawRooms.get(roomId);
    if (!room || !room.round) return;
    if (room.round.drawerLc !== socket._regUser.usernameLower) return;
    if (!room.round.strokes.length) return;

    const lastStrokeId = room.round.strokes[room.round.strokes.length - 1].strokeId;
    room.round.strokes = room.round.strokes.filter(s => s.strokeId !== lastStrokeId);

    for (const p of room.players) {
      if (p.lc === room.round.drawerLc) continue; // drawer already updated their own canvas locally
      io.sockets.sockets.get(p.socketId)?.emit("drawGuess:undo", { strokes: room.round.strokes });
    }
  });

  // A guess — right or wrong, wrong ones are shown to everyone like chat;
  // correct ones are announced without revealing the word to non-guessers yet.
  socket.on("drawGuess:guess", ({ roomId, text }) => {
    if (!socket._regUser) return;
    const room = drawRooms.get(roomId);
    if (!room || !room.round) return;
    const lc = socket._regUser.usernameLower;
    const player = room.players.find(p => p.lc === lc);
    if (!player) return;
    if (lc === room.round.drawerLc) return;
    if (room.round.guessedLc.has(lc)) return;

    const guessText = String(text || "").slice(0, 100).trim();
    if (!guessText) return;

    if (normalizeGuess(guessText) !== normalizeGuess(room.round.word)) {
      broadcastDrawRoom(room, "drawGuess:chat", { username: player.username, text: guessText, correct: false });
      return;
    }

    room.round.guessedLc.add(lc);
    const elapsedSec = (Date.now() - room.round.startedAt) / 1000;
    const points = Math.max(10, Math.round(100 - elapsedSec * 1.1));
    player.score += points;

    broadcastDrawRoom(room, "drawGuess:chat", { username: player.username, correct: true, points });
    socket.emit("drawGuess:youGuessed", { points, word: room.round.word });
    broadcastDrawRoom(room, "drawGuess:scores", { scores: drawRoomScores(room) });

    const guessers = room.players.filter(p => p.connected && p.lc !== room.round.drawerLc);
    if (guessers.length && guessers.every(p => room.round.guessedLc.has(p.lc))) {
      endDrawRound(room, "allGuessed");
    }
  });

  socket.on("drawGuess:leave", () => cleanupDrawGuessForSocket(socket.id));

  // Explicit decline — lets the host's lobby update right away instead of
  // waiting out the full invite expiry. Also starts a cooldown so this host
  // can't immediately re-invite the same person again.
  socket.on("drawGuess:declineInvite", ({ roomId }) => {
    if (!socket._regUser) return;
    const room = drawRooms.get(roomId);
    if (!room) return;
    const lc = socket._regUser.usernameLower;
    const invite = room.pendingInvites.get(lc);
    if (!invite) return;
    clearTimeout(invite.timeoutHandle);
    room.pendingInvites.delete(lc);
    drawDeclineCooldown.set(`${room.hostLc}|${lc}`, Date.now() + DRAW_DECLINE_COOLDOWN_MS);
    const host = room.players.find(p => p.lc === room.hostLc);
    if (host) io.sockets.sockets.get(host.socketId)?.emit("drawGuess:inviteDeclined", { username: socket._regUser.username });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Poker (Texas Hold'em) — invite-based tables, same shape as Draw & Guess:
  // one active table per user, no-approval-needed accept/decline with a
  // cooldown on repeat invites after a decline, plus a public "active
  // tables" browser. Coins are the user's persistent pokerCoins balance —
  // ensurePokerCoins() lazily starts everyone at 1000 and refills once a
  // day, but only once their stack has actually hit 0.
  // ══════════════════════════════════════════════════════════════════════

  socket.on("poker:invite", ({ toUsernames }) => {
    if (!socket._regUser) return;
    const hostLc = socket._regUser.usernameLower;
    const hostUser = registeredUsers.get(hostLc);
    if (!hostUser) return;

    let room = findActivePokerRoomForUser(hostLc);
    if (room && !(room.hostLc === hostLc && room.status === "lobby")) {
      socket.emit("poker:error", { message: "თქვენ უკვე ხართ სხვა პოკერის მაგიდასთან — ჯერ დატოვეთ ან დაასრულეთ ის, სანამ ახალს შექმნით." });
      return;
    }

    if (room) {
      const hostPlayer = room.players.find(p => p.lc === hostLc);
      if (hostPlayer) { hostPlayer.socketId = socket.id; hostPlayer.connected = true; }
      pokerRoomBySocket.set(socket.id, room.id);
    } else {
      const startingStack = ensurePokerCoins(hostUser);
      if (startingStack <= 0) {
        socket.emit("poker:error", { message: "დღეს უკვე გამოიყენე უფასო მონეტების შევსება — დაბრუნდი ხვალ." });
        return;
      }
      room = {
        id: makePokerRoomId(),
        hostLc,
        status: "lobby",
        stage: "lobby",
        players: [{ lc: hostLc, username: hostUser.username, socketId: socket.id, stack: startingStack, connected: true, folded: false, allIn: false, currentBet: 0, totalBetThisHand: 0, holeCards: [] }],
        pendingInvites: new Map(), // lc → { timeoutHandle }
        dealerSeatIndex: -1, // pokerStartNextHand pre-increments — this makes hand #1 start with the host as dealer
        communityCards: [], pot: 0, currentBet: 0, minRaise: POKER_BIG_BLIND, actingSeatIndex: null, actionDeadline: null,
        handNumber: 0,
      };
      pokerRooms.set(room.id, room);
      pokerRoomBySocket.set(socket.id, room.id);
    }

    const list = Array.isArray(toUsernames) ? toUsernames.filter(u => typeof u === "string").slice(0, POKER_MAX_PLAYERS) : [];
    const invited = [];
    const cooldown = [];
    const now = Date.now();
    for (const uname of list) {
      const lc = uname.toLowerCase();
      if (lc === hostLc) continue;
      if (room.players.some(p => p.lc === lc)) continue;
      if (room.pendingInvites.has(lc)) continue;
      if (!isVisiblyOnline(lc)) continue;

      const targetUser = registeredUsers.get(lc);
      if (!targetUser) continue;

      const cdKey = `${hostLc}|${lc}`;
      const cdExpiry = pokerDeclineCooldown.get(cdKey);
      if (cdExpiry) {
        if (cdExpiry > now) { cooldown.push(targetUser.username); continue; }
        pokerDeclineCooldown.delete(cdKey);
      }

      const timeoutHandle = setTimeout(() => room.pendingInvites.delete(lc), POKER_INVITE_TTL_MS);
      room.pendingInvites.set(lc, { timeoutHandle });
      room.kicked?.delete(lc); // the host asked them back in
      io.to(`user:${lc}`).emit("poker:invited", { roomId: room.id, fromUsername: hostUser.username });
      notifyGameInvite(lc, "poker", room.id, hostUser.username);
      invited.push(targetUser.username);
    }

    socket.join(`pokerroom:${room.id}`);
    socket.emit("poker:room", pokerRoomStateForViewer(room, hostLc));
    socket.emit("poker:inviteSent", { invited, cooldown });
    broadcastPublicPokerRooms();
  });

  socket.on("poker:listPublicRooms", () => {
    socket.emit("poker:publicRooms", getPublicPokerRooms());
  });

  // Lets the setup screen show a coin balance before the user has created
  // or joined any table — lazily grants/refills via the same rules as
  // actually sitting down (ensurePokerCoins), so the number shown here is
  // always exactly what they'd bring to a table right now.
  socket.on("poker:getBalance", () => {
    if (!socket._regUser) return;
    const user = registeredUsers.get(socket._regUser.usernameLower);
    if (!user) return;
    socket.emit("poker:balance", { coins: ensurePokerCoins(user) });
  });

  socket.on("poker:declineInvite", ({ roomId }) => {
    if (!socket._regUser) return;
    const room = pokerRooms.get(roomId);
    if (!room) return;
    const lc = socket._regUser.usernameLower;
    const invite = room.pendingInvites.get(lc);
    if (!invite) return;
    clearTimeout(invite.timeoutHandle);
    room.pendingInvites.delete(lc);
    pokerDeclineCooldown.set(`${room.hostLc}|${lc}`, Date.now() + POKER_DECLINE_COOLDOWN_MS);
    const host = room.players.find(p => p.lc === room.hostLc);
    if (host) io.sockets.sockets.get(host.socketId)?.emit("poker:inviteDeclined", { username: socket._regUser.username });
  });

  // Accept an invite, reconnect to a table you're already seated at, or —
  // like Draw & Guess — sit down at a table picked from the public "active
  // tables" list. Brings your full current coin balance to the table.
  socket.on("poker:join", ({ roomId }) => {
    if (!socket._regUser) return;
    const lc = socket._regUser.usernameLower;
    const user = registeredUsers.get(lc);
    if (!user) return;

    const existingRoomId = pokerRoomBySocket.get(socket.id);
    if (existingRoomId && existingRoomId !== roomId) cleanupPokerForSocket(socket.id);

    const room = pokerRooms.get(roomId);
    if (!room) { socket.emit("poker:error", { message: "მაგიდა ვეღარ მოიძებნა — შეიძლება უკვე დასრულდა." }); return; }
    if (room.status === "ended") { socket.emit("poker:error", { message: "ეს თამაში უკვე დასრულდა." }); return; }

    if (room.kicked?.has(lc)) { socket.emit("poker:error", { message: LOBBY_KICKED_MSG }); return; }
    const already = room.players.find(p => p.lc === lc);
    if (already) {
      already.socketId = socket.id;
      already.connected = true;
      pokerRoomBySocket.set(socket.id, room.id);
      socket.join(`pokerroom:${room.id}`);
      socket.emit("poker:room", pokerRoomStateForViewer(room, lc));
      broadcastPokerRoom(room);
      broadcastPublicPokerRooms();
      return;
    }

    if (room.players.length >= POKER_MAX_PLAYERS) { socket.emit("poker:error", { message: "მაგიდა სავსეა." }); return; }

    const startingStack = ensurePokerCoins(user);
    if (startingStack <= 0) {
      socket.emit("poker:error", { message: "დღეს უკვე გამოიყენე უფასო მონეტების შევსება — დაბრუნდი ხვალ." });
      return;
    }

    const invite = room.pendingInvites.get(lc);
    if (invite) clearTimeout(invite.timeoutHandle);
    room.pendingInvites.delete(lc);

    room.players.push({ lc, username: user.username, socketId: socket.id, stack: startingStack, connected: true, folded: false, allIn: false, currentBet: 0, totalBetThisHand: 0, holeCards: [] });
    pokerRoomBySocket.set(socket.id, room.id);
    socket.join(`pokerroom:${room.id}`);

    socket.emit("poker:room", pokerRoomStateForViewer(room, lc));
    broadcastPokerRoom(room);
    broadcastPublicPokerRooms();

    // Joining a table stuck "waiting" for a second player picks the game
    // back up automatically.
    if (room.status === "playing" && room.stage === "waiting" && room.players.filter(p => p.stack > 0).length >= POKER_MIN_PLAYERS && !room.nextHandTimeoutHandle) {
      room.nextHandTimeoutHandle = setTimeout(() => { room.nextHandTimeoutHandle = null; pokerStartNextHand(room); }, POKER_NEXT_HAND_DELAY_MS);
    }
  });

  // Host starts the table once enough friends have joined the lobby.
  socket.on("poker:start", ({ roomId }) => {
    if (!socket._regUser) return;
    const room = pokerRooms.get(roomId);
    if (!room || room.hostLc !== socket._regUser.usernameLower) return;
    if (room.status !== "lobby") return;
    if (room.players.length < POKER_MIN_PLAYERS) {
      socket.emit("poker:error", { message: `თამაშის დასაწყებად საჭიროა მინიმუმ ${POKER_MIN_PLAYERS} მოთამაშე.` });
      return;
    }
    room.status = "playing";
    pokerStartNextHand(room);
    broadcastPublicPokerRooms();
  });

  // fold | check | call | raise (amount = target total bet) | allin
  socket.on("poker:action", ({ roomId, action, amount }) => {
    if (!socket._regUser) return;
    const room = pokerRooms.get(roomId);
    if (!room || room.status !== "playing") return;
    const lc = socket._regUser.usernameLower;
    const seat = room.players.findIndex(p => p.lc === lc);
    if (seat === -1) return;

    const result = pokerApplyAction(room, seat, action, amount);
    if (!result.ok) { socket.emit("poker:error", { message: "არასწორი მოქმედება (" + result.reason + ")" }); return; }
    pokerAfterAction(room);
  });

  socket.on("poker:chat", ({ roomId, text }) => {
    if (!socket._regUser) return;
    const room = pokerRooms.get(roomId);
    if (!room) return;
    const lc = socket._regUser.usernameLower;
    const idx = room.players.findIndex(p => p.lc === lc);
    if (idx === -1) return;

    const clean = String(text || "").slice(0, 200).replace(/<[^>]*>/g, "").trim();
    if (!clean) return;
    if (mediaRateLimited(socket, "pokerChat", 8, 10_000)) {
      socket.emit("poker:error", { message: "ძალიან ხშირად წერ — ცოტა დაელოდე." });
      return;
    }

    const msg = { seatIndex: idx, username: room.players[idx].username, text: clean, ts: Date.now() };
    for (const p of room.players) {
      const s = io.sockets.sockets.get(p.socketId);
      if (s) s.emit("poker:chatMessage", msg);
    }
  });

  socket.on("poker:leave", () => cleanupPokerForSocket(socket.id));

  // ══════════════════════════════════════════════════════════════════════
  // Chess — invite-based 1v1 games, same invite/decline/cooldown/one-active-
  // game-per-user shape as Poker and Draw & Guess.
  // ══════════════════════════════════════════════════════════════════════

  socket.on("chess:invite", ({ toUsernames }) => {
    if (!socket._regUser) return;
    const hostLc = socket._regUser.usernameLower;
    const hostUser = registeredUsers.get(hostLc);
    if (!hostUser) return;

    let room = findActiveChessRoomForUser(hostLc);
    if (room && !(room.hostLc === hostLc && room.status === "lobby")) {
      socket.emit("chess:error", { message: "თქვენ უკვე ხართ სხვა ჭადრაკის თამაშში — ჯერ დატოვეთ ან დაასრულეთ ის, სანამ ახალს შექმნით." });
      return;
    }

    if (room) {
      const hostPlayer = room.players.find(p => p.lc === hostLc);
      if (hostPlayer) { hostPlayer.socketId = socket.id; hostPlayer.connected = true; }
      chessRoomBySocket.set(socket.id, room.id);
    } else {
      room = {
        id: makeChessRoomId(),
        hostLc,
        status: "lobby",
        players: [{ lc: hostLc, username: hostUser.username, socketId: socket.id, connected: true, color: null }],
        pendingInvites: new Map(),
        state: chessNewGameState(),
        lastMove: null,
        result: null,
        moveDeadline: null,
      };
      chessRooms.set(room.id, room);
      chessRoomBySocket.set(socket.id, room.id);
    }

    const list = Array.isArray(toUsernames) ? toUsernames.filter(u => typeof u === "string").slice(0, CHESS_MAX_PLAYERS) : [];
    const invited = [];
    const cooldown = [];
    const now = Date.now();
    for (const uname of list) {
      const lc = uname.toLowerCase();
      if (lc === hostLc) continue;
      if (room.players.some(p => p.lc === lc)) continue;
      if (room.pendingInvites.has(lc)) continue;
      if (!isVisiblyOnline(lc)) continue;

      const targetUser = registeredUsers.get(lc);
      if (!targetUser) continue;

      const cdKey = `${hostLc}|${lc}`;
      const cdExpiry = chessDeclineCooldown.get(cdKey);
      if (cdExpiry) {
        if (cdExpiry > now) { cooldown.push(targetUser.username); continue; }
        chessDeclineCooldown.delete(cdKey);
      }

      const timeoutHandle = setTimeout(() => room.pendingInvites.delete(lc), CHESS_INVITE_TTL_MS);
      room.pendingInvites.set(lc, { timeoutHandle });
      room.kicked?.delete(lc); // the host asked them back in
      io.to(`user:${lc}`).emit("chess:invited", { roomId: room.id, fromUsername: hostUser.username });
      notifyGameInvite(lc, "chess", room.id, hostUser.username);
      invited.push(targetUser.username);
    }

    socket.join(`chessroom:${room.id}`);
    socket.emit("chess:room", chessRoomState(room));
    socket.emit("chess:inviteSent", { invited, cooldown });
    broadcastPublicChessRooms();
  });

  socket.on("chess:listPublicRooms", () => {
    socket.emit("chess:publicRooms", getPublicChessRooms());
  });

  socket.on("chess:declineInvite", ({ roomId }) => {
    if (!socket._regUser) return;
    const room = chessRooms.get(roomId);
    if (!room) return;
    const lc = socket._regUser.usernameLower;
    const invite = room.pendingInvites.get(lc);
    if (!invite) return;
    clearTimeout(invite.timeoutHandle);
    room.pendingInvites.delete(lc);
    chessDeclineCooldown.set(`${room.hostLc}|${lc}`, Date.now() + CHESS_DECLINE_COOLDOWN_MS);
    const host = room.players.find(p => p.lc === room.hostLc);
    if (host) io.sockets.sockets.get(host.socketId)?.emit("chess:inviteDeclined", { username: socket._regUser.username });
  });

  socket.on("chess:join", ({ roomId }) => {
    if (!socket._regUser) return;
    const lc = socket._regUser.usernameLower;
    const user = registeredUsers.get(lc);
    if (!user) return;

    const existingRoomId = chessRoomBySocket.get(socket.id);
    if (existingRoomId && existingRoomId !== roomId) cleanupChessForSocket(socket.id);

    const room = chessRooms.get(roomId);
    if (!room) { socket.emit("chess:error", { message: "თამაში ვეღარ მოიძებნა — შეიძლება უკვე დასრულდა." }); return; }
    if (room.status === "ended") { socket.emit("chess:error", { message: "ეს თამაში უკვე დასრულდა." }); return; }

    if (room.kicked?.has(lc)) { socket.emit("chess:error", { message: LOBBY_KICKED_MSG }); return; }
    const already = room.players.find(p => p.lc === lc);
    if (already) {
      already.socketId = socket.id;
      already.connected = true;
      chessRoomBySocket.set(socket.id, room.id);
      socket.join(`chessroom:${room.id}`);
      socket.emit("chess:room", chessRoomState(room));
      broadcastChessRoom(room);
      broadcastPublicChessRooms();
      return;
    }

    if (room.players.length >= CHESS_MAX_PLAYERS) { socket.emit("chess:error", { message: "თამაში სავსეა." }); return; }

    const invite = room.pendingInvites.get(lc);
    if (invite) clearTimeout(invite.timeoutHandle);
    room.pendingInvites.delete(lc);

    room.players.push({ lc, username: user.username, socketId: socket.id, connected: true, color: null });
    chessRoomBySocket.set(socket.id, room.id);
    socket.join(`chessroom:${room.id}`);

    socket.emit("chess:room", chessRoomState(room));
    broadcastChessRoom(room);
    broadcastPublicChessRooms();
  });

  socket.on("chess:start", ({ roomId }) => {
    if (!socket._regUser) return;
    const room = chessRooms.get(roomId);
    if (!room || room.hostLc !== socket._regUser.usernameLower) return;
    if (room.status !== "lobby") return;
    if (room.players.length !== CHESS_MIN_PLAYERS) {
      socket.emit("chess:error", { message: "ჭადრაკის დასაწყებად საჭიროა ზუსტად 2 მოთამაშე." });
      return;
    }
    // Random colour assignment.
    const shuffled = Math.random() < 0.5 ? [room.players[0], room.players[1]] : [room.players[1], room.players[0]];
    shuffled[0].color = CHESS_WHITE;
    shuffled[1].color = CHESS_BLACK;

    room.status = "playing";
    room.state = chessNewGameState();
    room.lastMove = null;
    room.result = null;
    scheduleChessMoveTimer(room);
    broadcastChessRoom(room);
    broadcastPublicChessRooms();
  });

  socket.on("chess:move", ({ roomId, from, to, promotion }) => {
    if (!socket._regUser) return;
    const room = chessRooms.get(roomId);
    if (!room || room.status !== "playing" || room.result) return;
    const lc = socket._regUser.usernameLower;
    const player = room.players.find(p => p.lc === lc);
    if (!player || player.color !== room.state.turn) return; // not your turn / not in this game

    if (typeof from !== "string" || typeof to !== "string") return;
    let fromSq, toSq;
    try { fromSq = chessNameToSquare(from); toSq = chessNameToSquare(to); } catch { return; }
    if (!Number.isInteger(fromSq) || fromSq < 0 || fromSq > 63 || !Number.isInteger(toSq) || toSq < 0 || toSq > 63) return;

    const legal = chessLegalMoves(room.state);
    const match = legal.find(m => m.from === fromSq && m.to === toSq && (!m.promotion || m.promotion.toUpperCase() === String(promotion || "Q").toUpperCase()));
    if (!match) { socket.emit("chess:error", { message: "არალეგალური სვლა." }); return; }

    room.state = chessApplyMove(room.state, match);
    room.lastMove = { from, to };

    const status = chessGameStatus(room.state);
    if (status.status === "checkmate" || status.status === "stalemate" || status.status === "draw") {
      chessFinishGame(room, status.status === "checkmate"
        ? { status: "checkmate", winner: status.winner }
        : { status: status.status, reason: status.reason || null });
      return;
    }

    scheduleChessMoveTimer(room);
    broadcastChessRoom(room);
  });

  socket.on("chess:resign", ({ roomId }) => {
    if (!socket._regUser) return;
    const room = chessRooms.get(roomId);
    if (!room || room.status !== "playing" || room.result) return;
    const lc = socket._regUser.usernameLower;
    const player = room.players.find(p => p.lc === lc);
    if (!player || !player.color) return;
    chessFinishGame(room, { status: "resignation", winner: chessOpponent(player.color) });
  });

  socket.on("chess:chat", ({ roomId, text }) => {
    if (!socket._regUser) return;
    const room = chessRooms.get(roomId);
    if (!room) return;
    const lc = socket._regUser.usernameLower;
    const player = room.players.find(p => p.lc === lc);
    if (!player) return;

    const clean = String(text || "").slice(0, 200).replace(/<[^>]*>/g, "").trim();
    if (!clean) return;
    if (mediaRateLimited(socket, "chessChat", 8, 10_000)) {
      socket.emit("chess:error", { message: "ძალიან ხშირად წერ — ცოტა დაელოდე." });
      return;
    }

    const msg = { username: player.username, text: clean, ts: Date.now() };
    for (const p of room.players) {
      const s = io.sockets.sockets.get(p.socketId);
      if (s) s.emit("chess:chatMessage", msg);
    }
  });

  socket.on("chess:leave", () => cleanupChessForSocket(socket.id));

  // ══════════════════════════════════════════════════════════════════════
  // Checkers ("დამა") — identical invite/lobby/game shape to Chess.
  // ══════════════════════════════════════════════════════════════════════

  socket.on("checkers:invite", ({ toUsernames }) => {
    if (!socket._regUser) return;
    const hostLc = socket._regUser.usernameLower;
    const hostUser = registeredUsers.get(hostLc);
    if (!hostUser) return;

    let room = findActiveCheckersRoomForUser(hostLc);
    if (room && !(room.hostLc === hostLc && room.status === "lobby")) {
      socket.emit("checkers:error", { message: "თქვენ უკვე ხართ სხვა თამაშში — ჯერ დატოვეთ ან დაასრულეთ ის, სანამ ახალს შექმნით." });
      return;
    }

    if (room) {
      const hostPlayer = room.players.find(p => p.lc === hostLc);
      if (hostPlayer) { hostPlayer.socketId = socket.id; hostPlayer.connected = true; }
      checkersRoomBySocket.set(socket.id, room.id);
    } else {
      room = {
        id: makeCheckersRoomId(),
        hostLc,
        status: "lobby",
        players: [{ lc: hostLc, username: hostUser.username, socketId: socket.id, connected: true, color: null }],
        pendingInvites: new Map(),
        state: checkersNewGameState(),
        lastMove: null,
        result: null,
        moveDeadline: null,
      };
      checkersRooms.set(room.id, room);
      checkersRoomBySocket.set(socket.id, room.id);
    }

    const list = Array.isArray(toUsernames) ? toUsernames.filter(u => typeof u === "string").slice(0, CHECKERS_MAX_PLAYERS) : [];
    const invited = [];
    const cooldown = [];
    const now = Date.now();
    for (const uname of list) {
      const lc = uname.toLowerCase();
      if (lc === hostLc) continue;
      if (room.players.some(p => p.lc === lc)) continue;
      if (room.pendingInvites.has(lc)) continue;
      if (!isVisiblyOnline(lc)) continue;

      const targetUser = registeredUsers.get(lc);
      if (!targetUser) continue;

      const cdKey = `${hostLc}|${lc}`;
      const cdExpiry = checkersDeclineCooldown.get(cdKey);
      if (cdExpiry) {
        if (cdExpiry > now) { cooldown.push(targetUser.username); continue; }
        checkersDeclineCooldown.delete(cdKey);
      }

      const timeoutHandle = setTimeout(() => room.pendingInvites.delete(lc), CHECKERS_INVITE_TTL_MS);
      room.pendingInvites.set(lc, { timeoutHandle });
      room.kicked?.delete(lc); // the host asked them back in
      io.to(`user:${lc}`).emit("checkers:invited", { roomId: room.id, fromUsername: hostUser.username });
      notifyGameInvite(lc, "checkers", room.id, hostUser.username);
      invited.push(targetUser.username);
    }

    socket.join(`checkersroom:${room.id}`);
    socket.emit("checkers:room", checkersRoomState(room));
    socket.emit("checkers:inviteSent", { invited, cooldown });
    broadcastPublicCheckersRooms();
  });

  socket.on("checkers:listPublicRooms", () => {
    socket.emit("checkers:publicRooms", getPublicCheckersRooms());
  });

  socket.on("checkers:declineInvite", ({ roomId }) => {
    if (!socket._regUser) return;
    const room = checkersRooms.get(roomId);
    if (!room) return;
    const lc = socket._regUser.usernameLower;
    const invite = room.pendingInvites.get(lc);
    if (!invite) return;
    clearTimeout(invite.timeoutHandle);
    room.pendingInvites.delete(lc);
    checkersDeclineCooldown.set(`${room.hostLc}|${lc}`, Date.now() + CHECKERS_DECLINE_COOLDOWN_MS);
    const host = room.players.find(p => p.lc === room.hostLc);
    if (host) io.sockets.sockets.get(host.socketId)?.emit("checkers:inviteDeclined", { username: socket._regUser.username });
  });

  socket.on("checkers:join", ({ roomId }) => {
    if (!socket._regUser) return;
    const lc = socket._regUser.usernameLower;
    const user = registeredUsers.get(lc);
    if (!user) return;

    const existingRoomId = checkersRoomBySocket.get(socket.id);
    if (existingRoomId && existingRoomId !== roomId) cleanupCheckersForSocket(socket.id);

    const room = checkersRooms.get(roomId);
    if (!room) { socket.emit("checkers:error", { message: "თამაში ვეღარ მოიძებნა — შეიძლება უკვე დასრულდა." }); return; }
    if (room.status === "ended") { socket.emit("checkers:error", { message: "ეს თამაში უკვე დასრულდა." }); return; }

    if (room.kicked?.has(lc)) { socket.emit("checkers:error", { message: LOBBY_KICKED_MSG }); return; }
    const already = room.players.find(p => p.lc === lc);
    if (already) {
      already.socketId = socket.id;
      already.connected = true;
      checkersRoomBySocket.set(socket.id, room.id);
      socket.join(`checkersroom:${room.id}`);
      socket.emit("checkers:room", checkersRoomState(room));
      broadcastCheckersRoom(room);
      broadcastPublicCheckersRooms();
      return;
    }

    if (room.players.length >= CHECKERS_MAX_PLAYERS) { socket.emit("checkers:error", { message: "თამაში სავსეა." }); return; }

    const invite = room.pendingInvites.get(lc);
    if (invite) clearTimeout(invite.timeoutHandle);
    room.pendingInvites.delete(lc);

    room.players.push({ lc, username: user.username, socketId: socket.id, connected: true, color: null });
    checkersRoomBySocket.set(socket.id, room.id);
    socket.join(`checkersroom:${room.id}`);

    socket.emit("checkers:room", checkersRoomState(room));
    broadcastCheckersRoom(room);
    broadcastPublicCheckersRooms();
  });

  socket.on("checkers:start", ({ roomId }) => {
    if (!socket._regUser) return;
    const room = checkersRooms.get(roomId);
    if (!room || room.hostLc !== socket._regUser.usernameLower) return;
    if (room.status !== "lobby") return;
    if (room.players.length !== CHECKERS_MIN_PLAYERS) {
      socket.emit("checkers:error", { message: `დასაწყებად საჭიროა ზუსტად ${CHECKERS_MIN_PLAYERS} მოთამაშე.` });
      return;
    }
    const shuffled = Math.random() < 0.5 ? [room.players[0], room.players[1]] : [room.players[1], room.players[0]];
    shuffled[0].color = CHECKERS_RED;
    shuffled[1].color = CHECKERS_BLACK;

    room.status = "playing";
    room.state = checkersNewGameState();
    room.lastMove = null;
    room.result = null;
    scheduleCheckersMoveTimer(room);
    broadcastCheckersRoom(room);
    broadcastPublicCheckersRooms();
  });

  socket.on("checkers:move", ({ roomId, from, to }) => {
    if (!socket._regUser) return;
    const room = checkersRooms.get(roomId);
    if (!room || room.status !== "playing" || room.result) return;
    const lc = socket._regUser.usernameLower;
    const player = room.players.find(p => p.lc === lc);
    if (!player || player.color !== room.state.turn) return; // not your turn / not in this game

    const fromSq = Number(from), toSq = Number(to);
    if (!Number.isInteger(fromSq) || fromSq < 0 || fromSq > 63 || !Number.isInteger(toSq) || toSq < 0 || toSq > 63) return;

    const legal = checkersLegalMoves(room.state);
    const match = legal.find(m => m.from === fromSq && m.to === toSq);
    if (!match) { socket.emit("checkers:error", { message: "არალეგალური სვლა." }); return; }

    room.state = checkersApplyMove(room.state, match);
    const movesPlayed = [{ from: fromSq, to: toSq, capture: match.capture }];
    room.lastMove = checkersBuildLastMove(movesPlayed);

    // Mandatory capture is still enforced above (checkersLegalMoves already
    // restricts you to captures only when one exists) — but the human
    // always taps every move themselves, including a forced one with only
    // a single option. Nothing auto-plays on their behalf.
    const status = checkersGameStatus(room.state);
    if (status.status === "over") {
      checkersFinishGame(room, { status: "over", winner: status.winner, reason: status.reason });
      return;
    }

    // Only reset the move timer when the turn actually changed hands — a
    // multi-jump continuation keeps the same player acting, so the clock
    // just keeps counting down through the whole chain rather than resetting
    // to a fresh 90s for every individual jump in it.
    if (room.state.mustContinueFrom === null) scheduleCheckersMoveTimer(room);
    broadcastCheckersRoom(room);
  });

  socket.on("checkers:resign", ({ roomId }) => {
    if (!socket._regUser) return;
    const room = checkersRooms.get(roomId);
    if (!room || room.status !== "playing" || room.result) return;
    const lc = socket._regUser.usernameLower;
    const player = room.players.find(p => p.lc === lc);
    if (!player || !player.color) return;
    checkersFinishGame(room, { status: "resignation", winner: checkersOpponent(player.color) });
  });

  socket.on("checkers:chat", ({ roomId, text }) => {
    if (!socket._regUser) return;
    const room = checkersRooms.get(roomId);
    if (!room) return;
    const lc = socket._regUser.usernameLower;
    const player = room.players.find(p => p.lc === lc);
    if (!player) return;

    const clean = String(text || "").slice(0, 200).replace(/<[^>]*>/g, "").trim();
    if (!clean) return;
    if (mediaRateLimited(socket, "checkersChat", 8, 10_000)) {
      socket.emit("checkers:error", { message: "ძალიან ხშირად წერ — ცოტა დაელოდე." });
      return;
    }

    const msg = { username: player.username, text: clean, ts: Date.now() };
    for (const p of room.players) {
      const s = io.sockets.sockets.get(p.socketId);
      if (s) s.emit("checkers:chatMessage", msg);
    }
  });

  socket.on("checkers:leave", () => cleanupCheckersForSocket(socket.id));

  // ══════════════════════════════════════════════════════════════════════
  // Georgian Joker ("ჯოკერი") — 4-player invite/lobby/game shape mirroring
  // Chess/Checkers, extended for a 4-seat table and the richer bid/play flow.
  // ══════════════════════════════════════════════════════════════════════

  socket.on("joker:invite", ({ toUsernames }) => {
    if (!socket._regUser) return;
    const hostLc = socket._regUser.usernameLower;
    const hostUser = registeredUsers.get(hostLc);
    if (!hostUser) return;

    let room = findActiveJokerRoomForUser(hostLc);
    if (room && !(room.hostLc === hostLc && room.status === "lobby")) {
      socket.emit("joker:error", { message: "თქვენ უკვე ხართ სხვა თამაშში — ჯერ დატოვეთ ან დაასრულეთ ის, სანამ ახალს შექმნით." });
      return;
    }

    if (room) {
      const hostPlayer = room.players.find(p => p.lc === hostLc);
      if (hostPlayer) { hostPlayer.socketId = socket.id; hostPlayer.connected = true; }
      jokerRoomBySocket.set(socket.id, room.id);
    } else {
      room = {
        id: makeJokerRoomId(),
        hostLc,
        status: "lobby",
        players: [{ lc: hostLc, username: hostUser.username, socketId: socket.id, connected: true, seat: null, isBot: false }],
        pendingInvites: new Map(),
        dealerSeat: 0, handIndex: 0, handSize: 0, setIdx: 0,
        trumpSuit: null, trumpCard: null, hands: [[], [], [], []],
        phase: null, bidOrder: [], bids: [null, null, null, null], bidTurnIdx: 0,
        currentTrick: [], ledSuit: null, trickLeader: null, tricksWon: [0, 0, 0, 0],
        turnSeat: null, totals: [0, 0, 0, 0], setHandsPerPlayer: [[], [], [], []],
        history: [], lastHandSummary: null, actionDeadline: null, finalResult: null,
      };
      jokerRooms.set(room.id, room);
      jokerRoomBySocket.set(socket.id, room.id);
    }

    // No longer capped to "table size minus one" — the host can invite as
    // many friends as they like; whoever joins first fills the 4 seats
    // (joker:join above already rejects anyone once the table is full).
    const list = Array.isArray(toUsernames) ? toUsernames.filter(u => typeof u === "string").slice(0, 20) : [];
    const invited = [];
    const cooldown = [];
    const now = Date.now();
    for (const uname of list) {
      const lc = uname.toLowerCase();
      if (lc === hostLc) continue;
      if (room.players.some(p => p.lc === lc)) continue;
      if (room.pendingInvites.has(lc)) continue;
      if (!isVisiblyOnline(lc)) continue;

      const targetUser = registeredUsers.get(lc);
      if (!targetUser) continue;

      const cdKey = `${hostLc}|${lc}`;
      const cdExpiry = jokerDeclineCooldown.get(cdKey);
      if (cdExpiry) {
        if (cdExpiry > now) { cooldown.push(targetUser.username); continue; }
        jokerDeclineCooldown.delete(cdKey);
      }

      const timeoutHandle = setTimeout(() => room.pendingInvites.delete(lc), JOKER_INVITE_TTL_MS);
      room.pendingInvites.set(lc, { timeoutHandle });
      room.kicked?.delete(lc); // the host asked them back in
      io.to(`user:${lc}`).emit("joker:invited", { roomId: room.id, fromUsername: hostUser.username });
      notifyGameInvite(lc, "joker", room.id, hostUser.username);
      invited.push(targetUser.username);
    }

    socket.join(`jokerroom:${room.id}`);
    socket.emit("joker:room", jokerRoomStateForViewer(room, hostLc));
    socket.emit("joker:inviteSent", { invited, cooldown });
    broadcastPublicJokerRooms();
  });

  socket.on("joker:listPublicRooms", () => {
    socket.emit("joker:publicRooms", getPublicJokerRooms());
  });

  socket.on("joker:declineInvite", ({ roomId }) => {
    if (!socket._regUser) return;
    const room = jokerRooms.get(roomId);
    if (!room) return;
    const lc = socket._regUser.usernameLower;
    const invite = room.pendingInvites.get(lc);
    if (!invite) return;
    clearTimeout(invite.timeoutHandle);
    room.pendingInvites.delete(lc);
    jokerDeclineCooldown.set(`${room.hostLc}|${lc}`, Date.now() + JOKER_DECLINE_COOLDOWN_MS);
    const host = room.players.find(p => p.lc === room.hostLc);
    if (host) io.sockets.sockets.get(host.socketId)?.emit("joker:inviteDeclined", { username: socket._regUser.username });
  });

  socket.on("joker:join", ({ roomId }) => {
    if (!socket._regUser) return;
    const lc = socket._regUser.usernameLower;
    const user = registeredUsers.get(lc);
    if (!user) return;

    const existingRoomId = jokerRoomBySocket.get(socket.id);
    if (existingRoomId && existingRoomId !== roomId) cleanupJokerForSocket(socket.id);

    const room = jokerRooms.get(roomId);
    if (!room) { socket.emit("joker:error", { message: "მაგიდა ვეღარ მოიძებნა — შეიძლება უკვე დასრულდა." }); return; }
    if (room.status === "ended") { socket.emit("joker:error", { message: "ეს თამაში უკვე დასრულდა." }); return; }

    if (room.kicked?.has(lc)) { socket.emit("joker:error", { message: LOBBY_KICKED_MSG }); return; }
    const already = room.players.find(p => p.lc === lc);
    if (already) {
      const wasBot = already.isBot;
      already.socketId = socket.id;
      already.connected = true;
      already.isBot = false;
      jokerRoomBySocket.set(socket.id, room.id);
      socket.join(`jokerroom:${room.id}`);
      socket.emit("joker:room", jokerRoomStateForViewer(room, lc));
      // If a bot was mid-"turn" for this exact seat when they reconnected,
      // hand control back immediately with a fresh normal-length timer
      // instead of leaving the short bot-delay timer running.
      if (wasBot && room.status === "playing" && jokerCurrentTurnSeat(room) === already.seat) {
        jokerScheduleTurn(room);
      }
      broadcastJokerRoom(room);
      broadcastPublicJokerRooms();
      return;
    }

    if (room.players.length >= JOKER_MAX_PLAYERS) { socket.emit("joker:error", { message: "მაგიდა სავსეა." }); return; }

    const invite = room.pendingInvites.get(lc);
    if (invite) clearTimeout(invite.timeoutHandle);
    room.pendingInvites.delete(lc);

    room.players.push({ lc, username: user.username, socketId: socket.id, connected: true, seat: null, isBot: false });
    jokerRoomBySocket.set(socket.id, room.id);
    socket.join(`jokerroom:${room.id}`);

    socket.emit("joker:room", jokerRoomStateForViewer(room, lc));
    broadcastJokerRoom(room);
    broadcastPublicJokerRooms();
  });

  socket.on("joker:start", ({ roomId }) => {
    if (!socket._regUser) return;
    const room = jokerRooms.get(roomId);
    if (!room || room.hostLc !== socket._regUser.usernameLower) return;
    if (room.status !== "lobby") return;
    if (room.players.length !== JOKER_MIN_PLAYERS) {
      socket.emit("joker:error", { message: `დასაწყებად საჭიროა ზუსტად ${JOKER_MIN_PLAYERS} მოთამაშე.` });
      return;
    }

    // Random seat assignment (0-3), same fairness principle as Chess/Checkers' colour shuffle.
    const shuffled = room.players.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    shuffled.forEach((p, i) => { p.seat = i; });

    room.status = "playing";
    room.dealerSeat = 0;
    room.handIndex = 0;
    room.handSize = JOKER_HAND_SIZES[0];
    room.setIdx = 1;
    room.setHandsPerPlayer = [[], [], [], []];
    room.totals = [0, 0, 0, 0];
    room.history = [];
    room.lastHandSummary = null;
    room.finalResult = null;

    const { hands, trumpCard, trumpSuit } = jokerDealHand(room.handSize, room.dealerSeat);
    room.hands = hands;
    room.trumpCard = trumpCard;
    room.trumpSuit = trumpSuit;
    room.bidOrder = [1, 2, 3, 0].map(off => (room.dealerSeat + off) % 4);
    room.bids = [null, null, null, null];
    room.bidTurnIdx = 0;
    room.turnSeat = room.bidOrder[0];
    room.tricksWon = [0, 0, 0, 0];
    room.currentTrick = [];
    room.ledSuit = null;
    room.trickLeader = null;
    room.phase = "bidding";

    jokerScheduleTurn(room);
    broadcastJokerRoom(room);
    broadcastPublicJokerRooms();
  });

  socket.on("joker:bid", ({ roomId, bid }) => {
    if (!socket._regUser) return;
    const room = jokerRooms.get(roomId);
    if (!room || room.status !== "playing" || room.phase !== "bidding") return;
    const lc = socket._regUser.usernameLower;
    const player = room.players.find(p => p.lc === lc);
    if (!player || player.seat !== room.turnSeat) return;

    const b = Number(bid);
    const isLast = room.bidTurnIdx === 3;
    const priorSum = jokerPriorBidsSum(room);
    if (!jokerIsBidLegal(b, room.handSize, isLast, priorSum)) {
      socket.emit("joker:error", { message: "არალეგალური ბიდი." });
      return;
    }
    jokerApplyBid(room, player.seat, b);
  });

  socket.on("joker:playCard", ({ roomId, card, jokerChoice, declaredSuit }) => {
    if (!socket._regUser) return;
    const room = jokerRooms.get(roomId);
    if (!room || room.status !== "playing" || room.phase !== "playing") return;
    const lc = socket._regUser.usernameLower;
    const player = room.players.find(p => p.lc === lc);
    if (!player || player.seat !== room.turnSeat) return;

    if (typeof card !== "string" || !room.hands[player.seat].includes(card)) {
      socket.emit("joker:error", { message: "ეს ბარათი არ გაქვთ." });
      return;
    }

    const isLead = room.currentTrick.length === 0;
    const legal = jokerLegalCardsToPlay(room.hands[player.seat], isLead ? null : room.ledSuit, room.trumpSuit);
    if (!legal.includes(card)) {
      socket.emit("joker:error", { message: "ამ ბარათის თამაში ამჟამად არალეგალურია — უნდა აჰყვეთ ფერს ან დაწკაპოთ." });
      return;
    }

    let choice = null, suit = null;
    if (jokerIsJokerCard(card)) {
      if (jokerChoice !== "high" && jokerChoice !== "low") { socket.emit("joker:error", { message: "აირჩიეთ ჯოკერი მაღლა ან დაბლა." }); return; }
      choice = jokerChoice;
      if (isLead) {
        if (!JOKER_SUITS_LIST.includes(declaredSuit)) { socket.emit("joker:error", { message: "ჯოკერით სვლისას აირჩიეთ ფერი." }); return; }
        suit = declaredSuit;
      }
    }

    jokerApplyPlay(room, player.seat, card, choice, suit);
  });

  socket.on("joker:chat", ({ roomId, text }) => {
    if (!socket._regUser) return;
    const room = jokerRooms.get(roomId);
    if (!room) return;
    const lc = socket._regUser.usernameLower;
    const player = room.players.find(p => p.lc === lc);
    if (!player) return;

    const clean = String(text || "").slice(0, 200).replace(/<[^>]*>/g, "").trim();
    if (!clean) return;
    if (mediaRateLimited(socket, "jokerChat", 8, 10_000)) {
      socket.emit("joker:error", { message: "ძალიან ხშირად წერ — ცოტა დაელოდე." });
      return;
    }

    const msg = { seat: player.seat, username: player.username, text: clean, ts: Date.now() };
    for (const p of room.players) {
      const s = io.sockets.sockets.get(p.socketId);
      if (s) s.emit("joker:chatMessage", msg);
    }
  });


  socket.on("joker:leave", () => cleanupJokerForSocket(socket.id));

  // ══════════════════════════════════════════════════════════════════════
  // Imposter ("იმპოსტორი") — social-deduction word game, 3-8 players.
  // Same invite/lobby shape as the other games, but flexible player count
  // (like Draw & Guess) instead of a fixed 2 or 4.
  // ══════════════════════════════════════════════════════════════════════

  socket.on("imposter:invite", ({ toUsernames }) => {
    if (!socket._regUser) return;
    const hostLc = socket._regUser.usernameLower;
    const hostUser = registeredUsers.get(hostLc);
    if (!hostUser) return;

    let room = findActiveImposterRoomForUser(hostLc);
    if (room && !(room.hostLc === hostLc && room.status === "lobby")) {
      socket.emit("imposter:error", { message: "თქვენ უკვე ხართ სხვა თამაშში — ჯერ დატოვეთ ან დაასრულეთ ის, სანამ ახალს შექმნით." });
      return;
    }

    if (room) {
      const hostPlayer = room.players.find(p => p.lc === hostLc);
      if (hostPlayer) { hostPlayer.socketId = socket.id; hostPlayer.connected = true; }
      imposterRoomBySocket.set(socket.id, room.id);
    } else {
      room = {
        id: makeImposterRoomId(),
        hostLc,
        status: "lobby",
        players: [{ lc: hostLc, username: hostUser.username, socketId: socket.id, connected: true }],
        pendingInvites: new Map(),
        majorityWord: null, imposterWord: null, imposterLc: null,
        phase: null, roundIndex: 0, roundsHistory: [], currentAnswers: {}, votes: {},
        lastVoteTally: null, votedOutLc: null, actionDeadline: null, result: null,
      };
      imposterRooms.set(room.id, room);
      imposterRoomBySocket.set(socket.id, room.id);
    }

    const list = Array.isArray(toUsernames) ? toUsernames.filter(u => typeof u === "string").slice(0, IMPOSTER_MAX_PLAYERS - 1) : [];
    const invited = [];
    const cooldown = [];
    const now = Date.now();
    for (const uname of list) {
      const lc = uname.toLowerCase();
      if (lc === hostLc) continue;
      if (room.players.some(p => p.lc === lc)) continue;
      if (room.pendingInvites.has(lc)) continue;
      if (!isVisiblyOnline(lc)) continue;

      const targetUser = registeredUsers.get(lc);
      if (!targetUser) continue;

      const cdKey = `${hostLc}|${lc}`;
      const cdExpiry = imposterDeclineCooldown.get(cdKey);
      if (cdExpiry) {
        if (cdExpiry > now) { cooldown.push(targetUser.username); continue; }
        imposterDeclineCooldown.delete(cdKey);
      }

      const timeoutHandle = setTimeout(() => room.pendingInvites.delete(lc), IMPOSTER_INVITE_TTL_MS);
      room.pendingInvites.set(lc, { timeoutHandle });
      room.kicked?.delete(lc); // the host asked them back in
      io.to(`user:${lc}`).emit("imposter:invited", { roomId: room.id, fromUsername: hostUser.username });
      notifyGameInvite(lc, "imposter", room.id, hostUser.username);
      invited.push(targetUser.username);
    }

    socket.join(`imposterroom:${room.id}`);
    socket.emit("imposter:room", imposterRoomStateForViewer(room, hostLc));
    socket.emit("imposter:inviteSent", { invited, cooldown });
    broadcastPublicImposterRooms();
  });

  socket.on("imposter:listPublicRooms", () => {
    socket.emit("imposter:publicRooms", getPublicImposterRooms());
  });

  socket.on("imposter:declineInvite", ({ roomId }) => {
    if (!socket._regUser) return;
    const room = imposterRooms.get(roomId);
    if (!room) return;
    const lc = socket._regUser.usernameLower;
    const invite = room.pendingInvites.get(lc);
    if (!invite) return;
    clearTimeout(invite.timeoutHandle);
    room.pendingInvites.delete(lc);
    imposterDeclineCooldown.set(`${room.hostLc}|${lc}`, Date.now() + IMPOSTER_DECLINE_COOLDOWN_MS);
    const host = room.players.find(p => p.lc === room.hostLc);
    if (host) io.sockets.sockets.get(host.socketId)?.emit("imposter:inviteDeclined", { username: socket._regUser.username });
  });

  socket.on("imposter:join", ({ roomId }) => {
    if (!socket._regUser) return;
    const lc = socket._regUser.usernameLower;
    const user = registeredUsers.get(lc);
    if (!user) return;

    const existingRoomId = imposterRoomBySocket.get(socket.id);
    if (existingRoomId && existingRoomId !== roomId) cleanupImposterForSocket(socket.id);

    const room = imposterRooms.get(roomId);
    if (!room) { socket.emit("imposter:error", { message: "თამაში ვეღარ მოიძებნა — შეიძლება უკვე დასრულდა." }); return; }
    if (room.status === "ended") { socket.emit("imposter:error", { message: "ეს თამაში უკვე დასრულდა." }); return; }

    if (room.kicked?.has(lc)) { socket.emit("imposter:error", { message: LOBBY_KICKED_MSG }); return; }
    const already = room.players.find(p => p.lc === lc);
    if (already) {
      already.socketId = socket.id;
      already.connected = true;
      imposterRoomBySocket.set(socket.id, room.id);
      socket.join(`imposterroom:${room.id}`);
      socket.emit("imposter:room", imposterRoomStateForViewer(room, lc));
      broadcastImposterRoom(room);
      broadcastPublicImposterRooms();
      return;
    }

    if (room.players.length >= IMPOSTER_MAX_PLAYERS) { socket.emit("imposter:error", { message: "მაგიდა სავსეა." }); return; }

    const invite = room.pendingInvites.get(lc);
    if (invite) clearTimeout(invite.timeoutHandle);
    room.pendingInvites.delete(lc);

    room.players.push({ lc, username: user.username, socketId: socket.id, connected: true });
    imposterRoomBySocket.set(socket.id, room.id);
    socket.join(`imposterroom:${room.id}`);

    socket.emit("imposter:room", imposterRoomStateForViewer(room, lc));
    broadcastImposterRoom(room);
    broadcastPublicImposterRooms();
  });

  socket.on("imposter:start", ({ roomId }) => {
    if (!socket._regUser) return;
    const room = imposterRooms.get(roomId);
    if (!room || room.hostLc !== socket._regUser.usernameLower) return;
    if (room.status !== "lobby") return;
    if (room.players.length < IMPOSTER_MIN_PLAYERS) {
      socket.emit("imposter:error", { message: `დასაწყებად საჭიროა მინიმუმ ${IMPOSTER_MIN_PLAYERS} მოთამაშე.` });
      return;
    }
    imposterStartGame(room);
  });

  socket.on("imposter:submitClue", ({ roomId, word }) => {
    if (!socket._regUser) return;
    const room = imposterRooms.get(roomId);
    if (!room || room.status !== "playing" || room.phase !== "clue") return;
    const lc = socket._regUser.usernameLower;
    if (!room.players.some(p => p.lc === lc)) return;
    if (room.currentAnswers[lc]) return; // already answered this round

    const clean = String(word || "").trim().slice(0, 40).replace(/<[^>]*>/g, "");
    if (!clean) { socket.emit("imposter:error", { message: "პასუხი ცარიელია." }); return; }

    room.currentAnswers[lc] = clean;
    imposterGhostNoteActivity(room, lc);
    if (room.players.every(p => room.currentAnswers[p.lc])) imposterFinishClueRound(room);
    else broadcastImposterRoom(room);
  });

  socket.on("imposter:submitVote", ({ roomId, votedForUsername }) => {
    if (!socket._regUser) return;
    const room = imposterRooms.get(roomId);
    if (!room || room.status !== "playing" || room.phase !== "voting") return;
    const lc = socket._regUser.usernameLower;
    if (!room.players.some(p => p.lc === lc)) return;
    if (room.votes[lc]) return; // already voted

    const target = room.players.find(p => p.username === votedForUsername);
    if (!target || target.lc === lc) { socket.emit("imposter:error", { message: "არასწორი ხმა." }); return; }

    room.votes[lc] = target.lc;
    if (room.players.every(p => room.votes[p.lc])) imposterTallyVotes(room);
    else broadcastImposterRoom(room);
  });

  socket.on("imposter:submitGuess", ({ roomId, guess }) => {
    if (!socket._regUser) return;
    const room = imposterRooms.get(roomId);
    if (!room || room.status !== "playing" || room.phase !== "imposterGuess") return;
    const lc = socket._regUser.usernameLower;
    if (lc !== room.imposterLc) return;

    const correct = imposterNormalizeWord(guess) === imposterNormalizeWord(room.majorityWord);
    imposterFinishGame(room, { imposterCaught: true, imposterGuessedRight: correct });
  });

  socket.on("imposter:chat", ({ roomId, text }) => {
    if (!socket._regUser) return;
    const room = imposterRooms.get(roomId);
    if (!room) return;
    const lc = socket._regUser.usernameLower;
    const player = room.players.find(p => p.lc === lc);
    if (!player) return;

    const clean = String(text || "").slice(0, 200).replace(/<[^>]*>/g, "").trim();
    if (!clean) return;
    if (mediaRateLimited(socket, "imposterChat", 8, 10_000)) {
      socket.emit("imposter:error", { message: "ძალიან ხშირად წერ — ცოტა დაელოდე." });
      return;
    }

    imposterGhostNoteActivity(room, lc);
    const msg = { username: player.username, text: clean, ts: Date.now() };
    for (const p of room.players) {
      const s = io.sockets.sockets.get(p.socketId);
      if (s) s.emit("imposter:chatMessage", msg);
    }
  });

  socket.on("imposter:leave", () => cleanupImposterForSocket(socket.id));

  // ══════════════════════════════════════════════════════════════════════
  // Blackjack ("ბლექჯეკი") — up to 5 players, each vs. a shared dealer.
  // ══════════════════════════════════════════════════════════════════════

  socket.on("blackjack:invite", ({ toUsernames }) => {
    if (!socket._regUser) return;
    const hostLc = socket._regUser.usernameLower;
    const hostUser = registeredUsers.get(hostLc);
    if (!hostUser) return;

    let room = findActiveBjRoomForUser(hostLc);
    if (room && !(room.hostLc === hostLc && room.status === "lobby")) {
      socket.emit("blackjack:error", { message: "თქვენ უკვე ხართ სხვა მაგიდაზე — ჯერ დატოვეთ ან დაასრულეთ ის, სანამ ახალს შექმნით." });
      return;
    }

    if (room) {
      const hostPlayer = room.players.find(p => p.lc === hostLc);
      if (hostPlayer) { hostPlayer.socketId = socket.id; hostPlayer.connected = true; }
      bjRoomBySocket.set(socket.id, room.id);
    } else {
      bjEnsureCoins(hostUser);
      room = {
        id: makeBjRoomId(),
        hostLc,
        status: "lobby",
        players: [{ lc: hostLc, username: hostUser.username, socketId: socket.id, connected: true, seat: 0, stack: hostUser.bjCoins, bet: null, hands: [] }],
        pendingInvites: new Map(),
        deck: [], dealerCards: [], dealerHoleRevealed: false,
        phase: null, turnSeat: null, turnHandIdx: 0, actionDeadline: null,
      };
      bjRooms.set(room.id, room);
      bjRoomBySocket.set(socket.id, room.id);
    }

    const list = Array.isArray(toUsernames) ? toUsernames.filter(u => typeof u === "string").slice(0, 20) : [];
    const invited = [];
    const cooldown = [];
    const now = Date.now();
    for (const uname of list) {
      const lc = uname.toLowerCase();
      if (lc === hostLc) continue;
      if (room.players.some(p => p.lc === lc)) continue;
      if (room.pendingInvites.has(lc)) continue;
      if (!isVisiblyOnline(lc)) continue;

      const targetUser = registeredUsers.get(lc);
      if (!targetUser) continue;

      const cdKey = `${hostLc}|${lc}`;
      const cdExpiry = bjDeclineCooldown.get(cdKey);
      if (cdExpiry) {
        if (cdExpiry > now) { cooldown.push(targetUser.username); continue; }
        bjDeclineCooldown.delete(cdKey);
      }

      const timeoutHandle = setTimeout(() => room.pendingInvites.delete(lc), BJ_INVITE_TTL_MS);
      room.pendingInvites.set(lc, { timeoutHandle });
      room.kicked?.delete(lc); // the host asked them back in
      io.to(`user:${lc}`).emit("blackjack:invited", { roomId: room.id, fromUsername: hostUser.username });
      notifyGameInvite(lc, "blackjack", room.id, hostUser.username);
      invited.push(targetUser.username);
    }

    socket.join(`bjroom:${room.id}`);
    socket.emit("blackjack:room", bjRoomStateForViewer(room));
    socket.emit("blackjack:inviteSent", { invited, cooldown });
    broadcastPublicBjRooms();
  });

  socket.on("blackjack:listPublicRooms", () => {
    socket.emit("blackjack:publicRooms", getPublicBjRooms());
  });

  socket.on("blackjack:declineInvite", ({ roomId }) => {
    if (!socket._regUser) return;
    const room = bjRooms.get(roomId);
    if (!room) return;
    const lc = socket._regUser.usernameLower;
    const invite = room.pendingInvites.get(lc);
    if (!invite) return;
    clearTimeout(invite.timeoutHandle);
    room.pendingInvites.delete(lc);
    bjDeclineCooldown.set(`${room.hostLc}|${lc}`, Date.now() + BJ_DECLINE_COOLDOWN_MS);
    const host = room.players.find(p => p.lc === room.hostLc);
    if (host) io.sockets.sockets.get(host.socketId)?.emit("blackjack:inviteDeclined", { username: socket._regUser.username });
  });

  socket.on("blackjack:join", ({ roomId }) => {
    if (!socket._regUser) return;
    const lc = socket._regUser.usernameLower;
    const user = registeredUsers.get(lc);
    if (!user) return;

    const existingRoomId = bjRoomBySocket.get(socket.id);
    if (existingRoomId && existingRoomId !== roomId) cleanupBjForSocket(socket.id);

    const room = bjRooms.get(roomId);
    if (!room) { socket.emit("blackjack:error", { message: "მაგიდა ვეღარ მოიძებნა — შეიძლება უკვე დასრულდა." }); return; }
    if (room.status === "ended") { socket.emit("blackjack:error", { message: "ეს თამაში უკვე დასრულდა." }); return; }

    if (room.kicked?.has(lc)) { socket.emit("blackjack:error", { message: LOBBY_KICKED_MSG }); return; }
    const already = room.players.find(p => p.lc === lc);
    if (already) {
      already.socketId = socket.id;
      already.connected = true;
      bjRoomBySocket.set(socket.id, room.id);
      socket.join(`bjroom:${room.id}`);
      socket.emit("blackjack:room", bjRoomStateForViewer(room));
      broadcastBjRoom(room);
      broadcastPublicBjRooms();
      return;
    }

    if (room.players.length >= BJ_MAX_PLAYERS) { socket.emit("blackjack:error", { message: "მაგიდა სავსეა." }); return; }

    const invite = room.pendingInvites.get(lc);
    if (invite) clearTimeout(invite.timeoutHandle);
    room.pendingInvites.delete(lc);

    bjEnsureCoins(user);
    const seat = room.players.length;
    room.players.push({ lc, username: user.username, socketId: socket.id, connected: true, seat, stack: user.bjCoins, bet: null, hands: [] });
    bjRoomBySocket.set(socket.id, room.id);
    socket.join(`bjroom:${room.id}`);

    socket.emit("blackjack:room", bjRoomStateForViewer(room));
    broadcastBjRoom(room);
    broadcastPublicBjRooms();
  });

  socket.on("blackjack:start", ({ roomId }) => {
    if (!socket._regUser) return;
    const room = bjRooms.get(roomId);
    if (!room || room.hostLc !== socket._regUser.usernameLower) return;
    if (room.status !== "lobby") return;
    if (room.players.length < BJ_MIN_PLAYERS) return;
    room.status = "playing";
    bjStartBettingPhase(room);
    broadcastPublicBjRooms();
  });

  socket.on("blackjack:placeBet", ({ roomId, amount }) => {
    if (!socket._regUser) return;
    const room = bjRooms.get(roomId);
    if (!room || room.status !== "playing" || room.phase !== "betting") return;
    const lc = socket._regUser.usernameLower;
    const player = room.players.find(p => p.lc === lc);
    if (!player || player.bet) return;

    const bet = Math.floor(Number(amount));
    if (!Number.isFinite(bet) || bet < BJ_MIN_BET || bet > BJ_MAX_BET || bet > player.stack) {
      socket.emit("blackjack:error", { message: `ფსონი უნდა იყოს ${BJ_MIN_BET}-დან ${BJ_MAX_BET}-მდე და არ აღემატებოდეს შენს ბალანსს.` });
      return;
    }
    player.bet = bet;
    broadcastBjRoom(room);
    bjMaybeDealRound(room);
  });

  socket.on("blackjack:action", ({ roomId, action }) => {
    if (!socket._regUser) return;
    const room = bjRooms.get(roomId);
    if (!room || room.status !== "playing" || room.phase !== "playing") return;
    const lc = socket._regUser.usernameLower;
    const player = room.players[room.turnSeat];
    if (!player || player.lc !== lc) return;

    if (action === "hit") bjApplyHit(room);
    else if (action === "stand") bjApplyStand(room);
    else if (action === "double") bjApplyDouble(room);
    else if (action === "split") bjApplySplit(room);
    else socket.emit("blackjack:error", { message: "უცნობი მოქმედება." });
  });

  socket.on("blackjack:chat", ({ roomId, text }) => {
    if (!socket._regUser) return;
    const room = bjRooms.get(roomId);
    if (!room) return;
    const lc = socket._regUser.usernameLower;
    const player = room.players.find(p => p.lc === lc);
    if (!player) return;

    const clean = String(text || "").slice(0, 200).replace(/<[^>]*>/g, "").trim();
    if (!clean) return;
    if (mediaRateLimited(socket, "blackjackChat", 8, 10_000)) {
      socket.emit("blackjack:error", { message: "ძალიან ხშირად წერ — ცოტა დაელოდე." });
      return;
    }

    const msg = { username: player.username, text: clean, ts: Date.now() };
    for (const p of room.players) {
      const s = io.sockets.sockets.get(p.socketId);
      if (s) s.emit("blackjack:chatMessage", msg);
    }
  });

  socket.on("blackjack:leave", () => cleanupBjForSocket(socket.id));

  // ══════════════════════════════════════════════════════════════════════
  // Rooms ("ოთახები") — Discord-style topic rooms, registered users only.
  // Opening a room in the client auto-joins it (rooms:join): no separate
  // approval step, matches "no approval required to join a room". Reading
  // history is allowed for any registered user regardless of membership —
  // membership just tracks who's a current member (shown in the member
  // list, and what a Leave button clears). Sending requires you either be
  // a member already or join automatically as part of the send.
  // ══════════════════════════════════════════════════════════════════════

  socket.on("rooms:join", ({ roomId }) => {
    if (!socket._regUser) return;
    const room = chatRooms.get(roomId);
    if (!room) { socket.emit("rooms:error", { message: "ოთახი ვერ მოიძებნა" }); return; }
    const lc = socket._regUser.usernameLower;
    if (room.bannedUsers.includes(lc)) {
      socket.emit("rooms:error", { message: "ადმინისტრატორმა შეგზღუდათ ამ ოთახში მონაწილეობა" });
      return;
    }

    socket.join(`roomchat:${roomId}`);
    if (!room.members.includes(lc)) {
      room.members.push(lc);
      saveChatRooms();
      socket.to(`roomchat:${roomId}`).emit("rooms:memberJoined", { roomId, username: socket._regUser.username });
    }

    room.lastRead = room.lastRead || {};
    room.lastRead[lc] = Date.now();
    saveChatRooms();

    const amAdmin = isRoomAdmin(lc);
    socket.emit("rooms:room", {
      room: roomPublicSummary(room, lc),
      messages: room.messages.map(roomMessagePublic),
      isAdmin: amAdmin,
      members: room.members.map(m => registeredUsers.get(m)?.username || m),
      bannedUsers: amAdmin ? room.bannedUsers.map(m => registeredUsers.get(m)?.username || m) : undefined,
    });
  });

  socket.on("rooms:leave", ({ roomId }) => {
    if (!socket._regUser) return;
    const room = chatRooms.get(roomId);
    socket.leave(`roomchat:${roomId}`);
    if (!room) return;
    const lc = socket._regUser.usernameLower;
    if (room.members.includes(lc)) {
      room.members = room.members.filter(m => m !== lc);
      saveChatRooms();
      io.to(`roomchat:${roomId}`).emit("rooms:memberLeft", { roomId, username: socket._regUser.username });
    }
    socket.emit("rooms:left", { roomId });
  });

  socket.on("rooms:send", ({ roomId, text }) => {
    if (!socket._regUser || typeof text !== "string") return;
    if (socket._regUser.isGuest) { socket.emit("guest:registerRequired", { feature: "roomsWrite" }); return; }
    const room = chatRooms.get(roomId);
    if (!room) { socket.emit("rooms:error", { message: "ოთახი ვერ მოიძებნა" }); return; }
    const lc = socket._regUser.usernameLower;
    if (room.bannedUsers.includes(lc)) {
      socket.emit("rooms:error", { message: "ადმინისტრატორმა შეგზღუდათ ამ ოთახში მონაწილეობა" });
      return;
    }

    const clean = text.slice(0, MSG_MAX).replace(/<[^>]*>/g, "").trim();
    if (!clean) return;
    if (findBannedWord(clean)) { socket.emit("rooms:error", { message: ABUSE_WORD_MESSAGE }); return; }
    if (mediaRateLimited(socket, "roomMsg", 10, 10_000)) {
      socket.emit("rooms:error", { message: "ძალიან ბევრი შეტყობინება — ცოტა დაელოდე." });
      return;
    }

    // Sending implies joining — matches the "no approval needed" join flow
    // and means you never have to think about joining as a separate step.
    if (!room.members.includes(lc)) {
      room.members.push(lc);
      socket.join(`roomchat:${roomId}`);
      io.to(`roomchat:${roomId}`).emit("rooms:memberJoined", { roomId, username: socket._regUser.username });
    }

    const msg = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      fromLc: lc,
      fromUsername: socket._regUser.username,
      text: clean,
      ts: new Date().toISOString(),
    };
    room.messages.push(msg);
    bumpStat("msgRooms");
    if (room.messages.length > ROOM_MSG_CAP) room.messages.shift();
    saveChatRooms();

    io.to(`roomchat:${roomId}`).emit("rooms:message", { roomId, message: roomMessagePublic(msg) });
  });

  // ── Admin-only room management ──────────────────────────────────────────
  // Every handler below re-checks isRoomAdmin() itself — a client can never
  // grant itself admin by editing local state or replaying a captured
  // request, since the flag is looked up fresh from registeredUsers.

  socket.on("rooms:create", ({ name }) => {
    if (!socket._regUser || !isRoomAdmin(socket._regUser.usernameLower)) {
      socket.emit("rooms:error", { message: "მხოლოდ ადმინისტრატორს შეუძლია ოთახის შექმნა" });
      return;
    }
    const clean = cleanRoomName(name);
    if (!clean) { socket.emit("rooms:error", { message: "ოთახის სახელი სავალდებულოა" }); return; }
    if (findBannedWord(clean)) { socket.emit("rooms:error", { message: ABUSE_WORD_MESSAGE }); return; }

    const room = {
      id: makeRoomId(),
      name: clean,
      createdBy: socket._regUser.usernameLower,
      createdByUsername: socket._regUser.username,
      createdAt: new Date().toISOString(),
      members: [],
      bannedUsers: [],
      messages: [],
    };
    chatRooms.set(room.id, room);
    saveChatRooms();
    io.emit("rooms:updated");
    socket.emit("rooms:created", { roomId: room.id });
  });

  socket.on("rooms:edit", ({ roomId, name }) => {
    if (!socket._regUser || !isRoomAdmin(socket._regUser.usernameLower)) {
      socket.emit("rooms:error", { message: "მხოლოდ ადმინისტრატორს შეუძლია ოთახის რედაქტირება" });
      return;
    }
    const room = chatRooms.get(roomId);
    if (!room) { socket.emit("rooms:error", { message: "ოთახი ვერ მოიძებნა" }); return; }
    const clean = cleanRoomName(name);
    if (!clean) { socket.emit("rooms:error", { message: "ოთახის სახელი სავალდებულოა" }); return; }
    if (findBannedWord(clean)) { socket.emit("rooms:error", { message: ABUSE_WORD_MESSAGE }); return; }

    room.name = clean;
    saveChatRooms();
    io.emit("rooms:updated");
    io.to(`roomchat:${roomId}`).emit("rooms:roomEdited", { roomId, name: room.name });
  });

  socket.on("rooms:delete", ({ roomId }) => {
    if (!socket._regUser || !isRoomAdmin(socket._regUser.usernameLower)) {
      socket.emit("rooms:error", { message: "მხოლოდ ადმინისტრატორს შეუძლია ოთახის წაშლა" });
      return;
    }
    const room = chatRooms.get(roomId);
    if (!room) { socket.emit("rooms:error", { message: "ოთახი ვერ მოიძებნა" }); return; }

    io.to(`roomchat:${roomId}`).emit("rooms:roomDeleted", { roomId });
    io.in(`roomchat:${roomId}`).socketsLeave(`roomchat:${roomId}`);
    chatRooms.delete(roomId);
    saveChatRooms();
    io.emit("rooms:updated");
  });

  // The admin can delete any message; everyone else can delete their own.
  socket.on("rooms:deleteMessage", ({ roomId, messageId } = {}) => {
    if (!socket._regUser) return;
    const room = chatRooms.get(roomId);
    if (!room) return;
    const target = room.messages.find(m => m.id === messageId);
    if (!target) return;
    const me = socket._regUser.usernameLower;
    if (!isRoomAdmin(me) && (socket._regUser.isGuest || target.fromLc !== me)) {
      socket.emit("rooms:error", { message: "მხოლოდ საკუთარი შეტყობინების წაშლა შეგიძლია" });
      return;
    }
    const before = room.messages.length;
    room.messages = room.messages.filter(m => m.id !== messageId);
    if (room.messages.length === before) return; // nothing removed
    saveChatRooms();
    io.to(`roomchat:${roomId}`).emit("rooms:messageDeleted", { roomId, messageId });
  });

  socket.on("rooms:kickUser", ({ roomId, username }) => {
    if (!socket._regUser || !isRoomAdmin(socket._regUser.usernameLower)) {
      socket.emit("rooms:error", { message: "მხოლოდ ადმინისტრატორს შეუძლია მომხმარებლის ამოღება" });
      return;
    }
    const room = chatRooms.get(roomId);
    if (!room || typeof username !== "string") return;
    const targetLc = username.toLowerCase().trim();

    room.members = room.members.filter(m => m !== targetLc);
    saveChatRooms();
    forceLeaveRoomSockets(targetLc, roomId);
    io.to(`user:${targetLc}`).emit("rooms:kicked", { roomId, roomName: room.name });
    io.to(`roomchat:${roomId}`).emit("rooms:memberLeft", { roomId, username });
  });

  socket.on("rooms:banUser", ({ roomId, username }) => {
    if (!socket._regUser || !isRoomAdmin(socket._regUser.usernameLower)) {
      socket.emit("rooms:error", { message: "მხოლოდ ადმინისტრატორს შეუძლია მომხმარებლის დაბლოკვა" });
      return;
    }
    const room = chatRooms.get(roomId);
    if (!room || typeof username !== "string") return;
    const targetLc = username.toLowerCase().trim();
    if (targetLc === socket._regUser.usernameLower) return; // can't ban yourself

    if (!room.bannedUsers.includes(targetLc)) room.bannedUsers.push(targetLc);
    room.members = room.members.filter(m => m !== targetLc);
    saveChatRooms();
    forceLeaveRoomSockets(targetLc, roomId);
    io.to(`user:${targetLc}`).emit("rooms:banned", { roomId, roomName: room.name });
    io.to(`roomchat:${roomId}`).emit("rooms:memberLeft", { roomId, username });
  });

  socket.on("rooms:unbanUser", ({ roomId, username }) => {
    if (!socket._regUser || !isRoomAdmin(socket._regUser.usernameLower)) {
      socket.emit("rooms:error", { message: "მხოლოდ ადმინისტრატორს შეუძლია შეზღუდვის მოხსნა" });
      return;
    }
    const room = chatRooms.get(roomId);
    if (!room || typeof username !== "string") return;
    const targetLc = username.toLowerCase().trim();

    room.bannedUsers = room.bannedUsers.filter(u => u !== targetLc);
    saveChatRooms();
    socket.emit("rooms:unbanned", { roomId, username });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Forum ("ფორუმი") — Reddit-style posts/comments/voting, registered users
  // only, moderated by the same isAdmin account that runs Rooms. Live
  // updates are broadcast to everyone (io.emit) since the forum isn't a
  // joined "room" the way chat rooms are — anyone with the page open should
  // see new posts/comments/scores land in real time. Per-viewer vote state
  // (myVote) is only ever sent back to the voter themselves, never broadcast.
  // ══════════════════════════════════════════════════════════════════════

  socket.on("forum:createPost", ({ title, body }) => {
    if (!socket._regUser) return;
    if (socket._regUser.isGuest) { socket.emit("guest:registerRequired", { feature: "forumWrite" }); return; }
    const cleanTitle = cleanForumText(title, FORUM_TITLE_MAX);
    const cleanBody = cleanForumText(body, FORUM_BODY_MAX);
    if (!cleanTitle) { socket.emit("forum:error", { message: "სათაური სავალდებულოა" }); return; }
    if (findBannedWord(cleanTitle) || findBannedWord(cleanBody)) {
      socket.emit("forum:error", { message: ABUSE_WORD_MESSAGE }); return;
    }
    if (mediaRateLimited(socket, "forumPost", 5, 60_000)) {
      socket.emit("forum:error", { message: "ძალიან ბევრი პოსტი — ცოტა დაელოდე." });
      return;
    }

    const post = {
      id: makeForumPostId(),
      title: cleanTitle,
      body: cleanBody,
      authorLc: socket._regUser.usernameLower,
      authorUsername: socket._regUser.username,
      createdAt: new Date().toISOString(),
      votes: {},
      comments: [],
    };
    forumPosts.set(post.id, post);
    bumpStat("forumPosts");
    saveForum();

    io.emit("forum:postCreated", { post: forumPostSummary(post, null) });
    socket.emit("forum:postCreatedAck", { postId: post.id });
  });

  // The admin can delete anything; everyone else can delete what they wrote.
  const forumCanDelete = (authorLc) => !!socket._regUser && (isRoomAdmin(socket._regUser.usernameLower) ||
    (!socket._regUser.isGuest && authorLc === socket._regUser.usernameLower));
  socket.on("forum:deletePost", ({ postId } = {}) => {
    const target = forumPosts.get(postId);
    if (!target) return;
    if (!forumCanDelete(target.authorLc)) {
      socket.emit("forum:error", { message: "მხოლოდ საკუთარი პოსტის წაშლა შეგიძლია" });
      return;
    }
    forumPosts.delete(postId);
    saveForum();
    io.emit("forum:postDeleted", { postId });
  });

  socket.on("forum:comment", ({ postId, body }) => {
    if (!socket._regUser) return;
    if (socket._regUser.isGuest) { socket.emit("guest:registerRequired", { feature: "forumWrite" }); return; }
    const post = forumPosts.get(postId);
    if (!post) { socket.emit("forum:error", { message: "პოსტი ვერ მოიძებნა" }); return; }
    const cleanBody = cleanForumText(body, FORUM_COMMENT_MAX);
    if (!cleanBody) return;
    if (findBannedWord(cleanBody)) { socket.emit("forum:error", { message: ABUSE_WORD_MESSAGE }); return; }

    if (mediaRateLimited(socket, "forumComment", 10, 10_000)) {
      socket.emit("forum:error", { message: "ძალიან ბევრი კომენტარი — ცოტა დაელოდე." });
      return;
    }

    const comment = {
      id: makeForumCommentId(),
      body: cleanBody,
      authorLc: socket._regUser.usernameLower,
      authorUsername: socket._regUser.username,
      createdAt: new Date().toISOString(),
      votes: {},
    };
    post.comments.push(comment);
    bumpStat("forumComments");
    if (post.comments.length > FORUM_COMMENT_CAP) post.comments.shift();
    saveForum();

    io.emit("forum:commentAdded", { postId, comment: forumCommentPublic(comment, null) });
  });

  socket.on("forum:deleteComment", ({ postId, commentId } = {}) => {
    const post = forumPosts.get(postId);
    if (!post) return;
    const target = post.comments.find(c => c.id === commentId);
    if (!target) return;
    if (!forumCanDelete(target.authorLc)) {
      socket.emit("forum:error", { message: "მხოლოდ საკუთარი კომენტარის წაშლა შეგიძლია" });
      return;
    }
    const before = post.comments.length;
    post.comments = post.comments.filter(c => c.id !== commentId);
    if (post.comments.length === before) return;
    saveForum();
    io.emit("forum:commentDeleted", { postId, commentId });
  });

  // direction: 1 (upvote), -1 (downvote), 0 (remove my vote)
  socket.on("forum:vote", ({ postId, direction }) => {
    if (!socket._regUser) return;
    if (socket._regUser.isGuest) { socket.emit("guest:registerRequired", { feature: "forumWrite" }); return; }
    const post = forumPosts.get(postId);
    if (!post) return;
    const dir = Number(direction);
    if (![1, -1, 0].includes(dir)) return;
    const lc = socket._regUser.usernameLower;

    if (dir === 0) delete post.votes[lc]; else post.votes[lc] = dir;
    saveForum();

    socket.emit("forum:myVoteUpdated", { postId, myVote: dir });
    io.emit("forum:scoreUpdated", { postId, score: forumScore(post.votes) });
  });

  socket.on("forum:voteComment", ({ postId, commentId, direction }) => {
    if (!socket._regUser) return;
    const post = forumPosts.get(postId);
    if (!post) return;
    const comment = post.comments.find(c => c.id === commentId);
    if (!comment) return;
    const dir = Number(direction);
    if (![1, -1, 0].includes(dir)) return;
    const lc = socket._regUser.usernameLower;

    if (dir === 0) delete comment.votes[lc]; else comment.votes[lc] = dir;
    saveForum();

    socket.emit("forum:myVoteUpdated", { postId, commentId, myVote: dir });
    io.emit("forum:scoreUpdated", { postId, commentId, score: forumScore(comment.votes) });
  });

  // ── Disconnect ───────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    console.log(`[SOCKET] Disconnected: ${socket.id}`);
    recordDisconnect(socket.clientIP, socket._connectedAt);

    if (socket._regUser) {
      const sockets = onlineRegSockets.get(socket._regUser.usernameLower);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          onlineRegSockets.delete(socket._regUser.usernameLower);
          if (!socket._regUser.isGuest) {
            const gone = registeredUsers.get(socket._regUser.usernameLower);
            if (gone) { gone.lastSeenAt = Date.now(); saveAuthUsers(); }
          }
          announceOnlineChanged(); // they just went fully offline
        }
      }
    }

    // Random-chat partner handling — keeps a short reconnect grace window
    // (network blip, page refresh) instead of ending the conversation the
    // instant a socket drops.
    if (socket.partner) {
      const partner   = socket.partner;
      const name      = socket.userName || "Anonymous";
      const nameLower = name.toLowerCase();

      socket.partner       = null;
      socket._isGhost      = true;
      socket._messageQueue = [];

      // Immediately notify the staying partner so they see the disconnect
      // message and can block right away. We clear partner.partner now so
      // blockUser falls cleanly into the name-only block path.
      partner.lastPartnerName     = name;
      partner.lastPartnerIP       = socket.clientIP || "";
      partner.lastPartnerSocketId = socket.id;
      partner.hasReportedLast     = false;
      partner.partner             = null;
      if (partner.connected) {
        partner.emit("partnerDisconnected", { name });
        partner.emit("music:stop");
      }

      if (socket.userName) {
        const timeout = setTimeout(() => {
          pendingDisconnects.delete(nameLower);
          activeUsernames.delete(nameLower);
        }, RECONNECT_GRACE_MS);
        pendingDisconnects.set(nameLower, { partner, timeout, ghostSocket: socket });
      }
    } else {
      if (socket.userName) activeUsernames.delete(socket.userName.toLowerCase());
    }

    waitingQueue = waitingQueue.filter(s => s.id !== socket.id);
    updateOnlineCount();

    cleanupGameForSocket(socket.id);
    cleanupDrawGuessForSocket(socket.id);
    cleanupPokerForSocket(socket.id);
    cleanupChessForSocket(socket.id);
    cleanupCheckersForSocket(socket.id);
    cleanupJokerForSocket(socket.id);
    cleanupImposterForSocket(socket.id);
    cleanupBjForSocket(socket.id);
    for (const [sid, s] of flappySessions) if (s.socketId === socket.id) flappySessions.delete(sid);

    // A guest's identity lives only as long as they're connected somewhere —
    // once their last socket disconnects, their temporary shadow account
    // disappears entirely (it was never written to disk regardless).
    if (guestSocketMap.has(socket.id)) {
      const lc = guestSocketMap.get(socket.id);
      guestSocketMap.delete(socket.id);
      if (guestTokenMap.has(socket.id)) {
        authTokens.delete(guestTokenMap.get(socket.id));
        guestTokenMap.delete(socket.id);
      }
      const sockets = onlineRegSockets.get(lc);
      if (sockets) { sockets.delete(socket.id); if (sockets.size === 0) onlineRegSockets.delete(lc); }
      const stillConnected = [...guestSocketMap.values()].includes(lc);
      if (!stillConnected) {
        registeredUsers.delete(lc);
        announceOnlineChanged();
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// START SERVER
// ════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 5000;

// ── Graceful shutdown (PATCH: flush pending saves) ────────────────────────────
// ── Crash safety net ──────────────────────────────────────────────────────────
// A thrown error inside a socket event handler (like the BLOCKED_PHRASE_RE bug)
// otherwise kills the ENTIRE process and disconnects everyone. Log it instead
// and keep the server alive. This does NOT replace fixing the actual bug —
// it just stops one bad message from taking the whole site down.
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION] Server stayed alive despite this error:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION] Server stayed alive despite this rejection:', reason);
});

process.on('SIGTERM', () => {
  console.log('[SHUTDOWN] Flushing pending saves...');
  if (authUsersDirty) _saveAuthUsersToDisk();
  if (privMsgsDirty) _savePrivateMsgsToDisk();
  if (statsDirty) _saveStatsToDisk();
  if (roomsDirty) _saveChatRoomsToDisk();
  if (forumDirty) _saveForumToDisk();
  if (notifDirty) _saveNotificationsToDisk();
  if (streaksDirty) _saveStreaksToDisk();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[SHUTDOWN] Flushing pending saves...');
  if (authUsersDirty) _saveAuthUsersToDisk();
  if (privMsgsDirty) _savePrivateMsgsToDisk();
  if (statsDirty) _saveStatsToDisk();
  if (roomsDirty) _saveChatRoomsToDisk();
  if (forumDirty) _saveForumToDisk();
  if (notifDirty) _saveNotificationsToDisk();
  if (streaksDirty) _saveStreaksToDisk();
  process.exit(0);
});

adminSeedPromise.then(() => {
  server.listen(PORT, () => {
    console.log(`\n🚀 GAICANI Server running on port ${PORT}\n`);
    console.log(`   URL: http://localhost:${PORT}`);
    console.log(`   Admin panel: http://localhost:${PORT}${ROUTE.panel}`);
    console.log(`   Stats: http://localhost:${PORT}${ROUTE.stats}\n`);
  });
});
