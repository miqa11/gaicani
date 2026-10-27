"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const world = require("../city-world.js"), vehicles = require("../city-vehicles.js");
const motion = require("../city-motion.js"), prediction = require("../city-prediction.js");
const fleet = vehicles.createFleet();
const origin = { epoch: 1, seq: 0, mode: "world", x: 525, y: 760, dir: "down" };
function create() { const p = prediction.create(world, () => fleet); p.accept(origin); return p; }
function near(a, b) { assert.ok(Math.abs(a - b) < 1e-8, a + " != " + b); }

test("delayed confirmations replay the remaining walk without moving the stopping point", () => {
  const p = create(); let server = { ...origin }, seq = 0;
  for (let i = 0; i < 60; i++) p.predict({ x: 1, y: 0 }, 16);
  p.predict({ x: 0, y: 0 }, 1);
  const stopped = { ...p.getState() }, batches = [];
  for (let batch; (batch = p.drain()); ) batches.push(batch);
  for (const batch of batches) {
    for (const input of batch.commands) { Object.assign(server, motion.step(world, server, input, input.dt, fleet)); seq = input.seq; }
    p.accept({ ...server, epoch: 1, seq, action: "idle" });
    near(p.getState().x, stopped.x); near(p.getState().y, stopped.y);
    assert.equal(p.getState().dir, "right");
  }
  assert.equal(p.pendingCount(), 0);
  assert.equal(p.getState().action, "idle");
});

test("old and duplicate snapshots cannot rewind a new direction or a stop", () => {
  const p = create(); p.predict({ x: 1, y: 0 }, 30);
  const batch = p.drain(), at = motion.step(world, origin, batch.commands[0], 30, fleet);
  p.accept({ ...at, epoch: 1, seq: 1 });
  p.predict({ x: 0, y: 1 }, 30); p.predict({ x: 0, y: 0 }, 1);
  const final = { ...p.getState() };
  assert.equal(p.accept(origin), false);
  assert.equal(p.accept({ ...at, epoch: 1, seq: 1 }), false);
  assert.deepEqual(p.getState(), final);
});

test("teleports and entering a different scene discard old commands", () => {
  const p = create(); p.predict({ x: 1, y: 0 }, 50);
  p.accept({ epoch: 2, seq: 0, mode: "casino", x: 500, y: 615, dir: "up" });
  assert.equal(p.pendingCount(), 0); assert.equal(p.drain(), null);
  near(p.getState().x, 500); near(p.getState().y, 615);
  assert.equal(p.accept({ ...origin, seq: 1 }), false);
  assert.equal(p.predict({ x: 0, y: -1 }, 16).dir, "up");
  assert.equal(p.drain().commands[0].seq, 1);
});

test("stationary clients send no commands until an input is predicted", () => {
  const p = create(); assert.equal(p.drain(), null);
  p.predict({ x: 0, y: 0 }, 1);
  near(p.getState().x, origin.x); near(p.getState().y, origin.y);
  assert.equal(p.drain().commands[0].seq, 1);
  p.clear(); assert.equal(p.getState(), null); assert.equal(p.drain(), null);
});
