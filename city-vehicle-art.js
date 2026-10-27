/* Small, canvas-native sprites for the shared night-city fleet. */
(function (root) {
  "use strict";
  function rect(g, color, x, y, w, h) { g.fillStyle = color; g.fillRect(x, y, w, h); }
  function draw(g, vehicle, now, options) {
    const o = options || {}, van = vehicle.kind === "minibus" || vehicle.kind === "van";
    const length = van ? 72 : 56, width = van ? 32 : 28;
    const angle = Number.isFinite(vehicle.angle)?vehicle.angle:({ right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 }[vehicle.dir] || 0);
    const x = Math.round(o.x === undefined ? vehicle.x : o.x), y = Math.round(o.y === undefined ? vehicle.y : o.y);
    g.save(); g.translate(x, y);
    g.fillStyle = "#05071399"; g.beginPath(); g.ellipse(2, 9, length * .58, width * .68, 0, 0, Math.PI * 2); g.fill();
    g.rotate(angle);
    const l = length / 2, w = width / 2;
    // Headlight cones and their broken reflections on wet asphalt.
    g.fillStyle = vehicle.driverId ? "#fff1b61c" : "#ffe4a009";
    [-w + 6, w - 6].forEach(yy => {
      g.beginPath(); g.moveTo(l - 1, yy - 2); g.lineTo(l + 75, yy - 21); g.lineTo(l + 75, yy + 21); g.lineTo(l - 1, yy + 2); g.fill();
    });
    rect(g, "#030610", -l - 3, -w - 2, length + 6, width + 5);
    [-l + 9, l - 15].forEach(xx => { rect(g, "#080c17", xx, -w - 4, 11, 5); rect(g, "#080c17", xx, w - 1, 11, 5); rect(g, "#78788b", xx + 3, -w - 3, 5, 1); });
    rect(g, vehicle.color, -l, -w, length, width);
    rect(g, "#ffffff30", -l + 3, -w + 1, length - 6, 2);
    rect(g, "#00000042", -l + 2, w - 4, length - 4, 4);
    rect(g, "#18273a", -l + (van ? 10 : 12), -w + 3, length - (van ? 24 : 28), width - 6);
    rect(g, "#77bfd1", l - 19, -w + 4, 8, width - 8);
    rect(g, "#b4f3e0", l - 18, -w + 5, 2, width - 12);
    rect(g, "#33475f", -l + 8, -w + 5, van ? 8 : 6, width - 10);
    rect(g, vehicle.color, -l + (van ? 22 : 20), -w + 3, van ? 23 : 12, width - 6);
    rect(g, "#ffffff22", -l + (van ? 23 : 21), -w + 4, van ? 21 : 10, 2);
    if (van) {
      rect(g, "#c7dedf", -l + 23, -4, 20, 8);
      rect(g, "#31445c", -l + 25, -2, 16, 4);
      for (let i = 0; i < 3; i++) rect(g, "#20374d", -l + 8 + i * 12, -w + 1, 8, 2);
    }
    if (vehicle.kind === "taxi" || /taxi/i.test(vehicle.id)) {
      rect(g, "#202133", -4, -7, 12, 14); rect(g, "#ffe48b", -3, -6, 10, 12);
      rect(g, "#272336", -1, -4, 2, 3); rect(g, "#272336", 3, 1, 2, 3);
      for (let i = 0; i < 5; i++) rect(g, i % 2 ? "#161b2b" : "#f7db88", -l + 13 + i * 4, w - 3, 4, 2);
    }
    rect(g, "#d5c0ae", -l - 1, -w + 4, 2, width - 8); rect(g, "#a6b5be", l - 1, -w + 3, 2, width - 6);
    [-w + 4, w - 7].forEach(yy => {
      rect(g, "#fff0b2", l - 2, yy, 3, 4); rect(g, "#ff657b", -l - 1, yy, 2, 4);
    });
    rect(g, "#f7e9c9", -l - 2, -3, 2, 6);
    rect(g, "#a2bed0", l - 13, -w - 3, 4, 3); rect(g, "#a2bed0", l - 13, w, 4, 3);
    const transition=vehicle.transition,progress=transition?(Date.now()-transition.at)/transition.duration:2;
    if(progress>=0&&progress<1){rect(g,vehicle.color,-9,-w-10,17,3);rect(g,'#a6e6e5',-7,-w-9,13,2);}
    (vehicle.seats||[]).forEach(seat=>{if(!seat.playerId||(transition?.playerId===seat.playerId&&progress<1))return;rect(g,'#121a2e',seat.x-5,seat.y-5,10,10);rect(g,seat.color||'#a9e3f5',seat.x-4,seat.y,8,4);rect(g,'#efbd98',seat.x-3,seat.y-4,6,5);rect(g,'#342138',seat.x-3,seat.y-5,6,2);});
    g.restore();
    if(progress>=0&&progress<1){const px=transition.from.x+(transition.to.x-transition.from.x)*progress,py=transition.from.y+(transition.to.y-transition.from.y)*progress;rect(g,'#efbd98',px-4,py-16,8,8);rect(g,transition.color||'#b78bec',px-6,py-8,12,12);rect(g,'#242237',px-5,py+4,4,7);rect(g,'#242237',px+1,py+4,4,7);}
    if (o.available || o.self) {
      g.save(); g.textAlign = "center"; g.textBaseline = "middle";
      g.font = '700 9px "Noto Sans Georgian", sans-serif';
      const occupants=(vehicle.seats||[]).filter(s=>s.playerId);
      const text = (o.self?vehicle.model:'F · Get In') + ' · ' + (occupants.length?occupants.map(s=>s.name).join(', '):vehicle.model);
      const tw = Math.min(220, g.measureText(text).width + 16), yy = y - (vehicle.dir === "up" || vehicle.dir === "down" ? length / 2 + 14 : width / 2 + 16);
      rect(g, "#080d20eb", x - tw / 2, yy - 10, tw, 20);
      g.strokeStyle = o.self ? "#76f1dd" : "#ffd58b"; g.lineWidth = 1; g.strokeRect(x - tw / 2, yy - 10, tw, 20);
      g.fillStyle = o.self ? "#a6fff1" : "#ffdda3"; g.fillText(text, x, yy, tw - 10); g.restore();
    }
  }
  root.GaicaniCityVehicleArt = { draw: draw };
})(typeof window !== "undefined" ? window : globalThis);
