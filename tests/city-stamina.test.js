"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const motion = require("../city-motion"), prediction = require("../city-prediction");
const { createCityMotionController } = require("../server-city-motion");
const emptyWorld = { width:10000,height:10000,blockers:[],isWalkable:()=>true,casinoIsWalkable:()=>true };
const garage = {list:()=>[],obstacles:()=>[],canDrive:()=>true,sync:()=>{},brake:()=>{}};
const start = () => ({x:500,y:500,dir:"right",mode:"world"});
function advance(state,input,count) { for(let i=0;i<count;i++)state={...state,...motion.step(emptyWorld,state,input,50,[])};return state; }

test("sprinting is faster, spends bounded stamina, and exhaustion requires recovery",()=>{
 const walking=advance(start(),{x:1,y:0},20),running=advance(start(),{x:1,y:0,sprint:true},20);
 assert.ok(Math.abs((running.x-500)/(walking.x-500)-motion.SPRINT_MULTIPLIER)<1e-10);
 assert.ok(Math.abs(running.stamina-76)<1e-10);
 let exhausted=advance(start(),{x:1,y:0,sprint:true},84);assert.equal(exhausted.stamina,0);assert.equal(exhausted.sprintLocked,true);
 const recovering=advance(exhausted,{x:1,y:0,sprint:true},20);assert.equal(recovering.sprinting,false);assert.ok(recovering.stamina>0&&recovering.stamina<25);
 const rested=advance(recovering,{x:0,y:0},120);assert.equal(rested.stamina,100);assert.equal(rested.x,recovering.x);assert.equal(rested.y,recovering.y);
});

test("jump accepts a rising edge, spends stamina and cannot repeat before cooldown",()=>{
 let p=advance(start(),{x:0,y:0,jump:true},1);assert.equal(p.jumpSerial,1);assert.equal(p.jumpRemaining,motion.JUMP_DURATION);assert.ok(p.stamina<100);
 p=advance(p,{x:0,y:0,jump:true},30);assert.equal(p.jumpSerial,1);assert.equal(p.jumpRemaining,0);
 p=advance(p,{x:0,y:0,jump:false},1);p=advance(p,{x:0,y:0,jump:true},1);assert.equal(p.jumpSerial,2);
 p=advance(p,{x:0,y:0,jump:false},1);p=advance(p,{x:0,y:0,jump:true},1);assert.equal(p.jumpSerial,2);
 assert.equal(p.x,500);assert.equal(p.y,500);
});

test("jumping and running retain solid ground collisions and never activate in locked scenes",()=>{
 const world={...emptyWorld,isWalkable:(x,y,r)=>x+r<540};let p=start();
 for(let i=0;i<20;i++)p={...p,...motion.step(world,p,{x:1,y:0,sprint:true,jump:i===0},50,[])};
 assert.ok(p.x<529);
 for(const patch of [{blocked:true},{mode:"casino"},{vehicleId:"lada-2106",vehicleSeat:1}]){
  const initial={...start(),...patch},next=motion.step(emptyWorld,initial,{x:1,y:0,sprint:true,jump:true},50,[]);
  assert.equal(next.jumpRemaining,0);assert.equal(next.jumpSerial,0);assert.equal(next.sprinting,false);
 }
});

test("ability state replays identically through prediction and authoritative confirmations",()=>{
 const player={id:"runner",...start(),action:"idle"},controller=createCityMotionController(emptyWorld,garage),client=prediction.create(emptyWorld,()=>[]);
 client.accept(controller.view(player,0));let now=0;
 for(let i=0;i<80;i++){
  const input={x:i<50?1:0,y:0,sprint:i<45,jump:i===4||i===50};
  client.predict(input,25);now+=25;const local={...client.getState()},reply=controller.process(player,client.drain(),now);
  for(const key of ["x","y","stamina","jumpRemaining","jumpCooldown","jumpSerial","jumpHeld","sprintLocked","sprinting"])assert.equal(local[key],reply[key],key);
  client.accept(reply);
 }
 assert.equal(player.jumpSerial,2);
});

test("duplicate, malformed, and over-budget commands cannot create free jumps or speed",()=>{
 const player={id:"runner",...start()},controller=createCityMotionController(emptyWorld,garage),view=controller.view(player,0);
 const first={epoch:view.epoch,commands:[{seq:1,x:1,y:0,dt:50,sprint:true,jump:true}]};
 const ack=controller.process(player,first,50),again=controller.process(player,first,100);assert.equal(ack.jumpSerial,again.jumpSerial);assert.equal(ack.x,again.x);
 assert.ok(controller.process(player,{epoch:view.epoch,commands:[{seq:2,x:1,y:0,dt:50,sprint:999}]},100).error);
 const before=player.x;const commands=Array.from({length:32},(_,i)=>({seq:i+2,x:1,y:0,dt:50,sprint:true,jump:!(i%2)}));
 controller.process(player,{epoch:view.epoch,commands},100);assert.ok(player.x-before<=motion.WALK_SPEED*motion.SPRINT_MULTIPLIER*.15+.0001);assert.equal(player.jumpSerial,1);
});

test("idle background players recover without sliding and scene changes cancel airborne state",()=>{
 const player={id:"runner",...start(),action:"idle"},controller=createCityMotionController(emptyWorld,garage),view=controller.view(player,0);
 controller.process(player,{epoch:view.epoch,commands:[{seq:1,x:0,y:0,dt:50,jump:true}]},50);const x=player.x;
 controller.maintain(player,1050);assert.equal(player.jumpRemaining,0);assert.equal(player.stamina,100);assert.equal(player.x,x);
 player.jumpRemaining=500;player.activityLocked=true;player.activityLockId="fishing";const locked=controller.view(player,1100);
 assert.equal(locked.jumpRemaining,0);assert.equal(locked.blocked,true);assert.ok(locked.epoch>view.epoch);
});
