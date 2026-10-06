// ── 🔒 Private chats stored encrypted ──────────────────────────────────────
// With the CHAT_KEY environment variable set (Render → Environment), private
// messages (private_messages.json) and voice/photo files are written to disk
// encrypted with AES-256-GCM. The data folder and the admin backups then hold
// only scrambled data; the server unlocks it in memory to deliver messages,
// so nothing changes for users. Without CHAT_KEY everything is saved as
// before (plain), and files saved before the key existed still open.
//
// Every encrypted file carries a short fingerprint of the key it was locked
// with (not the key itself), so a backup restored on a server with a
// different key is recognised instead of being read as garbage.
"use strict";

const crypto = require("crypto");

const RAW = String(process.env.CHAT_KEY || "").trim();
const MIN_LEN = 20;
const KEY = RAW.length >= MIN_LEN ? crypto.createHash("sha256").update(RAW, "utf8").digest() : null;
const KEY_ID = KEY ? crypto.createHash("sha256").update("gaicani-key-id:").update(KEY).digest("hex").slice(0, 8) : null;

const TEXT_TAG = "GCENC1:";                      // GCENC1:<keyId>:<base64(iv|tag|data)>
const FILE_TAG = Buffer.from("GCENC1\0", "latin1"); // GCENC1\0<keyId><iv|tag|data>

function seal(buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const data = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]);
}
function unseal(buf) {
  const d = crypto.createDecipheriv("aes-256-gcm", KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
}
function keyError(id) {
  const e = new Error(KEY ? "locked with a different CHAT_KEY" : "locked, and CHAT_KEY isn't set");
  e.code = KEY ? "WRONG_KEY" : "NO_KEY";
  e.keyId = id;
  return e;
}

const isEncryptedText = (s) => typeof s === "string" && s.startsWith(TEXT_TAG);
const isEncryptedFile = (b) => Buffer.isBuffer(b) && b.length > FILE_TAG.length + 8 && b.subarray(0, FILE_TAG.length).equals(FILE_TAG);

// Text files (the private-chat JSON).
function encryptText(str) {
  if (!KEY) return str;
  return TEXT_TAG + KEY_ID + ":" + seal(Buffer.from(str, "utf8")).toString("base64");
}
function decryptText(str) {
  if (!isEncryptedText(str)) return str;
  const rest = str.slice(TEXT_TAG.length), id = rest.slice(0, 8);
  if (!KEY || id !== KEY_ID) throw keyError(id);
  return unseal(Buffer.from(rest.slice(9), "base64")).toString("utf8");
}

// Binary files (voice messages, photos).
function encryptFile(buf) {
  if (!KEY) return buf;
  return Buffer.concat([FILE_TAG, Buffer.from(KEY_ID, "latin1"), seal(buf)]);
}
function decryptFile(buf) {
  if (!isEncryptedFile(buf)) return buf;
  const id = buf.subarray(FILE_TAG.length, FILE_TAG.length + 8).toString("latin1");
  if (!KEY || id !== KEY_ID) throw keyError(id);
  return unseal(buf.subarray(FILE_TAG.length + 8));
}

// Can this server open that saved chat file? → { encrypted, ok, code }
function checkText(str) {
  if (!isEncryptedText(str)) return { encrypted: false, ok: true };
  try { decryptText(str); return { encrypted: true, ok: true }; }
  catch (e) { return { encrypted: true, ok: false, code: e.code || "DAMAGED" }; }
}

module.exports = {
  enabled: !!KEY,
  keyTooShort: !!RAW && !KEY,
  minLength: MIN_LEN,
  keyId: KEY_ID,
  isEncryptedText, isEncryptedFile,
  encryptText, decryptText, encryptFile, decryptFile, checkText,
};
