"use strict";
/* ════════════════════════════════════════════════════════════════════════
   ბურა — rules engine
   ------------------------------------------------------------------------
   Pure game logic only: no sockets, no rooms, no timers. Everything here is
   a plain function over plain data, so the rules can be tested exhaustively
   on their own. The networking layer in server.js drives this.

   Card representation: "<rank><suit>", e.g. "As", "10h", "6c".
     ranks: 6 7 8 9 J Q K 10 A     suits: s(♠) h(♥) d(♦) c(♣)
   ════════════════════════════════════════════════════════════════════════ */

const SUITS = ["s", "h", "d", "c"];

// Bura's order is NOT the usual one: the 10 sits between K and A, so it is
// the second-strongest card in the game. Only the ace beats it.
const RANK_ORDER = ["6", "7", "8", "9", "J", "Q", "K", "10", "A"];

const CARD_POINTS = { "A": 11, "10": 10, "K": 4, "Q": 3, "J": 2, "9": 0, "8": 0, "7": 0, "6": 0 };

const TOTAL_POINTS = 120;   // full deck is always 120 points, in both variants
const WIN_POINTS   = 61;    // 61+ takes the round; 60-60 is ყაიმი (a draw)

// Call ladder. Each step multiplies what the round is worth.
const CALLS = {
  davi:  { order: 1, multiplier: 2, label: "დავი"  },
  se:    { order: 2, multiplier: 3, label: "სე"    },
  chari: { order: 3, multiplier: 4, label: "ჩარი"  },
  fanji: { order: 4, multiplier: 5, label: "ფანჯი" },
  shashi:{ order: 5, multiplier: 6, label: "შაში"  },
};
const CALL_SEQUENCE = ["davi", "se", "chari", "fanji", "shashi"];

/* ── Card helpers ─────────────────────────────────────────────────────── */

function cardSuit(card) { return card.slice(-1); }
function cardRank(card) { return card.slice(0, -1); }
function cardPoints(card) { return CARD_POINTS[cardRank(card)] ?? 0; }
function rankValue(card) { return RANK_ORDER.indexOf(cardRank(card)); }

function buildDeck(mode) {
  // "classic" = 4 players, 36 cards (6..A)
  // "three"   = 1v1 three-card bura, 20 cards (10,J,Q,K,A) — 6..9 removed
  const ranks = mode === "three" ? ["J", "Q", "K", "10", "A"] : RANK_ORDER;
  const deck = [];
  for (const s of SUITS) for (const r of ranks) deck.push(r + s);
  return deck;
}

function shuffleDeck(deck, rng = Math.random) {
  const copy = [...deck];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function handPoints(cards) {
  return cards.reduce((sum, c) => sum + cardPoints(c), 0);
}

/* ── Beating ──────────────────────────────────────────────────────────── */

// Does `attacker` beat `target`, given the trump suit?
//   * trump beats any non-trump
//   * same suit → higher rank wins
//   * a different non-trump suit does NOT beat anything (it's just discarded)
function beats(attacker, target, trump) {
  const aSuit = cardSuit(attacker), tSuit = cardSuit(target);
  const aTrump = aSuit === trump, tTrump = tSuit === trump;
  if (aTrump && !tTrump) return true;
  if (!aTrump && tTrump) return false;
  if (aSuit !== tSuit) return false;          // different non-trump suits never beat
  return rankValue(attacker) > rankValue(target);
}

// To take the trick, every led card must be answered by a distinct card that
// beats it. That's a bipartite matching problem, not a simple pairwise scan —
// with up to 5 cards a naive "compare in order" check gives wrong answers,
// so this searches for a full matching.
function canBeatAll(played, led, trump) {
  if (played.length !== led.length) return false;
  const n = led.length;
  const used = new Array(n).fill(false);

  function match(i) {
    if (i === n) return true;
    for (let j = 0; j < n; j++) {
      if (used[j]) continue;
      if (!beats(played[j], led[i], trump)) continue;
      used[j] = true;
      if (match(i + 1)) return true;
      used[j] = false;
    }
    return false;
  }
  return match(0);
}

/* ── Move validation ──────────────────────────────────────────────────── */

// A lead must be 1..maxCards cards, all of the SAME suit, all held.
function validateLead(cards, hand, maxCards) {
  if (!Array.isArray(cards) || cards.length < 1 || cards.length > maxCards) {
    return { ok: false, error: "არასწორი კარტების რაოდენობა" };
  }
  if (new Set(cards).size !== cards.length) {
    return { ok: false, error: "კარტი გამეორებულია" };
  }
  for (const c of cards) {
    if (!hand.includes(c)) return { ok: false, error: "ეს კარტი ხელში არ გაქვს" };
  }
  const suit = cardSuit(cards[0]);
  if (!cards.every(c => cardSuit(c) === suit)) {
    return { ok: false, error: "ჩამოსვლისას ყველა კარტი ერთი ფერის უნდა იყოს" };
  }
  return { ok: true };
}

// A response must match the led count exactly. Any suits are allowed —
// whether it actually takes the trick is decided separately by canBeatAll.
function validateResponse(cards, hand, ledCount) {
  if (!Array.isArray(cards) || cards.length !== ledCount) {
    return { ok: false, error: `უნდა დადო ზუსტად ${ledCount} კარტი` };
  }
  if (new Set(cards).size !== cards.length) {
    return { ok: false, error: "კარტი გამეორებულია" };
  }
  for (const c of cards) {
    if (!hand.includes(c)) return { ok: false, error: "ეს კარტი ხელში არ გაქვს" };
  }
  return { ok: true };
}

/* ── Malutka ──────────────────────────────────────────────────────────── */

// Playing your whole hand at once on your own lead. Normally every card must
// be trump; a room option loosens that to "any single suit".
function isMalutka(cards, handSize, trump, anySuitAllowed) {
  if (cards.length !== handSize) return false;
  if (cards.length === 0) return false;
  const suits = new Set(cards.map(cardSuit));
  if (suits.size !== 1) return false;         // mixed suits is never a malutka
  if (anySuitAllowed) return true;
  return cards.every(c => cardSuit(c) === trump);
}

/* ── Calls ────────────────────────────────────────────────────────────── */

// Calls must climb: you can only name one strictly above the current level.
function canCall(call, currentCall) {
  if (!CALLS[call]) return false;
  if (!currentCall) return call === "davi";
  return CALLS[call].order === CALLS[currentCall].order + 1;
}

function callMultiplier(call) {
  return call && CALLS[call] ? CALLS[call].multiplier : 1;
}

// Conceding hands the caller what the round was worth BEFORE their call —
// so conceding a დავი gives 1 point, not 2.
function concedeValue(currentCall) {
  if (!currentCall) return 1;
  const idx = CALL_SEQUENCE.indexOf(currentCall);
  if (idx <= 0) return 1;
  return CALLS[CALL_SEQUENCE[idx - 1]].multiplier;
}

/* ── Round scoring ────────────────────────────────────────────────────── */

// Decides a finished round from each team's captured points.
// 61+ wins; an exact 60-60 split is ყაიმი and nobody scores.
function scoreRound(teamAPoints, teamBPoints, currentCall) {
  const mult = callMultiplier(currentCall);
  if (teamAPoints >= WIN_POINTS) return { winner: "A", points: mult, tie: false };
  if (teamBPoints >= WIN_POINTS) return { winner: "B", points: mult, tie: false };
  return { winner: null, points: 0, tie: true };   // 60-60
}

/* ── Three-card variant: "ვარ" ────────────────────────────────────────── */

// Only in 1v1 three-card bura. Declaring ვარ claims the round immediately:
// 31+ captured points wins it, anything less loses it. There is no draw here.
function resolveVar(declarerPoints, currentCall) {
  const mult = callMultiplier(currentCall);
  return declarerPoints >= 31
    ? { declarerWins: true,  points: mult }
    : { declarerWins: false, points: mult };
}

module.exports = {
  SUITS, RANK_ORDER, CARD_POINTS, TOTAL_POINTS, WIN_POINTS, CALLS, CALL_SEQUENCE,
  cardSuit, cardRank, cardPoints, rankValue,
  buildDeck, shuffleDeck, handPoints,
  beats, canBeatAll,
  validateLead, validateResponse,
  isMalutka,
  canCall, callMultiplier, concedeValue,
  scoreRound, resolveVar,
};
