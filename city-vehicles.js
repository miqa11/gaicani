/* Shared street vehicles. Positions and occupancy are owned by the city server. */
(function (root, factory) {
  const vehicles = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = vehicles;
  if (root) root.GaicaniCityVehicles = vehicles;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  const definitions = [
    { id: "lada-2106", name: "ჟიგული 2106", model: "LADA 2106", kind: "sedan", color: "#da7650", x: 610, y: 780, dir: "right", speed: 300, radius: 26 },
    { id: "night-taxi", name: "ღამის ტაქსი", model: "TBILISI TAXI", kind: "taxi", color: "#f3ce60", x: 980, y: 780, dir: "right", speed: 330, radius: 26 },
    { id: "marshrutka-7", name: "მარშრუტკა №7", model: "MARSHRUTKA 07", kind: "minibus", color: "#56b6b0", x: 1180, y: 1200, dir: "left", speed: 245, radius: 31 },
    { id: "neon-coupe", name: "ნეონის კუპე", model: "NEON COUPE '92", kind: "coupe", color: "#c970dc", x: 1840, y: 780, dir: "left", speed: 365, radius: 26 },
    { id: "blue-volga", name: "ლურჯი ვოლგა", model: "VOLGA 24", kind: "sedan", color: "#5d9fd2", x: 2075, y: 1200, dir: "right", speed: 315, radius: 27 },
    { id: "courtyard-lada", name: "ეზოს ჟიგული", model: "LADA 2101", kind: "sedan", color: "#a5be7a", x: 780, y: 1620, dir: "left", speed: 285, radius: 26 }
  ];
  const angles = { right:0, down:Math.PI/2, left:Math.PI, up:-Math.PI/2 };
  const angleOf = v => Number.isFinite(v.angle) ? v.angle : angles[v.dir] || 0;
  const direction = a => Math.abs(Math.cos(a)) > Math.abs(Math.sin(a)) ? (Math.cos(a)<0?'left':'right') : (Math.sin(a)<0?'up':'down');
  const delta = (a,b) => Math.atan2(Math.sin(a-b),Math.cos(a-b));
  function byId(id) { return definitions.find(v=>v.id===id)||null; }
  function dimensions(v) { return { l:v.kind==='minibus'?36:28, w:v.kind==='minibus'?16:14 }; }
  function seatLayout(v) {
    const rows=v.kind==='minibus'?4:v.kind==='coupe'?1:2;
    return Array.from({length:rows*2},(_,id)=>({id,x:(v.kind==='minibus'?23:10)-Math.floor(id/2)*14,y:id%2?7:-7}));
  }
  function seatPoint(v,index) { const s=seatLayout(v)[index]||{x:0,y:0},a=angleOf(v);return {x:v.x+s.x*Math.cos(a)-s.y*Math.sin(a),y:v.y+s.x*Math.sin(a)+s.y*Math.cos(a)}; }
  function createFleet() { return definitions.map(v=>Object.assign({},v,{angle:angleOf(v),velocity:0,driverId:null,seats:seatLayout(v).map(s=>({...s,playerId:null,name:'',color:''})),access:'everyone',radio:'off',radioEpoch:0,transition:null})); }
  function polygon(v) {
    const {l,w}=dimensions(v),a=angleOf(v),c=Math.cos(a),s=Math.sin(a);
    return [[-l,-w],[l,-w],[l,w],[-l,w]].map(([x,y])=>({x:v.x+x*c-y*s,y:v.y+x*s+y*c}));
  }
  function intersects(a,b) {
    for(const p of [a,b])for(let i=0;i<p.length;i++){
      const q=p[(i+1)%p.length],n={x:-(q.y-p[i].y),y:q.x-p[i].x};
      const av=a.map(v=>v.x*n.x+v.y*n.y),bv=b.map(v=>v.x*n.x+v.y*n.y);
      if(Math.max(...av)<=Math.min(...bv)||Math.max(...bv)<=Math.min(...av))return false;
    }return true;
  }
  function rectPolygon(r){return [{x:r.x,y:r.y},{x:r.x+r.w,y:r.y},{x:r.x+r.w,y:r.y+r.h},{x:r.x,y:r.y+r.h}];}
  function clearPath(world,a,b){const steps=Math.max(1,Math.ceil(Math.hypot(b.x-a.x,b.y-a.y)/4));for(let i=0;i<=steps;i++)if(!world.isWalkable(a.x+(b.x-a.x)*i/steps,a.y+(b.y-a.y)*i/steps,11))return false;return true;}
  function contains(v,x,y,r=0) {
    const a=angleOf(v),dx=x-v.x,dy=y-v.y,{l,w}=dimensions(v);
    const px=Math.abs(dx*Math.cos(a)+dy*Math.sin(a)),py=Math.abs(-dx*Math.sin(a)+dy*Math.cos(a));
    return Math.hypot(Math.max(0,px-l),Math.max(0,py-w))<r || (px<l&&py<w);
  }
  function isDriveable(world,x,y,radius,others,ignoreId,heading,people) {
    if(!Number.isFinite(x)||!Number.isFinite(y))return false;
    const base=(others||[]).find(v=>v.id===ignoreId)||byId(ignoreId)||{radius,kind:radius>=30?'minibus':'sedan'};
    const v={...base,x,y,angle:typeof heading==='number'?heading:angles[heading]??angleOf(base)},poly=polygon(v);
    if(poly.some(p=>p.x<1||p.y<1||p.x>world.width-1||p.y>world.height-1))return false;
    const water=[{x:2510,y:0,w:135,h:928},{x:2510,y:1032,w:135,h:world.height-1032}];
    const left=Math.min(...poly.map(p=>p.x)),right=Math.max(...poly.map(p=>p.x)),top=Math.min(...poly.map(p=>p.y)),bottom=Math.max(...poly.map(p=>p.y));
    if([...world.blockers,...water].some(b=>left<b.x+b.w&&right>b.x&&top<b.y+b.h&&bottom>b.y&&intersects(poly,rectPolygon(b))))return false;
    if((others||[]).some(o=>o.id!==ignoreId&&Math.abs(o.x-x)<90&&Math.abs(o.y-y)<90&&intersects(poly,polygon(o))))return false;
    return !(people||[]).some(p=>!p.vehicleId&&!p.interiorId&&!p.rideId&&contains(v,p.x,p.y,p.radius||11));
  }
  function move(world,v,dx,dy,distance,others,people) {
    let x=v.x,y=v.y; if(![x,y,dx,dy,distance].every(Number.isFinite)||distance<=0)return {x,y};
    const count=Math.max(1,Math.ceil(distance/2));
    for(let i=0;i<count;i++){
      const nx=x+dx*distance/count,ny=y+dy*distance/count;
      if(!isDriveable(world,nx,ny,v.radius,others,v.id,angleOf(v),people))break;
      x=nx;y=ny;
    }return {x,y};
  }
  function drive(world,v,input,dt,others,people) {
    const seconds=dt/1000,mag=Math.min(1,Math.hypot(input.x||0,input.y||0));let angle=angleOf(v),velocity=v.velocity||0;
    let desired=angle,error=0;
    if(mag>.01){desired=Math.atan2(input.y,input.x);error=delta(desired,angle);}
    // Opposite input brakes, then reverses without needing space for a U-turn.
    const reversing=mag>.01&&Math.abs(error)>Math.PI*.72;
    if(reversing)error=delta(desired+Math.PI,angle);
    const target=mag>.01?(reversing?-1:1)*v.speed*(reversing?.55:1)*mag*Math.max(.2,Math.cos(error*.5)):0;
    const rate=(velocity!==0&&Math.sign(target)!==Math.sign(velocity))||Math.abs(target)<Math.abs(velocity)?800:260;
    velocity += Math.sign(target-velocity)*Math.min(Math.abs(target-velocity),rate*seconds);
    if(Math.abs(velocity)<.5)velocity=0;
    const turn=Math.sign(error)*Math.min(Math.abs(error),3.6*seconds);
    // Validate every small rotation as well as translation, so corners cannot sweep through a wall.
    const slices=Math.max(1,Math.ceil(Math.abs(turn)/.035));
    for(let i=0;i<slices;i++){const a=angle+turn/slices;if(isDriveable(world,v.x,v.y,v.radius,others,v.id,a,people))angle=a;else {velocity=0;break;}}
    const at=move(world,{...v,angle},Math.cos(angle)*Math.sign(velocity),Math.sin(angle)*Math.sign(velocity),Math.abs(velocity)*seconds,others,people);
    if(Math.abs(velocity)>0&&Math.hypot(at.x-v.x,at.y-v.y)<Math.abs(velocity)*seconds-.01)velocity=0;
    return {...at,angle,velocity,dir:direction(angle),moving:Math.hypot(at.x-v.x,at.y-v.y)>.0001};
  }
  function exitPoint(world,v,others,people,index=0) {
    const a=angleOf(v),{l,w}=dimensions(v),side=index%2?1:-1;
    const offsets=[[0,side*(w+18)],[0,-side*(w+18)],[-l-18,0],[l+18,0]];
    for(const scale of [1,1.5,2])for(const [dx,dy]of offsets){
      const x=v.x+(dx*Math.cos(a)-dy*Math.sin(a))*scale,y=v.y+(dx*Math.sin(a)+dy*Math.cos(a))*scale;
      if(world.isWalkable(x,y,11)&&clearPath(world,v,{x,y})&&!(others||[]).some(o=>contains(o,x,y,12))&&!(people||[]).some(p=>!p.vehicleId&&!p.interiorId&&!p.rideId&&Math.hypot(p.x-x,p.y-y)<24))return {x,y};
    }return null;
  }
  function createGarage(world,options={}) {
    const fleet=createFleet(),players=options.players||new Map(),invites=new Map(),clock=options.now||Date.now;
    const relationship=options.relationship||(()=>({blocked:false,friends:false}));
    const find=id=>fleet.find(v=>v.id===id)||null;
    const obstacles=()=>[...players.values(),...(world.npcs||[]),...(world.garden?.npcs||[])].filter(p=>!p.vehicleId&&!p.interiorId&&!p.rideId);
    const list=()=>fleet.map(v=>({...v,seats:v.seats.map(s=>({...s}))}));
    function stopped(v){return v&&Math.abs(v.velocity)<5;}
    function syncOccupants(v){for(const seat of v.seats){const p=players.get(seat.playerId);if(!p)continue;const at=seat.id===0?{x:v.x,y:v.y}:seatPoint(v,seat.id);Object.assign(p,at,{dir:v.dir,vehicleAngle:v.angle,vehicleSpeed:seat.id===0?v.velocity:0});}}
    function conflicts(p,v){return v.seats.some(s=>s.playerId&&s.playerId!==p.id&&relationship(p,players.get(s.playerId)).blocked);}
    function access(p,v){const owner=players.get(v.ownerId||v.driverId);return !conflicts(p,v)&&(!owner||owner.id===p.id||v.access==='everyone'||(v.access==='friends'&&relationship(p,owner).friends)||(v.access==='invite'&&(invites.get(v.id+':'+p.id)||0)>clock()));}
    function transition(p,v,kind,from,to){v.transition={playerId:p.id,name:p.name,color:p.color,kind,from,to,at:clock(),duration:350};}
    function enter(p,id,seatId){
      if(!p||p.interiorId||p.rideId||p.gameId||p.vehicleId||p.gardenSeatId)return {error:'ჯერ ქუჩაში ფეხით დაბრუნდი.'};
      const v=find(id);if(!v||Math.hypot(p.x-v.x,p.y-v.y)>90)return {error:'მანქანასთან ახლოს მიდი.'};
      if(!clearPath(world,p,v))return {error:'კართან ღია მხრიდან მიდი.'};
      if(!stopped(v))return {error:'დაელოდე მანქანის გაჩერებას.'};
      if(!access(p,v))return {error:'მანქანაში შესვლის უფლება არ გაქვს ან მოთამაშე დაბლოკილია.'};
      const seat=seatId===undefined?v.seats.find(s=>!s.playerId):v.seats.find(s=>s.id===seatId&&!s.playerId);
      if(!seat)return {error:'თავისუფალი ადგილი არ არის.'};
      const from={x:p.x,y:p.y};players.set(p.id,p);seat.playerId=p.id;seat.name=p.name;seat.color=p.color;
      if(seat.id===0){v.driverId=p.id;v.ownerId=p.id;}
      Object.assign(p,{vehicleId:v.id,vehicleSeat:seat.id,gardenDance:null,action:seat.id===0?'drive':'passenger',actionUntil:0,inputX:0,inputY:0});
      invites.delete(v.id+':'+p.id);syncOccupants(v);transition(p,v,'enter',from,seatPoint(v,seat.id));return {ok:true};
    }
    function release(p,moveOutside,force=false){
      const v=find(p?.vehicleId);if(!p)return {error:'ქალაქში ჯერ არ ხარ.'};
      const seat=v?.seats.find(s=>s.playerId===p.id);
      if(seat){
        if(!force&&moveOutside&&!stopped(v))return {error:'გადმოსვლამდე გააჩერე მანქანა.'};
        const at=moveOutside?exitPoint(world,v,fleet,obstacles().filter(o=>o.id!==p.id),seat.id):null;
        if(moveOutside&&!at)return {error:'გვერდით უსაფრთხო ადგილი არ არის. სხვა ადგილას გააჩერე.'};
        const from=seatPoint(v,seat.id);seat.playerId=null;seat.name='';seat.color='';
        if(v.driverId===p.id){v.driverId=null;v.velocity=0;v.ownerId=null;v.access='everyone';for(const key of invites.keys())if(key.startsWith(v.id+':'))invites.delete(key);}
        if(at){p.x=at.x;p.y=at.y;transition(p,v,'exit',from,at);}syncOccupants(v);
      }
      Object.assign(p,{vehicleId:null,vehicleSeat:null,vehicleSpeed:0,inputX:0,inputY:0,action:'idle',actionUntil:0});return {ok:true};
    }
    function takeDriver(p){const v=find(p?.vehicleId);if(!v||v.driverId||!stopped(v)||!access(p,v))return {error:'მძღოლის ადგილი მიუწვდომელია.'};const old=v.seats.find(s=>s.playerId===p.id);if(!old)return {error:'ჯერ მანქანაში ჩაჯექი.'};old.playerId=null;old.name='';old.color='';Object.assign(v.seats[0],{playerId:p.id,name:p.name,color:p.color});v.driverId=p.id;v.ownerId=p.id;p.vehicleSeat=0;syncOccupants(v);return {ok:true};}
    function sync(p){const v=find(p.vehicleId);if(!v)return null;if(v.driverId===p.id){v.x=p.x;v.y=p.y;v.dir=p.dir;v.angle=Number.isFinite(p.vehicleAngle)?p.vehicleAngle:angles[p.dir];v.velocity=p.vehicleSpeed||0;syncOccupants(v);}else syncOccupants(v);return v;}
    function setting(p,key,value){const v=find(p?.vehicleId);if(!v||v.driverId!==p.id)return {error:'ამ პარამეტრს მძღოლი ცვლის.'};if(key==='access'&&['everyone','friends','invite'].includes(value)){v.access=value;return {ok:true};}if(key==='radio'&&['off','boom-bap','rnb','club'].includes(value)){v.radio=value;v.radioEpoch=clock();return {ok:true};}return {error:'უცნობი პარამეტრი.'};}
    function invite(p,target){const v=find(p?.vehicleId);if(!v||v.driverId!==p.id||!target||target.id===p.id||target.vehicleId||target.interiorId||target.rideId||target.gameId||Math.hypot(target.x-v.x,target.y-v.y)>150||conflicts(target,v))return {error:'მოსაწვევად ახლოს მდგომი მოთამაშე აირჩიე.'};if(p.lastCarInvite&&clock()-p.lastCarInvite<1000)return {error:'ერთი წამი მოიცადე.'};p.lastCarInvite=clock();invites.set(v.id+':'+target.id,clock()+60000);return {ok:true,vehicleId:v.id,name:p.name,expiresAt:clock()+60000};}
    function maintain(){
      for(const v of fleet){
        const driver=players.get(v.driverId);if(!driver){v.driverId=null;v.velocity=0;}
        for(const s of v.seats){const p=players.get(s.playerId);if(s.playerId&&!p){s.playerId=null;s.name='';s.color='';}else if(p&&s.id>0&&conflicts(p,v)){v.velocity=0;const d=players.get(v.driverId);if(d)d.vehicleSpeed=0;release(p,true,true);}}
        syncOccupants(v);
      }
      for(const [key,until]of invites)if(until<clock())invites.delete(key);
    }
    function brake(p){const v=find(p?.vehicleId);if(v&&v.driverId===p.id){v.velocity=0;p.vehicleSpeed=0;syncOccupants(v);}}
    const canDrive=p=>{const v=find(p?.vehicleId);return !v||!conflicts(p,v);};
    return {find,list,enter,release,takeDriver,sync,setting,invite,maintain,brake,stopped,obstacles,relationship,canDrive,
      canMove:(v,x,y,dir)=>isDriveable(world,x,y,v.radius,fleet,v.id,dir,obstacles()),move:(v,dx,dy,d)=>move(world,v,dx,dy,d,fleet,obstacles())};
  }
  return {definitions,byId,createFleet,angleOf,direction,delta,seatLayout,seatPoint,polygon,intersects,contains,isDriveable,move,drive,exitPoint,createGarage};
});
