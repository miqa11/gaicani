// ── 🤖 Computer opponents: how they choose a move ───────────────────────────
// Pure decision code for chess, checkers and joker. It plays through the
// server's own tested rules engines (passed in as E), so a computer can never
// make an illegal move. Searches are capped by time and node count — this
// runs on the same thread as everything else, so a move must stay quick.
"use strict";

module.exports = function makeBots(E) {
  const rnd = (n) => Math.floor(Math.random() * n);
  const now = () => Date.now();

  // ══ Chess ═══════════════════════════════════════════════════════════════
  // Negamax with alpha-beta, iterative deepening and a short capture search,
  // scored by material and piece-square tables.
  const VAL = { P: 100, N: 320, B: 330, R: 500, Q: 900, K: 0 };
  // Tables are written rank 8 → rank 1 as seen by white (the usual layout).
  const PST = {
    P: [0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5,
      0, 0, 0, 20, 20, 0, 0, 0, 5, -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0],
    N: [-50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10, 0, -30, -30, 5, 15, 20, 20, 15, 5, -30,
      -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10, 5, -30, -40, -20, 0, 5, 5, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50],
    B: [-20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 5, 5, 10, 10, 5, 5, -10,
      -10, 0, 10, 10, 10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 5, 0, 0, 0, 0, 5, -10, -20, -10, -10, -10, -10, -10, -10, -20],
    R: [0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0],
    Q: [-20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10, -5, 0, 5, 5, 5, 5, 0, -5,
      0, 0, 5, 5, 5, 5, 0, -5, -10, 5, 5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20],
    K: [-30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30,
      -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20, -20, -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10, 30, 20],
    KE: [-50, -40, -30, -20, -20, -30, -40, -50, -30, -20, -10, 0, 0, -10, -20, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30,
      -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -30, 0, 0, 0, 0, -30, -30, -50, -30, -30, -30, -30, -30, -30, -50],
  };
  const MATE = 100000;

  // Board index = rank * 8 + file, rank 0 = white's back rank. Positive = good for white.
  function chessEval(board) {
    let score = 0, nonPawn = 0;
    for (const p of board) if (p && p !== "P" && p !== "p" && p !== "K" && p !== "k") nonPawn += VAL[p.toUpperCase()];
    const endgame = nonPawn <= 1600;
    for (let s = 0; s < 64; s++) {
      const p = board[s];
      if (!p) continue;
      const t = p.toUpperCase(), white = p === t, r = s >> 3, f = s & 7;
      const table = t === "K" && endgame ? PST.KE : PST[t];
      const v = VAL[t] + table[white ? (7 - r) * 8 + f : r * 8 + f];
      score += white ? v : -v;
    }
    return score;
  }
  const sideSign = (turn) => (turn === "w" ? 1 : -1);
  function orderMoves(board, moves) {
    const key = (m) => (m.promotion ? 800 : 0) + (m.capture ? 10 * VAL[(board[m.to] || "P").toUpperCase()] - VAL[m.piece.toUpperCase()] / 10 + 1000 : 0);
    return moves.map((m) => [key(m), m]).sort((a, b) => b[0] - a[0]).map((x) => x[1]);
  }
  // Captures only, so a search never stops in the middle of an exchange.
  // Pseudo-legal captures are cheap; the ones that leave the king in check
  // are skipped as they come up.
  function chessQuiesce(st, alpha, beta, ctx, qd) {
    if ((++ctx.nodes & 255) === 0 && now() > ctx.deadline) ctx.abort = true;
    if (ctx.abort) return 0;
    const stand = chessEval(st.board) * sideSign(st.turn);
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
    if (qd <= 0) return alpha;
    const caps = orderMoves(st.board, E.chessPseudoMoves(st).filter((m) => m.capture || m.promotion));
    for (const m of caps) {
      const next = E.chessApplyMove(st, m);
      if (E.chessInCheck(next, st.turn)) continue;
      const sc = -chessQuiesce(next, -beta, -alpha, ctx, qd - 1);
      if (ctx.abort) return 0;
      if (sc >= beta) return beta;
      if (sc > alpha) alpha = sc;
    }
    return alpha;
  }
  function chessSearch(st, depth, alpha, beta, ply, ctx) {
    if ((++ctx.nodes & 255) === 0 && now() > ctx.deadline) ctx.abort = true;
    if (ctx.abort) return 0;
    if (depth <= 0) return chessQuiesce(st, alpha, beta, ctx, ctx.qdepth);
    const moves = E.chessLegalMoves(st);
    if (!moves.length) return E.chessInCheck(st, st.turn) ? -MATE + ply : 0;
    if (st.halfmove >= 100) return 0;
    for (const m of orderMoves(st.board, moves)) {
      const sc = -chessSearch(E.chessApplyMove(st, m), depth - 1, -beta, -alpha, ply + 1, ctx);
      if (ctx.abort) return 0;
      if (sc >= beta) return beta;
      if (sc > alpha) alpha = sc;
    }
    return alpha;
  }
  const CHESS_LEVELS = {
    easy:   { depth: 1, qdepth: 0, noise: 160, randomMove: 0.25, ms: 100 },
    medium: { depth: 2, qdepth: 3, noise: 25,  randomMove: 0,    ms: 200 },
    hard:   { depth: 4, qdepth: 4, noise: 0,   randomMove: 0,    ms: 450 },
  };
  function chessPickMove(state, level) {
    const L = CHESS_LEVELS[level] || CHESS_LEVELS.medium;
    const moves = E.chessLegalMoves(state);
    if (!moves.length) return null;
    if (L.randomMove && Math.random() < L.randomMove) return moves[rnd(moves.length)];
    const ctx = { nodes: 0, deadline: now() + L.ms, abort: false, qdepth: L.qdepth };
    // Shuffled first, so equally good moves vary from game to game (the sort keeps that order among equals).
    const shuffled = moves.slice();
    for (let i = shuffled.length - 1; i > 0; i--) { const j = rnd(i + 1); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
    let ordered = orderMoves(state.board, shuffled);
    let best = ordered[0];
    for (let d = 1; d <= L.depth; d++) {
      let alpha = -Infinity, bestHere = null, bestScore = -Infinity;
      const scored = [];
      for (const m of ordered) {
        // With noise the scores must be exact (full window); without, prune.
        let sc = -chessSearch(E.chessApplyMove(state, m), d - 1, -Infinity, L.noise ? Infinity : -alpha, 1, ctx);
        if (ctx.abort) break;
        if (L.noise) sc += (Math.random() * 2 - 1) * L.noise; // only exact (full-window) scores get noise
        scored.push([sc, m]);
        if (sc > bestScore) { bestScore = sc; bestHere = m; }
        if (sc > alpha) alpha = sc;
      }
      if (ctx.abort && !bestHere) break;
      if (bestHere) best = bestHere;
      if (ctx.abort) break;
      ordered = scored.sort((a, b) => b[0] - a[0]).map((x) => x[1]).concat(ordered.filter((m) => !scored.some((x) => x[1] === m)));
    }
    return best;
  }

  // ══ Checkers ════════════════════════════════════════════════════════════
  // Same search shape; a multi-jump keeps the same side moving, so those
  // steps aren't a turn change in the search either.
  function checkersEval(board) {
    let s = 0;
    for (let i = 0; i < 64; i++) {
      const p = board[i];
      if (!p) continue;
      const red = p.toLowerCase() === "r", king = p === "R" || p === "B";
      const r = i >> 3, f = i & 7;
      let v = king ? 175 : 100;
      if (!king) v += 4 * (red ? r : 7 - r);            // men want to move up
      if (!king && (red ? r === 0 : r === 7)) v += 8;   // back row guards
      if (f >= 2 && f <= 5 && r >= 2 && r <= 5) v += 4; // centre
      if (f === 0 || f === 7) v -= 3;                   // edges are weaker
      s += red ? v : -v;
    }
    return s;
  }
  const ckSign = (turn) => (turn === "r" ? 1 : -1);
  function checkersSearch(st, depth, alpha, beta, ply, ctx) {
    if ((++ctx.nodes & 255) === 0 && now() > ctx.deadline) ctx.abort = true;
    if (ctx.abort) return 0;
    const moves = E.checkersLegalMoves(st);
    if (!moves.length) return -MATE + ply;
    if (depth <= 0 && st.mustContinueFrom === null) return checkersEval(st.board) * ckSign(st.turn);
    for (const m of moves) {
      const next = E.checkersApplyMove(st, m);
      const same = next.turn === st.turn;
      const sc = same ? checkersSearch(next, depth, alpha, beta, ply + 1, ctx) : -checkersSearch(next, depth - 1, -beta, -alpha, ply + 1, ctx);
      if (ctx.abort) return 0;
      if (sc >= beta) return beta;
      if (sc > alpha) alpha = sc;
    }
    return alpha;
  }
  const CHECKERS_LEVELS = {
    easy:   { depth: 1, noise: 60, randomMove: 0.3, ms: 100 },
    medium: { depth: 4, noise: 10, randomMove: 0,   ms: 250 },
    hard:   { depth: 8, noise: 0,  randomMove: 0,   ms: 450 },
  };
  function checkersPickMove(state, level) {
    const L = CHECKERS_LEVELS[level] || CHECKERS_LEVELS.medium;
    const moves = E.checkersLegalMoves(state);
    if (!moves.length) return null;
    if (moves.length === 1) return moves[0];
    if (L.randomMove && Math.random() < L.randomMove) return moves[rnd(moves.length)];
    const ctx = { nodes: 0, deadline: now() + L.ms, abort: false };
    let best = moves[rnd(moves.length)];
    for (let d = 1; d <= L.depth; d++) {
      let bestScore = -Infinity, bestHere = null;
      for (const m of moves) {
        const next = E.checkersApplyMove(state, m);
        let sc = next.turn === state.turn ? checkersSearch(next, d - 1, -Infinity, Infinity, 1, ctx) : -checkersSearch(next, d - 1, -Infinity, Infinity, 1, ctx);
        if (ctx.abort) break;
        sc += L.noise ? (Math.random() * 2 - 1) * L.noise : Math.random();
        if (sc > bestScore) { bestScore = sc; bestHere = m; }
      }
      if (ctx.abort) break;
      if (bestHere) best = bestHere;
    }
    return best;
  }

  // ══ Joker ═══════════════════════════════════════════════════════════════
  // A card player's rules of thumb: bid what the hand can probably take, then
  // try to take exactly that many — win cheaply while you still need tricks,
  // throw your highest losing card once you don't.
  function jokerBid(room, seat) {
    const hand = room.hands[seat], trump = room.trumpSuit, n = room.handSize;
    const isLast = room.bidTurnIdx === 3;
    let prior = 0;
    for (let i = 0; i < room.bidTurnIdx; i++) prior += room.bids[room.bidOrder[i]];
    const trumps = hand.filter((c) => !E.jokerIsJokerCard(c) && trump && E.jokerSuitOf(c) === trump).length;
    let est = 0;
    for (const c of hand) {
      if (E.jokerIsJokerCard(c)) { est += 0.95; continue; }
      const v = E.jokerValueOf(c), isTrump = trump && E.jokerSuitOf(c) === trump;
      if (isTrump) est += v >= 14 ? 0.95 : v === 13 ? 0.8 : v === 12 ? 0.6 : v === 11 ? 0.45 : trumps >= 3 ? 0.35 : 0.15;
      else est += v >= 14 ? (n <= 4 ? 0.8 : 0.6) : v === 13 ? (n <= 4 ? 0.45 : 0.3) : 0;
    }
    let bid = Math.max(0, Math.min(n, Math.round(est)));
    if (!E.jokerIsBidLegal(bid, n, isLast, prior)) {
      const up = bid + 1, down = bid - 1;
      bid = est >= bid && E.jokerIsBidLegal(up, n, isLast, prior) ? up : E.jokerIsBidLegal(down, n, isLast, prior) ? down : up;
    }
    return bid;
  }
  function jokerWouldWin(room, seat, card, jokerChoice) {
    const trick = room.currentTrick.concat([{ seat, card, jokerChoice: jokerChoice || null }]);
    const led = room.currentTrick.length ? room.ledSuit : (E.jokerIsJokerCard(card) ? null : E.jokerSuitOf(card));
    return E.jokerResolveTrick(trick, room.trumpSuit, led).seat === seat;
  }
  function jokerPlay(room, seat) {
    const hand = room.hands[seat];
    const leading = room.currentTrick.length === 0;
    const legal = E.jokerLegalCardsToPlay(hand, leading ? null : room.ledSuit, room.trumpSuit);
    const need = room.bids[seat] - room.tricksWon[seat];
    const tricksLeft = hand.length;
    const trump = room.trumpSuit;
    const plain = legal.filter((c) => !E.jokerIsJokerCard(c));
    const joker = legal.find((c) => E.jokerIsJokerCard(c));
    const strength = (c) => E.jokerValueOf(c) + (trump && E.jokerSuitOf(c) === trump ? 20 : 0);
    const byStrength = plain.slice().sort((a, b) => strength(a) - strength(b)); // weakest first
    const declare = trump || "h";
    const play = (card, jokerChoice = null, declaredSuit = null) => ({ card, jokerChoice, declaredSuit });

    if (need > 0) {
      if (leading) {
        // Must win every remaining trick → lead the joker; otherwise lead the strongest card.
        if (joker && (need >= tricksLeft || !byStrength.length)) return play(joker, "high", declare);
        const top = byStrength[byStrength.length - 1];
        if (top && strength(top) >= 14) return play(top);
        if (joker && need > 0 && tricksLeft <= need + 1) return play(joker, "high", declare);
        return play(top || joker, top ? null : "high", top ? null : declare);
      }
      const last = room.currentTrick.length === 3;
      const winners = byStrength.filter((c) => jokerWouldWin(room, seat, c));
      if (winners.length) return play(last ? winners[0] : winners[winners.length - 1]);
      if (joker) return play(joker, "high");
      return play(byStrength[0]);
    }
    // Enough tricks already — try not to take another.
    if (leading) {
      if (byStrength.length) return play(byStrength[0]);
      return play(joker, "low", declare);
    }
    const losers = byStrength.filter((c) => !jokerWouldWin(room, seat, c));
    if (losers.length) return play(losers[losers.length - 1]);
    if (joker) return play(joker, "low");
    return play(byStrength[0]);
  }

  return { chessPickMove, checkersPickMove, jokerBid, jokerPlay, chessEval, CHESS_LEVELS };
};
