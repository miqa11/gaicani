// ── 🛟 Support AI — asks random-chat visitors what we should improve ─────────
// When someone searching in random chat finds no real partner within WAIT_MS,
// "Support AI" (a scripted partner, not a person) is matched with them
// instead. It asks the question, says thanks after the first answer, and
// every message they send it is saved for the Support dashboard.
// "⏭ გამოტოვება" or 🚫 block = it never comes to that person again; anyone
// else meets it at most once every AGAIN_AFTER_MS. Support turns it on/off.
//
// The partner object stands in for a socket: the random-chat code calls
// partner.emit(...) on it like on any socket, and it answers through the
// real person's socket.
"use strict";

const crypto = require("crypto");

const NAME = "Support AI";
const AVATAR = "avatar-support.jpg";
const QUESTION = [
  "გვითხარი რა არ მოგწონს ან რას ისურვებდი, რომ უკეთესი იყოს.",
  "თუ არაფერი გაქვს სათქმელი, უბრალოდ დამბლოკე — აღარ შეგაწუხებ. ❤️",
  "შენი აზრი ჩვენთვის ძალიან მნიშვნელოვანია.",
];
const THANKS = "მადლობა! ❤️ შენი აზრი გადავეცი ჩვენს გუნდს. თუ კიდევ რამე გაქვს სათქმელი, მომწერე.";
const WAIT_MS = 5000;                       // only when no real partner turns up this fast
const AGAIN_AFTER_MS = 7 * 24 * 3600 * 1000; // the same person at most once a week
const MAX_CONVS = 1000, MAX_MSGS = 40, MAX_TEXT = 1000;

function createSupportAI({ file, readJson, writeAtomic, graceMs, onUpdate = () => {}, log = console.log }) {
  const st = {
    enabled: true,
    optOut: new Set(),   // people who skipped / blocked it — never again
    lastMet: new Map(),  // key → when they last met it
    counts: { asked: 0, answered: 0, skipped: 0 },
    convs: [],           // conversations with at least one message, newest first
  };
  try {
    const o = readJson(file);
    st.enabled = o.enabled !== false;
    st.optOut = new Set(o.optOut || []);
    st.lastMet = new Map(Object.entries(o.lastMet || {}));
    st.counts = Object.assign(st.counts, o.counts || {});
    st.convs = Array.isArray(o.convs) ? o.convs : [];
  } catch { /* first run */ }

  let saveTimer = null;
  function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const cut = Date.now() - AGAIN_AFTER_MS;
      for (const [k, t] of st.lastMet) if (t < cut) st.lastMet.delete(k);
      try {
        writeAtomic(file, JSON.stringify({ enabled: st.enabled, optOut: [...st.optOut], lastMet: Object.fromEntries(st.lastMet), counts: st.counts, convs: st.convs }));
      } catch (e) { log("[SUPPORT-AI] save failed: " + e.message); }
    }, 2000);
  }

  // Who this is, as stably as we can tell — the account, this browser's
  // random id, or (only if neither) the guest name. No IP addresses.
  function keysOf(sock) {
    const keys = [];
    const r = sock._regUser;
    if (r && !r.isGuest && r.usernameLower) keys.push("a:" + r.usernameLower);
    if (sock._did) keys.push("d:" + sock._did);
    if (!keys.length && sock.userName) keys.push("g:" + String(sock.userName).toLowerCase());
    return keys;
  }
  function eligible(sock) {
    if (!st.enabled) return false;
    const keys = keysOf(sock);
    if (!keys.length) return false;
    const cut = Date.now() - AGAIN_AFTER_MS;
    return !keys.some((k) => st.optOut.has(k) || (st.lastMet.get(k) || 0) > cut);
  }

  // A new conversation with this person's socket. Returns the stand-in partner.
  function start(user) {
    const now = Date.now();
    const keys = keysOf(user);
    for (const k of keys) st.lastMet.set(k, now);
    st.counts.asked++;
    save();
    const reg = user._regUser && !user._regUser.isGuest ? user._regUser : null;
    const who = { name: reg ? reg.username : (user.userName || "სტუმარი"), registered: !!reg };
    let conv = null, ended = false, finalTimer = null, msgN = 0;
    const timers = new Set();
    const later = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); };

    const bot = {
      id: "supportai:" + crypto.randomBytes(6).toString("hex"),
      isSupportAI: true,
      userName: NAME, clientIP: "", bio: "", interests: [], _regUser: null,
      connected: true, _isGhost: false, partner: user,
      recentPartnerIds: new Set(), blockedNames: [], blockedIds: new Set(), blockedByTimes: [],
      lastPartnerName: user.userName, hasTyped: false, chatStartedAt: now, lastMessages: [], spamStrikes: 0,
      emit(ev, data) { onEvent(ev, data); return true; },
      disconnect() { finish(); },
      join() {}, leave() {},
    };
    // Only to the person still talking to it (not after they moved on).
    const live = () => bot.partner && bot.partner.partner === bot && bot.partner.connected && !bot.partner._isGhost ? bot.partner : null;
    const say = (text) => { const u = live(); if (u) { u.emit("partnerTyping", false); u.emit("message", { text, messageId: bot.id + "-" + (++msgN) }); } };
    const typing = () => { const u = live(); if (u) u.emit("partnerTyping", true); };

    function record(text) {
      if (!conv) {
        conv = { id: bot.id.slice(10), at: Date.now(), who: who.name, registered: who.registered, outcome: "", messages: [] };
        st.convs.unshift(conv);
        if (st.convs.length > MAX_CONVS) st.convs.length = MAX_CONVS;
        st.counts.answered++;
      }
      if (conv.messages.length >= MAX_MSGS) return;
      const m = { text: String(text).slice(0, MAX_TEXT), at: Date.now() };
      conv.messages.push(m);
      save();
      onUpdate({ conv });
    }
    function optOut(outcome) {
      for (const k of keys) st.optOut.add(k);
      st.counts.skipped++;
      if (conv) { conv.outcome = outcome; onUpdate({ conv }); }
      save();
      log(`[SUPPORT-AI] ${who.name} — ${outcome === "blocked" ? "blocked" : "skipped"} (won't be asked again)`);
    }
    function finish() {
      if (ended) return;
      ended = true; bot.connected = false;
      for (const t of timers) clearTimeout(t);
      timers.clear(); clearTimeout(finalTimer);
    }

    function onEvent(ev, data) {
      if (ended) return;
      if (ev === "message") {
        const text = data && typeof data.text === "string" ? data.text.trim() : "";
        if (!text) return;
        record(text);
        const first = conv.messages.length === 1;
        if (data.messageId) later(700, () => { const u = live(); if (u) u.emit("partnerSeen", { messageId: data.messageId }); });
        if (first) { later(1300, typing); later(2900, () => say(THANKS)); }
      } else if (ev === "sticker" || ev === "gif") {
        record(ev === "gif" ? "[GIF]" : "[სტიკერი]");
      } else if (ev === "youWereBlocked") {
        optOut("blocked");
        finish();
      } else if (ev === "partnerDisconnected") {
        // They moved on (or lost connection — they can come back for a while).
        clearTimeout(finalTimer);
        finalTimer = setTimeout(finish, graceMs);
      } else if (ev === "partnerReconnected") {
        clearTimeout(finalTimer);
      } else if (ev === "game:invite" || ev === "music:invite") {
        // It doesn't play — say no straight away instead of leaving them waiting.
        later(800, () => { const u = live(); if (u) u.emit(ev === "game:invite" ? "game:declined" : "music:declined"); });
      }
      // Anything else (typing, seen, reactions…) — ignored.
    }

    // The question, typed out line by line like a person would.
    later(1000, typing);
    later(2300, () => say(QUESTION[0]));
    later(2800, typing);
    later(4300, () => say(QUESTION[1]));
    later(4800, typing);
    later(6000, () => { say(QUESTION[2]); const u = live(); if (u) u.emit("supportAI:skipOffer"); });

    bot.skip = () => { if (!ended) optOut("skipped"); };
    return bot;
  }

  return {
    NAME, AVATAR, WAIT_MS,
    get enabled() { return st.enabled; },
    setEnabled(on) { st.enabled = !!on; save(); },
    eligible, start, keysOf,
    isBot: (x) => !!(x && x.isSupportAI),
    // After the conversation is over (block from the "partner left" offer).
    optOutSocket(sock) { const keys = keysOf(sock); if (!keys.length) return; for (const k of keys) st.optOut.add(k); st.counts.skipped++; save(); },
    view(limit = 200) { return { enabled: st.enabled, counts: st.counts, optedOut: st.optOut.size, convs: st.convs.slice(0, limit) }; },
    remove(id) { const i = st.convs.findIndex((c) => c.id === id); if (i < 0) return false; st.convs.splice(i, 1); save(); return true; },
  };
}

module.exports = { createSupportAI, NAME };
