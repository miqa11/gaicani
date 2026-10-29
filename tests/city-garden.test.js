"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const world = require("../city-world.js"), vehicles = require("../city-vehicles.js");
const { createCityGarden } = require("../server-city-garden.js");
const { createCityMotionController } = require("../server-city-motion.js");

function setup() {
  const players = new Map(), garden = createCityGarden({ world, players, epoch: 123456 });
  const a = { id: "a", name: "A", x: 1300, y: 2400, dir: "down", action: "idle", actionUntil: 0 };
  const b = { id: "b", name: "B", x: 1340, y: 2420, dir: "down", action: "idle", actionUntil: 0 };
  players.set(a.id, a); players.set(b.id, b);
  return { players, garden, a, b };
}

test("only the Casino and functional Arcade remain enterable; Casino layout is untouched", () => {
  assert.deepEqual(world.buildings.filter(b => b.enterable).map(b => b.id).sort(), ["arcade-palace", "neon-casino"]);
  const baseline = execFileSync("git", ["show", "HEAD:city-world.js"], { cwd: __dirname + "/..", encoding: "utf8" });
  const context = { module: { exports: {} } }; vm.runInNewContext(baseline, context);
  const geometry = value => JSON.parse(JSON.stringify(value, (key, item) => key === "label" ? undefined : item));
  assert.deepEqual(geometry(world.casino), geometry(context.module.exports.casino));
  assert.equal(world.buildings.length, context.module.exports.buildings.length);
});

test("the huge garden has an open city gate, solid fences, clear floor, and reachable public areas", () => {
  assert.equal(world.height, 3420);
  for (const y of [1790, 1840, 1870, 1960, 2020]) assert.ok(world.isWalkable(1400, y, 11), "north path y" + y);
  assert.equal(world.isWalkable(800, 1845, 11), false);
  assert.equal(world.isWalkable(125, 2700, 11), false);
  assert.equal(world.isWalkable(1400, 3270, 11), false);
  for (let x = 1060; x < 1700; x += 80) for (let y = 2290; y < 2760; y += 80) assert.ok(world.isWalkable(x, y, 11));
  for (const seat of world.garden.seats) assert.ok(world.isWalkable(seat.x, seat.y, 11), seat.id);
  assert.ok(world.gardenContains(1400, 2500));
  assert.ok(world.gardenDanceFloorContains(1400, 2500));
  assert.equal(world.gardenContains(1400, 1750), false);
  assert.equal(vehicles.isDriveable(world, 1620, 1900, 26, [], "lada-2106", "down"), true);
  assert.ok(world.garden.npcs.length >= 10);
  assert.ok(world.garden.npcs.every(npc => npc.name.includes("ქალაქის პერსონაჟი")));
});

test("four real dance moves loop, share a group clock, and reject unavailable players", () => {
  const { garden, a, b } = setup();
  for (const move of ["running-man", "cabbage-patch", "electric-slide", "robot"]) {
    assert.ok(garden.dance(a, { move, sync: true }, 1000000).ok);
    assert.ok(garden.dance(b, { move, sync: true }, 1005000).ok);
    assert.equal(a.gardenDance.startedAt, b.gardenDance.startedAt);
    assert.equal(a.gardenDance.startedAt, 123456);
    garden.maintain(a); assert.equal(a.gardenDance.move, move);
  }
  assert.ok(garden.dance(a, { move: "missing" }).error);
  b.x = 500; b.y = 2500;
  assert.ok(garden.dance(b, { move: "robot" }).error);
  a.vehicleId = "lada-2106";
  assert.ok(garden.dance(a, { move: "robot" }).error);
  garden.maintain(a); assert.equal(a.gardenDance, null);
});

test("seats are exclusive, safe to leave, and freed on disconnect or activity changes", () => {
  const { garden, a, b } = setup(), seat = world.garden.seats[0];
  Object.assign(a, { x: seat.x, y: seat.y + 35 }); Object.assign(b, { x: seat.x + 20, y: seat.y + 35 });
  assert.ok(garden.sit(a, seat.id).ok); assert.equal(a.gardenSeatId, seat.id);
  assert.ok(garden.sit(b, seat.id).error);
  assert.equal(garden.publicState().seats.find(s => s.id === seat.id).occupantId, "a");
  assert.ok(garden.stand(a).ok); assert.ok(world.isWalkable(a.x, a.y, 11));
  assert.ok(garden.sit(b, seat.id).ok); garden.remove(b);
  assert.equal(garden.publicState().seats.find(s => s.id === seat.id).occupantId, null);
  assert.ok(garden.sit(a, seat.id).ok); a.gameId = "game"; a.action = "phone"; garden.maintain(a);
  assert.equal(a.gardenSeatId, null); assert.equal(a.action, "phone");
});

test("movement cancels dancing and standing resets prediction from a safe position", () => {
  const { garden, a } = setup(), garage = vehicles.createGarage(world), motion = createCityMotionController(world, garage);
  let view = motion.view(a, 0);
  motion.process(a, { epoch: view.epoch, commands: [{ seq: 1, x: 0, y: 0, dt: 1 }] }, 10);
  garden.dance(a, { move: "running-man", sync: false }, 20);
  motion.maintain(a, 5000); assert.equal(a.action, "dance");
  garden.beforeMove(a, { commands: [{ seq: 2, x: 1, y: 0, dt: 16 }] });
  assert.equal(a.gardenDance, null);
  const seat = world.garden.seats[0]; Object.assign(a, { x: seat.x, y: seat.y + 35 });
  assert.ok(garden.sit(a, seat.id).ok); view = motion.view(a, 5010); assert.equal(view.blocked, true);
  assert.equal(view.gardenSeatId, seat.id); assert.equal(view.gardenSeatKind, "stool");
  motion.maintain(a, 6000); assert.equal(a.action, "sit");
  garden.beforeMove(a, { commands: [{ seq: 1, x: 1, y: 0, dt: 16 }] });
  assert.equal(a.gardenSeatId, null); assert.ok(world.isWalkable(a.x, a.y, 11));
  const stand = motion.view(a, 6020); assert.ok(stand.epoch > view.epoch); assert.equal(stand.blocked, false);
  assert.equal(stand.gardenSeatId, null); assert.equal(stand.gardenDance, null);
});

test("whispers are restricted to nearby real players and preserve moderation/cooldowns", () => {
  const { players, garden, a, b } = setup();
  const sent = garden.whisper(a, { targetId: b.id, text: "Hello garden" }, 10000);
  assert.ok(sent.ok); assert.equal(sent.message.targetId, b.id); assert.equal(sent.message.fromId, a.id);
  assert.ok(garden.whisper(a, { targetId: b.id, text: "again" }, 10001).error);
  b.x += 400; assert.ok(garden.whisper(a, { targetId: b.id, text: "far" }, 12000).error);
  b.x = a.x + 30;
  const moderated = createCityGarden({ world, players, blockedText: text => text.includes("blocked") });
  assert.ok(moderated.whisper(a, { targetId: b.id, text: "blocked" }, 13000).error);
  assert.ok(moderated.whisper(a, { targetId: "garden-dj", text: "NPC" }, 14000).error);
});
