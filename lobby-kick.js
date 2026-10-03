// ── Lobby kick button (game lobbies) ────────────────────────────────────────
// Until a game starts, its host can remove someone from the lobby. Each game
// page adds GaicaniLobbyKick.button(...) to the other players' rows when
// you're the host; the server checks it's really the host and that the game
// hasn't started (see kickFromLobby in server.js). A kicked player can only
// come back through a new invite from the host.
(function () {
  "use strict";

  const CSS = `
.lobby-kick-btn { margin-left:auto; flex-shrink:0; padding:5px 10px; border-radius:999px; cursor:pointer;
  border:1px solid rgba(227,59,95,.45); background:rgba(227,59,95,.12); color:#ff8aa1;
  font:inherit; font-size:.74em; font-weight:700; line-height:1.2; white-space:nowrap;
  transition:background .15s, border-color .15s; }
.lobby-kick-btn:hover { background:rgba(227,59,95,.24); border-color:rgba(227,59,95,.7); }
.lobby-kick-btn:focus-visible { outline:2px solid #f4d98f; outline-offset:2px; }
.lobby-kick-btn:disabled { opacity:.5; cursor:default; }
.pk-lobby-stack + .lobby-kick-btn { margin-left:0; }
`;
  function ensureCss() {
    if (document.getElementById("lobbyKickCss")) return;
    const st = document.createElement("style");
    st.id = "lobbyKickCss"; st.textContent = CSS;
    document.head.appendChild(st);
  }

  window.GaicaniLobbyKick = {
    ensureCss,
    // A "✕ გაგდება" button for one player's row; asks before kicking.
    button(username, onKick) {
      ensureCss();
      const b = document.createElement("button");
      b.type = "button";
      b.className = "lobby-kick-btn";
      b.textContent = "✕ გაგდება";
      b.title = "ლობიდან გაგდება";
      b.setAttribute("aria-label", username + " — ლობიდან გაგდება");
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!confirm(`გააგდო ${username} ლობიდან?\nხელახლა შემოსვლას მხოლოდ შენი ახალი მოწვევით შეძლებს.`)) return;
        b.disabled = true;
        onKick();
      });
      return b;
    },
  };
})();
