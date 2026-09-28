"use strict";
/* ════════════════════════════════════════════════════════════════════════
   ბურა — game loop
   ------------------------------------------------------------------------
   Turn order, tricks, refills, round and match scoring. Sits on top of
   bura-engine.js (pure rules) and is still free of any networking, so the
   whole flow can be driven and tested without sockets.

   TWO RULES THE WRITTEN RULES DIDN'T PIN DOWN — decided as follows:

   1. If nobody beats the lead, the LEADER takes their own trick and leads
      again. The lead only moves when someone actually beats it. (The
      alternative — passing the lead on a failed trick — would make leading
      strictly bad, which contradicts how the calls work.)

   2. All other players respond in clockwise order, then the trick resolves.
      A player takes the trick over only by beating what is CURRENTLY
      winning, so the last player to beat it wins. This is what makes
      გატანება work: a player who can't take it discards points onto the
      trick, hoping their partner is the one holding it.

   Both are easy to flip if your table plays them differently.
   ════════════════════════════════════════════════════════════════════════ */

const E = require("./bura-engine.js");

const TEAM_OF_SEAT = { 0: "A", 1: "B", 2: "A", 3: "B" }; // partners sit opposite

function createGame(opts = {}) {
  const mode = opts.mode === "three" ? "three" : "classic";
  const seatCount = mode === "three" ? 2 : 4;
  return {
    mode,
    seatCount,
    handSize: mode === "three" ? 3 : 5,
    target: opts.target || 6,              // match runs to 6 / 11 / 21
    malutkaAnySuit: !!opts.malutkaAnySuit, // room option
    matchScore: { A: 0, B: 0 },
    round: null,
    finished: false,
    winner: null,
  };
}

function teamOfSeat(game, seat) {
  return game.mode === "three" ? (seat === 0 ? "A" : "B") : TEAM_OF_SEAT[seat];
}

function startRound(game, dealerSeat = 0, rng = Math.random) {
  const deck = E.shuffleDeck(E.buildDeck(game.mode), rng);
  const hands = [];
  for (let s = 0; s < game.seatCount; s++) hands.push(deck.splice(0, game.handSize));

  // The trump card sits at the BOTTOM of the deck and is drawn last.
  const trumpCard = deck[deck.length - 1];
  const trump = trumpCard ? E.cardSuit(trumpCard) : null;

  game.round = {
    deck,
    hands,
    trump,
    trumpCard,
    dealerSeat,
    turnSeat: (dealerSeat + 1) % game.seatCount, // left of dealer leads first
    leaderSeat: (dealerSeat + 1) % game.seatCount,
    trick: null,
    captured: { A: [], B: [] },
    currentCall: null,
    callingTeam: null,
    pendingCall: null,     // a call awaiting the other team's answer
    phase: "lead",         // lead | respond | callAnswer | done
    lastTrickWinner: null,
    varDeclared: false,
  };
  return game.round;
}

/* ── Leading ──────────────────────────────────────────────────────────── */

// The most cards that may be led right now. Once the deck runs dry, refills
// go winner-first and hands stop being equal — so leading more cards than the
// shortest hand holds would leave someone unable to answer. Capping the lead
// at the smallest hand keeps every response playable.
// (Found by stress-testing full matches; the fixed-size unit tests never hit
// it because hands only go uneven in the deck's final few tricks.)
function maxLeadSize(game) {
  const r = game.round;
  // Only seats still holding cards matter — an empty seat sits out and
  // shouldn't drag the cap to zero.
  const active = r.hands.map(h => h.length).filter(n => n > 0);
  if (!active.length) return 1;
  return Math.max(1, Math.min(game.handSize, Math.min(...active)));
}

// Next seat clockwise that still holds cards. Returns null if nobody does.
// Near the end of a round the deck is empty and players run out at different
// times; a seat with no cards simply sits the rest of the round out rather
// than blocking the trick from ever completing.
function nextSeatWithCards(game, fromSeat) {
  const r = game.round;
  for (let i = 1; i <= game.seatCount; i++) {
    const seat = (fromSeat + i) % game.seatCount;
    if (r.hands[seat].length > 0) return seat;
  }
  return null;
}

function playLead(game, seat, cards) {
  const r = game.round;
  if (!r || r.phase !== "lead") return { ok: false, error: "ახლა ჩამოსვლის დრო არ არის" };
  if (seat !== r.turnSeat) return { ok: false, error: "ახლა შენი რიგი არ არის" };

  const hand = r.hands[seat];
  const v = E.validateLead(cards, hand, maxLeadSize(game));
  if (!v.ok) return v;

  const malutka = E.isMalutka(cards, hand.length, r.trump, game.malutkaAnySuit);

  r.hands[seat] = hand.filter(c => !cards.includes(c));
  r.trick = {
    leaderSeat: seat,
    ledCards: [...cards],
    count: cards.length,
    plays: [{ seat, cards: [...cards] }],
    winningSeat: seat,
    winningCards: [...cards],
    malutka,
  };
  r.leaderSeat = seat;
  // Everyone still holding cards owes a response to this trick.
  r.trick.participants = r.hands.reduce((acc, h, i) => {
    if (i === seat || h.length > 0) acc.push(i);
    return acc;
  }, []);
  const nxt = nextSeatWithCards(game, seat);
  if (nxt === null) {
    // Nobody else can answer — the lead stands and the trick resolves at once.
    r.phase = "respond";
    return { ok: true, malutka, resolved: resolveTrick(game) };
  }
  r.turnSeat = nxt;
  r.phase = "respond";
  return { ok: true, malutka };
}

/* ── Responding ───────────────────────────────────────────────────────── */

function playResponse(game, seat, cards) {
  const r = game.round;
  if (!r || r.phase !== "respond") return { ok: false, error: "ახლა პასუხის დრო არ არის" };
  if (seat !== r.turnSeat) return { ok: false, error: "ახლა შენი რიგი არ არის" };

  const hand = r.hands[seat];
  // Normally you answer with exactly as many cards as were led. In the last
  // tricks of a round a player can be holding fewer than that — in which case
  // they play out whatever they have left rather than being stuck unable to
  // move. (Rare: about 1 round in 2000 in stress testing, but it deadlocked
  // the round when it happened.)
  const need = Math.min(r.trick.count, hand.length);
  const v = E.validateResponse(cards, hand, need);
  if (!v.ok) return v;

  r.hands[seat] = hand.filter(c => !cards.includes(c));

  // You only take the trick over by beating what is CURRENTLY winning —
  // not merely the original lead.
  const took = E.canBeatAll(cards, r.trick.winningCards, r.trump);
  r.trick.plays.push({ seat, cards: [...cards], took });
  if (took) {
    r.trick.winningSeat = seat;
    r.trick.winningCards = [...cards];
  }

  const expected = r.trick.participants ? r.trick.participants.length : game.seatCount;
  const allPlayed = r.trick.plays.length >= expected;
  if (!allPlayed) {
    const nxt = nextSeatWithCards(game, seat);
    if (nxt !== null && !r.trick.plays.some(p => p.seat === nxt)) {
      r.turnSeat = nxt;
      return { ok: true, took, trickComplete: false };
    }
  }
  return { ok: true, took, trickComplete: true, resolved: resolveTrick(game) };
}

function resolveTrick(game) {
  const r = game.round;
  const t = r.trick;
  const winnerSeat = t.winningSeat;
  const winnerTeam = teamOfSeat(game, winnerSeat);

  // Every card on the table goes to the winning team — this is how გატანება
  // pays off: points discarded by a partner end up captured.
  const all = t.plays.flatMap(p => p.cards);
  r.captured[winnerTeam].push(...all);

  r.lastTrickWinner = winnerSeat;
  r.trick = null;

  refillHands(game, winnerSeat);

  const out = { winnerSeat, winnerTeam, points: E.handPoints(all) };

  if (roundIsOver(game)) {
    r.phase = "done";
    out.roundOver = true;
  } else {
    // Taker leads next — unless they're out of cards, in which case the lead
    // moves on to the next seat that still has some.
    const leadSeat = r.hands[winnerSeat].length > 0
      ? winnerSeat
      : nextSeatWithCards(game, winnerSeat);
    if (leadSeat === null) { r.phase = "done"; out.roundOver = true; return out; }
    r.leaderSeat = leadSeat;
    r.turnSeat = leadSeat;
    r.phase = "lead";
  }
  return out;
}

// Refill starting from the trick winner, going clockwise, back up to handSize.
function refillHands(game, startSeat) {
  const r = game.round;
  for (let i = 0; i < game.seatCount; i++) {
    const seat = (startSeat + i) % game.seatCount;
    while (r.hands[seat].length < game.handSize && r.deck.length > 0) {
      r.hands[seat].push(r.deck.shift());
    }
  }
}

function roundIsOver(game) {
  const r = game.round;
  return r.deck.length === 0 && r.hands.every(h => h.length === 0);
}

/* ── Calls ────────────────────────────────────────────────────────────── */

function makeCall(game, seat, call) {
  const r = game.round;
  if (!r) return { ok: false, error: "რაუნდი არ მიმდინარეობს" };
  if (r.pendingCall) return { ok: false, error: "გამოძახება უკვე გაკეთებულია" };
  if (seat !== r.turnSeat) return { ok: false, error: "გამოძახება მხოლოდ შენს სვლაზე შეიძლება" };
  if (!E.canCall(call, r.currentCall)) return { ok: false, error: "ასეთი გამოძახება ვერ გააკეთე" };

  const team = teamOfSeat(game, seat);
  if (r.callingTeam === team) return { ok: false, error: "ორივე გუნდი რიგრიგობით უნდა ახვიდეს" };

  r.pendingCall = { call, bySeat: seat, byTeam: team };
  r.phase = "callAnswer";
  return { ok: true, call, awaitingTeam: team === "A" ? "B" : "A" };
}

// The other team either accepts (round continues at the new price), raises
// (handled by calling makeCall again), or concedes.
function answerCall(game, team, accept) {
  const r = game.round;
  if (!r || !r.pendingCall) return { ok: false, error: "პასუხის მოლოდინში გამოძახება არ არის" };
  const pc = r.pendingCall;
  if (team === pc.byTeam) return { ok: false, error: "შენმა გუნდმა გააკეთა გამოძახება" };

  if (!accept) {
    // Conceding pays the caller what the round was worth BEFORE their call.
    const pts = E.concedeValue(pc.call);
    game.matchScore[pc.byTeam] += pts;
    r.pendingCall = null;
    r.phase = "done";
    checkMatchEnd(game);
    return { ok: true, conceded: true, winner: pc.byTeam, points: pts };
  }

  r.currentCall = pc.call;
  r.callingTeam = pc.byTeam;
  r.pendingCall = null;
  r.phase = r.trick ? "respond" : "lead";
  return { ok: true, conceded: false, currentCall: r.currentCall };
}

/* ── Round / match scoring ────────────────────────────────────────────── */

function finishRound(game) {
  const r = game.round;
  const aPts = E.handPoints(r.captured.A);
  const bPts = E.handPoints(r.captured.B);
  const res = E.scoreRound(aPts, bPts, r.currentCall);

  if (res.winner) game.matchScore[res.winner] += res.points;
  checkMatchEnd(game);

  return { ...res, teamAPoints: aPts, teamBPoints: bPts, matchScore: { ...game.matchScore } };
}

// Three-card only: ვარ claims the round immediately on 31+ captured points.
function declareVar(game, seat) {
  if (game.mode !== "three") return { ok: false, error: "ვარ მხოლოდ სამკარტა ბურაშია" };
  const r = game.round;
  if (!r) return { ok: false, error: "რაუნდი არ მიმდინარეობს" };
  if (r.lastTrickWinner !== seat) return { ok: false, error: "ვარ მხოლოდ ხელის წაღების შემდეგ შეიძლება" };

  const team = teamOfSeat(game, seat);
  const pts = E.handPoints(r.captured[team]);
  const res = E.resolveVar(pts, r.currentCall);
  const winner = res.declarerWins ? team : (team === "A" ? "B" : "A");
  game.matchScore[winner] += res.points;
  r.phase = "done";
  r.varDeclared = true;
  checkMatchEnd(game);
  return { ok: true, declarerWins: res.declarerWins, winner, points: res.points, capturedPoints: pts };
}

function checkMatchEnd(game) {
  for (const team of ["A", "B"]) {
    if (game.matchScore[team] >= game.target) {
      game.finished = true;
      game.winner = team;
    }
  }
}

/* ── View for one seat (never leaks other players' hands) ─────────────── */

function viewForSeat(game, seat) {
  const r = game.round;
  if (!r) return { mode: game.mode, matchScore: game.matchScore, finished: game.finished, winner: game.winner };
  return {
    mode: game.mode,
    target: game.target,
    matchScore: { ...game.matchScore },
    finished: game.finished,
    winner: game.winner,
    trump: r.trump,
    trumpCard: r.trumpCard,
    deckLeft: r.deck.length,
    myHand: [...r.hands[seat]],
    handCounts: r.hands.map(h => h.length),
    turnSeat: r.turnSeat,
    leaderSeat: r.leaderSeat,
    maxLead: maxLeadSize(game),
    phase: r.phase,
    trick: r.trick ? {
      ledCards: r.trick.ledCards,
      count: r.trick.count,
      plays: r.trick.plays,
      winningSeat: r.trick.winningSeat,
      malutka: r.trick.malutka,
    } : null,
    currentCall: r.currentCall,
    callingTeam: r.callingTeam,
    pendingCall: r.pendingCall,
    capturedPoints: { A: E.handPoints(r.captured.A), B: E.handPoints(r.captured.B) },
  };
}

module.exports = {
  createGame, startRound, teamOfSeat, maxLeadSize, nextSeatWithCards,
  playLead, playResponse, resolveTrick, refillHands, roundIsOver,
  makeCall, answerCall,
  finishRound, declareVar, checkMatchEnd,
  viewForSeat,
};
