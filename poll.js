// ── Poll: "would you pay 5₾/month to remove ads?" ─────────────────────────
// Shown once per IP (the server decides — see /api/poll/ads5 in server.js).
// Results are visible to the admin only; this page never receives them.
//
// Waits until nothing else is blocking the screen (the front page's name
// popup, the dashboard's loading screen) so two popups never stack. If the
// visitor leaves before it ever appears, it isn't marked as seen and they'll
// get it on their next visit.
(function () {
  if (window.__gaicaniPollStarted) return;
  window.__gaicaniPollStarted = true;

  const QUESTION = "გადაიხდიდით თუ არა 5 ლარს თვიურად რეკლამების გასათიშად?";
  const BLOCKERS = ["nameModal", "loading-screen"];
  const CHECK_EVERY_MS = 700;
  const GIVE_UP_AFTER_MS = 3 * 60 * 1000;

  function isShowing(el) {
    if (!el) return false;
    const cs = window.getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden";
  }
  function screenIsClear() {
    return !BLOCKERS.some(id => isShowing(document.getElementById(id)));
  }

  function injectStyles() {
    if (document.getElementById("gcPollStyles")) return;
    const st = document.createElement("style");
    st.id = "gcPollStyles";
    st.textContent = `
      #gcPoll { position:fixed; inset:0; z-index:100000; display:flex; align-items:center; justify-content:center;
        padding:20px; background:rgba(0,0,0,.55); animation:gcPollIn .2s ease; }
      #gcPoll .gcp-card { position:relative; width:100%; max-width:340px; background:#2b2d31; color:#dcddde;
        border:1px solid rgba(255,255,255,.08); border-radius:16px; padding:22px 18px 18px; text-align:center;
        box-shadow:0 18px 50px rgba(0,0,0,.5); font-family:inherit; }
      #gcPoll .gcp-tag { font-size:.74em; font-weight:800; color:#8b93ff; letter-spacing:.03em; margin-bottom:8px; }
      #gcPoll .gcp-q { font-size:1.02em; font-weight:700; color:#fff; line-height:1.5; margin-bottom:18px; }
      #gcPoll .gcp-btns { display:flex; gap:10px; }
      #gcPoll .gcp-btn { flex:1; min-height:48px; border:none; border-radius:12px; font-size:16px; font-weight:800;
        cursor:pointer; color:#fff; -webkit-tap-highlight-color:transparent; }
      #gcPoll .gcp-yes { background:linear-gradient(135deg,#3ba55d,#2d8a4e); }
      #gcPoll .gcp-no  { background:linear-gradient(135deg,#f23f42,#c0393b); }
      #gcPoll .gcp-btn:disabled { opacity:.6; cursor:default; }
      #gcPoll .gcp-close { position:absolute; top:8px; right:10px; width:34px; height:34px; border:none;
        background:transparent; color:#96989d; font-size:1.2em; cursor:pointer; border-radius:8px; }
      #gcPoll .gcp-thanks { font-size:1.05em; font-weight:700; color:#fff; padding:14px 0 6px; }
      @keyframes gcPollIn { from { opacity:0 } to { opacity:1 } }
    `;
    document.head.appendChild(st);
  }

  function close() {
    const el = document.getElementById("gcPoll");
    if (el) el.remove();
  }

  function show() {
    injectStyles();
    const wrap = document.createElement("div");
    wrap.id = "gcPoll";
    wrap.innerHTML =
      '<div class="gcp-card" role="dialog" aria-modal="true" aria-label="გამოკითხვა">' +
        '<button class="gcp-close" type="button" aria-label="დახურვა">✕</button>' +
        '<div class="gcp-tag">📊 მოკლე გამოკითხვა</div>' +
        '<div class="gcp-q"></div>' +
        '<div class="gcp-btns">' +
          '<button class="gcp-btn gcp-yes" type="button">✅ კი</button>' +
          '<button class="gcp-btn gcp-no" type="button">❌ არა</button>' +
        '</div>' +
      '</div>';
    wrap.querySelector(".gcp-q").textContent = QUESTION;
    document.body.appendChild(wrap);

    // It's on screen now — this IP won't be shown it again, even if closed.
    fetch("/api/poll/ads5/seen", { method: "POST" }).catch(() => {});

    wrap.querySelector(".gcp-close").addEventListener("click", close);
    wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });

    const vote = (answer) => {
      wrap.querySelectorAll(".gcp-btn").forEach(b => { b.disabled = true; });
      fetch("/api/poll/ads5/vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer }),
      }).catch(() => {}).finally(() => {
        const card = wrap.querySelector(".gcp-card");
        card.innerHTML = '<div class="gcp-thanks">მადლობა პასუხისთვის! 🙏</div>';
        setTimeout(close, 1500);
      });
    };
    wrap.querySelector(".gcp-yes").addEventListener("click", () => vote("yes"));
    wrap.querySelector(".gcp-no").addEventListener("click", () => vote("no"));
  }

  async function start() {
    let shouldShow = false;
    try {
      const r = await fetch("/api/poll/ads5", { cache: "no-store" });
      shouldShow = !!(await r.json()).show;
    } catch (_) { return; }
    if (!shouldShow) return;

    const startedAt = Date.now();
    const tick = () => {
      if (screenIsClear()) { setTimeout(show, 600); return; }
      if (Date.now() - startedAt > GIVE_UP_AFTER_MS) return; // try again next visit
      setTimeout(tick, CHECK_EVERY_MS);
    };
    tick();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
