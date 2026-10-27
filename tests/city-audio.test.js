"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { model } = require("../city-audio.js");
test("sound and music default ON, while saved disabled/zero preferences survive", () => {
  assert.equal(model.normalizePreferences().music, true);
  assert.equal(model.normalizePreferences().effects, true);
  assert.deepEqual(model.normalizePreferences({ music:false,effects:false,muted:true,musicVolume:0,effectsVolume:0 }),
    { music:false,effects:false,muted:true,musicVolume:0,effectsVolume:0 });
  assert.equal(model.normalizePreferences({musicVolume:12,effectsVolume:-4}).musicVolume, 1);
  assert.equal(model.normalizePreferences({musicVolume:12,effectsVolume:-4}).effectsVolume, 0);
});
test("garden speakers get louder nearby and become silent outside or indoors", () => {
  const near = model.spatial({x:1380,y:2180,inGarden:true});
  const far = model.spatial({x:300,y:3100,inGarden:true});
  assert.ok(near.gain > far.gain * 2);
  assert.equal(model.spatial({x:1380,y:2180,inGarden:false}).gain, 0);
  assert.equal(model.spatial({x:1380,y:2180,inGarden:true,interior:true}).gain, 0);
  assert.ok(model.spatial({x:700,y:2200,inGarden:true}).pan > 0);
  assert.ok(model.spatial({x:2100,y:2200,inGarden:true}).pan < 0);
});
test("continuous playlist advances across tracks and wraps without a movement reset", () => {
  const tracks = model.originalTracks;
  assert.equal(tracks.length, 3);
  assert.ok(tracks.every(t => t.kind === "original" && t.bars === 32 && t.duration > 60));
  const first = model.transport(1000, 6000, tracks), later = model.transport(1000, 9000, tracks);
  assert.equal(first.index, 0); assert.ok(Math.abs(later.position-first.position-3)<1e-8);
  const next = model.transport(1000, 1000 + (tracks[0].duration + .5) * 1000, tracks);
  assert.equal(next.index, 1); assert.ok(Math.abs(next.position-.5)<1e-8);
  const total = tracks.reduce((n,t)=>n+t.duration,0);
  const wrapped = model.transport(1000,1000+(total+2)*1000,tracks);
  assert.equal(wrapped.index,0); assert.ok(Math.abs(wrapped.position-2)<1e-8);
});
test("authorized audio config requires rights metadata and rejects platform URLs", () => {
  const track = {kind:"audio",url:"/audio/license.ogg",title:"Authorized",credit:"Rights holder",license:"Game permission",duration:180,bpm:96};
  assert.equal(model.validateTracks([track])[0].url,track.url);
  for (const change of [{license:""},{credit:""},{url:"https://youtube.com/watch?v=x"},{url:"https://open.spotify.com/track/x"},{duration:0},{bpm:0}])
    assert.throws(()=>model.validateTracks([{...track,...change}]));
});
test("overlapping lookahead and rapid gesture ticks schedule each musical step once", () => {
  const ledger = model.createScheduleLedger();
  assert.equal(ledger.claim("club:64", 1000, 1000), true);
  assert.equal(ledger.claim("club:65", 1121, 1000), true);
  // A later forced tick revisits the current step after the future one was
  // already scheduled. Remembering just the last step would duplicate both.
  for (let i = 0; i < 50; i++) {
    assert.equal(ledger.claim("club:64", 1000, 1004), false);
    assert.equal(ledger.claim("club:65", 1121, 1004), false);
  }
  assert.equal(ledger.size(), 2);
  for (let i = 1; i <= 2000; i++) ledger.claim("club:" + (65+i), 1121+i*121, 1121+i*121);
  assert.ok(ledger.size() < 12, "old steps should be pruned during a long session");
  ledger.clear(); assert.equal(ledger.size(),0);
  assert.equal(ledger.claim("club:64", 1000, 1000), true);
});
