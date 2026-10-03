// ── 🔔 Notifications bell (registered accounts) ─────────────────────────────
// Facebook-style: a bell with a red counter of everything new since you last
// opened it, and a dropdown with the saved history (friend requests, accepted
// requests, private messages, Trinder likes/matches, game invites). Opening
// the panel clears the counter; each item stays highlighted until clicked.
// History and read state live on the server (see "Notifications" in
// server.js), so they follow the account across tabs and devices.
//
// Usage on any page, once the socket has authenticated a REGISTERED account:
//   <button id="notifBell" hidden>…</button>   (see dashboard.html)
//   GaicaniNotif.attach(socket);
// Calling attach() again (e.g. after a reconnect) only re-syncs the counter.
(function () {
  "use strict";

  const GAME_LABEL = {
    drawGuess: "დახატე-და-გამოიცანიში", poker: "პოკერზე", chess: "ჭადრაკზე",
    checkers: "დამაზე", joker: "ჯოკერზე", imposter: "იმპოსტორზე", blackjack: "ბლექჯეკზე",
  };
  const GAME_ICON = {
    drawGuess: "🎨", poker: "🃏", chess: "♟️", checkers: "⚪",
    joker: "🃏", imposter: "🕵️", blackjack: "🂡",
  };
  const TYPE_ICON = {
    friend_request: ["👥", "#4f6cff"], friend_accept: ["✅", "#1fc18a"],
    message: ["💬", "#4f6cff"], trinder_like: ["💗", "#e33b5f"],
    trinder_match: ["💞", "#e33b5f"], game_invite: ["🎮", "#9d5cff"],
  };

  const CSS = `
.notif-bell { position:relative; width:38px; height:38px; flex-shrink:0; border-radius:50%;
  display:grid; place-items:center; padding:0; cursor:pointer; color:var(--text,#f5f0ff);
  background:rgba(255,255,255,.07); border:1px solid var(--border-2,rgba(214,168,79,.28));
  transition:background .15s, border-color .15s, color .15s; }
.notif-bell[hidden] { display:none; }
.notif-bell:hover { background:rgba(255,255,255,.12); }
.notif-bell[aria-expanded="true"] { background:rgba(79,108,255,.22); border-color:rgba(79,108,255,.6); color:var(--accent-lt,#93a4ff); }
.notif-bell:focus-visible { outline:2px solid var(--gold,#d6a84f); outline-offset:2px; }
.notif-bell svg { width:20px; height:20px; display:block; }
.notif-badge { position:absolute; top:-5px; right:-6px; min-width:19px; height:19px; padding:0 5px;
  border-radius:10px; background:#e33b5f; color:#fff; font-size:11px; font-weight:800; line-height:19px;
  text-align:center; box-shadow:0 0 0 2px #130f26; font-variant-numeric:tabular-nums; pointer-events:none; }
.notif-badge[hidden] { display:none; }
.notif-badge.pop { animation:notifPop .35s ease-out; }
@keyframes notifPop { 0% { transform:scale(.4); } 70% { transform:scale(1.18); } 100% { transform:scale(1); } }

.notif-panel { position:fixed; z-index:1000; width:380px; max-width:calc(100vw - 16px);
  max-height:min(72vh, 600px); display:flex; flex-direction:column; overflow:hidden;
  background:linear-gradient(180deg,#261f49,#1c1735); color:var(--text,#f5f0ff);
  border:1px solid rgba(214,168,79,.32); border-radius:18px;
  box-shadow:0 24px 60px -18px rgba(0,0,0,.75), 0 0 0 1px rgba(0,0,0,.2); }
.notif-panel[hidden] { display:none; }
.notif-head { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:14px 16px 6px; }
.notif-title { margin:0; font-size:1.18em; font-weight:800; }
.notif-readall { background:none; border:none; padding:6px 8px; margin-right:-8px; border-radius:8px; cursor:pointer;
  color:var(--accent-lt,#93a4ff); font:inherit; font-size:.8em; font-weight:700; }
.notif-readall:hover:not(:disabled) { background:rgba(79,108,255,.14); }
.notif-readall:disabled { color:var(--muted,#958db6); opacity:.6; cursor:default; }
.notif-filters { display:flex; gap:6px; padding:4px 16px 10px; }
.notif-filter { border:none; border-radius:999px; padding:6px 13px; cursor:pointer; font:inherit; font-size:.84em; font-weight:700;
  background:transparent; color:var(--text-dim,#d2cbec); }
.notif-filter:hover { background:rgba(255,255,255,.07); }
.notif-filter.on { background:rgba(79,108,255,.22); color:var(--accent-lt,#93a4ff); }
.notif-list { overflow-y:auto; overscroll-behavior:contain; padding:0 8px 8px; }
.notif-item { display:flex; align-items:center; gap:12px; padding:9px 8px; border-radius:12px;
  color:inherit; text-decoration:none; cursor:pointer; }
.notif-item:hover { background:rgba(255,255,255,.06); }
.notif-item:focus-visible { outline:2px solid var(--gold,#d6a84f); outline-offset:-2px; }
.notif-item.unread { background:rgba(79,108,255,.10); }
.notif-item.unread:hover { background:rgba(79,108,255,.16); }
.notif-av { position:relative; width:52px; height:52px; flex-shrink:0; }
.notif-av-img { width:52px; height:52px; border-radius:50%; object-fit:cover; display:grid; place-items:center;
  background:linear-gradient(135deg,#4f6cff,#9d5cff); color:#fff; font-weight:800; font-size:1.3em; }
.notif-av-img.heart { background:linear-gradient(135deg,#ff6f96,#e33b5f 50%,#7c3aed); font-size:1.5em; }
.notif-type { position:absolute; right:-3px; bottom:-3px; width:24px; height:24px; border-radius:50%;
  display:grid; place-items:center; font-size:12px; line-height:1; box-shadow:0 0 0 2px #221b40; }
.notif-body { flex:1; min-width:0; font-size:.9em; line-height:1.38; }
.notif-text { color:var(--text-dim,#d2cbec); overflow-wrap:anywhere; }
.notif-text b { color:var(--text,#f5f0ff); font-weight:800; }
.notif-item.unread .notif-text { color:var(--text,#f5f0ff); }
.notif-time { margin-top:3px; font-size:.82em; color:var(--muted,#958db6); }
.notif-item.unread .notif-time { color:var(--accent-lt,#93a4ff); font-weight:700; }
.notif-dot { width:11px; height:11px; border-radius:50%; background:var(--accent,#4f6cff); flex-shrink:0; }
.notif-empty { padding:34px 16px 40px; text-align:center; color:var(--muted,#958db6); font-size:.9em; }
.notif-empty-icon { font-size:2.2em; margin-bottom:8px; opacity:.8; }
@media (prefers-reduced-motion: reduce) { .notif-badge.pop { animation:none; } }
`;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g,
      c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function ago(ts) {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return "ახლახან";
    const m = Math.floor(s / 60);
    if (m < 60) return m + " წუთის წინ";
    const h = Math.floor(m / 60);
    if (h < 24) return h + " საათის წინ";
    const d = Math.floor(h / 24);
    if (d < 7) return d + " დღის წინ";
    return Math.floor(d / 7) + " კვირის წინ";
  }

  function textFor(n) {
    const who = "<b>" + esc(n.from || "") + "</b>";
    const count = n.count || 1;
    switch (n.type) {
      case "friend_request": return who + "-მ გამოგიგზავნა მეგობრობის მოთხოვნა";
      case "friend_accept":  return who + "-მ მიიღო შენი მეგობრობის მოთხოვნა";
      case "message":
        if (count > 1) return who + "-მ მოგწერა <b>" + count + "</b> შეტყობინება";
        if (n.kind === "photo") return who + "-მ გამოგიგზავნა ფოტო 📷";
        if (n.kind === "gif") return who + "-მ გამოგიგზავნა GIF";
        if (n.kind === "sticker") return who + "-მ გამოგიგზავნა სტიკერი 🥟";
        if (n.kind === "voice") return who + "-მ გამოგიგზავნა ხმოვანი შეტყობინება 🎤";
        return who + "-მ მოგწერა";
      case "trinder_like":
        return count > 1 ? "<b>" + count + "</b> ადამიანს მოეწონე Trinder-ზე" : "ვიღაცას მოეწონე Trinder-ზე — ნახე ვინ";
      case "trinder_match": return "ახალი მატჩი Trinder-ზე: <b>" + esc(n.name || n.from || "") + "</b> — მიწერე!";
      case "game_invite":    return who + "-მა მოგიწვია " + esc(GAME_LABEL[n.game] || "თამაშზე");
      default:               return "ახალი შეტყობინება";
    }
  }

  function itemHTML(n) {
    let av;
    if (n.type === "trinder_like") av = '<div class="notif-av-img heart" aria-hidden="true">💗</div>';
    else if (n.avatar) av = '<img class="notif-av-img" src="/' + esc(n.avatar) + '" alt="" loading="lazy" />';
    else av = '<div class="notif-av-img" aria-hidden="true">' + esc((n.from || "?").charAt(0).toUpperCase()) + "</div>";
    const [icon, color] = n.type === "game_invite"
      ? [GAME_ICON[n.game] || "🎮", TYPE_ICON.game_invite[1]]
      : (TYPE_ICON[n.type] || ["🔔", "#4f6cff"]);
    return '<a class="notif-item' + (n.read ? "" : " unread") + '" href="' + esc(safeLink(n.link) || "#") + '" data-id="' + esc(n.id) + '">' +
      '<div class="notif-av">' + av + '<span class="notif-type" style="background:' + color + '" aria-hidden="true">' + icon + "</span></div>" +
      '<div class="notif-body"><div class="notif-text">' + textFor(n) + "</div>" +
      '<div class="notif-time">' + esc(ago(n.ts)) + "</div></div>" +
      (n.read ? "" : '<span class="notif-dot" aria-label="წაუკითხავი"></span>') +
      "</a>";
  }

  // Links are generated by the server, but only ever follow same-site paths.
  function safeLink(link) {
    return typeof link === "string" && link.charAt(0) === "/" && link.charAt(1) !== "/" && link.charAt(1) !== "\\" ? link : null;
  }

  let socket = null, bell = null, badge = null, panel = null, listEl = null, readAllBtn = null;
  let items = [], unseen = 0, filter = "all", open = false;
  const baseTitle = document.title;

  function setUnseen(n) {
    const grew = n > unseen;
    unseen = Math.max(0, n | 0);
    if (!badge) return;
    badge.textContent = unseen > 99 ? "99+" : String(unseen);
    badge.hidden = unseen === 0;
    if (grew && unseen > 0) { badge.classList.remove("pop"); void badge.offsetWidth; badge.classList.add("pop"); }
    bell.setAttribute("aria-label", unseen ? "შეტყობინებები — " + unseen + " ახალი" : "შეტყობინებები");
    document.title = (unseen ? "(" + (unseen > 99 ? "99+" : unseen) + ") " : "") + baseTitle;
  }

  function render() {
    if (!listEl) return;
    const shown = filter === "unread" ? items.filter(n => !n.read) : items;
    readAllBtn.disabled = !items.some(n => !n.read);
    if (!shown.length) {
      listEl.innerHTML = '<div class="notif-empty"><div class="notif-empty-icon">🔔</div>' +
        (filter === "unread" ? "წაუკითხავი შეტყობინება არ გაქვს" : "შეტყობინებები ჯერ არ გაქვს") + "</div>";
      return;
    }
    listEl.innerHTML = shown.map(itemHTML).join("");
  }

  function refresh() {
    if (!socket) return;
    socket.emit("notif:list", null, (d) => {
      if (!d) return;
      items = Array.isArray(d.items) ? d.items : [];
      if (open) {
        // Opening the panel is what "seeing" them means — the counter resets.
        if (d.unseen > 0) socket.emit("notif:seen");
        setUnseen(0);
        render();
      } else {
        setUnseen(d.unseen || 0);
      }
    });
  }

  // Right-aligned under the bell, but never past either edge of the screen.
  function place() {
    const r = bell.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const w = panel.offsetWidth;
    panel.style.top = Math.round(r.bottom + 8) + "px";
    panel.style.left = Math.round(Math.min(Math.max(8, r.right - w), vw - w - 8)) + "px";
  }

  function openPanel() {
    open = true;
    panel.hidden = false;
    bell.setAttribute("aria-expanded", "true");
    place();
    setUnseen(0);
    render();
    refresh();
  }
  function closePanel(returnFocus) {
    if (!open) return;
    open = false;
    panel.hidden = true;
    bell.setAttribute("aria-expanded", "false");
    if (returnFocus) bell.focus();
  }

  function buildPanel() {
    if (!document.getElementById("notifCss")) {
      const st = document.createElement("style");
      st.id = "notifCss"; st.textContent = CSS;
      document.head.appendChild(st);
    }
    panel = document.createElement("div");
    panel.className = "notif-panel";
    panel.id = "notifPanel";
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "შეტყობინებები");
    panel.innerHTML =
      '<div class="notif-head"><h2 class="notif-title">შეტყობინებები</h2>' +
      '<button type="button" class="notif-readall">✓ ყველა წაკითხულად</button></div>' +
      '<div class="notif-filters" role="tablist">' +
      '<button type="button" class="notif-filter on" data-f="all" role="tab" aria-selected="true">ყველა</button>' +
      '<button type="button" class="notif-filter" data-f="unread" role="tab" aria-selected="false">წაუკითხავი</button></div>' +
      '<div class="notif-list"></div>';
    document.body.appendChild(panel);
    listEl = panel.querySelector(".notif-list");
    readAllBtn = panel.querySelector(".notif-readall");

    readAllBtn.addEventListener("click", () => {
      items.forEach(n => { n.read = true; });
      socket.emit("notif:readAll");
      render();
    });
    panel.querySelectorAll(".notif-filter").forEach(b => b.addEventListener("click", () => {
      filter = b.dataset.f;
      panel.querySelectorAll(".notif-filter").forEach(x => {
        x.classList.toggle("on", x === b);
        x.setAttribute("aria-selected", String(x === b));
      });
      render();
    }));
    listEl.addEventListener("click", (e) => {
      const a = e.target.closest(".notif-item");
      if (!a) return;
      e.preventDefault();
      const n = items.find(x => x.id === a.dataset.id);
      if (!n) return;
      if (!n.read) { n.read = true; socket.emit("notif:read", { id: n.id }); }
      const link = safeLink(n.link);
      if (!link) { render(); return; }
      // A section on this same page (e.g. pending friend requests on the
      // dashboard) — scroll to it instead of reloading.
      const [p, hash] = link.split("#");
      if (hash && p === location.pathname) {
        closePanel(false);
        // Changing the hash lets a page with screens (the dashboard) switch to
        // the one holding that section before we scroll to it.
        if (location.hash !== "#" + hash) location.hash = hash;
        setTimeout(() => {
          const target = document.getElementById(hash);
          if (target && target.offsetParent !== null) target.scrollIntoView({ behavior: "smooth", block: "start" });
        }, 0);
        render();
        return;
      }
      location.href = link;
    });

    bell.addEventListener("click", (e) => {
      e.stopPropagation();
      if (open) closePanel(false); else openPanel();
    });
    document.addEventListener("click", (e) => {
      if (open && !panel.contains(e.target) && !bell.contains(e.target)) closePanel(false);
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && open) closePanel(true); });
    window.addEventListener("resize", () => { if (open) place(); });
    // Keep "5 წუთის წინ" honest while the panel stays open.
    setInterval(() => { if (open) render(); }, 60_000);
  }

  function attach(s) {
    bell = document.getElementById("notifBell");
    if (!s || !bell) return;
    badge = document.getElementById("notifBadge");
    bell.hidden = false;
    if (!panel) buildPanel();
    if (socket !== s) {
      socket = s;
      s.on("notif:new", ({ item, unseen: n }) => {
        if (!item) return;
        items = [item].concat(items.filter(x => x.id !== item.id));
        if (open) { socket.emit("notif:seen"); render(); }
        else setUnseen(n || 0);
      });
      // Read/seen state changed elsewhere (another tab, a chat opened, etc.)
      s.on("notif:changed", ({ unseen: n }) => {
        if (open) refresh(); else setUnseen(n || 0);
      });
    }
    refresh();
  }

  window.GaicaniNotif = { attach };
})();
