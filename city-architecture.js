/* Canvas architecture for Tbilisi 1999. All ornament is drawn inside the existing world footprints. */
(function (root, factory) {
  const architecture = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = architecture;
  if (root) root.GaicaniCityArchitecture = architecture;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const ink = "#10121f", cream = "#ffe4b1", cyan = "#6ae7f2", pink = "#ff69ce";
  const oldPalettes = [
    { wall: "#674e58", shade: "#453344", trim: "#c99380", wood: "#619c9b", timber: "#315a66", roof: "#aa665d" },
    { wall: "#525b68", shade: "#333e53", trim: "#afa0a3", wood: "#b5896d", timber: "#684957", roof: "#8b575d" },
    { wall: "#7b5b52", shade: "#4b3c45", trim: "#d2aa83", wood: "#999f88", timber: "#535f62", roof: "#a66b5c" },
    { wall: "#655367", shade: "#413448", trim: "#bb98a3", wood: "#6da7ab", timber: "#3e626f", roof: "#98606b" }
  ];

  function noise(a, b) {
    let n = Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  }
  function box(g, color, x, y, w, h) {
    g.fillStyle = color;
    g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  }
  function text(g, value, x, y, size, color, maxWidth) {
    g.font = '700 ' + size + 'px "Noto Sans Georgian", monospace';
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = color;
    g.fillText(value, Math.round(x), Math.round(y), maxWidth || 1000);
  }
  function line(g, color, x1, y1, x2, y2, width) {
    g.strokeStyle = color; g.lineWidth = width || 1;
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
  }
  function arch(g, color, x, y, w, h) {
    const r = Math.min(w / 2, h / 2);
    g.fillStyle = color; g.beginPath();
    g.moveTo(x, y + h); g.lineTo(x, y + r);
    g.quadraticCurveTo(x, y, x + w / 2, y);
    g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h); g.closePath(); g.fill();
  }
  function glowBox(g, color, x, y, w, h, blur) {
    g.save(); g.shadowColor = color; g.shadowBlur = blur || 12;
    box(g, color, x, y, w, h); g.restore();
  }

  function windowPane(g, x, y, w, h, p, seed, arched) {
    const lit = noise(seed, x) > .22, color = lit ? (noise(seed, y) > .5 ? "#e4ac79" : "#d88c99") : "#2b4058";
    if (arched) {
      arch(g, p.trim, x - 3, y - 4, w + 6, h + 7);
      arch(g, ink, x - 1, y - 2, w + 2, h + 3);
      arch(g, color, x + 1, y, w - 2, h);
    } else {
      box(g, p.trim, x - 3, y - 3, w + 6, h + 6);
      box(g, ink, x - 1, y - 1, w + 2, h + 2);
      box(g, color, x + 1, y + 1, w - 2, h - 2);
    }
    if (lit) {
      box(g, "#ffe6b588", x + 3, y + 7, Math.max(2, w / 2 - 5), h - 10);
      box(g, "#95667c", x + w - 7, y + 5, 5, h - 6);
      if (noise(seed, 31) > .56) {
        box(g, "#45405a", x + w * .55, y + h - 13, 4, 12);
        box(g, "#45405a", x + w * .55 - 1, y + h - 16, 6, 5);
      }
    }
    box(g, p.timber, x + w / 2 - 1, y + 4, 2, h - 4);
    box(g, p.timber, x + 1, y + h * .43, w - 2, 2);
    box(g, p.trim, x - 5, y + h + 2, w + 10, 3);
    if (noise(seed, 72) > .65) {
      box(g, "#8a5657", x - 2, y + h + 5, 15, 4);
      box(g, "#6c9c7a", x, y + h + 1, 3, 5);
      box(g, "#8abd88", x + 5, y + h - 1, 3, 7);
      box(g, pink, x + 6, y + h - 2, 2, 2);
    }
  }

  function balcony(g, x, y, w, p, enclosed) {
    box(g, ink, x - 3, y, w + 6, 31);
    box(g, p.timber, x, y + 2, w, 27);
    box(g, p.wood, x - 2, y, w + 4, 4);
    box(g, p.trim, x - 3, y + 29, w + 6, 3);
    for (let bx = x + 5; bx < x + w - 3; bx += 13) {
      box(g, p.wood, bx, y + 5, 2, 23);
      if (enclosed) {
        box(g, "#c3c0a8", bx + 3, y + 6, 7, 11);
        box(g, "#526e7f", bx + 4, y + 7, 5, 9);
      } else {
        // Repeating diamond fretwork is characteristic of the old timber galleries.
        line(g, p.wood, bx + 2, y + 7, bx + 10, y + 19);
        line(g, p.wood, bx + 10, y + 7, bx + 2, y + 19);
      }
      box(g, p.wood, bx + 3, y + 23, 7, 2);
    }
    box(g, p.wood, x, y + 20, w, 2);
    for (let bx = x + 8; bx < x + w - 5; bx += 32) {
      box(g, p.timber, bx, y + 32, 3, 7);
      box(g, p.trim, bx + 3, y + 32, 3, 3);
    }
  }

  function tiledRoof(g, b, p) {
    const { x, y, w } = b;
    box(g, "#241e30", x - 3, y + 2, w + 6, 23);
    box(g, p.roof, x + 4, y + 3, w - 8, 14);
    for (let row = 0; row < 3; row++) {
      for (let tx = x + 5 + (row % 2) * 5; tx < x + w - 7; tx += 11) {
        box(g, row % 2 ? "#c2846e" : "#85505b", tx, y + 4 + row * 4, 8, 2);
        box(g, "#694353", tx + 8, y + 5 + row * 4, 2, 3);
      }
    }
    box(g, p.trim, x - 2, y + 18, w + 4, 4);
    box(g, p.timber, x + 2, y + 22, w - 4, 3);
    for (let tx = x + 10; tx < x + w - 7; tx += 13) box(g, p.trim, tx, y + 23, 4, 5);
    box(g, "#443945", x + w * .71, y + 3, 15, 11);
    box(g, "#c19b8a", x + w * .71 - 2, y + 2, 19, 3);
  }

  function wallTexture(g, b, p, seed) {
    for (let n = 0; n < b.w * .3; n++) {
      const x = b.x + 9 + noise(seed + n, 11) * (b.w - 20);
      const y = b.y + 30 + noise(seed + n, 24) * (b.h - 38);
      box(g, n % 4 ? p.shade : p.trim, x, y, 2 + noise(n, seed) * 9, 1);
    }
    box(g, "#383441", b.x + 5, b.y + 28, 2, b.h - 33);
    box(g, p.trim, b.x + 7, b.y + 29, 1, b.h - 34);
  }

  function neonSign(g, b, y, large) {
    const width = Math.min(b.w - 30, large ? 370 : 190), x = b.x + (b.w - width) / 2, height = large ? 36 : 24;
    box(g, "#080d19", x - 4, y - 4, width + 8, height + 8);
    box(g, "#252138", x, y, width, height);
    g.save(); g.shadowColor = b.color; g.shadowBlur = 13;
    g.strokeStyle = b.color; g.lineWidth = 2; g.strokeRect(x + 1, y + 1, width - 2, height - 2);
    text(g, b.sign, b.x + b.w / 2, y + height / 2, large ? 20 : b.w < 145 ? 8 : 12, "#fff0e8", width - 12);
    g.restore();
    for (let px = x + 7; px < x + width - 5; px += 16) {
      box(g, px % 3 ? cream : b.color, px, y - 4, 3, 2);
      if (large) box(g, b.color, px, y + height + 2, 3, 2);
    }
    return { x, y, width, height };
  }

  function shopItem(g, b, x, y, width, seed) {
    const type = b.type;
    if (type === "bakery") {
      box(g, "#745055", x, y + 19, width, 3);
      for (let n = 0; n < width - 8; n += 12) {
        box(g, "#d79659", x + n + 2, y + 12, 9, 5);
        box(g, "#f2ce83", x + n + 3, y + 10, 7, 3);
        box(g, "#a56b49", x + n + 5, y + 10, 1, 4);
      }
    } else if (type === "internet" || type === "arcade" || type === "casino") {
      for (let n = 0; n < width - 14; n += 25) {
        box(g, "#dad4c8", x + n + 2, y + 4, 18, 14);
        box(g, "#263b56", x + n + 4, y + 6, 14, 10);
        box(g, type === "casino" ? pink : cyan, x + n + 6, y + 8, 10, 6);
        box(g, "#687386", x + n + 8, y + 18, 5, 2);
        box(g, "#c0b6bc", x + n + 2, y + 21, 20, 3);
      }
    } else if (type === "music" || b.id === "cassette-shop" || b.id === "radio") {
      for (let row = 0; row < 2; row++) {
        for (let n = 0; n < width - 10; n += 12) {
          box(g, ["#b89183", "#dd75ad", "#63b9cb", "#dfb268"][(n / 12 + row + seed) % 4 | 0], x + n + 2, y + 2 + row * 11, 9, 7);
          box(g, "#34334b", x + n + 3, y + 4 + row * 11, 7, 3);
          box(g, cream, x + n + 4, y + 5 + row * 11, 1, 1);
          box(g, cream, x + n + 7, y + 5 + row * 11, 1, 1);
        }
      }
    } else if (type === "cafe" || type === "bar") {
      for (let n = 0; n < width - 5; n += 9) {
        box(g, ["#6ab7a8", "#c55c82", "#d5a763"][n / 9 % 3 | 0], x + n + 2, y + 7, 4, 13);
        box(g, "#d2b99e", x + n + 3, y + 4, 2, 5);
      }
      box(g, "#74515b", x, y + 20, width, 3);
    } else if (b.id.includes("flower")) {
      for (let n = 0; n < width - 6; n += 10) {
        box(g, "#5d9e7f", x + n + 4, y + 8, 2, 15);
        box(g, "#77bb8a", x + n + 2, y + 14, 5, 2);
        box(g, [pink, cream, "#c09aff"][n / 10 % 3 | 0], x + n + 2, y + 5, 6, 5);
      }
    } else if (b.id === "bookshop") {
      for (let n = 0; n < width - 3; n += 5) box(g, ["#bd7a8b", "#64a1aa", "#d3a274"][n / 5 % 3 | 0], x + n + 1, y + 7 + n % 3, 3, 15 - n % 3);
      box(g, "#74515b", x, y + 22, width, 2);
    } else {
      for (let n = 0; n < width - 6; n += 10) {
        box(g, ["#d4b07a", "#65b6bd", "#d283ae"][n / 10 % 3 | 0], x + n + 2, y + 7 + n % 5, 7, 13);
        box(g, cream, x + n + 3, y + 9 + n % 5, 3, 2);
      }
    }
  }

  function shopFront(g, b, p, seed, options) {
    const y = b.y + b.h - 60, doorX = b.x + Math.round(b.w * .72), awning = !options || options.awning !== false;
    box(g, p.shade, b.x + 5, y - 7, b.w - 10, 62);
    if (awning) {
      box(g, ink, b.x + 5, y - 11, b.w - 10, 13);
      for (let x = b.x + 7; x < b.x + b.w - 12; x += 12) {
        box(g, (Math.floor((x - b.x) / 12) % 2) ? p.trim : p.timber, x, y - 9, 11, 10);
        box(g, (Math.floor((x - b.x) / 12) % 2) ? "#d1b493" : b.color, x, y, 11, 3);
      }
    }
    const paneCount = Math.max(2, Math.floor((b.w - 22) / 58)), paneWidth = (b.w - 22) / paneCount;
    for (let n = 0; n < paneCount; n++) {
      const x = b.x + 11 + n * paneWidth;
      box(g, p.trim, x - 2, y + 5, paneWidth - 3, 43);
      box(g, "#223c51", x, y + 7, paneWidth - 7, 38);
      box(g, "#d0aa7988", x + 2, y + 9, paneWidth - 11, 30);
      box(g, "#f2d69a", x + 2, y + 9, paneWidth - 11, 2);
      shopItem(g, b, x + 3, y + 13, paneWidth - 14, seed + n);
      box(g, "#c6d6d333", x + 4, y + 12, 2, 22);
    }
    box(g, "#171725", doorX - 3, y + 9, 29, 47);
    box(g, p.timber, doorX, y + 11, 23, 43);
    box(g, "#5c8b96", doorX + 3, y + 14, 17, 24);
    box(g, "#cce4dd88", doorX + 5, y + 16, 3, 18);
    box(g, cream, doorX + 18, y + 37, 2, 3);
    box(g, "#a08c8b", doorX - 5, b.y + b.h - 3, 34, 3);
    box(g, "#48404c", doorX - 8, b.y + b.h, 40, 3);
    if (b.enterable) {
      glowBox(g, "#8cffd2", doorX + 7, y + 3, 9, 3, 8);
      text(g, "ღიაა", doorX + 12, y + 23, 5, cream, 17);
    }
    box(g, p.trim, b.x + 6, b.y + b.h - 6, b.w - 12, 3);
  }

  function domesticDetails(g, b, p, seed) {
    const x = b.x, y = b.y, w = b.w;
    // TV antenna and a slatted Soviet air conditioner remain visible above the shop lights.
    box(g, "#77788b", x + w - 29, y + 8, 2, 20);
    line(g, "#9994a4", x + w - 39, y + 11, x + w - 19, y + 17);
    line(g, "#9994a4", x + w - 39, y + 17, x + w - 19, y + 11);
    box(g, "#2a293a", x + 12, y + 36, 26, 17);
    box(g, "#9294a0", x + 14, y + 38, 22, 12);
    for (let n = 0; n < 4; n++) box(g, "#525e71", x + 16, y + 40 + n * 2, 17, 1);
    line(g, "#685765", x + 17, y + 51, x + 11, y + 70);
    if (w > 200 && seed % 2 === 0) {
      const ly = y + 60;
      g.strokeStyle = "#c0a7aa"; g.lineWidth = 1; g.beginPath();
      g.moveTo(x + w * .32, ly); g.quadraticCurveTo(x + w * .55, ly + 11, x + w * .79, ly); g.stroke();
      ["#cbb5b0", "#c37593", "#74a4b7", "#bb9d79"].forEach((color, n) => {
        box(g, color, x + w * .36 + n * 17, ly + 4 + (n % 2) * 2, 11, 14 + n % 2 * 5);
        box(g, "#ded0bc", x + w * .36 + n * 17, ly + 3 + (n % 2) * 2, 2, 3);
      });
    }
    box(g, "#242836", x + w - 8, y + 31, 3, b.h - 38);
    box(g, "#78828c", x + w - 8, y + 32, 1, b.h - 42);
    box(g, "#355768", x + 10, y + b.h - 37, 19, 12);
    box(g, "#a2bfbe", x + 11, y + b.h - 36, 17, 1);
    text(g, String(3 + seed % 96).padStart(2, "0"), x + 20, y + b.h - 30, 7, cream, 17);
    if (b.id === "rooftop") {
      for (let r = 0; r < 11; r++) box(g, "#a9a0aa", x + w - 34, y + 28 + r * 12, 18, 2);
      box(g, "#3e3448", x + w - 36, y + 26, 2, 136);
      box(g, "#3e3448", x + w - 17, y + 26, 2, 136);
    }
  }

  function oldBuilding(g, b, i) {
    const p = oldPalettes[i % oldPalettes.length], seed = i + 11;
    box(g, p.wall, b.x, b.y, b.w, b.h);
    wallTexture(g, b, p, seed); tiledRoof(g, b, p);
    const cols = Math.max(2, Math.floor((b.w - 18) / 54)), gap = (b.w - 22) / cols, upperY = b.y + 38;
    for (let n = 0; n < cols; n++) {
      const wx = b.x + 11 + gap * n + (gap - 25) / 2;
      windowPane(g, wx, upperY, 25, 37, p, seed + n, true);
    }
    if (b.type === "courtyard" || b.type === "house" || b.id === "cafe-balcony" || b.id === "river-cafe") {
      balcony(g, b.x + 13, b.y + 78, b.w - 26, p, b.id === "cafe-balcony");
      for (let n = 0; n < cols; n++) {
        box(g, p.timber, b.x + 16 + gap * n, upperY - 8, 3, 45);
        box(g, p.trim, b.x + 17 + gap * n, upperY - 10, gap - 4, 3);
      }
    } else {
      for (let n = 0; n < cols; n++) {
        const wx = b.x + 11 + gap * n + (gap - 25) / 2;
        box(g, p.timber, wx - 4, b.y + 82, 33, 11);
        box(g, p.trim, wx - 5, b.y + 91, 35, 2);
        for (let r = 0; r < 6; r++) box(g, p.wood, wx - 3 + r * 6, b.y + 83, 2, 8);
      }
    }
    neonSign(g, b, b.y + b.h - 94, false);
    shopFront(g, b, p, seed); domesticDetails(g, b, p, seed);
    if (b.type === "courtyard") {
      const ax = b.x + b.w * .43, ay = b.y + b.h - 59;
      arch(g, p.trim, ax - 4, ay - 5, 45, 64);
      arch(g, "#171b2b", ax, ay, 37, 59);
      arch(g, "#253c47", ax + 7, ay + 12, 24, 47);
      box(g, "#77625f", ax + 1, ay + 47, 35, 12);
      for (let n = 0; n < 5; n++) box(g, "#a58d78", ax + 2, ay + 48 + n * 2, 32, 1);
      glowBox(g, cream, ax + 15, ay + 17, 4, 3, 10);
    }
  }

  function classicalBuilding(g, b) {
    const p = { wall: "#766278", shade: "#4d405d", trim: "#c9a4ac", timber: "#6b627b", wood: "#b3a0ac" };
    box(g, p.wall, b.x, b.y, b.w, b.h);
    wallTexture(g, b, p, 42);
    // Rustaveli's theatre facades: a stepped pediment, pilasters and tall arched bays.
    const pedimentSteps = Math.min(5, Math.max(2, Math.floor((b.w - 20) / 34)));
    for (let n = 0; n < pedimentSteps; n++) box(g, n % 2 ? "#a88393" : "#d2adac", b.x + 6 + n * 17, b.y + 5 + n * 3, b.w - 12 - n * 34, 4);
    box(g, "#45344f", b.x + 13, b.y + 31, b.w - 26, 4);
    text(g, "თბილისი · 1939", b.x + b.w / 2, b.y + 25, 8, cream, b.w - 90);
    const columns = Math.max(2, Math.floor((b.w - 30) / 55) + 1), columnGap = (b.w - 38) / (columns - 1);
    for (let n = 0; n < columns; n++) {
      const x = b.x + 19 + n * columnGap;
      box(g, "#4d415b", x - 7, b.y + 41, 14, 65);
      box(g, "#bda0a5", x - 4, b.y + 39, 8, 65);
      box(g, "#e1c3b0", x - 3, b.y + 40, 2, 62);
      box(g, "#e1bfae", x - 7, b.y + 36, 14, 5);
      box(g, "#d5b4a8", x - 7, b.y + 102, 14, 5);
      if (n < columns - 1) windowPane(g, x + (columnGap - 27) / 2, b.y + 46, 27, 48, p, n + 30, true);
    }
    neonSign(g, b, b.y + b.h - 83, true);
    box(g, "#252237", b.x + 8, b.y + b.h - 42, b.w - 16, 39);
    const posters = Math.max(2, Math.floor((b.w - 24) / 45));
    for (let n = 0; n < posters; n++) {
      const x = b.x + 14 + n * (b.w - 28) / posters;
      box(g, "#b29da0", x, b.y + b.h - 40, 30, 34);
      box(g, n % 2 ? "#7b3d71" : "#325a79", x + 3, b.y + b.h - 37, 24, 28);
      box(g, cream, x + 9, b.y + b.h - 34, 12, 2);
      box(g, "#e491a6", x + 10, b.y + b.h - 28, 9, 14);
    }
    box(g, "#ac8b94", b.x + 5, b.y + b.h - 3, b.w - 10, 4);
  }

  function modernBuilding(g, b, i) {
    const p = { wall: "#414c69", shade: "#28334d", trim: "#8ba1b4", wood: "#8aa6b9", timber: "#35485d" };
    const arcade = b.type === "arcade", casino = b.type === "casino", apartment = b.type === "apartment";
    box(g, casino ? "#574060" : p.wall, b.x, b.y, b.w, b.h);
    for (let y = b.y + 13; y < b.y + b.h - 70; y += 29) {
      box(g, "#7e7e9755", b.x + 4, y, b.w - 8, 1);
      for (let x = b.x + 9; x < b.x + b.w - 19; x += 32) {
        box(g, "#21283f", x, y + 5, 23, 19);
        box(g, noise(x, y) > .4 ? (apartment ? "#dcb18b" : "#4a9da8") : "#354962", x + 2, y + 7, 19, 15);
        box(g, "#c4d2cd66", x + 4, y + 8, 2, 10);
        box(g, p.trim, x + 11, y + 6, 1, 18);
      }
    }
    box(g, "#8996a4", b.x - 2, b.y + 3, b.w + 4, 5);
    box(g, "#252a43", b.x + 5, b.y + 8, b.w - 10, 9);
    if (apartment) {
      for (let n = 0; n < 3; n++) balcony(g, b.x + 14, b.y + 47 + n * 30, b.w - 28, p, false);
      neonSign(g, b, b.y + b.h - 86, false);
    } else {
      glowBox(g, casino ? pink : cyan, b.x + 7, b.y + 20, 3, b.h - 28, 14);
      glowBox(g, pink, b.x + b.w - 10, b.y + 20, 3, b.h - 28, 14);
      const sign = neonSign(g, b, b.y + b.h - (arcade ? 111 : 91), arcade);
      if (arcade) {
        text(g, "ჩააგდე მონეტა · 1999", b.x + b.w / 2, sign.y + sign.height + 12, 8, cyan, b.w - 35);
        box(g, "#151930", b.x + b.w / 2 - 17, b.y + 24, 34, 31);
        // Space invader on the roofline, drawn in square CRT pixels.
        ["00100100", "00011000", "01111110", "11011011", "11111111", "10100101", "00100100"].forEach((row, ry) => {
          [...row].forEach((pixel, rx) => { if (pixel === "1") box(g, rx % 2 ? pink : cyan, b.x + b.w / 2 - 12 + rx * 3, b.y + 28 + ry * 3, 2, 2); });
        });
      }
    }
    shopFront(g, b, p, i, { awning: false });
    domesticDetails(g, b, p, i);
    if (b.type === "internet") text(g, "ინტერნეტი · 24 საათი", b.x + b.w / 2, b.y + 29, 8, cream, b.w - 60);
    if (casino) {
      text(g, "♠  ♥  ♦  ♣", b.x + b.w / 2, b.y + 43, 17, "#ffb7da", b.w - 35);
      text(g, "1999", b.x + b.w / 2, b.y + 69, 11, cream, b.w - 40);
    }
  }

  function passageBuilding(g, b) {
    box(g, "#696074", b.x, b.y, b.w, b.h);
    box(g, "#9c8d9b", b.x + 4, b.y + 4, b.w - 8, 8);
    for (let y = b.y + 20; y < b.y + b.h; y += 15) {
      for (let x = b.x + 7 + (y % 2) * 7; x < b.x + b.w - 9; x += 24) box(g, "#b2a2aa44", x, y, 20, 11);
    }
    const mouthX = b.x + 17, mouthY = b.y + 72, width = b.w - 34;
    arch(g, "#b2a0b0", mouthX - 5, mouthY - 7, width + 10, b.h - 67);
    arch(g, "#11182c", mouthX, mouthY, width, b.h - 72);
    const innerWidth = Math.max(20, width - 30);
    for (let n = 0; n < 9; n++) {
      const stepW = innerWidth * (.38 + n * .07), stepY = mouthY + 40 + n * 9;
      if (stepY > b.y + b.h - 4) break;
      box(g, n % 2 ? "#4f4b68" : "#343952", b.x + b.w / 2 - stepW / 2, stepY, stepW, 8);
      box(g, "#8b76935c", b.x + b.w / 2 - stepW / 2, stepY, stepW, 1);
    }
    line(g, "#a498b7", mouthX + 10, b.y + b.h - 12, b.x + b.w * .39, mouthY + 39, 2);
    line(g, "#a498b7", mouthX + width - 10, b.y + b.h - 12, b.x + b.w * .61, mouthY + 39, 2);
    neonSign(g, b, b.y + 29, false);
    glowBox(g, cyan, b.x + b.w / 2 - 14, mouthY + 28, 28, 3, 15);
    text(g, "M", b.x + 18, b.y + 26, 16, "#ff797d", 19);
  }

  function drawBuilding(g, b, i) {
    g.save();
    // Deep pavement shadow, then a three pixel side face gives every block a clear silhouette.
    box(g, "#070b17bb", b.x - 5, b.y + 4, b.w + 12, b.h + 5);
    if (b.type === "cinema" || b.id === "old-bank") classicalBuilding(g, b);
    else if (["arcade", "casino", "internet", "apartment"].includes(b.type)) modernBuilding(g, b, i);
    else if (b.type === "passage") passageBuilding(g, b);
    else oldBuilding(g, b, i);
    box(g, "#202237", b.x + b.w - 3, b.y + 8, 3, b.h - 5);
    g.globalAlpha = .18;
    box(g, b.color, b.x + 8, b.y + b.h + 3, b.w - 14, 4);
    g.globalAlpha = .08;
    for (let n = 0; n < 4; n++) box(g, b.color, b.x + 17 + n * 15, b.y + b.h + 8, Math.max(5, b.w - 48 - n * 27), 1);
    g.restore();
  }

  function drawStreetDetails(g, world) {
    g.save();
    world.buildings.forEach((b, i) => {
      // Wires and hand painted wall posters sit against the facade, never in a walking lane.
      if (b.w > 200 && i % 3 === 0) {
        g.strokeStyle = "#191629"; g.lineWidth = 2; g.beginPath();
        g.moveTo(b.x + 8, b.y + 24); g.quadraticCurveTo(b.x + b.w * .5, b.y + 47, b.x + b.w - 10, b.y + 23); g.stroke();
        for (let n = 0; n < 6; n++) glowBox(g, n % 2 ? pink : cream, b.x + 25 + n * (b.w - 50) / 6, b.y + 29 + Math.sin(n / 5 * Math.PI) * 7, 2, 3, 4);
      }
      if (b.w > 155 && b.type !== "passage") {
        const x = b.x + b.w - 26, y = b.y + b.h - 48;
        box(g, "#d6b69c", x, y, 14, 20);
        box(g, i % 2 ? "#853e7c" : "#366176", x + 1, y + 1, 12, 10);
        box(g, "#f1d2ad", x + 3, y + 13, 8, 1);
        box(g, "#a17f7d", x + 3, y + 16, 6, 1);
      }
    });
    g.restore();
  }

  function signBounds(b) {
    const classical = b.type === "cinema" || b.id === "old-bank", arcade = b.type === "arcade";
    const modern = ["arcade", "casino", "internet", "apartment"].includes(b.type);
    const large = classical || arcade, w = Math.min(b.w - 30, large ? 370 : 190);
    const y = b.type === "passage" ? b.y + 29 : b.y + b.h -
      (classical ? 83 : b.type === "apartment" ? 86 : modern ? (arcade ? 111 : 91) : 94);
    return { x: b.x + (b.w - w) / 2, y: y, w: w, h: large ? 36 : 24 };
  }
  return { drawBuilding: drawBuilding, drawStreetDetails: drawStreetDetails, signBounds: signBounds };
});
