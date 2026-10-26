/* Shared public layout: rendered in the browser and used by the server for movement validation. */
(function (root, factory) {
  const world = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = world;
  if (root) root.GaicaniCityWorld = world;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  const width = 2880, height = 1980;
  const districts = [
    { id: "rustaveli", name: "რუსთაველის გამზირი", en: "RUSTAVELI AVENUE", x: 420, y: 440, color: "#ff4fc9" },
    { id: "old-town", name: "ძველი თბილისი", en: "OLD TBILISI", x: 1220, y: 420, color: "#ffc66b" },
    { id: "arcade", name: "არკადების უბანი", en: "ARCADE DISTRICT", x: 2070, y: 420, color: "#70f5ff" },
    { id: "underground", name: "მიწისქვეშა გადასასვლელი", en: "UNDERGROUND", x: 1420, y: 1110, color: "#b689ff" },
    { id: "bakery", name: "24/7 საცხობი", en: "OPEN ALL NIGHT", x: 680, y: 1510, color: "#ffae55" },
    { id: "riverside", name: "მტკვრის სანაპირო", en: "RIVERSIDE", x: 2290, y: 1480, color: "#68e8ff" }
  ];
  const buildings = [
    { id: "cinema", x: 115, y: 120, w: 300, h: 190, name: "კინოთეატრი თბილისი", sign: "კინო", color: "#e440b5", type: "cinema" },
    { id: "cafe-balcony", x: 635, y: 115, w: 270, h: 195, name: "კაფე აივანი", sign: "აივანი", color: "#50d8ff", type: "cafe" },
    { id: "courtyard", x: 1030, y: 105, w: 330, h: 210, name: "ძველი ეზო", sign: "ეზო", color: "#ffb25d", type: "courtyard" },
    { id: "photo-shop", x: 1510, y: 100, w: 280, h: 210, name: "ფოტოსალონი", sign: "ფოტო", color: "#fc5fc8", type: "shop" },
    { id: "arcade", x: 1990, y: 110, w: 360, h: 205, name: "პიქსელების არკადა", sign: "ARKADA", color: "#62f4ff", type: "arcade", enterable: true },
    { id: "radio", x: 255, y: 455, w: 245, h: 195, name: "რადიო 99.9", sign: "FM 99.9", color: "#ffb84f", type: "radio" },
    { id: "balcony-house", x: 760, y: 440, w: 280, h: 205, name: "მეზობლების სახლი", sign: "სახლი", color: "#d175ff", type: "house" },
    { id: "marani", x: 1260, y: 430, w: 305, h: 210, name: "მარანი", sign: "მარანი", color: "#ff6457", type: "cafe", enterable: true },
    { id: "internet-cafe", x: 1740, y: 435, w: 320, h: 205, name: "ინტერნეტ კაფე 1999", sign: "INTERNET", color: "#66ddff", type: "internet", enterable: true },
    { id: "cassette-shop", x: 2205, y: 425, w: 220, h: 210, name: "კასეტების მაღაზია", sign: "კასეტა", color: "#e84fa5", type: "shop" },
    { id: "bakery", x: 265, y: 875, w: 340, h: 205, name: "ღამის საცხობი", sign: "ცხელი პური", color: "#ffb34e", type: "bakery", enterable: true },
    { id: "flowers", x: 735, y: 890, w: 300, h: 185, name: "ყვავილების კიოსკი", sign: "ყვავილები", color: "#ff67bd", type: "shop" },
    { id: "passage", x: 1150, y: 875, w: 375, h: 220, name: "მიწისქვეშა გადასასვლელი", sign: "ქვემოთ ↓", color: "#9d74ff", type: "passage", enterable: true },
    { id: "game-room", x: 1645, y: 875, w: 315, h: 205, name: "სათამაშო ოთახი", sign: "GAME ROOM", color: "#74fcff", type: "arcade", enterable: true },
    { id: "tea-room", x: 2040, y: 890, w: 320, h: 190, name: "ჩაის ოთახი", sign: "ჩაი", color: "#ff9e64", type: "cafe" },
    { id: "yard-five", x: 110, y: 1315, w: 300, h: 210, name: "ეზო N5", sign: "ეზო №5", color: "#ce75ff", type: "courtyard" },
    { id: "all-night-shop", x: 585, y: 1310, w: 340, h: 205, name: "24 საათი", sign: "24/7", color: "#ffe260", type: "shop" },
    { id: "rooftop", x: 1100, y: 1315, w: 345, h: 205, name: "სახურავის კიბე", sign: "სახურავი ↑", color: "#ff61c7", type: "house", enterable: true },
    { id: "vinyl-club", x: 1590, y: 1325, w: 300, h: 195, name: "ვინილის კლუბი", sign: "VINYL", color: "#66e2ff", type: "music" },
    { id: "river-cafe", x: 2035, y: 1320, w: 300, h: 195, name: "სანაპიროს კაფე", sign: "მტკვარი", color: "#64ddff", type: "cafe" },
    { id: "blue-hour-apartments", x: 430, y: 120, w: 180, h: 190, name: "ლურჯი საათის სახლი", sign: "ლურჯი საათი", color: "#7588ff", type: "apartment" },
    { id: "radio-bar", x: 1805, y: 115, w: 165, h: 195, name: "რადიო ბარი", sign: "FM 99", color: "#ff62c9", type: "music" },
    { id: "late-shop", x: 2360, y: 120, w: 125, h: 190, name: "ღამის პატარა მაღაზია", sign: "24/7", color: "#ffe36b", type: "shop" },
    { id: "bookshop", x: 505, y: 445, w: 230, h: 195, name: "ძველი წიგნების მაღაზია", sign: "წიგნები", color: "#e9a764", type: "shop" },
    { id: "repair-shop", x: 1060, y: 445, w: 185, h: 195, name: "საათების სახელოსნო", sign: "შეკეთება", color: "#59cfe3", type: "shop" },
    { id: "old-bank", x: 2070, y: 445, w: 120, h: 195, name: "ძველი ბანკი", sign: "ბანკი", color: "#d58bff", type: "house" },
    { id: "record-booth", x: 610, y: 895, w: 110, h: 170, name: "კასეტების ჯიხური", sign: "კასეტა", color: "#ff70c8", type: "music" },
    { id: "flower-flat", x: 2375, y: 900, w: 120, h: 175, name: "ყვავილების კუთხე", sign: "ყვავილი", color: "#ff87c5", type: "shop" },
    { id: "courtyard-eight", x: 425, y: 1325, w: 140, h: 180, name: "ეზო №8", sign: "ეზო №8", color: "#c382ff", type: "courtyard" },
    { id: "night-tailor", x: 945, y: 1325, w: 140, h: 180, name: "ღამის ატელიე", sign: "ატელიე", color: "#76e4ef", type: "shop" },
    { id: "river-stairs", x: 2375, y: 1325, w: 125, h: 180, name: "სანაპიროს კიბე", sign: "მტკვარი", color: "#64ddff", type: "passage" }
  ];
  const blockers = buildings.map(function (b) { return { x: b.x, y: b.y, w: b.w, h: b.h }; });
  const npcs = [
    { id: "tamar", name: "თამარი", role: "მუსიკოსი", x: 448, y: 760, color: "#d86cae", line: "ეს სიმღერა 1999-ში დაიწყო და ჯერ არ დამიმთავრებია." },
    { id: "dato", name: "დათო", role: "ტაქსის მძღოლი", x: 1025, y: 780, color: "#f09c42", line: "მეტეხამდე? ამ დროს ტაქსს ზღაპრებიც მოჰყავს." },
    { id: "nino", name: "ნინო", role: "მცხობელი", x: 690, y: 1195, color: "#e56b52", line: "ცხელი პური ღამის ყველა საიდუმლოს იცნობს." },
    { id: "gio", name: "გიო", role: "არკადის ჩემპიონი", x: 1850, y: 1175, color: "#4dc6a0", line: "ერთი ცდა უფასოა. მეორე — თუ მართლა მაგარი ხარ." },
    { id: "mystery", name: "უცნობი", role: "ღამის მგზავრი", x: 1460, y: 1580, color: "#8070ca", line: "ძველ ტელეფონს მოუსმინე. ზოგჯერ ქალაქი გირეკავს." },
    { id: "cat", name: "ფისო", role: "ეზოს კატა", x: 2210, y: 1190, color: "#eaa657", line: "მიააუ. თუ გამომყვები, იქნებ რამე ვიპოვოთ." }
  ];
  const props = [
    { id: "phone", kind: "phone", x: 1518, y: 765, label: "ძველი ტელეფონი", line: "ტელეფონი რეკავს... ხაზზე მხოლოდ მდინარის ხმაა." },
    { id: "jukebox", kind: "jukebox", x: 1980, y: 760, label: "ჯუკბოქსი", line: "ჯუკბოქსმა 1999 წლის ყველაზე საიდუმლო სიმღერა ჩართო." },
    { id: "bench", kind: "bench", x: 2380, y: 1210, label: "სანაპიროს სკამი", line: "აქ ქალაქის ხმაური შორიდან ზღვის ხმას ჰგავს." },
    { id: "poster", kind: "poster", x: 1080, y: 1185, label: "ძველი აფიშა", line: "აფიშაზე წერია: «შეხვედრა იქ, სადაც ნეონი ციმციმებს»." },
    { id: "cat-food", kind: "cat", x: 2240, y: 1165, label: "ფისო", line: "ფისო კუდს აქიცინებს და ახლომდებარე ჩიხისკენ გარბის." }
  ];
  const spawns = [
    { x: 525, y: 760 }, { x: 950, y: 790 }, { x: 1190, y: 785 }, { x: 1620, y: 790 },
    { x: 2075, y: 790 }, { x: 2360, y: 1140 }, { x: 925, y: 1195 }, { x: 1980, y: 1195 }
  ];
  function isWalkable(x, y, radius) {
    const r = Number.isFinite(radius) ? radius : 11;
    if (x < r || y < r || x > width - r || y > height - r) return false;
    if (x + r > 2510 && !(y - r > 835 && y + r < 1125)) return false;
    for (let i = 0; i < blockers.length; i++) {
      const b = blockers[i];
      if (x + r > b.x && x - r < b.x + b.w && y + r > b.y && y - r < b.y + b.h) return false;
    }
    return true;
  }
  function districtAt(x, y) {
    let best = districts[0], bestD = Infinity;
    for (let i = 0; i < districts.length; i++) {
      const d = districts[i], dx = d.x - x, dy = d.y - y, n = dx * dx + dy * dy;
      if (n < bestD) { best = d; bestD = n; }
    }
    return best;
  }
  return { width: width, height: height, tile: 48, districts: districts, buildings: buildings,
    blockers: blockers, npcs: npcs, props: props, spawns: spawns, isWalkable: isWalkable, districtAt: districtAt };
});
