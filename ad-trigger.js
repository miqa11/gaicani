// ── Per-button click-counted ad trigger ──────────────────────────────────
// Each button gets its OWN independent countdown, shown as a small number
// badge in its bottom-right corner — not a shared counter, not a separate
// floating element. ძებნა counts its own clicks; ბლოკი counts its own;
// private chat's send button counts its own. Every Nth click on a button
// opens the ad and that button's own countdown restarts at N.
//
// Must be called SYNCHRONOUSLY, directly inside a real click handler — not
// after an await/fetch/setTimeout — or the browser's popup blocker will
// silently swallow window.open(). Every call site does this correctly.
(function () {
  const AD_URL = "https://omg10.com/4/11150018";
  const AD_EVERY_N = 5;

  // Persisted per browser tab so a reload mid-session doesn't reset someone
  // back to a full count. Each button gets its own sessionStorage key.
  function getCount(storageKey) {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw !== null) return parseInt(raw, 10) || 0;
    } catch (_) {}
    return 0;
  }
  function saveCount(storageKey, n) {
    try { sessionStorage.setItem(storageKey, String(n)); } catch (_) {}
  }

  // Creates (once) or reuses a small number badge pinned to the button's
  // own bottom-right corner. The button must have (or gets given) its own
  // stacking context — position:relative — so the badge anchors to IT,
  // not to some distant positioned ancestor.
  function ensureButtonBadge(btnEl, badgeId) {
    let badge = document.getElementById(badgeId);
    if (badge) return badge;

    const computedPos = window.getComputedStyle(btnEl).position;
    if (computedPos === "static") btnEl.style.position = "relative";

    badge = document.createElement("span");
    badge.id = badgeId;
    badge.className = "ad-click-badge";
    badge.title = "რეკლამამდე დარჩენილი დაწკაპუნებები";
    btnEl.appendChild(badge);
    return badge;
  }

  function render(badge, remaining) {
    badge.textContent = String(remaining);
  }

  // Exempt from ads entirely — no countdown shown, no ad ever fires — when
  // the user is pro, OR is inside a 24h ad-free window earned by scoring
  // 20+ in Flappy Bird. Checked here so every call site (present and
  // future) benefits without needing its own guard. The window's end time
  // comes from the server (adFreeUntil in the auth payload), so reloading
  // the page or editing localStorage can't fake or extend it.
  function isAdExempt() {
    const u = window.gaicaniAuthUser;
    if (!u) return false;
    if (u.isPro) return true;
    return typeof u.adFreeUntil === "number" && u.adFreeUntil > Date.now();
  }
  // Exposed so other pages (e.g. Flappy Bird's pre-round ad gate) apply the
  // exact same rule instead of re-implementing it.
  window.isAdExempt = isAdExempt;

  // Opens the ad in a new tab. Same URL as the click-counter above — kept
  // here so it's defined in exactly one place. MUST be called directly
  // inside a real click handler, or the popup blocker will swallow it.
  window.openAdNow = function () {
    window.open(AD_URL, "_blank", "noopener");
  };

  // Call inside a real click handler. `storageKey` must be UNIQUE per
  // button (each button counts independently); `badgeId` names that
  // button's own badge; `btnEl` is the button the badge attaches to.
  window.registerAdClick = function (storageKey, badgeId, btnEl) {
    if (isAdExempt()) {
      // Make sure no stale badge/number lingers from before they went pro.
      const existing = document.getElementById(badgeId);
      if (existing) existing.remove();
      return;
    }
    let count = getCount(storageKey) + 1;
    const badge = ensureButtonBadge(btnEl, badgeId);

    if (count >= AD_EVERY_N) {
      // This click completes THIS button's own set of N — fire the ad,
      // synchronously, so the browser still treats it as a direct result
      // of the user's click. Then this button's countdown restarts.
      window.open(AD_URL, "_blank", "noopener");
      count = 0;
      render(badge, AD_EVERY_N);
    } else {
      render(badge, AD_EVERY_N - count);
    }
    saveCount(storageKey, count);
  };

  // Draws a button's badge at its current count without incrementing —
  // used once on page load so it shows the right number before any click.
  window.initAdCountdown = function (storageKey, badgeId, btnEl) {
    if (isAdExempt()) return; // no badge at all for pro users
    const count = getCount(storageKey);
    const badge = ensureButtonBadge(btnEl, badgeId);
    render(badge, AD_EVERY_N - count);
  };

  // initAdCountdown runs on page load, before the socket has finished
  // authenticating — so a pro user can briefly see a stale badge rendered
  // under the assumption they weren't pro yet. Call this once isPro becomes
  // known (after auth completes, or right after an admin grants it live) to
  // sweep any badge that was drawn too early.
  window.clearAdBadgesIfPro = function () {
    if (!isAdExempt()) return;
    document.querySelectorAll(".ad-click-badge").forEach(b => b.remove());
  };
})();
