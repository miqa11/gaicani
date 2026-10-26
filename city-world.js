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
    { id: "neon-casino", x: 1575, y: 430, w: 150, h: 210, name: "ღამის კაზინო", sign: "CASINO 99", color: "#ff58d2", type: "casino", enterable: true },
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
    { id: "radio-bar", x: 1805, y: 115, w: 165, h: 195, name: "რადიო ბარი", sign: "RADIO BAR", color: "#ff62c9", type: "bar", enterable: true },
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
  const landmarks = [
    { id: "tv-tower", type: "tower", name: "Mtatsminda TV Tower · ანძა", sign: "ანძა", x: 2780, y: 255, interactX: 2780, interactY: 385, color: "#ff61d2" },
    { id: "mother-georgia", type: "mother", name: "ქართლის დედა", sign: "ქართლის დედა", x: 2744, y: 525, interactX: 2704, interactY: 640, color: "#d9dce8" },
    { id: "narikala", type: "fortress", name: "ნარიყალას ციხე", sign: "ნარიყალა", x: 2690, y: 745, interactX: 2715, interactY: 835, noteX: 2785, noteY: 915, color: "#ffc274" },
    { id: "funicular-west", type: "station", line: "tbilisi-cable", end: "west", name: "საბაგიროს სადგური", sign: "საბაგირო", x: 2463, y: 1090, interactX: 2463, interactY: 1090, color: "#ff525c" },
    { id: "funicular-east", type: "station", line: "tbilisi-cable", end: "east", name: "ნარიყალას საბაგირო", sign: "საბაგირო", x: 2700, y: 985, interactX: 2700, interactY: 985, color: "#ff525c" }
  ];
  const blockers = buildings.map(function (b) { return { x: b.x, y: b.y, w: b.w, h: b.h }; }).concat([
    { x: 2762, y: 343, w: 36, h: 22 },
    { x: 2727, y: 598, w: 34, h: 28 },
    { x: 2638, y: 732, w: 166, h: 26 }
  ]);
  const npcs = [
    { id: "tamar", name: "თამარი", role: "მუსიკოსი", x: 448, y: 760, color: "#d86cae", line: "ეს სიმღერა 1999-ში დაიწყო და ჯერ არ დამიმთავრებია." },
    { id: "dato", name: "დათო", role: "ტაქსის მძღოლი", x: 1025, y: 780, color: "#f09c42", line: "მეტეხამდე? ამ დროს ტაქსს ზღაპრებიც მოჰყავს." },
    { id: "nino", name: "ნინო", role: "მცხობელი", x: 690, y: 1195, color: "#e56b52", line: "ცხელი პური ღამის ყველა საიდუმლოს იცნობს." },
    { id: "gio", name: "გიო", role: "არკადის ჩემპიონი", x: 1850, y: 1175, color: "#4dc6a0", line: "ერთი ცდა უფასოა. მეორე — თუ მართლა მაგარი ხარ." },
    { id: "mystery", name: "უცნობი", role: "ღამის მგზავრი", x: 1460, y: 1580, color: "#8070ca", line: "ძველ ტელეფონს მოუსმინე. ზოგჯერ ქალაქი გირეკავს." },
    { id: "cat", kind: "cat", name: "ფისო", role: "ეზოს კატა", x: 2210, y: 1190, color: "#eaa657", line: "მიააუ. თუ გამომყვები, იქნებ რამე ვიპოვოთ." },
    { id: "maka", name: "მაკა", role: "ღამის ფოტოგრაფი", x: 840, y: 700, color: "#d95dba", wander: true, line: "წვიმის შემდეგ ნეონები ყველაზე ლამაზად ირეკლება." },
    { id: "levan", name: "ლევანი", role: "ტაქსის მძღოლი", x: 1300, y: 730, color: "#43a9cb", wander: true, line: "ღამე გრძელია, მაგრამ კარგი მუსიკა გზას ამოკლებს." },
    { id: "sandro", name: "სანდრო", role: "მუსიკის მოყვარული", x: 1960, y: 800, color: "#b77bf0", wander: true, line: "რადიო ბარისკენ მივდივარ — იქ დღეს კარგი ჩანაწერია." },
    { id: "ana", name: "ანა", role: "ღამის მცხობელი", x: 300, y: 1140, color: "#ec8462", wander: true, line: "ღამის ბოლოს პირველი პური უკვე მზად მექნება." },
    { id: "luka", name: "ლუკა", role: "მხატვარი", x: 1260, y: 1260, color: "#68bc90", wander: true, line: "ამ კედელზე ერთი პატარა ვარსკვლავი უნდა დავხატო." },
    { id: "salome", name: "სალომე", role: "მოცეკვავე", x: 1980, y: 1130, color: "#e7679b", wander: true, line: "ვინილის კლუბიდან მუსიკა მდინარემდე ისმის." },
    { id: "vato", name: "ვატო", role: "მეზობელი", x: 750, y: 1690, color: "#dfa750", wander: true, line: "ეზოში კატებს წყალი დავუტოვე. ამ სიცივეში სჭირდებათ." },
    { id: "tea", name: "თეა", role: "ჩაის გამყიდველი", x: 2280, y: 700, color: "#76cfbd", wander: true, line: "პიტნის ჩაი გაქვს გასინჯული შუაღამისას?" }
  ];
  const animals = [
    { id: "alley-cat", kind: "cat", x: 640, y: 710, color: "#d99761", phase: .4, roamX: 13, roamY: 5 },
    { id: "blue-cat", kind: "cat", x: 1490, y: 695, color: "#8e91b9", phase: 2.1, roamX: 10, roamY: 7 },
    { id: "bakery-dog", kind: "dog", x: 900, y: 1140, color: "#c58b5a", phase: 1.1, roamX: 16, roamY: 6 },
    { id: "river-dog", kind: "dog", x: 2180, y: 1150, color: "#a8795b", phase: 3.2, roamX: 12, roamY: 8 },
    { id: "courtyard-cat", kind: "cat", x: 700, y: 1260, color: "#e1bd79", phase: 4.5, roamX: 18, roamY: 5 },
    { id: "vinyl-dog", kind: "dog", x: 1850, y: 1260, color: "#7865ab", phase: 2.7, roamX: 15, roamY: 6 }
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
  const casino = {
    id: "neon-casino", width: 1000, height: 680, spawn: { x: 500, y: 615 },
    stations: [
      { id: "tbilisi", type: "slot", x: 145, y: 245, label: "Neon Tbilisi" },
      { id: "internet", type: "slot", x: 320, y: 245, label: "Retro Internet Café" },
      { id: "cat", type: "slot", x: 495, y: 245, label: "Lucky Cat" },
      { id: "express", type: "slot", x: 670, y: 245, label: "Midnight Express" },
      { id: "poker", type: "poker", x: 325, y: 495, label: "Poker" },
      { id: "blackjack", type: "blackjack", x: 610, y: 495, label: "Blackjack" },
      { id: "bar", type: "npc", x: 845, y: 475, label: "Dato the dealer" }
    ],
    blockers: [
      { x: 99, y: 128, w: 92, h: 102 }, { x: 274, y: 128, w: 92, h: 102 },
      { x: 449, y: 128, w: 92, h: 102 }, { x: 624, y: 128, w: 92, h: 102 },
      { x: 235, y: 366, w: 180, h: 105 }, { x: 520, y: 366, w: 180, h: 105 },
      { x: 758, y: 318, w: 178, h: 48 }
    ]
  };
  function casinoIsWalkable(x, y, radius) {
    const r = Number.isFinite(radius) ? radius : 11;
    if (x < 42 + r || y < 68 + r || x > casino.width - 42 - r || y > casino.height - 34 - r) return false;
    for (let i = 0; i < casino.blockers.length; i++) {
      const b = casino.blockers[i];
      if (x + r > b.x && x - r < b.x + b.w && y + r > b.y && y - r < b.y + b.h) return false;
    }
    return true;
  }
  function isWalkable(x, y, radius) {
    const r = Number.isFinite(radius) ? radius : 11;
    if (x < r || y < r || x > width - r || y > height - r) return false;
    if (x + r > 2510 && x - r < 2645 && !(y - r > 835 && y + r < 1125)) return false;
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
  return { width: width, height: height, tile: 48, districts: districts, buildings: buildings, landmarks: landmarks,
    blockers: blockers, npcs: npcs, animals: animals, props: props, spawns: spawns, casino: casino, casinoIsWalkable: casinoIsWalkable,
    isWalkable: isWalkable, districtAt: districtAt };
});
