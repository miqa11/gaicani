"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const world = require("../city-world.js");
const vehicles = require("../city-vehicles.js");

test("all six vehicles start on accessible streets with safe exits", () => {
  const fleet = vehicles.createFleet();
  assert.equal(fleet.length, 6);
  for (const car of fleet) {
    assert.ok(vehicles.isDriveable(world, car.x, car.y, car.radius, fleet, car.id, car.dir), car.id);
    const exit = vehicles.exitPoint(world, car, fleet);
    assert.ok(exit && world.isWalkable(exit.x, exit.y, 11), car.id);
  }
});

test("entry requires proximity and an available vehicle; release frees it", () => {
  const garage = vehicles.createGarage(world);
  const driver = { id: "driver", x: 525, y: 760 };
  const other = { id: "other", x: 600, y: 730 };
  const distant = { id: "distant", x: 100, y: 100 };
  assert.ok(garage.enter(distant, "lada-2106").error);
  assert.ok(garage.enter(driver, "missing").error);
  assert.ok(garage.enter(driver, "lada-2106").ok);
  assert.ok(garage.enter(other, "lada-2106").error);
  assert.equal(driver.vehicleId, "lada-2106");
  assert.ok(garage.release(driver, true).ok);
  assert.equal(driver.vehicleId, null);
  assert.ok(world.isWalkable(driver.x, driver.y, 11));
  assert.ok(garage.enter(other, "lada-2106").ok);
  assert.ok(garage.release(other, false).ok);
  assert.equal(garage.find("lada-2106").driverId, null);
});

test("players in interiors, cable cars, or games cannot reserve vehicles", () => {
  for (const state of [{ interiorId: "arcade" }, { rideId: "cable" }, { gameId: "game" }]) {
    const garage = vehicles.createGarage(world);
    assert.ok(garage.enter({ id: "busy", x: 610, y: 780, ...state }, "lada-2106").error);
    assert.equal(garage.find("lada-2106").driverId, null);
  }
});

test("a driver can pass the parked taxi at different tick offsets", () => {
  for (const offset of [0, 1.8, 4.2, 7.3]) {
    const fleet = vehicles.createFleet(), car = fleet.find(v => v.id === "lada-2106");
    car.y -= offset; car.dir = "up";
    for (let tick = 0; tick < 12; tick++) Object.assign(car, vehicles.move(world, car, 0, -1, 12, fleet));
    assert.ok(car.y <= 750, "must reach the passing lane from offset " + offset);
    car.dir = "right";
    for (let tick = 0; tick < 40; tick++) Object.assign(car, vehicles.move(world, car, 1, 0, 12, fleet));
    assert.ok(car.x > 1050, "must pass taxi at x980 from offset " + offset);
    assert.ok(vehicles.isDriveable(world, car.x, car.y, car.radius, fleet, car.id, car.dir));
  }
});

test("cars stop before parked traffic and stay off buildings and the river", () => {
  const fleet = vehicles.createFleet(), car = fleet.find(v => v.id === "lada-2106");
  for (let tick = 0; tick < 60; tick++) Object.assign(car, vehicles.move(world, car, 1, 0, 12, fleet));
  assert.ok(car.x < 925, "must stop before the taxi at x980");
  assert.equal(vehicles.isDriveable(world, 800, 500, car.radius, fleet, car.id, "right"), false);
  assert.equal(vehicles.isDriveable(world, 2570, 780, car.radius, fleet, car.id, "right"), false);
  assert.equal(vehicles.isDriveable(world, 610, 700, car.radius, fleet, car.id, "right"), false);
  // Rotating beside the taxi must account for the car's longer vertical body.
  assert.equal(vehicles.isDriveable(world, 980, 744, car.radius, fleet, car.id, "right"), true);
  assert.equal(vehicles.isDriveable(world, 980, 744, car.radius, fleet, car.id, "up"), false);
});
