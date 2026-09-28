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
