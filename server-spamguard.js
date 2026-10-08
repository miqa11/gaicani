// ── 🤖 A captcha for whoever sends the same message again and again ───────────
// Per IP address: when the exact same text is sent REPEAT_LIMIT times among
// that IP's last WINDOW_MSGS messages (within WINDOW_MS) — in random chat,
// rooms, the forum, game chats or private chats — the next messages wait
// until a captcha is solved: four digits drawn as a distorted picture.
// Nothing is blocked, muted or banned: once it's solved, the waiting
// messages go out and chatting goes on as before.
//
// End-to-end encrypted private messages can't be compared here (the server
// can't read them), so the chat page itself notices the repeats and says so
// ("spam:repeat"); the captcha is still enforced here, per IP.
"use strict";

const crypto = require("crypto");

const REPEAT_LIMIT = 5;              // the same text this many times…
const WINDOW_MSGS  = 8;              // …among the IP's last 8 messages…
const WINDOW_MS    = 2 * 60 * 1000;  // …all within 2 minutes
const SOLVE_GAP_MS = 1500;           // one guess per 1.5 s at most (keeps guessing scripts slow)
const MAX_HELD     = 5;              // messages kept per connection while the captcha is open
const FORGET_MS    = 60 * 60 * 1000; // an IP quiet this long is forgotten

// Digits as strokes in a 10×16 box — drawn as paths (not text), so the
// picture can't simply be read out of the markup.
const GLYPHS = {
  0: [[[2, 1], [8, 1], [9.5, 4], [9.5, 12], [8, 15], [2, 15], [0.5, 12], [0.5, 4], [2, 1]]],
  1: [[[2.5, 4], [6, 1], [6, 15]], [[2.5, 15], [9, 15]]],
  2: [[[1, 4], [3, 1], [7.5, 1], [9, 4], [8, 7.5], [1, 15], [9.5, 15]]],
  3: [[[1, 2], [4, 1], [8, 1.5], [9, 4.5], [5, 7.5], [9, 10.5], [8.5, 14], [4.5, 15], [1, 13.5]]],
  4: [[[2, 1], [0.8, 10], [9.5, 10]], [[7, 4.5], [7, 15]]], // open top — can't pass for an "A" when tilted
  5: [[[9, 1], [2, 1], [1, 7], [6, 6.5], [9, 9], [8.5, 13.5], [5, 15], [1, 13.5]]],
  6: [[[8.5, 2], [5, 1], [2, 3], [0.8, 8], [1.5, 13.5], [5, 15], [8.5, 13.5], [9, 10], [6.5, 7.5], [3, 7.8], [1, 10]]],
  7: [[[0.5, 1], [9.5, 1], [4, 15]], [[3, 8], [8, 8]]],
  8: [[[5, 7.8], [2, 6], [1.8, 2.8], [5, 1], [8.2, 2.8], [8, 6], [5, 7.8], [1.2, 10.5], [2, 14], [5, 15], [8, 14], [8.8, 10.5], [5, 7.8]]],
  9: [[[9, 6], [6.5, 8], [3, 8], [1, 5.5], [1.8, 2], [5, 1], [8.2, 2], [9.2, 6], [8.5, 11.5], [5.5, 15], [2, 14]]],
};

function captchaImage(code) {
  const W = 200, H = 72, r = Math.random;
  const parts = [];
  const curve = (w, op) => {
    const y = () => (r() * H).toFixed(1);
    parts.push(`<path d="M0 ${y()} C${(W * 0.3).toFixed(0)} ${y()} ${(W * 0.7).toFixed(0)} ${y()} ${W} ${y()}" stroke="hsl(${Math.floor(r() * 360)},45%,${45 + Math.floor(r() * 25)}%)" stroke-width="${w.toFixed(1)}" fill="none" opacity="${op}"/>`);
  };
  for (let i = 0; i < 5; i++) curve(1 + r() * 1.5, 0.55);
  [...code].forEach((digit, i) => {
    const s = 3 + r() * 0.5;
    const x0 = 18 + i * 44 + (r() - 0.5) * 8, y0 = 6 + r() * 8;
    const a = (r() - 0.5) * 0.55, cos = Math.cos(a), sin = Math.sin(a);
    const colour = `hsl(${Math.floor(r() * 360)},65%,${28 + Math.floor(r() * 18)}%)`;
    const width = (2.6 + r() * 1.1).toFixed(1);
    for (const stroke of GLYPHS[digit]) {
      const pts = stroke.map(([px, py]) => {
        const X = (px + (r() - 0.5) * 0.9) * s, Y = (py + (r() - 0.5) * 0.9) * s;
        return `${(x0 + X * cos - Y * sin).toFixed(1)} ${(y0 + X * sin + Y * cos).toFixed(1)}`;
      });
      parts.push(`<path d="M${pts.join(" L")}" stroke="${colour}" stroke-width="${width}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`);
    }
  });
  for (let i = 0; i < 3; i++) curve(0.8 + r() * 0.8, 0.8);
  for (let i = 0; i < 40; i++) parts.push(`<circle cx="${(r() * W).toFixed(1)}" cy="${(r() * H).toFixed(1)}" r="${(0.6 + r() * 1.2).toFixed(1)}" fill="hsl(${Math.floor(r() * 360)},40%,50%)" opacity=".6"/>`);
  for (let i = parts.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [parts[i], parts[j]] = [parts[j], parts[i]]; } // drawing order says nothing either
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#f6f2e8"/>${parts.join("")}</svg>`;
  return "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
}

// The events that carry text someone typed, and where the text is in each.
// (null = an end-to-end message, which can't be read here.)
const TEXT_OF = {
  "message":          (m) => (typeof m === "string" ? m : m && m.text),   // random chat
  "privateMsg:send":  (d) => (!d ? "" : d.e2e ? null : d.message),
  "rooms:send":       (d) => d && d.text,
  "forum:createPost": (d) => d && [d.title, d.body].filter(Boolean).join("\n"),
  "forum:comment":    (d) => d && d.body,
  "poker:chat":       (d) => d && d.text,
  "blackjack:chat":   (d) => d && d.text,
  "chess:chat":       (d) => d && d.text,
  "checkers:chat":    (d) => d && d.text,
  "joker:chat":       (d) => d && d.text,
  "imposter:chat":    (d) => d && d.text,
};

function createSpamGuard({ log = console.log } = {}) {
  const byIp = new Map(); // ip → { recent: [{ t, at }], need: { code } | null, waiting: Set<socket>, seen }

  setInterval(() => {
    const now = Date.now();
    for (const [ip, st] of byIp) if (now - st.seen > FORGET_MS) byIp.delete(ip);
  }, 10 * 60 * 1000).unref();

  const ipOf = (socket) => socket.clientIP || "unknown";
  function state(ip) {
    let st = byIp.get(ip);
    if (!st) { st = { recent: [], need: null, waiting: new Set(), seen: Date.now() }; byIp.set(ip, st); }
    st.seen = Date.now();
    return st;
  }
  function challenge(st) {
    st.need = { code: String(crypto.randomInt(0, 10000)).padStart(4, "0") };
  }
  function hold(socket, st, send) {
    socket._spamHeld = socket._spamHeld || [];
    if (send && socket._spamHeld.length < MAX_HELD) socket._spamHeld.push(send);
    st.waiting.add(socket);
    if (socket._spamShown !== st.need) { // shown once per captcha, not on every held message
      socket._spamShown = st.need;
      socket.emit("spam:captcha", { img: captchaImage(st.need.code) });
    }
    return false;
  }
  function release(socket) {
    const held = socket._spamHeld || [];
    socket._spamHeld = [];
    socket._spamShown = null;
    socket._e2eSends = [];
    for (const send of held) { try { send(); } catch (e) { log("[SPAM] held message failed: " + e.message); } }
  }

  // Before a message goes out: text = what it says (null for an end-to-end
  // message the server can't read), send = sends it. → true: go ahead now;
  // false: it waits for the captcha and is sent once that's solved.
  function check(socket, text, send) {
    const st = state(ipOf(socket));
    if (st.need) return hold(socket, st, send);
    if (text === null) { // end-to-end: only counted, for "spam:repeat"
      const now = Date.now();
      socket._e2eSends = (socket._e2eSends || []).filter((at) => now - at < WINDOW_MS).concat(now).slice(-WINDOW_MSGS);
      return true;
    }
    const t = typeof text === "string" ? text.trim() : "";
    if (!t) return true;
    const now = Date.now();
    st.recent = st.recent.filter((m) => now - m.at < WINDOW_MS).slice(-(WINDOW_MSGS - 1));
    st.recent.push({ t, at: now });
    const same = st.recent.filter((m) => m.t === t).length;
    if (same < REPEAT_LIMIT) return true;
    challenge(st);
    log(`[SPAM] ${ipOf(socket)} sent the same message ${same} times — captcha`);
    return hold(socket, st, send);
  }

  // An end-to-end chat page saw the same text going out again and again.
  // Believed only from a connection that really did just send that many.
  function repeatSeen(socket) {
    const now = Date.now();
    const recent = (socket._e2eSends || []).filter((at) => now - at < WINDOW_MS);
    if (recent.length < REPEAT_LIMIT - 1) return;
    const st = state(ipOf(socket));
    if (st.need) return;
    challenge(st);
    log(`[SPAM] ${ipOf(socket)} repeated an encrypted private message — captcha`);
    hold(socket, st, null);
  }

  function attach(socket) {
    if (socket._spamGuard) return;
    socket._spamGuard = true;

    // Every message event passes through here first; one that has to wait
    // for the captcha is simply let through later, exactly as it was sent.
    // (Handlers run a tick after this, so "spam:repeat" is dealt with right
    // here — in order with the message right behind it.)
    socket.use((packet, next) => {
      if (packet[0] === "spam:repeat") return repeatSeen(socket);
      const textOf = TEXT_OF[packet[0]];
      if (!textOf) return next();
      let text = "";
      try { text = textOf(packet[1]); } catch (_) {}
      if (check(socket, text, () => next())) next();
    });

    socket.on("spam:solve", (d, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const st = byIp.get(ipOf(socket));
      if (!st || !st.need) { release(socket); return reply({ ok: true }); } // nothing (left) to solve
      const now = Date.now();
      if (now - (socket._spamTry || 0) < SOLVE_GAP_MS) return reply({ ok: false, wait: true });
      socket._spamTry = now;
      const answer = String((d && d.answer) || "").replace(/\D/g, "");
      if (answer !== st.need.code) {
        challenge(st);
        socket._spamShown = st.need;
        return reply({ ok: false, img: captchaImage(st.need.code) });
      }
      st.need = null;
      st.recent = [];
      log(`[SPAM] ${ipOf(socket)} solved the captcha`);
      reply({ ok: true });
      const waiting = [...st.waiting];
      st.waiting.clear();
      for (const s of waiting) {
        if (!s.connected) continue;
        if (s !== socket) s.emit("spam:cleared");
        release(s);
      }
      if (!waiting.includes(socket)) release(socket);
    });

    // 🔄 the same digits, drawn again
    socket.on("spam:image", (_d, ack) => {
      const st = byIp.get(ipOf(socket));
      if (typeof ack === "function") ack(st && st.need ? { img: captchaImage(st.need.code) } : { ok: true });
    });


    socket.on("disconnect", () => {
      const st = byIp.get(ipOf(socket));
      if (st) st.waiting.delete(socket);
    });
  }

  return { check, attach, REPEAT_LIMIT, WINDOW_MSGS, WINDOW_MS };
}

module.exports = { createSpamGuard, captchaImage, TEXT_OF };
