/* ══════════════════════════════════════════════════════════════════════════
   server-flappybird-patch.js — "მფრინავი ჩიტი" (Flappy Bird) for GAICANI
   ────────────────────────────────────────────────────────────────────────
   HOW TO INTEGRATE INTO server.js:

   STEP 1 — Paste the "STATE" block below near the other top-level Maps —
            e.g. right after the existing block that declares
            `const onlineRegSockets = new Map();` (search for that string;
            it's a few lines below `const registeredUsers = new Map();`).

   STEP 2 — Paste the "CONFIG + HELPERS" block right after STEP 1's Maps.
            These must stay OUTSIDE io.on("connection", ...) — they're
            plain functions used by both the REST endpoint and the socket
            handlers below.

            IMPORTANT: FLAPPY_CFG must stay numerically identical to the
            FB_CFG object in flappy-bird.js. The server doesn't re-simulate
            the game — it only uses these numbers to compute the fastest a
            given score could physically have been reached, as an anti-cheat
            check. If you retune difficulty in flappy-bird.js, copy the same
            numbers here.

   STEP 3 — Paste the REST endpoint near the other `app.get(...)` routes —
            e.g. right after the existing
              app.get("/api/auth/avatars", (req, res) => { ... });
            block. It's public (no auth) since anyone should be able to
            see the leaderboard.

   STEP 4 — Paste the socket handlers INSIDE the *second*
            io.on("connection", (socket) => { ... }) block in server.js —
            the one where `socket._regUser = { usernameLower, ... }` gets
            set (search for that exact string to find it). Add them after
            the existing friend:accept / friend:decline handlers.

   STEP 5 — Inside that SAME io.on block, find the existing:
              socket.on("disconnect", () => {
                ...
                cleanupGameForSocket(socket.id);
              });
            and add the one line marked ← ADD THIS LINE below, right next
            to cleanupGameForSocket(socket.id).

   STEP 6 — Paste the periodic sweep near the other setInterval cleanups —
            e.g. right after the existing interval that expires old
            authTokens (search for `for (const [t, e] of authTokens)`).

   Nothing here touches the random-chat path, friend chat, or the existing
   mini-games (server-games-patch.js) — all new Maps/events, own namespace.
   ══════════════════════════════════════════════════════════════════════════ */


/* ── STEP 1 — State (near the other top-level Maps) ─────────────────────── */

const flappySessions   = new Map(); // sessionId → { usernameLower, socketId, startAt, submitted }
const flappyLastSubmit = new Map(); // usernameLower → timestamp (simple per-user rate limit)


/* ── STEP 2 — Config + helpers (outside io.on) ───────────────────────────── */

// Keep numerically identical to FB_CFG in flappy-bird.js — see note above.
const FLAPPY_CFG = {
  GAP_START: 170, GAP_MIN: 108, GAP_DECAY: 2.2,
  SPEED_START: 220, SPEED_MAX: 430, SPEED_GROWTH: 4,
  SPACING_START: 300, SPACING_MIN: 210, SPACING_DECAY: 1.5,
};

function flappySpeedForScore(s)   { return Math.min(FLAPPY_CFG.SPEED_MAX, FLAPPY_CFG.SPEED_START + s * FLAPPY_CFG.SPEED_GROWTH); }
function flappySpacingForScore(s) { return Math.max(FLAPPY_CFG.SPACING_MIN, FLAPPY_CFG.SPACING_START - s * FLAPPY_CFG.SPACING_DECAY); }

// Physics-grounded lower bound: pipes physically can't be passed faster than
// they travel to the bird at the score-dependent speed/spacing, so summing
// per-pipe travel time gives the fastest ANY score could legitimately be
// reached. This is the main anti-cheat check on submission — see STEP 4.
function flappyMinTimeMs(score) {
  let t = 0;
  for (let n = 0; n < score; n++) t += flappySpacingForScore(n) / flappySpeedForScore(n);
  return t * 1000;
}

function flappyGenSessionId() {
  return `fb_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// Scans registeredUsers for the current top 3 by flappyHighScore. A full
// scan is trivial at the scale of a Map like registeredUsers; if this ever
// needs to run against a huge user base, swap this for an incrementally
// maintained top-N structure instead of scanning on every score submission.
function getFlappyTop3() {
  const rows = [];
  for (const [lc, u] of registeredUsers) {
    if (u.flappyHighScore) {
      rows.push({ id: lc, username: u.username, score: u.flappyHighScore, achievedAt: u.flappyHighScoreAt || null });
    }
  }
  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, 3);
}

function broadcastFlappyLeaderboard() {
  io.emit("flappy:leaderboardUpdate", getFlappyTop3());
}


/* ── STEP 3 — REST endpoint (near the other app.get routes) ─────────────── */

// GET /api/flappy/leaderboard — public, no auth: the top-3 board is meant
// to be visible to anyone, same spirit as the site being viewable without
// an account.
app.get("/api/flappy/leaderboard", (req, res) => {
  res.json({ top3: getFlappyTop3() });
});


/* ── STEP 4 — Socket handlers (paste inside the SECOND io.on("connection", ── */
/*            socket => { ... }) block, after the existing friend:* ones)   */

/*

  // ── flappy:start — begin a new anti-cheat session ────────────────────────
  // Client calls this right when a game becomes playable; server stamps the
  // real start time server-side (the client can't be trusted to report this
  // itself) so flappy:submitScore below has something honest to check against.
  socket.on("flappy:start", () => {
    if (!socket._regUser) {
      socket.emit("flappy:error", { error: "საჭიროა შესვლა" });
      return;
    }
    const sessionId = flappyGenSessionId();
    flappySessions.set(sessionId, {
      usernameLower: socket._regUser.usernameLower,
      socketId: socket.id,
      startAt: Date.now(),
      submitted: false,
    });
    socket.emit("flappy:sessionStarted", { sessionId });
  });

  // ── flappy:submitScore — validate + record a finished game's score ───────
  socket.on("flappy:submitScore", ({ sessionId, score }) => {
    if (!socket._regUser) return;

    const numScore = Number(score);
    if (!Number.isFinite(numScore) || !Number.isInteger(numScore) || numScore < 0) return;

    const session = flappySessions.get(sessionId);
    if (!session || session.usernameLower !== socket._regUser.usernameLower) {
      socket.emit("flappy:scoreResult", { accepted: false, reason: "invalid_session" });
      return;
    }
    if (session.submitted) {
      socket.emit("flappy:scoreResult", { accepted: false, reason: "already_submitted" });
      return;
    }

    // Per-user rate limit — a real game takes at least a couple of seconds,
    // so nothing legitimate should ever submit faster than this.
    const lastSubmit = flappyLastSubmit.get(socket._regUser.usernameLower) || 0;
    if (Date.now() - lastSubmit < 2000) {
      socket.emit("flappy:scoreResult", { accepted: false, reason: "rate_limited" });
      return;
    }

    // Hard ceiling — backstop against corrupted/absurd values regardless of timing.
    if (numScore > 5000) {
      socket.emit("flappy:scoreResult", { accepted: false, reason: "implausible" });
      return;
    }

    // Physics-grounded plausibility check (see flappyMinTimeMs above).
    // 25% slack absorbs render/network jitter without meaningfully opening
    // the door to speedhack-style cheating.
    const elapsed      = Date.now() - session.startAt;
    const minPlausible = flappyMinTimeMs(numScore) * 0.75;
    if (numScore > 0 && elapsed < minPlausible) {
      socket.emit("flappy:scoreResult", { accepted: false, reason: "too_fast" });
      console.log(`[FLAPPY] Rejected implausible score: ${socket._regUser.username} claimed ${numScore} in ${elapsed}ms (needs >= ${minPlausible.toFixed(0)}ms)`);
      return;
    }

    session.submitted = true;
    flappyLastSubmit.set(socket._regUser.usernameLower, Date.now());

    const user = registeredUsers.get(socket._regUser.usernameLower);
    if (!user) return;

    const prevBest  = user.flappyHighScore || 0;
    const isNewBest = numScore > prevBest;
    if (isNewBest) {
      user.flappyHighScore   = numScore;
      user.flappyHighScoreAt = new Date().toISOString();
      saveAuthUsers();
    }

    socket.emit("flappy:scoreResult", {
      accepted: true,
      score: numScore,
      personalBest: user.flappyHighScore || 0,
      isNewBest,
    });

    if (isNewBest) {
      const top3 = getFlappyTop3();
      if (top3.some(r => r.id === socket._regUser.usernameLower)) {
        broadcastFlappyLeaderboard(); // pushes the live update to every connected client
      }
    }

    flappySessions.delete(sessionId);
  });

*/


/* ── STEP 5 — one line inside the existing disconnect handler ───────────── */
//
//   socket.on("disconnect", () => {
//     ... existing cleanup ...
//     cleanupGameForSocket(socket.id);
//     for (const [sid, s] of flappySessions) if (s.socketId === socket.id) flappySessions.delete(sid); // ← ADD THIS LINE
//   });


/* ── STEP 6 — periodic sweep for abandoned sessions (outside io.on) ─────── */

/*

setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of flappySessions) {
    if (now - s.startAt > 30 * 60 * 1000) flappySessions.delete(sid); // 30 min = generous max game length
  }
}, 60 * 60 * 1000);

*/


/* ══════════════════════════════════════════════════════════════════════════
   DATA SHAPE — what gets added to each user object in registeredUsers
   ────────────────────────────────────────────────────────────────────────
   user.flappyHighScore   — number, the user's personal best (undefined until
                             their first accepted score)
   user.flappyHighScoreAt — ISO date string of when that best was set

   Both persist automatically through the existing saveAuthUsers() /
   registered_users.json mechanism — no schema migration needed, old user
   records simply don't have these two fields until they play once.
   ══════════════════════════════════════════════════════════════════════════ */
