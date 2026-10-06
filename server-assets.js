// ── ⚡ Faster page loads: fingerprinted, long-cached files ───────────────────
// Every HTML page is sent with its own scripts, styles and pictures tagged
// with a short fingerprint of the file's contents (/style.css?v=3f9a1c2b07).
// A tagged file can be kept by the browser and by Cloudflare for a year:
// when the file changes, its fingerprint — and so its address — changes too,
// so an update still shows up on the very next page load. Pages themselves
// are always re-checked. Before, every script and style was re-checked with
// the server on every page open (a round trip each time).
//
// The socket.io client is served from here too, minified (47 KB instead of
// 154 KB), under its version: /vendor/socket.io.min.js?v=4.8.1.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const YEAR = "public, max-age=31536000, immutable";
const ASSET_RE = /(\s(?:src|srcset|href)=["'])(\/?)([A-Za-z0-9_./-]+\.(?:js|css|png|jpe?g|svg|webp|gif|ico))(["'])/g;
const SOCKET_IO_RE = /(["'])\/socket\.io\/socket\.io(?:\.min)?\.js\1/g;
const PAGE_TTL_MS = 30_000; // re-read a page (and its files' fingerprints) at most this often

function mountAssets(app, { root }) {
  root = path.resolve(root);

  // Fingerprint of a file's contents, recomputed only when it changes.
  const prints = new Map(); // absolute path → { mtimeMs, size, v }
  function versionOf(abs) {
    let st;
    try { st = fs.statSync(abs); } catch { return null; }
    if (!st.isFile()) return null;
    const c = prints.get(abs);
    if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.v;
    const v = crypto.createHash("md5").update(fs.readFileSync(abs)).digest("hex").slice(0, 10);
    prints.set(abs, { mtimeMs: st.mtimeMs, size: st.size, v });
    return v;
  }
  const inside = (abs) => abs.startsWith(root + path.sep);

  // socket.io's own minified client, if it's where npm puts it.
  let sioFile = null, sioV = null;
  try {
    const pkgRoot = path.join(path.dirname(require.resolve("socket.io")), "..");
    const f = path.join(pkgRoot, "client-dist", "socket.io.min.js");
    if (fs.existsSync(f)) {
      sioFile = f;
      sioV = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8")).version || versionOf(f);
    }
  } catch { /* keep the default /socket.io/socket.io.js */ }

  if (sioFile) {
    app.get("/vendor/socket.io.min.js", (req, res) => {
      res.setHeader("Cache-Control", req.query.v === sioV ? YEAR : "public, max-age=0");
      res.sendFile(sioFile, { cacheControl: false, headers: { "Content-Type": "application/javascript; charset=utf-8" } });
    });
  }

  function rewrite(html) {
    if (sioFile) html = html.replace(SOCKET_IO_RE, `$1/vendor/socket.io.min.js?v=${sioV}$1`);
    return html.replace(ASSET_RE, (m, pre, slash, rel, post) => {
      const abs = path.join(root, rel);
      if (!inside(abs)) return m;
      const v = versionOf(abs);
      return v ? `${pre}${slash}${rel}?v=${v}${post}` : m;
    });
  }

  // Pages: sent with fingerprinted file addresses, always re-checked
  // (ETag → "304 not modified" when nothing changed).
  const pages = new Map(); // absolute path → { mtimeMs, at, html }
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    let p;
    try { p = decodeURIComponent(req.path); } catch { return next(); }
    if (p === "/") p = "/index.html";
    if (!p.endsWith(".html") || /(^|\/)\./.test(p)) return next(); // hidden paths: left to express.static (which refuses them)
    const abs = path.join(root, p);
    if (!inside(abs)) return next();
    let st;
    try { st = fs.statSync(abs); } catch { return next(); }
    if (!st.isFile()) return next();
    let c = pages.get(abs);
    if (!c || c.mtimeMs !== st.mtimeMs || Date.now() - c.at > PAGE_TTL_MS) {
      try { c = { mtimeMs: st.mtimeMs, at: Date.now(), html: rewrite(fs.readFileSync(abs, "utf8")) }; }
      catch { return next(); }
      pages.set(abs, c);
    }
    res.setHeader("Cache-Control", "no-cache");
    res.type("html").send(c.html);
  });

  // For express.static's setHeaders: a file asked for with its current
  // fingerprint may be kept for a year.
  return {
    cacheHeaders(res, filePath) {
      const v = res.req && res.req.query && res.req.query.v;
      if (v && v === versionOf(path.resolve(filePath))) { res.setHeader("Cache-Control", YEAR); return true; }
      return false;
    },
  };
}

module.exports = { mountAssets };
