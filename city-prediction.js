/* Replay only inputs the server has not confirmed. An old snapshot cannot pull
   a stopped character back to where it was earlier in the walk. */
(function (root, factory) {
  const motion = typeof module !== "undefined" && module.exports ? require("./city-motion.js") : root.GaicaniCityMotion;
  const api = factory(motion);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.GaicaniCityPrediction = api;
})(typeof window !== "undefined" ? window : globalThis, function (motion) {
  "use strict";
  function create(world, getFleet) {
    let epoch = null, sequence = 0, confirmed = -1, state = null, pending = [], unsent = [];
    function clear() { epoch = null; sequence = 0; confirmed = -1; state = null; pending = []; unsent = []; }
    function accept(view) {
      if (!view || !Number.isSafeInteger(view.epoch) || !Number.isSafeInteger(view.seq) ||
          !Number.isFinite(view.x) || !Number.isFinite(view.y)) return false;
      if (epoch !== null && (view.epoch < epoch || (view.epoch === epoch && view.seq <= confirmed))) return false;
      const reset = epoch !== view.epoch;
      if (reset) { pending = []; unsent = []; sequence = view.seq; }
      epoch = view.epoch; confirmed = view.seq; sequence = Math.max(sequence, confirmed);
      pending = pending.filter(input => input.seq > confirmed);
      unsent = unsent.filter(input => input.seq > confirmed);
      state = { x: view.x, y: view.y, dir: view.dir || "down", mode: view.mode || "world",
        vehicleId: view.vehicleId || null, blocked: !!view.blocked, moving: false, action: view.action || "idle" };
      const fleet = getFleet();
      for (const input of pending) {
        Object.assign(state, motion.step(world, state, input, input.dt, fleet));
        state.action = state.moving ? (state.vehicleId ? "drive" : "walk") : "idle";
      }
      return true;
    }
    function predict(input, elapsed) {
      if (!state || pending.length >= 240) return null;
      const command = { seq: ++sequence, x: input.x, y: input.y, dt: Math.max(1, Math.min(50, elapsed)) };
      Object.assign(state, motion.step(world, state, command, command.dt, getFleet()));
      state.action = state.moving ? (state.vehicleId ? "drive" : "walk") : "idle";
      pending.push(command); unsent.push(command);
      return state;
    }
    function drain() { return unsent.length ? { epoch, commands: unsent.splice(0, 32) } : null; }
    return { accept, predict, drain, clear, getState: () => state, getEpoch: () => epoch,
      pendingCount: () => pending.length, queuedCount: () => unsent.length };
  }
  return { create };
});
