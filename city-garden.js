/* Shared outdoor garden presentation. Real player poses and seats come from the server. */
(function (root) {
  "use strict";
  const colors = ["#ff64cf", "#6df8e5", "#b699ff", "#ffd582", "#79c6ff"];
  const moves = [["running-man", "მორბენალი"], ["cabbage-patch", "წრიული"], ["electric-slide", "სრიალი"], ["robot", "რობოტი"]];
  let bridge = null, socket = null, panel = null, state = { epoch: Date.now(), seats: [] }, occupied = new Map(), lastUiKey = "";
  function box(g, color, x, y, w, h) { g.fillStyle = color; g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)); }
  function text(g, value, x, y, size = 12, color = "#fff1ec") {
    g.fillStyle = color; g.font = '800 ' + size + 'px "Noto Sans Georgian", monospace'; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(value, x, y, 600);
  }
  function neon(g, value, x, y, w, color, size = 18) {
    box(g, "#101425", x - w / 2 - 5, y - 21, w + 10, 42);
    g.save(); g.strokeStyle = color; g.lineWidth = 2; g.shadowColor = color; g.shadowBlur = 12; g.strokeRect(x - w / 2, y - 16, w, 32); text(g, value, x, y, size, color); g.restore();
  }
  function tree(g, x, y, variant = 0) {
    box(g, "#06132188", x - 37, y - 7, 80, 24); box(g, "#49344a", x - 5, y - 38, 10, 40);
    [[-31, -57, 36, 29], [-8, -70, 37, 37], [-42, -39, 39, 31], [-4, -44, 45, 37]].forEach((p, i) => {
      box(g, ["#28574e", "#376e5f", "#244347", "#457965"][(i + variant) % 4], x + p[0], y + p[1], p[2], p[3]);
    });
    for (let i = 0; i < 6; i++) box(g, colors[(i + variant) % 5], x - 25 + (i * 17) % 55, y - 45 + (i * 13) % 35, 3, 3);
  }
  function seat(g, item) {
    const { x, y, kind } = item;
    if (kind === "stool") {
      box(g, "#181b2a", x - 3, y + 1, 6, 21); box(g, "#80758c", x - 13, y + 19, 26, 3);
      box(g, "#322335", x - 17, y - 8, 34, 15); box(g, "#e05d98", x - 15, y - 9, 30, 11); box(g, "#ffb8ba", x - 11, y - 8, 22, 2);
    } else {
      const w = kind === "couch" ? 76 : 48, fill = kind === "couch" ? "#824870" : "#695255";
      box(g, "#0a1120", x - w / 2 - 3, y - 10, w + 6, 34); box(g, fill, x - w / 2, y - 15, w, 30);
      box(g, "#ce8c9c", x - w / 2 + 3, y - 14, w - 6, 4); box(g, "#382e42", x - w / 2 + 4, y + 7, w - 8, 5);
      box(g, "#ad7388", x - w / 2 - 3, y - 5, 6, 21); box(g, "#ad7388", x + w / 2 - 3, y - 5, 6, 21);
      box(g, "#6a657b", x - w / 2 + 6, y + 16, 3, 8); box(g, "#6a657b", x + w / 2 - 9, y + 16, 3, 8);
    }
  }
  function drawStatic(g, world) {
    const garden = world.garden, b = garden.bounds, floor = garden.danceFloor;
    g.save(); box(g, "#10252d", b.x, b.y, b.w, b.h);
    for (let y = b.y + 20; y < b.y + b.h - 18; y += 28) for (let x = b.x + 20; x < b.x + b.w - 18; x += 28) {
      const n = (x * 13 + y * 7) % 19; box(g, n % 3 ? "#183239" : "#21333e", x, y, 25, 25);
      if (n % 5 === 0) { box(g, "#41615a", x + 7, y + 9, 2, 5); box(g, "#56766b", x + 10, y + 11, 2, 3); }
    }
    // Wide walking paths branch around the DJ booth and meet at the dance floor.
    [[1280, 1840, 240, 190], [1070, 1980, 650, 80], [1080, 2020, 100, 260], [1600, 2020, 120, 260], [340, 2370, 1850, 86], [1280, 2780, 180, 415]].forEach(p => {
      box(g, "#393044", ...p); for (let x = p[0] + 6; x < p[0] + p[2] - 4; x += 28) for (let y = p[1] + 5; y < p[1] + p[3] - 4; y += 22) box(g, "#5c4e61", x, y, 24, 1);
    });
    box(g, "#070c1c", floor.x - 12, floor.y - 12, floor.w + 24, floor.h + 24);
    box(g, "#8af5ea", floor.x - 6, floor.y - 6, floor.w + 12, floor.h + 12);
    for (let y = floor.y; y < floor.y + floor.h; y += 40) for (let x = floor.x; x < floor.x + floor.w; x += 40) {
      box(g, (Math.floor((x - floor.x) / 40) + Math.floor((y - floor.y) / 40)) % 2 ? "#3b254d" : "#26384c", x, y, 38, 38);
      box(g, "#ac739e", x + 2, y + 2, 34, 1);
    }
    // Iron perimeter, illuminated posts, and the open north gate.
    const fence = (x, y, w, h) => {
      box(g, "#121424", x, y, w, h); box(g, "#647785", x, y, w, Math.min(3, h));
      if (w > h) for (let p = x; p < x + w; p += 24) box(g, "#7c778d", p, y - 7, 3, h + 10);
      else for (let p = y; p < y + h; p += 24) box(g, "#7c778d", x - 2, p, w + 5, 3);
    };
    fence(120, 1840, 1160, 18); fence(1520, 1840, 920, 18); fence(120, 1840, 18, 1440); fence(2422, 1840, 18, 1440); fence(120, 3262, 2320, 18);
    [1260, 1540].forEach(x => { box(g, "#242c43", x - 12, 1768, 24, 92); box(g, "#bf8bc8", x - 14, 1767, 28, 7); });
    neon(g, "ნეონის ბაღი · 1999", 1400, 1776, 420, "#82ffcc", 22);
    text(g, "მუსიკა · მეგობრები · ყოველთვის ღამე", 1400, 1812, 11, "#edd4f7");
    neon(g, "იცეკვე თბილისის ცის ქვეშ", 1380, 2014, 590, "#ff84d7", 18);
    const dj = garden.dj;
    box(g, "#090e22", dj.x - 10, dj.y - 8, dj.w + 20, dj.h + 20); box(g, "#463254", dj.x, dj.y, dj.w, dj.h);
    box(g, "#7ee9df", dj.x + 4, dj.y + 3, dj.w - 8, 4); box(g, "#2a1e3e", dj.x + 12, dj.y + 16, dj.w - 24, 70);
    [dj.x + 65, dj.x + dj.w - 65].forEach(x => {
      g.fillStyle = "#101723"; g.beginPath(); g.arc(x, dj.y + 49, 31, 0, Math.PI * 2); g.fill();
      g.strokeStyle = "#587c90"; g.lineWidth = 2; [13, 24].forEach(r => { g.beginPath(); g.arc(x, dj.y + 49, r, 0, Math.PI * 2); g.stroke(); });
      box(g, "#ff71c5", x - 5, dj.y + 44, 10, 10);
    });
    for (let i = 0; i < 7; i++) { box(g, "#75f1df", dj.x + 143 + i * 9, dj.y + 33, 4, 28); box(g, "#edd8a3", dj.x + 141 + i * 9, dj.y + 36 + i % 3 * 6, 8, 4); }
    neon(g, "დიჯეი ნიკა · ორიგინალური მუსიკა", 1380, dj.y + 102, 330, "#7af9e5", 14);
    const bar = garden.bar;
    box(g, "#17172b", bar.x - 9, bar.y - 6, bar.w + 18, bar.h + 16); box(g, "#6a3b54", bar.x, bar.y, bar.w, bar.h);
    box(g, "#a87375", bar.x + 7, bar.y + 8, bar.w - 14, 28);
    for (let x = bar.x + 18; x < bar.x + bar.w - 10; x += 24) {
      const c = colors[Math.floor(x / 24) % 5]; box(g, "#302b3c", x - 2, bar.y + 3, 15, 30); box(g, c, x, bar.y + 4, 10, 22); box(g, "#f2d99f", x + 3, bar.y - 3, 4, 9); box(g, "#fff0bf", x + 2, bar.y + 12, 6, 8);
    }
    box(g, "#211b2e", bar.x + 14, bar.y + 50, bar.w - 28, 53); box(g, "#c89773", bar.x - 3, bar.y + 111, bar.w + 6, 26);
    box(g, "#f4c997", bar.x - 3, bar.y + 111, bar.w + 6, 4);
    for (let x = bar.x + 30; x < bar.x + bar.w; x += 60) { box(g, "#e5bf69", x, bar.y + 104, 14, 14); box(g, "#fff0c0", x, bar.y + 103, 14, 3); }
    neon(g, "ბესოსთან · ლუდი და ამბები", bar.x + bar.w / 2, bar.y - 34, 420, "#ffd37f", 18);
    garden.speakers.forEach(s => {
      box(g, "#090d1a", s.x, s.y, s.w, s.h); box(g, "#4e405e", s.x + 3, s.y + 3, s.w - 6, s.h - 6);
      [15, 42].forEach((offset, i) => { g.fillStyle = "#0d1725"; g.beginPath(); g.arc(s.x + s.w / 2, s.y + offset, i ? 17 : 9, 0, Math.PI * 2); g.fill(); g.strokeStyle = "#8e718d"; g.lineWidth = 2; g.stroke(); });
      box(g, "#70ead4", s.x + 6, s.y + s.h - 6, s.w - 12, 2);
    });
    garden.tables.forEach(t => {
      box(g, "#0a1425", t.x - 44, t.y - 18, 88, 48); box(g, "#a87973", t.x - 40, t.y - 20, 80, 40); box(g, "#d6ac86", t.x - 38, t.y - 18, 76, 3);
      box(g, "#26384d", t.x - 2, t.y - 18, 4, 36); [-24, 20].forEach(x => { box(g, "#e8b95c", t.x + x, t.y - 12, 10, 13); box(g, "#fff3ce", t.x + x, t.y - 13, 10, 3); });
      box(g, "#f16bb5", t.x - 6, t.y + 4, 12, 6); box(g, "#a0f8cf", t.x - 3, t.y - 4, 4, 12);
    });
    garden.seats.forEach(s => seat(g, s));
    garden.corners.forEach((c, i) => { neon(g, i ? "მეორე მხარე · მყუდრო კუთხე" : "ტირიფის მოსასვენებელი", c.x + c.w / 2, c.y - 22, c.w, colors[i + 1], 12); });
    [1950, 2440, 2890, 3180].forEach((y, row) => {
      g.strokeStyle = "#0a1022"; g.lineWidth = 2; g.beginPath(); g.moveTo(165, y); g.quadraticCurveTo(1280, y + 45, 2390, y); g.stroke();
      for (let i = 0; i < 39; i++) { const x = 180 + i * 57, yy = y + Math.sin(i / 38 * Math.PI) * 22; box(g, "#58475b", x, yy, 2, 5); box(g, colors[(i + row) % 5], x - 2, yy + 4, 6, 7); }
    });
    garden.secrets.forEach(s => {
      if (s.kind === "cassette") { box(g, "#d89cbe", s.x - 10, s.y - 7, 20, 14); box(g, "#302641", s.x - 7, s.y - 4, 14, 6); box(g, "#f3dab9", s.x - 6, s.y - 3, 3, 3); box(g, "#f3dab9", s.x + 3, s.y - 3, 3, 3); }
      if (s.kind === "poster") { box(g, "#d6b795", s.x - 25, s.y - 40, 50, 65); box(g, "#723b87", s.x - 22, s.y - 37, 44, 37); text(g, "'99", s.x, s.y - 18, 18, "#f9d8a6"); text(g, "ნეონი", s.x, s.y + 10, 8, "#2a263b"); }
    });
    g.restore();
  }
  function beat() { return root.GaicaniCityAudio?.getBeat() || { bpm: 100, pulse: (Math.sin((Date.now() - state.epoch) / 96) + 1) / 2, phase: (Date.now() - state.epoch) / 600 }; }
  function drawDynamic(g, world, now, options = {}) {
    const { inView = () => true, phone = false } = options, garden = world.garden, floor = garden.danceFloor, music = beat();
    if (inView(floor.x + floor.w / 2, floor.y + floor.h / 2, 440)) {
      g.save(); const phase = Math.floor((Date.now() - state.epoch) / (60000 / music.bpm));
      for (let row = 0; row < 13; row++) for (let col = 0; col < 17; col++) {
        if (phone && (row + col + phase) % 3) continue;
        const x = floor.x + col * 40, y = floor.y + row * 40;
        if (!inView(x, y, 45)) continue;
        g.globalAlpha = .12 + music.pulse * .27; box(g, colors[(row * 3 + col + phase) % 5], x + 2, y + 2, 35, 35);
      }
      g.globalAlpha = 1;
      for (let i = 0; i < (phone ? 2 : 5); i++) {
        const x = garden.dj.x + 25 + i * (garden.dj.w - 50) / (phone ? 1 : 4), end = floor.x + floor.w / 2 + Math.sin(now / 1600 + i * 1.8) * 380;
        g.fillStyle = colors[i] + "16"; g.beginPath(); g.moveTo(x, garden.dj.y + garden.dj.h); g.lineTo(end - 70, floor.y + floor.h); g.lineTo(end + 70, floor.y + floor.h); g.closePath(); g.fill();
      }
      g.restore();
    }
    garden.speakers.forEach(s => { if (!inView(s.x, s.y)) return; g.save(); g.strokeStyle = "#82ffdb"; g.globalAlpha = .18 + music.pulse * .3; g.lineWidth = 2; g.beginPath(); g.arc(s.x + s.w / 2, s.y + 42, 10 + music.pulse * 9, 0, Math.PI * 2); g.stroke(); g.restore(); });
    garden.trees.forEach((t, i) => { if (inView(t.x, t.y)) { const sway = Math.sin(now / 1400 + i) * 3; box(g, "#5b8c7355", t.x - 20 + sway, t.y - 56, 16, 3); } });
    garden.secrets.filter(s => s.kind === "fireflies").forEach(s => {
      if (!inView(s.x, s.y, 90)) return;
      g.save(); for (let i = 0; i < 9; i++) { g.globalAlpha = .3 + .6 * Math.abs(Math.sin(now / 900 + i)); box(g, "#c4ff9e", s.x + Math.sin(now / 1500 + i) * 60, s.y + Math.cos(now / 1900 + i * 2) * 35, 2, 3); } g.restore();
    });
  }
  function drawPerson(g, person, now) {
    if (!person.gardenDance && !person.gardenSeatId) return false;
    const { x, y } = person, dance = person.gardenDance, t = (Date.now() - (dance?.startedAt || state.epoch)) / (60000 / beat().bpm), wave = Math.sin(t * Math.PI * 2), quarter = Math.floor(t) % 4;
    let lean = 0, lift = 0, dx = 0, armL = 0, armR = 0, kick = 0;
    if (dance?.move === "running-man") { lift = -Math.abs(wave) * 3; armL = wave * 7; armR = -armL; kick = wave * 7; lean = .07; }
    if (dance?.move === "cabbage-patch") { lean = wave * .14; armL = Math.cos(t * Math.PI * 2) * 6; armR = wave * 6; dx = wave * 3; }
    if (dance?.move === "electric-slide") { dx = Math.sin(t * Math.PI / 2) * 8; lift = -Math.abs(wave) * 2; armL = armR = quarter < 2 ? -4 : 4; kick = wave * 3; }
    if (dance?.move === "robot") { lean = [0, -.11, 0, .11][quarter]; armL = quarter % 2 ? -9 : 3; armR = quarter % 2 ? 3 : -9; kick = quarter === 2 ? 4 : 0; }
    g.save(); g.translate(Math.round(x + dx), Math.round(y + lift)); g.rotate(lean);
    g.fillStyle = "#05091488"; g.beginPath(); g.ellipse(0, 12, 17, 5, 0, 0, Math.PI * 2); g.fill();
    box(g, "#242139", -8, 3, 6, person.gardenSeatId ? 7 : 13 + kick); box(g, "#242139", 2, 3, 6, person.gardenSeatId ? 7 : 13 - kick);
    box(g, "#d6d4e7", -9, person.gardenSeatId ? 9 : 14 + kick, 8, 3); box(g, "#d6d4e7", 2, person.gardenSeatId ? 9 : 14 - kick, 8, 3);
    box(g, person.color || "#bd75ef", -9, -10, 18, 16); box(g, "#fff2d466", -6, -7, 12, 2);
    box(g, "#2a2134", -8, -24, 16, 14); box(g, "#efbd98", -6, -22, 12, 11); box(g, "#34213b", -8, -25, 16, 5);
    box(g, "#ffe2a7", -4, -18, 2, 2); box(g, "#ffe2a7", 3, -18, 2, 2);
    box(g, "#f2c09b", -13, -8 + armL, 4, 11); box(g, "#f2c09b", 9, -8 + armR, 4, 11);
    if (dance?.move === "robot") { box(g, "#f2c09b", -18, -8 + armL, 9, 3); box(g, "#f2c09b", 12, -8 + armR, 8, 3); }
    if (person.gardenSeatId) { box(g, "#f2c09b", -13, -1, 8, 3); box(g, "#f2c09b", 6, -1, 8, 3); }
    g.restore();
    const width = Math.max(62, Math.min(160, (person.name || "").length * 6 + 14)); box(g, "#0a1021ec", x - width / 2, y - 48, width, 17);
    g.strokeStyle = person.npc ? "#c5b797" : person.self ? "#ff7adb" : "#7fe9dd"; g.lineWidth = 1; g.strokeRect(x - width / 2, y - 48, width, 17);
    text(g, person.name || "", x, y - 39, 8, person.npc ? "#ecd4ae" : "#f6ebff");
    if (person.action === "wave") text(g, "👋", x, y - 66, 15);
    return true;
  }
  function setState(data) {
    if (!data) return; state = data; occupied = new Map((data.seats || []).map(s => [s.id, s.occupantId]));
  }
  function command(event, payload = {}) {
    if (!bridge || !socket?.connected) return;
    bridge.stop(); socket.emit(event, payload, reply => {
      if (!reply || reply.error) { bridge.toast(reply?.error || "ქალაქთან კავშირი შეფერხდა."); return; }
      if (reply.garden) setState(reply.garden); if (reply.self) bridge.acceptSelf(reply.self); updateUi();
    });
  }
  function nearestSeat() {
    const p = bridge?.self(); if (!p) return null;
    return root.GaicaniCityWorld.garden.seats.filter(s => !occupied.get(s.id) || occupied.get(s.id) === p.id).map(s => ({ s, d: Math.hypot(s.x - p.x, s.y - p.y) })).filter(item => item.d <= 85).sort((a, b) => a.d - b.d)[0]?.s || null;
  }
  function updateUi() {
    if (!bridge || !panel) return;
    const p = bridge.self(), world = root.GaicaniCityWorld, connected = !!(socket?.connected && bridge.joined()), busy = !!(p?.vehicleId || p?.gameId || root.GaicaniCityGames?.active || root.GaicaniCityGames?.blocksMovement), here = !!(connected && p && !p.interiorId && !p.rideId && !busy && world.gardenContains(p.x, p.y));
    panel.hidden = !here; document.getElementById("gardenWayfinder").hidden = here || busy || !!p?.interiorId || !!p?.rideId || !p || !connected;
    if (!here) return;
    const floor = world.gardenDanceFloorContains(p.x, p.y), seated = !!p.gardenSeatId, dancing = !!p.gardenDance;
    document.getElementById("gardenDance").disabled = !floor;
    document.getElementById("gardenPoseStop").hidden = !seated && !dancing;
    document.getElementById("gardenPoseStop").textContent = seated ? "↑ ადგომა" : "■ შეჩერება";
    document.getElementById("gardenSit").disabled = seated || !nearestSeat();
    const count = bridge.players().filter(other => !other.interiorId && !other.rideId && world.gardenContains(other.x, other.y)).length + 1;
    document.getElementById("gardenStatus").textContent = count + " ნამდვილი მოთამაშე · " + (dancing ? moves.find(m => m[0] === p.gardenDance.move)?.[1] : seated ? "დასვენება" : floor ? "ცეკვის დროა" : "საცეკვაო მოედანი შუაშია");
    const nearby = bridge.players().filter(other => !other.interiorId && !other.rideId && world.gardenContains(other.x, other.y) && Math.hypot(p.x - other.x, p.y - other.y) <= 120);
    const key = nearby.map(other => other.id + other.name).join("|");
    if (key !== lastUiKey) {
      lastUiKey = key; const select = document.getElementById("gardenWhisperTarget"), selected = select.value; select.replaceChildren();
      const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = "პირადი საუბარი · ახლოს მდგომი მოთამაშე"; select.appendChild(placeholder);
      nearby.forEach(other => { const o = document.createElement("option"); o.value = other.id; o.textContent = other.name; select.appendChild(o); });
      if (nearby.some(other => other.id === selected)) select.value = selected;
    }
    document.getElementById("gardenWhisper").disabled = !document.getElementById("gardenWhisperTarget").value;
  }
  function mount(api) {
    bridge = api; socket = api.socket();
    const wayfinder = document.createElement("div"); wayfinder.id = "gardenWayfinder"; wayfinder.className = "garden-wayfinder"; wayfinder.textContent = "↓ ნეონის ბაღი · სამხრეთის ღია ჭიშკარი"; wayfinder.hidden = true;
    panel = document.createElement("section"); panel.id = "gardenControls"; panel.className = "garden-controls"; panel.hidden = true; panel.setAttribute("aria-label", "ნეონის ბაღი — 1999");
    panel.innerHTML = "<div class=\"garden-heading\"><b>ნეონის ბაღი — 1999</b><button id=\"gardenExpand\" type=\"button\" aria-expanded=\"false\" aria-controls=\"gardenOptions\">⋯</button></div><small id=\"gardenStatus\"></small><div class=\"garden-actions\"><button id=\"gardenDance\" type=\"button\">♫ ცეკვა</button><button id=\"gardenSay\" type=\"button\">💬 საუბარი</button><button id=\"gardenSit\" type=\"button\">▰ დაჯდომა</button><button id=\"gardenPoseStop\" type=\"button\" hidden>■ შეჩერება</button></div><div id=\"gardenOptions\" hidden><label>რეტრო მოძრაობა<select id=\"gardenDanceMove\"></select></label><label class=\"garden-sync\"><input id=\"gardenDanceSync\" type=\"checkbox\"> ჯგუფთან სინქრონულად</label><div class=\"garden-private\"><select id=\"gardenWhisperTarget\" aria-label=\"პირადი საუბრის ადრესატი\"><option value=\"\">პირადი საუბარი · ახლოს მდგომი მოთამაშე</option></select><button id=\"gardenWhisper\" type=\"button\" disabled>ჩუმად</button></div><small>ცეკვას მოძრაობა აჩერებს · ქალაქის პერსონაჟები ნამდვილი მოთამაშეები არ არიან.</small></div>";
    document.querySelector(".city-world").append(wayfinder, panel);
    moves.forEach(([id, name]) => { const option = document.createElement("option"); option.value = id; option.textContent = name; document.getElementById("gardenDanceMove").appendChild(option); });
    const danceChoices=document.createElement('div');danceChoices.className='garden-dance-choices';danceChoices.setAttribute('aria-label','ცეკვის არჩევა');
    const danceNames={'running-man':'მორბენალი','cabbage-patch':'წრიული','electric-slide':'სრიალი','robot':'რობოტი'};
    moves.forEach(([id])=>{const b=document.createElement('button');b.type='button';b.textContent=danceNames[id]||id;b.dataset.move=id;b.setAttribute('aria-pressed','false');b.onclick=()=>{document.getElementById('gardenDanceMove').value=id;danceChoices.querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));command('city:garden:dance',{move:id,sync:document.getElementById('gardenDanceSync').checked});};danceChoices.append(b);});
    panel.querySelector('.garden-actions').after(danceChoices);document.getElementById('gardenDanceMove').parentElement.hidden=true;
    panel.querySelector('.garden-heading b').textContent='ნეონის ბაღი';document.getElementById('gardenDance').textContent='ცეკვა';
    document.getElementById("gardenDance").addEventListener("click", () => command("city:garden:dance", { move: document.getElementById("gardenDanceMove").value, sync: document.getElementById("gardenDanceSync").checked }));
    document.getElementById("gardenPoseStop").addEventListener("click", () => command(bridge.self()?.gardenSeatId ? "city:garden:stand" : "city:garden:stop"));
    document.getElementById("gardenSit").addEventListener("click", () => { const s = nearestSeat(); if (s) command("city:garden:sit", { seatId: s.id }); });
    document.getElementById("gardenSay").addEventListener("click", () => api.compose("city"));
    document.getElementById("gardenWhisper").addEventListener("click", () => { const id = document.getElementById("gardenWhisperTarget").value; if (id) api.compose("garden-whisper", id); });
    document.getElementById("gardenWhisperTarget").addEventListener("change", updateUi);
    document.getElementById("gardenExpand").addEventListener("click", event => { const options = document.getElementById("gardenOptions"); options.hidden = !options.hidden; event.currentTarget.setAttribute("aria-expanded", String(!options.hidden)); api.stop(); });
    socket.on("city:garden:state", setState);
    socket.on("city:garden:whisper", message => { api.whisper(message); });
    socket.on("disconnect", () => { panel.hidden = true; wayfinder.hidden = true; });
    setInterval(updateUi, 180);
  }
  root.GaicaniCityGarden = { drawTree:tree, drawStatic, drawDynamic, drawPerson, setState, mount, command, nearestSeat, getEpoch: () => state.epoch };
})(typeof window !== "undefined" ? window : globalThis);
