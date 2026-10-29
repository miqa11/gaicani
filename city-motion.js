/* Deterministic movement used for both prediction and authoritative input replay. */
(function (root, factory) {
  const vehicles = typeof module !== "undefined" && module.exports ? require("./city-vehicles.js") : root.GaicaniCityVehicles;
  const motion = factory(vehicles);
  if (typeof module !== "undefined" && module.exports) module.exports = motion;
  if (root) root.GaicaniCityMotion = motion;
})(typeof window !== "undefined" ? window : globalThis, function (vehicles) {
  "use strict";
  const WALK_SPEED = 165;
  const SPRINT_MULTIPLIER = 1.65, SPRINT_DRAIN = 24, JUMP_DURATION = 600, JUMP_COOLDOWN = 900, JUMP_COST = 12;
  const bounded = (value, min, max, fallback) => Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  function abilities(state) {
    return { stamina: bounded(state.stamina, 0, 100, 100), sprintLocked: state.sprintLocked === true,
      sprinting: false, jumpRemaining: bounded(state.jumpRemaining, 0, JUMP_DURATION, 0),
      jumpCooldown: bounded(state.jumpCooldown, 0, JUMP_COOLDOWN, 0), jumpHeld: state.jumpHeld === true,
      jumpSerial: Number.isSafeInteger(state.jumpSerial) && state.jumpSerial >= 0 ? state.jumpSerial : 0 };
  }

  function step(world, state, input, dt, fleet, people) {
    let x = state.x, y = state.y, dir = state.dir || "down";
    const ability = abilities(state);
    const result = () => ({ x, y, dir, ...ability, moving: Math.hypot(x - state.x, y - state.y) > .0001 });
    if (![x, y, dt].every(Number.isFinite) || dt <= 0 || dt > 50) return result();
    let dx = input && Number.isFinite(input.x) ? Math.max(-1, Math.min(1, input.x)) : 0;
    let dy = input && Number.isFinite(input.y) ? Math.max(-1, Math.min(1, input.y)) : 0;
    const length = Math.hypot(dx, dy);
    const seconds = dt / 1000, onFoot = !state.blocked && !state.vehicleId && state.mode !== "casino";
    const heldJump = input?.jump === true;
    ability.jumpRemaining = onFoot ? Math.max(0, ability.jumpRemaining - dt) : 0;
    ability.jumpCooldown = Math.max(0, ability.jumpCooldown - dt);
    if (onFoot && heldJump && !ability.jumpHeld && ability.jumpCooldown === 0 && ability.stamina >= JUMP_COST) {
      ability.jumpRemaining = JUMP_DURATION; ability.jumpCooldown = JUMP_COOLDOWN;
      ability.stamina -= JUMP_COST; ability.jumpSerial++;
    }
    ability.jumpHeld = heldJump;
    if (ability.stamina >= 25) ability.sprintLocked = false;
    const running = onFoot && length > .001 && input?.sprint === true && !ability.sprintLocked && ability.stamina > 0;
    let runSeconds = 0;
    if (running) {
      runSeconds = Math.min(seconds, ability.stamina / SPRINT_DRAIN);
      ability.stamina = Math.max(0, ability.stamina - SPRINT_DRAIN * runSeconds);
      ability.sprinting = runSeconds > 0;
      if (ability.stamina < .000001) { ability.stamina = 0; ability.sprintLocked = true; }
    } else ability.stamina = Math.min(100, ability.stamina + (length > .001 && onFoot ? 12 : 18) * seconds);
    if (state.blocked) return result();
    if (length > 1) { dx /= length; dy /= length; }
    const nextDir = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "left" : "right") : (dy < 0 ? "up" : "down");
    const car = state.mode !== "casino" && vehicles.byId(state.vehicleId);
    if (car) {
      if (state.vehicleSeat > 0) return result();
      const condition=(fleet||[]).find(v=>v.id===car.id)?.condition;
      const efficiency=condition?Math.max(.85,Math.min(1,.85+.15*(condition.tires+condition.engine)/200)):1;
      const at = vehicles.drive(world, {...car,speed:car.speed*efficiency,x,y,dir,angle:state.vehicleAngle,velocity:state.vehicleSpeed||0}, {x:dx,y:dy},dt,fleet,people);
      return {x:at.x,y:at.y,dir:at.dir,...ability,moving:at.moving,vehicleAngle:at.angle,vehicleSpeed:at.velocity};
    }
    if (length <= .001) return result();
    dir = nextDir;
    const walkable = state.mode === "casino" ? world.casinoIsWalkable : world.isWalkable;
    const distance = WALK_SPEED * (seconds + runSeconds * (SPRINT_MULTIPLIER - 1));
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * distance / 2));
    const sx = dx * distance / steps, sy = dy * distance / steps;
    for (let i = 0; i < steps; i++) {
      const clear = (nx,ny) => state.mode === "casino" || !(fleet||[]).some(v => vehicles.contains(v,nx,ny,11) &&
        (!vehicles.contains(v,x,y,11) || Math.hypot(nx-v.x,ny-v.y)<Math.hypot(x-v.x,y-v.y)));
      if (sx && walkable(x + sx, y, 11) && clear(x+sx,y)) x += sx;
      if (sy && walkable(x, y + sy, 11) && clear(x,y+sy)) y += sy;
    }
    return result();
  }

  return { WALK_SPEED, SPRINT_MULTIPLIER, SPRINT_DRAIN, JUMP_DURATION, JUMP_COOLDOWN, JUMP_COST, abilities, step };
});
