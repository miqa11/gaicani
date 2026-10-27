"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const world = require("../city-world.js"), vehicles = require("../city-vehicles.js"), motion = require("../city-motion.js");
const { createCityMotionController } = require("../server-city-motion.js");
const makePlayer = () => ({ id: "walker", x: 525, y: 760, dir: "down", action: "idle", actionUntil: 0 });
const command = (seq, x, y, dt = 16) => ({ seq, x, y, dt });
function setup() {
  const garage = vehicles.createGarage(world), controller = createCityMotionController(world, garage), player = makePlayer();
  const initial = controller.view(player, 0);
  return { garage, controller, player, epoch: initial.epoch };
}

test("prediction and authority replay identical inputs, then remain exactly stopped", () => {
  const { garage, controller, player, epoch } = setup();
  let prediction = { x: player.x, y: player.y, dir: player.dir, mode: "world" };
  const commands = [command(1, 1, 0), command(2, 1, 0), command(3, .6, .8), command(4, 0, 0, 1)];
  for (const input of commands) prediction = { ...prediction, ...motion.step(world, prediction, input, input.dt, garage.list()) };
  const ack = controller.process(player, { epoch, commands }, 200);
  assert.equal(ack.seq, 4);
  assert.equal(ack.x, prediction.x); assert.equal(ack.y, prediction.y); assert.equal(ack.dir, prediction.dir);
  assert.equal(player.action, "idle");
  controller.maintain(player, 5000);
  assert.equal(player.x, prediction.x); assert.equal(player.y, prediction.y);
});

test("duplicate packets do not apply movement twice and older epochs cannot move players", () => {
  const { controller, player, epoch } = setup();
  const payload = { epoch, commands: [command(1, 1, 0, 40)] };
  const first = controller.process(player, payload, 40);
  const duplicate = controller.process(player, payload, 80);
  assert.equal(duplicate.seq, 1); assert.equal(duplicate.x, first.x);
  player.x = 1000; player.y = 780;
  const reset = controller.view(player, 90);
  assert.equal(reset.epoch, epoch + 1); assert.equal(reset.seq, 0);
  const stale = controller.process(player, { epoch, commands: [command(2, 1, 0)] }, 100);
  assert.equal(stale.reset, true); assert.equal(player.x, 1000);
});

test("future sequence gaps reset the origin instead of replaying missing inputs", () => {
  const { controller, player, epoch } = setup();
  const ack = controller.process(player, { epoch, commands: [command(2, 1, 0)] }, 20);
  assert.equal(ack.reset, true); assert.equal(ack.epoch, epoch + 1); assert.equal(player.x, 525);
});

test("a teleport before the first input still creates a fresh prediction origin", () => {
  const { controller, player, epoch } = setup();
  player.x = 1000; player.y = 780;
  const teleported = controller.view(player, 20);
  assert.equal(teleported.epoch, epoch + 1); assert.equal(teleported.seq, 0);
  assert.equal(teleported.x, 1000);
});

test("the server limits elapsed movement to wall-clock time plus a small jitter budget", () => {
  const { controller, player, epoch } = setup();
  const batch = offset => ({ epoch, commands: Array.from({ length: 32 }, (_, i) => command(i + offset + 1, 1, 0, 50)) });
  controller.process(player, batch(0), 0);
  controller.process(player, batch(32), 0);
  assert.ok(Math.abs(player.x - (525 + motion.WALK_SPEED * .1)) < .00001);
  controller.process(player, { epoch, commands: [command(65, 1, 0, 50)] }, 50);
  assert.ok(Math.abs(player.x - (525 + motion.WALK_SPEED * .15)) < .00001);
});

test("malformed and oversized commands are rejected without moving or activating a player", () => {
  for (const commands of [[], Array(33).fill(command(1, 1, 0)), [command(1, NaN, 0)], [command(1, 1, 0, 500)], [command(1, 1, 0, -1)]]) {
    const { controller, player, epoch } = setup();
    const ack = controller.process(player, { epoch, commands }, 50);
    assert.ok(ack.error); assert.equal(player.x, 525); assert.equal(controller.active(player), false);
  }
});

test("diagonal walking has the same speed, collides with walls, and preserves facing at rest", () => {
  const initial = { x: 525, y: 760, dir: "up", mode: "world" };
  const diagonal = motion.step(world, initial, { x: 1, y: 1 }, 50, []);
  assert.ok(Math.abs(Math.hypot(diagonal.x - initial.x, diagonal.y - initial.y) - motion.WALK_SPEED * .05) < .00001);
  const stopped = motion.step(world, diagonal, { x: 0, y: 0 }, 50, []);
  assert.equal(stopped.dir, diagonal.dir); assert.equal(stopped.x, diagonal.x); assert.equal(stopped.moving, false);
  let besideWall = { x: 250, y: 700, dir: "right", mode: "world" };
  for (let i = 0; i < 20; i++) besideWall = { ...besideWall, ...motion.step(world, besideWall, { x: 1, y: -1 }, 50, []) };
  assert.ok(world.isWalkable(besideWall.x, besideWall.y, 11));
});

test("casino, vehicle and activity transitions get new epochs and cannot replay old movement", () => {
  const { controller, player, garage, epoch } = setup();
  controller.process(player, { epoch, commands: [command(1, 1, 0)] }, 16);
  player.interiorId = "neon-casino"; player.casinoX = 500; player.casinoY = 615;
  const casino = controller.view(player, 20);
  assert.equal(casino.epoch, epoch + 1); assert.equal(casino.mode, "casino"); assert.equal(casino.x, 500);
  const moved = controller.process(player, { epoch: casino.epoch, commands: [command(1, 1, 0, 50)] }, 70);
  assert.ok(moved.x > 500); assert.ok(Math.abs(player.x - (525 + motion.WALK_SPEED * .016)) < .00001);
  player.interiorId = null; player.x = 610; player.y = 780;
  assert.ok(garage.enter(player, "lada-2106").ok);
  const car = controller.view(player, 80);
  assert.equal(car.vehicleId, "lada-2106"); assert.equal(car.mode, "world");
  const drive = controller.process(player, { epoch: car.epoch, commands: [command(1, 1, 0, 50)] }, 130);
  assert.ok(Math.abs(drive.x - 625) < .00001);
  player.gameId = "game"; player.action = "phone";
  const blocked = controller.view(player, 140);
  assert.equal(blocked.blocked, true);
  controller.process(player, { epoch: blocked.epoch, commands: [command(1, 1, 0, 50)] }, 190);
  assert.equal(player.x, drive.x);
  controller.maintain(player, 5000);
  assert.equal(player.action, "phone");
});
