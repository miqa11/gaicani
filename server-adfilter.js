// ── 🚫 Ad filter — banned phrases set in the admin panel ─────────────────────
// The admin adds phrases like "SEV•GE". Anyone who then sends a message
// containing one (random chat, rooms, forum, game chats, private chat that
// isn't end-to-end) is banned by IP at once, and the message never goes out.
// Each ban is logged — who, which IP, when, what they wrote and which phrase
// caught it — so the admin can see it and undo a mistake.
//
// A phrase is matched loosely, the way advertisers disguise it: case, spaces,
// dots, dashes and symbols between the letters are ignored, and look-alike
// letters (Cyrillic "е", "ѕ"…, 0 for o, 1 for i…) count as the real ones —
// "SEV•GE" also catches "sev.ge", "S E V G E", "ѕеv-gе", "sev ge".
// A phrase written as /…/ is used as a real regular expression instead.
"use strict";

const crypto = require("crypto");

const MAX_PATTERNS = 200, MAX_BANS = 1000, MAX_TEXT = 300;
const LOOKALIKE = {
  // Cyrillic / Greek letters that look Latin
  "а": "a", "в": "b", "е": "e", "ё": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c", "т": "t",
  "у": "y", "х": "x", "ѕ": "s", "і": "i", "ј": "j", "ԁ": "d", "ɡ": "g", "ο": "o", "α": "a", "ε": "e", "ν": "v",
  "ι": "i", "κ": "k", "τ": "t", "ρ": "p", "υ": "u",
  // digits and symbols used as letters
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s", "!": "i", "|": "i",
};
// Lower case, look-alikes to the real letter, and only letters/digits kept.
function squash(text) {
  let s = String(text || "").normalize("NFKC").toLowerCase();
  let out = "";
  for (const ch of s) {
    const c = LOOKALIKE[ch] || ch;
    if (/[\p{L}\p{N}]/u.test(c)) out += c;
  }
  return out;
}

function compile(raw) {
  const p = String(raw || "").trim();
  const m = p.match(/^\/(.+)\/([a-z]*)$/s);
  if (m) {
    if (m[1].length > 200) return { error: "Regex is too long (max 200 characters)" };
    try { return { regex: new RegExp(m[1], [...new Set((m[2] + "iu").replace(/[^imsu]/g, ""))].join("")) }; }
    catch (e) { return { error: "Not a valid regex: " + e.message }; }
  }
  const sq = squash(p);
  if (sq.length < 3) return { error: "Too short — it would catch normal messages. Use at least 3 letters/digits." };
  return { squashed: sq };
}

function createAdFilter({ file, readJson, writeAtomic, log = console.log }) {
  let patterns = []; // { id, pattern, addedAt }
  let bans = [];     // { id, at, username, ip, text, pattern, where, unbanned }
  const compiled = new Map(); // id → { regex } | { squashed }
  try {
    const o = readJson(file);
    patterns = Array.isArray(o.patterns) ? o.patterns : [];
    bans = Array.isArray(o.bans) ? o.bans : [];
  } catch { /* first run */ }
  for (const p of patterns) { const c = compile(p.pattern); if (!c.error) compiled.set(p.id, c); }

  let timer = null;
  function save() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try { writeAtomic(file, JSON.stringify({ patterns, bans })); } catch (e) { log("[ADFILTER] save failed: " + e.message); }
    }, 500);
  }

  // The phrase this text contains, or null.
  function match(text) {
    if (!patterns.length || typeof text !== "string" || !text) return null;
    const t = text.slice(0, 4000);
    let sq = null;
    for (const p of patterns) {
      const c = compiled.get(p.id);
      if (!c) continue;
      if (c.regex) { c.regex.lastIndex = 0; if (c.regex.test(t.normalize("NFKC"))) return p; }
      else { if (sq === null) sq = squash(t); if (sq.includes(c.squashed)) return p; }
    }
    return null;
  }

  return {
    match,
    squash,
    add(raw) {
      const pattern = String(raw || "").trim().slice(0, 210);
      if (!pattern) return { error: "Type a phrase" };
      if (patterns.length >= MAX_PATTERNS) return { error: "Too many phrases (max " + MAX_PATTERNS + ")" };
      const c = compile(pattern);
      if (c.error) return { error: c.error };
      if (patterns.some((p) => p.pattern.toLowerCase() === pattern.toLowerCase())) return { error: "Already in the list" };
      const entry = { id: crypto.randomBytes(5).toString("hex"), pattern, addedAt: Date.now() };
      patterns.push(entry); compiled.set(entry.id, c); save();
      return { ok: true, entry };
    },
    remove(id) {
      const i = patterns.findIndex((p) => p.id === id);
      if (i < 0) return false;
      compiled.delete(patterns[i].id); patterns.splice(i, 1); save();
      return true;
    },
    record({ username, ip, text, pattern, where }) {
      const entry = { id: crypto.randomBytes(5).toString("hex"), at: Date.now(), username: username || "", ip: ip || "",
        text: String(text || "").slice(0, MAX_TEXT), pattern, where: where || "" };
      bans.unshift(entry);
      if (bans.length > MAX_BANS) bans.length = MAX_BANS;
      save();
      return entry;
    },
    ban(id) { return bans.find((b) => b.id === id) || null; },
    markUnbanned(id) { const b = bans.find((x) => x.id === id); if (b) { b.unbanned = Date.now(); save(); } return b; },
    view() { return { patterns, bans: bans.slice(0, 300), total: bans.length }; },
  };
}

module.exports = { createAdFilter, squash };
