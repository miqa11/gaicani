"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {createCityActivities}=require("../server-city-activities");
function setup(registered=true){let time=100000,seq=0,saves=0;const p={id:"p",userKey:registered?"tester":"",x:100,y:100},players=new Map([[p.id,p]]),user={coins:1000},registeredUsers=new Map(registered?[["tester",user]]:[]);
 const catalog={activities:[{id:"practice",kind:"practice",location:{x:100,y:100},description:"Practice",reward:50,lock:true,cooldownMs:5000},{id:"future",kind:"not-built",location:{x:100,y:100}}],items:[{id:"badge"}]};
 const engine=createCityActivities({world:{},players,registeredUsers,catalog,now:()=>time,saveAuthUsers:()=>saves++,changeCoins:(u,k,n)=>{assert.equal(k,"tester");u.coins+=n;}});
 engine.register("practice",{start(ctx){ctx.active.challenge={at:ctx.now+2000};},act(ctx,packet){if(packet.verb!=="hit"||ctx.now<ctx.active.challenge.at)return {error:"Too early"};ctx.addItem("badge");ctx.finish();return {ok:true};}});
 const send=(packet)=>engine.command(p,{requestId:"r"+(++seq),...packet});const begin=()=>send({action:"start",activityId:"practice"});const hit=()=>send({action:"act",token:engine.state(p).active.token,verb:"hit"});
 return {p,user,players,registeredUsers,engine,send,begin,hit,advance:n=>time+=n,saves:()=>saves};}
test("core discovers only installed handlers and validates place, state and activity IDs",()=>{
 const f=setup();assert.deepEqual(f.engine.state(f.p).capabilities,["practice"]);assert.ok(f.send({action:"start",activityId:"future"}).error);
 f.p.x=500;assert.ok(f.begin().error);f.p.x=100;f.p.vehicleId="lada";assert.ok(f.begin().error);f.p.vehicleId=null;
 assert.ok(f.begin().ok);assert.equal(f.p.activityLocked,true);assert.ok(f.begin().error);assert.ok(f.send({action:"complete",token:f.engine.state(f.p).active.token,score:99999}).error);assert.equal(f.user.coins,1000);
});
test("completion requires authoritative mechanic timing; duplicate requests never grant twice",()=>{
 const f=setup();f.begin();assert.ok(f.hit().error);f.advance(2000);const token=f.engine.state(f.p).active.token;
 const packet={requestId:"final",action:"act",token,verb:"hit"};assert.ok(f.send(packet).ok);assert.equal(f.user.coins,1050);assert.equal(f.p.activityLocked,false);
 const duplicate=f.send(packet);assert.equal(duplicate.duplicate,true);assert.equal(f.user.coins,1050);assert.equal(f.engine.profile(f.p).inventory.badge,1);
 assert.ok(f.send({...packet,verb:"hack"}).error);assert.ok(f.hit().error);assert.ok(f.begin().error);
});
test("guests play and collect in-session items without receiving persistent coins",()=>{
 const f=setup(false);f.begin();f.advance(2200);assert.ok(f.hit().ok);assert.equal(f.engine.state(f.p).profile.coins,null);assert.equal(f.engine.profile(f.p).inventory.badge,1);assert.equal(f.saves(),0);
 f.engine.remove(f.p);assert.deepEqual(f.engine.profile(f.p).inventory,{});
});
test("guest records in the existing account map never receive persistent activity rewards",()=>{
 const f=setup();f.user.isGuest=true;f.begin();f.advance(2200);f.hit();assert.equal(f.user.coins,1000);assert.equal(f.user.cityActivities,undefined);assert.equal(f.saves(),0);assert.equal(f.engine.state(f.p).profile.registered,false);
});
test("malformed mechanic payloads cannot crash the command handler or leave movement locked",()=>{
 const f=setup();f.engine.register("practice",{act(){throw Error("malformed payload");}});f.begin();const r=f.hit();assert.ok(r.error);assert.equal(f.p.activityLocked,false);assert.equal(f.user.coins,1000);
});
test("daily reward cap survives reconnects and clears only on the next Georgia day",()=>{
 const f=setup();f.engine.profile(f.p).earned.coins=590;f.begin();f.advance(2200);f.hit();assert.equal(f.user.coins,1010);
 f.engine.remove(f.p);assert.equal(f.engine.profile(f.p).earned.coins,600);f.advance(6000);f.begin();f.advance(2200);f.hit();assert.equal(f.user.coins,1010);
 f.advance(86400000);assert.equal(f.engine.profile(f.p).earned.coins,0);assert.equal(f.engine.profile(f.p).inventory.badge,2);
});
test("disconnect, timeout, scene changes and teleport jumps release locks with no reward",()=>{
 for(const mode of ["disconnect","timeout","scene","teleport"]){const f=setup();f.begin();if(mode==="disconnect")f.engine.remove(f.p);else {f.advance(mode==="timeout"?200000:50);if(mode==="scene")f.p.interiorId="casino";if(mode==="teleport")f.p.x=2000;f.engine.tick();}assert.equal(f.p.activityLocked,false,mode);assert.equal(f.user.coins,1000,mode);}
});
test("requests are bounded and tokens cannot cancel another attempt",()=>{
 const f=setup();f.begin();assert.ok(f.send({action:"cancel",token:"forged"}).error);assert.equal(f.engine.state(f.p).active.status,"active");
 for(let i=0;i<14;i++)f.send({action:"track",activityId:"practice"});assert.ok(f.send({action:"track",activityId:"practice"}).error);
 f.advance(1001);assert.ok(f.send({action:"cancel",token:f.engine.state(f.p).active.token}).ok);assert.equal(f.p.activityLocked,false);
});
test("actions recheck transport, scene, expiry and movement before the next scheduled tick",()=>{
 for(const mode of ["vehicle","scene","expiry","teleport"]){const f=setup();f.begin();f.advance(2200);f.engine.tick();
  if(mode==="vehicle")f.p.vehicleId="car";if(mode==="scene")f.p.interiorId="arcade-palace";if(mode==="expiry")f.advance(200000);if(mode==="teleport")f.p.x=4000;
  assert.ok(f.hit().error,mode);assert.equal(f.user.coins,1000,mode);assert.equal(f.p.activityLocked,false,mode);
 }
});
test("a faulty activity tick stops only its attempt and releases movement",()=>{
 const f=setup();f.engine.register("practice",{tick(){throw Error("Invalid activity state");}});f.begin();assert.doesNotThrow(()=>f.engine.tick());assert.equal(f.p.activityLocked,false);assert.equal(f.engine.state(f.p).active.status,"failed");
});
test("completed activity panels can be dismissed without claiming another reward",()=>{
 const f=setup();f.begin();f.advance(2200);f.hit();const token=f.engine.state(f.p).active.token;
 assert.ok(f.send({action:"cancel",token}).ok);assert.equal(f.engine.state(f.p).active,null);assert.equal(f.user.coins,1050);assert.equal(f.engine.profile(f.p).inventory.badge,1);
});
