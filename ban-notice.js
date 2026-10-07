// ── 24h temp-ban notice ──────────────────────────────────────────────────
// Shown the instant a "tempBanned" socket event arrives — i.e. someone is
// actively connected (mid-game, mid-chat) when an admin blocks them. Without
// this they'd just silently disconnect and only learn why if they happened
// to reload the page later (the server's HTTP-level block page still covers
// that case on its own). This covers the moment it actually happens.
//
// Usage on any page: after creating `socket`, call:
//   attachTempBanGuard(socket);
function attachTempBanGuard(socket) {
  if (!socket || socket._tempBanGuardAttached) return;
  socket._tempBanGuardAttached = true;
  attachConnectionKeeper(socket);   // reconnect instantly when you come back to the site

  // Account blocked by an admin for an offensive name → forced rename screen.
  socket.on("account:nameBlocked", (data) => showNameBlockScreen(data && data.username));

  // 🤖 The same message sent again and again → a captcha before the next
  // ones go out (server-spamguard.js). Nothing is blocked.
  socket.on("spam:captcha", (data) => showSpamCaptcha(socket, data || {}));
  socket.on("spam:cleared", () => closeSpamCaptcha(true));

  socket.on("tempBanned", (data) => {
    const hours = Math.max(1, Math.round(data?.hours || 24));
    const username = String(data?.username || "").trim();

    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:99999;background:#17181c;color:#eceef2;" +
      "display:flex;align-items:center;justify-content:center;padding:24px;" +
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;";

    const box = document.createElement("div");
    box.style.cssText =
      "max-width:400px;width:100%;background:#212227;border:1px solid rgba(242,63,66,.3);" +
      "border-radius:16px;padding:28px 24px;text-align:center;";

    const icon = document.createElement("div");
    icon.style.cssText = "font-size:2.6em;margin-bottom:10px;";
    icon.textContent = "🚫";

    const h1 = document.createElement("h1");
    h1.style.cssText = "font-size:1.15em;margin:0 0 14px;color:#f56769;";
    h1.textContent = `წვდომა შეზღუდულია ${hours === 24 ? "1 დღით" : hours + " საათით"}`;

    const p1 = document.createElement("p");
    p1.style.cssText = "font-size:.9em;line-height:1.65;color:#c7cad3;margin:0 0 12px;";
    p1.innerHTML = "თქვენ დროებით დაგეიკეტათ წვდომა<br><b>შეურაცხმყოფელი სახელის გამო</b>.";

    box.appendChild(icon);
    box.appendChild(h1);
    box.appendChild(p1);

    if (username) {
      const nameEl = document.createElement("div");
      nameEl.style.cssText =
        "display:inline-block;background:rgba(242,63,66,.12);border:1px solid rgba(242,63,66,.3);" +
        "color:#f56769;border-radius:8px;padding:6px 14px;font-weight:800;margin:6px 0 14px;word-break:break-all;";
      nameEl.textContent = username; // textContent — never innerHTML with untrusted data
      box.appendChild(nameEl);
    }

    const p2 = document.createElement("p");
    p2.style.cssText = "font-size:.9em;line-height:1.65;color:#c7cad3;margin:0 0 12px;";
    p2.textContent = "გთხოვთ, დაბრუნებისას აირჩიოთ სხვა სახელი.";
    box.appendChild(p2);

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // The socket is already being disconnected server-side; stop any
    // reconnect attempts so the overlay doesn't get torn down underneath.
    try { socket.io.opts.reconnection = false; socket.disconnect(); } catch (_) {}
  });
}


// ── 🤖 "Same message again and again" captcha ────────────────────────────────
// Four digits in a picture. The messages sent meanwhile wait on the server
// and go out as soon as it's solved — nothing is lost or blocked.
function showSpamCaptcha(socket, data) {
  const el = (tag, css, text) => { const e = document.createElement(tag); if (css) e.style.cssText = css; if (text != null) e.textContent = text; return e; };
  let wrap = document.getElementById("gcSpamCaptcha");
  if (!wrap) {
    wrap = el("div", "position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;padding:20px;" +
      "background:rgba(8,6,18,.78);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;");
    wrap.id = "gcSpamCaptcha";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    const box = el("form", "width:100%;max-width:340px;background:#1d1a2e;color:#eceef2;border:1px solid rgba(214,168,79,.35);" +
      "border-radius:18px;padding:22px 20px 18px;text-align:center;box-shadow:0 18px 50px rgba(0,0,0,.55);");
    box.setAttribute("autocomplete", "off");
    box.appendChild(el("div", "font-size:2em;margin-bottom:6px;", "🤖"));
    box.appendChild(el("div", "font-weight:700;font-size:1.05em;margin-bottom:8px;", "დაადასტურე, რომ ადამიანი ხარ"));
    box.appendChild(el("div", "font-size:.84em;line-height:1.5;color:#c9c4dc;margin-bottom:14px;",
      "ერთსა და იმავე შეტყობინებას რამდენჯერმე აგზავნი. გასაგრძელებლად ჩაწერე სურათზე გამოსახული 4 ციფრი — შეტყობინება ამის შემდეგ გაიგზავნება."));
    const img = el("img", "display:block;width:200px;max-width:100%;height:auto;margin:0 auto 6px;border-radius:10px;background:#f6f2e8;");
    img.id = "gcSpamCaptchaImg";
    img.alt = "კაპჩა";
    box.appendChild(img);
    const again = el("button", "background:none;border:none;color:#d6a84f;font-size:.8em;cursor:pointer;padding:4px 8px;margin-bottom:10px;", "🔄 სხვა სურათი");
    again.type = "button";
    box.appendChild(again);
    const input = el("input", "display:block;width:100%;box-sizing:border-box;height:46px;border-radius:12px;border:1px solid rgba(255,255,255,.18);" +
      "background:rgba(255,255,255,.07);color:#fff;font-size:22px;letter-spacing:.35em;text-align:center;outline:none;margin-bottom:8px;");
    input.id = "gcSpamCaptchaInput";
    input.type = "text"; input.inputMode = "numeric"; input.maxLength = 4; input.placeholder = "••••";
    input.setAttribute("autocomplete", "one-time-code");
    input.setAttribute("aria-label", "სურათზე გამოსახული ციფრები");
    box.appendChild(input);
    const err = el("div", "min-height:1.2em;font-size:.8em;color:#f0a0a0;margin-bottom:8px;");
    err.id = "gcSpamCaptchaErr";
    err.setAttribute("aria-live", "polite");
    box.appendChild(err);
    const btn = el("button", "width:100%;height:46px;border:none;border-radius:12px;font-weight:700;font-size:.95em;cursor:pointer;" +
      "color:#1a1405;background:linear-gradient(135deg,#f0c76a,#d6a84f);", "დადასტურება");
    btn.type = "submit";
    box.appendChild(btn);
    wrap.appendChild(box);
    document.body.appendChild(wrap);

    input.addEventListener("input", () => { input.value = input.value.replace(/\D/g, "").slice(0, 4); });
    again.addEventListener("click", () => {
      socket.emit("spam:image", null, (r) => { if (r && r.img) img.src = r.img; else if (r && r.ok) closeSpamCaptcha(); });
    });
    box.addEventListener("submit", (e) => {
      e.preventDefault();
      if (input.value.length !== 4 || btn.disabled) { err.textContent = "ჩაწერე 4 ციფრი"; return; }
      btn.disabled = true;
      socket.emit("spam:solve", { answer: input.value }, (r) => {
        btn.disabled = false;
        if (r && r.ok) { closeSpamCaptcha(); return; }
        input.value = "";
        if (r && r.wait) { err.textContent = "⏳ ცოტა მოიცადე და სცადე თავიდან"; return; }
        err.textContent = "❌ არასწორია — სცადე ახალი სურათით";
        if (r && r.img) img.src = r.img;
        input.focus();
      });
    });
  }
  if (data.img) document.getElementById("gcSpamCaptchaImg").src = data.img;
  const input = document.getElementById("gcSpamCaptchaInput");
  setTimeout(() => { try { input.focus(); } catch (_) {} }, 50);
}
function closeSpamCaptcha() {
  document.getElementById("gcSpamCaptcha")?.remove();
}


// ── Forced rename screen ────────────────────────────────────────────────────
// Shown when an admin has blocked this account for an offensive name. The
// only way forward is choosing a new, clean name (the server checks it with
// the same rules as registration) — or logging out and continuing as a guest.
function showNameBlockScreen(currentName) {
  if (document.getElementById("nameBlockScreen")) return;
  const el = (tag, css, text) => { const e = document.createElement(tag); if (css) e.style.cssText = css; if (text != null) e.textContent = text; return e; };
  const wrap = el("div", "position:fixed;inset:0;z-index:100001;display:flex;align-items:center;justify-content:center;padding:20px;" +
    "background:radial-gradient(700px 500px at 50% 0%,rgba(227,59,95,.18),transparent 70%),#130f26;color:#f5f0ff;font-family:inherit;");
  wrap.id = "nameBlockScreen";
  const card = el("div", "width:100%;max-width:380px;text-align:center;padding:26px 20px;border-radius:22px;" +
    "background:linear-gradient(180deg,#261f49,#1a1533);border:1.5px solid rgba(227,59,95,.55);box-shadow:0 30px 80px -20px rgba(0,0,0,.9);");
  card.appendChild(el("div", "font-size:2.6em;margin-bottom:6px;", "🚫"));
  card.appendChild(el("div", "font-size:1.2em;font-weight:800;margin-bottom:10px;", "ანგარიში დაბლოკილია"));
  const msg = el("div", "font-size:.92em;line-height:1.55;color:#d2cbec;margin-bottom:6px;");
  msg.append("შენი ანგარიში ");
  msg.appendChild(el("b", "color:#ff8aa1;", "„" + (currentName || "") + "“"));
  msg.append(" დაიბლოკა შეურაცხმყოფელი სახელის გამო.");
  card.appendChild(msg);
  card.appendChild(el("div", "font-size:.88em;color:#aaa3c8;margin-bottom:16px;", "განსაბლოკად აირჩიე ახალი, მისაღები სახელი."));
  const input = el("input", "width:100%;box-sizing:border-box;padding:13px 14px;border-radius:12px;border:1px solid rgba(214,168,79,.35);" +
    "background:#221c42;color:#f5f0ff;font-size:16px;font-family:inherit;margin-bottom:8px;");
  input.type = "text"; input.maxLength = 20; input.placeholder = "ახალი სახელი (2–20 სიმბოლო)"; input.autocomplete = "off";
  const err = el("div", "min-height:1.3em;color:#ff8aa1;font-size:.85em;margin-bottom:8px;");
  const btn = el("button", "width:100%;padding:13px;border:none;border-radius:12px;font-weight:800;font-size:1em;color:#fff;cursor:pointer;" +
    "background:linear-gradient(135deg,#5b77ff,#8b55ff);font-family:inherit;", "სახელის შეცვლა და განბლოკვა");
  btn.type = "button";
  const out = el("button", "margin-top:12px;background:none;border:none;color:#958db6;font-size:.85em;cursor:pointer;text-decoration:underline;font-family:inherit;", "გამოსვლა");
  out.type = "button";
  card.append(input, err, btn, out);
  wrap.appendChild(card); document.body.appendChild(wrap);
  setTimeout(() => input.focus(), 50);

  async function submit() {
    const newName = input.value.trim();
    if (newName.length < 2) { err.textContent = "სახელი: 2–20 სიმბოლო"; return; }
    let token = null; try { token = localStorage.getItem("gaicani_auth_token"); } catch (_) {}
    btn.disabled = true; err.textContent = "";
    try {
      const r = await fetch("/api/auth/rename-required", { method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify({ newName }) });
      const d = await r.json();
      if (!r.ok) { err.textContent = d.error || "ვერ შეიცვალა"; btn.disabled = false; return; }
      try { localStorage.setItem("gaicani_auth_user", d.username); } catch (_) {}
      card.replaceChildren(el("div", "font-size:2.4em;", "✅"), el("div", "font-weight:800;margin-top:8px;", "სახელი შეიცვალა — „" + d.username + "“"));
      setTimeout(() => location.reload(), 1200);
    } catch (_) { err.textContent = "კავშირის შეცდომა"; btn.disabled = false; }
  }
  btn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  out.addEventListener("click", () => {
    try { localStorage.removeItem("gaicani_auth_token"); localStorage.removeItem("gaicani_auth_user"); } catch (_) {}
    location.href = "/";
  });
}


// ── Connection keeper ───────────────────────────────────────────────────────
// Phones (iPhones especially) freeze a page the moment you switch apps and can
// silently kill its connection. Back on the site, the page may still think it
// is connected — and on its own it can take ~2 minutes to notice. So whenever
// the page returns to the foreground or the network comes back, we ping the
// server; no answer within 2.5 s → reconnect at once. Closing the dead link
// looks exactly like a normal network drop, so each page's existing
// "reconnected → log back in" code takes over. Deliberate disconnects (a ban,
// a name block, a page closing its own connection) are left alone.
function attachConnectionKeeper(socket) {
  if (!socket || socket._connKeeperAttached) return;
  socket._connKeeperAttached = true;
  let stopped = false, ourRetry = false, checking = false, lastCheck = 0;
  let pill = null, pillTimer = null;

  function showPill() {
    if (pill || !document.body) return;
    pill = document.createElement("div");
    pill.id = "connPill";
    pill.textContent = "🔄 კავშირის აღდგენა…";
    pill.style.cssText = "position:fixed;top:calc(10px + env(safe-area-inset-top, 0px));left:50%;transform:translateX(-50%);" +
      "z-index:99990;padding:7px 14px;border-radius:999px;background:rgba(19,15,38,.92);color:#f4d98f;font-size:13px;" +
      "font-weight:700;border:1px solid rgba(214,168,79,.4);box-shadow:0 8px 24px rgba(0,0,0,.45);pointer-events:none;font-family:inherit;";
    document.body.appendChild(pill);
  }
  function hidePill() { clearTimeout(pillTimer); pillTimer = null; if (pill) { pill.remove(); pill = null; } }

  let lastId = null;
  socket.on("connect", () => {
    // Our previous connection may still look alive on the server (a frozen
    // phone never said goodbye) — tell the server which one we replace.
    if (lastId && lastId !== socket.id) socket.emit("conn:replaced", { oldId: lastId });
    lastId = socket.id;
    stopped = false; ourRetry = false; hidePill();
  });
  socket.on("disconnect", (reason) => {
    // The server closed us on purpose, or the page did → don't fight it.
    if (reason === "io server disconnect" || (reason === "io client disconnect" && !ourRetry)) { stopped = true; hidePill(); return; }
    clearTimeout(pillTimer);
    pillTimer = setTimeout(showPill, 1500);   // only for outages longer than a moment
  });

  function check() {
    if (stopped || checking) return;
    const now = Date.now();
    if (now - lastCheck < 3000) return;       // don't ping on every tiny focus change
    lastCheck = now;
    if (!socket.connected) {                  // already down → retry now instead of waiting out the back-off
      ourRetry = true; socket.disconnect(); socket.connect(); return;
    }
    checking = true;
    let answered = false;
    const timer = setTimeout(() => {
      checking = false;
      if (!answered && socket.connected) {    // looks open but nothing comes back → it's dead
        try { socket.io.engine && socket.io.engine.close(); } catch (_) {}
      }
    }, 2500);
    socket.emit("conn:ping", () => { answered = true; checking = false; clearTimeout(timer); });
  }

  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check(); });
  window.addEventListener("pageshow", (e) => { if (e.persisted) check(); });   // back/forward cache
  window.addEventListener("online", check);                                      // network returned
  window.addEventListener("focus", check);
}
