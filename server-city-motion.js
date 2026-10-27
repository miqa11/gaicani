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
      key: [player.interiorId || "", player.rideId || "", player.gameId || "", player.vehicleId || ""].join("|"),
      blocked: !!(player.rideId || player.gameId || (player.interiorId && mode !== "casino"))
    };
  }
  function ensure(player, now) {
    const at = Number.isFinite(now) ? now : Date.now(), current = context(player);
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
      dir: player.dir || "down", action: player.action || "idle", vehicleId: player.vehicleId || null, blocked: state.blocked };
  }
  function active(player) { return !!states.get(player)?.active; }
  function maintain(player, now) {
    const state = ensure(player, now);
    if (state.active && !state.blocked && now - state.lastCommandAt > 500 && !(player.actionUntil > now)) player.action = "idle";
    return state.active;
  }
  function process(player, payload, now) {
    const at = Number.isFinite(now) ? now : Date.now(), state = ensure(player, at);
    const reply = extra => Object.assign(view(player, at), extra);
    if (!payload || payload.epoch !== state.epoch) return reply({ reset: true });
    if (!Array.isArray(payload.commands) || payload.commands.length < 1 || payload.commands.length > 32) return reply({ error: "Invalid movement batch" });
    for (const command of payload.commands) {
      if (!command || !Number.isSafeInteger(command.seq) || command.seq < 1 ||
          !Number.isFinite(command.x) || !Number.isFinite(command.y) || !Number.isFinite(command.dt) || command.dt <= 0 || command.dt > 50) {
        return reply({ error: "Invalid movement command" });
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
      const next = motion.step(world, { x: state.x, y: state.y, dir: player.dir,
        vehicleId: player.vehicleId, mode: state.mode, blocked: state.blocked }, command, elapsed, garage.list());
      if (state.mode === "casino") { player.casinoX = next.x; player.casinoY = next.y; }
      else { player.x = next.x; player.y = next.y; }
      state.x = next.x; state.y = next.y; state.seq = command.seq;
      player.dir = next.dir;
      state.lastCommandAt = at;
      if (!state.blocked && !(player.actionUntil > at)) player.action = next.moving ? (player.vehicleId ? "drive" : "walk") : "idle";
      if (player.vehicleId) garage.sync(player);
    }
    return reply();
  }
  return { view, active, maintain, process };
}

module.exports = { createCityMotionController };
