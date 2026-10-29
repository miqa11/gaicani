"use strict";

function createCityGarden({ world, players, epoch = Date.now(), cleanText, blockedText }) {
  const occupied = new Map();
  const moves = new Set(["running-man", "cabbage-patch", "electric-slide", "robot"]);
  const clean = cleanText || (text => String(text || "").trim().slice(0, 120));
  const isAvailable = player => !!(player && !player.interiorId && !player.rideId && !player.gameId && !player.vehicleId && world.gardenContains(player.x, player.y));
  const seatFor = id => world.garden.seats.find(seat => seat.id === id);
  function publicState() {
    return { epoch, seats: world.garden.seats.map(seat => ({ id: seat.id, occupantId: occupied.get(seat.id) || null })) };
  }
  function clearDance(player) {
    player.gardenDance = null;
    if (player.action === "dance") { player.action = "idle"; player.actionUntil = 0; }
  }
  function stand(player, moveOutside = true) {
    if (!player) return { error: "ქალაქში ჯერ არ ხარ." };
    const seat = seatFor(player.gardenSeatId);
    if (seat && occupied.get(seat.id) === player.id) {
      if (moveOutside) {
        const offsets = seat.dir === "up" ? [[0, 38], [38, 0], [-38, 0], [0, -38]] : [[0, -38], [38, 0], [-38, 0], [0, 38]];
        const at = offsets.map(([dx, dy]) => ({ x: seat.x + dx, y: seat.y + dy })).find(at =>
          world.isWalkable(at.x, at.y, 11) && !world.garden.seats.some(other => other.id !== seat.id && occupied.has(other.id) && Math.hypot(other.x - at.x, other.y - at.y) < 25));
        if (!at) return { error: "გვერდით ადგილი არ არის — კიდევ სცადე." };
        player.x = at.x; player.y = at.y;
      }
      occupied.delete(seat.id);
    }
    player.gardenSeatId = null; player.gardenSeatKind = null;
    player.inputX = player.inputY = player.casinoInputX = player.casinoInputY = 0;
    if (player.action === "sit") { player.action = "idle"; player.actionUntil = 0; }
    return { ok: true };
  }
  function stop(player) {
    if (!player) return { error: "ქალაქში ჯერ არ ხარ." };
    clearDance(player);
    return player.gardenSeatId ? stand(player) : { ok: true };
  }
  function dance(player, data, now = Date.now()) {
    if (!isAvailable(player)) return { error: "საცეკვაოდ ნეონის ბაღში ფეხით მოდი." };
    if (!world.gardenDanceFloorContains(player.x, player.y)) return { error: "შუაში, საცეკვაო მოედანზე დადექი." };
    if (!data || !moves.has(data.move)) return { error: "აირჩიე ცეკვის მოძრაობა." };
    if (player.gardenSeatId) { const result = stand(player); if (result.error) return result; }
    player.gardenDance = { move: data.move, startedAt: data.sync === true ? epoch : now, sync: data.sync === true };
    player.action = "dance"; player.actionUntil = 0; player.inputX = player.inputY = 0;
    return { ok: true };
  }
  function sit(player, seatId) {
    if (!isAvailable(player)) return { error: "დასაჯდომად ბაღში ფეხით მოდი." };
    const seat = seatFor(seatId);
    if (!seat || Math.hypot(player.x - seat.x, player.y - seat.y) > 85) return { error: "სკამთან ახლოს მიდი." };
    if (occupied.has(seat.id) && occupied.get(seat.id) !== player.id) return { error: "ეს ადგილი უკვე დაკავებულია." };
    if (player.gardenSeatId && player.gardenSeatId !== seat.id) {
      const previous = seatFor(player.gardenSeatId);
      if (previous && occupied.get(previous.id) === player.id) occupied.delete(previous.id);
    }
    clearDance(player); occupied.set(seat.id, player.id);
    player.gardenSeatId = seat.id; player.gardenSeatKind = seat.kind;
    player.x = seat.x; player.y = seat.y; player.dir = seat.dir;
    player.inputX = player.inputY = 0; player.action = "sit"; player.actionUntil = 0;
    return { ok: true };
  }
  function beforeMove(player, payload) {
    if (!player) return;
    const commands = Array.isArray(payload?.commands) ? payload.commands : [payload];
    const moving = commands.some(command => command && Number.isFinite(command.x) && Number.isFinite(command.y) && Math.hypot(command.x, command.y) > .001);
    if (!moving) return;
    clearDance(player);
    if (player.gardenSeatId) stand(player);
  }
  function remove(player) {
    if (!player) return;
    clearDance(player); stand(player, false);
  }
  function maintain(player) {
    if (!player) return;
    if (!isAvailable(player)) { if (player.gardenDance || player.gardenSeatId) remove(player); return; }
    if (player.gardenDance && !world.gardenDanceFloorContains(player.x, player.y)) clearDance(player);
    if (player.gardenSeatId && occupied.get(player.gardenSeatId) !== player.id) stand(player, false);
  }
  function whisper(player, data, now = Date.now()) {
    const target = players.get(data && data.targetId);
    if (!isAvailable(player) || !isAvailable(target) || target.id === player.id || Math.hypot(player.x - target.x, player.y - target.y) > 120) return { error: "პირადი საუბრისთვის ბაღში მოთამაშესთან ახლოს მიდი." };
    const text = clean(data && data.text);
    if (!text || (blockedText && blockedText(text))) return { error: "შეტყობინება ცარიელია ან მიუღებელ ტექსტს შეიცავს." };
    if (player.lastGardenWhisperAt && now - player.lastGardenWhisperAt < 1000) return { error: "ერთი წამი მოიცადე." };
    player.lastGardenWhisperAt = now;
    return { ok: true, message: { fromId: player.id, targetId: target.id, name: player.name, text, at: now } };
  }
  return { publicState, isAvailable, dance, sit, stand, stop, beforeMove, maintain, remove, whisper };
}

module.exports = { createCityGarden };
