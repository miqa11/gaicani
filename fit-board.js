// ── Square game boards that fit any screen ──────────────────────────────────
// A board container marked data-fit-board keeps its board (its first child)
// the largest square that fits inside it, on every screen and rotation.
//
// CSS alone couldn't: "width: 100%; max-height: 100%; aspect-ratio: 1" keeps
// the full width and just cuts the height when the box is wider than it is
// tall (sideways phones, short laptop windows), so the board stopped being
// square and rows were cut off.
(function () {
  "use strict";

  function fit(wrap) {
    const board = wrap.firstElementChild;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (!board || !w || !h) return; // hidden screen — refits when it's shown
    const size = Math.floor(Math.min(w, h)) + "px";
    if (board.style.width !== size) { board.style.width = size; board.style.height = size; }
  }

  function init() {
    const wraps = document.querySelectorAll("[data-fit-board]");
    if (!wraps.length) return;
    const all = () => wraps.forEach(fit);
    if (window.ResizeObserver) {
      const ro = new ResizeObserver((entries) => entries.forEach((e) => fit(e.target)));
      wraps.forEach((w) => ro.observe(w));
    }
    window.addEventListener("resize", all);
    window.addEventListener("orientationchange", () => setTimeout(all, 250));
    all();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
