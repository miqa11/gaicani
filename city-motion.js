/* Deterministic movement used for both prediction and authoritative input replay. */
(function (root, factory) {
  const vehicles = typeof module !== "undefined" && module.exports ? require("./city-vehicles.js") : root.GaicaniCityVehicles;
  const motion = factory(vehicles);
  if (typeof module !== "undefined" && module.exports) module.exports = motion;
  if (root) root.GaicaniCityMotion = motion;
})(typeof window !== "undefined" ? window : globalThis, function (vehicles) {
  "use strict";
  const WALK_SPEED = 165;

  function step(world, state, input, dt, fleet) {
    let x = state.x, y = state.y, dir = state.dir || "down";
    const result = () => ({ x, y, dir, moving: Math.hypot(x - state.x, y - state.y) > .0001 });
    if (![x, y, dt].every(Number.isFinite) || dt <= 0 || dt > 50) return result();
    let dx = input && Number.isFinite(input.x) ? Math.max(-1, Math.min(1, input.x)) : 0;
    let dy = input && Number.isFinite(input.y) ? Math.max(-1, Math.min(1, input.y)) : 0;
    const length = Math.hypot(dx, dy);
    if (length <= .001 || state.blocked) return result();
    if (length > 1) { dx /= length; dy /= length; }
    const nextDir = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "left" : "right") : (dy < 0 ? "up" : "down");
    const car = state.mode !== "casino" && vehicles.byId(state.vehicleId);
    if (car) {
      if (nextDir !== dir && !vehicles.isDriveable(world, x, y, car.radius, fleet, car.id, nextDir)) return result();
      dir = nextDir;
      const at = vehicles.move(world, Object.assign({}, car, { x, y, dir }), dx, dy, car.speed * dt / 1000, fleet);
      x = at.x; y = at.y;
      return result();
    }
    dir = nextDir;
    const walkable = state.mode === "casino" ? world.casinoIsWalkable : world.isWalkable;
    const distance = WALK_SPEED * dt / 1000;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * distance / 2));
    const sx = dx * distance / steps, sy = dy * distance / steps;
    for (let i = 0; i < steps; i++) {
      if (sx && walkable(x + sx, y, 11)) x += sx;
      if (sy && walkable(x, y + sy, 11)) y += sy;
    }
    return result();
  }

  return { WALK_SPEED, step };
});
