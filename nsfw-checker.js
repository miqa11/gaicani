/**
 * nsfw-checker.js — Free, self-hosted nudity/porn filter for GAICANI photos
 * ─────────────────────────────────────────────────────────────────────────
 * STATUS: OFF by default (see "Kill switch" below). Your Render instance
 * OOM-crashed twice trying to load the model, so this ships disabled —
 * every photo is currently allowed through unfiltered, same as before this
 * feature existed. Nothing TensorFlow-related loads while it's off. Flip
 * NSFW_FILTER_ENABLED=true once you've resolved the memory situation.
 *
 * Runs INSIDE server.js (not a separate process) — image classification is
 * fast enough on the small MobileNetV2 model that a socket round-trip can
 * just `await` it before relaying a photo.
 *
 * Powered by NSFWJS (https://github.com/infinitered/nsfwjs) on top of
 * @tensorflow/tfjs-node. Both are MIT-licensed, run entirely on your own
 * server, and make zero network calls per image — there's no API key, no
 * per-request cost, and no rate limit other than your own CPU. The model
 * itself ships inside the `nsfwjs` package, so nsfw.load() reads it off
 * disk from node_modules; it doesn't fetch anything over the network.
 *
 * WHERE THIS IS WIRED IN — server.js already has this fully integrated
 * (not a patch you need to apply yourself): it requires this file, and
 * both the "photo" and "friendChat:photo" handlers await
 * checkImageDataUrl(dataUrl) before relaying, emitting NSFW_REJECT_MESSAGE
 * back to the SENDER ONLY on a block — never to the recipient, and never
 * as a ban/block/disconnect. That product decision (silently drop +
 * notify sender, nothing else) is on purpose: NSFW classifiers do have
 * false positives, and a single auto-ban on a false positive is worse
 * than an occasional missed block.
 *
 * TUNING: the three thresholds below are the only numbers you should
 * need to touch. If real traffic shows too many false positives (e.g.
 * beach photos, workout selfies), raise them. If obvious nudity is
 * slipping through, lower them. There's no single "correct" number —
 * NSFWJS itself documents ~90-93% accuracy, not 100%.
 *
 * MEMORY: loading the model and running tfjs-node's native TensorFlow
 * runtime costs real RAM — in practice, comfortably north of 150-250MB on
 * top of whatever your app already uses, even before any photo is checked.
 * On a ~512MB instance that's tight enough to OOM-crash the whole server,
 * not just the photo filter. If that happens:
 *   - The most reliable fix is more RAM (Render: bump the instance's plan).
 *   - server.js intentionally does NOT preload the model at boot anymore —
 *     it lazy-loads on the first real photo instead, so a memory-starved
 *     instance at least boots and serves everything else (auth, chat,
 *     friends, games) rather than crash-looping before anyone connects.
 *   - A hard V8 "heap out of memory" crash can't be caught in JS (unlike
 *     ordinary errors, which checkImageDataUrl already fails open on) — so
 *     if the instance truly doesn't have enough RAM, this feature isn't
 *     usable there until it does, no matter where in the code loading is
 *     triggered from.
 */

"use strict";

// ── Kill switch ──────────────────────────────────────────────────────────
// OFF unless you explicitly turn it on (Render → Environment →
// NSFW_FILTER_ENABLED=true). While off, this module never requires
// @tensorflow/tfjs-node or nsfwjs at all — not "loads them but skips using
// them", genuinely never touches them — so a disabled filter costs zero
// extra RAM. Turn this on only once you've confirmed the instance has
// enough memory to run tfjs-node (see the MEMORY note above); on a box
// that can't, leaving this off is what keeps the rest of the app up.
const NSFW_FILTER_ENABLED = process.env.NSFW_FILTER_ENABLED === "true";

// ── The message shown to the SENDER when a photo is blocked ────────────────
const NSFW_REJECT_MESSAGE = "ფოტო არ აკმაყოფილებს დადგენილ მოთხოვნებს და მისი გაგზავნა დაუშვებელია.";

// ── Thresholds ───────────────────────────────────────────────────────────
// NSFWJS always returns all 5 classes (Neutral, Drawing, Hentai, Sexy, Porn)
// with probabilities that sum to ~1. "Sexy" alone (swimwear/lingerie-style
// images) is deliberately NOT enough on its own to block — only counted at
// half-weight toward the combined score — so a beach photo doesn't get
// treated the same as actual nudity.
const NSFW_PORN_THRESHOLD     = 0.75; // block if Porn alone   >= this
const NSFW_HENTAI_THRESHOLD   = 0.75; // block if Hentai alone >= this
const NSFW_COMBINED_THRESHOLD = 0.85; // block if Porn + Hentai + 0.5×Sexy >= this

// ── Model loading (once, lazily, cached) ────────────────────────────────────
let modelPromise = null;

function getModel() {
  if (!modelPromise) {
    // Required in here, not at module top-level, on purpose: this line
    // never runs at all while NSFW_FILTER_ENABLED is false.
    const tf   = require("@tensorflow/tfjs-node");
    const nsfw = require("nsfwjs");
    modelPromise = nsfw.load().then((model) => ({ tf, model }));
  }
  return modelPromise;
}

// Call once at server startup so the model is warm before the first real
// photo arrives (loading takes a second or two; without this, whichever
// user sends the very first photo eats that delay). Not calling this is
// still safe — getModel() lazy-loads on first use either way. Not used by
// server.js right now — see the MEMORY note above for why.
async function initNsfwModel() {
  if (!NSFW_FILTER_ENABLED) return;
  try {
    await getModel();
    console.log("[NSFW] Model loaded — photo filter is active.");
  } catch (e) {
    console.error("[NSFW] Failed to load model — photo filter will retry lazily on first use:", e.message);
  }
}

function dataUrlToBuffer(dataUrl) {
  const comma = dataUrl.indexOf(",");
  if (comma === -1) return null;
  try {
    return Buffer.from(dataUrl.slice(comma + 1), "base64");
  } catch {
    return null;
  }
}

/**
 * Classifies a `data:image/...;base64,...` string.
 * Returns { blocked, predictions, error }.
 *   - predictions is { Neutral, Drawing, Hentai, Sexy, Porn } (0..1 each),
 *     or null if the image couldn't be decoded/classified.
 *   - On ANY failure (bad image data, decode error, model error) this
 *     FAILS OPEN — blocked:false — so a technical hiccup in the checker
 *     never itself becomes an extra way to reject someone's legitimate
 *     photo. Failures are logged server-side so you can notice if they
 *     start happening often (e.g. an image format decodeImage can't read).
 *     Flip the `catch` block below to return blocked:true if you'd rather
 *     fail closed instead.
 */
async function checkImageDataUrl(dataUrl) {
  if (!NSFW_FILTER_ENABLED) return { blocked: false, predictions: null, disabled: true };

  let image = null;
  try {
    const buffer = dataUrlToBuffer(dataUrl);
    if (!buffer || buffer.length === 0) return { blocked: false, predictions: null, error: true };

    const { tf, model } = await getModel();
    // channels=3 (RGB) — classify() expects a [h, w, 3] tensor; some PNGs
    // decode with an alpha channel otherwise, which throws a shape error.
    image = tf.node.decodeImage(buffer, 3);
    const raw = await model.classify(image);

    const predictions = {};
    for (const { className, probability } of raw) predictions[className] = probability;

    const combined =
      (predictions.Porn   || 0) +
      (predictions.Hentai || 0) +
      0.5 * (predictions.Sexy || 0);

    const blocked =
      (predictions.Porn   || 0) >= NSFW_PORN_THRESHOLD   ||
      (predictions.Hentai || 0) >= NSFW_HENTAI_THRESHOLD ||
      combined >= NSFW_COMBINED_THRESHOLD;

    return { blocked, predictions, error: false };
  } catch (e) {
    console.error("[NSFW] Check failed, allowing the photo through:", e.message);
    return { blocked: false, predictions: null, error: true };
  } finally {
    // Tensor memory is NOT garbage-collected by V8 — must dispose explicitly
    // or long-running processes leak memory one photo at a time.
    if (image) image.dispose();
  }
}

module.exports = { initNsfwModel, checkImageDataUrl, NSFW_REJECT_MESSAGE };
