/* Shared street vehicles. Positions and occupancy are owned by the city server. */
(function (root, factory) {
  const vehicles = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = vehicles;
  if (root) root.GaicaniCityVehicles = vehicles;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  const definitions = [
    { id: "lada-2106", name: "ჟიგული 2106", model: "LADA 2106", kind: "sedan", color: "#da7650", x: 610, y: 780, dir: "right", speed: 300, radius: 26 },
    { id: "night-taxi", name: "ღამის ტაქსი", model: "TBILISI TAXI", kind: "taxi", color: "#f3ce60", x: 980, y: 780, dir: "right", speed: 330, radius: 26 },
    { id: "marshrutka-7", name: "მარშრუტკა №7", model: "MARSHRUTKA 07", kind: "minibus", color: "#56b6b0", x: 1180, y: 1200, dir: "left", speed: 245, radius: 31 },
    { id: "neon-coupe", name: "ნეონის კუპე", model: "NEON COUPE '92", kind: "coupe", color: "#c970dc", x: 1840, y: 780, dir: "left", speed: 365, radius: 26 },
    { id: "blue-volga", name: "ლურჯი ვოლგა", model: "VOLGA 24", kind: "sedan", color: "#5d9fd2", x: 2075, y: 1200, dir: "right", speed: 315, radius: 27 },
    { id: "courtyard-lada", name: "ეზოს ჟიგული", model: "LADA 2101", kind: "sedan", color: "#a5be7a", x: 780, y: 1620, dir: "left", speed: 285, radius: 26 }
  ];
  function byId(id) { return definitions.find(v => v.id === id) || null; }
  function createFleet() { return definitions.map(v => Object.assign({}, v, { driverId: null })); }
  function footprint(vehicle, dir) {
    const bus = vehicle.kind === "minibus" || vehicle.radius >= 30;
    const halfLength = bus ? 36 : 28, halfWidth = bus ? 16 : 14;
    const vertical = (dir || vehicle.dir) === "up" || (dir || vehicle.dir) === "down";
    return { x:vertical ? halfWidth : halfLength, y:vertical ? halfLength : halfWidth, halfWidth };
  }
  function isDriveable(world, x, y, radius, otherVehicles, ignoreId, dir) {
    const r = Number.isFinite(radius) ? radius : 26;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !world.isWalkable(x, y, r)) return false;
    const fleet = otherVehicles || [], vehicle = fleet.find(v => v.id === ignoreId) || byId(ignoreId) || { radius:r, dir:"right" };
    const body = footprint(vehicle, dir);
    // Arcade steering permits changing lanes with WASD. Use body width for the road shoulder,
    // while the larger world radius keeps buildings and the river safely out of reach.
    const road = [360, 780, 1200, 1620].some(center => Math.abs(y - center) <= 52 - body.halfWidth) ||
      [540, 1080, 1620, 2160].some(center => Math.abs(x - center) <= 52 - body.halfWidth);
    return road && !fleet.some(v => {
      if (v.id === ignoreId) return false;
      const other = footprint(v);
      return Math.abs(v.x - x) < body.x + other.x + 2 && Math.abs(v.y - y) < body.y + other.y + 2;
    });
  }
  function move(world, vehicle, dx, dy, distance, otherVehicles) {
    let x = vehicle.x, y = vehicle.y;
    if (![x, y, dx, dy, distance].every(Number.isFinite) || distance <= 0) return { x, y };
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * distance / 2));
    const sx = dx * distance / steps, sy = dy * distance / steps;
    // Small collision steps let any frame timing reach the usable edge of a lane.
    // A rejected full frame could leave the car too far from the shoulder to pass another car.
    for (let i = 0; i < steps; i++) {
      if (sx && isDriveable(world, x + sx, y, vehicle.radius, otherVehicles, vehicle.id, vehicle.dir)) x += sx;
      if (sy && isDriveable(world, x, y + sy, vehicle.radius, otherVehicles, vehicle.id, vehicle.dir)) y += sy;
    }
    return { x, y };
  }
  function exitPoint(world, vehicle, others) {
    const distance = vehicle.radius + 20;
    const offsets = vehicle.dir === "up" || vehicle.dir === "down" ?
      [[distance, 0], [-distance, 0], [0, distance], [0, -distance]] :
      [[0, distance], [0, -distance], [distance, 0], [-distance, 0]];
    offsets.push([distance, distance], [-distance, distance], [distance, -distance], [-distance, -distance]);
    for (const offset of offsets) {
      const x = vehicle.x + offset[0], y = vehicle.y + offset[1];
      if (world.isWalkable(x, y, 11) && !(others || []).some(v => v.id !== vehicle.id && Math.hypot(v.x - x, v.y - y) < v.radius + 13)) return { x, y };
    }
    return null;
  }
  function createGarage(world) {
    const fleet = createFleet();
    function find(id) { return fleet.find(v => v.id === id) || null; }
    function list() { return fleet.map(v => Object.assign({}, v)); }
    function release(player, moveOutside) {
      const v = find(player && player.vehicleId);
      if (v && v.driverId === player.id) {
        if (moveOutside) {
          const at = exitPoint(world, v, fleet);
          if (!at) return { error: "მანქანის გვერდით ადგილი არ არის — ცოტა წინ წადი." };
          player.x = at.x; player.y = at.y;
        }
        v.driverId = null;
      }
      if (player) { player.vehicleId = null; player.inputX = player.inputY = 0; player.action = "idle"; player.actionUntil = 0; }
      return { ok: true };
    }
    function enter(player, id) {
      if (!player || player.interiorId || player.rideId || player.gameId || player.vehicleId) return { error: "მანქანაში ჩასაჯდომად ჯერ ქუჩაში დაბრუნდი." };
      const v = find(id);
      if (!v || Math.hypot(player.x - v.x, player.y - v.y) > 90) return { error: "მანქანასთან ახლოს მიდი." };
      if (v.driverId) return { error: "ამ მანქანას უკვე ჰყავს მძღოლი." };
      v.driverId = player.id; player.vehicleId = v.id; player.x = v.x; player.y = v.y; player.dir = v.dir;
      player.inputX = player.inputY = 0; player.action = "idle"; player.actionUntil = 0;
      return { ok: true };
    }
    function canMove(vehicle, x, y, dir) {
      return isDriveable(world, x, y, vehicle.radius, fleet, vehicle.id, dir);
    }
    function moveVehicle(vehicle, dx, dy, distance) { return move(world, vehicle, dx, dy, distance, fleet); }
    function sync(player) {
      const v = find(player.vehicleId);
      if (!v || v.driverId !== player.id) { player.vehicleId = null; return null; }
      v.x = player.x; v.y = player.y; v.dir = player.dir;
      return v;
    }
    return { find, list, enter, release, canMove, move:moveVehicle, sync };
  }
  return { definitions, byId, createFleet, isDriveable, move, exitPoint, createGarage };
});
