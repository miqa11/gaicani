(function (root) {
  "use strict";
const CHESS_WHITE = "w", CHESS_BLACK = "b";

function chessSq(file, rank) { return rank * 8 + file; }
function chessFileOf(s) { return s % 8; }
function chessRankOf(s) { return Math.floor(s / 8); }
function chessInBounds(f, r) { return f >= 0 && f < 8 && r >= 0 && r < 8; }
function chessSquareName(s) { return "abcdefgh"[chessFileOf(s)] + (chessRankOf(s) + 1); }
function chessNameToSquare(name) { return chessSq("abcdefgh".indexOf(name[0]), Number(name[1]) - 1); }

function chessInitialBoard() {
  const b = new Array(64).fill(null);
  const back = ["R", "N", "B", "Q", "K", "B", "N", "R"];
  for (let f = 0; f < 8; f++) {
    b[chessSq(f, 0)] = back[f];
    b[chessSq(f, 1)] = "P";
    b[chessSq(f, 6)] = "p";
    b[chessSq(f, 7)] = back[f].toLowerCase();
  }
  return b;
}

function chessNewGameState() {
  return {
    board: chessInitialBoard(),
    turn: CHESS_WHITE,
    castling: { wK: true, wQ: true, bK: true, bQ: true },
    epSquare: null,
    halfmove: 0,
    fullmove: 1,
  };
}

function chessIsWhitePiece(p) { return !!p && p === p.toUpperCase(); }
function chessColorOf(p) { return chessIsWhitePiece(p) ? CHESS_WHITE : CHESS_BLACK; }
function chessSameColor(p1, p2) { return !!p1 && !!p2 && chessColorOf(p1) === chessColorOf(p2); }
function chessOpponent(side) { return side === CHESS_WHITE ? CHESS_BLACK : CHESS_WHITE; }

const CHESS_KNIGHT_DELTAS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const CHESS_KING_DELTAS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const CHESS_BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const CHESS_ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function chessIsSquareAttacked(board, square, bySide) {
  const f = chessFileOf(square), r = chessRankOf(square);
  const pawnDir = bySide === CHESS_WHITE ? -1 : 1;
  for (const df of [-1, 1]) {
    const pf = f + df, pr = r + pawnDir;
    if (chessInBounds(pf, pr)) {
      const p = board[chessSq(pf, pr)];
      if (p && chessColorOf(p) === bySide && p.toUpperCase() === "P") return true;
    }
  }
  for (const [df, dr] of CHESS_KNIGHT_DELTAS) {
    const nf = f + df, nr = r + dr;
    if (!chessInBounds(nf, nr)) continue;
    const p = board[chessSq(nf, nr)];
    if (p && chessColorOf(p) === bySide && p.toUpperCase() === "N") return true;
  }
  for (const [df, dr] of CHESS_KING_DELTAS) {
    const nf = f + df, nr = r + dr;
    if (!chessInBounds(nf, nr)) continue;
    const p = board[chessSq(nf, nr)];
    if (p && chessColorOf(p) === bySide && p.toUpperCase() === "K") return true;
  }
  for (const [df, dr] of CHESS_BISHOP_DIRS) {
    let nf = f + df, nr = r + dr;
    while (chessInBounds(nf, nr)) {
      const p = board[chessSq(nf, nr)];
      if (p) { if (chessColorOf(p) === bySide && (p.toUpperCase() === "B" || p.toUpperCase() === "Q")) return true; break; }
      nf += df; nr += dr;
    }
  }
  for (const [df, dr] of CHESS_ROOK_DIRS) {
    let nf = f + df, nr = r + dr;
    while (chessInBounds(nf, nr)) {
      const p = board[chessSq(nf, nr)];
      if (p) { if (chessColorOf(p) === bySide && (p.toUpperCase() === "R" || p.toUpperCase() === "Q")) return true; break; }
      nf += df; nr += dr;
    }
  }
  return false;
}

function chessFindKing(board, side) {
  const king = side === CHESS_WHITE ? "K" : "k";
  for (let s = 0; s < 64; s++) if (board[s] === king) return s;
  return -1;
}
function chessInCheck(state, side) {
  const kingSq = chessFindKing(state.board, side);
  if (kingSq === -1) return false;
  return chessIsSquareAttacked(state.board, kingSq, chessOpponent(side));
}

function chessPseudoMoves(state) {
  const moves = [];
  const { board, turn } = state;

  for (let s = 0; s < 64; s++) {
    const piece = board[s];
    if (!piece || chessColorOf(piece) !== turn) continue;
    const f = chessFileOf(s), r = chessRankOf(s);
    const type = piece.toUpperCase();

    if (type === "P") {
      const dir = turn === CHESS_WHITE ? 1 : -1;
      const startRank = turn === CHESS_WHITE ? 1 : 6;
      const promoRank = turn === CHESS_WHITE ? 7 : 0;

      const oneR = r + dir;
      if (chessInBounds(f, oneR) && !board[chessSq(f, oneR)]) {
        chessPushPawnMoves(moves, s, chessSq(f, oneR), piece, promoRank === oneR, false);
        if (r === startRank) {
          const twoR = r + 2 * dir;
          if (!board[chessSq(f, twoR)]) moves.push({ from: s, to: chessSq(f, twoR), piece, doublePush: true });
        }
      }
      for (const df of [-1, 1]) {
        const cf = f + df, cr = r + dir;
        if (!chessInBounds(cf, cr)) continue;
        const target = chessSq(cf, cr);
        const targetPiece = board[target];
        if (targetPiece && !chessSameColor(piece, targetPiece)) {
          chessPushPawnMoves(moves, s, target, piece, promoRank === cr, true);
        } else if (state.epSquare !== null && target === state.epSquare) {
          moves.push({ from: s, to: target, piece, enPassant: true, capture: true });
        }
      }
    } else if (type === "N" || type === "K") {
      const deltas = type === "N" ? CHESS_KNIGHT_DELTAS : CHESS_KING_DELTAS;
      for (const [df, dr] of deltas) {
        const nf = f + df, nr = r + dr;
        if (!chessInBounds(nf, nr)) continue;
        const t = chessSq(nf, nr);
        const tp = board[t];
        if (!tp || !chessSameColor(piece, tp)) moves.push({ from: s, to: t, piece, capture: !!tp });
      }
    } else {
      const dirs = type === "B" ? CHESS_BISHOP_DIRS : type === "R" ? CHESS_ROOK_DIRS : [...CHESS_BISHOP_DIRS, ...CHESS_ROOK_DIRS];
      for (const [df, dr] of dirs) {
        let nf = f + df, nr = r + dr;
        while (chessInBounds(nf, nr)) {
          const t = chessSq(nf, nr);
          const tp = board[t];
          if (!tp) { moves.push({ from: s, to: t, piece }); }
          else { if (!chessSameColor(piece, tp)) moves.push({ from: s, to: t, piece, capture: true }); break; }
          nf += df; nr += dr;
        }
      }
    }
  }

  chessAddCastlingMoves(state, moves);
  return moves;
}

function chessPushPawnMoves(moves, from, to, piece, isPromo, isCapture) {
  if (isPromo) {
    for (const promo of ["Q", "R", "B", "N"]) {
      moves.push({ from, to, piece, capture: isCapture, promotion: chessColorOf(piece) === CHESS_WHITE ? promo : promo.toLowerCase() });
    }
  } else {
    moves.push({ from, to, piece, capture: isCapture });
  }
}

function chessAddCastlingMoves(state, moves) {
  const { board, turn, castling } = state;
  const side = chessOpponent(turn);
  if (turn === CHESS_WHITE) {
    if (castling.wK && !board[chessSq(5, 0)] && !board[chessSq(6, 0)] && board[chessSq(7, 0)] === "R" && board[chessSq(4, 0)] === "K") {
      if (!chessIsSquareAttacked(board, chessSq(4, 0), side) && !chessIsSquareAttacked(board, chessSq(5, 0), side) && !chessIsSquareAttacked(board, chessSq(6, 0), side)) {
        moves.push({ from: chessSq(4, 0), to: chessSq(6, 0), piece: "K", castle: "K" });
      }
    }
    if (castling.wQ && !board[chessSq(1, 0)] && !board[chessSq(2, 0)] && !board[chessSq(3, 0)] && board[chessSq(0, 0)] === "R" && board[chessSq(4, 0)] === "K") {
      if (!chessIsSquareAttacked(board, chessSq(4, 0), side) && !chessIsSquareAttacked(board, chessSq(3, 0), side) && !chessIsSquareAttacked(board, chessSq(2, 0), side)) {
        moves.push({ from: chessSq(4, 0), to: chessSq(2, 0), piece: "K", castle: "Q" });
      }
    }
  } else {
    if (castling.bK && !board[chessSq(5, 7)] && !board[chessSq(6, 7)] && board[chessSq(7, 7)] === "r" && board[chessSq(4, 7)] === "k") {
      if (!chessIsSquareAttacked(board, chessSq(4, 7), side) && !chessIsSquareAttacked(board, chessSq(5, 7), side) && !chessIsSquareAttacked(board, chessSq(6, 7), side)) {
        moves.push({ from: chessSq(4, 7), to: chessSq(6, 7), piece: "k", castle: "K" });
      }
    }
    if (castling.bQ && !board[chessSq(1, 7)] && !board[chessSq(2, 7)] && !board[chessSq(3, 7)] && board[chessSq(0, 7)] === "r" && board[chessSq(4, 7)] === "k") {
      if (!chessIsSquareAttacked(board, chessSq(4, 7), side) && !chessIsSquareAttacked(board, chessSq(3, 7), side) && !chessIsSquareAttacked(board, chessSq(2, 7), side)) {
        moves.push({ from: chessSq(4, 7), to: chessSq(2, 7), piece: "k", castle: "Q" });
      }
    }
  }
}

function chessCloneState(state) {
  return {
    board: state.board.slice(),
    turn: state.turn,
    castling: { ...state.castling },
    epSquare: state.epSquare,
    halfmove: state.halfmove,
    fullmove: state.fullmove,
  };
}

function chessApplyMove(state, move) {
  const s = chessCloneState(state);
  const { board } = s;
  const piece = move.piece;
  const mover = chessColorOf(piece);

  s.epSquare = null;

  if (move.enPassant) {
    board[move.to] = piece;
    board[move.from] = null;
    const capturedPawnSq = chessSq(chessFileOf(move.to), chessRankOf(move.from));
    board[capturedPawnSq] = null;
  } else if (move.castle) {
    board[move.to] = piece;
    board[move.from] = null;
    if (move.castle === "K") {
      const rookFrom = mover === CHESS_WHITE ? chessSq(7, 0) : chessSq(7, 7);
      const rookTo = mover === CHESS_WHITE ? chessSq(5, 0) : chessSq(5, 7);
      board[rookTo] = board[rookFrom];
      board[rookFrom] = null;
    } else {
      const rookFrom = mover === CHESS_WHITE ? chessSq(0, 0) : chessSq(0, 7);
      const rookTo = mover === CHESS_WHITE ? chessSq(3, 0) : chessSq(3, 7);
      board[rookTo] = board[rookFrom];
      board[rookFrom] = null;
    }
  } else {
    board[move.to] = move.promotion || piece;
    board[move.from] = null;
  }

  if (move.doublePush) {
    const dir = mover === CHESS_WHITE ? 1 : -1;
    s.epSquare = chessSq(chessFileOf(move.from), chessRankOf(move.from) + dir);
  }

  if (piece === "K") { s.castling.wK = false; s.castling.wQ = false; }
  if (piece === "k") { s.castling.bK = false; s.castling.bQ = false; }
  if (move.from === chessSq(0, 0) || move.to === chessSq(0, 0)) s.castling.wQ = false;
  if (move.from === chessSq(7, 0) || move.to === chessSq(7, 0)) s.castling.wK = false;
  if (move.from === chessSq(0, 7) || move.to === chessSq(0, 7)) s.castling.bQ = false;
  if (move.from === chessSq(7, 7) || move.to === chessSq(7, 7)) s.castling.bK = false;

  s.halfmove = (move.capture || piece.toUpperCase() === "P") ? 0 : s.halfmove + 1;
  if (mover === CHESS_BLACK) s.fullmove += 1;
  s.turn = chessOpponent(mover);

  return s;
}

function chessLegalMoves(state) {
  const mover = state.turn;
  const out = [];
  for (const m of chessPseudoMoves(state)) {
    const next = chessApplyMove(state, m);
    if (!chessInCheck(next, mover)) out.push(m);
  }
  return out;
}

function chessIsInsufficientMaterial(board) {
  const pieces = board.filter(Boolean);
  if (pieces.every(p => p.toUpperCase() === "K")) return true;
  if (pieces.length === 3) {
    const nonKings = pieces.filter(p => p.toUpperCase() !== "K");
    if (nonKings.length === 1 && (nonKings[0].toUpperCase() === "N" || nonKings[0].toUpperCase() === "B")) return true;
  }
  return false;
}

function chessGameStatus(state) {
  const moves = chessLegalMoves(state);
  const check = chessInCheck(state, state.turn);
  if (moves.length === 0) {
    if (check) return { status: "checkmate", winner: chessOpponent(state.turn) };
    return { status: "stalemate" };
  }
  if (state.halfmove >= 100) return { status: "draw", reason: "fifty-move" };
  if (chessIsInsufficientMaterial(state.board)) return { status: "draw", reason: "insufficient-material" };
  return { status: check ? "check" : "playing" };
}

// ══════════════════════════════════════════════════════════════════════════
// Checkers (American draughts) — invite-based 1v1 games, same shape as
// Chess/Poker. Move generation with mandatory captures, multi-jump chains,
// and king promotion was built and validated standalone (30 targeted tests
// covering mandatory capture, multi-jump continuation, the mid-chain
// promotion-stops-the-turn rule, and forward-only men vs all-direction
// kings) plus 500 fully randomized games checked for exact piece
// conservation on every single move — before being ported in unchanged.
// ══════════════════════════════════════════════════════════════════════════


const CHECKERS_RED = "r", CHECKERS_BLACK = "b";

function checkersSq(file, rank) { return rank * 8 + file; }
function checkersFileOf(s) { return s % 8; }
function checkersRankOf(s) { return Math.floor(s / 8); }
function checkersInBounds(f, r) { return f >= 0 && f < 8 && r >= 0 && r < 8; }
function checkersIsDark(s) { return (checkersFileOf(s) + checkersRankOf(s)) % 2 === 0; }

function checkersInitialBoard() {
  const b = new Array(64).fill(null);
  for (let s = 0; s < 64; s++) {
    if (!checkersIsDark(s)) continue;
    const r = checkersRankOf(s);
    if (r <= 2) b[s] = "r";
    else if (r >= 5) b[s] = "b";
  }
  return b;
}

function checkersNewGameState() {
  return { board: checkersInitialBoard(), turn: CHECKERS_RED, mustContinueFrom: null };
}

function checkersPieceColor(p) { return p ? p.toLowerCase() : null; }
function checkersIsKing(p) { return p === "R" || p === "B"; }
function checkersOpponent(side) { return side === CHECKERS_RED ? CHECKERS_BLACK : CHECKERS_RED; }
function checkersKingOf(side) { return side === CHECKERS_RED ? "R" : "B"; }

const CHECKERS_DIRS_ALL = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
function checkersForwardDirsFor(piece) {
  if (checkersIsKing(piece)) return CHECKERS_DIRS_ALL;
  return checkersPieceColor(piece) === CHECKERS_RED ? [[1, 1], [-1, 1]] : [[1, -1], [-1, -1]];
}

// Kings fly — any number of empty squares along a diagonal, same as
// international/Russian draughts (not the American "one square only" rule).
// Regular men can still only MOVE one square forward (see
// checkersSimpleMovesFrom), but can CAPTURE one square in any of the 4
// diagonal directions, including backward — also standard international
// draughts rules, not the American restriction to forward-only captures.
function checkersCaptureMovesFrom(board, from) {
  const piece = board[from];
  if (!piece) return [];
  const f = checkersFileOf(from), r = checkersRankOf(from);
  const moves = [];

  if (checkersIsKing(piece)) {
    for (const [df, dr] of CHECKERS_DIRS_ALL) {
      // Walk outward over empty squares looking for the first piece in
      // this direction.
      let nf = f + df, nr = r + dr;
      while (checkersInBounds(nf, nr) && !board[checkersSq(nf, nr)]) { nf += df; nr += dr; }
      if (!checkersInBounds(nf, nr)) continue; // ran off the board — nothing to capture this way
      const midSq = checkersSq(nf, nr);
      const midPiece = board[midSq];
      if (checkersPieceColor(midPiece) === checkersPieceColor(piece)) continue; // blocked by your own piece
      // Found one enemy piece — every empty square immediately past it
      // (until the next piece or the edge) is a legal landing square.
      let lf = nf + df, lr = nr + dr;
      while (checkersInBounds(lf, lr) && !board[checkersSq(lf, lr)]) {
        moves.push({ from, to: checkersSq(lf, lr), capture: midSq, piece });
        lf += df; lr += dr;
      }
    }
    return moves;
  }

  // Regular men still only MOVE forward (see checkersSimpleMovesFrom below),
  // but — standard international/Russian draughts rule — they CAN capture
  // in any of the 4 diagonal directions, including backward. Only their
  // non-capturing moves stay forward-restricted.
  for (const [df, dr] of CHECKERS_DIRS_ALL) {
    const midF = f + df, midR = r + dr;
    const landF = f + 2 * df, landR = r + 2 * dr;
    if (!checkersInBounds(landF, landR)) continue;
    const midSq = checkersSq(midF, midR), landSq = checkersSq(landF, landR);
    const midPiece = board[midSq];
    if (midPiece && checkersPieceColor(midPiece) !== checkersPieceColor(piece) && !board[landSq]) {
      moves.push({ from, to: landSq, capture: midSq, piece });
    }
  }
  return moves;
}

function checkersSimpleMovesFrom(board, from) {
  const piece = board[from];
  if (!piece) return [];
  const f = checkersFileOf(from), r = checkersRankOf(from);
  const moves = [];

  if (checkersIsKing(piece)) {
    for (const [df, dr] of CHECKERS_DIRS_ALL) {
      let nf = f + df, nr = r + dr;
      while (checkersInBounds(nf, nr)) {
        const t = checkersSq(nf, nr);
        if (board[t]) break; // blocked — can't land on or pass through an occupied square
        moves.push({ from, to: t, capture: null, piece });
        nf += df; nr += dr;
      }
    }
    return moves;
  }

  for (const [df, dr] of checkersForwardDirsFor(piece)) {
    const nf = f + df, nr = r + dr;
    if (!checkersInBounds(nf, nr)) continue;
    const t = checkersSq(nf, nr);
    if (!board[t]) moves.push({ from, to: t, capture: null, piece });
  }
  return moves;
}

function checkersLegalMoves(state) {
  const { board, turn, mustContinueFrom } = state;
  if (mustContinueFrom !== null) return checkersCaptureMovesFrom(board, mustContinueFrom);

  const captures = [];
  const simples = [];
  for (let s = 0; s < 64; s++) {
    const p = board[s];
    if (!p || checkersPieceColor(p) !== turn) continue;
    captures.push(...checkersCaptureMovesFrom(board, s));
    simples.push(...checkersSimpleMovesFrom(board, s));
  }
  return captures.length > 0 ? captures : simples;
}

function checkersCloneState(state) {
  return { board: state.board.slice(), turn: state.turn, mustContinueFrom: state.mustContinueFrom };
}

function checkersApplyMove(state, move) {
  const s = checkersCloneState(state);
  const { board } = s;
  let piece = move.piece;

  board[move.to] = piece;
  board[move.from] = null;
  if (move.capture !== null) board[move.capture] = null;

  const landRank = checkersRankOf(move.to);
  let promoted = false;
  if (!checkersIsKing(piece)) {
    if ((checkersPieceColor(piece) === CHECKERS_RED && landRank === 7) || (checkersPieceColor(piece) === CHECKERS_BLACK && landRank === 0)) {
      piece = checkersKingOf(checkersPieceColor(piece));
      board[move.to] = piece;
      promoted = true;
    }
  }

  if (move.capture !== null && !promoted) {
    const further = checkersCaptureMovesFrom(board, move.to);
    if (further.length > 0) {
      s.mustContinueFrom = move.to;
      return s;
    }
  }

  s.mustContinueFrom = null;
  s.turn = checkersOpponent(state.turn);
  return s;
}

function checkersCountPieces(board, side) {
  let n = 0;
  for (const p of board) if (p && checkersPieceColor(p) === side) n++;
  return n;
}

function checkersGameStatus(state) {
  const moves = checkersLegalMoves(state);
  if (moves.length === 0) {
    return {
      status: "over",
      winner: checkersOpponent(state.turn),
      reason: checkersCountPieces(state.board, state.turn) === 0 ? "no-pieces" : "no-moves",
    };
  }
  return { status: "playing" };
}

// Groups a flat move list into per-piece "segments" — a new segment starts
// whenever the next move's "from" doesn't continue the previous move's
// "to" (i.e. a different piece is now moving, only possible when a forced
// sequence cascades across a turn boundary). The client animates each
// segment as one continuous piece journey with its own trail.
function checkersBuildLastMove(movesPlayed) {
  const segments = [];
  let current = null;
  for (const m of movesPlayed) {
    if (current && current.path[current.path.length - 1] === m.from) {
      current.path.push(m.to);
      if (m.capture !== null) current.captures.push(m.capture);
    } else {
      current = { path: [m.from, m.to], captures: m.capture !== null ? [m.capture] : [] };
      segments.push(current);
    }
  }
  return {
    from: movesPlayed[0].from,
    to: movesPlayed[movesPlayed.length - 1].to,
    segments,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// Georgian Joker ("ჯოკერი") — 4-player, 24-hand trick-taking engine.
// 36-card deck (9 ranks × 4 suits minus the two black 6s, plus 2 Jokers),
// bidding with the dealer's "sum ≠ tricks available" restriction, mandatory
// suit-following with Jokers always exempt, HIGH/LOW Joker trick resolution,
// and the full scoring/khishti/set-bonus system. Validated standalone with
// 66 targeted tests (every Joker HIGH/LOW edge case, dealer bid restriction,
// all scoring branches) plus 60 fully simulated 24-hand games with random
// legal bidding/play checked for correct trick counts and bid legality on
// every single hand — before being ported in unchanged.
// ══════════════════════════════════════════════════════════════════════════


  root.GaicaniLocalRules = {
    chess: {
      newGameState: chessNewGameState,
      legalMoves: chessLegalMoves,
      applyMove: chessApplyMove,
      inCheck: chessInCheck,
      gameStatus: chessGameStatus,
      squareName: chessSquareName,
      nameToSquare: chessNameToSquare
    },
    checkers: {
      newGameState: checkersNewGameState,
      legalMoves: checkersLegalMoves,
      applyMove: checkersApplyMove,
      gameStatus: checkersGameStatus,
      buildLastMove: checkersBuildLastMove
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
