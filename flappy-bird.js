/* ══════════════════════════════════════════════════════════════════════════
   flappy-bird.js — "მფრინავი ჩიტი" (Flappy Bird) client for GAICANI
   Depends on: /socket.io/socket.io.js, an existing "gaicani_auth_token" /
   "gaicani_auth_user" pair in localStorage (same convention as auth-client.js,
   dashboard.html, friend-chat.html), and the server-flappybird-patch.js
   endpoints/socket events being merged into server.js.

   NOTE ON DIFFICULTY CONSTANTS: FB_CFG below must stay numerically identical
   to the FLAPPY_CFG block in server-flappybird-patch.js — the server uses the
   same speed/spacing formulas to compute the fastest a score could physically
   be reached, as its main anti-cheat check. If you retune difficulty here,
   copy the same numbers over there.
   ══════════════════════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  /* ── Small helpers ─────────────────────────────────────────────────── */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" })[c]);
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /* ── Auth storage (same keys as auth-client.js) ───────────────────── */
  const LS_TOKEN = "gaicani_auth_token";
  const LS_USER  = "gaicani_auth_user";
  function loadAuth() {
    try { return { token: localStorage.getItem(LS_TOKEN), username: localStorage.getItem(LS_USER) }; }
    catch (_) { return {}; }
  }
  function clearAuth() {
    try { localStorage.removeItem(LS_TOKEN); localStorage.removeItem(LS_USER); } catch (_) {}
  }

  /* ── Toast (same shape as dashboard.html) ─────────────────────────── */
  function showToast(msg, ms = 3200) {
    const c = $("fb-toast-container");
    if (!c) return;
    const t = document.createElement("div");
    t.className = "fb-toast";
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(() => {
      t.style.transition = "opacity .3s";
      t.style.opacity = "0";
      setTimeout(() => t.remove(), 320);
    }, ms);
  }

  /* ══════════════════════════════════════════════════════════════════
     DIFFICULTY CONFIG — see note at top of file
     ══════════════════════════════════════════════════════════════════ */
  const FB_CFG = {
    GRAVITY:        1700,   // px/s^2
    FLAP_VELOCITY:  -430,   // px/s, SET on flap (not additive) — prevents moon-jump spam-tapping
    BIRD_R:         14,
    BIRD_X:         100,
    PIPE_W:         70,
    CANVAS_W:       400,
    CANVAS_H:       640,
    GROUND_H:       24,
    GAP_START: 170, GAP_MIN: 108, GAP_DECAY: 2.2,
    SPEED_START: 220, SPEED_MAX: 430, SPEED_GROWTH: 4,
    SPACING_START: 300, SPACING_MIN: 210, SPACING_DECAY: 1.5,
  };
  FB_CFG.GROUND_Y = FB_CFG.CANVAS_H - FB_CFG.GROUND_H;

  function gapForScore(s)     { return Math.max(FB_CFG.GAP_MIN, FB_CFG.GAP_START - s * FB_CFG.GAP_DECAY); }
  function speedForScore(s)   { return Math.min(FB_CFG.SPEED_MAX, FB_CFG.SPEED_START + s * FB_CFG.SPEED_GROWTH); }
  function spacingForScore(s) { return Math.max(FB_CFG.SPACING_MIN, FB_CFG.SPACING_START - s * FB_CFG.SPACING_DECAY); }

  /* ══════════════════════════════════════════════════════════════════
     DOM refs
     ══════════════════════════════════════════════════════════════════ */
  const elLoading         = $("fb-loading");
  const elGuestGate        = $("fb-guest-gate");
  const elApp              = $("fb-app");
  const elTopUsername      = $("fbTopUsername");
  const elBestScoreChip    = $("fbBestScore");
  const elPodium           = $("fbPodium");
  const elCanvasBox        = $("fbCanvasBox");
  const elCanvas           = $("fbCanvas");
  const elHudScore         = $("fbHudScore");
  const elStartOverlay     = $("fbStartOverlay");
  const elGameOverOverlay  = $("fbGameOverOverlay");
  const elFinalScore       = $("fbFinalScore");
  const elGameOverBest     = $("fbGameOverBest");
  const elNewBestBadge     = $("fbNewBestBadge");
  const elRestartBtn       = $("fbRestartBtn");

  const ctx = elCanvas.getContext("2d");

  function showOverlay(el) { el.classList.add("visible"); }
  function hideOverlay(el) { el.classList.remove("visible"); }

  /* ══════════════════════════════════════════════════════════════════
     Canvas sizing (DPR-aware, fixed logical resolution)
     ══════════════════════════════════════════════════════════════════ */
  function sizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    elCanvas.width  = FB_CFG.CANVAS_W * dpr;
    elCanvas.height = FB_CFG.CANVAS_H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  sizeCanvas();
  window.addEventListener("resize", sizeCanvas, { passive: true });

  /* ══════════════════════════════════════════════════════════════════
     Game state
     ══════════════════════════════════════════════════════════════════ */
  const STATE = { IDLE: "idle", PLAYING: "playing", OVER: "over" };
  let state = STATE.IDLE;
  let bird, pipes, score, groundOffset, wingPhase, rafId, lastT, starsBg;

  let myBest = 0;
  let sessionId = null;
  let pendingScoreSubmit = null; // holds a score if the game ended before a session id arrived

  function makeStars() {
    const arr = [];
    for (let i = 0; i < 26; i++) {
      arr.push({
        x: Math.random() * FB_CFG.CANVAS_W,
        y: Math.random() * (FB_CFG.GROUND_Y - 20),
        r: Math.random() * 1.4 + 0.4,
        tw: Math.random() * Math.PI * 2,
      });
    }
    return arr;
  }

  function resetGame() {
    bird = { y: FB_CFG.CANVAS_H / 2, vel: 0, rot: 0 };
    pipes = [];
    score = 0;
    groundOffset = 0;
    wingPhase = 0;
    elHudScore.textContent = "0";
    elHudScore.classList.remove("visible");
    if (!starsBg) starsBg = makeStars();
  }
  resetGame();
  drawFrame(0); // paint one idle frame immediately so the canvas isn't blank

  /* ══════════════════════════════════════════════════════════════════
     Rendering
     ══════════════════════════════════════════════════════════════════ */
  function drawFrame(dt) {
    const W = FB_CFG.CANVAS_W, H = FB_CFG.CANVAS_H;

    // Sky
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#20233a");
    g.addColorStop(1, "#12131c");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // Stars (subtle twinkle, nod to the GAICANI logo's star)
    ctx.save();
    for (const s of starsBg) {
      s.tw += dt * 1.5;
      ctx.globalAlpha = 0.35 + Math.sin(s.tw) * 0.25;
      ctx.fillStyle = "#f2c94c";
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Pipes
    for (const p of pipes) drawPipePair(p);

    // Ground
    ctx.fillStyle = "#1b1c22";
    ctx.fillRect(0, FB_CFG.GROUND_Y, W, FB_CFG.GROUND_H);
    ctx.fillStyle = "#26272f";
    ctx.fillRect(0, FB_CFG.GROUND_Y, W, 4);
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    const tileW = 26;
    for (let x = -tileW + (groundOffset % tileW) * -1; x < W; x += tileW) {
      ctx.fillRect(x, FB_CFG.GROUND_Y + 8, tileW / 2, 3);
    }
    ctx.restore();

    // Bird
    drawBird();
  }

  function drawPipePair(p) {
    const W = FB_CFG.PIPE_W;
    const topH = p.gapY;
    const botY = p.gapY + p.gapH;
    const botH = FB_CFG.GROUND_Y - botY;

    ctx.fillStyle = "#2f9e56";
    roundRectTopless(p.x, 0, W, topH);
    roundRectBottomless(p.x, botY, W, botH);

    // Lip detail
    ctx.fillStyle = "#3ba55d";
    ctx.fillRect(p.x - 4, Math.max(0, topH - 20), W + 8, 20);
    ctx.fillRect(p.x - 4, botY, W + 8, 20);
    ctx.strokeStyle = "rgba(0,0,0,0.25)";
    ctx.lineWidth = 2;
    ctx.strokeRect(p.x - 4, Math.max(0, topH - 20), W + 8, 20);
    ctx.strokeRect(p.x - 4, botY, W + 8, 20);
  }
  function roundRectTopless(x, y, w, h) {
    const r = 6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.closePath();
    ctx.fill();
  }
  function roundRectBottomless(x, y, w, h) {
    const r = 6;
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x + w, y + r);
    ctx.quadraticCurveTo(x + w, y, x + w - r, y);
    ctx.lineTo(x + r, y);
    ctx.quadraticCurveTo(x, y, x, y + r);
    ctx.closePath();
    ctx.fill();
  }

  function drawBird() {
    const x = FB_CFG.BIRD_X, y = bird.y, r = FB_CFG.BIRD_R;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(bird.rot);

    // Body — gold, echoing the star in the GAICANI logo
    const bg = ctx.createRadialGradient(-r*0.3, -r*0.3, 1, 0, 0, r*1.3);
    bg.addColorStop(0, "#ffe9a8");
    bg.addColorStop(1, "#f2c94c");
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();

    // Wing (flaps with a simple sine cycle)
    const wingLift = Math.sin(wingPhase) * 6;
    ctx.fillStyle = "#e0ad2c";
    ctx.beginPath();
    ctx.ellipse(-2, 2 + wingLift * 0.3, r * 0.62, r * 0.4, -0.3, 0, Math.PI * 2);
    ctx.fill();

    // Beak
    ctx.fillStyle = "#f2843c";
    ctx.beginPath();
    ctx.moveTo(r * 0.75, -2);
    ctx.lineTo(r * 1.35, 2);
    ctx.lineTo(r * 0.75, 7);
    ctx.closePath();
    ctx.fill();

    // Eye
    ctx.fillStyle = "#1e1f22";
    ctx.beginPath();
    ctx.arc(r * 0.35, -r * 0.28, 2.4, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  /* ══════════════════════════════════════════════════════════════════
     Physics + game loop
     ══════════════════════════════════════════════════════════════════ */
  function spawnPipeIfNeeded() {
    const last = pipes[pipes.length - 1];
    if (!last || last.x <= FB_CFG.CANVAS_W - spacingForScore(score)) {
      const gapH = gapForScore(score);
      const margin = 40;
      const gapY = margin + Math.random() * (FB_CFG.GROUND_Y - margin * 2 - gapH);
      pipes.push({ x: FB_CFG.CANVAS_W + FB_CFG.PIPE_W, gapY, gapH, passed: false });
    }
  }

  function updatePhysics(dt) {
    const speed = speedForScore(score);

    spawnPipeIfNeeded();

    for (const p of pipes) p.x -= speed * dt;
    pipes = pipes.filter(p => p.x > -FB_CFG.PIPE_W - 10);

    groundOffset += speed * dt;
    wingPhase += dt * 10;

    bird.vel += FB_CFG.GRAVITY * dt;
    bird.y += bird.vel * dt;
    bird.rot = clamp(bird.vel / 700, -0.5, 1.1);

    // Ceiling / ground collision
    if (bird.y - FB_CFG.BIRD_R <= 0) {
      bird.y = FB_CFG.BIRD_R;
      return endGame();
    }
    if (bird.y + FB_CFG.BIRD_R >= FB_CFG.GROUND_Y) {
      bird.y = FB_CFG.GROUND_Y - FB_CFG.BIRD_R;
      return endGame();
    }

    // Pipe collision + scoring
    for (const p of pipes) {
      const withinX = FB_CFG.BIRD_X + FB_CFG.BIRD_R > p.x && FB_CFG.BIRD_X - FB_CFG.BIRD_R < p.x + FB_CFG.PIPE_W;
      if (withinX) {
        const inGap = bird.y - FB_CFG.BIRD_R > p.gapY && bird.y + FB_CFG.BIRD_R < p.gapY + p.gapH;
        if (!inGap) return endGame();
      }
      if (!p.passed && p.x + FB_CFG.PIPE_W < FB_CFG.BIRD_X - FB_CFG.BIRD_R) {
        p.passed = true;
        score++;
        elHudScore.textContent = String(score);
      }
    }
  }

  function loop(now) {
    if (state !== STATE.PLAYING) return;
    if (!lastT) lastT = now;
    let dt = (now - lastT) / 1000;
    lastT = now;
    dt = Math.min(dt, 1 / 30); // clamp so a backgrounded/throttled tab can't skip the bird through a pipe

    const stillPlaying = updatePhysics(dt) !== "over";
    drawFrame(dt);

    if (state === STATE.PLAYING) rafId = requestAnimationFrame(loop);
  }

  function startPlaying() {
    resetGame();
    hideOverlay(elStartOverlay);
    hideOverlay(elGameOverOverlay);
    elHudScore.classList.add("visible");
    state = STATE.PLAYING;
    lastT = 0;
    bird.vel = FB_CFG.FLAP_VELOCITY; // first tap doubles as the first flap
    requestSession();
    rafId = requestAnimationFrame(loop);
  }

  function endGame() {
    state = STATE.OVER;
    cancelAnimationFrame(rafId);
    elHudScore.classList.remove("visible");
    elFinalScore.textContent = String(score);
    elGameOverBest.textContent = String(myBest);
    elNewBestBadge.style.display = "none";
    showOverlay(elGameOverOverlay);
    submitScore(score);
    return "over";
  }

  /* ══════════════════════════════════════════════════════════════════
     Start overlay + ad gate.

     Players who aren't ad-exempt must press a button before EACH round,
     which opens an ad in a new tab. It's deliberately two steps — press
     the button (ad opens), then come back and tap to play — because the
     ad tab takes the player away; starting the round at the same moment
     would leave the bird falling while they're looking at the ad.

     Exempt players (pro, or inside a 24h ad-free window earned by scoring
     20+) skip the gate and just tap to start, as before.
     ══════════════════════════════════════════════════════════════════ */
  function renderStartOverlay() {
    elStartOverlay.style.background = "";
    elStartOverlay.innerHTML = `
      <div class="fb-overlay-title">მზად ხარ?</div>
      <div class="fb-overlay-sub">შეხებით ან <strong>Space</strong>-ით ფრინავს აფრენ. მოერიდე მილებს!</div>
      <div class="fb-tap-hint">▲ შეეხე დასაწყებად ▲</div>
    `;
  }
  renderStartOverlay();

  /* ══════════════════════════════════════════════════════════════════
     Input
     ══════════════════════════════════════════════════════════════════ */
  function handleFlapInput() {
    if (state === STATE.IDLE) {
      startPlaying();
      return;
    }
    if (state === STATE.PLAYING) { bird.vel = FB_CFG.FLAP_VELOCITY; }
  }
  elCanvasBox.addEventListener("pointerdown", (e) => { e.preventDefault(); handleFlapInput(); });
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space") { e.preventDefault(); handleFlapInput(); }
  });

  elRestartBtn.addEventListener("click", () => {
    hideOverlay(elGameOverOverlay);
    state = STATE.IDLE;
    resetGame();
    drawFrame(0);
    renderStartOverlay();
    showOverlay(elStartOverlay);
  });

  /* ══════════════════════════════════════════════════════════════════
     Server communication
     ══════════════════════════════════════════════════════════════════ */
  let socket = null;

  function requestSession() {
    sessionId = null;
    if (socket && socket.connected) socket.emit("flappy:start");
  }

  function submitScore(finalScore) {
    if (!socket || !socket.connected) { pendingScoreSubmit = finalScore; return; }
    if (!sessionId) { pendingScoreSubmit = finalScore; return; }
    socket.emit("flappy:submitScore", { sessionId, score: finalScore });
  }

  /* ══════════════════════════════════════════════════════════════════
     Leaderboard rendering
     ══════════════════════════════════════════════════════════════════ */
  const MEDALS = { 1: "🥇", 2: "🥈", 3: "🥉" };

  function renderPodium(top3) {
    const byRank = [1, 2, 3].map(rank => top3[rank - 1] || null);
    elPodium.innerHTML = byRank.map((row, i) => {
      const rank = i + 1;
      if (!row) {
        return `<div class="fb-podium-slot rank-${rank}"><div class="fb-podium-medal">${MEDALS[rank]}</div><div class="fb-podium-empty">—</div></div>`;
      }
      return `
        <div class="fb-podium-slot rank-${rank}">
          <div class="fb-podium-medal">${MEDALS[rank]}</div>
          <div class="fb-podium-name">${esc(row.username)}</div>
          <div class="fb-podium-score">${esc(String(row.score))}</div>
        </div>`;
    }).join("");
  }

  async function loadLeaderboardInitial() {
    try {
      const r = await fetch("/api/flappy/leaderboard");
      const d = await r.json();
      renderPodium(d.top3 || []);
    } catch (_) { /* leaderboard is non-critical — game still works without it */ }
  }

  /* ══════════════════════════════════════════════════════════════════
     Init — auth gate, then boot the game. Registered users use their
     saved token; anyone else gets a temporary guest identity instead of
     being blocked — same everywhere-else-on-the-site pattern, so guests
     can play Flappy Bird too and still show up on the leaderboard.
     ══════════════════════════════════════════════════════════════════ */
  // Registered accounts only — anyone else sees the registration gate. The
  // server enforces the same rule (flappy:start rejects guests), so this is
  // the friendly front door, not the lock.
  function showRegisterGate() {
    if (socket) { try { socket.disconnect(); } catch (_) {} }
    elApp.classList.remove("visible");
    elLoading.style.display = "none";
    elGuestGate.classList.add("visible");
  }

  async function init() {
    const { token, username } = loadAuth();

    // No account on this device → straight to the gate. No point opening a
    // connection as a guest just to be turned away.
    if (!token) { showRegisterGate(); return; }

    socket = io();
    socket.on("connect", () => {
      socket.emit("auth:token", { token });
    });

    socket.on("flappy:registerRequired", showRegisterGate);

    socket.on("auth:authenticated", ({ username: authedName, isGuest } = {}) => {
      // A real token never authenticates as a guest, but if it somehow did,
      // guests don't get to play — show the gate rather than the game.
      if (isGuest) { showRegisterGate(); return; }

      elTopUsername.textContent = `🔐 ${authedName || username}`;
      elLoading.style.display = "none";
      elApp.classList.add("visible");
      loadLeaderboardInitial();
      requestSession();
    });

    socket.on("auth:invalid", () => {
      clearAuth();
      elLoading.style.display = "none";
      elGuestGate.classList.add("visible");
    });

    socket.on("flappy:sessionStarted", ({ sessionId: sid }) => {
      sessionId = sid;
      if (pendingScoreSubmit !== null) {
        const s = pendingScoreSubmit;
        pendingScoreSubmit = null;
        submitScore(s);
      }
    });

    socket.on("flappy:scoreResult", ({ accepted, personalBest, isNewBest } = {}) => {
      if (!accepted) return; // rejected by anti-cheat — leaderboard/best simply won't move
      if (typeof personalBest === "number") {
        myBest = personalBest;
        elBestScoreChip.textContent = String(myBest);
        elGameOverBest.textContent = String(myBest);
      }
      if (isNewBest) {
        elNewBestBadge.style.display = "inline-flex";
        showToast("🎉 ახალი პირადი რეკორდი!");
      }
    });

    socket.on("flappy:error", ({ error }) => {
      if (error) showToast(`⚠️ ${esc(error)}`);
    });

    socket.on("flappy:leaderboardUpdate", (top3) => renderPodium(top3 || []));
  }

  document.addEventListener("DOMContentLoaded", init);
})();
