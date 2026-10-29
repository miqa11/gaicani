"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {createCityActivities} = require("../server-city-activities");
const W = require("../city-world");
const data = require("../city-activities-data");

function setup({guest=false,roll=50}={}) {
  let now=100000, sequence=0, saves=0;
  const p={id:"one",userKey:"one",name:"One",x:0,y:0,jumpSerial:0,jumpRemaining:0};
  const other={id:"two",userKey:"two",name:"Two",x:0,y:0};
  const user={coins:100,isGuest:guest}, otherUser={coins:100};
  const players=new Map([[p.id,p],[other.id,other]]);
  const registeredUsers=new Map([["one",user],["two",otherUser]]);
  const garage={list:()=>[{id:"test-car",model:"Lada",x:2720,y:985,seats:[]}]};
  const engine=createCityActivities({world:W,players,garage,registeredUsers,now:()=>now,
    randomInt:max=>max===100?roll:0,saveAuthUsers:()=>saves++});
  const send=(packet,who=p)=>engine.command(who,{requestId:"test-"+(++sequence),...packet});
  const active=(who=p)=>engine.state(who).active;
  const advance=(ms,tick=true)=>{now+=ms;if(tick)engine.tick();};
  const begin=(id,options={},who=p)=>{
    Object.assign(who,data.activities.find(a=>a.id===id).location);
    who.jumpRemaining=0;
    return send({action:"start",activityId:id,options},who);
  };
  const act=(verb,value,who=p,extra={})=>send({action:"act",token:active(who).token,verb,value,...extra},who);
  const move=(point,who=p)=>{
    const duration=Math.max(1000,Math.ceil(Math.hypot(who.x-point.x,who.y-point.y)/160*1000));
    who.x=point.x;who.y=point.y;who.jumpRemaining=0;advance(duration);
  };
  const clues=(who=p)=>{while(active(who).status==="active"&&!active(who).choices){move(active(who).target,who);assert.equal(act("search",undefined,who).ok,true);}};
  return {p,other,user,otherUser,players,engine,send,active,advance,begin,act,move,clues,
    time:()=>now,saves:()=>saves};
}

test("all exploration handlers are installed and reject unearned client completions",()=>{
  const f=setup();
  for(const id of ["fishing","treasure","bugs","photography","parkour"])assert.ok(f.engine.state(f.p).capabilities.includes(id));
  f.begin("fishing");
  assert.ok(f.act("complete",{score:99999,item:"fish-legendary"}).error);
  assert.equal(f.user.coins,100);
  assert.deepEqual(f.engine.profile(f.p).inventory,{});
});

test("fishing accepts only the server timing window and rolls all three rarities",()=>{
  for(const [roll,item] of [[0,"fish-legendary"],[19,"fish-rare"],[20,"fish-common"]]){
    const f=setup({roll});f.begin("fishing");
    assert.equal(f.p.activityLocked,true);
    assert.ok(f.act("reel").error);
    f.advance(f.active().challenge.at-f.time());
    const packet={action:"act",token:f.active().token,verb:"reel",requestId:"catch-once"};
    assert.equal(f.send(packet).ok,true);
    assert.equal(f.active().status,"success");
    assert.equal(f.engine.profile(f.p).inventory[item],1);
    assert.equal(f.user.coins,112);
    assert.equal(f.p.activityLocked,false);
    assert.equal(f.p.activityAnimation.kind,"reel");
    assert.equal(f.send(packet).duplicate,true);
    assert.equal(f.engine.profile(f.p).inventory[item],1);
    assert.equal(f.user.coins,112);
  }
});

test("missed or full-inventory catches release movement without awarding coins",()=>{
  for(const mode of ["late","full"]){
    const f=setup();f.begin("fishing");
    if(mode==="full")f.engine.profile(f.p).inventory["fish-common"]=999;
    f.advance(f.active().challenge.at-f.time()+(mode==="late"?401:0));
    if(mode==="full")assert.ok(f.act("reel").ok);
    assert.equal(f.active().status,"failed");
    assert.equal(f.user.coins,100);
    assert.equal(f.p.activityLocked,false);
  }
});

test("bugs use an independent net timing mechanic and guests keep only session collections",()=>{
  for(const [roll,item] of [[0,"bug-rare"],[50,"bug-common"]]){
    const f=setup({roll,guest:true});f.begin("bugs");
    assert.ok(f.act("reel").error);
    f.advance(f.active().challenge.at-f.time());
    assert.ok(f.act("catch").ok);
    assert.equal(f.engine.profile(f.p).inventory[item],1);
    assert.equal(f.user.coins,100);
    assert.equal(f.user.cityActivities,undefined);
    assert.equal(f.saves(),0);
    f.engine.remove(f.p);assert.deepEqual(f.engine.profile(f.p).inventory,{});
  }
});

test("treasure and parkour markers sit on genuinely walkable ground",()=>{
  for(let trail=0;trail<3;trail++){
    const f=setup();assert.ok(f.begin("treasure",{trail}).ok);
    while(!f.active().choices){
      const target=f.active().target;assert.ok(W.isWalkable(target.x,target.y,18),JSON.stringify(target));
      f.move(target);f.act("search");
    }
  }
  const f=setup();f.begin("parkour");
  for(const p of f.active().checkpoints)assert.ok(W.isWalkable(p.x,p.y,18));
});

test("treasure requires ordered clues, the correct puzzle answer, and a one-time journal claim",()=>{
  const f=setup();f.begin("treasure");
  assert.ok(f.act("solve","1999").error);
  f.move({x:700,y:780});
  assert.ok(f.act("search").error);
  f.clues();
  assert.ok(f.act("solve","1999").ok);
  assert.equal(f.engine.profile(f.p).inventory.cassette,1);
  assert.equal(f.user.coins,115);
  assert.equal(f.p.activityAnimation.kind,"dig");
  f.engine.remove(f.p);
  f.advance(61000);
  assert.ok(f.begin("treasure",{trail:0}).error);
  assert.equal(f.engine.profile(f.p).inventory.cassette,1);
  assert.ok(f.begin("treasure",{trail:"0"}).error);
});

test("wrong treasure answers fail and inventory limits do not consume a one-time discovery",()=>{
  const wrong=setup();wrong.begin("treasure");wrong.clues();wrong.act("solve","1989");
  assert.equal(wrong.active().status,"failed");assert.equal(wrong.user.coins,100);
  const full=setup();full.begin("treasure");full.clues();full.engine.profile(full.p).inventory.cassette=999;
  assert.ok(full.act("solve","1999").error);
  assert.equal(full.engine.profile(full.p).claims["treasure:0"],undefined);
  full.engine.profile(full.p).inventory.cassette=998;
  assert.ok(full.act("solve","1999").ok);
});

test("cooperative treasure needs a second eligible hunter and lets both finish safely",()=>{
  const f=setup();
  f.begin("treasure",{trail:2});f.begin("treasure",{trail:2},f.other);
  f.clues();assert.ok(f.act("solve","together").error);
  f.clues(f.other);
  f.user.blockedUsers=["two"];assert.ok(f.act("solve","together").error);f.user.blockedUsers=[];
  f.other.interiorId="casino";assert.ok(f.act("solve","together").error);f.other.interiorId=null;
  f.other.userKey="one";assert.ok(f.act("solve","together").error);f.other.userKey="two";
  assert.ok(f.act("solve","together").ok);
  assert.ok(f.act("solve","together",f.other).ok);
  assert.equal(f.user.coins,115);assert.equal(f.otherUser.coins,115);
  assert.equal(f.engine.profile(f.p).inventory.souvenir,1);
  assert.equal(f.engine.profile(f.other).inventory.souvenir,1);
  assert.ok(!Object.hasOwn(f.active(),"_partnerId"));
});

test("photography checks fresh consent, bilateral blocks, distance, and scene at capture",()=>{
  const f=setup();Object.assign(f.other,data.activities.find(a=>a.id==="photography").location);
  f.begin("photography");
  const value={targetType:"player",targetId:f.other.id};
  assert.ok(!f.active().subjects.some(s=>s.id===f.other.id));
  assert.ok(f.act("capture",value).error);
  f.send({action:"privacy",value:{photos:true}},f.other);f.advance(1000);
  assert.ok(f.active().subjects.some(s=>s.id===f.other.id));
  f.send({action:"privacy",value:false},f.other);
  assert.ok(f.act("capture",value).error);
  f.send({action:"privacy",value:true},f.other);
  f.otherUser.blockedUsers=["one"];assert.ok(f.act("capture",value).error);f.otherUser.blockedUsers=[];
  f.user.blockedUsers=["two"];assert.ok(f.act("capture",value).error);f.user.blockedUsers=[];
  f.other.interiorId="casino";assert.ok(f.act("capture",value).error);f.other.interiorId=null;
  f.other.y+=500;assert.ok(f.act("capture",value).error);f.other.y-=500;
  f.advance(1000);
  const result=f.act("capture",{...value,frame:"mint",pose:"dance",allowedPlayerIds:["intruder"]});
  assert.ok(result.ok);assert.deepEqual(result.photo.allowedPlayerIds,["one","two"]);
  assert.equal(result.photo.frame,"mint");assert.equal(result.photo.pose,"dance");
  assert.equal(f.p.activityAnimation.kind,"camera");
  assert.equal(f.engine.profile(f.p).records.photos[0].subjectId,"two");
});

test("landmarks, cars, citizens and opted-in players are real selectable photo subjects",()=>{
  const f=setup();f.begin("photography");
  assert.ok(f.active().subjects.some(s=>s.type==="landmark"&&s.id==="funicular-east"));
  assert.ok(f.active().subjects.some(s=>s.type==="vehicle"&&s.id==="test-car"));
  f.move(data.npcs[0]);
  assert.ok(f.active().subjects.some(s=>s.type==="citizen"&&s.id==="g-mzi"));
  const result=f.act("capture",{targetType:"citizen",targetId:"g-mzi",frame:"invalid",pose:"invalid"});
  assert.ok(result.ok);assert.equal(result.photo.frame,"neon");assert.equal(result.photo.pose,"wave");
  assert.deepEqual(result.photo.allowedPlayerIds,["one"]);
});

test("photo rewards are once per subject and the saved album stays bounded",()=>{
  const f=setup();
  for(let i=0;i<26;i++){
    assert.ok(f.begin("photography").ok);
    assert.ok(f.act("capture",{targetType:"landmark",targetId:"funicular-east"}).ok);
    f.advance(61000);
  }
  assert.equal(f.user.coins,105);
  assert.equal(f.engine.profile(f.p).records.photos.length,24);
});

function finishParkour(f,perJump=1000){
  while(f.active().status==="active"){
    f.move(f.active().target);
    f.p.jumpSerial++;f.p.jumpRemaining=500;f.advance(perJump);
  }
}
test("parkour checks ordered positions and separate real jumps, not submitted scores",()=>{
  const f=setup();f.begin("parkour");
  assert.ok(f.act("complete",{score:1}).error);
  f.move(f.active().checkpoints[2]);f.p.jumpSerial++;f.p.jumpRemaining=500;f.advance(1000);
  assert.equal(f.active().step,0);
  f.move(f.active().target);f.advance(1000);assert.equal(f.active().step,0);
  f.p.jumpSerial++;f.p.jumpRemaining=500;f.advance(1000);assert.equal(f.active().step,1);
  f.move(f.active().target);f.p.jumpRemaining=500;f.advance(1000);assert.equal(f.active().step,1);
  finishParkour(f);
  assert.equal(f.active().status,"success");
  assert.equal(f.user.coins,112);
  assert.equal(f.engine.boards.get("parkour").length,1);
  assert.equal(f.engine.profile(f.p).records.parkour,f.active().time);
});

test("parkour keeps each player's fastest record rather than overwriting it with a slower run",()=>{
  const f=setup();f.begin("parkour");finishParkour(f,1000);
  const best=f.engine.boards.get("parkour")[0].time;
  f.advance(61000);f.begin("parkour");finishParkour(f,2000);
  assert.equal(f.engine.boards.get("parkour")[0].time,best);
  assert.equal(f.engine.profile(f.p).records.parkour,best);
});

test("parkour rejects teleporting, car entry, disconnect and timeouts without prizes",()=>{
  for(const mode of ["teleport","car","disconnect","timeout"]){
    const f=setup();f.begin("parkour");
    if(mode==="teleport"){f.p.x=2500;f.advance(40);}
    if(mode==="car"){f.p.vehicleId="test-car";f.advance(40);}
    if(mode==="disconnect")f.engine.remove(f.p);
    if(mode==="timeout")f.advance(90001);
    assert.equal(f.user.coins,100,mode);
    assert.equal(f.engine.boards.size,0,mode);
    assert.equal(f.p.activityLocked,false,mode);
  }
});

