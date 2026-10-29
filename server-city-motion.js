"use strict";
const motion = require("./city-motion.js");

/* Inputs describe elapsed simulation time, so releasing a key never leaves a held
   velocity running while a stop packet travels across the network. */
function createCityMotionController(world, garage) {
  const states = new WeakMap();
  const MAX_BUDGET = 250, INITIAL_BUDGET = 100;

  function context(player) {
    const mode = player.interiorId === "neon-casino" ? "casino" : "world";
    return {
      mode,
      x: mode === "casino" ? player.casinoX : player.x,
      y: mode === "casino" ? player.casinoY : player.y,
      key: [player.interiorId || "", player.rideId || "", player.gameId || "", player.vehicleId || "", player.vehicleSeat ?? "", player.gardenSeatId || "", player.activityLocked ? player.activityLockId || "activity" : ""].join("|"),
      blocked: !!(player.activityLocked || player.rideId || player.gameId || player.gardenSeatId || player.vehicleSeat > 0 || garage.canDrive?.(player)===false || (player.interiorId && mode !== "casino"))
    };
  }
  function ensure(player, now) {
    const at = Number.isFinite(now) ? now : Date.now(), current = context(player);
    if (current.blocked || current.mode === "casino" || player.vehicleId) { player.jumpRemaining = 0; player.sprinting = false; }
    let state = states.get(player);
    if (!state) {
      state = { epoch: 1, seq: 0, active: false, budget: INITIAL_BUDGET, at, lastCommandAt: at, ...current };
      states.set(player, state);
    } else if (state.key !== current.key || Math.abs(state.x - current.x) > .0001 || Math.abs(state.y - current.y) > .0001) {
      // Entrances, rides and teleports are new prediction origins. Old packets
      // must never replay movement from the previous scene or vehicle.
      Object.assign(state, current, { epoch: state.epoch + 1, seq: 0, budget: INITIAL_BUDGET, at, lastCommandAt: at });
    } else Object.assign(state, current);
    return state;
  }
  function view(player, now) {
    const state = ensure(player, now);
    return { epoch: state.epoch, seq: state.seq, mode: state.mode, x: state.x, y: state.y,
      ...motion.abilities(player), sprinting: player.sprinting === true,
      dir: player.dir || "down", action: player.action || "idle", vehicleId: player.vehicleId || null, blocked: state.blocked,
      vehicleSeat:player.vehicleSeat??null,vehicleAngle:player.vehicleAngle,vehicleSpeed:player.vehicleSpeed||0,
      gardenDance: player.gardenDance || null, gardenSeatId: player.gardenSeatId || null, gardenSeatKind: player.gardenSeatKind || null };
  }
  function active(player) { return !!states.get(player)?.active; }
  function maintain(player, now) {
    const state = ensure(player, now);
    if (now - state.lastCommandAt > 500) {
      // Background tabs stop submitting frames. Let their animation end and
      // their stamina recover without advancing their position at all.
      const elapsed = Math.max(0, now - Math.max(state.lastCommandAt, state.idleAbilityAt || state.lastCommandAt));
      const ability = motion.abilities(player);
      ability.stamina = Math.min(100, ability.stamina + elapsed * .018);
      ability.jumpRemaining = Math.max(0, ability.jumpRemaining - elapsed);
      ability.jumpCooldown = Math.max(0, ability.jumpCooldown - elapsed);
      ability.jumpHeld = false;
      if (ability.stamina >= 25) ability.sprintLocked = false;
      Object.assign(player, ability); state.idleAbilityAt = now;
    }
    if (state.active && !(player.actionUntil > now)) {
      if(player.vehicleId && now - state.lastCommandAt > 500) garage.brake(player);
      if (player.gardenSeatId) player.action = "sit";
      else if (player.gardenDance) player.action = "dance";
      else if (!state.blocked && now - state.lastCommandAt > 500) player.action = "idle";
    }
    return state.active;
  }
  function process(player, payload, now) {
    const at = Number.isFinite(now) ? now : Date.now(), state = ensure(player, at);
    const reply = extra => Object.assign(view(player, at), extra);
    if (!payload || payload.epoch !== state.epoch) return reply({ reset: true });
    if (!Array.isArray(payload.commands) || payload.commands.length < 1 || payload.commands.length > 32) return reply({ error: "გადაადგილების არასწორი მონაცემები" });
    for (const command of payload.commands) {
      if (!command || !Number.isSafeInteger(command.seq) || command.seq < 1 ||
          !Number.isFinite(command.x) || !Number.isFinite(command.y) || !Number.isFinite(command.dt) || command.dt <= 0 || command.dt > 50 ||
          (command.sprint !== undefined && typeof command.sprint !== "boolean") || (command.jump !== undefined && typeof command.jump !== "boolean")) {
        return reply({ error: "გადაადგილების არასწორი ბრძანება" });
      }
    }
    state.active = true;
    // A small jitter allowance absorbs normal delivery bursts without granting
    // clients an unbounded clock or accepting movement at a faster speed.
    state.budget = Math.min(MAX_BUDGET, state.budget + Math.max(0, at - state.at));
    state.at = at;
    player.inputX = player.inputY = player.casinoInputX = player.casinoInputY = 0;
    for (const command of payload.commands) {
      if (command.seq <= state.seq) continue;
      if (command.seq !== state.seq + 1) {
        Object.assign(state, { epoch: state.epoch + 1, seq: 0, budget: INITIAL_BUDGET });
        return reply({ reset: true });
      }
      const elapsed = Math.min(command.dt, state.budget);
      state.budget -= elapsed;
      const next = motion.step(world, { ...motion.abilities(player), x: state.x, y: state.y, dir: player.dir,
        vehicleId: player.vehicleId, vehicleSeat:player.vehicleSeat, vehicleAngle:player.vehicleAngle, vehicleSpeed:player.vehicleSpeed||0, mode: state.mode, blocked: state.blocked }, command, elapsed, garage.list(), garage.obstacles?.());
      if (state.mode === "casino") { player.casinoX = next.x; player.casinoY = next.y; }
      else { player.x = next.x; player.y = next.y; }
      state.x = next.x; state.y = next.y; state.seq = command.seq;
      player.dir = next.dir;
      if (next.jumpSerial > (player.jumpSerial || 0)) player.gardenDance = null;
      Object.assign(player, motion.abilities(next), {sprinting:next.sprinting === true});
      if(Number.isFinite(next.vehicleAngle))player.vehicleAngle=next.vehicleAngle;
      if(Number.isFinite(next.vehicleSpeed))player.vehicleSpeed=next.vehicleSpeed;
      state.lastCommandAt = at;
      if (!state.blocked && !(player.actionUntil > at)) player.action = next.moving ? (player.vehicleId ? "drive" : next.sprinting ? "run" : "walk") : player.gardenDance ? "dance" : "idle";
      if (player.vehicleId) garage.sync(player);
    }
    return reply();
  }
  return { view, active, maintain, process };
}

module.exports = { createCityMotionController };
