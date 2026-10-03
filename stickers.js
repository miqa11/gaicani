// ── Georgian sticker pack ───────────────────────────────────────────────────
// Lives in the GIF panel of random chat and private chat as a second tab
// ("🥟 სტიკერები | GIF"); the panel remembers which tab you used last. The
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

  const CSS = `
.stk-tabs { display: flex; gap: 6px; flex-shrink: 0; }
.stk-tab { flex: 1; padding: 8px 10px; border-radius: 999px; cursor: pointer; font: inherit; font-size: .85em; font-weight: 800;
  border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.06); color: inherit; opacity: .75; }
.stk-tab[aria-selected="true"] { opacity: 1; background: rgba(214,168,79,.18); border-color: rgba(214,168,79,.55); color: #f4d98f; }
.stk-close { flex: 0 0 38px; height: 38px; border-radius: 50%; cursor: pointer; font: inherit; font-weight: 800;
  border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.06); color: inherit; }
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

  function savedTab() { try { return localStorage.getItem(TAB_KEY) || "stickers"; } catch (_) { return "stickers"; } }

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

    // Adds the "🥟 სტიკერები | GIF" tabs to a GIF panel.
    //   panel   — the panel element; tabs + sticker grid go at its top
    //   gifEls  — the panel's GIF parts (search box, results), hidden on the sticker tab
    //   onPick  — called with a sticker id
    //   onGifs  — called when the GIF tab is shown (load / focus the search)
    //   onClose — optional: adds a ✕ button to the tab row
    // Returns open(): call it whenever the panel opens; it shows the tab used
    // last and returns true when that's the GIF tab.
    attach(panel, { gifEls, onPick, onGifs, onClose }) {
      ensureCss();
      const tabs = document.createElement("div");
      tabs.className = "stk-tabs";
      tabs.setAttribute("role", "tablist");
      tabs.innerHTML =
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
      panel.insertBefore(tabs, panel.firstChild);

      let current = null;
      function show(tab, user) {
        current = tab;
        tabs.querySelectorAll(".stk-tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
        grid.hidden = tab !== "stickers";
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
        show(savedTab() === "gif" ? "gif" : "stickers", false);
        return current === "gif";
      };
    },
  };
})();
