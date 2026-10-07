/* ════════════════════════════════════════════════════════════════════════════
   🔐 End-to-end encrypted private chats — the browser side
   ════════════════════════════════════════════════════════════════════════════
   Every account has a key pair (P-256) made here, in the user's browser:
     * the public half goes to the server, so friends can lock messages for you;
     * the private half never leaves the device unlocked. A copy locked with
       your password (PBKDF2-SHA256 → AES-GCM) is kept on the server, so the
       same account can open its chats on another phone by typing its
       password — the server can't open that copy.
   Two friends' keys give both of them the same secret (ECDH → HKDF), which
   locks each message with AES-256-GCM. Nobody else — not the server, not the
   site owner, not someone holding a backup — can read it.

   On this device the private key is kept in IndexedDB as a non-extractable
   key: scripts can use it, but can't read it out. Logging out removes it.
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const subtle = window.crypto && window.crypto.subtle;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const ITER = 310000;                   // PBKDF2 rounds for the password lock (~0.3–1 s on a phone)
  const CURVE = { name: "ECDH", namedCurve: "P-256" };
  const GCM = (iv, aad) => ({ name: "AES-GCM", iv, additionalData: aad });

  const b64 = (buf) => {
    const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const unb64 = (s) => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
  const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  const rand = (n) => window.crypto.getRandomValues(new Uint8Array(n));
  const keyIdOf = async (pubB64) => hex(await subtle.digest("SHA-256", unb64(pubB64))).slice(0, 16);

  function supported() {
    return !!(subtle && window.indexedDB !== undefined && window.isSecureContext !== false && typeof TextEncoder === "function");
  }

  /* ── This device's keys (IndexedDB, falls back to memory for the visit) ──
     One record per account: { current, keys: { keyId: { priv, pub } }, bundle }
     — older keys stay so messages locked with them still open. */
  const DB = "gaicani-e2ee", STORE = "keys";
  const memory = new Map();
  let dbp = null;
  function idb() {
    if (!dbp) dbp = new Promise((res, rej) => {
      try {
        const r = indexedDB.open(DB, 1);
        r.onupgradeneeded = () => r.result.createObjectStore(STORE);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      } catch (e) { rej(e); }
    });
    return dbp;
  }
  async function loadRec(lc) {
    if (memory.has(lc)) return memory.get(lc);
    try {
      const db = await idb();
      const rec = await new Promise((res) => {
        const q = db.transaction(STORE).objectStore(STORE).get(lc);
        q.onsuccess = () => res(q.result || null);
        q.onerror = () => res(null);
      });
      if (rec) memory.set(lc, rec);
      return rec;
    } catch (_) { return null; }
  }
  async function saveRec(lc, rec) {
    memory.set(lc, rec);
    try {
      const db = await idb();
      await new Promise((res, rej) => {
        const t = db.transaction(STORE, "readwrite");
        t.objectStore(STORE).put(rec, lc);
        t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
      });
    } catch (_) { /* private browsing etc. — kept for this visit only */ }
  }
  // A record that holds this key under another name (the account was
  // renamed) — moved over to the new name.
  async function adoptByKeyId(lc, keyId) {
    try {
      const db = await idb();
      const found = await new Promise((res) => {
        const q = db.transaction(STORE).objectStore(STORE).openCursor();
        q.onsuccess = () => {
          const c = q.result;
          if (!c) return res(null);
          if (c.value && c.value.keys && c.value.keys[keyId]) return res({ name: c.key, rec: c.value });
          c.continue();
        };
        q.onerror = () => res(null);
      });
      if (!found) return null;
      await saveRec(lc, found.rec);
      if (found.name !== lc) await forget(found.name);
      return found.rec;
    } catch (_) { return null; }
  }
  async function forget(username) {
    const lc = String(username || "").toLowerCase();
    memory.delete(lc);
    try {
      const db = await idb();
      await new Promise((res) => { const t = db.transaction(STORE, "readwrite"); t.objectStore(STORE).delete(lc); t.oncomplete = res; t.onerror = res; });
    } catch (_) {}
  }

  /* ── The password lock for the server's copy ─────────────────────────── */
  async function passKey(password, salt, iter) {
    const base = await subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
    return subtle.deriveKey({ name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" }, base,
      { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  const WRAP_AAD = enc.encode("gaicani-e2ee-key-v1");
  async function wrap(jwk, password) {
    const salt = rand(16), iv = rand(12);
    const k = await passKey(password, salt, ITER);
    const ct = await subtle.encrypt(GCM(iv, WRAP_AAD), k, enc.encode(JSON.stringify(jwk)));
    return { salt: b64(salt), iter: ITER, iv: b64(iv), ct: b64(ct) };
  }
  async function unwrap(w, password) {
    const k = await passKey(password, unb64(w.salt), w.iter);
    const plain = await subtle.decrypt(GCM(unb64(w.iv), WRAP_AAD), k, unb64(w.ct)); // throws if the password is wrong
    return JSON.parse(dec.decode(plain));
  }
  const importPriv = (jwk) => subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d, ext: true },
    CURVE, false, ["deriveBits"]);
  const importPub = (pubB64) => subtle.importKey("raw", unb64(pubB64), CURVE, false, []);

  async function remember(lc, bundle, jwk) {
    const rec = (await loadRec(lc)) || { current: null, keys: {} };
    rec.keys[bundle.keyId] = { priv: await importPriv(jwk), pub: bundle.pub };
    rec.current = bundle.keyId;
    rec.bundle = { keyId: bundle.keyId, pub: bundle.pub, wrapped: bundle.wrapped };
    await saveRec(lc, rec);
    return rec;
  }

  /* ── State for the page ─────────────────────────────────────────────── */
  const S = { token: null, lc: null, rec: null, serverKeyId: null, status: "off" };
  const friends = new Map(); // lc → { keyId, byId: { keyId: pubB64 } }
  const pubKeys = new Map(); // keyId → CryptoKey
  const pairKeys = new Map(); // "myId|theirId" → AES key

  async function api(path, body) {
    const r = await fetch(path, {
      method: body ? "POST" : "GET",
      headers: Object.assign({ Authorization: "Bearer " + S.token }, body ? { "Content-Type": "application/json" } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    let d = null; try { d = await r.json(); } catch (_) {}
    return { status: r.status, ok: r.ok, d: d || {} };
  }

  // Publish a key: this device's own one if it has it (wrapped with the same
  // password — checked first), otherwise a brand-new one.
  async function publish(lc, password, replace) {
    const rec = await loadRec(lc);
    let pub, wrapped, jwk = null;
    if (rec && rec.bundle && rec.keys[rec.bundle.keyId]) {
      try { await unwrap(rec.bundle.wrapped, password); pub = rec.bundle.pub; wrapped = rec.bundle.wrapped; } catch (_) {}
    }
    if (!pub) {
      const kp = await subtle.generateKey(CURVE, true, ["deriveBits"]);
      jwk = await subtle.exportKey("jwk", kp.privateKey);
      pub = b64(await subtle.exportKey("raw", kp.publicKey));
      wrapped = await wrap(jwk, password);
    }
    const r = await api("/api/e2ee/key", { password, pub, wrapped, replace: !!replace });
    if (r.status === 409 && r.d.key) return setupWithPassword({ token: S.token, username: lc, password, key: r.d.key });
    if (!r.ok) throw new Error(r.d.error || "key");
    const bundle = r.d.key;
    if (jwk) await remember(lc, bundle, jwk);
    else { rec.current = bundle.keyId; await saveRec(lc, rec); }
    return true;
  }

  // Right after logging in or signing up, while the password is at hand:
  // open this account's key on this device, or make one if it has none yet.
  async function setupWithPassword({ token, username, password, key }) {
    if (!supported() || !token || !username || !password) return false;
    S.token = token;
    const lc = String(username).toLowerCase();
    if (key && key.wrapped) {
      let jwk = null;
      try { jwk = await unwrap(key.wrapped, password); } catch (_) {}
      if (jwk) { await remember(lc, key, jwk); return true; }
      // The copy on file doesn't open with this (correct) password — e.g. the
      // password was reset. Start a new key; older messages may stay locked.
      return publish(lc, password, true);
    }
    return publish(lc, password, false);
  }

  // On a chat page: is this device ready? → "ready" | "locked" | "unsupported"
  async function open({ token, username }) {
    S.token = token; S.lc = String(username).toLowerCase();
    if (!supported()) return (S.status = "unsupported");
    S.rec = await loadRec(S.lc);
    const r = await api("/api/e2ee/keys?user=" + encodeURIComponent(S.lc));
    S.serverKeyId = r.ok && r.d.key ? r.d.key.keyId : null;
    if (S.serverKeyId && !(S.rec && S.rec.keys[S.serverKeyId])) S.rec = (await adoptByKeyId(S.lc, S.serverKeyId)) || S.rec;
    if (S.serverKeyId && S.rec && S.rec.keys[S.serverKeyId]) {
      if (S.rec.current !== S.serverKeyId) { S.rec.current = S.serverKeyId; await saveRec(S.lc, S.rec); }
      return (S.status = "ready");
    }
    return (S.status = "locked");
  }

  // The password typed on a chat page (devices that were logged in before
  // encryption existed, or a new phone). → true, or throws with a message.
  async function unlock(password) {
    const r = await api("/api/e2ee/unlock", { password });
    if (r.status === 401) throw new Error(r.d.error || "არასწორი პაროლი");
    if (r.status === 429) throw new Error("ძალიან ბევრი მცდელობა — ცოტა ხანში სცადე");
    if (!r.ok) throw new Error("ვერ მოხერხდა — სცადე თავიდან");
    await setupWithPassword({ token: S.token, username: S.lc, password, key: r.d.key });
    return (await open({ token: S.token, username: S.lc })) === "ready";
  }

  /* ── Friends' public keys ─────────────────────────────────────────────── */
  function learnFriend(lc, info) {
    lc = String(lc).toLowerCase();
    if (!info) { friends.set(lc, { keyId: null, byId: {} }); return; }
    const byId = {};
    for (const k of [info, ...(info.old || [])]) if (k && k.keyId && k.pub) byId[k.keyId] = k.pub;
    friends.set(lc, { keyId: info.keyId, byId });
  }
  async function refreshFriend(lc) {
    const r = await api("/api/e2ee/keys?user=" + encodeURIComponent(String(lc).toLowerCase()));
    if (r.ok) learnFriend(lc, r.d.key);
    return friendKeyId(lc);
  }
  const friendKeyId = (lc) => (friends.get(String(lc).toLowerCase()) || {}).keyId || null;

  async function pubKey(keyId, pubB64) {
    if (!pubKeys.has(keyId)) {
      if ((await keyIdOf(pubB64)) !== keyId) throw new Error("key mismatch");
      pubKeys.set(keyId, await importPub(pubB64));
    }
    return pubKeys.get(keyId);
  }
  // The secret two people share: ECDH of my private key and their public key,
  // stretched with HKDF into an AES-256-GCM key (the same on both sides).
  async function pairKey(myId, theirId, theirLc) {
    const id = myId + "|" + theirId;
    if (pairKeys.has(id)) return pairKeys.get(id);
    const mine = S.rec && S.rec.keys[myId];
    const f = friends.get(theirLc);
    const theirPub = (f && f.byId[theirId]) || (S.rec && S.rec.keys[theirId] && S.rec.keys[theirId].pub);
    if (!mine || !theirPub) throw new Error("no key");
    const bits = await subtle.deriveBits({ name: "ECDH", public: await pubKey(theirId, theirPub) }, mine.priv, 256);
    const hk = await subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
    // Tied to the two keys, not the names — so a renamed account's chats still open.
    const pair = [myId, theirId].sort().join("|");
    const key = await subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode("gaicani-e2ee-v1"), info: enc.encode(pair) },
      hk, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    pairKeys.set(id, key);
    return key;
  }
  // Bound into every message: what it is and which key sent it to which, so
  // a message can't be passed off as another kind or as going the other way.
  const aad = (kind, env) => enc.encode(`gaicani-e2ee-v1|${kind}|${env.s}>${env.r}`);

  // Can a message to this friend be sent end-to-end right now?
  function canSeal(friendLc) {
    return S.status === "ready" && !!S.rec && !!S.rec.keys[S.rec.current] && !!friendKeyId(friendLc);
  }
  // Must it be? (Both of you have keys — then the server refuses anything else.)
  function mustSeal(friendLc) { return !!S.serverKeyId && !!friendKeyId(friendLc); }

  async function sealBytes(friendLc, kind, bytes) {
    friendLc = String(friendLc).toLowerCase();
    const s = S.rec.current, r = friendKeyId(friendLc);
    const key = await pairKey(s, r, friendLc);
    const iv = rand(12);
    const env = { v: 1, s, r, iv: b64(iv) };
    const ct = await subtle.encrypt(GCM(iv, aad(kind, env)), key, bytes);
    return { env, ct };
  }
  async function openBytes(friendLc, fromLc, kind, env, ct) {
    friendLc = String(friendLc).toLowerCase(); fromLc = String(fromLc).toLowerCase();
    const mine = fromLc === S.lc;
    const myId = mine ? env.s : env.r, theirId = mine ? env.r : env.s;
    if (!S.rec || !S.rec.keys[myId]) return null; // locked on this device / an older key it never had
    const f = friends.get(friendLc);
    if (!f || !f.byId[theirId]) await refreshFriend(friendLc);
    try {
      const key = await pairKey(myId, theirId, friendLc);
      return await subtle.decrypt(GCM(unb64(env.iv), aad(kind, env)), key, ct);
    } catch (_) { return null; }
  }

  // Text-like messages (text + reply quote, sticker, GIF): a small JSON object.
  async function sealJSON(friendLc, kind, obj) {
    const { env, ct } = await sealBytes(friendLc, kind, enc.encode(JSON.stringify(obj)));
    env.ct = b64(ct);
    return env;
  }
  async function openJSON(friendLc, fromLc, kind, env) {
    if (!env || !env.ct) return null;
    const plain = await openBytes(friendLc, fromLc, kind, env, unb64(env.ct));
    if (!plain) return null;
    try { return JSON.parse(dec.decode(plain)); } catch (_) { return null; }
  }
  // Voice messages and photos: the file is locked whole; the envelope (no ct)
  // goes with the message.
  async function sealFile(friendLc, kind, arrayBuffer) {
    const { env, ct } = await sealBytes(friendLc, kind, arrayBuffer);
    return { env, data: b64(ct) };
  }
  async function openFile(friendLc, fromLc, kind, env, arrayBuffer) {
    return openBytes(friendLc, fromLc, kind, env, arrayBuffer);
  }

  window.GaicaniE2EE = {
    supported, setupWithPassword, open, unlock, forget,
    learnFriend, refreshFriend, friendKeyId, canSeal, mustSeal,
    sealJSON, openJSON, sealFile, openFile,
    get status() { return S.status; },
    get hasServerKey() { return !!S.serverKeyId; },
  };
})();
