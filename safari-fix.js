// ── Safari / iPhone fixes shared by every page ──────────────────────────────
// Loaded in <head> right after the viewport tag. Safari — and every browser
// on an iPhone or iPad, since they all run on Safari's engine — handles a few
// things differently from Chrome:
//  • Tapping a text box with small text zooms the whole page in, and it
//    stays zoomed after you send → we ask it not to (pinch-zoom still works).
//  • A tap on plain space isn't a "click", so "tap outside to close" menus
//    and pickers stayed open → the page counts as tappable.
//  • Two quick taps (cards, board squares) zoomed the page in.
//  • Buttons never showed their pressed look.
//  • Opening the keyboard pushes the whole page up — on full-screen pages
//    (chats, games) that hid the header and left an empty gap under the
//    message box, and sometimes the page stayed pushed up after the
//    keyboard closed → those pages are put back in place.
//  • The Back button brings the previous page back from memory, frozen as it
//    was (old lobbies, coins, a dropped connection) → live pages reload,
//    the way they do in Chrome.
(function () {
  "use strict";
  var root = document.documentElement;

  // Back/forward: a live page (one with a socket.io connection) that comes
  // back from Safari's memory reloads instead of showing a stale copy.
  window.addEventListener("pageshow", function (e) {
    if (e.persisted && window.io) location.reload();
  });

  var ua = navigator.userAgent || "";
  var iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (!iOS) return;
  root.classList.add("is-ios");

  // No zoom when a text box gets focus. iOS still lets people pinch-zoom.
  var vp = document.querySelector('meta[name="viewport"]');
  if (vp && !/maximum-scale/.test(vp.content)) vp.setAttribute("content", vp.content + ", maximum-scale=1");

  // :active (the pressed look) only works on iOS when something listens for touches.
  document.addEventListener("touchstart", function () {}, { passive: true });

  var st = document.createElement("style");
  st.id = "safariFixCss";
  st.textContent =
    "html{-webkit-tap-highlight-color:transparent;touch-action:manipulation}" +
    "@media (hover:none){body{cursor:pointer}input,textarea,[contenteditable]{cursor:auto}}";
  (document.head || root).appendChild(st);

  // ── Keep full-screen pages in place around the keyboard ──
  var vv = window.visualViewport;
  // A page that is exactly one screen tall and doesn't scroll (not, say, the
  // dashboard with a popup open, which is scrolled on purpose).
  function fullScreenPage() {
    var b = document.body;
    if (!b) return false;
    var still = getComputedStyle(b).overflowY === "hidden" || getComputedStyle(root).overflowY === "hidden";
    return still && root.scrollHeight <= window.innerHeight + 2;
  }
  function typingIn() {
    var a = document.activeElement;
    return a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable) ? a : null;
  }
  function putBack() {
    if (!fullScreenPage() || (vv && vv.scale > 1.01)) return; // never fight someone's pinch-zoom
    var y = window.scrollY || window.pageYOffset || 0;
    if (y <= 0) return;
    var box = typingIn();
    if (box) {
      var pinned = pinnedParent(box);
      if (pinned) {
        // A box on a pinned layer (a popup, a panel) keeps Safari's own
        // scrolling — unless the page itself moves that layer above the
        // keyboard (the random chat's message bar).
        if (!pinned.hasAttribute("data-follows-keyboard")) return;
      } else {
        // Only when the box is still in sight without the push (the page
        // has already shrunk to the space above the keyboard).
        var r = box.getBoundingClientRect();
        if (r.bottom + y > (vv ? vv.height : window.innerHeight) + 1) return;
      }
    }
    window.scrollTo(0, 0);
  }
  function pinnedParent(el) {
    for (var n = el; n && n !== document.body; n = n.parentElement) {
      if (getComputedStyle(n).position === "fixed") return n;
    }
    return null;
  }
  var t = 0;
  function soon() { clearTimeout(t); t = setTimeout(putBack, 60); }
  if (vv) { vv.addEventListener("resize", soon); vv.addEventListener("scroll", soon); }
  window.addEventListener("scroll", soon, { passive: true });
  document.addEventListener("focusout", function () { setTimeout(function () { if (!typingIn()) putBack(); }, 150); });
})();
