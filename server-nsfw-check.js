/* ══════════════════════════════════════════════════════════════════════════
   server-nsfw-check.js — free, self-hosted nudity detection for GAICANI
   ────────────────────────────────────────────────────────────────────────
   OBSOLETE: GAICANI no longer supports sending photos (random chat and
   friend chat both had photo-send functionality removed — see server.js,
   script.js, friend-chat.html, style.css). This file was only ever useful
   as a pre-relay check on photo uploads, so it is not wired into server.js
   and can be deleted. Kept here only for reference in case photo sending
   is reintroduced later.
   ────────────────────────────────────────────────────────────────────────
   Uses NSFWJS (open-source, runs locally via TensorFlow.js — NO API key,
   NO per-request cost, NO external calls once the model is downloaded).

   HOW TO INTEGRATE (if photo sending is ever added back):
   1. npm install nsfwjs @tensorflow/tfjs-node
   2. Put this file next to server.js.
   3. At the top of server.js:  const { checkImageNSFW, nsfwReady } = require("./server-nsfw-check");
   4. Before relaying ANY photo, await checkImageNSFW(dataUrl) and branch on
      the result — see the usage example at the bottom of this file.
   ══════════════════════════════════════════════════════════════════════════ */

"use strict";

const tf    = require("@tensorflow/tfjs-node");
const nsfwjs = require("nsfwjs");

// ── Model loading (once, at startup) ────────────────────────────────────────
let model = null;
let modelLoadingPromise = null;

function loadModel() {
  if (model) return Promise.resolve(model);
  if (modelLoadingPromise) return modelLoadingPromise;

  modelLoadingPromise = nsfwjs.load().then(m => {
    model = m;
    console.log("[NSFW] Model loaded and ready.");
    return m;
  }).catch(e => {
    console.error("[NSFW] Failed to load model:", e.message);
    modelLoadingPromise = null; // allow retry on next call
    throw e;
  });

  return modelLoadingPromise;
}

// Kick off loading immediately so the first real image check isn't slow.
loadModel().catch(() => {});

// Resolves once the model is ready — optional, useful if you want to gate
// server startup / route registration on it.
const nsfwReady = () => loadModel();

// ── Config ───────────────────────────────────────────────────────────────
// Tune these thresholds to taste. "Sexy" (swimwear/lingerie-type, non-nude)
// is intentionally allowed through by default — only real nudity/porn/hentai
// gets rejected, matching "not bikini, but full nudes" from the request.
const REJECT_THRESHOLDS = {
  Porn:   0.55,
  Hentai: 0.60,
  Sexy:   1.01, // set below 1 (e.g. 0.9) if you also want to catch borderline "Sexy" shots
};

// ── Core check ───────────────────────────────────────────────────────────
// dataUrl: a base64 data URL string, e.g. "data:image/jpeg;base64,...."
// Returns: { blocked: boolean, predictions: [...] }
async function checkImageNSFW(dataUrl) {
  try {
    const m = await loadModel();

    const base64 = String(dataUrl).split(",")[1] || String(dataUrl);
    const buffer = Buffer.from(base64, "base64");

    const image = tf.node.decodeImage(buffer, 3);
    let predictions;
    try {
      predictions = await m.classify(image);
    } finally {
      image.dispose(); // always free the tensor, even if classify() throws
    }

    let blocked = false;
    for (const p of predictions) {
      const threshold = REJECT_THRESHOLDS[p.className];
      if (threshold !== undefined && p.probability >= threshold) {
        blocked = true;
        break;
      }
    }

    return { blocked, predictions };
  } catch (e) {
    console.error("[NSFW] Check failed, failing OPEN (allowing image):", e.message);
    // Fail-open: if the checker itself errors (bad image data, model hiccup),
    // don't silently block legitimate photos. Change to `blocked: true` if
    // you'd rather fail closed instead.
    return { blocked: false, predictions: [], error: true };
  }
}

module.exports = { checkImageNSFW, nsfwReady };

/* ══════════════════════════════════════════════════════════════════════════
   USAGE EXAMPLE — drop-in replacement for the friendChat:photo handler in
   server-friendchat-media-patch.js. Same pattern applies to any other place
   a photo/dataUrl gets relayed (random chat photo send, etc.) — just wrap
   the existing "relay to recipient" line with this check first.
   ══════════════════════════════════════════════════════════════════════════

  socket.on("friendChat:photo", async ({ toUsername, dataUrl }) => {
    if (!socket._regUser || !toUsername || !dataUrl) return;

    const toLc   = String(toUsername).toLowerCase().trim();
    const myUser = registeredUsers.get(socket._regUser.usernameLower);

    if (!myUser || !(myUser.friends || []).includes(toLc)) return;

    // ── NSFW check — runs before anything is relayed ──────────────────────
    const { blocked } = await checkImageNSFW(dataUrl);
    if (blocked) {
      // Only the sender sees this — nothing is shown to the recipient,
      // nobody is blocked, the chat stays open.
      socket.emit("friendChat:photoRejected", {
        message: "ფოტო არ აკმაყოფილებს დადგენილ მოთხოვნებს და მისი გაგზავნა დაუშვებელია."
      });
      return;
    }

    io.to(`user:${toLc}`).emit("friendChat:photo", {
      fromUsername: socket._regUser.username,
      dataUrl:      dataUrl,
      timestamp:    new Date().toISOString()
    });
  });

*/
