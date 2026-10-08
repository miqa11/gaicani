/* ── 📷 View-once photos — shared by random chat and private chat ──────────────
   Sender:   choose()  → "send a photo?" → the gallery → the picked photo is
             shrunk (upright, ≤1600px, JPEG — which also drops hidden details
             like where it was taken) and shown with "send" / "cancel".
   Receiver: card()    → "X is sending you a photo — see it?" → yes → blurred
             → tap → full screen for 10 seconds (counting down) → gone.
   Before the preview, the photo is checked for nudity on the phone itself
   (NSFWJS — free, open source, served from this site, nothing sent
   anywhere); a nude or explicit photo can't be sent.
   Pages talk to their own server; this file only does the screens. */
(function () {
  "use strict";
  const SECONDS = 10;
  const CSS = `
.vo-back{position:fixed;inset:0;z-index:2147483000;background:rgba(8,6,20,.78);display:flex;align-items:center;justify-content:center;padding:16px;
  -webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);font-family:inherit}
.vo-box{width:100%;max-width:360px;background:#211b3f;border:1px solid rgba(214,168,79,.28);border-radius:18px;padding:18px;color:#f3eeff;
  box-shadow:0 20px 60px rgba(0,0,0,.55);text-align:center}
.vo-box h3{margin:0 0 6px;font-size:1.05em}
.vo-box p{margin:0 0 14px;font-size:.84em;line-height:1.5;color:#b7aed6}
.vo-box img{display:block;max-width:100%;max-height:52vh;margin:0 auto 12px;border-radius:12px;object-fit:contain}
.vo-btns{display:flex;gap:10px}
.vo-spin{width:34px;height:34px;margin:4px auto 12px;border-radius:50%;border:3px solid rgba(255,255,255,.18);border-top-color:#a58bff;animation:voSpin .8s linear infinite}
@keyframes voSpin{to{transform:rotate(360deg)}}
.vo-btns button{flex:1;border:none;border-radius:12px;padding:12px;font:inherit;font-weight:700;font-size:.92em;cursor:pointer}
.vo-no{background:rgba(255,255,255,.1);color:#f3eeff}
.vo-yes{background:linear-gradient(135deg,#7c5cff,#5865f2);color:#fff}
.vo-card{display:flex;flex-direction:column;align-items:center;gap:8px;max-width:280px;padding:12px;border-radius:16px;
  background:rgba(124,92,255,.12);border:1px solid rgba(124,92,255,.35);color:inherit;text-align:center;font-size:.9em;line-height:1.45}
.vo-card .vo-btns{width:100%}
.vo-card .vo-btns button{padding:9px;font-size:.86em}
.vo-thumb{position:relative;width:220px;max-width:100%;height:165px;border-radius:12px;overflow:hidden;cursor:pointer;background:#000}
.vo-thumb img{width:100%;height:100%;object-fit:cover;filter:blur(24px);transform:scale(1.15);pointer-events:none}
.vo-thumb span{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;color:#fff;
  font-weight:700;font-size:.86em;text-shadow:0 1px 6px rgba(0,0,0,.7)}
.vo-thumb span b{font-size:1.8em}
.vo-muted{opacity:.75;font-size:.85em}
.vo-view{position:fixed;inset:0;z-index:2147483100;background:#000;display:flex;align-items:center;justify-content:center;
  -webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
.vo-view img{max-width:100vw;max-height:100vh;object-fit:contain;pointer-events:none;-webkit-user-drag:none}
.vo-count{position:absolute;top:calc(14px + env(safe-area-inset-top,0px));right:14px;width:46px;height:46px;border-radius:50%;
  border:3px solid rgba(255,255,255,.85);color:#fff;display:flex;align-items:center;justify-content:center;font:700 1.15em/1 system-ui,sans-serif;background:rgba(0,0,0,.35)}
.vo-close-hint{position:absolute;bottom:calc(18px + env(safe-area-inset-bottom,0px));left:0;right:0;text-align:center;color:rgba(255,255,255,.7);font:600 .82em system-ui,sans-serif}`;
  function css() {
    if (document.getElementById("voCss")) return;
    const s = document.createElement("style"); s.id = "voCss"; s.textContent = CSS; document.head.appendChild(s);
  }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  // A small dialog: title, text, optional picture, and two buttons. onYes
  // runs inside the tap itself (phones only open the gallery from a tap).
  function dialog({ title, text, img, no, yes, onYes }) {
    css();
    return new Promise((resolve) => {
      const back = el("div", "vo-back"), box = el("div", "vo-box");
      box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true");
      box.appendChild(el("h3", null, title));
      if (img) { const i = el("img"); i.src = img; i.alt = ""; box.appendChild(i); }
      if (text) box.appendChild(el("p", null, text));
      const btns = el("div", "vo-btns"), bNo = el("button", "vo-no", no), bYes = el("button", "vo-yes", yes);
      bNo.type = bYes.type = "button";
      if (no) btns.appendChild(bNo);
      btns.appendChild(bYes); box.appendChild(btns); back.appendChild(box); document.body.appendChild(back);
      const done = (v) => { back.remove(); resolve(v); };
      bNo.onclick = () => done(false);
      bYes.onclick = () => { if (onYes) onYes(); done(true); };
      back.onclick = (e) => { if (e.target === back) done(false); };
    });
  }

  async function shrink(file, max = 1600, quality = 0.82) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const w0 = img.naturalWidth, h0 = img.naturalHeight;
      if (!w0 || !h0) throw new Error("empty");
      const k = Math.min(1, max / Math.max(w0, h0));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(w0 * k)); c.height = Math.max(1, Math.round(h0 * k));
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", quality));
      if (!blob) throw new Error("encode");
      return blob;
    } finally { URL.revokeObjectURL(url); }
  }

  // ── 🔞 Nudity check on this phone (NSFWJS, MobileNetV2 — about 90% right).
  // Loaded the first time someone opens the photo flow (~5 MB, then cached).
  let nsfwModel = null;
  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  }
  function nsfwReady() {
    if (!nsfwModel) {
      nsfwModel = (async () => {
        if (!window.nsfwjs) await loadScript("/nsfw/nsfwjs.min.js");
        return window.nsfwjs.load("/nsfw/model/model.json");
      })();
      nsfwModel.catch(() => { nsfwModel = null; }); // a failed download can be tried again
    }
    return nsfwModel;
  }
  // → true when it looks nude / explicit. Throws if the check can't run.
  async function looksNude(blob) {
    const model = await nsfwReady();
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const p = {};
      for (const x of await model.classify(img)) p[x.className] = x.probability;
      return (p.Porn || 0) + (p.Hentai || 0) >= 0.5 || (p.Sexy || 0) >= 0.85;
    } finally { URL.revokeObjectURL(url); }
  }
  function busy(text) {
    css();
    const back = el("div", "vo-back"), box = el("div", "vo-box");
    box.append(el("div", "vo-spin"), el("p", null, text));
    back.appendChild(box); document.body.appendChild(back);
    return () => back.remove();
  }

  // Sender: ask → gallery → shrink → nudity check → preview. → { blob } | { error } | null (cancelled)
  function choose(opts = {}) {
    css();
    nsfwReady().catch(() => {}); // start downloading the check while they pick
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file"; input.accept = "image/*"; input.style.display = "none";
      document.body.appendChild(input);
      input.addEventListener("change", async () => {
        const file = input.files && input.files[0];
        input.remove();
        if (!file) return resolve(null);
        if (file.type && !file.type.startsWith("image/")) return resolve({ error: "მხოლოდ სურათის ფაილებია დაშვებული" });
        if (file.size > 25 * 1024 * 1024) return resolve({ error: "ფოტო ზედმეტად დიდია" });
        let blob;
        try { blob = await shrink(file); } catch (_) { return resolve({ error: "ეს ფოტო ვერ გაიხსნა — სცადე JPG ან PNG" }); }
        const done = busy("🔍 ფოტოს ვამოწმებ…");
        let nude;
        try { nude = await looksNude(blob); } catch (_) { nude = null; } finally { done(); }
        if (nude === null) return resolve({ error: "ფოტოს შემოწმება ვერ მოხერხდა — შეამოწმე ინტერნეტი და სცადე თავიდან" });
        if (nude) {
          await dialog({ title: "🚫 ამ ფოტოს ვერ გაგზავნი",
            text: "როგორც ჩანს, ფოტოზე შიშველი ან უხამსი შინაარსია. ასეთი ფოტოების გაგზავნა აკრძალულია.",
            no: null, yes: "გასაგებია" });
          return resolve(null);
        }
        const url = URL.createObjectURL(blob);
        const ok = await dialog({ title: "📷 გაგზავნა?", img: url,
          text: `${opts.to ? opts.to + " " : ""}ჯერ დაგეთანხმება, შემდეგ ნახავს ${SECONDS} წამით — მერე ფოტო გაქრება.`,
          no: "გაუქმება", yes: "📤 გაგზავნა" });
        URL.revokeObjectURL(url);
        resolve(ok ? { blob } : null);
      });
      const p = dialog({ title: "📷 გსურს ფოტოს გაგზავნა?",
        text: `ფოტო ერთჯერადია: ${opts.to || "თანამოსაუბრე"} ჯერ დაგეთანხმება, ნახავს ${SECONDS} წამით და მერე ის გაქრება.`,
        no: "არა", yes: "📷 ფოტოს არჩევა", onYes: () => input.click() });
      p.then((yes) => { if (!yes) { input.remove(); resolve(null); } });
    });
  }

  // Full screen for SECONDS (or until tapped). → Promise when closed.
  function show(url) {
    css();
    return new Promise((resolve) => {
      const v = el("div", "vo-view"), img = el("img"), count = el("div", "vo-count", String(SECONDS));
      img.src = url; img.alt = ""; img.draggable = false;
      v.append(img, count, el("div", "vo-close-hint", "ერთჯერადი ფოტო — შეხებით დახურვა"));
      v.addEventListener("contextmenu", (e) => e.preventDefault());
      document.body.appendChild(v);
      let left = SECONDS;
      const t = setInterval(() => { left--; count.textContent = String(left); if (left <= 0) close(); }, 1000);
      function close() { clearInterval(t); v.remove(); resolve(); }
      v.addEventListener("click", close);
    });
  }

  // Receiver's card in the chat. handlers: { from, onAnswer(accept) → Promise<url|null>, onViewed() }
  function card({ from, onAnswer, onViewed }) {
    css();
    const c = el("div", "vo-card");
    const ask = () => {
      c.replaceChildren(el("div", null, `📷 ${from} გიგზავნის ფოტოს. გსურს ნახვა?`), el("div", "vo-muted", `ნახავ ${SECONDS} წამით, მერე გაქრება`));
      const btns = el("div", "vo-btns"), bNo = el("button", "vo-no", "✖ არა"), bYes = el("button", "vo-yes", "👁 ნახვა");
      bNo.type = bYes.type = "button";
      btns.append(bNo, bYes); c.appendChild(btns);
      bNo.onclick = (e) => { e.stopPropagation(); setText("🚫 ფოტოზე უარი თქვი"); onAnswer(false); };
      bYes.onclick = async (e) => {
        e.stopPropagation();
        setText("⏳ იტვირთება…");
        const url = await onAnswer(true);
        if (url) ready(url); else setText("⚠️ ფოტო ვეღარ ჩაიტვირთა");
      };
    };
    const ready = (url) => {
      const th = el("div", "vo-thumb"), i = el("img"), lab = el("span");
      i.src = url; i.alt = ""; i.draggable = false;
      lab.append(el("b", null, "👁"), el("div", null, `შეხე — ${SECONDS} წამით`));
      th.append(i, lab);
      c.replaceChildren(th);
      th.onclick = async (e) => {
        e.stopPropagation();
        th.onclick = null;
        await show(url);
        try { URL.revokeObjectURL(url); } catch (_) {}
        setText("📷 ფოტო ნანახია — გაქრა");
        if (onViewed) onViewed();
      };
    };
    const setText = (t) => c.replaceChildren(el("div", "vo-muted", t));
    ask();
    return { el: c, setText, ready };
  }

  window.GaicaniViewOnce = { choose, show, card, shrink, SECONDS };
})();
