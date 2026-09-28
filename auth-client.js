/* ════════════════════════════════════════════════════════════════════════════
   auth-client.js — GAICANI Registered User System
   Handles: Register / Login / Friend Requests / Private Chat / Dashboard
   ════════════════════════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  /* ── $ helper ────────────────────────────────────────────────────── */
  function $(id) { return document.getElementById(id); }

  /* ── HTML escape ─────────────────────────────────────────────────── */
  function esc(s) {
    return String(s).replace(/[&<>"']/g,
      c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
  }

  /* ── "Do not disturb" during chat — a device-local preference. Once on,
     game invites stop popping up over random chat (and, separately, over
     private chat too — see friend-chat.html). Turned back on from the
     dashboard's settings. Same storage key as friend-chat.html so the
     preference is unified across both contexts. ── */
  const DND_CHAT_INVITES_KEY = "gaicani_dnd_chat_invites";
  function isChatInviteDndOn() {
    try { return localStorage.getItem(DND_CHAT_INVITES_KEY) === "1"; } catch (_) { return false; }
  }
  function enableChatInviteDnd() {
    try { localStorage.setItem(DND_CHAT_INVITES_KEY, "1"); } catch (_) {}
    const bar = document.getElementById("dgInviteBar");
    if (bar) { bar.classList.remove("show"); bar.innerHTML = ""; }
    showToast("🔕 ჩატის დროს შეტყობინებები გამორთულია — ჩართვა შესაძლებელია ჩემი გვერდიდან");
  }
  function renderChatInviteBar({ icon, messageHtml, onAccept, onDecline }) {
    if (isChatInviteDndOn()) return false;
    const bar = document.getElementById("dgInviteBar");
    if (!bar) return false;
    bar.innerHTML = `
      <div class="dg-invite-bar-row">
        <span>${icon} ${messageHtml}</span>
        <button class="dg-invite-accept">✅</button>
        <button class="dg-invite-decline">❌</button>
      </div>
      <button class="dg-invite-dnd">🔕 თუ გსურთ აღარ მოგივიდეთ ჩატის დროს შეტყობინება დააჭირეთ ღილაკს</button>`;
    bar.classList.add("show");
    bar.querySelector(".dg-invite-accept").onclick = () => { bar.classList.remove("show"); onAccept(); };
    bar.querySelector(".dg-invite-decline").onclick = () => { bar.classList.remove("show"); onDecline(); };
    bar.querySelector(".dg-invite-dnd").onclick = enableChatInviteDnd;
    return true;
  }

  /* ── Storage ─────────────────────────────────────────────────────── */
  const LS_TOKEN = "gaicani_auth_token";
  const LS_USER  = "gaicani_auth_user";

  function saveAuth(token, username) {
    try { localStorage.setItem(LS_TOKEN, token); localStorage.setItem(LS_USER, username); } catch (_) {}
  }
  function loadAuth() {
    try { return { token: localStorage.getItem(LS_TOKEN), username: localStorage.getItem(LS_USER) }; }
    catch (_) { return {}; }
  }
  function clearAuth() {
    try { localStorage.removeItem(LS_TOKEN); localStorage.removeItem(LS_USER); } catch (_) {}
  }

  /* ── Predefined profile avatars ──────────────────────────────────── */
  const AVAILABLE_AVATARS = [
    "avatar1.png", "avatar2.png", "avatar3.png", "avatar4.png",
    "avatar5.png", "avatar6.png", "avatar7.png", "avatar8.png",
    "avatar9.jpg", "avatar10.jpg", "avatar11.jpg", "avatar12.jpg",
    "avatar13.jpg", "avatar14.jpg", "avatar15.jpg", "avatar16.jpg",
    "avatar17.jpg", "avatar18.jpg", "avatar19.jpg", "avatar20.jpg",
    "avatar21.jpg", "avatar22.jpg", "avatar23.jpg", "avatar24.jpg",
  ];
  const AVATAR_DIR = "/";
  let signupSelectedAvatar = AVAILABLE_AVATARS[0];

  function renderAvatarGrid(containerEl, selected, onPick) {
    if (!containerEl) return;
    containerEl.innerHTML = "";
    AVAILABLE_AVATARS.forEach(file => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "avatar-picker-option" + (file === selected ? " selected" : "");
      btn.dataset.avatar = file;
      btn.innerHTML = `<img src="${AVATAR_DIR}${file}" alt="avatar" loading="lazy" />`;
      btn.addEventListener("click", () => {
        containerEl.querySelectorAll(".avatar-picker-option").forEach(b => b.classList.remove("selected"));
        btn.classList.add("selected");
        onPick(file);
      });
      containerEl.appendChild(btn);
    });
  }

  // ── Avatar grid rendering (PATCH: only render once) ───────────────────────────
  const avatarGridEl = $("signup-avatar-grid");
  if (avatarGridEl && !avatarGridEl.dataset.rendered) {
    renderAvatarGrid(avatarGridEl, signupSelectedAvatar, file => {
      signupSelectedAvatar = file;
    });
    avatarGridEl.dataset.rendered = "true";
  }

  /* ── State ───────────────────────────────────────────────────────── */
  let authUser = null;    // { username, token, friends:[], pendingRequests:[], avatar }
  let authSocket = null;  // reference to the main socket
  let sessionBlocked = new Set();  // lowercase usernames blocked this session

  // Private chat state
  let privChatPartner = null;  // username of open private chat
  let privChatMessages = [];

  /* ── Toast (uses script.js showToast if available) ───────────────── */
  function showToast(msg, ms = 3500) {
    if (typeof window.showToast === "function") { window.showToast(msg, ms); return; }
    const c = $("notif-container") || document.body;
    const t = document.createElement("div");
    t.className = "toast-popup"; t.textContent = msg;
    c.appendChild(t);
    requestAnimationFrame(() => t.classList.add("toast-visible"));
    setTimeout(() => { t.classList.remove("toast-visible"); setTimeout(() => t.remove(), 350); }, ms);
  }

  /* ══════════════════════════════════════════════════════════════════
     AUTH TABS — Guest / Login / Register
     ══════════════════════════════════════════════════════════════════ */

  function activateTab(tab) {
    ["guest","login","signup"].forEach(id => {
      const btn = $("auth-tab-" + id);
      const sec = $("auth-section-" + id);
      if (btn) btn.classList.toggle("active", id === tab);
      if (sec) sec.style.display = id === tab ? "" : "none";
    });
    // clear errors on tab switch
    setError("login-error", "");
    setError("signup-error", "");
  }

  $("auth-tab-guest") ?.addEventListener("click", () => activateTab("guest"));
  $("auth-tab-login") ?.addEventListener("click", () => activateTab("login"));
  $("auth-tab-signup")?.addEventListener("click", () => activateTab("signup"));

  /* ── Error helpers ────────────────────────────────────────────────── */
  function setError(elId, msg) {
    const el = $(elId);
    if (!el) return;
    el.textContent = msg;
    el.style.display = msg ? "block" : "none";
  }

  /* ══════════════════════════════════════════════════════════════════
     REGISTER
     ══════════════════════════════════════════════════════════════════ */
  $("signup-btn")?.addEventListener("click", doRegister);
  $("signup-confirm")?.addEventListener("keydown", e => { if (e.key === "Enter") doRegister(); });

  async function doRegister() {
    const username = ($("signup-username")?.value || "").trim();
    const password = ($("signup-password")?.value || "");
    const confirm  = ($("signup-confirm") ?.value || "");

    setError("signup-error", "");

    if (!username) { setError("signup-error", "შეიყვანეთ სახელი"); return; }
    if (username.length < 2 || username.length > 20)
      { setError("signup-error", "სახელი: 2–20 სიმბოლო"); return; }
    if (!password) { setError("signup-error", "შეიყვანეთ პაროლი"); return; }
    if (password.length < 6) { setError("signup-error", "პაროლი მინ. 6 სიმბოლო"); return; }
    if (password !== confirm) { setError("signup-error", "პაროლები არ ემთხვევა"); return; }

    const btn = $("signup-btn");
    if (btn) { btn.disabled = true; btn.textContent = "⏳..."; }

    try {
      const r = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, avatar: signupSelectedAvatar }),
      });
      const d = await r.json();
      if (!r.ok) {
        setError("signup-error", d.error || "შეცდომა");
        return;
      }
      // Success — auto-login
      handleAuthSuccess(d.token, d.username, d.friends || [], d.pendingRequests || [], d.avatar);
    } catch (_) {
      setError("signup-error", "კავშირის შეცდომა. კვლავ სცადეთ.");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "რეგისტრაცია"; }
    }
  }

  /* ══════════════════════════════════════════════════════════════════
     LOGIN
     ══════════════════════════════════════════════════════════════════ */
  $("login-btn")?.addEventListener("click", doLogin);
  $("login-password")?.addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });

  async function doLogin() {
    const username = ($("login-username")?.value || "").trim();
    const password = ($("login-password")?.value || "");

    setError("login-error", "");
    if (!username || !password) { setError("login-error", "შეიყვანეთ სახელი და პაროლი"); return; }

    const btn = $("login-btn");
    if (btn) { btn.disabled = true; btn.textContent = "⏳..."; }

    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const d = await r.json();
      if (!r.ok) { setError("login-error", d.error || "არასწორი სახელი ან პაროლი"); return; }
      handleAuthSuccess(d.token, d.username, d.friends || [], d.pendingRequests || [], d.avatar);
    } catch (_) {
      setError("login-error", "კავშირის შეცდომა. კვლავ სცადეთ.");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "შესვლა"; }
    }
  }

  /* ══════════════════════════════════════════════════════════════════
     AUTH SUCCESS — called after login or register
     ══════════════════════════════════════════════════════════════════ */
  function handleAuthSuccess(token, username, friends, pendingRequests, avatar) {
    saveAuth(token, username);
    authUser = { username, token, friends: friends || [], pendingRequests: pendingRequests || [],
                 avatar: avatar || AVAILABLE_AVATARS[0] };
    window.gaicaniAuthUser = authUser;

    // Show success toast, then redirect straight to the dashboard
    showToast(`✅ ${esc(username)} — წარმატებით შეხვედით!`);
    setTimeout(() => {
      window.location.href = '/dashboard.html';
    }, 700);
  }

  function autoSetNameAfterAuth(username) {
    // Hide the name modal immediately — registered users never need to see it
    const nameModal = document.getElementById("nameModal");
    const overlay   = document.getElementById("modalLoadingOverlay");
    if (nameModal) nameModal.style.display = "none";

    // Used by tryAutoLogin so returning registered users skip the name modal
    setTimeout(() => {
      if (typeof window.socket !== "undefined" && window.socket.connected) {
        const currentName = window.userName || "";
        if (!currentName) {
          const nameInput = $("nameInput");
          if (nameInput) nameInput.value = username;
          const saveBtn = $("saveNameBtn");
          if (saveBtn) saveBtn.click();
        }
      }
    }, 400);
  }

  /* ── Update top bar badge ──────────────────────────────────────────── */
  function updateAuthBadge() {
    const badge = $("auth-user-badge");
    if (badge) badge.style.display = "none"; // always hidden now
    const myPageBtn = $("myPageBtn");
    if (!myPageBtn) return;
    if (authUser) {
      myPageBtn.style.display = "inline-flex";
    } else {
      myPageBtn.style.display = "none";
    }
  }

  /* ══════════════════════════════════════════════════════════════════
     SOCKET EVENTS — bind once when authUser is set
     ══════════════════════════════════════════════════════════════════ */
  let socketBound = false;

  function bindSocketEvents() {
    if (socketBound) return;
    // Wait for socket to be available
    const waitForSocket = setInterval(() => {
      if (typeof window.socket !== "undefined") {
        clearInterval(waitForSocket);
        _bindSocketNow(window.socket);
      }
    }, 100);
  }

  function _bindSocketNow(s) {
    if (socketBound) return;
    socketBound = true;
    authSocket = s;

    // Send auth once connected or reconnected — a real token for a
    // registered user, or a guest identity for anyone else, so game
    // invites can be sent AND received through this same socket (the one
    // random chat itself runs on) regardless of registration status.
    function sendAuthToken() {
      if (authUser) {
        s.emit("auth:login", { token: authUser.token });
      } else {
        let preferredUsername = null;
        try { preferredUsername = sessionStorage.getItem("gaicani_guest_username"); } catch (_) {}
        s.emit("auth:guest", { preferredUsername });
      }
    }

    if (s.connected) sendAuthToken();
    s.on("connect", sendAuthToken);

    // Authentication confirmed
    s.on("auth:authenticated", ({ username, friends, pendingRequests, isGuest, isPro, adFreeUntil }) => {
      if (isGuest) {
        // Guests have no friends/pending requests to populate — just
        // remember the assigned name so it's reused on the next page.
        if (username) { try { sessionStorage.setItem("gaicani_guest_username", username); } catch (_) {} }
        return;
      }
      if (authUser) {
        authUser.friends = friends || [];
        authUser.pendingRequests = pendingRequests || [];
        authUser.isPro = !!isPro;
        authUser.adFreeUntil = Number(adFreeUntil) || 0; // 24h ad-free earned in Flappy Bird
        window.gaicaniAuthUser = authUser;
        if (typeof window.clearAdBadgesIfPro === "function") window.clearAdBadgesIfPro();
      }
      renderDashFriends(friends || []);
    });

    // Earned 24h ad-free in Flappy Bird (possibly in ANOTHER tab) — drop the
    // ad badges here immediately rather than waiting for a reload.
    s.on("ads:adFreeUntil", ({ adFreeUntil }) => {
      if (authUser) {
        authUser.adFreeUntil = Number(adFreeUntil) || 0;
        window.gaicaniAuthUser = authUser;
        if (typeof window.clearAdBadgesIfPro === "function") window.clearAdBadgesIfPro();
      }
    });

    // Pro status changed while this session is live (admin just granted or
    // revoked it) — update immediately rather than waiting for a reconnect.
    s.on("auth:proStatusChanged", ({ isPro }) => {
      if (authUser) {
        authUser.isPro = !!isPro;
        window.gaicaniAuthUser = authUser;
        if (typeof window.clearAdBadgesIfPro === "function") window.clearAdBadgesIfPro();
      }
    });

    // Token expired
    s.on("auth:error", () => {
      clearAuth();
      authUser = null;
      window.gaicaniAuthUser = null;
      updateAuthBadge();
      updateRegMenuVisibility();
      showToast("⚠️ სესია ამოიწურა. გთხოვთ ხელახლა შეხვიდეთ.");
    });

    // ── Partner is a registered user — show banner ────────────────────
    s.on("auth:partnerRegInfo", ({ partnerRegName, isFriend }) => {
      showPartnerRegBanner(partnerRegName, isFriend);
      updateAddFriendBtn(partnerRegName, isFriend);
      if (isFriend) hideFriendAddHint(); else showFriendAddHint(partnerRegName);
    });

    // ── Incoming friend request ───────────────────────────────────────
    s.on("friend:incomingRequest", ({ fromUsername }) => {
      showFriendRequestNotif(fromUsername);
    });

    // ── Invited to a Draw & Guess room — shown wherever the person currently
    // is (including mid-conversation in random chat), via a fixed overlay bar.
    s.on("drawGuess:invited", ({ roomId, fromUsername }) => {
      renderChatInviteBar({
        icon: "🎨", messageHtml: `<strong>${esc(fromUsername)}</strong>-მა მოგიწვია დახატე-და-გამოიცანიში`,
        onAccept: () => { window.location.href = "/draw-guess.html?room=" + encodeURIComponent(roomId); },
        onDecline: () => s.emit("drawGuess:declineInvite", { roomId }),
      });
    });

    // ── Invited to a Poker table — same fixed overlay bar, same everywhere-
    // you-are behavior as the Draw & Guess invite above.
    s.on("poker:invited", ({ roomId, fromUsername }) => {
      renderChatInviteBar({
        icon: "🃏", messageHtml: `<strong>${esc(fromUsername)}</strong>-მა მოგიწვია პოკერზე`,
        onAccept: () => { window.location.href = "/poker.html?room=" + encodeURIComponent(roomId); },
        onDecline: () => s.emit("poker:declineInvite", { roomId }),
      });
    });

    // ── Invited to a Chess game — same fixed overlay bar, same everywhere-
    // you-are behavior as the Draw & Guess / Poker invites above.
    s.on("chess:invited", ({ roomId, fromUsername }) => {
      renderChatInviteBar({
        icon: "♟️", messageHtml: `<strong>${esc(fromUsername)}</strong>-მა მოგიწვია ჭადრაკზე`,
        onAccept: () => { window.location.href = "/chess.html?room=" + encodeURIComponent(roomId); },
        onDecline: () => s.emit("chess:declineInvite", { roomId }),
      });
    });

    // ── Invited to a Checkers game — same fixed overlay bar, same
    // everywhere-you-are behavior as the other games' invites above.
    s.on("checkers:invited", ({ roomId, fromUsername }) => {
      renderChatInviteBar({
        icon: "⚪", messageHtml: `<strong>${esc(fromUsername)}</strong>-მა მოგიწვია დამაზე`,
        onAccept: () => { window.location.href = "/checkers.html?room=" + encodeURIComponent(roomId); },
        onDecline: () => s.emit("checkers:declineInvite", { roomId }),
      });
    });

    // ── Invited to a Joker table — same fixed overlay bar, same
    // everywhere-you-are behavior as the other games' invites above.
    s.on("joker:invited", ({ roomId, fromUsername }) => {
      renderChatInviteBar({
        icon: "🃏", messageHtml: `<strong>${esc(fromUsername)}</strong>-მა მოგიწვია ჯოკერზე`,
        onAccept: () => { window.location.href = "/joker.html?room=" + encodeURIComponent(roomId); },
        onDecline: () => s.emit("joker:declineInvite", { roomId }),
      });
    });

    // ── Invited to an Imposter game — same fixed overlay bar, same
    // everywhere-you-are behavior as the other games' invites above.
    s.on("imposter:invited", ({ roomId, fromUsername }) => {
      renderChatInviteBar({
        icon: "🕵️", messageHtml: `<strong>${esc(fromUsername)}</strong>-მა მოგიწვია იმპოსტორზე`,
        onAccept: () => { window.location.href = "/imposter.html?room=" + encodeURIComponent(roomId); },
        onDecline: () => s.emit("imposter:declineInvite", { roomId }),
      });
    });

    // ── Invited to a Blackjack table — same fixed overlay bar, same
    // everywhere-you-are behavior as the other games' invites above.
    s.on("blackjack:invited", ({ roomId, fromUsername }) => {
      renderChatInviteBar({
        icon: "🂡", messageHtml: `<strong>${esc(fromUsername)}</strong>-მა მოგიწვია ბლექჯეკზე`,
        onAccept: () => { window.location.href = "/blackjack.html?room=" + encodeURIComponent(roomId); },
        onDecline: () => s.emit("blackjack:declineInvite", { roomId }),
      });
    });

    // ── Request accepted (by the other person) ────────────────────────
    s.on("friend:acceptedByOther", ({ byUsername, friends }) => {
      if (authUser && friends) authUser.friends = friends;
      else if (authUser && byUsername) {
        const lc = byUsername.toLowerCase();
        if (!authUser.friends.includes(lc)) authUser.friends.push(lc);
      }
      renderDashFriends(authUser?.friends || []);
      showToast(`✅ ${esc(byUsername)} ახლა შენი მეგობარია!`);
    });

    // ── Request accepted (I accepted someone) ─────────────────────────
    s.on("friend:accepted", ({ username, friends }) => {
      if (authUser) authUser.friends = friends || authUser.friends;
      renderDashFriends(authUser?.friends || []);
      if (username) showToast(`✅ ${esc(username)} ახლა შენი მეგობარია!`);
    });

    // ── Friend removed me ─────────────────────────────────────────────
    s.on("friend:removedByOther", ({ byUsername }) => {
      if (authUser) {
        authUser.friends = authUser.friends.filter(
          f => f.toLowerCase() !== byUsername.toLowerCase()
        );
        renderDashFriends(authUser.friends);
      }
      showToast(`ℹ️ ${esc(byUsername)}-მ შენი მეგობრობა გაიუქმა`);
    });

    // ── I removed a friend ────────────────────────────────────────────
    s.on("friend:removed", ({ friends }) => {
      if (authUser) authUser.friends = friends || [];
      renderDashFriends(authUser?.friends || []);
      showToast("✅ მეგობარი წაიშალა");
    });

    s.on("friend:error", ({ msg }) => showToast(`❌ ${esc(msg)}`));

    // ── Decline events ────────────────────────────────────────────────
    s.on("friend:declined", () => showToast("ℹ️ მეგობრობის მოთხოვნა უარყოფილ იქნა"));
    s.on("friend:declinedByOther", ({ byUsername }) =>
      showToast(`ℹ️ ${esc(byUsername)}-მ მოთხოვნა უარყო`));

    // ── Private messages ──────────────────────────────────────────────
    s.on("privateMsg:received", ({ fromUsername, message, timestamp }) => {
      if (privChatPartner === fromUsername) {
        appendPrivMsg(fromUsername, message, timestamp, false);
      } else {
        showToast(`💬 ${esc(fromUsername)}: ${esc(message.substring(0, 60))}`);
      }
    });

    // ── When partner disconnects, clear + hide add friend btn / banner ─
    s.on("partnerDisconnected", () => {
      hidePartnerRegBanner();
      hideFriendAddHint();
      const addBtn = $("addFriendIconBtn");
      if (addBtn) addBtn.style.display = "none";
    });

    // ── When a new partner is found, check if they're registered ────
    s.on("partnerFound", () => {
      hidePartnerRegBanner();
      hideFriendAddHint();
      const addBtn = $("addFriendIconBtn");
      if (addBtn) addBtn.style.display = "none";
      // Ask server if partner is a registered user (only if we're logged in)
      if (authUser) {
        setTimeout(() => s.emit("auth:checkPartner"), 400);
      }
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     PARTNER REG BANNER — "🌟 name — რეგისტრირებულია..."
     ══════════════════════════════════════════════════════════════════ */
  let bannerTimeout = null;

  function showPartnerRegBanner(partnerName, isFriend) {
    clearTimeout(bannerTimeout);
    const banner = $("partner-reg-banner");
    if (!banner) return;

    if (isFriend) {
      banner.textContent = `✅ ${partnerName} — შენი მეგობარია`;
    } else {
      banner.textContent = `🌟 ${partnerName} — დარეგისტრირებულია თუ გსურთ შეგიძლიათ დაამატოთ ➕ - ღილაკზე დაჭერით `;
    }
    banner.style.display = "block";

    // Auto-hide after 5 seconds
    bannerTimeout = setTimeout(() => {
      banner.style.display = "none";
    }, 5000);
  }

  function hidePartnerRegBanner() {
    clearTimeout(bannerTimeout);
    const banner = $("partner-reg-banner");
    if (banner) banner.style.display = "none";
  }

  /* ══════════════════════════════════════════════════════════════════
     SHARED: actually send the friend request (used by both the header
     ➕ button and the glowing ➕ inside the in-chat hint)
     ══════════════════════════════════════════════════════════════════ */
  function sendFriendRequestTo(partnerRegName) {
    if (!authUser || !partnerRegName) return;
    authSocket?.emit("friend:request", { toUsername: partnerRegName });
    const addBtn = $("addFriendIconBtn");
    if (addBtn) addBtn.style.display = "none";
    hideFriendAddHint();
    showToast(`📨 მეგობრობის მოთხოვნა გაიგზავნა ${esc(partnerRegName)}-სთვის`);
  }

  /* ══════════════════════════════════════════════════════════════════
     ADD-FRIEND HINT CARD — shown inside the chat, points to the ➕ btn
     ══════════════════════════════════════════════════════════════════ */
  function showFriendAddHint(partnerRegName) {
    hideFriendAddHint(); // no duplicates
    const chatEl = $("chat");
    if (!chatEl || !partnerRegName) return;

    const hint = document.createElement("div");
    hint.className = "friend-add-hint";
    hint.id = "friendAddHint";
    hint.innerHTML =
      `რომ დაამატოთ პარტნიორი, სწორად დააჭირეთ ღილაკს <span class="fah-plus" id="fahPlusBtn">➕</span>`;
    chatEl.appendChild(hint);
    chatEl.scrollTop = chatEl.scrollHeight;

    const plusBtn = hint.querySelector("#fahPlusBtn");
    if (plusBtn) {
      plusBtn.style.cursor = "pointer";
      plusBtn.addEventListener("click", () => sendFriendRequestTo(partnerRegName));
    }
  }

  function hideFriendAddHint() {
    const hint = $("friendAddHint");
    if (hint) hint.remove();
  }

  /* ══════════════════════════════════════════════════════════════════
     ADD FRIEND ICON BUTTON (➕)
     ══════════════════════════════════════════════════════════════════ */
  function updateAddFriendBtn(partnerRegName, isFriend) {
    const btn = $("addFriendIconBtn");
    if (!btn || !authUser) return;

    if (isFriend) {
      btn.style.display = "none";
      return;
    }

    btn.style.display = "flex";
    // Remove old listener by cloning
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);

    newBtn.addEventListener("click", () => {
      sendFriendRequestTo(partnerRegName);
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     FRIEND REQUEST NOTIFICATION
     ══════════════════════════════════════════════════════════════════ */
  function showFriendRequestNotif(fromUsername) {
    const c = $("notif-container") || document.body;
    const notif = document.createElement("div");
    notif.className = "friend-request-notif";
    notif.innerHTML = `
      <div class="frn-body">
        <span class="frn-icon">👤</span>
        <div class="frn-text">
          <strong>${esc(fromUsername)}</strong> გიგზავნის მეგობრობის მოთხოვნას
        </div>
      </div>
      <div class="frn-btns">
        <button class="frn-accept">✅ დამატება</button>
        <button class="frn-decline">❌ უარყოფა</button>
      </div>
    `;

    c.appendChild(notif);

    notif.querySelector(".frn-accept").addEventListener("click", () => {
      authSocket?.emit("friend:accept", { fromUsername });
      notif.remove();
    });
    notif.querySelector(".frn-decline").addEventListener("click", () => {
      authSocket?.emit("friend:decline", { fromUsername });
      notif.remove();
    });

    // Auto-dismiss after 30 seconds
    setTimeout(() => notif.remove(), 30000);
  }

  /* ══════════════════════════════════════════════════════════════════
     DASHBOARD PANEL (inline sheet)
     ══════════════════════════════════════════════════════════════════ */
  function paintDashAvatar() {
    const dashAvatar = $("dashAvatar");
    if (!dashAvatar || !authUser) return;
    if (authUser.avatar) {
      dashAvatar.innerHTML = `<img src="${AVATAR_DIR}${authUser.avatar}" alt="avatar" />`;
    } else {
      dashAvatar.textContent = authUser.username.charAt(0).toUpperCase();
    }
  }

  function openDashboard() {
    const panel = $("dashboard-panel");
    if (!panel) return;
    panel.style.display = "block";

    // Populate user info
    const dashUsername = $("dashUsername");
    paintDashAvatar();
    if (dashUsername && authUser) dashUsername.textContent = authUser.username;

    // Collapse the avatar picker each time the dashboard is (re)opened
    const pickerPanel = $("avatarPickerPanel");
    if (pickerPanel) pickerPanel.style.display = "none";

    renderDashFriends(authUser?.friends || []);
    renderDashBlocked();
  }

  function closeDashboard() {
    const panel = $("dashboard-panel");
    if (panel) panel.style.display = "none";
  }

  /* ── Change avatar (from ჩემი გვერდი) ─────────────────────────────── */
  $("dashChangeAvatarBtn")?.addEventListener("click", () => {
    const pickerPanel = $("avatarPickerPanel");
    if (!pickerPanel) return;
    const showing = pickerPanel.style.display !== "none";
    if (showing) { pickerPanel.style.display = "none"; return; }

    renderAvatarGrid($("dash-avatar-grid"), authUser?.avatar, async (file) => {
      if (!authUser) return;
      const prev = authUser.avatar;
      authUser.avatar = file;
      paintDashAvatar(); // optimistic update

      try {
        const r = await fetch("/api/auth/avatar", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${authUser.token}` },
          body: JSON.stringify({ avatar: file }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "შეცდომა");
        showToast("✅ პროფილის სურათი განახლდა");
      } catch (e) {
        authUser.avatar = prev; // revert on failure
        paintDashAvatar();
        showToast("⚠️ სურათის შენახვა ვერ მოხერხდა");
      }
    });
    pickerPanel.style.display = "block";
  });

  $("dashClose")?.addEventListener("click", closeDashboard);
  $("dashOverlay")?.addEventListener("click", closeDashboard);

  $("dashRandomChat")?.addEventListener("click", () => {
    closeDashboard();
    // If already in a chat, press next; otherwise start searching
    const nextBtn = $("nextBtn");
    if (nextBtn) nextBtn.click();
  });

  /* ── Dashboard friends list ──────────────────────────────────────── */
  function renderDashFriends(friends) {
    const list  = $("dash-friends-list");
    const cnt   = $("dashFriendCount");
    if (!list) return;
    if (cnt) cnt.textContent = (friends || []).length;

    if (!friends || !friends.length) {
      list.innerHTML = `<div class="dash-empty">ჯერ მეგობრები არ გყავს.<br>
        <small>ჩატის დროს ➕ ღილაკზე დააჭირე.</small></div>`;
      return;
    }

    list.innerHTML = friends.map(f => `
      <div class="dash-friend-item" data-friend="${esc(f)}">
        <div class="dash-friend-avatar">${esc(f).charAt(0).toUpperCase()}</div>
        <span class="dash-friend-name">${esc(f)}</span>
        <div class="dash-friend-actions">
          <button class="dash-act-btn dash-act-chat"   data-f="${esc(f)}" title="Private Chat">💬</button>
          <button class="dash-act-btn dash-act-remove" data-f="${esc(f)}" title="მეგობრობის გაუქმება">✕</button>
          <button class="dash-act-btn dash-act-block"  data-f="${esc(f)}" title="სესიის ბლოკი">🚫</button>
        </div>
      </div>`).join("");

    list.querySelectorAll(".dash-act-chat").forEach(btn => {
      btn.addEventListener("click", () => {
        closeDashboard();
        openPrivateChat(btn.dataset.f);
      });
    });

    list.querySelectorAll(".dash-act-remove").forEach(btn => {
      btn.addEventListener("click", () => {
        const fname = btn.dataset.f;
        if (!confirm(`წაშალოთ ${esc(fname)} მეგობრებიდან?`)) return;
        authSocket?.emit("friend:remove", { friendUsername: fname });
      });
    });

    list.querySelectorAll(".dash-act-block").forEach(btn => {
      btn.addEventListener("click", () => {
        const fname = btn.dataset.f;
        if (!confirm(`დაბლოკოთ ${esc(fname)} ამ სესიაზე?`)) return;
        const lc = fname.toLowerCase();
        sessionBlocked.add(lc);
        authSocket?.emit("reg:sessionBlock", { targetUsername: lc });
        renderDashFriends(authUser?.friends || []);
        renderDashBlocked();
        showToast(`🚫 ${esc(fname)} — დაბლოკილია ამ სესიაზე`);
      });
    });

    paintFriendAvatars(friends, list);
  }

  /* Fetch real profile pictures for a list of usernames and swap them
     into the letter-circles inside the given container. */
  function paintFriendAvatars(usernames, container) {
    if (!usernames || !usernames.length || !container) return;
    fetch("/api/users/avatars", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usernames }),
    })
      .then(r => r.json())
      .then(d => {
        const avatars = d?.avatars || {};
        container.querySelectorAll("[data-friend]").forEach(item => {
          const lc = item.dataset.friend.toLowerCase();
          const file = avatars[lc];
          const av = item.querySelector(".dash-friend-avatar");
          if (file && av) av.innerHTML = `<img src="${AVATAR_DIR}${file}" alt="avatar" />`;
        });
      })
      .catch(() => {});
  }

  /* ── Dashboard blocked list ──────────────────────────────────────── */
  function renderDashBlocked() {
    const list    = $("dash-blocked-list");
    const section = $("dashBlockedSection");
    const cnt     = $("dashBlockedCount");
    if (!list || !section) return;

    const blocked = [...sessionBlocked];
    if (cnt) cnt.textContent = blocked.length;
    section.style.display = blocked.length ? "" : "none";

    if (!blocked.length) { list.innerHTML = ""; return; }

    list.innerHTML = blocked.map(u => `
      <div class="dash-friend-item" data-friend="${esc(u)}">
        <div class="dash-friend-avatar" style="background:rgba(242,63,66,0.15);color:#f23f42;">${esc(u).charAt(0).toUpperCase()}</div>
        <span class="dash-friend-name" style="color:#f23f42;">${esc(u)}</span>
        <button class="dash-act-btn dash-act-unblock" data-u="${esc(u)}" title="ბლოკის მოხსნა" style="color:#3ba55d;">✓</button>
      </div>`).join("");

    list.querySelectorAll(".dash-act-unblock").forEach(btn => {
      btn.addEventListener("click", () => {
        sessionBlocked.delete(btn.dataset.u);
        authSocket?.emit("reg:sessionUnblock", { targetUsername: btn.dataset.u });
        renderDashBlocked();
        renderDashFriends(authUser?.friends || []);
        showToast(`✅ ${esc(btn.dataset.u)} — ბლოკი მოხსნილია`);
      });
    });

    paintFriendAvatars(blocked, list);
  }

  /* ══════════════════════════════════════════════════════════════════
     PRIVATE CHAT PANEL (with friends — full chat features)
     ══════════════════════════════════════════════════════════════════ */
  function openPrivateChat(friend) {
    if (!authUser) return;
    privChatPartner = friend;
    privChatMessages = [];

    const panel = $("priv-panel");
    const title = $("priv-title");
    if (!panel) return;

    if (title) title.textContent = `🔒 ${friend}`;
    panel.style.display = "flex";

    const msgs = $("priv-messages");
    if (msgs) msgs.innerHTML = "";

    // Load history
    fetch(`/api/priv/history?username=${encodeURIComponent(authUser.username)}&friend=${encodeURIComponent(friend)}`, {
      headers: { "Authorization": `Bearer ${authUser.token}` }
    }).then(r => r.json()).then(d => {
      if (d.messages) {
        d.messages.forEach(m => appendPrivMsg(m.from, m.text, m.ts, m.from.toLowerCase() === authUser.username.toLowerCase()));
      }
    }).catch(() => {});

    setTimeout(() => {
      const inp = $("priv-input");
      if (inp) inp.focus();
    }, 100);
  }

  function closePrivateChat() {
    privChatPartner = null;
    privChatMessages = [];
    const panel = $("priv-panel");
    if (panel) panel.style.display = "none";
  }

  $("priv-close")?.addEventListener("click", closePrivateChat);

  function appendPrivMsg(from, text, ts, isMe) {
    const msgs = $("priv-messages");
    if (!msgs) return;

    const d  = document.createElement("div");
    d.className = isMe ? "priv-msg priv-msg-me" : "priv-msg priv-msg-them";

    const bubble = document.createElement("div");
    bubble.className = "priv-bubble";
    bubble.textContent = text;

    const time = document.createElement("div");
    time.className = "priv-ts";
    const dt = ts ? new Date(ts) : new Date();
    const h = dt.getHours(), m = dt.getMinutes();
    const ampm = h >= 12 ? "PM" : "AM";
    time.textContent = `${h%12||12}:${String(m).padStart(2,"0")} ${ampm}`;

    d.appendChild(bubble);
    d.appendChild(time);
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function sendPrivMsg() {
    if (!privChatPartner || !authUser) return;
    const inp = $("priv-input");
    if (!inp) return;
    const text = inp.value.trim();
    if (!text) return;
    inp.value = "";

    authSocket?.emit("privateMsg:send", { toUsername: privChatPartner, message: text });
    appendPrivMsg(authUser.username, text, new Date().toISOString(), true);
  }

  $("priv-send")?.addEventListener("click", sendPrivMsg);
  $("priv-input")?.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendPrivMsg(); }
  });

  /* ══════════════════════════════════════════════════════════════════
     FRIEND CHAT IN MAIN CHAT — when chatting with a friend
     The private chat panel opens on top for direct messaging.
     The main random chat can also continue with all features.
     ══════════════════════════════════════════════════════════════════ */

  // If we arrive from dashboard with a pending private chat open
  const pendingPriv = (() => {
    try { return JSON.parse(sessionStorage.getItem("gaicani_open_priv") || "null"); }
    catch (_) { return null; }
  })();
  if (pendingPriv?.friend) {
    sessionStorage.removeItem("gaicani_open_priv");
    setTimeout(() => {
      if (authUser) openPrivateChat(pendingPriv.friend);
    }, 500);
  }

  /* ══════════════════════════════════════════════════════════════════
     THREE-DOT MENU (⋮) for registered users
     Items: 🎮 Games | 🚩 Report | ინტერესები | ჩემი გვერდი
     ══════════════════════════════════════════════════════════════════ */
  function updateRegMenuVisibility() {
    const menuBtn = $("regMenuBtn");
    if (!menuBtn) return;
    // Available to every user now (guest or registered) — gating happens
    // when it's opened (must be actively chatting), not on visibility.
    menuBtn.style.display = "flex";

    // body.reg-user CSS shows the account-only items (Interests, My Page,
    // Logout) inside the dropdown and hides ინტ. from the main bar.
    document.body.classList.toggle("reg-user", !!authUser);
  }

  function toggleRegMenu(e) {
    const dd = $("regMenuDropdown");
    if (!dd) return;
    if (dd.style.display === "none" || !dd.style.display) {
      openRegMenu();
    } else {
      closeRegMenu();
    }
    e.stopPropagation();
  }

  function openRegMenu() {
    const dd = $("regMenuDropdown");
    if (dd) dd.style.display = "block";
  }

  function closeRegMenu() {
    const dd = $("regMenuDropdown");
    if (dd) dd.style.display = "none";
  }

  document.addEventListener("click", () => closeRegMenu());
  $("regMenuBtn")?.addEventListener("click", toggleRegMenu);

  // ── 🎨 ფონის შეცვლა — random-chat background picker ────────────────────
  // A device-local preference (not per-partner — random-chat partners
  // aren't a persistent identity the way friends are), same "only you see
  // it" spirit as the private-chat background picker.
  const RC_THEMES = [
    { id: "default", label: "სტანდარტული", css: "#1c1e24" },
    { id: "light",   label: "ღია", css: "linear-gradient(160deg, #f5f6fa 0%, #e4e7ef 100%)", light: true },
    { id: "pink",    label: "ვარდისფერი", css: "linear-gradient(160deg, #3a1a2e 0%, #55243f 45%, #1a0f18 100%)" },
    { id: "ocean",   label: "ოკეანე", css: "linear-gradient(160deg, #0d2b3a 0%, #123a4a 45%, #0a1620 100%)" },
    { id: "sunset",  label: "მზის ჩასვლა", css: "linear-gradient(160deg, #3a2408 0%, #4a2a3a 50%, #1a1020 100%)" },
  ];
  function rcThemeStorageKey() { return "gaicani_random_chat_theme"; }
  function rcLoadTheme() {
    try { return localStorage.getItem(rcThemeStorageKey()) || "default"; } catch (_) { return "default"; }
  }
  function rcApplyTheme(themeId) {
    const theme = RC_THEMES.find(t => t.id === themeId) || RC_THEMES[0];
    // Re-skins the WHOLE page (header, chat bubbles, input bar, menu) via a
    // body class — not just the chat message area. See the rc-theme-*
    // rules at the end of style.css for exactly what each theme touches.
    document.body.classList.remove("rc-theme-default", "rc-theme-light", "rc-theme-pink", "rc-theme-ocean", "rc-theme-sunset");
    document.body.classList.add(`rc-theme-${theme.id}`);
    const chat = $("chat");
    if (chat) {
      chat.classList.add("rc-bg-transition");
      chat.style.background = theme.css;
    }
  }
  function rcSaveTheme(themeId) {
    try { localStorage.setItem(rcThemeStorageKey(), themeId); } catch (_) { /* private-mode storage may reject writes — theme just won't persist */ }
  }
  function rcRenderThemeGrid() {
    const current = rcLoadTheme();
    const grid = $("rcThemeGrid");
    if (!grid) return;
    grid.innerHTML = "";
    RC_THEMES.forEach(theme => {
      const swatch = document.createElement("div");
      swatch.className = "rc-theme-swatch" + (theme.light ? " rc-light" : "") + (theme.id === current ? " selected" : "");
      swatch.style.background = theme.css;
      const label = document.createElement("div");
      label.className = "rc-theme-swatch-label";
      label.textContent = theme.label;
      swatch.appendChild(label);
      swatch.addEventListener("click", () => {
        rcApplyTheme(theme.id);
        rcSaveTheme(theme.id);
        grid.querySelectorAll(".rc-theme-swatch").forEach(s => s.classList.remove("selected"));
        swatch.classList.add("selected");
        setTimeout(closeRcThemeSheet, 220);
      });
      grid.appendChild(swatch);
    });
  }
  function openRcThemeSheet() {
    rcRenderThemeGrid();
    $("rcThemeSheet")?.classList.add("show");
    $("rcThemeBackdrop")?.classList.add("show");
  }
  function closeRcThemeSheet() {
    $("rcThemeSheet")?.classList.remove("show");
    $("rcThemeBackdrop")?.classList.remove("show");
  }
  $("rcThemeBackdrop")?.addEventListener("click", closeRcThemeSheet);
  rcApplyTheme(rcLoadTheme());

  $("regMenuTheme")?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeRegMenu();
    openRcThemeSheet();
  });

  // 🎮 Games
  $("regMenuGames")?.addEventListener("click", (e) => {
    // stopPropagation prevents the document-level outside-click listener in
    // games.js from firing on this same event and immediately re-closing the
    // game menu that _toggleGameMenu() is about to open.
    e.stopPropagation();
    closeRegMenu();
    if (!window.partnerConnected) {
      showToast("🎮 თამაშები მხოლოდ ჩატის დროს ხელმისაწვდომია");
      return;
    }
    if (typeof window._toggleGameMenu === "function") {
      window._toggleGameMenu();
    } else {
      showToast("🎮 თამაშები მხოლოდ ჩატის დროს ხელმისაწვდომია");
    }
  });

  // 🎮 Games Interests — opens the bio/interests popup for sharing gaming preferences
  $("regMenuGameInt")?.addEventListener("click", () => {
    closeRegMenu();
    const bioPopup = $("bioPopup");
    if (bioPopup) bioPopup.style.display = "flex";
  });

  // 🚩 Report — same logic as main report button
  $("regMenuReport")?.addEventListener("click", () => {
    closeRegMenu();
    const reportBtn = $("reportBtn");
    if (reportBtn && !reportBtn.disabled) {
      reportBtn.click();
    } else {
      showToast("🚩 რეპორტი მხოლოდ ჩატის დროს ხელმისაწვდომია");
    }
  });

  // 🎵 Music — same logic as the main music button (registered users only;
  // their music icon lives in this menu instead of the top bar)
  $("regMenuMusic")?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeRegMenu();
    const musicBtn = $("musicBtn");
    if (musicBtn && !musicBtn.disabled) {
      musicBtn.click();
    } else {
      showToast("🎵 მუსიკა მხოლოდ ჩატის დროს ხელმისაწვდომია");
    }
  });

  // ინტერესები (Interests)
  $("regMenuInt")?.addEventListener("click", () => {
    closeRegMenu();
    if (typeof window.openBioPopup === "function") window.openBioPopup();
  });

  // სახელის შეცვლა (Change Name) — calls the same modal-opening logic the
  // old standalone main-bar button used to run, now exposed directly since
  // that button no longer exists in the DOM at all (moved here entirely).
  $("regMenuChangeName")?.addEventListener("click", () => {
    closeRegMenu();
    if (typeof window.openChangeNameModal === "function") window.openChangeNameModal();
  });

  // ჩემი გვერდი (My Page) — navigate to the full dashboard page
  $("regMenuDash")?.addEventListener("click", () => {
    closeRegMenu();
    window.location.href = '/dashboard.html';
  });

  // Logout
  $("regMenuLogout")?.addEventListener("click", () => {
    closeRegMenu();
    if (!confirm("გამოხვიდეთ სისტემიდან?")) return;
    fetch("/api/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: authUser?.token }),
    }).catch(() => {});
    clearAuth();
    window.location.reload();
  });

  /* ══════════════════════════════════════════════════════════════════
     AUTO-LOGIN on page load (from localStorage)
     ══════════════════════════════════════════════════════════════════ */
  async function tryAutoLogin() {
    const { token, username } = loadAuth();
    if (!token || !username) return;

    try {
      const r = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const d = await r.json();
      if (!d.ok && !d.success) {
        clearAuth();
        return;
      }
      // Restore session silently
      authUser = {
        username: d.username || username,
        token,
        friends: d.friends || [],
        pendingRequests: d.pendingRequests || [],
        avatar: d.avatar || AVAILABLE_AVATARS[0],
      };
      window.gaicaniAuthUser = authUser;
      updateAuthBadge();
      updateRegMenuVisibility();
      bindSocketEvents();
      // Auto-fill and submit name so returning users skip the name modal
      autoSetNameAfterAuth(authUser.username);
    } catch (_) {
      // Network error — restore from local storage best-effort
      authUser = { username, token, friends: [], pendingRequests: [] };
      window.gaicaniAuthUser = authUser;
      updateAuthBadge();
      updateRegMenuVisibility();
      bindSocketEvents();
      autoSetNameAfterAuth(username);
    }
  }

  /* ── Expose openDashboard globally for any external callers ──────── */
  window.openDashboard = openDashboard;

  /* ── Init ────────────────────────────────────────────────────────── */
  document.addEventListener("DOMContentLoaded", () => {
    // Activate guest tab by default
    activateTab("guest");
    updateAuthBadge();
    updateRegMenuVisibility();
    // If there's no stored token at all, bind the guest identity right
    // away rather than waiting on tryAutoLogin (which only runs when a
    // token exists) — otherwise a guest's socket never gets _regUser set
    // here, and they'd never receive or send game invites while actually
    // on the random chat page itself (only on dashboard/game pages).
    const { token, username } = loadAuth();
    if (token && username) {
      tryAutoLogin();
    } else {
      bindSocketEvents();
    }
  });

})();
