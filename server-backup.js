// ── 💾 Backup & restore of all site data (admin panel) ──────────────────────
// Download: one .tar.gz with every account, private chat, room, forum post,
// streak, notification, stat, ban list and voice/photo file — everything a
// fresh server needs to carry on as if nothing happened. It's a standard
// archive (7-Zip / WinRAR / tar open it). Logs are left out on purpose.
//
// Restore: upload that file on the admin panel. It's unpacked into a
// temporary folder and checked first; only a complete, valid backup replaces
// the data. The files it replaces are kept in _before_restore/ (one level,
// overwritten by the next restore). Then the server restarts itself so it
// loads the restored data — on Render that's automatic. Everyone has to log
// in again, the same as after any restart; names, passwords and everything
// else are exactly as in the backup.
//
// No library needed: the tar format is simple (512-byte headers), and gzip
// comes with Node.
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// Data files that make up the site. Anything else in the data folder (the
// traffic log, .tmp / .corrupt copies) isn't backed up.
const DATA_FILES = [
  "registered_users.json",  // accounts, passwords (hashed), friends, coins, streaks, profiles, Trinder
  "private_messages.json",
  "chat_rooms.json",
  "forum_posts.json",
  "friend_streaks.json",
  "notifications.json",
  "stats.json",
  "banned_ips.json",
  "banned_user_agents.json",
  "temp_bans.json",         // 24h blocks still running (with the reason shown)
  "support_ai.json",        // 🛟 Support AI: answers from random chat, on/off, who said "don't ask again"
];
const MEDIA_DIR = "private-photos";               // voice messages and photos
const MEDIA_NAME = /^[A-Za-z0-9_-]{8,100}\.[A-Za-z0-9]{2,5}$/;
const MANIFEST = "gaicani-backup.json";
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024;        // 2 GB unpacked, at most
const MAX_FILE = 512 * 1024 * 1024;

// ── tar ──
function tarHeader(name, size, mtime) {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100, "utf8");
  h.write("0000644\0", 100, 8, "ascii");
  h.write("0000000\0", 108, 8, "ascii");
  h.write("0000000\0", 116, 8, "ascii");
  h.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  h.write(Math.floor(mtime / 1000).toString(8).padStart(11, "0") + "\0", 136, 12, "ascii");
  h.write("        ", 148, 8, "ascii");               // checksum counts as spaces
  h.write("0", 156, 1, "ascii");                       // regular file
  h.write("ustar\0" + "00", 257, 8, "ascii");
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return h;
}
const pad512 = (n) => (512 - (n % 512)) % 512;
const cstr = (buf) => { const i = buf.indexOf(0); return buf.toString("utf8", 0, i === -1 ? buf.length : i); };

// Reads the entries of an uncompressed tar file one at a time.
function* readTar(fd) {
  const head = Buffer.alloc(512);
  let pos = 0;
  for (;;) {
    if (fs.readSync(fd, head, 0, 512, pos) < 512) return;
    if (head.every((b) => b === 0)) return;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? 32 : head[i];
    if (sum !== parseInt(cstr(head.subarray(148, 156)).trim(), 8)) throw new Error("archive is damaged");
    const prefix = cstr(head.subarray(345, 500));
    const name = (prefix ? prefix + "/" : "") + cstr(head.subarray(0, 100));
    const size = parseInt(cstr(head.subarray(124, 136)).trim() || "0", 8);
    const type = String.fromCharCode(head[156] || 48);
    yield { name: name.replace(/^\.\//, ""), size, type, offset: pos + 512 };
    pos += 512 + size + pad512(size);
  }
}
function copyRange(fd, offset, size, dest) {
  const out = fs.openSync(dest, "w");
  try {
    const buf = Buffer.alloc(Math.min(size, 1 << 20) || 1);
    let done = 0;
    while (done < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - done), offset + done);
      if (n <= 0) throw new Error("archive ended early");
      fs.writeSync(out, buf, 0, n);
      done += n;
    }
  } finally { fs.closeSync(out); }
}
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

// ── routes ──
// app, routes { download, restore }, guard (admin only), dataPath,
// flush() → writes everything still in memory to disk,
// freeze() → stops all further data saves (the restored files must not be
// overwritten by the running server before it restarts).
// checkChats(text) → { encrypted, ok, code }: can this server open an
// encrypted private-chat file (server-chatcrypt.js)?
function mountBackup(app, { routes, guard, dataPath, flush, freeze, checkChats = () => ({ ok: true }), log = console }) {
  const stamp = () => new Date().toISOString().slice(0, 16).replace("T", "-").replace(":", ""); // 2026-10-06-1432

  app.get(routes.download, guard, async (req, res) => {
    try { flush(); } catch (e) { log.error("[BACKUP] flush failed:", e.message); }
    const entries = [];
    for (const f of DATA_FILES) {
      const p = path.join(dataPath, f);
      try { const st = fs.statSync(p); if (st.isFile()) entries.push({ name: f, path: p, size: st.size, mtime: st.mtimeMs }); } catch (_) {}
    }
    try {
      for (const f of fs.readdirSync(path.join(dataPath, MEDIA_DIR))) {
        if (!MEDIA_NAME.test(f)) continue;
        const p = path.join(dataPath, MEDIA_DIR, f);
        const st = fs.statSync(p);
        if (st.isFile()) entries.push({ name: MEDIA_DIR + "/" + f, path: p, size: st.size, mtime: st.mtimeMs });
      }
    } catch (_) {}
    let users = 0;
    try { users = Object.keys(JSON.parse(fs.readFileSync(path.join(dataPath, "registered_users.json"), "utf8"))).length; } catch (_) {}
    const manifest = Buffer.from(JSON.stringify({
      app: "gaicani", version: 1, createdAt: new Date().toISOString(), users,
      files: entries.map((e) => e.name),
    }, null, 1));

    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="gaicani-backup-${stamp()}.tar.gz"`);
    res.setHeader("Cache-Control", "no-store");
    const gz = zlib.createGzip({ level: 6 });
    gz.pipe(res);
    const put = (buf) => new Promise((ok) => { if (gz.write(buf)) ok(); else gz.once("drain", ok); });
    let aborted = false;
    req.on("close", () => { if (!res.writableEnded) aborted = true; });
    try {
      await put(tarHeader(MANIFEST, manifest.length, Date.now()));
      await put(manifest); await put(Buffer.alloc(pad512(manifest.length)));
      for (const e of entries) {
        if (aborted) break;
        let data;
        try { data = await fs.promises.readFile(e.path); } catch (_) { continue; } // deleted meanwhile
        await put(tarHeader(e.name, data.length, e.mtime));
        await put(data); await put(Buffer.alloc(pad512(data.length)));
      }
      await put(Buffer.alloc(1024));
      gz.end();
      log.log(`[BACKUP] Downloaded: ${users} accounts, ${entries.length} files`);
    } catch (e) {
      log.error("[BACKUP] failed:", e.message);
      gz.destroy(e);
    }
  });

  let restoring = false;
  app.post(routes.restore, guard, (req, res) => {
    if (restoring) return res.status(409).json({ error: "A restore is already running" });
    restoring = true;
    const work = path.join(dataPath, "_restore_tmp");
    rmrf(work);
    fs.mkdirSync(path.join(work, "files", MEDIA_DIR), { recursive: true });
    const tarPath = path.join(work, "upload.tar");
    const out = fs.createWriteStream(tarPath);
    const gunzip = zlib.createGunzip();
    let bytes = 0, failed = false;
    const fail = (status, msg) => {
      if (failed) return;
      failed = true; restoring = false;
      try { req.unpipe(); req.resume(); out.destroy(); } catch (_) {}
      rmrf(work);
      if (!res.headersSent) res.status(status).json({ error: msg });
    };
    gunzip.on("data", (c) => { bytes += c.length; if (bytes > MAX_UPLOAD) fail(413, "The backup is too big"); });
    gunzip.on("error", () => fail(400, "This isn't a GAICANI backup (.tar.gz) file"));
    req.on("error", () => fail(400, "The upload was interrupted"));
    out.on("error", (e) => fail(500, "Couldn't save the upload: " + e.message));
    req.pipe(gunzip).pipe(out);
    out.on("finish", () => {
      if (failed) return;
      let fd;
      try {
        // 1. Unpack into the temporary folder, keeping only known files.
        fd = fs.openSync(tarPath, "r");
        let manifest = null;
        const got = [];
        for (const e of readTar(fd)) {
          if (e.type !== "0") continue;
          if (e.size > MAX_FILE) throw new Error(e.name + " is too big");
          let rel = null;
          if (e.name === MANIFEST) {
            const b = Buffer.alloc(e.size); fs.readSync(fd, b, 0, e.size, e.offset);
            manifest = JSON.parse(b.toString("utf8"));
            continue;
          }
          if (DATA_FILES.includes(e.name)) rel = e.name;
          else if (e.name.startsWith(MEDIA_DIR + "/") && MEDIA_NAME.test(e.name.slice(MEDIA_DIR.length + 1))) rel = e.name;
          if (!rel) continue;
          copyRange(fd, e.offset, e.size, path.join(work, "files", rel));
          got.push(rel);
        }
        fs.closeSync(fd); fd = null;

        // 2. Check it's a whole GAICANI backup before touching anything.
        if (!manifest || manifest.app !== "gaicani") throw new Error("This isn't a GAICANI backup file");
        if (!got.includes("registered_users.json")) throw new Error("The backup has no accounts file");
        let users = 0, chats = null;
        for (const f of got) {
          if (!f.endsWith(".json")) continue;
          const text = fs.readFileSync(path.join(work, "files", f), "utf8");
          if (f === "private_messages.json") {
            // May be encrypted. One locked with another key is still restored
            // (everything else works); the server sets it aside on start.
            chats = checkChats(text);
            if (chats.encrypted) { if (chats.code === "DAMAGED") throw new Error("The private chats file is damaged"); continue; }
          }
          const v = JSON.parse(text); // throws if damaged
          if (f === "registered_users.json") {
            if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("The accounts file is damaged");
            users = Object.keys(v).length;
          }
        }
        const media = got.filter((f) => f.startsWith(MEDIA_DIR + "/")).length;

        // 3. Freeze saving, set the current files aside, put the backup in place.
        freeze();
        const aside = path.join(dataPath, "_before_restore");
        rmrf(aside);
        fs.mkdirSync(aside, { recursive: true });
        try {
          for (const f of DATA_FILES) {
            const cur = path.join(dataPath, f);
            if (fs.existsSync(cur)) fs.renameSync(cur, path.join(aside, f));
          }
          fs.mkdirSync(path.join(dataPath, MEDIA_DIR), { recursive: true });
          for (const f of got) fs.renameSync(path.join(work, "files", f), path.join(dataPath, f));
        } catch (e) {
          // Put the old data back exactly as it was, then restart on it.
          for (const f of DATA_FILES) {
            const old = path.join(aside, f), cur = path.join(dataPath, f);
            try { if (fs.existsSync(old)) fs.renameSync(old, cur); else fs.rmSync(cur, { force: true }); } catch (_) {}
          }
          log.error("[BACKUP] Restore failed while swapping files, old data put back:", e.message);
          res.status(500).json({ error: "Restore failed (" + e.message + ") — your old data was put back. The server restarts now." });
          setTimeout(() => process.exit(0), 1500);
          return;
        }
        rmrf(work);

        log.log(`[BACKUP] Restored: ${users} accounts, ${media} voice/photo files (from ${manifest.createdAt}). Restarting…`);
        res.json({ success: true, users, media, createdAt: manifest.createdAt || null,
          chatsLocked: chats && chats.encrypted && !chats.ok ? chats.code : null });
        // Restart so the server loads the restored data (Render starts it again by itself).
        setTimeout(() => process.exit(0), 1500);
      } catch (e) {
        if (fd) try { fs.closeSync(fd); } catch (_) {}
        fail(400, e.message || "The backup couldn't be read");
      }
    });
  });
}

module.exports = { mountBackup, DATA_FILES };
