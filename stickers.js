// ── 😊 Emoji, Georgian stickers and GIFs ────────────────────────────────────
// The 😊 button in random chat and private chat opens one panel with three
// tabs — "😊 ემოჯი | 🥟 სტიკერები | GIF"; it remembers the tab used last.
// Emoji go into your message (not sent on their own). Sticker pictures are
// pictures are /stickers/<id>.svg; the server only relays ids it knows
// (STICKER_IDS in server.js — keep both lists the same).
(function () {
  "use strict";

  const LIST = [
    { id: "gamarjoba",   label: "გამარჯობა!" },
    { id: "gaicani",     label: "გაიცანი" },
    { id: "love",        label: "მიყვარხარ" },
    { id: "haha",        label: "ჰაჰაჰა" },
    { id: "kai",         label: "კაი!" },
    { id: "sad",         label: "ნუუუ..." },
    { id: "dzili",       label: "ძილი ნებისა" },
    { id: "gaumarjos",   label: "გაუმარჯოს!" },
    { id: "alaverdi",    label: "ალავერდი!" },
    { id: "supra",       label: "სუფრა" },
    { id: "khachapuri",  label: "ხაჭაპური" },
    { id: "khinkali",    label: "ხინკალი" },
    { id: "churchkhela", label: "ჩურჩხელა" },
    { id: "vaime",       label: "ვაიმე!" },
    { id: "genatsvale",  label: "გენაცვალე" },
    { id: "dzmao",       label: "ძმაო!" },
    { id: "sakartvelo",  label: "საქართველო" },
  ];
  const BY_ID = Object.fromEntries(LIST.map((s) => [s.id, s]));
  const TAB_KEY = "gaicani_media_tab";
  const RECENT_KEY = "gaicani_recent_emoji";
  // One emoji per item (flags and ❤️-style emoji are several code points).
  const split = (str) => (typeof Intl !== "undefined" && Intl.Segmenter)
    ? [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(str)].map((x) => x.segment)
    : (str.match(/\p{Regional_Indicator}{2}|\p{Extended_Pictographic}\uFE0F?/gu) || []);
  const EMOJI = [
    ["სმაილები", split("😀😃😄😁😆😅😂🤣😊😇🙂😉😍🥰😘😋😛😜🤪😎🤩🥳😏😒😞😔😕🙁😣😩🥺😢😭😤😠😡🤬🤯😳🥵🥶😱😨😰🤗🤔🤭🤫😶😐😑😬🙄😮😲🥱😴🤤😵🥴🤢🤮🤧😷🤒🤑🤠😈👻💀👽🤖💩")],
    ["ჟესტები და გულები", split("👍👎👌✌️🤞🤟🤘🤙👈👉👆👇✋👋👏🙌🤲🤝🙏💪❤️🧡💛💚💙💜🖤🤍🤎💔❣️💕💞💓💗💖💘💝💋🔥✨⭐🌟💯💥💫")],
    ["სუფრა, თამაში, ბუნება", split("🍷🥂🍾🍻🍺☕🍕🍔🍟🥟🧀🍇🍉🍓🍑🍒🍫🍰🎂🍦🍿⚽🏀🎮🎲🎵🎶🎉🎁🏆🥇🌹🌸🌺🌻🌈☀️🌙⛄🐶🐱🐻🐼🦊🐸🐵🦄🐝🦋🇬🇪")],
  ];
  function recentEmoji() { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]").slice(0, 16); } catch (_) { return []; } }
  function rememberEmoji(e) { try { localStorage.setItem(RECENT_KEY, JSON.stringify([e, ...recentEmoji().filter((x) => x !== e)].slice(0, 16))); } catch (_) {} }
  // Puts text where the cursor is, then tells the box it changed (resize, counters, send button…).
  // The box usually isn't focused while you tap emoji (that would pop the
  // keyboard up over the panel), so its cursor is remembered when it loses
  // focus and moved along after each emoji.
  function trackCaret(el) {
    if (!el || el._gcCaretTracked) return;
    el._gcCaretTracked = true;
    el.addEventListener("blur", () => { el._gcCaret = el.selectionEnd; });
    el.addEventListener("input", (e) => { if (e.isTrusted) el._gcCaret = null; });
  }
  function insertAtCursor(el, text) {
    if (!el || el.disabled || el.readOnly) return false;
    let start, end;
    if (document.activeElement === el) { start = el.selectionStart; end = el.selectionEnd; }
    else start = end = Math.min(el._gcCaret != null ? el._gcCaret : el.value.length, el.value.length);
    if (el.maxLength > 0 && el.value.length - (end - start) + text.length > el.maxLength) return false;
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    const pos = start + text.length;
    el._gcCaret = pos;
    try { el.setSelectionRange(pos, pos); } catch (_) {}
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  const CSS = `
.stk-tabs { display: flex; gap: 6px; flex-shrink: 0; }
.stk-tab { flex: 1 1 0; min-width: 0; padding: 8px 6px; border-radius: 999px; cursor: pointer; font: inherit; font-size: .8em; font-weight: 800;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.06); color: inherit; opacity: .75; }
.stk-tab[aria-selected="true"] { opacity: 1; background: rgba(214,168,79,.18); border-color: rgba(214,168,79,.55); color: #f4d98f; }
.stk-close { flex: 0 0 38px; height: 38px; border-radius: 50%; cursor: pointer; font: inherit; font-weight: 800;
  border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.06); color: inherit; }
.emo-panel { overflow-y: auto; min-height: 0; padding: 2px 2px 6px; overscroll-behavior: contain; }
.emo-panel[hidden] { display: none; }
.emo-head { font-size: .7em; font-weight: 800; opacity: .65; margin: 8px 4px 4px; }
.emo-row { display: grid; grid-template-columns: repeat(auto-fill, minmax(42px, 1fr)); gap: 2px; }
.emo { height: 42px; border: none; background: none; border-radius: 10px; cursor: pointer; font-size: 26px; line-height: 1; padding: 0;
  font-family: "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif; touch-action: manipulation; }
.emo:hover, .emo:focus-visible { background: rgba(255,255,255,.1); }
.emo:active { transform: scale(.88); }
.stk-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(76px, 1fr)); gap: 6px; overflow-y: auto; min-height: 0; padding: 2px; }
.stk-grid[hidden] { display: none; }
.stk-item { aspect-ratio: 1; border: none; border-radius: 14px; background: rgba(255,255,255,.04); padding: 4px; cursor: pointer; }
.stk-item:hover, .stk-item:focus-visible { background: rgba(255,255,255,.12); }
.stk-item:active { transform: scale(.93); }
.stk-item img { width: 100%; height: 100%; display: block; pointer-events: none; }
.sticker-msg-img { width: 128px; height: 128px; display: block; }
@media (max-width: 360px) { .sticker-msg-img { width: 112px; height: 112px; } }
`;
  function ensureCss() {
    if (document.getElementById("stickersCss")) return;
    const st = document.createElement("style");
    st.id = "stickersCss"; st.textContent = CSS;
    document.head.appendChild(st);
  }

  function savedTab() { try { return localStorage.getItem(TAB_KEY) || "emoji"; } catch (_) { return "emoji"; } }

  window.GaicaniStickers = {
    list: LIST,
    get: (id) => BY_ID[id] || null,
    url: (id) => (BY_ID[id] ? `/stickers/${id}.svg` : ""),

    // An <img> for a sticker message.
    img(id) {
      const s = BY_ID[id];
      if (!s) return null;
      ensureCss();
      const img = document.createElement("img");
      img.src = `/stickers/${id}.svg`;
      img.alt = s.label;
      img.title = s.label;
      img.className = "sticker-msg-img";
      img.decoding = "async";
      return img;
    },

    // Adds the "😊 ემოჯი | 🥟 სტიკერები | GIF" tabs to a GIF panel.
    //   panel   — the panel element; tabs, emoji and sticker grids go at its top
    //   gifEls  — the panel's GIF parts (search box, results), hidden on the other tabs
    //   input   — the message box emoji are typed into
    //   onPick  — called with a sticker id
    //   onGifs  — called when the GIF tab is shown (load / focus the search)
    //   onClose — optional: adds a ✕ button to the tab row
    // Returns open(): call it whenever the panel opens; it shows the tab used
    // last and returns true when that's the GIF tab.
    attach(panel, { gifEls, input, onPick, onGifs, onClose }) {
      ensureCss();
      const tabs = document.createElement("div");
      tabs.className = "stk-tabs";
      tabs.setAttribute("role", "tablist");
      tabs.innerHTML =
        (input ? '<button type="button" class="stk-tab" role="tab" data-tab="emoji">😊 ემოჯი</button>' : "") +
        '<button type="button" class="stk-tab" role="tab" data-tab="stickers">🥟 სტიკერები</button>' +
        '<button type="button" class="stk-tab" role="tab" data-tab="gif">GIF</button>' +
        (onClose ? '<button type="button" class="stk-close" aria-label="დახურვა">✕</button>' : "");
      const grid = document.createElement("div");
      grid.className = "stk-grid";
      grid.setAttribute("role", "tabpanel");
      grid.innerHTML = LIST.map((s) =>
        `<button type="button" class="stk-item" data-sticker="${s.id}" title="${s.label}" aria-label="${s.label}">` +
        `<img src="/stickers/${s.id}.svg" alt="" loading="lazy" decoding="async"></button>`).join("");
      panel.insertBefore(grid, panel.firstChild);
      const emo = document.createElement("div");
      emo.className = "emo-panel";
      emo.setAttribute("role", "tabpanel");
      const paintEmoji = () => {
        const recent = recentEmoji();
        const sections = (recent.length ? [["ბოლოს გამოყენებული", recent]] : []).concat(EMOJI);
        emo.innerHTML = sections.map(([name, list]) =>
          `<div class="emo-head">${name}</div><div class="emo-row">` +
          list.map((e) => `<button type="button" class="emo" aria-label="${e}">${e}</button>`).join("") + "</div>").join("");
      };
      if (input) { panel.insertBefore(emo, panel.firstChild); trackCaret(input); }
      panel.insertBefore(tabs, panel.firstChild);
      emo.addEventListener("click", (e) => {
        e.stopPropagation();
        const b = e.target.closest(".emo");
        if (!b) return;
        if (insertAtCursor(input, b.textContent)) rememberEmoji(b.textContent);
      });

      let current = null;
      function show(tab, user) {
        current = tab;
        tabs.querySelectorAll(".stk-tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
        grid.hidden = tab !== "stickers";
        emo.hidden = tab !== "emoji";
        panel.classList.toggle("stk-on-gif", tab === "gif"); // pages can size the panel per tab
        if (tab === "emoji") paintEmoji(); // recent ones first
        (gifEls || []).forEach((el) => { if (el) el.style.display = tab === "gif" ? "" : "none"; });
        if (user) { try { localStorage.setItem(TAB_KEY, tab); } catch (_) {} }
        if (tab === "gif" && user && onGifs) onGifs();
      }
      tabs.addEventListener("click", (e) => {
        e.stopPropagation();
        if (e.target.closest(".stk-close")) { onClose(); return; }
        const b = e.target.closest(".stk-tab");
        if (b && b.dataset.tab !== current) show(b.dataset.tab, true);
      });
      grid.addEventListener("click", (e) => {
        e.stopPropagation();
        const b = e.target.closest(".stk-item");
        if (b) onPick(b.dataset.sticker);
      });
      return function open() {
        const t = savedTab();
        show(t === "gif" || t === "stickers" ? t : input ? "emoji" : "stickers", false);
        return current === "gif";
      };
    },
  };
})();
