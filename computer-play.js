// ── 🤖 "Play the computer" card on a game's start screen ────────────────────
// Chess / checkers: three levels. Joker: one button that seats you with three
// computer players. The server starts the game at once and the page's usual
// room updates take it from there (see startComputerGame in server.js).
(function () {
  "use strict";

  const CSS = `
.cp-card { border-radius: 16px; padding: 12px; border: 1px solid rgba(214,168,79,.28);
  background: radial-gradient(120% 120% at 0% 0%, rgba(25,179,166,.20), transparent 55%), rgba(255,255,255,.04); }
.cp-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.cp-icon { width: 42px; height: 42px; border-radius: 12px; display: grid; place-items: center; flex-shrink: 0;
  background: rgba(25,179,166,.18); }
.cp-icon img { width: 34px; height: 34px; }
.cp-head b { display: block; font-size: .95em; }
.cp-head small { display: block; font-size: .76em; opacity: .75; line-height: 1.35; margin-top: 1px; }
.cp-levels { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.cp-levels.one { grid-template-columns: 1fr; }
.cp-level { border: 1px solid rgba(255,255,255,.14); border-radius: 12px; padding: 10px 4px; cursor: pointer; font: inherit;
  font-weight: 800; font-size: .84em; color: inherit; background: rgba(255,255,255,.06); line-height: 1.25; }
.cp-level small { display: block; font-weight: 600; font-size: .78em; opacity: .7; margin-top: 2px; }
.cp-level:hover { background: rgba(255,255,255,.12); }
.cp-level:disabled { opacity: .55; cursor: default; }
.cp-level.primary { background: linear-gradient(135deg,#19b3a6,#0f7f75); border-color: transparent; color: #fff; }
.cp-note { font-size: .7em; opacity: .6; margin-top: 8px; text-align: center; }
`;
  function ensureCss() {
    if (document.getElementById("computerPlayCss")) return;
    const st = document.createElement("style");
    st.id = "computerPlayCss"; st.textContent = CSS;
    document.head.appendChild(st);
  }

  window.GaicaniComputer = {
    // socket, game ("chess" | "checkers" | "joker"), before (element the card goes above).
    mount({ socket, game, before }) {
      if (!socket || !before || !before.parentNode || document.getElementById("cpCard")) return;
      ensureCss();
      const joker = game === "joker";
      const card = document.createElement("div");
      card.className = "cp-card"; card.id = "cpCard";
      card.innerHTML =
        '<div class="cp-head"><span class="cp-icon"><img src="/bot-avatar.svg" alt=""></span><div>' +
        '<b>კომპიუტერთან თამაში</b><small>' + (joker ? "არავინაა ონლაინ? სამ კომპიუტერთან ერთად ითამაშე ახლავე" : "არავინაა ონლაინ? ითამაშე ახლავე — აირჩიე სირთულე") + "</small></div></div>" +
        (joker
          ? '<div class="cp-levels one"><button type="button" class="cp-level primary" data-level="medium">🃏 დაწყება 3 კომპიუტერთან</button></div>'
          : '<div class="cp-levels">' +
            '<button type="button" class="cp-level" data-level="easy">😊 მარტივი<small>დამწყებისთვის</small></button>' +
            '<button type="button" class="cp-level primary" data-level="medium">🙂 საშუალო<small>კარგი ვარჯიში</small></button>' +
            '<button type="button" class="cp-level" data-level="hard">😈 რთული<small>გამოწვევა</small></button></div>') +
        '<div class="cp-note">კომპიუტერთან მოგება ტოპ-სიაში არ ითვლება</div>';
      before.parentNode.insertBefore(card, before);
      card.addEventListener("click", (e) => {
        const b = e.target.closest(".cp-level");
        if (!b) return;
        card.querySelectorAll(".cp-level").forEach((x) => { x.disabled = true; });
        setTimeout(() => card.querySelectorAll(".cp-level").forEach((x) => { x.disabled = false; }), 2500);
        socket.emit(`${game}:playComputer`, { level: b.dataset.level });
      });
    },
  };
})();
