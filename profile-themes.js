// ── Profile styles: the ring around your picture and your card's glow ───────
// Picked on the dashboard (👤 → 🎨 პროფილის სტილი) and shown wherever your
// picture is: your card, your profile card, friends' lists and chat headers.
// The rare ones are rewards for coming back: they unlock with your best
// daily-bonus streak (VIP accounts get gold and diamond straight away).
// The server keeps the same ids and checks the locks (PROFILE_THEMES there).
(function () {
  "use strict";

  const conic = (...c) => `conic-gradient(${c.join(",")})`;
  const LIST = [
    { id: "default",  label: "მინანქარი", solid: "#4f6cff", tint: "rgba(79,108,255,.32)",
      ring: conic("#4f6cff", "#1fc18a", "#f4d98f", "#e33b5f", "#9d5cff", "#4f6cff") },
    { id: "cobalt",   label: "კობალტი",   solid: "#4f6cff", tint: "rgba(79,108,255,.42)",
      ring: conic("#4f6cff", "#b7c3ff", "#2f45c9", "#4f6cff") },
    { id: "emerald",  label: "ზურმუხტი",  solid: "#1fc18a", tint: "rgba(31,193,138,.30)",
      ring: conic("#1fc18a", "#b5f7dd", "#0d7f59", "#1fc18a") },
    { id: "ruby",     label: "ლალი",      solid: "#e33b5f", tint: "rgba(227,59,95,.34)",
      ring: conic("#e33b5f", "#ffb3c3", "#9c1235", "#e33b5f") },
    { id: "amethyst", label: "ამეთვისტო", solid: "#9d5cff", tint: "rgba(157,92,255,.36)",
      ring: conic("#9d5cff", "#e0c8ff", "#6326c9", "#9d5cff") },
    { id: "sunset",   label: "დაისი",     solid: "#ff7a59", tint: "rgba(255,122,89,.32)",
      ring: conic("#ffb347", "#ff5f80", "#9d5cff", "#ff5f80", "#ffb347"), lock: { days: 3 } },
    { id: "ocean",    label: "ზღვა",      solid: "#19b3a6", tint: "rgba(25,179,166,.32)",
      ring: conic("#19b3a6", "#7fe3ff", "#4f6cff", "#7fe3ff", "#19b3a6"), lock: { days: 5 } },
    { id: "fire",     label: "ცეცხლი",    solid: "#ff6d00", tint: "rgba(255,109,0,.34)", glow: "rgba(255,109,0,.75)",
      ring: conic("#fff176", "#ff9800", "#ff3d00", "#d50000", "#ff9800", "#fff176"),
      lock: { days: 7 }, badge: "🔥 ცეცხლის ჩარჩო", fire: true },
    { id: "gold",     label: "ოქრო",      solid: "#d6a84f", tint: "rgba(214,168,79,.36)", glow: "rgba(244,217,143,.7)",
      ring: conic("#fff4d2", "#d6a84f", "#f4d98f", "#a87a25", "#fff4d2"),
      lock: { days: 14, vip: true }, badge: "👑 ოქროს ჩარჩო" },
    { id: "diamond",  label: "ბრილიანტი", solid: "#9be7ff", tint: "rgba(155,231,255,.28)", glow: "rgba(155,231,255,.75)",
      ring: conic("#ffffff", "#9be7ff", "#e0c3ff", "#ffffff", "#7fd3ff", "#ffffff"),
      lock: { days: 30, vip: true }, badge: "💎 ბრილიანტის ჩარჩო" },
  ];
  const BY_ID = Object.fromEntries(LIST.map((t) => [t.id, t]));

  // CSS custom properties for an element showing this theme.
  function vars(id) {
    const t = BY_ID[id];
    if (!t || id === "default") return "";
    return `--pt-ring:${t.ring};--pt-tint:${t.tint};--pt-solid:${t.solid};--pt-glow:${t.glow || "transparent"}`;
  }
  function apply(el, id) {
    if (!el) return;
    ["--pt-ring", "--pt-tint", "--pt-solid", "--pt-glow"].forEach((p) => el.style.removeProperty(p));
    const t = BY_ID[id];
    el.classList.toggle("pt-on", !!t && id !== "default");
    el.classList.toggle("pt-glow", !!(t && t.glow));
    el.classList.toggle("pt-fire", !!(t && t.fire)); // the 🔥 ring flickers
    if (!t || id === "default") return;
    el.style.setProperty("--pt-ring", t.ring);
    el.style.setProperty("--pt-tint", t.tint);
    el.style.setProperty("--pt-solid", t.solid);
    el.style.setProperty("--pt-glow", t.glow || "transparent");
  }

  const CSS = `
.pt-on.profile-card-avatar, .pt-on.fc-avatar { border: none; padding: 4px; background: var(--pt-ring); }
.pt-on.fc-avatar { padding: 2.5px; }
.pt-on.profile-card-avatar img, .pt-on.fc-avatar img { border-radius: 50%; }
.pt-glow.profile-card-avatar, .pt-glow.fc-avatar { box-shadow: 0 0 18px var(--pt-glow); }
.pt-on.friend-avatar { box-shadow: 0 0 0 2px var(--pt-solid); }
.pt-glow.friend-avatar { box-shadow: 0 0 0 2px var(--pt-solid), 0 0 10px var(--pt-glow); }
/* 🔥 The fire ring is alive: it flickers, and on your own card spins faster. */
@keyframes ptFlicker {
  0%, 100% { box-shadow: 0 0 14px rgba(255,109,0,.85), 0 0 4px #ffd54f; }
  30% { box-shadow: 0 -3px 26px rgba(255,61,0,.95), 0 0 10px #ffb300; }
  60% { box-shadow: 0 2px 18px rgba(255,145,0,.9), 0 0 12px #ff3d00; }
}
@keyframes ptFlickerSm {
  0%, 100% { box-shadow: 0 0 0 2px #ff6d00, 0 0 8px rgba(255,109,0,.8); }
  50% { box-shadow: 0 0 0 2px #ffb300, 0 0 14px rgba(255,61,0,.95); }
}
.pt-fire.profile-card-avatar, .pt-fire.fc-avatar { animation: ptFlicker 1.3s ease-in-out infinite; }
.pt-fire.friend-avatar { animation: ptFlickerSm 1.3s ease-in-out infinite; }
.user-card.pt-fire .user-avatar { animation: ptFlicker 1.3s ease-in-out infinite; }
.user-card.pt-fire .user-avatar::before { animation-duration: 3s; }
@media (prefers-reduced-motion: reduce) {
  .pt-fire.profile-card-avatar, .pt-fire.fc-avatar, .pt-fire.friend-avatar, .user-card.pt-fire .user-avatar { animation: none; }
}
.pt-badge { display: inline-block; margin: -4px 0 10px; padding: 3px 10px; border-radius: 999px; font-size: .74em; font-weight: 800;
  background: rgba(214,168,79,.14); border: 1px solid rgba(214,168,79,.45); color: #f4d98f; }
`;
  function ensureCss() {
    if (document.getElementById("profileThemesCss")) return;
    const st = document.createElement("style");
    st.id = "profileThemesCss"; st.textContent = CSS;
    document.head.appendChild(st);
  }
  if (document.head) ensureCss(); else document.addEventListener("DOMContentLoaded", ensureCss);

  window.GaicaniThemes = {
    list: LIST,
    get: (id) => BY_ID[id] || null,
    // "🔥 7 დღე ზედიზედ" — how to unlock a locked style.
    lockHint: (t) => (t && t.lock ? `🔥 ${t.lock.days} დღე ზედიზედ${t.lock.vip ? " ან VIP" : ""}` : ""),
    vars,
    apply,
    // "👑 ოქროს ჩარჩო" under the picture on a profile card, for the rare ones.
    badgeHtml: (id) => (BY_ID[id] && BY_ID[id].badge ? `<div><span class="pt-badge">${BY_ID[id].badge}</span></div>` : ""),
  };
})();
