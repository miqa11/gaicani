'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const W=require('../city-world'),V=require('../city-vehicles'),M=require('../city-motion'),P=require('../city-prediction');
const {createCityMotionController}=require('../server-city-motion');
function setup(){const players=new Map(),blocked=new Set(),friends=new Set();let now=10000;const garage=V.createGarage(W,{players,now:()=>now,relationship:(a,b)=>({blocked:!!a&&!!b&&(blocked.has(a.id+':'+b.id)||blocked.has(b.id+':'+a.id)),friends:!!a&&!!b&&friends.has(a.id+':'+b.id)})});const make=id=>{const p={id,name:id,color:'#aa77ff',x:610,y:830,dir:'up',action:'idle',actionUntil:0};players.set(id,p);return p;};return {players,garage,make,blocked,friends,tick:()=>now+=2000};}
test('seat assignment is exclusive, bounded, and duplicate boarding cannot teleport players',()=>{
 const {garage,make}=setup(),a=make('a');assert.ok(garage.enter(a,'lada-2106',0).ok);assert.ok(garage.enter(make('b'),'lada-2106',0).error);
 for(let i=1;i<4;i++)assert.ok(garage.enter(make('p'+i),'lada-2106').ok);
 assert.ok(garage.enter(make('full'),'lada-2106').error);assert.ok(garage.enter(a,'night-taxi').error);
 assert.equal(new Set(garage.find('lada-2106').seats.map(s=>s.playerId)).size,4);
});
test('passengers follow rotated seats and forged steering cannot move the car',()=>{
 const {garage,make}=setup(),a=make('a'),b=make('b');garage.enter(a,'lada-2106');garage.enter(b,'lada-2106');
 const c=createCityMotionController(W,garage);const first=c.view(a,0);let seq=0;
 for(let t=50;t<=500;t+=50)c.process(a,{epoch:first.epoch,commands:[{seq:++seq,x:1,y:0,dt:50}]},t);
 const car=garage.find(a.vehicleId),pos=V.seatPoint(car,b.vehicleSeat);assert.deepEqual({x:b.x,y:b.y},pos);
 const pv=c.view(b,500),x=car.x;assert.equal(pv.blocked,true);c.process(b,{epoch:pv.epoch,commands:[{seq:1,x:0,y:1,dt:50}]},550);assert.equal(car.x,x);assert.equal(car.y,780);
 assert.ok(garage.release(b,true).error,'moving exit refused');
 garage.brake(a);assert.ok(garage.release(b,true).ok);assert.ok(W.isWalkable(b.x,b.y,11));assert.equal(V.contains(car,b.x,b.y,11),false);
});
test('driver disconnect stops vehicle; passengers can exit or explicitly take the wheel',()=>{
 const {garage,make,players}=setup(),a=make('a'),b=make('b');garage.enter(a,'lada-2106');garage.enter(b,'lada-2106');a.vehicleSpeed=240;garage.sync(a);
 garage.release(a,false);players.delete(a.id);garage.maintain();const v=garage.find(b.vehicleId);assert.equal(v.driverId,null);assert.equal(v.velocity,0);assert.equal(b.vehicleSeat,1);
 assert.ok(garage.takeDriver(b).ok);assert.equal(v.driverId,b.id);assert.equal(b.vehicleSeat,0);assert.equal(v.seats[1].playerId,null);
 assert.ok(garage.release(b,true).ok);assert.ok(v.seats.every(s=>!s.playerId));
});
test('access settings, expiring invites, mutual friends and blocked occupants are enforced',()=>{
 const {garage,make,friends,blocked,tick}=setup(),a=make('a'),b=make('b'),c=make('c');garage.enter(a,'lada-2106');
 assert.ok(garage.setting(b,'access','everyone').error);garage.setting(a,'access','friends');assert.ok(garage.enter(b,'lada-2106').error);
 friends.add('b:a');assert.ok(garage.enter(b,'lada-2106').ok);garage.release(b,true);b.x=610;b.y=830;
 garage.setting(a,'access','invite');assert.ok(garage.enter(b,'lada-2106').error);assert.ok(garage.invite(a,b).ok);assert.ok(garage.enter(b,'lada-2106').ok);
 blocked.add('c:b');assert.ok(garage.invite(a,c).error);garage.setting(a,'access','everyone');assert.ok(garage.enter(c,'lada-2106').error);
 blocked.add('a:b');garage.maintain();assert.ok(!a.vehicleId||!b.vehicleId,'new block stops the car and safely separates occupants');
 const v=garage.find('lada-2106');assert.equal(v.velocity,0);
});
test('expired invitations cannot board and conflicting occupants cannot resume driving',()=>{
 const {garage,make,tick,blocked}=setup(),a=make('a'),b=make('b');garage.enter(a,'lada-2106');garage.setting(a,'access','invite');garage.invite(a,b);
 for(let i=0;i<31;i++)tick();assert.ok(garage.enter(b,'lada-2106').error);
 garage.invite(a,b);assert.ok(garage.enter(b,'lada-2106').ok);blocked.add('a:b');assert.equal(garage.canDrive(a),false);
 const c=createCityMotionController(W,garage),state=c.view(a,0);assert.equal(state.blocked,true);
 c.process(a,{epoch:state.epoch,commands:[{seq:1,x:1,y:0,dt:50}]},50);assert.equal(a.x,610);
});
test('radio is selected only by the driver and all seats share one station epoch',()=>{
 const {garage,make}=setup(),a=make('a'),b=make('b');garage.enter(a,'lada-2106');garage.enter(b,'lada-2106');
 assert.ok(garage.setting(b,'radio','club').error);assert.ok(garage.setting(a,'radio','club').ok);
 const before=garage.list()[0];assert.equal(before.radio,'club');assert.equal(before.radioEpoch,10000);garage.sync(a);assert.equal(garage.list()[0].radioEpoch,before.radioEpoch);
});
test('free outdoor driving uses oriented body collisions, not road or garden restrictions',()=>{
 const fleet=V.createFleet(),v=fleet[0];
 for(const p of [[610,700],[1400,1850],[1400,2500],[1850,2950],[2700,980]])assert.ok(V.isDriveable(W,...p,v.radius,fleet,v.id,0),p.join(','));
 for(const b of W.buildings)assert.equal(V.isDriveable(W,b.x+b.w/2,b.y+b.h/2,v.radius,fleet,v.id,0),false,b.id);
 for(const p of [[800,1845],[2360,2330],[1270,2120],[2570,1500]])assert.equal(V.isDriveable(W,...p,v.radius,fleet,v.id,0),false,p.join(','));
 const narrow={width:500,height:500,blockers:[{x:0,y:0,w:200,h:500},{x:234,y:0,w:266,h:500}]};
 assert.ok(V.isDriveable(narrow,217,250,26,[],v.id,Math.PI/2));assert.equal(V.isDriveable(narrow,217,250,26,[],v.id,0),false);
});
test('cars brake before pedestrians without pushing them; pedestrians cannot walk into cars',()=>{
 const v={...V.createFleet()[0],x:1400,y:1710,velocity:200},person={x:1520,y:1710};let moving=v;
 for(let i=0;i<50;i++){const n=V.drive(W,moving,{x:1,y:0},50,[moving],[person]);moving={...moving,...n};}
 assert.ok(moving.x<person.x-38);assert.deepEqual(person,{x:1520,y:1710});
 let p={x:1400,y:1770,mode:'world'};for(let i=0;i<20;i++)p={...p,...M.step(W,p,{x:0,y:-1},50,[v])};assert.equal(V.contains(v,p.x,p.y,11),false);
});
test('a car can reverse out of a corridor too narrow for a U-turn and brake to rest',()=>{
 const corridor={width:600,height:600,blockers:[{x:0,y:0,w:280,h:600},{x:314,y:0,w:286,h:600}],isWalkable:()=>true};
 let v={...V.createFleet()[0],x:297,y:300,angle:Math.PI/2,velocity:0};
 for(let i=0;i<10;i++)v={...v,...V.drive(corridor,v,{x:0,y:-1},50,[v],[])};
 assert.ok(v.y<280&&v.velocity<0);assert.ok(Math.abs(v.angle-Math.PI/2)<.001);
 for(let i=0;i<12;i++)v={...v,...V.drive(corridor,v,{x:0,y:0},50,[v],[])};
 assert.equal(v.velocity,0);
});
test('acceleration, turning and braking replay identically through delayed confirmations',()=>{
 const {garage,make}=setup(),a=make('a');a.x=1400;a.y=1710;const car=garage.find('lada-2106');car.x=a.x;car.y=a.y;garage.enter(a,car.id);
 const c=createCityMotionController(W,garage),predict=P.create(W,()=>garage.list(),()=>garage.obstacles());predict.accept(c.view(a,0));
 const inputs=[...Array(12).fill({x:1,y:0}),...Array(12).fill({x:.7,y:.7}),...Array(20).fill({x:0,y:0})];let at=0,max=0;
 for(const input of inputs){predict.predict(input,25);const batch=predict.drain();at+=25;const reply=c.process(a,batch,at);const local=predict.getState();assert.ok(Math.abs(local.x-reply.x)<.000001);assert.ok(Math.abs(local.y-reply.y)<.000001);max=Math.max(max,reply.vehicleSpeed);predict.accept(reply);}
 assert.ok(max>50&&max<car.speed);assert.equal(a.vehicleSpeed,0);const x=a.x,y=a.y;c.maintain(a,at+2000);assert.equal(a.x,x);assert.equal(a.y,y);
});
test('all road and sidewalk corridors avoid buildings and solid street furniture',()=>{
 const overlap=(a,b)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;
 for(const b of W.buildings)for(const r of W.roads)assert.equal(overlap(b,{x:r.x-12,y:r.y-12,w:r.w+24,h:r.h+24}),false,b.id);
 for(const o of W.furniture)for(const r of W.roads)assert.equal(overlap({x:o.x-o.w/2,y:o.y-o.h/2,w:o.w,h:o.h},r),false,o.kind+' '+o.x+','+o.y);
 for(const b of W.buildings.filter(b=>b.enterable)){const x=b.x+b.w*.72+9,y=b.y+b.h+30;assert.ok(W.isWalkable(x,y,11));assert.ok(V.isDriveable(W,x,y+30,26,[],'lada-2106',0));}
 for(const x of [540,1080,1620,2160])for(let y=50;y<1750;y+=10)assert.ok(V.isDriveable(W,x,y,31,[],'marshrutka-7',Math.PI/2),'street '+x+','+y);
 for(const y of [360,780,1200,1620])for(let x=40;x<2450;x+=10)assert.ok(V.isDriveable(W,x,y,31,[],'marshrutka-7',0),'street '+x+','+y);
 const reached=new Set([0]),queue=[0];while(queue.length){const at=queue.shift();W.roads.forEach((road,i)=>{if(!reached.has(i)&&overlap(W.roads[at],road)){reached.add(i);queue.push(i);}});}assert.equal(reached.size,W.roads.length,'all roads, bridge and garden connector belong to one connected network');
 for(let i=0;i<W.buildings.length;i++)for(let j=i+1;j<W.buildings.length;j++)assert.equal(overlap(W.buildings[i],W.buildings[j]),false,W.buildings[i].id+' / '+W.buildings[j].id);
});
