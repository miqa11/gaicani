// ── 🔁 Play again with the same people ──────────────────────────────────────
// Each game page mounts this on its end screen. Pressing it votes for a
// rematch; when everyone still at the table has voted, the server starts a
// new game in the same room (see requestRematch in server.js) and the page's
// usual room updates take over from there.
(function () {
  "use strict";

  const CSS = `
.rm-box { display: flex; flex-direction: column; align-items: stretch; gap: 6px; width: 100%; margin-bottom: 8px; }
.rm-btn { width: 100%; padding: 12px 16px; border: none; border-radius: 14px; cursor: pointer; font: inherit; font-weight: 800;
  font-size: .98em; color: #fff; background: linear-gradient(135deg,#1fc18a,#0f8f66); box-shadow: 0 10px 22px -12px rgba(31,193,138,.9); }
.rm-btn.invited { animation: rm-pulse 1.2s ease-in-out infinite; }
.rm-btn:disabled { opacity: .6; cursor: default; animation: none; }
.rm-status { font-size: .8em; line-height: 1.4; opacity: .85; text-align: center; min-height: 1.1em; }
@keyframes rm-pulse { 50% { box-shadow: 0 0 0 6px rgba(31,193,138,.25), 0 10px 22px -12px rgba(31,193,138,.9); } }
@media (prefers-reduced-motion: reduce) { .rm-btn.invited { animation: none; } }
`;
  function ensureCss() {
    if (document.getElementById("rematchCss")) return;
    const st = document.createElement("style");
    st.id = "rematchCss"; st.textContent = CSS;
    document.head.appendChild(st);
  }
  const list = (names) => names.join(", ");

  window.GaicaniRematch = {
    // socket, game ("chess" …), before (the end screen element the button goes
    // above), roomId() → the current room, me() → your username.
    mount({ socket, game, before, roomId, me }) {
      if (!before || !before.parentNode || !socket) return { reset() {} };
      ensureCss();
      const box = document.createElement("div");
      box.className = "rm-box";
      box.innerHTML = '<button type="button" class="rm-btn">🔁 ხელახლა თამაში</button><div class="rm-status" aria-live="polite"></div>';
      before.parentNode.insertBefore(box, before);
      const btn = box.querySelector(".rm-btn"), status = box.querySelector(".rm-status");

      function reset() {
        btn.disabled = false;
        btn.classList.remove("invited");
        btn.textContent = "🔁 ხელახლა თამაში";
        status.textContent = "იგივე ხალხთან, ახალი პარტია";
      }
      reset();

      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = roomId();
        if (!id) return;
        btn.disabled = true;
        btn.textContent = "⏳ ველოდებით სხვებს…";
        socket.emit(`${game}:rematch`, { roomId: id });
      });

      socket.on(`${game}:rematchState`, (st) => {
        if (!st || st.roomId !== roomId()) return;
        if (st.started) { reset(); return; }
        const mine = (me() || "").toLowerCase();
        const iVoted = (st.votes || []).some((n) => n.toLowerCase() === mine);
        const others = (st.votes || []).filter((n) => n.toLowerCase() !== mine);
        if (!st.possible) {
          btn.disabled = true;
          btn.classList.remove("invited");
          btn.textContent = "🔁 ხელახლა თამაში";
          status.textContent = "ზოგი მოთამაშე წავიდა — ხელახლა ვეღარ ითამაშებთ";
          return;
        }
        if (iVoted) {
          btn.disabled = true;
          btn.classList.remove("invited");
          btn.textContent = "⏳ ველოდებით სხვებს…";
          status.textContent = st.waiting && st.waiting.length ? "ელოდება: " + list(st.waiting) : "";
        } else {
          btn.disabled = false;
          btn.classList.toggle("invited", others.length > 0);
          btn.textContent = others.length ? "🔁 თანხმობა — ვითამაშოთ!" : "🔁 ხელახლა თამაში";
          status.textContent = others.length ? list(others) + " ხელახლა თამაშს გთავაზობს" : "";
        }
      });
      return { reset };
    },
  };
})();
