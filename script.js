const socket = io();
attachTempBanGuard(socket);

window.socket = socket;

// A random id for this browser, kept in localStorage — lets 🛟 Support AI
// remember someone who said "don't ask me again" (no name, no IP).
const deviceId = (() => {
  try {
    let d = localStorage.getItem("gaicani_did");
    if (!/^[a-f0-9]{24}$/.test(d || "")) {
      d = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
      localStorage.setItem("gaicani_did", d);
    }
    return d;
  } catch (_) { return ""; }
})();
socket.on("connect", () => { if (deviceId) socket.emit("device", deviceId); });

// ── Bot Detection + Challenge Token ──────────────────────────────────────────
// Runs silently on page load. Checks for Selenium/WebDriver/headless signals.
// If detected: token is never fetched → setName fails → bot disconnected.

let _challengeToken  = null;
let _challengePow    = null; // computed proof-of-work answer
let _isBotDetected   = false;

function _detectBot() {
  try {
    // #1 — navigator.webdriver is TRUE in ALL WebDriver sessions
    //      (Selenium, Playwright, Puppeteer default mode). This is spec-mandated.
    if (navigator.webdriver === true) return true;

    // #2 — No plugins: headless Chrome / most bots have zero plugins
    if (!navigator.plugins || navigator.plugins.length === 0) return true;

    // #3 — No language list: automation tools often skip this
    if (!navigator.languages || navigator.languages.length === 0) return true;

    // #4 — Real Chrome always has window.chrome; modified/headless builds don't
    if (/Chrome/.test(navigator.userAgent) && !window.chrome) return true;

    // #5 — Selenium leaves traces in window properties
    if ('__webdriver_evaluate'        in window) return true;
    if ('__selenium_evaluate'         in window) return true;
    if ('__webdriver_script_function' in window) return true;
    if ('__fxdriver_evaluate'         in window) return true;
    if ('_phantom'                    in window) return true;
    if ('callPhantom'                 in window) return true;
    if ('__nightmare'                 in window) return true;
    if ('domAutomation'               in window) return true;
    if ('domAutomationController'     in window) return true;

    return false;
  } catch {
    return true; // if the check itself throws, treat as bot
  }
}

_isBotDetected = _detectBot();

if (!_isBotDetected) {
  // Fetch challenge token and compute proof-of-work
  fetch("/api/challenge")
    .then(r => r.json())
    .then(d => {
      _challengeToken = d.token;
      // POW: same formula as server expects — (nonce * 31 + nonce % 97)
      _challengePow   = (d.nonce * 31 + d.nonce % 97);
    })
    .catch(() => {});
}

// ── State ─────────────────────────────────────────────────────────────────────
let userName            = "";
let userBio             = "";
let partnerConnected    = false;
Object.defineProperty(window, 'partnerConnected', { get: () => partnerConnected });
let partnerName         = "";
let partnerIsVip        = false;
let partnerCardData     = null;   // what the partner profile popup shows
let isFirstLogin        = true;
let isReconnecting      = false;

let msgCounter          = 0;
let typingTimeout       = null;
let isTyping            = false;
let searchRetryInterval = null;
let pendingScrollRaf    = false;
let gifFetchController  = null;
let gifSearchTimer      = null;
let gifPickerOpen       = false;
let unreadCount         = 0;
let replyTo             = null;   // { text, senderName, messageId }
let lastPartnerName     = "";     // remember partner name after disconnect for blocking
let canBlockDisconnected = false; // allow blocking a partner who just left
const originalTitle     = document.title;

// Tab-away feature intentionally disabled — nothing happens when partner hides tab

// ── DOM refs ──────────────────────────────────────────────────────────────────
const chat           = document.getElementById("chat");
const messageInput   = document.getElementById("messageInput");
const sendBtn        = document.getElementById("sendBtn");
const nextBtn        = document.getElementById("nextBtn");
const scrollToTopBtn = document.getElementById("scrollToTopBtn");
const blockBtn       = document.getElementById("blockBtn");
const reportBtn      = document.getElementById("reportBtn");
const interestsBtn   = document.getElementById("interestsBtn");
const bioPopup       = document.getElementById("bioPopup");
const bioInput       = document.getElementById("bioInput");

// Every actual "block" action — regardless of which button/flow triggered
// it — should go through this single function instead of calling
// socket.emit("blockUser", ...) directly.
function emitBlockUser(targetName) {
  socket.emit("blockUser", { targetName });
}

const bioSaveBtn     = document.getElementById("bioSaveBtn");
const bioClearBtn    = document.getElementById("bioClearBtn");
const bioCharCount   = document.getElementById("bioCharCount");
const nameModal      = document.getElementById("nameModal");
const nameInput      = document.getElementById("nameInput");
const saveNameBtn    = document.getElementById("saveNameBtn");
const nameError      = document.getElementById("nameError");
const onlineCountEl  = document.getElementById("onlineCount");
const gifBtn         = document.getElementById("gifBtn");
const gifPicker      = document.getElementById("gifPicker");
const gifSearch      = document.getElementById("gifSearch");
const gifResults     = document.getElementById("gifResults");
const gifPickerClose = document.getElementById("gifPickerClose");
const charCount      = document.getElementById("charCount");
const questionBtn    = document.getElementById("questionBtn");
const replyPreview   = document.getElementById("replyPreview");
const replyPreviewName = document.getElementById("replyPreviewName");
const replyPreviewText = document.getElementById("replyPreviewText");
const replyPreviewClose = document.getElementById("replyPreviewClose");

// ── Sound ─────────────────────────────────────────────────────────────────────
let _audioCtx = null;

function getAudioCtx() {
  if (!_audioCtx) {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return _audioCtx;
}

// Browsers only let a page make sound after a tap or key press, and they
// pause it again when the page goes to the background (iPhone: "interrupted").
// So on every tap/key the sound is woken up again — created on the first
// one if needed, with a silent blip that unlocks it on iPhones — and woken
// when the page comes back to the front.
let _audioUnlocked = false;
function ensureAudioReady() {
  try {
    const ctx = getAudioCtx();
    if (ctx.state !== "running") ctx.resume().catch(() => {});
    if (!_audioUnlocked) {
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, 22050);
      src.connect(ctx.destination);
      src.start(0);
      _audioUnlocked = true;
    }
  } catch (_) { /* audio not supported */ }
}

["pointerdown", "touchend", "click", "keydown"].forEach((ev) => document.addEventListener(ev, ensureAudioReady, { passive: true, capture: true }));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && _audioCtx && _audioCtx.state !== "running") _audioCtx.resume().catch(() => {});
});

function playTone(freq, duration = 0.2, volume = 0.07) {
  try {
    const ctx = getAudioCtx();
    // Paused (background, idle) → wake it first, then play.
    if (ctx.state !== "running") { ctx.resume().then(() => { if (ctx.state === "running") playTone(freq, duration, volume); }).catch(() => {}); return; }
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  } catch (_) { /* audio not supported */ }
}

function playNotification(type) {
  if (type === "partnerFound") {
    playTone(880, 0.12); setTimeout(() => playTone(1100, 0.18), 110);
  } else if (type === "message") {
    playTone(660, 0.1, 0.04);
  }
}

// ── Tab unread badge ──────────────────────────────────────────────────────────
function incrementUnread() {
  if (document.hidden) {
    unreadCount++;
    document.title = `(${unreadCount}) ${originalTitle}`;
  }
}

// ── Tab visibility — reset unread badge + reconnect on foreground ─────────────
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    unreadCount    = 0;
    document.title = originalTitle;

    // If socket dropped while backgrounded, kick it to reconnect immediately
    if (!socket.connected && userName) {
      socket.connect();
    }
  }
});

// ── Scroll ────────────────────────────────────────────────────────────────────
function scheduleScroll() {
  if (pendingScrollRaf) return;
  pendingScrollRaf = true;
  requestAnimationFrame(() => {
    chat.scrollTop   = chat.scrollHeight;
    pendingScrollRaf = false;
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function generateMsgId() {
  return `${socket.id}_${++msgCounter}_${Date.now()}`;
}

function formatTimestamp(date) {
  const h    = date.getHours();
  const m    = date.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  const h12  = h % 12 || 12;
  return `${h12}:${m.toString().padStart(2, "0")} ${ampm}`;
}

function _appendInfoMessage(text, className, id) {
  const el       = document.createElement("div");
  el.className   = className;
  el.textContent = text;
  if (id) el.id  = id;
  chat.appendChild(el);
  scheduleScroll();
}

function addSystemMessage(text)            { _appendInfoMessage(text, "system-message"); }
function addSystemHintMessage(text, extraClass) {
  _appendInfoMessage(text, extraClass ? `system-message-hint ${extraClass}` : "system-message-hint");
}
function addSystemBigMessage(text)         { _appendInfoMessage(text, "system-message-big"); }

// ── Registration promo card — shown once to guests right after the
//    "დააჭირეთ ღილაკს" hint, before their first search. Skipped entirely
//    for already-registered users (window.gaicaniAuthUser is set by
//    auth-client.js once a token is confirmed).

// ── Donation card — shown in the chat feed right after the "press the button
//    to search" hint. Unlike the register promo this is shown to EVERYONE,
//    registered users included. Built with DOM nodes rather than innerHTML.
function addDonationCard() {
  const card = document.createElement("div");
  card.className = "chat-donate-card";

  const txt = document.createElement("div");
  txt.className = "chat-donate-text";
  txt.appendChild(document.createTextNode("💜 მხარი დაუჭირე Gaicani.online-ს მცირე დონაციით 🙏"));
  txt.appendChild(document.createElement("br"));
  txt.appendChild(document.createTextNode("შენი დახმარება საიტის განვითარებასა და გაუმჯობესებას მოხმარდება 🚀"));
  txt.appendChild(document.createElement("br"));
  txt.appendChild(document.createTextNode("ნებისმიერი თანხა ჩვენთვის მნიშვნელოვანია ❤️"));

  const btn = document.createElement("a");
  btn.className = "chat-donate-btn";
  btn.href = "https://www.kisa.ge/donate/8fvhi1xii0";
  btn.target = "_blank";
  btn.rel = "noopener noreferrer";
  btn.textContent = "მხარდაჭერა 💜";

  card.appendChild(txt);
  card.appendChild(btn);
  chat.appendChild(card);
  scheduleScroll();
}

function addRegisterPromoCard() {
  if (window.gaicaniAuthUser) return;

  const card = document.createElement("div");
  card.className = "register-promo-card";
  card.innerHTML = `
    <div class="register-promo-title">✨ რატომ დარეგისტრირდე?</div>
    <div class="register-promo-line">
      <div class="rp-item"><span class="rp-ico">👤</span><div><b>დაიკავე შენი უნიკალური სახელი</b><br>შექმენი შენი username და შეინარჩუნე შენი პროფილი.</div></div>
      <div class="rp-item"><span class="rp-ico">💘</span><div><b>Trinder — გაიცანი ახალი ადამიანები</b><br>დაათვალიერე მომხმარებლების პროფილები, მოიწონე ისინი და თუ მოწონება ორმხრივი იქნება — <b>დამეჩდით!</b> ❤️</div></div>
      <div class="rp-item"><span class="rp-ico">👥</span><div><b>დაამატე მეგობრები</b><br>შეინახე საინტერესო ადამიანები და აღარ დაკარგო ისინი.</div></div>
      <div class="rp-item"><span class="rp-ico">💬</span><div><b>პირადი ჩათი</b><br>ესაუბრე მეგობრებს პირადად.</div></div>
      <div class="rp-item"><span class="rp-ico">🎵</span><div><b>მოუსმინეთ მუსიკას ერთად <i>(Limited)</i></b><br>მოუსმინე მუსიკას მეგობრებთან ერთად.</div></div>
      <div class="rp-item"><span class="rp-ico">❤️</span><div><b>რეაქციები, სურათები და ჩათის ფონები</b><br>გახადე შენი საუბრები უფრო საინტერესო.</div></div>
      <div class="rp-item"><span class="rp-ico">🏠</span><div><b>ოთახები</b><br>შექმენი ან შეუერთდი სხვადასხვა თემატურ ოთახებს.</div></div>
      <div class="rp-item"><span class="rp-ico">🗣️</span><div><b>დებატები და ფორუმი</b><br>გამოხატე შენი აზრი და გაიცანი ადამიანები საერთო ინტერესებით.</div></div>
      <div class="rp-item"><span class="rp-ico">🎮</span><div><b>თამაშები</b><br>ითამაშე ონლაინ თამაშები სხვა მომხმარებლებთან.</div></div>
      <div class="rp-item"><span class="rp-ico">🖼️</span><div><b>შექმენი შენი პროფილი</b><br>დაამატე ფოტო, „ჩემ შესახებ“ და სხვა ინფორმაცია.</div></div>
      <div class="rp-item"><span class="rp-ico">🔥</span><div><b>აქტივობა და streak-ები</b><br>შეინარჩუნე ზედიზედ შესვლის დღეები და აჩვენე შენი აქტივობა.</div></div>
      <hr class="rp-hr">
      <div class="rp-cta"><b>🚀 რეგისტრაცია სულ რამდენიმე წამს გრძელდება!</b></div>
      ✏️ მხოლოდ <b>სახელი + პაროლი</b><br>
      📧 <b>ელფოსტა არ არის საჭირო</b><br>
      💳 <b>მარტივი რეგისტრაცია</b>
      <div class="rp-cta">🔥 <b>დარეგისტრირდი და აღმოაჩინე Gaicani.online-ის სრული შესაძლებლობები!</b></div>
    </div>`;
  card.addEventListener("click", () => {
    const signupTab = document.getElementById("auth-tab-signup");
    if (signupTab) signupTab.click();
    if (nameModal) nameModal.style.display = "flex";
  });
  chat.appendChild(card);
  scheduleScroll();
}

// ── System message with an inline image (used for the press-counter hint) ──
function addSystemImageMessage(imgSrc, altText) {
  const el       = document.createElement("div");
  el.className   = "system-message system-message--with-image";

  const img       = document.createElement("img");
  img.src         = imgSrc;
  img.alt         = altText || "";
  img.loading     = "lazy";
  img.style.maxWidth    = "100%";
  img.style.borderRadius = "10px";
  img.style.display     = "block";
  img.style.margin      = "8px auto 0";

  el.appendChild(img);
  chat.appendChild(el);
  scheduleScroll();
}

// ── Partner-found card (avatar + name + status) ─────────────────────────────
// ── Partner profile popup — tap the partner's card or their name in the
//    header. All user text goes in via textContent (never innerHTML).
// 🛟 The real Support account (guests can't take the name) and the Support
// AI that asks for feedback: no card, no report — nobody adds or reports them.
function isSupportName(n) { return /^support( ai)?$/i.test(String(n || "").trim()); }
function openPartnerProfile() {
  const d = partnerCardData;
  if (!d || isSupportName(d.name)) return;
  document.getElementById("partnerProfileOverlay")?.remove();
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const ov = el("div", "pp-overlay"); ov.id = "partnerProfileOverlay";
  const card = el("div", "pp-card"); card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "true");
  const close = el("button", "pp-close", "✕"); close.type = "button"; close.setAttribute("aria-label", "დახურვა");
  const av = el("div", "pp-avatar");
  if (d.avatar) { const img = el("img"); img.src = "/" + d.avatar; img.alt = ""; av.appendChild(img); }
  else av.textContent = (d.name || "?").charAt(0).toUpperCase();
  const name = el("div", "pp-name", d.name || "");
  if (d.isVip) { const v = el("span", "vip-badge"); v.innerHTML = 'VIP <span class="pro-star">⭐</span>'; name.appendChild(v); }
  card.append(close, av, name);
  if (!d.profile) {
    card.appendChild(el("div", "pp-guest", "👤 სტუმარი — ჯერ არ დარეგისტრირებულა"));
  } else {
    card.appendChild(el("div", "pp-bio" + (d.bio ? "" : " empty"), d.bio || "ბიოგრაფია ჯერ არ დაუწერია"));
    const p = d.profile, chips = [];
    if (p.age) chips.push("🎂 " + p.age + " წლის");
    if (p.gender === "male") chips.push("👨 კაცი"); else if (p.gender === "female") chips.push("👩 ქალი");
    if (p.city) chips.push("📍 " + p.city);
    if (p.study) chips.push("🎓 " + p.study);
    if (p.work) chips.push("💼 " + p.work);
    if (chips.length) { const w = el("div", "pf-chips"); chips.forEach(t => w.appendChild(el("span", "pf-chip", t))); card.appendChild(w); }
  }
  ov.appendChild(card); document.body.appendChild(ov);
  const shut = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") shut(); };
  close.addEventListener("click", shut);
  ov.addEventListener("click", (e) => { if (e.target === ov) shut(); });
  document.addEventListener("keydown", onKey);
}
document.getElementById("partnerNameDisplay")?.addEventListener("click", () => { if (partnerName) openPartnerProfile(); });

function addPartnerFoundCard(name, isVip) {
  const card       = document.createElement("div");
  card.className   = "partner-found-card";

  const avatar     = document.createElement("div");
  avatar.className = "pfc-avatar";
  avatar.textContent = (name || "?").charAt(0).toUpperCase();

  const info       = document.createElement("div");
  info.className   = "pfc-info";

  const nameEl       = document.createElement("div");
  nameEl.className   = "pfc-name";
  nameEl.textContent = name;
  if (isVip) {
    const vip = document.createElement("span");
    vip.className = "vip-badge";
    vip.innerHTML = "VIP <span class=\"pro-star\">⭐</span>";
    nameEl.appendChild(vip);
  }

  const statusEl       = document.createElement("div");
  statusEl.className   = "pfc-status";
  statusEl.textContent = "პარტნიორი ნაპოვნია";

  info.appendChild(nameEl);
  info.appendChild(statusEl);
  card.appendChild(avatar);
  card.appendChild(info);
  card.title = "პროფილის ნახვა";
  card.style.cursor = "pointer";
  card.addEventListener("click", openPartnerProfile);   // tap the card → partner's profile
  chat.appendChild(card);
  scheduleScroll();

  // The picture that came with the match (registered people, 🛟 Support AI)
  // is used straight away; otherwise it's looked up by name.
  const known = partnerCardData && partnerCardData.name === name ? partnerCardData.avatar : null;
  if (known) {
    const img = document.createElement("img");
    img.src = "/" + known; img.alt = "avatar";
    avatar.textContent = ""; avatar.appendChild(img);
    return;
  }
  // Load the partner's real profile picture if they're a registered user,
  // otherwise fall back to the default (unregistered) picture.
  const DEFAULT_PARTNER_PIC = "/images%20(1).jpeg";
  fetch("/api/users/avatars", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usernames: [name] }),
  })
    .then(r => r.json())
    .then(d => {
      const file = d?.avatars?.[(name || "").toLowerCase()];
      avatar.innerHTML = `<img src="${file ? "/" + file : DEFAULT_PARTNER_PIC}" alt="avatar" />`;
    })
    .catch(() => {
      avatar.innerHTML = `<img src="${DEFAULT_PARTNER_PIC}" alt="avatar" />`;
    });
}
function addDisconnectMessage(text)        { _appendInfoMessage(text, "system-message-disconnect"); }
function addReconnectingMessage(name)      {
  document.getElementById("reconnectingMsg")?.remove();
  _appendInfoMessage(
    `${name} - კავშირი გაწყდა, ველოდებით... ⏳`,
    "system-message-reconnecting",
    "reconnectingMsg"
  );
}
function removeReconnectingMessage()       { document.getElementById("reconnectingMsg")?.remove(); }

// ── Searching message with random fact ───────────────────────────────────────
function addSearchingMessage() {
  // Remove any existing searching block
  document.getElementById("searchingMsg")?.remove();
  // Ensure inputs are disabled while searching so user can't type into a non-existent chat
  setInputsEnabled(false);

  const wrapper     = document.createElement("div");
  wrapper.id        = "searchingMsg";
  wrapper.className = "searching-block";

  const searchText       = document.createElement("div");
  searchText.className   = "system-message";
  searchText.textContent = "ვეძებთ ახალ პარტნიორს... 🔎";
  wrapper.appendChild(searchText);

  // Fact card
  const factCard       = document.createElement("div");
  factCard.className   = "fact-card";

  const factLabel       = document.createElement("span");
  factLabel.className   = "fact-label";
  factLabel.textContent = "💡 RANDOM FACT";

  const factText       = document.createElement("span");
  factText.className   = "fact-text";
  factText.textContent = "...";

  // Arrow button — bottom-right corner
  const nextFactBtn       = document.createElement("button");
  nextFactBtn.className   = "fact-next-btn";
  nextFactBtn.title       = "სხვა ფაქტი";
  nextFactBtn.textContent = "→";

  factCard.appendChild(factLabel);
  factCard.appendChild(factText);
  factCard.appendChild(nextFactBtn);
  wrapper.appendChild(factCard);


  
  const warningEl = document.createElement("div");
  warningEl.className = "searching-warning";
  warningEl.textContent = "⚠️ WARNING : გთხოვთ არ ჩაკეცოთ ბრაუზერი";
  wrapper.appendChild(warningEl);

  chat.appendChild(wrapper);
  scheduleScroll();

  function loadFact() {
    nextFactBtn.classList.add("spinning");
    fetch("/api/random-fact")
      .then(r => r.json())
      .then(data => {
        if (data.fact) {
          // Fade out → swap text → fade in
          factText.style.transition = "opacity 0.15s";
          factText.style.opacity    = "0";
          setTimeout(() => {
            factText.textContent      = data.fact;
            factText.style.opacity    = "1";
          }, 150);
        }
      })
      .catch(() => {
        factText.textContent = "ფაქტი ვერ ჩაიტვირთა 😕";
      })
      .finally(() => {
        nextFactBtn.classList.remove("spinning");
      });
  }

  // Load initial fact
  loadFact();

  // Arrow click → load next fact
  nextFactBtn.addEventListener("click", loadFact);
}

function addMessage(text, isYou, messageId, replyToData) {
  const id = messageId || generateMsgId();

  const wrapper         = document.createElement("div");
  wrapper.className     = `message-wrapper ${isYou ? "you" : "partner"}`;
  wrapper.dataset.messageId = id;

  // ── Reply quote block ────────────────────────────────────────────────────
  if (replyToData && replyToData.text) {
    const quote       = document.createElement("div");
    quote.className   = `reply-quote ${isYou ? "you" : "partner"}`;

    if (replyToData.senderName) {
      const quoteName       = document.createElement("span");
      quoteName.className   = "reply-quote-name";
      quoteName.textContent = replyToData.senderName;
      quote.appendChild(quoteName);
    }

    const quoteText       = document.createElement("span");
    quoteText.className   = "reply-quote-text";
    const raw = replyToData.text;
    quoteText.textContent = raw.length > 80 ? raw.slice(0, 80) + "…" : raw;

    quote.appendChild(quoteText);
    wrapper.appendChild(quote);
  }

  const msgRow      = document.createElement("div");
  msgRow.className  = "message-row";

  const content     = document.createElement("div");
  content.className = `message-content${isYou ? " you" : ""}`;
  content.textContent = text;

  const timestamp       = document.createElement("div");
  timestamp.className   = "timestamp inline-ts";
  timestamp.textContent = formatTimestamp(new Date());

  // ── Reply button ──────────────────────────────────────────────────────────
  const replyBtn     = document.createElement("button");
  replyBtn.className = "reply-btn";
  replyBtn.innerHTML = "↩";
  replyBtn.title     = "Reply";
  replyBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setReplyTo({
      text,
      senderName: isYou ? userName : (partnerName || "Partner"),
      messageId: id,
    });
  });

  if (isYou) {
    // You: [reply-btn]  [timestamp]  [bubble]
    msgRow.appendChild(replyBtn);
    msgRow.appendChild(timestamp);
    msgRow.appendChild(content);
  } else {
    // Partner: [bubble]  [react-btn]  [reply-btn]  [timestamp]
    const reactBtn     = document.createElement("button");
    reactBtn.className = "react-btn";
    reactBtn.innerHTML = "🙂";
    reactBtn.title     = "React";
    reactBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      showReactionPicker(reactBtn, id);
    });
    msgRow.appendChild(content);
    msgRow.appendChild(reactBtn);
    msgRow.appendChild(replyBtn);
    msgRow.appendChild(timestamp);
  }

  const reactionArea    = document.createElement("div");
  reactionArea.className = "reaction-area";
  reactionArea.id       = `reactions_${id}`;

  wrapper.appendChild(msgRow);
  wrapper.appendChild(reactionArea);

  // Seen indicator — only for messages you sent
  if (isYou) {
    const seen       = document.createElement("div");
    seen.className   = "seen-status";
    seen.id          = `seen_${id}`;
    seen.textContent = "✓";
    wrapper.appendChild(seen);
  }

  chat.appendChild(wrapper);
  scheduleScroll();
  return id;
}

function addGifMessage(gifUrl, isYou) {
  const wrapper     = document.createElement("div");
  wrapper.className = `message-wrapper gif-msg-wrapper ${isYou ? "you" : "partner"}`;

  const img       = document.createElement("img");
  img.src         = gifUrl;
  img.className   = "gif-message-img";
  img.loading     = "lazy";
  img.decoding    = "async";

  const timestamp       = document.createElement("div");
  timestamp.className   = "timestamp";
  timestamp.textContent = formatTimestamp(new Date());

  wrapper.appendChild(img);
  wrapper.appendChild(timestamp);
  chat.appendChild(wrapper);
  scheduleScroll();
}

// ── Question card ─────────────────────────────────────────────────────────────
function addQuestionCard(questionText, isYou) {
  const card       = document.createElement("div");
  card.className   = `question-card ${isYou ? "you" : "partner"}`;

  const label      = document.createElement("div");
  label.className  = "question-card-label";
  label.textContent = isYou ? "❓ შენ გამოგზავნე კითხვა" : `❓ ${partnerName || "პარტნიორი"} გიგზავნის კითხვას`;

  const text       = document.createElement("div");
  text.className   = "question-card-text";
  text.textContent = questionText;

  const ts         = document.createElement("div");
  ts.className     = "timestamp";
  ts.textContent   = formatTimestamp(new Date());

  card.appendChild(label);
  card.appendChild(text);
  card.appendChild(ts);
  chat.appendChild(card);
  scheduleScroll();
}

// ── Typing indicator (inline chat bubble) ──────────────────────────────────
// Rendered as a real message-list entry, styled like a partner bubble, sitting
// wherever the partner's next message will land. hideTypingIndicator() removes
// it outright, so the real message (added right after) drops into that spot.

function showTypingIndicator() {
  if (document.getElementById("liveTypingBubble")) return; // already showing
  const el     = document.createElement("div");
  el.id        = "liveTypingBubble";
  el.className = "typing-indicator";
  el.innerHTML = "<span></span><span></span><span></span>";
  chat.appendChild(el); // sits in the message flow, right where the partner's next message will land
  scheduleScroll();
}

function hideTypingIndicator() {
  const el = document.getElementById("liveTypingBubble");
  if (el) el.remove();
}

function clearChat() { chat.innerHTML = ""; clearReply(); }

// ── Floating "go to start of chat" button ───────────────────────────────────
function showScrollToTopBtn() { if (scrollToTopBtn) scrollToTopBtn.style.display = "flex"; }
if (scrollToTopBtn) {
  scrollToTopBtn.addEventListener("click", () => {
    chat.scrollTo({ top: 0, behavior: "smooth" });
  });
}

// Stub — countdown was removed but the call site still references this
function clearPartnerAwayCountdown() {}

function updateOnlineCount(count) {
  onlineCountEl.textContent = `Users: ${count + 30}`;
}

// ── Reply helpers ──────────────────────────────────────────────────────────────
function setReplyTo({ text, senderName, messageId }) {
  replyTo = { text, senderName, messageId };
  replyPreviewName.textContent = senderName;
  replyPreviewText.textContent = text.length > 80 ? text.slice(0, 80) + "…" : text;
  replyPreview.style.display = "flex";
  messageInput.focus();
}

function clearReply() {
  replyTo = null;
  replyPreview.style.display = "none";
  replyPreviewName.textContent = "";
  replyPreviewText.textContent = "";
}

replyPreviewClose.addEventListener("click", () => clearReply());

function setInputsEnabled(enabled) {
  setTimeout(refreshPhotoBtn, 0); // 📷 follows the chat (VIP only)
  messageInput.disabled   = !enabled;
  messageInput.readOnly   = !enabled;
  messageInput.style.pointerEvents = enabled ? "" : "none";
  sendBtn.disabled        = !enabled;
  gifBtn.disabled         = !enabled;
  questionBtn.disabled    = !enabled;
  if (!enabled) {
    // Clear any text typed during a race (e.g. keyboard still open while searching)
    messageInput.value = "";
    messageInput.style.height = "auto";
    charCount.textContent = "";
    charCount.classList.remove("warning");
    messageInput.blur();
  }
  // blockBtn is managed separately via updateBlockBtn()
}

// Block button is enabled when chatting OR when partner just left normally.
// Report button is enabled when chatting OR when partner just disconnected.
// It stays disabled during the reconnecting grace-period.
function updateBlockBtn() {
  blockBtn.disabled  = !(partnerConnected || canBlockDisconnected);
  if (reportBtn) reportBtn.disabled = !(partnerConnected || canBlockDisconnected) || isSupportName(partnerName || lastPartnerName);
}

function setPartnerNameDisplay(name, isVip) {
  const el = document.getElementById("partnerNameDisplay");
  if (!el) return;
  el.innerHTML = ""; // clear, then rebuild with safe DOM nodes below
  if (name) {
    el.appendChild(document.createTextNode(`👤 ${name}`));
    if (isVip) {
      const vip = document.createElement("span");
      vip.className = "vip-badge";
      vip.innerHTML = "VIP <span class=\"pro-star\">⭐</span>";
      el.appendChild(vip);
    }
    el.style.opacity = "1";
    el.style.color = "";
  } else {
    el.appendChild(document.createTextNode("👤 ---"));
    el.style.opacity = "0.25";
  }
}

function showNameError(msg) {
  nameError.textContent   = msg;
  nameError.style.display = "block";
  const _ov = document.getElementById("modalLoadingOverlay");
  if (_ov) _ov.style.display = "none";
  nameInput.classList.add("error");
}

function clearNameError() {
  nameError.textContent   = "";
  nameError.style.display = "none";
  nameInput.classList.remove("error");
}

// ── Toast popup — used for name-change confirmation ───────────────────────────
function showToast(text, duration = 3000) {
  document.querySelectorAll(".toast-popup").forEach(t => t.remove());
  const toast       = document.createElement("div");
  toast.className   = "toast-popup";
  toast.textContent = text;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("toast-visible"));
  setTimeout(() => {
    toast.classList.remove("toast-visible");
    setTimeout(() => toast.remove(), 350);
  }, duration);
}

// ── Search retry ──────────────────────────────────────────────────────────────
// No client-side polling needed. The server's tryFindPartner() already queues
// the socket and pairs it automatically when a match arrives. All call sites
// that used startSearchRetry() are now no-ops so they compile safely.
function startSearchRetry() { /* no-op — server handles pairing */ }

function stopSearchRetry() {
  if (searchRetryInterval !== null) {
    clearInterval(searchRetryInterval);
    searchRetryInterval = null;
  }
}

// ── GIF Picker ────────────────────────────────────────────────────────────────
const TENOR_PROXY = "/api/gifs"; // key stays on the server

async function fetchGifs(query) {
  if (gifFetchController) gifFetchController.abort();
  // Hold our own reference: gifFetchController is shared state and a newer
  // search may replace it while this one is still awaiting.
  const myController = new AbortController();
  gifFetchController = myController;
  gifResults.innerHTML = '<div class="gif-placeholder">Loading...</div>';

  try {
    const url  = query ? `${TENOR_PROXY}?q=${encodeURIComponent(query)}` : TENOR_PROXY;
    const res  = await fetch(url, { signal: myController.signal });
    const data = await res.json();
    // Ignore results from a search that has since been superseded, so a
    // slow older response can't overwrite newer results.
    if (gifFetchController !== myController) return;
    renderGifResults(data.results || []);
  } catch (err) {
    if (err.name !== "AbortError" && gifFetchController === myController) {
      gifResults.innerHTML = '<div class="gif-placeholder">Failed to load GIFs 😢</div>';
    }
  } finally {
    // Only clear it if we're still the current request. Clearing
    // unconditionally wiped the reference to a NEWER in-flight controller,
    // so the next search couldn't abort it and two responses would race.
    if (gifFetchController === myController) gifFetchController = null;
  }
}

function renderGifResults(results) {
  const frag = document.createDocumentFragment();
  if (!results.length) {
    const ph = document.createElement("div");
    ph.className = "gif-placeholder";
    ph.textContent = "No GIFs found";
    gifResults.innerHTML = "";
    gifResults.appendChild(ph);
    return;
  }
  const col1 = document.createElement("div");
  const col2 = document.createElement("div");
  col1.className = "gif-col";
  col2.className = "gif-col";
  results.forEach((result, i) => {
    const media      = result.media[0];
    const previewUrl = media.tinygif?.url || media.gif?.url;
    const fullUrl    = media.gif?.url;
    if (!previewUrl || !fullUrl) return;
    const img        = document.createElement("img");
    img.src          = previewUrl;
    img.className    = "gif-item";
    img.loading      = "lazy";
    img.decoding     = "async";
    img.addEventListener("click", () => sendGif(fullUrl, previewUrl));
    (i % 2 === 0 ? col1 : col2).appendChild(img);
  });
  frag.appendChild(col1);
  frag.appendChild(col2);
  gifResults.innerHTML = "";
  gifResults.appendChild(frag);
}

// ── Visual Viewport — drives BOTH the input bar and GIF picker ────────────────
// On iOS Safari the keyboard (+ its accessory bar) shrinks the visual viewport
// but NOT the layout viewport, so position:fixed elements stay hidden behind it.
// We read the gap and push everything up by exactly that amount — the same trick
// Instagram uses so their input sits flush above the keyboard with no extra bar.
const chatInputBar = document.querySelector(".chat-input");

function getKeyboardHeight() {
  if (!window.visualViewport) return 0;
  const vv = window.visualViewport;
  return Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
}

function updateViewportOffsets() {
  const vv  = window.visualViewport;
  const kbH = getKeyboardHeight();

  // ── iOS Safari: use the actual visual-viewport height to clamp the body ──
  // This prevents the layout from overflowing when the address bar is visible.
  document.body.style.height = kbH > 0 ? vv.height + "px" : "";

  // Toggle a class so CSS can zoom out messages slightly when keyboard is open.
  // Use a small threshold (> 80) to avoid triggering on iOS toolbar-resize jitter.
  document.body.classList.toggle("keyboard-open", kbH > 80);

  // Input bar is position:fixed (layout-viewport coords) so it needs shifting
  // up by the full keyboard height (Safari accessory bar included).
  // When keyboard is closed, reset to 0 so CSS env(safe-area-inset-bottom) takes over.
  chatInputBar.style.bottom     = kbH > 0 ? kbH + "px" : "";
  chatInputBar.style.transition = kbH === 0 ? "bottom 0.22s ease" : "none";
  syncInputWithPicker(); // the 😊 panel open → the bar sits on top of it

  // GIF picker: bottom sheet sits flush above keyboard
  if (gifPickerOpen) {
    gifPicker.style.bottom = kbH + "px";
  }

  // Pin scroll to bottom whenever the viewport shifts
  scheduleScroll();
}

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", updateViewportOffsets, { passive: true });
  window.visualViewport.addEventListener("scroll", updateViewportOffsets, { passive: true });
  // Run once on load so the input bar and chat area start at the right position
  // (important on iOS where env(safe-area-inset-bottom) must be applied early)
  updateViewportOffsets();
} else {
  // Fallback for very old iOS Safari that doesn't support visualViewport
  window.addEventListener("resize", updateViewportOffsets, { passive: true });
}

function updateGifPickerPosition() {
  if (!gifPickerOpen) return;
  const kbH = getKeyboardHeight();
  gifPicker.style.bottom = kbH + "px";
}

// The panel has two tabs: 🥟 stickers and GIF (see stickers.js). Its ✕ moves
// into the tab row, so the GIF header is just the search box.
const openMediaTab = window.GaicaniStickers
  ? window.GaicaniStickers.attach(gifPicker, {
      gifEls: [gifSearch.closest(".gif-picker-header"), gifResults],
      input: messageInput, // 😊 tab: emoji go into the message
      onPick: sendSticker,
      onGifs: () => { gifSearch.value = ""; gifSearch.focus(); fetchGifs(""); },
      onClose: () => closeGifPickerPanel(),
    })
  : () => true;
if (window.GaicaniStickers) gifPickerClose.style.display = "none";

// Like Messenger: while the 😊 panel is open the message bar rides on top of
// it (and the chat makes room above), so you can see what you're typing —
// before, the panel slid over the bar and hid it.
function syncInputWithPicker() {
  const kbH = getKeyboardHeight();
  // Keyboard up as well (typing a GIF search): no room for the bar too, so
  // it waits under the panel until the keyboard goes.
  const ph = gifPickerOpen && kbH <= 80 ? gifPicker.offsetHeight : 0;
  if (!ph) {
    if (chatInputBar.dataset.overPicker) {
      delete chatInputBar.dataset.overPicker;
      chatInputBar.style.bottom = kbH > 0 ? kbH + "px" : "";
      chat.style.paddingBottom = "";
    }
    return;
  }
  chatInputBar.dataset.overPicker = "1";
  chatInputBar.style.transition = "bottom 0.28s cubic-bezier(0.32, 0.72, 0, 1)";
  chatInputBar.style.bottom = (kbH + ph) + "px";
  chat.style.paddingBottom = `calc(${ph + chatInputBar.offsetHeight + 12}px + env(safe-area-inset-bottom, 0px))`;
  scheduleScroll();
}
if (window.ResizeObserver) new ResizeObserver(() => syncInputWithPicker()).observe(gifPicker);

function openGifPicker() {
  const kbH = getKeyboardHeight();
  gifPicker.style.display = "flex";
  // Force reflow so the transition fires from off-screen position
  gifPicker.getBoundingClientRect();
  gifPicker.style.bottom = kbH + "px";
  gifPickerOpen = true;
  const gifTab = openMediaTab();
  // Like Messenger, the panel takes the keyboard's place: close the keyboard.
  if (!gifTab && document.activeElement === messageInput) messageInput.blur();
  syncInputWithPicker();
  if (!gifTab) return; // emoji / sticker tab — nothing to load, no keyboard
  gifSearch.value = "";
  gifSearch.focus();
  fetchGifs("");
}

function closeGifPickerPanel() {
  gifPicker.style.bottom = "-100%";
  gifPickerOpen = false;
  syncInputWithPicker();
  // Hide after slide-out animation
  setTimeout(() => {
    if (!gifPickerOpen) gifPicker.style.display = "none";
  }, 300);
}

gifBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  gifPickerOpen ? closeGifPickerPanel() : openGifPicker();
});

gifPickerClose.addEventListener("click", (e) => { e.stopPropagation(); closeGifPickerPanel(); });

gifSearch.addEventListener("input", () => {
  clearTimeout(gifSearchTimer);
  gifSearchTimer = setTimeout(() => fetchGifs(gifSearch.value.trim()), 400);
});

gifSearch.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Enter") e.preventDefault();
});

// …and the other way round: the keyboard coming up for the message (tap,
// send, reply…) closes the panel, so the two never pile up on the screen.
messageInput.addEventListener("focus", () => { if (gifPickerOpen) closeGifPickerPanel(); });

// A tap outside closes the panel — except on the message bar's buttons (send
// closes it itself once the message is out). Tapping the text box closes it,
// like Messenger, since the keyboard takes its place.
document.addEventListener("click", (e) => {
  if (!gifPickerOpen || gifPicker.contains(e.target) || e.target === gifBtn) return;
  if (chatInputBar.contains(e.target) && e.target !== messageInput) return;
  closeGifPickerPanel();
});

function sendGif(fullUrl, previewUrl) {
  if (!partnerConnected) return;
  socket.emit("gif", { url: fullUrl, preview: previewUrl });
  addGifMessage(fullUrl, true);
  closeGifPickerPanel();
}

socket.on("gif", (data) => addGifMessage(data.url, false));

function sendSticker(id) {
  if (!partnerConnected) return;
  socket.emit("sticker", { id });
  addStickerMessage(id, true);
  closeGifPickerPanel();
}
function addStickerMessage(id, isYou) {
  const img = window.GaicaniStickers && window.GaicaniStickers.img(id);
  if (!img) return;
  const wrapper     = document.createElement("div");
  wrapper.className = `message-wrapper gif-msg-wrapper sticker-msg-wrapper ${isYou ? "you" : "partner"}`;
  const timestamp       = document.createElement("div");
  timestamp.className   = "timestamp";
  timestamp.textContent = formatTimestamp(new Date());
  wrapper.appendChild(img);
  wrapper.appendChild(timestamp);
  chat.appendChild(wrapper);
  scheduleScroll();
}
socket.on("sticker", (data) => addStickerMessage(data && data.id, false));

// ── Report Reason Modal ──────────────────────────────────────────────────────
// ── Custom confirm modal — replaces native confirm(). iOS Safari revokes
// the "user gesture" flag as soon as a native confirm()/alert()/prompt()
// dialog is shown, so any window.open() called afterward (even in the same
// click handler) gets silently blocked on iPhone. A DOM modal's own button
// click is its own fresh, genuine user gesture, so window.open() from
// inside ITS click handler works reliably on Safari/iOS too.
function showConfirmModal(message, confirmLabel, onConfirm) {
  const modal = document.createElement("div");
  modal.className = "photo-confirm-modal";

  const backdrop = document.createElement("div");
  backdrop.className = "photo-confirm-backdrop";
  backdrop.onclick = () => modal.remove();

  const content = document.createElement("div");
  content.className = "photo-confirm-content";
  content.addEventListener("click", (e) => e.stopPropagation());

  const title = document.createElement("p");
  title.className = "photo-confirm-title";
  title.textContent = message;

  const buttonGroup = document.createElement("div");
  buttonGroup.className = "photo-confirm-buttons";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "photo-confirm-btn cancel";
  cancelBtn.textContent = "გაუქმება";
  cancelBtn.onclick = () => modal.remove();

  const confirmBtn = document.createElement("button");
  confirmBtn.className = "photo-confirm-btn confirm";
  confirmBtn.textContent = confirmLabel || "დადასტურება";
  confirmBtn.onclick = () => {
    modal.remove();
    onConfirm(); // fires synchronously inside THIS click — safe for Safari popups
  };

  buttonGroup.appendChild(cancelBtn);
  buttonGroup.appendChild(confirmBtn);
  content.appendChild(title);
  content.appendChild(buttonGroup);
  backdrop.appendChild(content);
  modal.appendChild(backdrop);
  document.body.appendChild(modal);
}

function showReportReasonModal(targetName, onSubmit) {
  const modal = document.createElement("div");
  modal.className = "photo-confirm-modal";

  const backdrop = document.createElement("div");
  backdrop.className = "photo-confirm-backdrop";

  const content = document.createElement("div");
  content.className = "photo-confirm-content";

  const title = document.createElement("p");
  title.className = "photo-confirm-title";
  title.textContent = `რატომ მოახსენებთ "${targetName}"-ს?`;

  const textarea = document.createElement("textarea");
  textarea.className = "report-reason-textarea";
  textarea.placeholder = "მიუთითეთ მიზეზი (სავალდებულოა)...";
  textarea.maxLength = 200;

  const errorMsg = document.createElement("p");
  errorMsg.className = "report-reason-error";
  errorMsg.textContent = "გთხოვთ, მიუთითოთ მიზეზი.";
  errorMsg.style.display = "none";

  const buttonGroup = document.createElement("div");
  buttonGroup.className = "photo-confirm-buttons";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "photo-confirm-btn cancel";
  cancelBtn.textContent = "გაუქმება";
  cancelBtn.onclick = () => modal.remove();

  const confirmBtn = document.createElement("button");
  confirmBtn.className = "photo-confirm-btn confirm";
  confirmBtn.textContent = "🚩 გაგზავნა";
  confirmBtn.onclick = () => {
    const reason = textarea.value.trim();
    if (reason.length < 3) {
      errorMsg.style.display = "block";
      textarea.focus();
      return;
    }
    modal.remove();
    onSubmit(reason);
  };

  textarea.addEventListener("input", () => { errorMsg.style.display = "none"; });

  buttonGroup.appendChild(cancelBtn);
  buttonGroup.appendChild(confirmBtn);

  content.appendChild(title);
  content.appendChild(textarea);
  content.appendChild(errorMsg);
  content.appendChild(buttonGroup);

  backdrop.appendChild(content);
  modal.appendChild(backdrop);

  document.body.appendChild(modal);
  setTimeout(() => textarea.focus(), 50);
}


// ── Question button ───────────────────────────────────────────────────────────
let questionBtnCooldown = false;

questionBtn.addEventListener("click", async () => {
  if (!partnerConnected || questionBtnCooldown) return;
  questionBtnCooldown = true;
  questionBtn.disabled = true;
  questionBtn.textContent = "⌛";

  try {
    const res  = await fetch("/api/random-question");
    const data = await res.json();
    if (data.question) {
      // Show question card locally for you
      addQuestionCard(data.question, true);
      // Relay to partner via socket
      socket.emit("sendQuestion", { text: data.question });
    }
  } catch {
    addSystemMessage("კითხვა ვერ ჩაიტვირთა 😕");
  } finally {
    setTimeout(() => {
      questionBtnCooldown  = false;
      questionBtn.disabled = !partnerConnected;
      questionBtn.textContent = "?";
    }, 3000); // 3 s cooldown
  }
});

// Partner received a question card from us
socket.on("partnerQuestion", ({ text }) => {
  addQuestionCard(text, false);
  playNotification("message");
  incrementUnread();
});

// ── Reactions ─────────────────────────────────────────────────────────────────
const REACTIONS          = ["❤️","😂","😢"];
let activeReactionPicker = null;

function showReactionPicker(anchorEl, messageId) {
  closeReactionPicker();
  const picker      = document.createElement("div");
  picker.className  = "reaction-picker";
  const frag = document.createDocumentFragment();
  REACTIONS.forEach(emoji => {
    const btn       = document.createElement("button");
    btn.className   = "reaction-emoji-btn";
    btn.textContent = emoji;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      reactToMessage(messageId, emoji);
      closeReactionPicker();
    });
    frag.appendChild(btn);
  });
  picker.appendChild(frag);
  document.body.appendChild(picker);
  activeReactionPicker = picker;
  requestAnimationFrame(() => {
    const rect = anchorEl.getBoundingClientRect();
    const pw = picker.offsetWidth, ph = picker.offsetHeight;
    let left = rect.left, top = rect.top - ph - 8;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    if (top < 4) top = rect.bottom + 8;
    picker.style.cssText += `left:${left}px;top:${top}px;opacity:1;transform:scale(1)`;
  });
}

function closeReactionPicker() {
  activeReactionPicker?.remove();
  activeReactionPicker = null;
}

document.addEventListener("click", () => closeReactionPicker());

function reactToMessage(messageId, emoji) {
  socket.emit("react", { messageId, emoji });
  displayReaction(messageId, emoji, true);
}

function displayReaction(messageId, emoji, isMine) {
  const area = document.getElementById(`reactions_${messageId}`);
  if (!area) return;
  const cls = isMine ? "reaction-mine" : "reaction-partner";
  let pill   = area.querySelector(`.${cls}`);
  if (pill) {
    pill.classList.remove("reaction-pop");
    void pill.offsetWidth;
    pill.textContent = emoji;
    pill.classList.add("reaction-pop");
  } else {
    pill = document.createElement("span");
    pill.className   = `reaction-pill ${cls} reaction-pop`;
    pill.textContent = emoji;
    area.appendChild(pill);
  }
}

// ── Message sending ───────────────────────────────────────────────────────────
function sendMessage() {
  const message = messageInput.value.trim();
  if (!message) return;
  // Guard every possible way the chat can be in a non-connected state
  if (!partnerConnected || !userName) return;
  if (messageInput.disabled || messageInput.readOnly) return;
  const msgId = generateMsgId();
  const currentReply = replyTo ? { ...replyTo } : null;
  addMessage(message, true, msgId, currentReply);
  sendChat(msgId, message, currentReply); // also while the connection is coming back
  messageInput.value = "";
  messageInput.style.height = "auto";
  messageInput.style.overflowY = "hidden";
  charCount.textContent = "";
  charCount.classList.remove("warning");
  clearReply();
  // Keep focus on input so the keyboard stays open on mobile. Sent from the
  // 😊 panel instead: close it and go back to the messages (no keyboard).
  if (gifPickerOpen) closeGifPickerPanel();
  else messageInput.focus();
}

// ── Sending that survives a dropped connection ─────────────────────────────
// A message shows 🕓 until the server says it got it, then ✓ (✓✓ once read).
// Phones quietly drop the connection in the background: if that answer
// doesn't come within a few seconds, the connection is checked and remade,
// and what's waiting goes out as soon as the chat is back (the server takes
// each message once). One that can't be delivered (the partner left) is
// marked ⚠️ instead of sitting at a grey ✓ for ever.
const pendingOut = new Map(); // messageId → { text, replyTo, at, timer }
function setSentMark(id, state) {
  const el = document.getElementById(`seen_${id}`);
  if (!el) return;
  el.classList.toggle("pending", state === "pending");
  el.classList.toggle("failed", state === "failed");
  if (state === "pending") el.textContent = "🕓";
  else if (state === "failed") el.textContent = "⚠️ არ გაიგზავნა";
  else if (el.textContent !== "✓✓") el.textContent = "✓";
}
function sendChat(id, text, reply) {
  pendingOut.set(id, { text, replyTo: reply, at: Date.now(), timer: null });
  setSentMark(id, "pending");
  if (socket.connected) emitChat(id);
  else if (socket.checkConnection) socket.checkConnection(); else socket.connect();
}
function emitChat(id) {
  const m = pendingOut.get(id);
  if (!m || !socket.connected) return;
  socket.emit("message", { text: m.text, messageId: id, replyTo: m.replyTo }, (r) => {
    if (!pendingOut.has(id)) return;
    clearTimeout(m.timer);
    pendingOut.delete(id);
    setSentMark(id, r && r.ok === false ? "failed" : "sent");
  });
  clearTimeout(m.timer);
  m.timer = setTimeout(function waitForAnswer() {
    if (!pendingOut.has(id)) return;
    if (Date.now() - m.at > 90000) { pendingOut.delete(id); setSentMark(id, "failed"); return; }
    // The anti-spam captcha holds it until it's solved — not lost.
    if (!document.getElementById("gcSpamCaptcha") && socket.checkConnection) socket.checkConnection();
    m.timer = setTimeout(waitForAnswer, 6000);
  }, 6000);
}
function resendPending() { for (const id of [...pendingOut.keys()]) emitChat(id); }
function dropPending(markFailed) {
  for (const [id, m] of pendingOut) { clearTimeout(m.timer); if (markFailed) setSentMark(id, "failed"); }
  pendingOut.clear();
}
socket.on("partnerRestored", resendPending);                 // back in the same chat after reconnecting
socket.on("partnerDisconnected", () => dropPending(true));   // they left — what didn't reach them, didn't
socket.on("partnerFound", () => dropPending(false));         // a new chat

// ── Bio / Interests popup ─────────────────────────────────────────────────────
let bioPopupOpen = false;

function openBioPopup() {
  bioInput.value       = userBio;
  bioCharCount.textContent = `${userBio.length}/60`;
  bioPopup.style.display = "flex";
  bioPopupOpen = true;
  setTimeout(() => bioInput.focus(), 50);
}
// Exposed so the ⋮ menu (auth-client.js, a separate script) can open this
// directly — "ინტერესები" lives only in that menu now, not as its own
// main-bar button, so there's no button element to proxy a click through.
window.openBioPopup = openBioPopup;

function closeBioPopup() {
  bioPopup.style.display = "none";
  bioPopupOpen = false;
}

interestsBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  bioPopupOpen ? closeBioPopup() : openBioPopup();
});

bioInput.addEventListener("input", () => {
  bioCharCount.textContent = `${bioInput.value.length}/60`;
});

bioInput.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Enter") { e.preventDefault(); saveBio(); }
  if (e.key === "Escape") closeBioPopup();
});

function saveBio() {
  const text = bioInput.value.trim().slice(0, 60);
  userBio = text;
  socket.emit("setBio", text);
  interestsBtn?.classList.toggle("has-bio", text.length > 0);
  closeBioPopup();
  if (text) showToast("✅ ინფო შენახულია!");
}

function clearBio() {
  bioInput.value = "";
  bioCharCount.textContent = "0/60";
  userBio = "";
  socket.emit("setBio", "");
  interestsBtn?.classList.remove("has-bio");
}

bioSaveBtn.addEventListener("click", saveBio);
bioClearBtn.addEventListener("click", clearBio);
document.getElementById("bioCloseBtn").addEventListener("click", (e) => { e.stopPropagation(); closeBioPopup(); });

// Close popup when clicking outside it
document.addEventListener("click", (e) => {
  // On phones the popup's layer covers the whole screen with the card on top,
  // so a tap on that empty layer itself also counts as "outside".
  if (bioPopupOpen && (e.target === bioPopup || !bioPopup.contains(e.target)) && e.target !== interestsBtn &&
      !(e.target.closest && e.target.closest("#regMenuInt"))) {   // the ⋮ menu item that opens it
    closeBioPopup();
  }
});

// ── Name modal ────────────────────────────────────────────────────────────────
let _saveNameTimeout = null; // tracks the freeze-recovery timer

function _resetSaveBtn() {
  clearTimeout(_saveNameTimeout);
  _saveNameTimeout        = null;
  saveNameBtn.disabled    = false;
  saveNameBtn.textContent = isFirstLogin ? "საუბრის დაწყება" : "Save Name";
  const _ov = document.getElementById("modalLoadingOverlay");
  if (_ov) _ov.style.display = "none";
}

function saveName() {
  let name;
  if (window.gaicaniAuthUser) {
    // Registered account — their own name (set by autoSetNameAfterAuth, or
    // typed into the change-name modal).
    name = nameInput.value.trim();
  } else {
    // Guests can't choose a name. Send the one this tab was already given,
    // so it stays the same across pages; otherwise a placeholder. Either way
    // the SERVER assigns the real "სტუმარი####" — this is only the request,
    // and the name actually shown comes back in nameAccepted.
    let stored = null;
    try { stored = sessionStorage.getItem("gaicani_guest_username"); } catch (_) {}
    name = (stored && /^სტუმარი\d{4}$/.test(stored)) ? stored : "სტუმარი";
  }
  if (!name)            { showNameError("შეიყვანეთ სახელი ..."); return; }
  if (name.length < 2)  { showNameError("სახელი უნდა შედგებოდეს მინიმუმ ორი სიმბოლოსგან!"); return; }
  if (name.length > 20) { showNameError("20 სიმბოლოზე მეტი ვერ იქნება სახელი ! "); return; }
  clearNameError();

  // If socket isn't connected yet, don't freeze — show a clear error
  if (!socket.connected) {
    showNameError("იტვირთება საიტი, კიდევ სცადეთ 🔄");
    return;
  }

  saveNameBtn.disabled    = true;
  saveNameBtn.textContent = "Checking...";

  // Show loading overlay to blur the form content
  const _overlay = document.getElementById("modalLoadingOverlay");
  if (_overlay) _overlay.style.display = "flex";

  // ── Token not ready yet (slow network on page load) ──────────────────────
  // Re-fetch and retry once rather than sending null and getting a tokenInvalid loop
  if (!_challengeToken || !_challengePow) {
    fetch("/api/challenge")
      .then(r => r.json())
      .then(d => {
        _challengeToken = d.token;
        _challengePow   = (d.nonce * 31 + d.nonce % 97);
        _doSetName(name);
      })
      .catch(() => {
        showNameError("კავშირის შეცდომა. გთხოვთ გვერდი განაახლოთ.");
        _resetSaveBtn();
      });
    return;
  }

  _doSetName(name);
}

function _doSetName(name) {
  // Safety timeout — re-enable button if server never replies within 8 s
  clearTimeout(_saveNameTimeout);
  _saveNameTimeout = setTimeout(() => {
    showNameError("სერვერი არ პასუხობს. სცადეთ ხელახლა. 🔄");
    _resetSaveBtn();
  }, 8000);

  socket.emit("setName", {
    name,
    token:     _challengeToken,
    powAnswer: _challengePow,
    webdriver: !!navigator.webdriver,
  });
}

// ── Socket events ─────────────────────────────────────────────────────────────

// The connection dropped for a network reason (bad signal, phone app-switch):
// remember to resume our chat when we're back — the server holds the partner
// for up to 30 minutes. This trigger was missing, so chats never resumed after
// any drop. Deliberate closes (a ban, a name block) are not resumed.
socket.on("disconnect", (reason) => {
  if (reason === "io server disconnect" || reason === "io client disconnect") return;
  if (userName && !isFirstLogin) isReconnecting = true;
});

socket.on("connect", () => {
  _reconnectNameRetries = 0; // reset on every fresh connect
  // Only silently re-auth if the user was already in an active chat (partnerConnected or was searching)
  // Never auto-setName on a fresh page load — user must press the button.
  if (userName && !isFirstLogin && isReconnecting) {
    // Hide the name modal — silently reconnecting, not asking for a new name
    if (nameModal) nameModal.style.display = "none";
    // Fetch a fresh token — the previous one was one-time-use and already consumed
    fetch("/api/challenge")
      .then(r => r.json())
      .then(d => {
        _challengeToken = d.token;
        _challengePow   = (d.nonce * 31 + d.nonce % 97);
        socket.emit("setName", { name: userName, token: _challengeToken, powAnswer: _challengePow });
      })
      .catch(() => {
        socket.emit("setName", { name: userName, token: "", powAnswer: 0 });
      });
  }
});

// Challenge token was missing or expired — silently re-fetch and retry
socket.on("tokenInvalid", () => {
  fetch("/api/challenge")
    .then(r => r.json())
    .then(d => {
      _challengeToken = d.token;
      _challengePow   = (d.nonce * 31 + d.nonce % 97);
      const name = userName || nameInput.value.trim();
      if (name) {
        socket.emit("setName", { name, token: _challengeToken, powAnswer: _challengePow });
      }
    })
    .catch(() => {
      if (!isReconnecting) {
        showNameError("კავშირის შეცდომა. გთხოვთ გვერდი განაახლოთ.");
        saveNameBtn.disabled    = false;
        saveNameBtn.textContent = isFirstLogin ? "საუბრის დაწყება" : "Save Name";
      }
    });
});

socket.on("nameAccepted", (acceptedName) => {
  const wasNameChange = !isFirstLogin && !isReconnecting;
  _resetSaveBtn(); // cancel the 8-second safety timeout and re-enable button
  userName                = acceptedName;
  nameModal.style.display = "none";
  clearNameError();

  // Do NOT persist username to localStorage — we never want auto-reconnect
  // on page reload. User must always press the button themselves.
  // sessionStorage is different: it's how a guest's chosen name carries
  // over if they later open the dashboard or a game (same tab session),
  // so they show up there as themselves instead of a random "სტუმარი####".
  try { sessionStorage.setItem("gaicani_guest_username", acceptedName); } catch (_) {}

  // Show the username in the top bar
  const displayEl = document.getElementById("userNameDisplay");
  if (displayEl) {
    displayEl.textContent = `👤 ${acceptedName}`;
    displayEl.style.display = "block";
  }

  // Interests/bio and "change name" now live in the ⋮ menu instead of as
  // separate main-bar buttons — keeps the main bar less cluttered. See
  // regMenuInt in the dropdown.

  // Show "ჩემი გვერდი" (My Page / dashboard) — same main-bar-icon treatment
  // as before, not the ⋮ menu (that's reserved for registered users, who
  // already have myPageBtn shown via auth-client.js instead).
  const myPageBtnEl = document.getElementById("myPageBtn");
  if (myPageBtnEl && myPageBtnEl.style.display === "none") myPageBtnEl.style.display = "inline-flex";

  if (isFirstLogin) {
    isFirstLogin = false;
    clearChat();
    // Do NOT auto-search — user must press the Search button manually
    addSystemMessage("🔎 ძებნის დასაწყებად დააჭირე ღილაკს");
    addRegisterPromoCard();
    addDonationCard();
  } else if (isReconnecting) {
    isReconnecting = false;
    _reconnectNameRetries = 0; // reset retry counter on success
    removeReconnectingMessage();
    // Keep inputs and chat as-is — server follows with partnerRestored or partnerDisconnected
  }
  // else: mid-session name change — no extra action
  if (wasNameChange) {
    addSystemMessage(`🟢 თქვენ წარმატებით შეიცვალეთ სახელი „${acceptedName}" 🟢`);
  }
});

// Tracks how many times we've retried the original name after a reconnect collision
let _reconnectNameRetries = 0;
const _RECONNECT_NAME_MAX_RETRIES = 5;

socket.on("nameTaken", () => {
  saveNameBtn.disabled    = false;
  saveNameBtn.textContent = isFirstLogin ? "საუბრის დაწყება" : "Save Name";

  if (isReconnecting) {
    // The server still has our old socket registered under our name.
    // Wait a short moment and retry with the SAME original name — the old
    // socket entry will be cleaned up within a second or two.
    if (_reconnectNameRetries < _RECONNECT_NAME_MAX_RETRIES) {
      _reconnectNameRetries++;
      const delay = 800 + _reconnectNameRetries * 400; // back off slightly each attempt
      setTimeout(() => {
        if (!socket.connected) return; // don't retry if socket dropped again
        const originalName = userName || nameInput.value.trim();
        fetch("/api/challenge")
          .then(r => r.json())
          .then(d => {
            _challengeToken = d.token;
            _challengePow   = (d.nonce * 31 + d.nonce % 97);
            socket.emit("setName", { name: originalName, token: _challengeToken, powAnswer: _challengePow });
          })
          .catch(() => {
            // Network error — give up silently, user is still logged in with old name
            isReconnecting = false;
            _reconnectNameRetries = 0;
          });
      }, delay);
      return; // still reconnecting — do not reset isReconnecting yet
    }

    // Exhausted retries — name is genuinely taken by someone else.
    // Keep the user's existing session intact without renaming them.
    isReconnecting = false;
    _reconnectNameRetries = 0;
    // Don't show modal or change name — just continue as-is
    return;
  }

  _reconnectNameRetries = 0;
  isReconnecting = false;
  showNameError("ეს სახელი დაკავებულია. სხვა აირჩიეთ. 😟 ");
  nameInput.focus();
  nameInput.select();
});

// Name refused because it contains a banned word. Distinct from nameTaken:
// retrying the same name will never work, so don't run the reconnect retry
// logic — just tell them and let them pick something else.
socket.on("nameRejected", ({ message }) => {
  saveNameBtn.disabled    = false;
  saveNameBtn.textContent = isFirstLogin ? "საუბრის დაწყება" : "Save Name";
  _reconnectNameRetries = 0;
  isReconnecting = false;
  showNameError(message || "ეს სახელი დაუშვებელია. სხვა აირჩიეთ.");
  nameInput.focus();
  nameInput.select();
});

socket.on("onlineCount", (count) => updateOnlineCount(count));

socket.on("queuePosition", ({ position, total }) => {
  const wrapper = document.getElementById("searchingMsg");
  if (wrapper) {
    const msg = wrapper.querySelector(".system-message");
    if (msg) msg.textContent = `ვეძებთ ახალ პარტნიორს... 🔎 `;
  }
});

socket.on("partnerFound", (partner) => {
  // ── Stop everything searching-related immediately ──────────────────────
  stopSearchRetry();
  // Abort any in-flight fact fetch so stale async work doesn't land after match
  if (gifFetchController) { gifFetchController.abort(); gifFetchController = null; }

  // ── Set state atomically before touching the DOM ───────────────────────
  isReconnecting       = false;  // clear any lingering reconnect state
  partnerConnected     = true;
  partnerName          = partner.name || "Anonymous";
  partnerIsVip         = !!partner.partnerIsPro;
  partnerCardData      = { name: partnerName, isVip: partnerIsVip, bio: partner.partnerAccountBio || partner.partnerBio || "",  // account bio first, else the chat interests line
                           avatar: partner.partnerAvatar || null, profile: partner.partnerProfile || null };
  lastPartnerName      = "";
  canBlockDisconnected = false;

  // ── DOM updates ────────────────────────────────────────────────────────
  clearChat();
  setPartnerNameDisplay(partnerName, partnerIsVip);
  addPartnerFoundCard(partnerName, partnerIsVip);

  // Show partner's bio if they set one
  if (partner.partnerBio) {
    const bioEl       = document.createElement("div");
    bioEl.className   = "partner-bio-line";
    bioEl.textContent = `💬 ${partner.partnerBio}`;
    chat.appendChild(bioEl);
    scheduleScroll();
  }

  // ── Enable inputs — do this last so the DOM is fully ready ────────────
  setInputsEnabled(true);
  // Safety: explicitly unlock in case a prior race left these locked
  messageInput.disabled        = false;
  messageInput.readOnly        = false;
  messageInput.style.pointerEvents = "";
  messageInput.style.opacity       = "";
  updateBlockBtn();
  hideTypingIndicator();
  playNotification("partnerFound");
  incrementUnread();
  showScrollToTopBtn();
});

// Reconnect grace-period events
let partnerWasReconnecting = false;

socket.on("partnerReconnecting", (data) => {
  partnerWasReconnecting = true;
  // Silent — keep chat and inputs running
});

socket.on("partnerReconnected", (data) => {
  stopSearchRetry();
  isReconnecting         = false;
  partnerWasReconnecting = false;
  partnerName            = data.name || partnerName;
  partnerConnected       = true;
  canBlockDisconnected   = false;
  removeReconnectingMessage();
  clearPartnerAwayCountdown();
  setPartnerNameDisplay(partnerName);
  setInputsEnabled(true);
  // Explicitly unlock — race-safe double-clear
  messageInput.disabled        = false;
  messageInput.readOnly        = false;
  messageInput.style.pointerEvents = "";
  updateBlockBtn();
  hideTypingIndicator();
});

// Own socket restored to previous partner after reconnecting
socket.on("partnerRestored", (data) => {
  stopSearchRetry();
  isReconnecting       = false;   // clear reconnecting flag — we're back
  partnerName          = data.name || "Anonymous";
  partnerConnected     = true;
  lastPartnerName      = "";
  canBlockDisconnected = false;
  removeReconnectingMessage();
  setPartnerNameDisplay(partnerName, partnerIsVip);  // restore name in header (cleared on disconnect)
  setInputsEnabled(true);
  updateBlockBtn();
  hideTypingIndicator();
  showScrollToTopBtn();
  // No clearChat() — messages stay, chat resumes silently
});

socket.on("waitingForPartner", () => {
  // Guard: if partnerFound already arrived (race), do nothing at all.
  // This can happen when partnerFound and waitingForPartner are queued
  // back-to-back and arrive in the same microtask flush.
  if (partnerConnected) return;
  // Also ignore during reconnecting — server handles that path
  if (isReconnecting) return;
  partnerName = ""; setPartnerNameDisplay("");
  setInputsEnabled(false);
});

// ════════════════════════════════════════════════════════════════════════════

// 🛟 Support AI: under its question, a way to say "no thanks" — it never
// comes back to this person, and the search for a real partner starts.
socket.on("supportAI:skipOffer", () => {
  if (!partnerConnected || !isSupportName(partnerName)) return;
  const box = document.createElement("div");
  box.className = "sai-skip";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "sai-skip-btn";
  btn.textContent = "⏭ გამოტოვება";
  const note = document.createElement("div");
  note.className = "sai-skip-note";
  note.textContent = "Support AI აღარ შეგაწუხებს — ახალ თანამოსაუბრეს მოგიძებნით";
  btn.addEventListener("click", () => { btn.disabled = true; socket.emit("supportAI:skip"); nextBtn.click(); });
  box.append(btn, note);
  chat.appendChild(box);
  scheduleScroll();
});

// ── 📷 Photos (VIP senders) — view once, see view-once.js ─────────────────
// 📷 → "send a photo?" → gallery → preview → send. The other person is asked
// first; only if they agree does it reach them, blurred; a tap shows it for
// 10 seconds and it's gone. Nothing is saved anywhere.
function isVip() { const u = window.gaicaniAuthUser; return !!(u && u.isPro && !u.isGuest); }
function refreshPhotoBtn() {
  const b = document.getElementById("photoBtn");
  if (!b) return;
  b.style.display = isVip() ? "" : "none";
  b.disabled = !partnerConnected || isSupportName(partnerName);
}
socket.on("auth:authenticated", () => setTimeout(refreshPhotoBtn, 0));
socket.on("auth:proStatusChanged", () => setTimeout(refreshPhotoBtn, 0));
const sentPhotos = new Map(); // offer id → its status line
const PHOTO_STATE = { accepted: "✅ დაგეთანხმა — ახლა უყურებს", viewed: "👁 ნახა — ფოტო გაქრა",
  declined: "🚫 ფოტოზე უარი თქვა", expired: "⌛ არ უპასუხა — ფოტო გაუქმდა" };
function blobToBase64(blob) {
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => { const s = String(fr.result); res(s.slice(s.indexOf(",") + 1)); }; fr.onerror = rej; fr.readAsDataURL(blob); });
}
function addOwnPhoto(url) {
  const wrapper = document.createElement("div");
  wrapper.className = "message-wrapper you";
  const row = document.createElement("div");
  row.className = "message-row";
  const content = document.createElement("div");
  content.className = "message-content you rc-photo";
  const img = document.createElement("img");
  img.src = url; img.alt = "";
  content.appendChild(img);
  row.appendChild(content);
  const status = document.createElement("div");
  status.className = "seen-status";
  status.textContent = "⏳ ელოდება თანხმობას…";
  wrapper.append(row, status);
  chat.appendChild(wrapper);
  scheduleScroll();
  return status;
}
document.getElementById("photoBtn")?.addEventListener("click", async () => {
  if (!isVip() || !partnerConnected || !window.GaicaniViewOnce) return;
  const r = await window.GaicaniViewOnce.choose({ to: partnerName });
  if (!r) return;
  if (r.error) { addSystemMessage("⚠️ " + r.error); return; }
  if (!partnerConnected) { addSystemMessage("⚠️ თანამოსაუბრე აღარ არის"); return; }
  const status = addOwnPhoto(URL.createObjectURL(r.blob));
  socket.emit("rcPhoto:offer", { data: await blobToBase64(r.blob) }, (res) => {
    if (!res || res.error) { status.textContent = "⚠️ " + ((res && res.error) || "ვერ გაიგზავნა"); status.classList.add("failed"); return; }
    sentPhotos.set(res.id, status);
  });
});
socket.on("rcPhoto:status", ({ id, state } = {}) => {
  const st = sentPhotos.get(id);
  if (!st) return;
  st.textContent = PHOTO_STATE[state] || "";
  if (state !== "accepted") sentPhotos.delete(id);
});
// Someone is sending me a photo: ask first.
const photoWaits = new Map(), photoCards = new Map();
socket.on("rcPhoto:offer", ({ id, from } = {}) => {
  if (!partnerConnected || !window.GaicaniViewOnce || !id) return;
  const card = window.GaicaniViewOnce.card({
    from: from || partnerName,
    onAnswer: (accept) => new Promise((resolve) => {
      socket.emit("rcPhoto:answer", { id, accept: !!accept });
      if (!accept) return resolve(null);
      const t = setTimeout(() => { photoWaits.delete(id); resolve(null); }, 25000);
      photoWaits.set(id, (url) => { clearTimeout(t); resolve(url); });
    }),
    onViewed: () => socket.emit("rcPhoto:viewed", { id }),
  });
  photoCards.set(id, card);
  const wrapper = document.createElement("div");
  wrapper.className = "message-wrapper partner";
  wrapper.appendChild(card.el);
  chat.appendChild(wrapper);
  scheduleScroll();
  playNotification("message");
  incrementUnread();
});
socket.on("rcPhoto:deliver", async ({ id, data } = {}) => {
  const done = photoWaits.get(id);
  if (!done) return;
  photoWaits.delete(id);
  try { done(URL.createObjectURL(await (await fetch("data:image/jpeg;base64," + data)).blob())); } catch (_) { done(null); }
});
socket.on("rcPhoto:withdrawn", ({ id } = {}) => { const c = photoCards.get(id); if (c) c.setText("⌛ ფოტო გაუქმდა"); });

socket.on("partnerTyping", (typing) => {
  typing ? showTypingIndicator() : hideTypingIndicator();
});

socket.on("message", (msg) => {
  // Drop messages that arrive after partner has already disconnected/changed.
  // This handles the race where "next" was clicked but the server hadn't
  // processed it yet and forwarded one last message from the old partner.
  if (!partnerConnected) return;
  hideTypingIndicator();
  addMessage(msg.text, false, msg.messageId, msg.replyTo || null);
  playNotification("message");
  incrementUnread();
  // Only send seen receipt if the tab is actually visible
  if (msg.messageId && !document.hidden) socket.emit("seen", { messageId: msg.messageId });
});

socket.on("partnerSeen", ({ messageId }) => {
  const el = document.getElementById(`seen_${messageId}`);
  if (el) { el.textContent = "✓✓"; el.classList.add("seen"); }
});

socket.on("reacted", ({ messageId, emoji }) => {
  displayReaction(messageId, emoji, false);
});

// Tab-away events disabled — intentionally ignored
socket.on("partnerTabAway", () => {});
socket.on("partnerTabBack", () => {});

socket.on("partnerDisconnected", (data) => {
  partnerWasReconnecting = false;
  removeReconnectingMessage();
  stopSearchRetry();          // stop any running search — user must press Next manually
  partnerConnected     = false;
  partnerName = ""; setPartnerNameDisplay("");
  lastPartnerName      = data.name || lastPartnerName || "";
  canBlockDisconnected = !!lastPartnerName;
  setInputsEnabled(false);
  updateBlockBtn();
  hideTypingIndicator();      // clear typing dots if they were showing

  // Show disconnect notice + inline block offer
  const disconnectEl = document.createElement("div");
  disconnectEl.className = "system-message-disconnect";
  disconnectEl.textContent = `❌ ${lastPartnerName || "პარტნიორი"} გათიშა.`;
  chat.appendChild(disconnectEl);

  if (lastPartnerName) {
    const offerEl = document.createElement("div");
    offerEl.className = "block-offer";
    offerEl.innerHTML =
      `<span>გსურთ დაბლოკოთ <strong>"${lastPartnerName}"</strong>? ის ვეღარ შეძლებს თქვენს შეწუხებას.</span>` +
      `<button class="block-offer-btn" id="blockOfferBtn">🚫 დაბლოკვა</button>` +
      (isSupportName(lastPartnerName) ? "" : // 🛟 Support can't be reported
      `<div class="block-offer-report-row">` +
        `<button class="report-offer-btn" id="reportOfferBtn">🚩 რეპორტი</button>` +
      `</div>`);
    chat.appendChild(offerEl);
    scheduleScroll();

    offerEl.querySelector("#blockOfferBtn").addEventListener("click", () => {
      offerEl.remove();
      emitBlockUser(lastPartnerName);
    });

    offerEl.querySelector("#reportOfferBtn")?.addEventListener("click", () => {
      const btn = offerEl.querySelector("#reportOfferBtn");
      if (!btn || btn.disabled) return;
      showReportReasonModal(lastPartnerName, (reason) => {
        btn.disabled = true;
        btn.textContent = "✅ გაგზავნილია";
        socket.emit("reportUser", { reason });
        emitBlockUser(lastPartnerName);
      });
    });
  } else {
    scheduleScroll();
  }

});

socket.on("userBlocked", (data) => {
  const blockedName = data.name || lastPartnerName || "მომხმარებელი";
  stopSearchRetry();
  clearChat();
  partnerConnected     = false;
  partnerName = ""; setPartnerNameDisplay("");
  lastPartnerName      = "";
  canBlockDisconnected = false;
  updateBlockBtn();
  closeGifPickerPanel();
  addSystemMessage(`🔴 „${blockedName}" -  წარმატებით იქნა დაბლოკილი 🔴`);
  setInputsEnabled(false);
  // Do NOT auto-search — user must press Next manually
});

socket.on("blockLimitReached", () => {
  addSystemMessage("🚫 ბლოკირების ლიმიტს მიაღწიეთ ამ სესიისთვის.");
});

socket.on("youWereBlocked", (data) => {
  const blockerName = data.name || "მომხმარებელი";
  partnerConnected     = false;
  partnerName = ""; setPartnerNameDisplay("");
  lastPartnerName      = "";
  canBlockDisconnected = false;
  stopSearchRetry();
  hideTypingIndicator();
  setInputsEnabled(false);
  updateBlockBtn();
  closeGifPickerPanel();
  addDisconnectMessage(`${blockerName} -მა დაგბლოკათ :(`);
  // Do NOT auto-search — user must press Next manually
});

socket.on("reportConfirmed", () => {
  addSystemMessage("შეტყობინება გაგზავნილია. გმადლობთ. 🙏");
  if (reportBtn) reportBtn.disabled = true; // one report per partner
  // If reporting a disconnected partner, also clear the block state
  canBlockDisconnected = false;
  updateBlockBtn();
});

socket.on("reportBanned", () => {
  partnerConnected     = false;
  partnerName = ""; setPartnerNameDisplay("");
  lastPartnerName      = "";
  canBlockDisconnected = false;
  stopSearchRetry();
  hideTypingIndicator();
  setInputsEnabled(false);
  updateBlockBtn();
  closeGifPickerPanel();
  clearChat();
  addDisconnectMessage("🚫 თქვენ დაიბლოკეთ 24 საათით — მრავალი მომხმარებლის მიერ მოხსენების გამო.");
});

socket.on("messageFlagged", () => {
  // silently drop — no notice shown to user
});

// First offence — warning, chat continues
socket.on("linkWarning", () => {
  addSystemMessage("⚠️ ლინკების გაზიარება არ შეიძლება! განმეორებით შემთხვევაში ერთი დღით დაიბლოკებით საიტიდან!");
});

// Second offence — banned
socket.on("linkBanned", () => {
  partnerConnected     = false;
  partnerName = ""; setPartnerNameDisplay("");
  lastPartnerName      = "";
  canBlockDisconnected = false;
  stopSearchRetry();
  hideTypingIndicator();
  setInputsEnabled(false);
  updateBlockBtn();
  closeGifPickerPanel();
  clearChat();
  addDisconnectMessage("🚫 თქვენ დაიბლოკეთ 24 საათით ლინკების გაგზავნის გამო.");
});

// Legacy event kept for safety
socket.on("linkKicked", () => {
  partnerConnected     = false;
  partnerName = ""; setPartnerNameDisplay("");
  lastPartnerName      = "";
  canBlockDisconnected = false;
  stopSearchRetry();
  hideTypingIndicator();
  setInputsEnabled(false);
  updateBlockBtn();
  closeGifPickerPanel();
  clearChat();
  addDisconnectMessage("🚫 ლინკების გაგზავნა აკრძალულია! თქვენ გაირიცხეთ საიტიდან.");
});

// Partner of the link-sender sees a notice and gets unlinked
socket.on("partnerLinkKicked", () => {
  partnerConnected     = false;
  partnerName = ""; setPartnerNameDisplay("");
  lastPartnerName      = "";
  canBlockDisconnected = false;
  stopSearchRetry();
  hideTypingIndicator();
  setInputsEnabled(false);
  updateBlockBtn();
  closeGifPickerPanel();
  addDisconnectMessage("🚫 ლინკების გაგზავნა აკრძალულია! პარტნიორი გაირიცხა საიტიდან.");
});

socket.on("autoKicked", () => {
  try { sessionStorage.removeItem("gaicani_username"); } catch (_) {}
  partnerConnected     = false;
  partnerName = ""; setPartnerNameDisplay("");
  lastPartnerName      = "";
  canBlockDisconnected = false;
  stopSearchRetry();
  hideTypingIndicator();
  setInputsEnabled(false);
  updateBlockBtn();
  closeGifPickerPanel();
  clearChat();
  // Show ban notice on the entry modal
  const nameModal = document.getElementById("nameModal");
  const nameError = document.getElementById("nameError");
  const saveBtn   = document.getElementById("saveNameBtn");
  if (nameModal) nameModal.style.display = "flex";
  if (nameError) {
    nameError.textContent = "🚫 თქვენ დაიბლოკეთ 24 საათით ლინკების გაგზავნის გამო. სცადეთ ხვალ.";
    nameError.style.display = "block";
  }
  if (saveBtn) saveBtn.disabled = true;
});

// awayTimeout disabled — intentionally ignored
socket.on("awayTimeout", () => {});

// ── Button handlers ───────────────────────────────────────────────────────────

nextBtn.addEventListener("click", () => {
  nextBtn.disabled = true;
  setTimeout(() => { nextBtn.disabled = false; }, 1200);

  // Stop any stale state synchronously first
  stopSearchRetry();
  dropPending(false);
  partnerConnected     = false;
  partnerName = ""; setPartnerNameDisplay("");
  lastPartnerName      = "";
  canBlockDisconnected = false;
  setInputsEnabled(false);
  updateBlockBtn();
  hideTypingIndicator();
  closeGifPickerPanel();
  clearReply();
  clearChat();
  addSearchingMessage();

  // One emit — server tears down old pair AND calls tryFindPartner() itself.
  // No client-side retry needed; server queues us until a match is available.
  socket.emit("next");
});

blockBtn.addEventListener("click", () => {
  const targetName = partnerName || lastPartnerName;
  if (!targetName) return;
  showConfirmModal(
    `Block "${targetName}"? თქვენ ვეღარ შეხვდებით ამ იუზერს ბლოკის შემდეგ. 😡`,
    "🚫 დაბლოკვა",
    () => { emitBlockUser(targetName); }
  );
});

reportBtn.addEventListener("click", () => {
  const targetName = partnerName || lastPartnerName;
  if (!partnerConnected && !canBlockDisconnected) return;
  if (!targetName || isSupportName(targetName)) return;
  showReportReasonModal(targetName, (reason) => {
    socket.emit("reportUser", { reason });
    // Also block so they can't re-match
    emitBlockUser(targetName);
  });
});

sendBtn.addEventListener("click", sendMessage);

messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (!messageInput.disabled && !messageInput.readOnly) sendMessage();
  }
});

messageInput.addEventListener("input", () => {
  // Auto-resize textarea
  messageInput.style.height = "auto";
  messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + "px";
  messageInput.style.overflowY = messageInput.scrollHeight > 120 ? "auto" : "hidden";

  // Character counter
  const len = messageInput.value.length;
  charCount.textContent = len > 0 ? `${len}/2000` : ``;
  charCount.classList.toggle("warning", len > 1800);

  // Typing indicator — only when actually connected to a partner
  if (!partnerConnected || !socket.connected) return;
  if (!isTyping) { isTyping = true; socket.emit("typing", true); }
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    isTyping = false;
    if (partnerConnected) socket.emit("typing", false);
  }, 1500);
});


saveNameBtn.addEventListener("click", saveName);
nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveName(); } });

// ── Swipe-right gesture → Next (mobile) ──────────────────────────────────────
let touchStartX = 0, touchStartY = 0;

document.addEventListener("touchstart", (e) => {
  touchStartX = e.touches[0].clientX;
  touchStartY = e.touches[0].clientY;
}, { passive: true });

document.addEventListener("touchend", (e) => {
  const dx = e.changedTouches[0].clientX - touchStartX;
  const dy = Math.abs(e.changedTouches[0].clientY - touchStartY);
  // Swipe right > 150 px, mostly horizontal (dy < 30% of dx),
  // AND must start from the left edge (first 30px) to avoid accidental triggers
  if (dx > 150 && dy < dx * 0.3 && touchStartX < 30 && !nextBtn.disabled) {
    nextBtn.click();
  }
}, { passive: true });

// ── Welcome page / logo home ──────────────────────────────────────────────────
// Called when user clicks the GAICANI logo to return to the welcome screen.
function goToWelcome() {
  // Registered users: logo click → go to their Dashboard page instead
  if (window.gaicaniAuthUser) {
    window.location.href = "/dashboard.html";
    return;
  }
  // Lock state FIRST so no message can slip through
  partnerConnected     = false;
  partnerName = ""; setPartnerNameDisplay("");
  lastPartnerName      = "";
  canBlockDisconnected = false;
  userName             = "";
  isFirstLogin         = true;
  isReconnecting       = false;
  setInputsEnabled(false);
  updateBlockBtn();

  socket.emit("next"); // tell server we're leaving current chat
  stopSearchRetry();
  hideTypingIndicator();
  closeGifPickerPanel();
  clearChat();
  clearReply();

  // Clear saved name so a page reload also shows welcome
  try { sessionStorage.removeItem("gaicani_username"); } catch (_) {}

  // Show the welcome/name modal fresh
  const nameModalClose = document.getElementById("nameModalClose");
  if (nameModalClose) nameModalClose.style.display = "none";
  nameInput.value         = "";
  saveNameBtn.textContent = "საუბრის დაწყება";
  clearNameError();
  nameModal.style.display = "flex";
  setTimeout(() => nameInput.focus(), 100);
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  userName       = "";
  isFirstLogin   = true;
  isReconnecting = false;
  stopSearchRetry();
  setInputsEnabled(false);
  updateBlockBtn();
  setPartnerNameDisplay("");
  saveNameBtn.textContent  = "საუბრის დაწყება";
  charCount.textContent    = "";

  // X button on name modal — only active during mid-session name change
  const nameModalClose = document.getElementById("nameModalClose");
  if (nameModalClose) {
    nameModalClose.addEventListener("click", () => {
      nameModal.style.display = "none";
      nameModalClose.style.display = "none";
      clearNameError();
    });
  }

  // Always show the welcome modal — user must press the button themselves.
  // We never auto-submit the name or auto-search on page load. EXCEPTION:
  // a guest who already has an established name from elsewhere on the site
  // (dashboard, a game) gets that name auto-submitted instead of being
  // asked to type it in again — they already told us who they are, no
  // reason to ask twice. This does NOT auto-search for a partner though;
  // they still press "ძებნა" themselves for that part.
  try { sessionStorage.removeItem("gaicani_username"); } catch (_) {}

  // If a saved auth token exists, auth-client.js will hide this immediately.
  // Still show briefly for guests; auth-client suppresses for registered users.
  const _hasToken = (() => { try { return !!localStorage.getItem("gaicani_auth_token"); } catch(_){return false;} })();
  if (!_hasToken) {
    let _existingGuestName = null;
    try { _existingGuestName = sessionStorage.getItem("gaicani_guest_username"); } catch (_) {}

    if (_existingGuestName) {
      nameInput.value = _existingGuestName;
      if (socket.connected) {
        saveName();
      } else {
        // Socket handshake still in flight (slow network) — wait for it
        // rather than calling saveName() too early, which would fail
        // silently since the modal (where its error message would show)
        // is intentionally not being displayed in this auto-submit path.
        socket.once("connect", saveName);
      }
    } else {
      nameModal.style.display = "flex";
      setTimeout(() => nameInput.focus(), 100);
    }
  }
});
