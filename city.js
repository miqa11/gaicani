(function () {
"use strict";
const W=window.GaicaniCityWorld, canvas=document.getElementById("cityCanvas"), ctx=canvas.getContext("2d",{alpha:false});
const mini=document.getElementById("miniMap"), mctx=mini.getContext("2d"), stage=document.querySelector(".city-world");
const dot=document.getElementById("connectionDot"), connection=document.getElementById("connectionLabel"), onlineCount=document.getElementById("onlineCount");
const locationPill=document.getElementById("locationPill"), cityToast=document.getElementById("cityToast"), cityDialog=document.getElementById("cityDialog"), playerCard=document.getElementById("playerCard"), cityMessageComposer=document.getElementById("cityMessageComposer");
const keys={x:0,y:0}, remote=new Map(), rain=[];
const V=window.GaicaniCityVehicles, fleet=new Map(),Garden=window.GaicaniCityGarden,Audio=window.GaicaniCityAudio;
let vehiclePending=false,cityMessageSending=false,cityMessageRequest=0;
const predictor=window.GaicaniCityPrediction.create(W,()=>Array.from(fleet.values()),()=>[...remote.values(),...W.npcs,...W.garden.npcs].filter(p=>!p.vehicleId&&!p.interiorId&&!p.rideId));
let motionInput={x:0,y:0},lastMotionSendAt=0;
let phoneMode=false,renderDpr=1,viewWidth=1,viewHeight=1;
function inView(x,y,pad=72){return x>=camera.x-pad&&y>=camera.y-pad&&x<=camera.x+viewWidth+pad&&y<=camera.y+viewHeight+pad}
let socket=null, joined=false, self=null, selfName="ღამის მგზავრი", camera={x:0,y:0}, nearby=null, interior=null, signals=[], notes=[], noteFlights=[], activeDuels=[], ride=null, composerMode="city", messageTargetId=null;
let toastTimer=0,lastMiniAt=0,lastDistrict="",selectedPlayerName="",recentDuel=null,touchHeld=false;
const friendNames=new Set(),incomingFriendRequests=new Set(),outgoingFriendRequests=new Set();
function safe(fn,fallback){try{return fn()}catch(_){return fallback}}
function presence(state,label){if(dot&&dot.parentElement)dot.parentElement.className="city-presence "+state;connection.textContent=label}
function toast(message,ms){cityToast.textContent=message;cityToast.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>cityToast.hidden=true,ms||2500)}
function cue(freq){Audio.cue(freq)}
function resize(){
 const r=stage.getBoundingClientRect();phoneMode=matchMedia("(any-pointer: coarse)").matches||r.width<=700;
 renderDpr=Math.min(phoneMode?1:2,devicePixelRatio||1);viewWidth=Math.max(1,Math.round(r.width));viewHeight=Math.max(1,Math.round(r.height));
 canvas.width=Math.round(viewWidth*renderDpr);canvas.height=Math.round(viewHeight*renderDpr);ctx.imageSmoothingEnabled=false;
}
addEventListener("resize",resize,{passive:true});resize();
if(window.ResizeObserver)new ResizeObserver(resize).observe(stage);
function hash(x,y){let n=(x*374761393+y*668265263)|0;n=Math.imul(n^(n>>>13),1274126177);return ((n^(n>>>16))>>>0)/4294967295}
function label(c,s,x,y,size,color,align){c.fillStyle=color||"#fff";c.textAlign=align||"left";c.textBaseline="middle";c.font='700 '+size+'px "Noto Sans Georgian",sans-serif';c.fillText(s,x,y)}
function drawPixelBuilding(g,b,i){window.GaicaniCityArchitecture.drawBuilding(g,b,i)}
function drawWetStreetDetails(g){
 const roadsX=[540,1080,1620,2160],roadsY=[360,780,1200,1620],neons=["#f14fbd","#4ecbea","#ffb354","#9a74ff"];
 roadsY.forEach((y,ri)=>{
  for(let x=0;x<W.width;x+=24){g.fillStyle=hash(x,ri+31)>.5?"#62566a":"#4d4a60";g.fillRect(x,y-50,22,2);g.fillRect(x,y+47,22,2);g.fillStyle="#252439";g.fillRect(x+22,y-51,2,5);g.fillRect(x+22,y+46,2,5)}
  for(let n=0;n<105;n++){const x=hash(n+ri*901,19)*W.width,yy=y-34+hash(n,ri+5)*68;g.globalAlpha=.05+hash(n+71,ri)*.1;g.fillStyle=neons[n%neons.length];g.fillRect(x,yy,8+hash(n+6,ri)*63,1+Math.floor(hash(n,ri+12)*3))}
  g.globalAlpha=1;
  roadsX.forEach((x,xi)=>{g.fillStyle="#d6c4cb";for(let yy=y-32;yy<y+31;yy+=12)g.fillRect(x-29,yy,58,5);g.globalAlpha=.13;g.fillStyle=neons[(ri+xi)%neons.length];g.fillRect(x-27,y-35,54,68);g.globalAlpha=1})
 });
 roadsX.forEach((x,ci)=>{
  for(let y=0;y<W.height;y+=24){g.fillStyle=hash(ci+43,y)>.5?"#62566a":"#4d4a60";g.fillRect(x-50,y,2,22);g.fillRect(x+47,y,2,22);g.fillStyle="#252439";g.fillRect(x-51,y+22,5,2);g.fillRect(x+46,y+22,5,2)}
  for(let n=0;n<78;n++){const xx=x-34+hash(n+ci*147,7)*68,y=hash(n+32,ci+2)*W.height;g.globalAlpha=.05+hash(n,ci+19)*.1;g.fillStyle=neons[n%neons.length];g.fillRect(xx,y,1+Math.floor(hash(n+1,ci)*3),8+hash(n+9,ci)*48)}
  g.globalAlpha=1;
  roadsY.forEach((y,yi)=>{g.fillStyle="#d6c4cb";for(let xx=x-32;xx<x+31;xx+=12)g.fillRect(xx,y-29,5,58);g.globalAlpha=.12;g.fillStyle=neons[(ci+yi+1)%neons.length];g.fillRect(x-35,y-27,68,54);g.globalAlpha=1})
 });
 [[280,545],[845,1120],[1435,650],[2310,825],[1210,1688],[1920,1270]].forEach((p,i)=>{g.fillStyle="#10121b";g.fillRect(p[0],p[1],18,10);g.fillStyle="#58606b";g.fillRect(p[0]+2,p[1]+2,14,1);for(let x=0;x<12;x+=4)g.fillRect(p[0]+3+x,p[1]+5,2,1)});
}
function drawStreetTree(g,x,y,variant){
 const greens=["#285b50","#356c55","#445f50","#285d67"],leaf=greens[variant%greens.length],light=["#63c58a","#86c56e","#9ab86e","#65c8bd"][variant%4];
 const glow=g.createRadialGradient(x,y-15,2,x,y-15,34);glow.addColorStop(0,"rgba(75,228,177,.14)");glow.addColorStop(1,"rgba(75,228,177,0)");g.fillStyle=glow;g.fillRect(x-35,y-50,70,70);
 g.fillStyle="#080b14";g.fillRect(x-15,y-7,30,14);g.fillStyle="#72504e";g.fillRect(x-13,y-5,26,11);g.fillStyle="#181725";g.fillRect(x-3,y-24,6,21);g.fillStyle="#463d43";g.fillRect(x-1,y-28,3,9);
 [[-10,-30,17,15],[-18,-22,17,14],[-3,-22,20,16],[8,-31,13,13],[3,-38,12,12]].forEach((p,i)=>{g.fillStyle=i%2?leaf:light;g.fillRect(x+p[0],y+p[1],p[2],p[3])});
 g.fillStyle="#d8dc90";g.fillRect(x-10,y-27,2,2);g.fillRect(x+8,y-35,2,2);g.fillStyle="#f0c673";g.fillRect(x+2,y-18,2,2);
}
function drawCafeTable(g,x,y,color){
 g.save();g.fillStyle="rgba(5,7,15,.72)";g.beginPath();g.ellipse(x,y+13,21,6,0,0,Math.PI*2);g.fill();g.fillStyle="#292439";g.fillRect(x-2,y-3,4,15);g.fillStyle="#775c5c";g.fillRect(x-13,y-5,26,4);g.fillStyle="#d3a36e";g.fillRect(x-11,y-7,22,3);g.fillStyle=color;g.beginPath();g.moveTo(x-17,y-8);g.lineTo(x,y-22);g.lineTo(x+17,y-8);g.closePath();g.fill();g.fillStyle="#161526";g.fillRect(x-17,y-9,34,3);g.fillStyle="#f6dfaf";g.fillRect(x-5,y-4,3,2);g.fillStyle="#5a454f";g.fillRect(x-23,y+2,9,3);g.fillRect(x+14,y+2,9,3);g.fillRect(x-22,y+4,2,8);g.fillRect(x+20,y+4,2,8);g.globalAlpha=.7;g.fillStyle=color;g.fillRect(x-19,y-10,2,2);g.fillRect(x+17,y-10,2,2);g.globalAlpha=1;g.restore();
}
function drawBusStop(g,x,y){
 g.fillStyle="#10121e";g.fillRect(x-40,y-25,80,29);g.fillStyle="#41495b";g.fillRect(x-37,y-23,74,3);g.fillStyle="#63798a";g.fillRect(x-34,y-18,3,20);g.fillRect(x+31,y-18,3,20);g.globalAlpha=.55;g.fillStyle="#3b7891";g.fillRect(x-30,y-17,27,17);g.fillRect(x+3,y-17,25,17);g.globalAlpha=1;g.fillStyle="#d0a875";g.fillRect(x-27,y-2,53,3);g.fillStyle="#554654";g.fillRect(x-26,y+1,4,3);g.fillRect(x+23,y+1,4,3);g.fillStyle="#11101b";g.fillRect(x+10,y-22,18,14);g.strokeStyle="#55e5ef";g.lineWidth=1;g.strokeRect(x+11,y-21,16,12);g.fillStyle="#fff0bf";g.fillRect(x+14,y-18,10,2);g.fillStyle="#ff62c8";g.fillRect(x+14,y-14,7,2);g.fillStyle="#6d6b78";g.fillRect(x-35,y+4,70,2);
}
function drawStreetFurnishings(g){
 [[115,698],[625,685],[1165,692],[1580,690],[2390,698],[1060,1144],[1580,1142],[2390,1138],[490,1265],[1490,1570],[1940,1570]].forEach((p,i)=>drawStreetTree(g,p[0],p[1],i));
 [[875,681,"#ffb24e"],[1280,691,"#e95db5"],[1965,690,"#5edce8"],[845,1148,"#ffb24e"],[1560,1140,"#70e8df"],[2245,1272,"#ff8fcf"],[710,1575,"#a27cff"]].forEach(p=>drawCafeTable(g,p[0],p[1],p[2]));
 drawBusStop(g,820,423);drawBusStop(g,2055,423);drawBusStop(g,1520,1248);
 const lamps=[[280,407],[710,407],[1325,408],[1900,407],[2390,407],[310,827],[930,827],[1530,827],[2190,827],[880,1247],[1760,1247],[2300,1247],[680,1668],[1540,1668],[2220,1668]];
 lamps.forEach((p,i)=>{const color=["#ffbd62","#fc63c9","#64e8ef","#ffbd62"][i%4],glow=g.createRadialGradient(p[0],p[1]-26,2,p[0],p[1]-26,43);glow.addColorStop(0,color+"55");glow.addColorStop(1,color+"00");g.fillStyle=glow;g.fillRect(p[0]-44,p[1]-69,88,86);g.fillStyle="#141522";g.fillRect(p[0]-2,p[1]-30,4,31);g.fillRect(p[0]-8,p[1]-32,16,3);g.fillStyle="#6d5e6c";g.fillRect(p[0]-1,p[1]-29,2,24);g.shadowColor=color;g.shadowBlur=9;g.fillStyle=color;g.fillRect(p[0]-4,p[1]-39,8,7);g.fillStyle="#fff0c4";g.fillRect(p[0]-1,p[1]-38,2,4);g.shadowBlur=0});
 [[1410,710,"#383144"],[2420,1240,"#452e3c"],[970,1250,"#39414b"],[1810,690,"#47304c"],[1280,1580,"#40303d"],[540,1137,"#3e3545"],[2310,685,"#40303d"],[875,1550,"#3c3546"]].forEach((p,i)=>{g.fillStyle="#10111b";g.fillRect(p[0]-6,p[1]-3,15,11);g.fillStyle=p[2];g.fillRect(p[0]-4,p[1]-6,12,10);g.fillStyle=i%2?"#ff64c9":"#6ae8ed";g.fillRect(p[0]-1,p[1]-4,2,2);g.fillRect(p[0]+4,p[1]-2,2,2);g.fillStyle="#90848d";g.fillRect(p[0]-3,p[1]+7,2,3);g.fillRect(p[0]+6,p[1]+7,2,3)});
}

function drawEastBank(g){
 g.save();g.beginPath();g.rect(2645,0,W.width-2645,W.height);g.clip();
 const hill=g.createLinearGradient(2645,0,W.width,0);hill.addColorStop(0,"#393049");hill.addColorStop(.47,"#2a293f");hill.addColorStop(1,"#17243a");g.fillStyle=hill;g.fillRect(2645,0,W.width-2645,W.height);
 for(let i=0;i<14;i++){const y=i*158-35;g.strokeStyle=i%2?"#75627a":"#666079";g.globalAlpha=.17;g.lineWidth=2;g.beginPath();g.moveTo(2648,y+90);g.quadraticCurveTo(2735,y-35,2880,y+45);g.stroke()}
 for(let i=0;i<48;i++){const x=2652+(i*59)%225,y=(i*109+41)%W.height;g.fillStyle=i%3?"#45584d":"#62625b";g.fillRect(x,y,2+(i%3),2);g.fillStyle="#b7a188";g.fillRect(x+1,y-2,2,1)}
 g.strokeStyle="#c29a75";g.globalAlpha=.52;g.lineWidth=4;g.beginPath();g.moveTo(2670,1060);g.bezierCurveTo(2855,902,2663,817,2825,656);g.bezierCurveTo(2874,575,2705,470,2840,335);g.stroke();g.globalAlpha=.22;g.strokeStyle="#ffe0a2";g.lineWidth=1;g.stroke();
 g.restore();
}
function drawLandmarkStructures(g){
 // cable wire
 g.strokeStyle="#bdc4d5";g.globalAlpha=.88;g.lineWidth=2;g.beginPath();g.moveTo(2472,1080);g.lineTo(2699,955);g.stroke();g.globalAlpha=.3;g.strokeStyle="#ff536e";g.lineWidth=5;g.stroke();
 // tower lights and Mtatsminda TV tower
 g.globalAlpha=.18;g.fillStyle="#ff4ecb";g.beginPath();g.ellipse(2780,369,52,12,0,0,Math.PI*2);g.fill();g.globalAlpha=1;
 g.fillStyle="#282238";g.fillRect(2765,349,30,20);g.fillStyle="#514763";g.fillRect(2770,342,20,12);
 g.fillStyle="#372d48";g.beginPath();g.moveTo(2775,345);g.lineTo(2780,176);g.lineTo(2785,345);g.closePath();g.fill();
 g.fillStyle="#b7a6bc";g.fillRect(2778,182,4,165);g.fillStyle="#df4ed2";g.fillRect(2776,212,8,3);g.fillRect(2776,266,8,3);g.fillRect(2776,319,8,3);g.fillStyle="#e8d8ed";g.fillRect(2779,164,2,24);g.fillStyle="#ff4fd7";g.fillRect(2778,158,4,5);label(g,"ანძა",2780,389,9,"#ff80e2","center");
 for(let y=204;y<340;y+=28){g.fillStyle="#ff52d6";g.globalAlpha=.7;g.fillRect(2768,y,3,2);g.fillRect(2789,y+10,3,2)}g.globalAlpha=1;
 // Kartlis Deda: bowl, flowing coat, sword
 g.globalAlpha=.24;g.fillStyle="#d7e7ed";g.beginPath();g.ellipse(2744,617,38,10,0,0,Math.PI*2);g.fill();g.globalAlpha=1;
 g.fillStyle="#858e9c";g.fillRect(2723,598,42,18);g.fillStyle="#c1c9cf";g.fillRect(2733,568,22,30);g.fillRect(2730,549,28,20);g.fillStyle="#e3e5e7";g.beginPath();g.arc(2744,538,10,0,Math.PI*2);g.fill();g.fillStyle="#b5bdc6";g.fillRect(2736,527,17,5);
 g.fillStyle="#c5cbd2";g.beginPath();g.moveTo(2736,555);g.lineTo(2711,582);g.lineTo(2720,589);g.lineTo(2744,570);g.lineTo(2768,589);g.lineTo(2777,581);g.lineTo(2752,555);g.closePath();g.fill();
 g.fillStyle="#e6d59f";g.beginPath();g.ellipse(2708,579,10,3,-.25,0,Math.PI*2);g.fill();g.strokeStyle="#e6e8ed";g.lineWidth=2;g.beginPath();g.moveTo(2772,579);g.lineTo(2791,544);g.stroke();g.fillStyle="#cbd2d9";g.fillRect(2788,538,6,11);label(g,"ქართლის დედა",2744,628,8,"#e6e7ee","center");
 // Narikala battlements, old stone and warm spotlights
 g.globalAlpha=.24;g.fillStyle="#ffba69";g.fillRect(2628,759,185,14);g.globalAlpha=1;g.fillStyle="#403749";g.fillRect(2638,733,166,27);g.fillStyle="#786173";g.fillRect(2638,731,166,5);
 for(let x=2644;x<2800;x+=19){g.fillStyle="#625064";g.fillRect(x,724,12,12);g.fillStyle="#c58a61";g.fillRect(x+4,728,3,5)}g.fillStyle="#272638";g.fillRect(2646,740,10,19);g.fillRect(2785,740,10,19);for(let x=2662;x<2780;x+=27){g.fillStyle="#ffbc65";g.fillRect(x,745,3,7)}label(g,"ნარიყალა",2720,778,8,"#ffc978","center");
 // Stations and red cable car
 [[2446,1074],[2682,965]].forEach(a=>{g.fillStyle="#161728";g.fillRect(a[0],a[1],36,27);g.fillStyle="#a83653";g.fillRect(a[0]+3,a[1]+4,30,18);g.fillStyle="#a9eefa";g.fillRect(a[0]+7,a[1]+7,22,9);g.fillStyle="#d8b18a";g.fillRect(a[0]-2,a[1]+25,40,3);g.fillStyle="#ffbf6a";g.fillRect(a[0]+16,a[1]-6,3,8)});
 g.fillStyle="#141827";g.fillRect(2567,910,27,22);g.fillStyle="#ee405f";g.fillRect(2570,913,21,15);g.fillStyle="#a9e7f2";g.fillRect(2573,915,15,7);g.fillStyle="#392136";g.fillRect(2570,928,21,3);label(g,"საბაგირო",2464,1110,7,"#ff9aad","center");label(g,"საბაგირო",2700,1005,7,"#ff9aad","center");
}

function makeMap(){
 const map=document.createElement("canvas");map.width=W.width;map.height=W.height;const g=map.getContext("2d");
 g.fillStyle="#171728";g.fillRect(0,0,W.width,W.height);
 for(let y=0;y<W.height;y+=W.tile)for(let x=0;x<W.width;x+=W.tile){const n=hash(x,y);g.fillStyle=n>.78?"#202035":n>.4?"#1b1b30":"#19192c";g.fillRect(x,y,W.tile-1,W.tile-1);if(n>.91){g.fillStyle="#29243b";g.fillRect(x+10,y+12,3,2);g.fillRect(x+32,y+31,2,2)}}
 window.GaicaniCityRoads.draw(g,W);
 const water=g.createLinearGradient(2510,0,2645,0);water.addColorStop(0,"#102c4b");water.addColorStop(1,"#09172f");g.fillStyle=water;g.fillRect(2510,0,135,W.height);drawEastBank(g);g.fillStyle="#9a637a";g.fillRect(2497,0,12,W.height);g.fillStyle="#d283a0";g.fillRect(2495,0,3,W.height);
 for(let y=15;y<W.height;y+=71){const n=hash(4,y);g.fillStyle=n>.5?"#286084":"#1b466c";g.fillRect(2540+n*35,y,75,2)}
 window.GaicaniCityRoads.bridge(g);
 W.props.filter(p=>p.kind==='phone'||p.kind==='jukebox').forEach(p=>{g.fillStyle='#21172f';g.fillRect(p.x-14,p.y-22,28,34);g.fillStyle=p.kind==='phone'?'#f77ac7':'#72e6ff';g.fillRect(p.x-10,p.y-18,20,20);});
 drawLandmarkStructures(g);
  W.districts.forEach(d=>{g.fillStyle="rgba(7,8,20,.72)";g.fillRect(d.x-100,d.y-48,200,27);g.strokeStyle=d.color;g.lineWidth=1;g.strokeRect(d.x-100,d.y-48,200,27);label(g,d.en,d.x,d.y-34,8,d.color,"center")});
  W.buildings.filter(b=>b.enterable).map(b=>({name:b.id==="neon-casino"?"CASINO":"PIXEL ARCADE",x:b.x+b.w/2,y:b.y-16,color:b.color})).forEach(place=>{g.fillStyle="rgba(5,7,20,.94)";g.fillRect(place.x-88,place.y-15,176,30);g.strokeStyle=place.color;g.lineWidth=2;g.strokeRect(place.x-88,place.y-15,176,30);label(g,place.name,place.x,place.y,19,place.color,"center")});
 Garden.drawStatic(g,W);
 return map
}
const staticMap=makeMap();
const buildingSprites=W.buildings.map((b,i)=>{const image=document.createElement('canvas');image.width=b.w+120;image.height=b.h+160;const g=image.getContext('2d');g.translate(60-b.x,100-b.y);drawPixelBuilding(g,b,i);window.GaicaniCityArchitecture.drawStreetDetails(g,{buildings:[b]});return {b,image};});
for(let i=0;i<44;i++)rain.push({x:Math.random()*W.width,y:Math.random()*W.height,len:7+Math.random()*13,speed:170+Math.random()*180,alpha:.12+Math.random()*.2});

function syncVehicles(items){
 if(!Array.isArray(items))return;
 const ids=new Set();items.forEach(v=>{if(!V.byId(v.id))return;ids.add(v.id);const old=fleet.get(v.id);fleet.set(v.id,Object.assign({},v,{displayX:old?old.displayX:v.x,displayY:old?old.displayY:v.y}))});
 for(const id of fleet.keys())if(!ids.has(id))fleet.delete(id);
}
function nearestVehicle(){
 if(!self||!joined||interior||ride||self.vehicleId||self.gameId)return null;
 let best=null,distance=91;fleet.forEach(v=>{const d=Math.hypot(v.x-self.x,v.y-self.y);if(v.seats?.some(s=>!s.playerId)&&d<distance){best=v;distance=d}});return best;
}
function toggleVehicle(){
 if(vehiclePending||!self||!joined||interior||ride||!cityDialog.hidden||!playerCard.hidden||!cityMessageComposer.hidden||window.GaicaniCityGames?.active||window.GaicaniCityGames?.blocksMovement||window.GaicaniArcadeUI?.blocksMovement)return;
 const v=self.vehicleId?fleet.get(self.vehicleId):nearestVehicle();
 if(!v){toast("მანქანასთან ახლოს მიდი · ყვითელი ნიშნები რუკაზე");return}
 const exiting=!!self.vehicleId;stopMovementInput();vehiclePending=true;
 const requestSelf=self;const timer=setTimeout(()=>{vehiclePending=false;refresh()},4000);
 socket.emit(exiting?"city:vehicle:exit":"city:vehicle:enter",exiting?{}:{vehicleId:v.id},r=>{
  clearTimeout(timer);vehiclePending=false;if(!joined||self!==requestSelf)return;
  if(!r||r.error){toast(r?.error||"კავშირი შეფერხდა — თავიდან სცადე.");refresh();return}
  syncVehicles(r.vehicles);if(r.self){Object.assign(self,r.self);acceptMotion(r.self.motion);applyPredictedState()}
  toast(exiting?"ქუჩაში დაბრუნდი":self.vehicleSeat===0?"Drive · release controls to brake":"Passenger · F to exit when stopped");cue(exiting?440:720);refresh();drawMini();
 });
}
function refreshVehicle(){
 const button=document.getElementById("vehicleButton"),hud=document.getElementById("vehicleHud"),v=self?.vehicleId?fleet.get(self.vehicleId):nearestVehicle();
 const available=!!(v&&joined&&!interior&&!ride&&cityDialog.hidden&&playerCard.hidden&&cityMessageComposer.hidden&&!self?.gameId&&!window.GaicaniCityGames?.active&&!window.GaicaniCityGames?.blocksMovement&&!window.GaicaniArcadeUI?.blocksMovement);
 button.hidden=!available;button.disabled=vehiclePending;hud.hidden=!available;
 if(!available)return;
 button.textContent=vehiclePending?"…":self.vehicleId?"F · Exit":"F · Get In";
 button.setAttribute("aria-label",self.vehicleId?"მანქანიდან გადმოსვლა":"მანქანის მართვა — "+v.name);
 document.getElementById("vehicleModel").textContent=v.model;
 document.getElementById("vehicleStatus").textContent=(self.vehicleId?(self.vehicleSeat===0?"Driver · ":"Passenger · "):"Get In · ")+(v.seats||[]).filter(s=>s.playerId).map(s=>s.name).join(", ")+" · "+(v.seats||[]).filter(s=>!s.playerId).length+" seats free";
}
document.getElementById("vehicleButton").addEventListener("click",toggleVehicle);
function drawStreetVehicles(now,dt,chars){
 fleet.forEach(v=>{
  const driver=v.driverId===self?.id?self:remote.get(v.driverId),following=1-Math.exp(-dt*18);
  const tx=driver&&!driver.interiorId&&!driver.rideId?driver.x:v.x,ty=driver&&!driver.interiorId&&!driver.rideId?driver.y:v.y;
  v.displayX+=(tx-v.displayX)*following;v.displayY+=(ty-v.displayY)*following;
  if(v.driverId===self?.id){v.displayX=self.x;v.displayY=self.y}
  if(!inView(v.displayX,v.displayY,100))return;
  chars.push({kind:"vehicle",x:v.displayX,y:v.displayY,vehicle:Object.assign({},v,{dir:driver?.dir||v.dir,angle:v.driverId===self?.id?self.vehicleAngle:v.angle}),self:v.id===self?.vehicleId,driverName:driver?.name||selfName,available:v.seats?.some(s=>!s.playerId)&&self&&!self.vehicleId&&Math.hypot(v.x-self.x,v.y-self.y)<=90});
 });
}
for(const id of ["neon-casino","arcade-palace"]){const b=W.buildings.find(b=>b.id===id),marker=document.querySelector(id==="neon-casino"?".city-map-marker.casino":".city-map-marker.arcade");if(marker){marker.style.left=(b.x+b.w/2)/W.width*100+"%";marker.style.top=(b.y+b.h/2)/W.height*100+"%";}}
function drawMini(){const w=mini.width,h=mini.height,sx=w/W.width,sy=h/W.height;mctx.clearRect(0,0,w,h);mctx.fillStyle="#11152a";mctx.fillRect(0,0,w,h);mctx.fillStyle="#102a48";mctx.fillRect(2510*sx,0,135*sx,h);mctx.fillStyle="#36334b";mctx.fillRect(2645*sx,0,(W.width-2645)*sx,h);mctx.fillStyle="#34364d";W.roads.forEach(r=>mctx.fillRect(r.x*sx,r.y*sy,r.w*sx,r.h*sy));mctx.fillStyle="#214e47";mctx.fillRect(W.garden.bounds.x*sx,W.garden.bounds.y*sy,W.garden.bounds.w*sx,W.garden.bounds.h*sy);mctx.fillStyle="#b45999";mctx.fillRect(W.garden.danceFloor.x*sx,W.garden.danceFloor.y*sy,W.garden.danceFloor.w*sx,W.garden.danceFloor.h*sy);mctx.fillStyle="#746879";W.buildings.forEach(b=>mctx.fillRect(b.x*sx,b.y*sy,b.w*sx,b.h*sy));fleet.forEach(v=>{mctx.fillStyle=v.driverId?"#6fffe0":"#ffd58b";mctx.fillRect(v.x*sx-1.5,v.y*sy-1.5,3,3)});remote.forEach(p=>{if(!p.interiorId&&!p.rideId){mctx.fillStyle="#63f4d1";mctx.fillRect(p.x*sx-1,p.y*sy-1,3,3)}});if(self&&!interior&&!ride){mctx.fillStyle="#ff65d0";mctx.fillRect(self.x*sx-2,self.y*sy-2,5,5);mctx.strokeStyle="#ffeaff";mctx.strokeRect(self.x*sx-3,self.y*sy-3,7,7)}}
function drawAvatar(x,y,name,color,dir,action,isSelf,now,message,messageUntil){
 const moving=action==="walk",gait=moving?Math.sin(isSelf?(self?.walkPhase||0):now/130):0,step=moving&&gait>0?1:0,bob=moving?-Math.abs(gait):0;
 ctx.fillStyle="rgba(0,0,0,.52)";ctx.beginPath();ctx.ellipse(x,y+8,14,5,0,0,Math.PI*2);ctx.fill();
 if(moving){ctx.globalAlpha=.24;ctx.fillStyle="#ff62d0";ctx.fillRect(x-12,y+9,24,2);ctx.globalAlpha=1}
 ctx.fillStyle="#13131f";ctx.fillRect(x-8,y-21+bob,16,14);
 ctx.fillStyle="#f0bd99";ctx.fillRect(x-6,y-20+bob,12,10);
 ctx.fillStyle="#2d1c31";ctx.fillRect(x-7,y-22+bob,14,5);ctx.fillRect(x-7,y-18+bob,2,4);
 if(dir==="down"||dir==="left"||dir==="right"){const eyeX=dir==="left"?x-5:dir==="right"?x+3:x-4;ctx.fillStyle="#fff1d8";ctx.fillRect(eyeX,y-16+bob,2,2);if(dir==="down"){ctx.fillRect(x+2,y-16+bob,2,2);ctx.fillStyle="#4a2733";ctx.fillRect(x-1,y-12+bob,2,1)}}
 ctx.fillStyle=color||"#b77aff";ctx.fillRect(x-9,y-9+bob,18,15);
 ctx.fillStyle="rgba(255,255,255,.45)";ctx.fillRect(x-5,y-7+bob,3,2);ctx.fillRect(x+2,y-7+bob,3,2);
 const armSwing=moving?Math.round(gait*2):0;ctx.fillStyle="#eeb994";ctx.fillRect(x-11,y-7+bob+armSwing,3,9);ctx.fillRect(x+8,y-7+bob-armSwing,3,9);
 ctx.fillStyle="#242237";ctx.fillRect(x-7,y+6+bob,5,5);ctx.fillRect(x+2,y+6+bob,5,5);
 ctx.fillStyle="#28223a";ctx.fillRect(x-7,y+10+bob+armSwing,5,4);ctx.fillRect(x+2,y+10+bob-armSwing,5,4);
 const lw=Math.max(42,Math.min(112,name.length*7+15));ctx.fillStyle="rgba(9,8,24,.9)";ctx.fillRect(x-lw/2,y-45+bob,lw,15);ctx.strokeStyle=isSelf?"#ff71d5":"rgba(126,240,255,.55)";ctx.strokeRect(x-lw/2,y-45+bob,lw,15);label(ctx,name,x,y-37+bob,8,"#f8f4ff","center");
 if(action==="phone"){ctx.fillStyle="#eeb994";ctx.fillRect(x+7,y-6+bob,4,8);ctx.fillStyle="#141528";ctx.fillRect(x+8,y-2+bob,9,12);ctx.fillStyle="#6beaff";ctx.fillRect(x+10,y+1+bob,5,6);ctx.fillStyle="#ff62d0";ctx.fillRect(x+10,y+7+bob,5,2)}
 if(action&&action!=="idle"&&action!=="walk")label(ctx,action==="wave"?"👋":action==="dance"?"♫":action==="wine"?"🍷":action==="phone"?"📱":action==="sad"?"😿":"✋",x,y-60+bob,13,"#fff","center");
 if(message&&messageUntil>Date.now())drawMessageBubble(x,y,message)
}
function drawAnimalSprite(kind,x,y,color,now,phase,dir){
 const gait=Math.sin(now/115+phase),bob=Math.abs(gait)*.7;ctx.save();ctx.translate(Math.round(x),Math.round(y-bob));if(dir<0)ctx.scale(-1,1);
 ctx.fillStyle="rgba(0,0,0,.52)";ctx.beginPath();ctx.ellipse(0,2,kind==="dog"?14:10,3,0,0,Math.PI*2);ctx.fill();
 if(kind==="cat"){
  ctx.strokeStyle=color;ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(-8,-9);ctx.quadraticCurveTo(-16,-17+gait*2,-12,-21+gait*2);ctx.stroke();
  ctx.fillStyle=color;ctx.fillRect(-9,-13,14,7);ctx.fillRect(2,-16,8,8);ctx.beginPath();ctx.moveTo(3,-15);ctx.lineTo(4,-21);ctx.lineTo(8,-16);ctx.fill();ctx.beginPath();ctx.moveTo(8,-15);ctx.lineTo(11,-20);ctx.lineTo(12,-14);ctx.fill();
  ctx.fillStyle="#f3c9a4";ctx.fillRect(7,-13,5,3);ctx.fillStyle="#171523";ctx.fillRect(8,-15,1,2);ctx.fillRect(11,-15,1,2);ctx.fillStyle="#f6cf7d";ctx.fillRect(-4,-5+gait,2,6);ctx.fillRect(2,-5-gait,2,6);ctx.fillStyle="#d6a5ac";ctx.fillRect(9,-11,2,1);
 }else{
  ctx.strokeStyle=color;ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(-10,-10);ctx.quadraticCurveTo(-17,-17-gait*2,-15,-21-gait*2);ctx.stroke();
  ctx.fillStyle=color;ctx.fillRect(-10,-15,19,9);ctx.fillRect(5,-17,10,9);ctx.fillRect(12,-14,6,4);ctx.fillRect(7,-18,4,5);ctx.fillStyle="#372536";ctx.fillRect(7,-17,2,4);ctx.fillStyle="#f3c29a";ctx.fillRect(15,-14,2,2);ctx.fillStyle="#1a1721";ctx.fillRect(13,-16,2,2);ctx.fillStyle="#ff5b87";ctx.fillRect(3,-10,5,2);ctx.fillStyle="#63424a";ctx.fillRect(-7,-6+gait,3,6);ctx.fillRect(-1,-6-gait,3,6);ctx.fillRect(7,-7-gait,3,7);
 }
 ctx.restore();
}
function drawNpc(n,now){if(n.kind==="cat"){const sway=Math.sin(now/830+n.x)*2;drawAnimalSprite("cat",n.x+sway,n.y,n.color,now,n.x*.01,sway<0?-1:1);return}const stroll=n.wander?Math.sin(now/1650+n.x)*7:Math.sin(now/650+n.x)*.6,b=Math.sin(now/380+n.x)*.7,step=n.wander?Math.sin(now/145+n.y)*2:0,x=n.x+stroll,y=n.y;ctx.fillStyle="rgba(0,0,0,.52)";ctx.beginPath();ctx.ellipse(x,y+8,11,4,0,0,Math.PI*2);ctx.fill();ctx.fillStyle="#20152a";ctx.fillRect(x-6,y-17+b,12,11);ctx.fillStyle=n.color;ctx.fillRect(x-7,y-7+b,14,13);ctx.fillStyle="#2c2437";ctx.fillRect(x-6,y+6+step,5,8);ctx.fillRect(x+1,y+6-step,5,8);ctx.fillStyle="#efc49d";ctx.fillRect(x-4,y-17+b,8,8);ctx.fillStyle="#20192b";ctx.fillRect(x-6,y-19+b,12,4);if(n.wander){ctx.fillStyle="#f1d37e";ctx.fillRect(x-10,y-3+b,3,4);ctx.fillRect(x+7,y-3+b,3,4)}}
function drawBus(x,y,color,route,reverse){ctx.save();ctx.translate(Math.round(x),Math.round(y));if(reverse)ctx.scale(-1,1);ctx.fillStyle="rgba(0,0,0,.62)";ctx.fillRect(-48,13,98,6);ctx.fillStyle="#11131e";ctx.fillRect(-49,-15,98,31);ctx.fillStyle=color;ctx.fillRect(-47,-18,94,29);ctx.fillStyle="#171827";ctx.fillRect(-44,-16,84,4);ctx.fillStyle="#f1d1a0";ctx.fillRect(-42,-12,81,2);for(let i=0;i<6;i++){const wx=-40+i*13;ctx.fillStyle="#102333";ctx.fillRect(wx,-8,10,10);ctx.fillStyle=i%2?"#56dce8":"#8be7ed";ctx.globalAlpha=.86;ctx.fillRect(wx+1,-7,8,7);ctx.globalAlpha=1;ctx.fillStyle="#4d586b";ctx.fillRect(wx+9,-8,1,11)}ctx.fillStyle="#293141";ctx.fillRect(28,-9,10,20);ctx.fillStyle="#c7dce4";ctx.fillRect(30,-7,6,7);ctx.fillStyle="#142033";ctx.fillRect(34,-5,1,3);ctx.fillStyle="#111421";ctx.fillRect(-45,10,17,8);ctx.fillRect(25,10,17,8);ctx.fillStyle="#858795";ctx.fillRect(-41,12,8,3);ctx.fillRect(29,12,8,3);ctx.fillStyle="#ffdc77";ctx.fillRect(43,-7,3,4);ctx.fillRect(43,6,3,4);ctx.fillStyle="#f2efff";ctx.font="700 7px system-ui,sans-serif";ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillText(route,0,-13);ctx.fillStyle="#ff59c4";ctx.globalAlpha=.26;ctx.fillRect(-49,17,98,3);ctx.globalAlpha=1;ctx.restore()}
function drawMessageBubble(x,y,text){
 const maxWidth=212,lines=[];ctx.save();ctx.font='700 8px "Noto Sans Georgian",sans-serif';
 String(text||"").trim().split(/\s+/).forEach(word=>{if(!word)return;const candidate=lines.length?lines[lines.length-1]+" "+word:word;if(ctx.measureText(candidate).width>maxWidth-18&&lines.length)lines.push(word);else if(lines.length)lines[lines.length-1]=candidate;else lines.push(candidate)});
 if(!lines.length){ctx.restore();return}
 if(lines.length>4){lines.length=4;lines[3]=lines[3].slice(0,24)+"…"}
 const width=Math.min(maxWidth,Math.max(50,Math.ceil(Math.max(...lines.map(line=>ctx.measureText(line).width))+18))),height=10+lines.length*10,top=y-55-height;
 ctx.fillStyle="rgba(9,8,24,.96)";ctx.fillRect(x-width/2,top,width,height);ctx.strokeStyle="#ff70d1";ctx.lineWidth=1;ctx.strokeRect(x-width/2+.5,top+.5,width-1,height-1);
 ctx.beginPath();ctx.moveTo(x-5,top+height-1);ctx.lineTo(x+5,top+height-1);ctx.lineTo(x,top+height+5);ctx.closePath();ctx.fillStyle="rgba(9,8,24,.96)";ctx.fill();ctx.strokeStyle="#ff70d1";ctx.beginPath();ctx.moveTo(x-5,top+height-1);ctx.lineTo(x,top+height+5);ctx.lineTo(x+5,top+height-1);ctx.stroke();
 ctx.fillStyle="#fff3fb";ctx.textAlign="center";ctx.textBaseline="middle";lines.forEach((line,i)=>ctx.fillText(line,x,top+6+i*10,width-12));ctx.restore();
}
function drawPuddles(now){for(let i=0;i<52;i++){const x=(i*271+45)%W.width,y=(i*193+111)%W.height;if(!inView(x,y,60)||(phoneMode&&i%2))continue;ctx.globalAlpha=.07+(Math.sin(now/490+i)+1)*.04;ctx.fillStyle=Math.sin(now/700+i*1.9)>0?"#cb47b8":"#35bada";ctx.fillRect(x,y,18+(i%5)*9,2);ctx.fillRect(x+5,y+4,9+(i%3)*4,1)}ctx.globalAlpha=1}
function drawCityTraffic(now){const span=W.width+140,t=now*.032;let x=((t+110)%span)-70;if(inView(x,378,100))drawBus(x,378,"#b72e5a","12 · რუსთაველი",false);let x2=((W.width-now*.026-460)%span+span)%span-70;if(inView(x2,1182,100))drawBus(x2,1182,"#287e9a","7 · ძველი თბილისი",true)}
function drawNeonLife(now){
 W.buildings.forEach((b,i)=>{
  if(!inView(b.x+b.w/2,b.y+b.h/2,Math.max(b.w,b.h)/2+35))return;
  const sign=window.GaicaniCityArchitecture.signBounds(b);
  ctx.globalAlpha=.12+.12*(Math.sin(now/370+i*1.71)+1)/2;
  ctx.strokeStyle=b.color;ctx.shadowColor=b.color;ctx.shadowBlur=phoneMode?0:14+6*Math.sin(now/520+i);ctx.lineWidth=1.2;
  ctx.strokeRect(sign.x+1,sign.y+1,sign.w-2,sign.h-2);ctx.shadowBlur=0;
  ctx.globalAlpha=.035+.025*(Math.sin(now/350+i*2)+1)/2;ctx.fillStyle=b.color;
  ctx.fillRect(b.x+4,b.y+b.h+7,b.w-8,3);
 });ctx.globalAlpha=1;ctx.shadowBlur=0;
}
function drawCasino(now,dt){
 const w=canvas.clientWidth,h=canvas.clientHeight,c=W.casino;
 camera.x=Math.round(Math.max(0,Math.min(c.width-w,(self?.casinoX||c.spawn.x)-w/2)));
 camera.y=Math.round(Math.max(0,Math.min(c.height-h,(self?.casinoY||c.spawn.y)-h/2)));
 const offsetX=Math.max(0,(w-c.width)/2),offsetY=Math.max(0,(h-c.height)/2);
 ctx.fillStyle="#090815";ctx.fillRect(0,0,w,h);ctx.save();ctx.translate(offsetX-camera.x,offsetY-camera.y);
 ctx.fillStyle="#221629";ctx.fillRect(0,0,c.width,c.height);
 for(let y=82;y<c.height-25;y+=46)for(let x=48;x<c.width-42;x+=46){ctx.fillStyle=((x/46+y/46)%2)?"#30203a":"#291a34";ctx.fillRect(x,y,43,43);ctx.globalAlpha=.13;ctx.fillStyle=(x+y)%3?"#ff61d3":"#65eaff";ctx.fillRect(x+5,y+5,32,2);ctx.globalAlpha=1}
 ctx.fillStyle="#130e22";ctx.fillRect(25,24,c.width-50,48);ctx.strokeStyle="#fd64d2";ctx.lineWidth=3;ctx.shadowColor="#fc4cca";ctx.shadowBlur=18;ctx.strokeRect(27,26,c.width-54,44);ctx.shadowBlur=0;
 label(ctx,"ღამის კაზინო",c.width/2,44,20,"#ffe7ff","center");label(ctx,"NEON CASINO · OPEN ALL NIGHT",c.width/2,94,10,"#8df6ff","center");
 for(let i=0;i<4;i++){const x=70+i*225;ctx.globalAlpha=.12+.06*Math.sin(now/370+i);ctx.fillStyle=i%2?"#61eaff":"#ff64d3";ctx.beginPath();ctx.ellipse(x+55,302,80,22,0,0,Math.PI*2);ctx.fill()}ctx.globalAlpha=1;
 const themes=[{icon:"🌙",color:"#ff56cb"},{icon:"💾",color:"#57eaff"},{icon:"🐈",color:"#ffc56b"},{icon:"🚕",color:"#ab85ff"}];
 c.stations.filter(s=>s.type==="slot").forEach((s,i)=>{const x=s.x,y=125,t=themes[i];ctx.fillStyle="#080713";ctx.fillRect(x-47,y-56,94,120);ctx.fillStyle="#432448";ctx.fillRect(x-41,y-52,82,111);ctx.fillStyle="#16152b";ctx.fillRect(x-35,y-45,70,64);ctx.strokeStyle=t.color;ctx.lineWidth=3;ctx.shadowColor=t.color;ctx.shadowBlur=15;ctx.strokeRect(x-34,y-44,68,61);ctx.shadowBlur=0;label(ctx,t.icon,x,y-13,30,"#fff","center");ctx.fillStyle="#f4cf75";ctx.fillRect(x-25,y+25,50,6);ctx.fillStyle="#11101c";ctx.fillRect(x-33,y+38,66,17);ctx.fillStyle=t.color;ctx.fillRect(x-29,y+42,58,3);ctx.fillStyle="#81778e";ctx.fillRect(x-3,y+57,6,10);ctx.fillStyle="#0b0a15";ctx.fillRect(x-42,y+67,84,5);ctx.globalAlpha=.55+.4*Math.sin(now/200+i);ctx.fillStyle=t.color;ctx.fillRect(x-35,y-50,8,3);ctx.fillRect(x+27,y-50,8,3);ctx.globalAlpha=1;label(ctx,s.label,x,y+82,9,"#f7dff7","center")});
 c.stations.filter(s=>s.type==="poker"||s.type==="blackjack").forEach((s,i)=>{const x=s.x,y=s.y-82;ctx.fillStyle="#140d1c";ctx.beginPath();ctx.ellipse(x,y+12,102,69,0,0,Math.PI*2);ctx.fill();ctx.fillStyle=i?"#6c233d":"#175544";ctx.beginPath();ctx.ellipse(x,y,91,55,0,0,Math.PI*2);ctx.fill();ctx.strokeStyle=i?"#ff6ba8":"#6affcb";ctx.lineWidth=3;ctx.shadowColor=ctx.strokeStyle;ctx.shadowBlur=10;ctx.stroke();ctx.shadowBlur=0;label(ctx,i?"BLACKJACK":"POKER",x,y-3,11,"#fff3dc","center");for(let k=0;k<3;k++){ctx.fillStyle=["#ffe37b","#e45aa9","#55dfe9"][k];ctx.beginPath();ctx.arc(x-22+k*22,y+20,7,0,Math.PI*2);ctx.fill()}for(let k=0;k<4;k++){ctx.fillStyle="#4e354b";ctx.fillRect(x-72+k*48,y+55,25,10);ctx.fillStyle="#ae859f";ctx.fillRect(x-70+k*48,y+56,21,2)}});
 ctx.fillStyle="#54294c";ctx.fillRect(778,322,154,48);ctx.fillStyle="#1a1125";ctx.fillRect(786,327,138,35);ctx.fillStyle="#fb77d2";ctx.fillRect(797,334,116,3);label(ctx,"BAR · 99",855,348,12,"#fff","center");ctx.fillStyle="#e9ad62";ctx.fillRect(800,376,110,5);ctx.fillStyle="#432b42";ctx.fillRect(815,382,7,34);ctx.fillRect(885,382,7,34);
 drawAvatar(845,475,"Dato · დილერი","#e4a15a","down","idle",false,now);label(ctx,"«კარგი ხელი მოთმინებას უყვარს»",845,449,8,"#ffe7bd","center");
 for(let i=0;i<6;i++){const x=86+i*158;ctx.fillStyle="#17111f";ctx.fillRect(x,322,12,44);ctx.fillStyle=i%2?"#6cecff":"#ff71d1";ctx.globalAlpha=.45+.4*Math.sin(now/240+i);ctx.fillRect(x+3,328,6,27);ctx.globalAlpha=1}
 const chars=[];if(self)chars.push({x:self.casinoX||c.spawn.x,y:self.casinoY||c.spawn.y,name:selfName,color:"#bd75ef",dir:self.dir,action:self.action,self:true,message:self.message,messageUntil:self.messageUntil,gardenDance:self.gardenDance,gardenSeatId:self.gardenSeatId});
 remote.forEach(p=>{if(p.interiorId!=="neon-casino"||!Number.isFinite(p.casinoX)||!Number.isFinite(p.casinoY))return;const f=1-Math.exp(-Math.min(.05,dt||.016)*20);p.casinoX+=(p.targetCasinoX-p.casinoX)*f;p.casinoY+=(p.targetCasinoY-p.casinoY)*f;chars.push({x:p.casinoX,y:p.casinoY,name:p.name,color:p.color,dir:p.dir,action:p.action==="idle"&&Math.hypot(p.targetCasinoX-p.casinoX,p.targetCasinoY-p.casinoY)>.7?"walk":p.action,self:false,message:p.message,messageUntil:p.messageUntil})});
 chars.sort((a,b)=>a.y-b.y);chars.forEach(p=>drawAvatar(Math.round(p.x),Math.round(p.y),p.name,p.color,p.dir,p.action,p.self,now,p.message,p.messageUntil));
 if(nearby&&nearby.type==="casinoStation"){ctx.strokeStyle="#fff4a1";ctx.lineWidth=2;ctx.setLineDash([5,4]);ctx.strokeRect(nearby.object.x-42,nearby.object.y-58,84,22);ctx.setLineDash([])}
 ctx.restore();label(ctx,"E / ✦  მაგიდები · სლოტები · საუბარი",w/2,h-23,11,"#ffe1fb","center");
}
function drawArcadeInterior(now){const w=canvas.clientWidth,h=canvas.clientHeight,pulse=.72+.28*Math.sin(now/240);const bg=ctx.createLinearGradient(0,0,w,h);bg.addColorStop(0,"#111226");bg.addColorStop(.52,"#241337");bg.addColorStop(1,"#10172e");ctx.fillStyle=bg;ctx.fillRect(0,0,w,h);ctx.fillStyle="#100e20";ctx.fillRect(0,0,w,h*.57);ctx.fillStyle="#301c39";ctx.fillRect(0,h*.57,w,h*.43);for(let x=-h;x<w+h;x+=54){ctx.strokeStyle="#7c4b862b";ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(w/2+(x-w/2)*.16,h*.57);ctx.lineTo(x,h);ctx.stroke()}for(let x=0;x<w;x+=58){ctx.fillStyle=(x/58|0)%2?"#32223d":"#3c2441";ctx.fillRect(x,h*.57,56,h*.43);ctx.globalAlpha=.13;ctx.fillStyle=(x/58|0)%2?"#ff47cb":"#44eaff";ctx.fillRect(x,h*.57,55,3);ctx.globalAlpha=1}ctx.save();ctx.globalAlpha=.26+.13*pulse;ctx.shadowColor="#43eaff";ctx.shadowBlur=30;ctx.fillStyle="#31dffb";ctx.fillRect(w*.12,h*.19,w*.76,3);ctx.restore();label(ctx,"PIXEL PALACE",w/2,h*.105,Math.max(20,Math.min(34,w*.055)),"#fff0ff","center");label(ctx,"INSERT COIN · PICK YOUR GAME",w/2,h*.165,Math.max(9,Math.min(14,w*.022)),"#79f5ff","center");const machines=[["PAC-MAN","#ffe35c"],["SNAKE","#70ff9d"],["TETRIS","#67caff"],["PONG","#ff68d5"]];machines.forEach((m,i)=>{const x=w*(.14+i*.205),mw=Math.min(112,w*.17),top=h*.29,mh=h*.38;ctx.fillStyle="#080914";ctx.fillRect(x-4,top-4,mw+8,mh+8);ctx.fillStyle="#322643";ctx.fillRect(x,top,mw,mh);ctx.save();ctx.shadowColor=m[1];ctx.shadowBlur=14+8*pulse;ctx.strokeStyle=m[1];ctx.lineWidth=2;ctx.strokeRect(x+3,top+3,mw-6,mh-6);ctx.restore();ctx.fillStyle="#080c19";ctx.fillRect(x+9,top+12,mw-18,mh*.53);ctx.fillStyle="#111a2b";ctx.fillRect(x+13,top+16,mw-26,mh*.53-8);if(i===0){ctx.fillStyle=m[1];for(let d=0;d<7;d++){ctx.beginPath();ctx.arc(x+20+d*(mw-40)/6,top+mh*.32,2,0,Math.PI*2);ctx.fill()}ctx.beginPath();ctx.arc(x+mw*.53,top+mh*.32,7,Math.PI*.18,Math.PI*1.82);ctx.lineTo(x+mw*.53,top+mh*.32);ctx.fill()}else if(i===1){ctx.strokeStyle=m[1];ctx.lineWidth=4;ctx.beginPath();ctx.moveTo(x+mw*.25,top+mh*.27);ctx.lineTo(x+mw*.55,top+mh*.27);ctx.lineTo(x+mw*.55,top+mh*.4);ctx.lineTo(x+mw*.4,top+mh*.4);ctx.stroke();ctx.fillStyle="#ffdd68";ctx.fillRect(x+mw*.7,top+mh*.42,4,4)}else if(i===2){for(let q=0;q<9;q++){ctx.fillStyle=["#53dff9","#e452cb","#ffe06a","#a67bff"][q%4];ctx.fillRect(x+mw*.25+(q%3)*7,top+mh*.26+Math.floor(q/3)*7,6,6)}}else{ctx.fillStyle="#ff75dc";ctx.fillRect(x+mw*.21,top+mh*.23,3,mh*.25);ctx.fillRect(x+mw*.76,top+mh*.34,3,mh*.25);ctx.fillStyle="#e7e5ff";ctx.fillRect(x+mw*.45,top+mh*.33,4,4)}ctx.fillStyle="#a58fac";ctx.fillRect(x+mw*.32,top+mh*.67,mw*.36,3);ctx.fillStyle="#080a14";ctx.fillRect(x+mw*.25,top+mh*.78,mw*.5,13);ctx.fillStyle=m[1];ctx.fillRect(x+mw*.33,top+mh*.8,mw*.34,2);label(ctx,m[0],x+mw/2,top+mh+15,Math.max(9,Math.min(13,w*.021)),m[1],"center")});label(ctx,"GEORGIAN ARCADE · EST. 1999",w/2,h*.91,Math.max(9,Math.min(13,w*.02)),"#c8b4e7","center");const visitors=Array.from(remote.values()).filter(p=>p.interiorId==="arcade-palace").slice(0,6);visitors.forEach((p,i)=>drawAvatar(w*(.23+i*.105),h*.82,p.name,p.color,"down",p.action||"idle",false,now));drawAvatar(w*.77,h*.82,selfName,"#bd75ef","down","idle",true,now)} function drawInterior(now,dt){if(interior.id==="arcade-palace"){drawArcadeInterior(now);return}if(interior.id==="neon-casino")drawCasino(now,dt)}
let lastFrameAt=0;
function applyPredictedState(){
 const state=predictor.getState();if(!state||!self)return;
 const casino=state.mode==="casino",xKey=casino?"casinoX":"x",yKey=casino?"casinoY":"y";
 self[xKey]=state.x;self[yKey]=state.y;self.dir=state.dir;
 self.vehicleId=state.vehicleId;self.vehicleSeat=state.vehicleSeat;self.vehicleAngle=state.vehicleAngle;self.vehicleSpeed=state.vehicleSpeed;
 if(!(self.actionUntil>Date.now()))self.action=state.action;
}
function acceptMotion(view){
 if(!self||!view)return;
 const previousEpoch=predictor.getEpoch();
 if(!predictor.accept(view))return;
 if("gardenDance" in view){self.gardenDance=view.gardenDance;self.gardenSeatId=view.gardenSeatId;self.gardenSeatKind=view.gardenSeatKind}
 self[view.mode==="casino"?"serverCasinoX":"serverX"]=view.x;
 self[view.mode==="casino"?"serverCasinoY":"serverY"]=view.y;
 if(previousEpoch!==view.epoch)motionInput={x:0,y:0};
 applyPredictedState();
}
function movementAllowed(){
 return self&&joined&&!ride&&!(self.vehicleId&&self.vehicleSeat>0)&&(!interior||interior.id==="neon-casino")&&cityDialog.hidden&&playerCard.hidden&&cityMessageComposer.hidden&&
  !window.GaicaniCityGames?.active&&!window.GaicaniCityGames?.blocksMovement&&!window.GaicaniCasinoUI?.blocksMovement&&!window.GaicaniArcadeUI?.blocksMovement;
}
function queueMotion(x,y,dt){
 const before=predictor.getState();if(!before)return;
 const oldX=before.x,oldY=before.y,state=predictor.predict({x,y},dt);
 if(!state)return;
 motionInput={x,y};if(Math.hypot(x,y)>.001){self.gardenDance=null;self.gardenSeatId=null;self.gardenSeatKind=null}self.walkPhase=(self.walkPhase||0)+Math.hypot(state.x-oldX,state.y-oldY)*.2;
 applyPredictedState();
}
function flushMotion(immediate){
 if(!socket?.connected||!joined||!self||predictor.getEpoch()===null)return;
 const now=performance.now();if(!immediate&&now-lastMotionSendAt<48)return;
 const batch=predictor.drain();if(!batch)return;
 lastMotionSendAt=now;const requestSelf=self;
 socket.emit("city:motion",batch,result=>{if(joined&&self===requestSelf)acceptMotion(result)});
}
function stepLocalPlayer(dt){
 if(!self||!joined||!predictor.getState())return;
 const allowed=movementAllowed(),x=allowed?keys.x:0,y=allowed?keys.y:0;
 if(Math.hypot(x,y)>.001)queueMotion(x,y,Math.min(50,dt*1000));
 else if(self.vehicleId&&self.vehicleSeat===0&&Math.abs(predictor.getState().vehicleSpeed)>.01){queueMotion(0,0,Math.min(50,dt*1000));flushMotion(false)}
 else if(Math.hypot(motionInput.x,motionInput.y)>.001){queueMotion(0,0,1);flushMotion(true)}
 else if(!(self.actionUntil>Date.now())&&!predictor.getState().blocked)self.action="idle";
}
function draw(now){
 if(document.hidden){lastFrameAt=0;requestAnimationFrame(draw);return}
 const w=viewWidth,h=viewHeight,d=renderDpr,dt=lastFrameAt?Math.min(.05,Math.max(0,(now-lastFrameAt)/1000)):.016;lastFrameAt=now;
 ctx.setTransform(d,0,0,d,0,0);ctx.imageSmoothingEnabled=false;
 Audio.update({x:self?.x||0,y:self?.y||0,inGarden:!!(self&&!interior&&!ride&&W.gardenContains(self.x,self.y)),interior:!!interior||!!ride,gardenEpoch:Garden.getEpoch(),garden:W.garden,carRadio:self?.vehicleId?{vehicleId:self.vehicleId,station:fleet.get(self.vehicleId)?.radio||"off",epoch:fleet.get(self.vehicleId)?.radioEpoch}:null});
 if(interior){stepLocalPlayer(dt,now);drawInterior(now,dt);requestAnimationFrame(draw);return}
 stepLocalPlayer(dt,now);
 if(ride){drawRideScene(w,h,now);requestAnimationFrame(draw);return}
 if(self){camera.x=Math.round(Math.max(0,Math.min(W.width-w,self.x-w/2)));camera.y=Math.round(Math.max(0,Math.min(W.height-h,self.y-h/2)))}
 else{camera.x=Math.max(0,W.width/2-w/2);camera.y=Math.max(0,W.height/2-h/2)}
 ctx.fillStyle="#101020";ctx.fillRect(0,0,w,h);ctx.drawImage(staticMap,camera.x,camera.y,Math.min(w,W.width-camera.x),Math.min(h,W.height-camera.y),0,0,Math.min(w,W.width-camera.x),Math.min(h,W.height-camera.y));ctx.save();ctx.translate(-camera.x,-camera.y);drawPuddles(now);drawNeonLife(now);Garden.drawDynamic(ctx,W,now,{inView,phone:phoneMode});
 rain.forEach((r,i)=>{if(phoneMode&&i>=18)return;r.y+=r.speed*dt;r.x-=18*dt;if(r.y>W.height){r.y=0;r.x=Math.random()*W.width}if(r.x<0)r.x=W.width;if(!inView(r.x,r.y,24))return;ctx.globalAlpha=r.alpha;ctx.fillStyle="#a9d8ff";ctx.fillRect(r.x,r.y,1,r.len)});ctx.globalAlpha=1;
 W.npcs.forEach(n=>{if(inView(n.x,n.y))drawNpc(n,now)});drawCitySignals(now);const chars=[];if(self&&!self.vehicleId)chars.push({x:self.x,y:self.y,name:selfName,color:"#bd75ef",dir:self.dir,action:self.action,self:true,message:self.message,messageUntil:self.messageUntil,gardenDance:self.gardenDance,gardenSeatId:self.gardenSeatId});
 remote.forEach(p=>{if(!p.interiorId&&!p.rideId){const follow=1-Math.exp(-dt*20);p.x+=(p.targetX-p.x)*follow;p.y+=(p.targetY-p.y)*follow;p.drawAction=p.action==="idle"&&Math.hypot(p.targetX-p.x,p.targetY-p.y)>.7?"walk":p.action;if(!p.vehicleId&&inView(p.x,p.y))chars.push(p)}});
 (W.animals||[]).forEach(a=>{if(!inView(a.x,a.y))return;const phase=a.phase||0,x=a.x+Math.sin(now/1650+phase)*(a.roamX||0),y=a.y+Math.cos(now/1380+phase)*(a.roamY||0);chars.push({kind:"animal",animalKind:a.kind,x:x,y:y,color:a.color,phase:phase,dir:Math.cos(now/1650+phase)<0?-1:1})});
 W.garden.npcs.forEach((n,i)=>{if(!inView(n.x,n.y))return;const active=!!n.dance&&Math.floor(now/12000+i)%5!==0;chars.push({x:n.x,y:n.y,name:n.name,color:n.color,dir:"down",action:"idle",npc:true,gardenDance:active?{move:n.dance,startedAt:Garden.getEpoch(),sync:true}:null})});
 buildingSprites.forEach(item=>{const b=item.b;if(inView(b.x+b.w/2,b.y+b.h/2,Math.max(b.w,b.h)+100))chars.push({kind:'building',x:b.x,y:b.y+b.h,item});});
 W.furniture.forEach(o=>{if(inView(o.x,o.y,90))chars.push({kind:'furniture',x:o.x,y:o.y,object:o});});
 W.garden.trees.forEach(o=>{if(inView(o.x,o.y,90))chars.push({kind:'gardenTree',x:o.x,y:o.y});});
 drawStreetVehicles(now,dt,chars);
 chars.sort((a,b)=>a.y-b.y);chars.forEach(p=>{if(p.kind==="building"){ctx.drawImage(p.item.image,p.item.b.x-60,p.item.b.y-100);return}if(p.kind==="furniture"){window.GaicaniCityRoads.furniture(ctx,p.object);return}if(p.kind==="gardenTree"){Garden.drawTree(ctx,p.x,p.y);return}if(!p.kind&&Array.from(fleet.values()).some(v=>v.transition?.kind==="exit"&&v.transition.playerId===(p.self?self?.id:p.id)&&Date.now()-v.transition.at<v.transition.duration))return;if(p.kind==="vehicle"){window.GaicaniCityVehicleArt.draw(ctx,p.vehicle,now,{x:p.x,y:p.y,self:p.self,driverName:p.driverName,available:p.available});return}if(p.kind==="animal"){drawAnimalSprite(p.animalKind,Math.round(p.x),Math.round(p.y),p.color,now,p.phase,p.dir);return}if(Garden.drawPerson(ctx,p,now)){if(p.message&&p.messageUntil>Date.now())drawMessageBubble(p.x,p.y,p.message);return}drawAvatar(Math.round(p.x),Math.round(p.y),p.name,p.color,p.dir,p.drawAction||p.action,p.self,now,p.message,p.messageUntil);if(p.actionUntil&&p.actionUntil<Date.now())p.action="idle"});
 if(nearby&&nearby.type==="player"){ctx.strokeStyle="#ff6bd4";ctx.lineWidth=2;ctx.strokeRect(nearby.object.x-16,nearby.object.y-27,32,42)}
 ctx.restore();if(now-lastMiniAt>(phoneMode?500:250)){drawMini();lastMiniAt=now}requestAnimationFrame(draw)
}
function target(){if(!self||ride||self.vehicleId)return null;let best=null,dist=102;function offer(type,o,x,y){const sx=interior?.id==="neon-casino"?self.casinoX:self.x,sy=interior?.id==="neon-casino"?self.casinoY:self.y,d=Math.hypot(x-sx,y-sy);if(d<dist){dist=d;best={type:type,object:o,distance:d}}}if(interior){if(interior.id!=="neon-casino")return null;W.casino.stations.forEach(s=>offer("casinoStation",s,s.x,s.y));remote.forEach(p=>{if(p.interiorId==="neon-casino"&&p.id!==self.id)offer("player",p,p.casinoX,p.casinoY)});return best}W.npcs.forEach(n=>offer("npc",n,n.x,n.y));W.garden.npcs.forEach(n=>offer("npc",n,n.x,n.y));W.garden.secrets.forEach(o=>offer("prop",o,o.x,o.y));W.garden.seats.forEach(o=>offer("gardenSeat",Object.assign({label:"დაჯდომა · "+o.kind},o),o.x,o.y));W.props.forEach(p=>offer("prop",p,p.x,p.y));W.buildings.filter(b=>b.enterable).forEach(b=>offer("building",b,b.x+b.w*.72+9,b.y+b.h+15));(W.landmarks||[]).forEach(l=>offer("landmark",l,l.interactX,l.interactY));notes.forEach(n=>offer("note",n,n.x,n.y));remote.forEach(p=>{if(!p.interiorId&&!p.rideId&&!p.vehicleId&&p.id!==self.id)offer("player",p,p.x,p.y)});return best}
function refresh(){refreshVehicle();nearby=target();const tip=document.getElementById("cityTip");if(nearby){const o=nearby.object,n=nearby.type==="npc"?o.name:nearby.type==="player"?o.name:nearby.type==="building"?o.name:nearby.type==="landmark"?o.name:nearby.type==="note"?"საიდუმლო წერილი":o.label;tip.textContent="E / ✦  "+n}else tip.textContent=self?.vehicleId?"F · გადმოსვლა — WASD / ისრები · მართვა":nearestVehicle()?"F · მანქანაში ჩაჯდომა — ქალაქი გელოდება":interior?.id==="neon-casino"?"დაათვალიერე სლოტები · იპოვე პოკერის მაგიდა · გაესაუბრე დილერს":"ქუჩის კუთხეში ძველი ტელეფონი რეკავს — იქნებ შენ გეძახის?";const d=self&&W.districtAt(self.x,self.y);if(d&&d.id!==lastDistrict){lastDistrict=d.id;locationPill.innerHTML="<b>"+d.name+"</b><span>2:17 AM · ყოველთვის ღამე</span>"}}
setInterval(refresh,160);
function closeDialog(){cityDialog.hidden=true}
function showDialog(k,title,message,actions){stopMovementInput();document.getElementById("dialogKicker").textContent=k||"ღამის ქალაქი";document.getElementById("dialogTitle").textContent=title||"";document.getElementById("dialogText").textContent=message||"";const box=document.getElementById("dialogActions");box.replaceChildren();(actions||[]).forEach(a=>{const b=document.createElement("button");b.type="button";b.textContent=a.label;b.addEventListener("click",a.run);box.appendChild(b)});cityDialog.hidden=false}
document.getElementById("dialogClose").addEventListener("click",closeDialog);document.getElementById("playerCardClose").addEventListener("click",()=>playerCard.hidden=true);
function leaveInterior(){if(!interior)return;window.GaicaniCasinoUI?.close?.();window.GaicaniArcadeUI?.close?.();interior=null;if(self)self.interiorId=null;document.getElementById("interiorExit").hidden=true;locationPill.innerHTML="<b>"+W.districtAt(self?self.x:420,self?self.y:440).name+"</b><span>2:17 AM · ყოველთვის ღამე</span>";if(socket)socket.emit("city:interior",{buildingId:null})}
document.getElementById("interiorExit").addEventListener("click",leaveInterior);

function open(t){if(t?.type==="gardenSeat"){Garden.command("city:garden:sit",{seatId:t.object.id});return}if(self?.vehicleId){toast("F · ჯერ მანქანიდან გადმოდი");return}if(!t){toast("ახლოს არაფერია — ცოტა გაისეირნე.");return}if(t.type==="casinoStation"){if(t.object.type==="slot")window.GaicaniCasinoUI?.open("slots",t.object.id);else if(t.object.type==="poker")window.GaicaniCasinoUI?.open("poker");else if(t.object.type==="blackjack")window.GaicaniCasinoUI?.open("blackjack");else showDialog("დილერი · დათო","კარგი ხელი მოთმინებას უყვარს","„თუ იღბალი დაიკარგა, ბარში ჰკითხე — იქ ყველა დაკარგული ნივთი ბოლოს პოულობს გზას.“",[{label:"🎰 სლოტები ვნახო",run:()=>{closeDialog();window.GaicaniCasinoUI?.open("slots","cat")}},{label:"გმადლობ, დათო",run:closeDialog}]);return}if(t.type==="note"){socket&&socket.emit("city:note:claim",{id:t.object.id},r=>{if(r&&r.error)toast(r.error)});return}if(t.type==="landmark"){openLandmark(t.object);return}if(t.type==="player"){stopMovementInput();selectedPlayerName=t.object.name;document.getElementById("playerCardName").textContent=selectedPlayerName;playerCard.dataset.targetId=t.object.id;updatePlayerActions();playerCard.hidden=false;return}playerCard.hidden=true;if(t.type==="npc"){showDialog(t.object.role,t.object.name,t.object.line,[{label:"👋 მივესალმო",run:()=>{closeDialog();toast(t.object.name+" გიღიმის.");cue(560)}},{label:"კარგ საღამოს",run:closeDialog}]);cue(490);return}if(t.type==="prop"){showDialog("ქალაქის პატარა საიდუმლო",t.object.label,t.object.line,[{label:"კარგი ამბავია",run:()=>{closeDialog();toast("ქალაქმა პატარა მოგონება გაგიზიარა.");cue(680)}}]);return}if(t.type==="building"){const b=t.object;if(!b.enterable||!["neon-casino","arcade-palace"].includes(b.id))return;showDialog("ღიაა ამ ღამით",b.name,"ნეონის შუქი კარს ქვემოდან ანათებს. შეგიძლია ცოტა ხნით შეიხედო და მერე ისევ ქუჩაში დაბრუნდე.",[{label:"შიგნით შევიდე",run:()=>{interior=b;if(self)self.interiorId=b.id;if(b.id==="neon-casino"&&self){self.casinoX=W.casino.spawn.x;self.casinoY=W.casino.spawn.y}closeDialog();playerCard.hidden=true;locationPill.innerHTML="<b>"+b.name+"</b><span>1999 · ყოველთვის ღამე</span>";document.getElementById("interiorExit").hidden=false;if(socket)socket.emit("city:interior",{buildingId:b.id});if(b.id==="arcade-palace")window.GaicaniArcadeUI?.open();cue(720)}},{label:"მოგვიანებით",run:closeDialog}])}}

function openLandmark(l){
 playerCard.hidden=true;
 if(l.type==="tower"){showDialog("მთაწმინდა · ანძა","გაუგზავნე სიგნალი","აირჩიე ფერი — სიგნალი მთელ ქალაქში 30 წამით გამოჩნდება.",[{label:"💗 ვარდისფერი · პაემანი",run:()=>sendSignal("pink")},{label:"💚 მწვანე · საუბარი",run:()=>sendSignal("green")},{label:"💙 ლურჯი · მეგობრები",run:()=>sendSignal("blue")},{label:"დახურვა",run:closeDialog}]);return}
 if(l.type==="mother"){showDialog("ქართლის დედა","ღვინო თუ ხმალი?","სხვა მოთამაშესთან ახლოს მიდი, სანამ აქ დგახარ — მის ბარათზე 🍷 ან ⚔️ გამოჩნდება.",[{label:"გასაგებია",run:closeDialog}]);return}
 if(l.type==="fortress"){showDialog("ნარიყალას ციხე","გაუშვი საიდუმლო წერილი","შენი ქაღალდის თვითმფრინავი ციხის კედლიდან ქალაქის ქვემოთ დაეშვება. სხვა მოთამაშე შეძლებს მის პოვნას.",[{label:"✉ წერილის დაწერა",run:()=>{closeDialog();openCityMessageComposer("note")}},{label:"მოგვიანებით",run:closeDialog}]);return}
 if(l.type==="station"){showDialog("თბილისის საბაგირო","შეხვდი ღამის მგზავრს","კაბინა მეორე მოთამაშის გამოჩენამდე სადგურზე დაგელოდება. ორი მგზავრის ასვლის შემდეგ 15-წამიანი მგზავრობა და პირადი ჩატი იწყება.",[{label:"🚠 კაბინაში ჩაჯდომა",run:()=>{closeDialog();socket&&socket.emit("city:ride:board",{stationId:l.id},r=>{if(r&&r.error)toast(r.error)})}},{label:"მოგვიანებით",run:closeDialog}])}
}
function sendSignal(color){closeDialog();if(!socket||!joined)return;socket.emit("city:signal:send",{color},r=>{if(r&&r.error){toast(r.error);return}toast("ანძა შენს სიგნალს 30 წამით ანათებს ✨");cue(810)})}
function drawCitySignals(now){
 if(signals.length){const tower=(W.landmarks||[]).find(l=>l.id==="tv-tower");if(tower){const colorMap={pink:"#ff4bce",green:"#54ff9a",blue:"#5ca8ff"};const sig=signals.reduce((a,b)=>b.expiresAt>a.expiresAt?b:a,signals[0]),col=colorMap[sig.color]||"#ff4bce",pulse=.55+Math.sin(now/120)*.35;ctx.save();ctx.globalAlpha=pulse;ctx.fillStyle=col;ctx.shadowColor=col;ctx.shadowBlur=30;ctx.fillRect(tower.x-3,tower.y-104,6,14);ctx.beginPath();ctx.arc(tower.x,tower.y-97,10+Math.sin(now/100)*4,0,Math.PI*2);ctx.fill();ctx.restore()}
  signals.forEach(sig=>{const pl=self&&self.id===sig.id?self:remote.get(sig.id);if(!pl)return;const colors={pink:"#ff4bce",green:"#54ff9a",blue:"#5ca8ff"},col=colors[sig.color]||"#fff";ctx.save();ctx.strokeStyle=col;ctx.lineWidth=2;ctx.globalAlpha=.55+.4*Math.sin(now/180);ctx.beginPath();ctx.arc(pl.x,pl.y-29,13+Math.sin(now/180)*3,0,Math.PI*2);ctx.stroke();ctx.restore()})
 }
 notes.forEach(n=>{const pulse=.72+Math.sin(now/180)*.22;ctx.save();ctx.translate(n.x,n.y);ctx.globalAlpha=pulse;ctx.shadowColor="#fff2a7";ctx.shadowBlur=15;ctx.fillStyle="#fff0a0";ctx.beginPath();ctx.moveTo(-9,-4);ctx.lineTo(7,-8);ctx.lineTo(9,5);ctx.lineTo(-6,8);ctx.closePath();ctx.fill();ctx.strokeStyle="#ffffff";ctx.stroke();ctx.fillStyle="#ff9e69";ctx.beginPath();ctx.moveTo(7,-8);ctx.lineTo(9,5);ctx.lineTo(3,1);ctx.fill();ctx.restore()});
 noteFlights=noteFlights.filter(f=>now-f.startAt<f.duration);noteFlights.forEach(f=>{const t=Math.min(1,(now-f.startAt)/f.duration),x=f.fromX+(f.x-f.fromX)*t,y=f.fromY+(f.y-f.fromY)*t-Math.sin(t*Math.PI)*90;ctx.save();ctx.translate(x,y);ctx.rotate(-.35+t*.55);ctx.globalAlpha=1-t*.35;ctx.shadowColor="#fff2a7";ctx.shadowBlur=12;ctx.fillStyle="#fff0a0";ctx.beginPath();ctx.moveTo(-10,-4);ctx.lineTo(9,-3);ctx.lineTo(0,7);ctx.closePath();ctx.fill();ctx.fillStyle="#ffb36c";ctx.fillRect(-1,-3,2,8);ctx.restore()});
 activeDuels=activeDuels.filter(d=>d.endsAt>Date.now());activeDuels.forEach(d=>{const a=d.id===self?.id?self:remote.get(d.id),b=d.targetId===self?.id?self:remote.get(d.targetId);if(!a||!b)return;const x=(a.x+b.x)/2,y=(a.y+b.y)/2-20,phase=Date.now()/100;ctx.save();ctx.translate(x,y);ctx.rotate(Math.sin(phase)*.7);ctx.strokeStyle="#fff2a8";ctx.lineWidth=3;ctx.shadowColor="#ff4bce";ctx.shadowBlur=15;ctx.beginPath();ctx.moveTo(-20,10);ctx.lineTo(20,-10);ctx.stroke();ctx.fillStyle="#fff";for(let i=0;i<4;i++){const ang=phase+i*Math.PI/2;ctx.fillRect(Math.cos(ang)*15,Math.sin(ang)*12,3,3)}ctx.restore()})
}
function renderSignalList(){
 const box=document.getElementById("citySignalList"),active=signals.filter(s=>s.expiresAt>Date.now());box.replaceChildren();if(!active.length){box.hidden=true;return}box.hidden=false;const h=document.createElement("h3");h.textContent="ანძის ცოცხალი სიგნალები";box.appendChild(h);const colors={pink:"#ff7bdc",green:"#72ffad",blue:"#7bb8ff"},labels={pink:"პაემანი",green:"საუბარი",blue:"მეგობრები"};active.forEach(sig=>{const row=document.createElement("div");row.className="city-signal-row";const name=document.createElement("span");name.textContent="● "+sig.name+" · "+labels[sig.color];name.style.color=colors[sig.color]||"#fff";row.appendChild(name);if(sig.id!==self?.id){for(const action of ["follow","wave"]){const b=document.createElement("button");b.type="button";b.textContent=action==="follow"?"მივიდე":"👋";b.addEventListener("click",()=>socket&&socket.emit("city:signal:"+action,{targetId:sig.id},r=>{if(r&&r.error)toast(r.error);else if(action==="follow")toast("სიგნალის მოთამაშესთან მიხვედი ✨")}));row.appendChild(b)}}box.appendChild(row)})
}
function drawRideScene(w,h,now){
 const grad=ctx.createLinearGradient(0,0,0,h);grad.addColorStop(0,"#111c40");grad.addColorStop(1,"#070a1b");ctx.fillStyle=grad;ctx.fillRect(0,0,w,h);
 for(let i=0;i<34;i++){const x=(i*97)%w,y=18+(i*53)%Math.max(80,h*.47);ctx.fillStyle=i%3?"#ffd78b":"#f477d8";ctx.globalAlpha=.4;ctx.fillRect(x,y,2,2)}ctx.globalAlpha=1;
 for(let i=0;i<12;i++){const x=i*w/12,bh=h*(.16+(i*17%28)/100);ctx.fillStyle=i%2?"#222b48":"#30253e";ctx.fillRect(x,h*.55-bh,w/12-3,bh);for(let j=0;j<4;j++){ctx.fillStyle=(i+j)%3?"#ffbd71":"#67e9ff";ctx.globalAlpha=.7;ctx.fillRect(x+6+j*11,h*.55-bh+12,4,5)}}ctx.globalAlpha=1;
 ctx.strokeStyle="#8693b7";ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(w*.05,h*.26);ctx.lineTo(w*.95,h*.09);ctx.stroke();
 const travel=ride.status==="riding"?Math.min(1,(Date.now()-ride.startedAt)/15000):.12,carX=w*(.13+travel*.72),carY=h*(.3-travel*.1);
 ctx.save();ctx.translate(carX,carY+Math.sin(now/180)*2);ctx.shadowColor="#ff4e6f";ctx.shadowBlur=24;ctx.fillStyle="#d93658";ctx.fillRect(-44,-26,88,54);ctx.shadowBlur=0;ctx.fillStyle="#9cecff";ctx.fillRect(-34,-19,68,25);ctx.fillStyle="#15233e";ctx.fillRect(-3,-19,4,25);ctx.fillStyle="#5a253f";ctx.fillRect(-40,29,80,5);ctx.restore();
 const riderY=h*.66;drawAvatar(w*.38,riderY,selfName,"#bd75ef","down","idle",true,now);if(ride.partner){drawAvatar(w*.62,riderY,ride.partner.name,ride.partner.color||"#53d8f2","down","idle",false,now)}
 if(ride.messages&&ride.messages.length){ride.messages.slice(-3).forEach((m,i)=>{ctx.fillStyle="rgba(8,10,28,.8)";ctx.fillRect(w*.2,h*.72+i*22,w*.6,19);label(ctx,m.name+": "+m.text,w*.5,h*.72+10+i*22,9,"#fff","center")});const last=ride.messages[ride.messages.length-1];if(Date.now()-last.receivedAt<5000){const x=last.id===self?.id?w*.38:w*.62;drawMessageBubble(x,riderY,last.text)}}
}
function setRide(data,status){ride=Object.assign({status:status||"waiting",messages:[]},data||{});document.getElementById("cityRideOverlay").hidden=false;document.getElementById("cityRideTitle").textContent=status==="riding"?"ღამის საბაგირო":"საბაგიროს სადგური";document.getElementById("cityRideStatus").textContent=status==="riding"?"კაბინა გზაშია — პირადი ჩატი თქვენ ორს გეკუთვნით.": "მეორე მგზავრს ველოდებით…";document.getElementById("cityRideSay").hidden=status!=="riding";if(status==="riding"&&ride.partner)document.getElementById("cityRideStatus").textContent=ride.partner.name+"-თან ერთად მგზავრობ — მხოლოდ თქვენ ხედავთ ამ ჩატს."}
document.getElementById("cityRideSay").addEventListener("click",()=>openCityMessageComposer("ride"));
document.getElementById("cityRideExit").addEventListener("click",()=>{if(socket&&ride)socket.emit("city:ride:leave")});
document.getElementById("playerWineButton").addEventListener("click",()=>{const targetId=playerCard.dataset.targetId;if(!targetId||!socket)return;socket.emit("city:mother:wine",{targetId},r=>{if(r&&r.error){toast(r.error);return}playerCard.hidden=true;openCityMessageComposer("wine",targetId);toast("🍷 მეგობრული შეთავაზება გაიგზავნა")})});
document.getElementById("playerSwordButton").addEventListener("click",()=>{const targetId=playerCard.dataset.targetId;if(!targetId||!socket)return;socket.emit("city:duel:start",{targetId},r=>{if(r&&r.error)toast(r.error);else{playerCard.hidden=true;toast("⚔️ ხმლების შეჯახება იწყება!")}})});

function updatePlayerActions(){
 const lc=selectedPlayerName.toLowerCase(),isFriend=friendNames.has(lc),incoming=incomingFriendRequests.has(lc),outgoing=outgoingFriendRequests.has(lc);
 document.getElementById("playerMessageButton").hidden=!isFriend;
 document.getElementById("playerAddFriendButton").hidden=isFriend||incoming||outgoing;
 document.getElementById("playerAcceptFriendButton").hidden=isFriend||!incoming;
 const mother=(W.landmarks||[]).find(l=>l.type==="mother"),targetId=playerCard.dataset.targetId,target=remote.get(targetId),nearMother=!!(self&&target&&mother&&Math.hypot(self.x-mother.interactX,self.y-mother.interactY)<155&&Math.hypot(target.x-mother.interactX,target.y-mother.interactY)<155);document.getElementById("playerWineButton").hidden=!nearMother;document.getElementById("playerSwordButton").hidden=!nearMother;
 window.GaicaniCityGames?.updatePlayerCard();
 const note=document.getElementById("playerChatNote");note.hidden=isFriend;
 note.textContent=incoming?"ამ მოთამაშემ მეგობრობის მოთხოვნა გამოგიგზავნა.":outgoing?"მოთხოვნა გაგზავნილია — პირად ჩატს მიღების შემდეგ გახსნი.":"პირადი ჩატი მეგობრებს შორისაა. დაამატე მეგობრად, რომ მისწერო.";
}
function replaceFriends(list){friendNames.clear();(list||[]).forEach(f=>{const n=typeof f==="string"?f:f&&(f.lc||f.username);if(n)friendNames.add(String(n).toLowerCase())});updatePlayerActions()}
function openCityMessageComposer(mode,targetId){stopMovementInput();composerMode=mode||"city";messageTargetId=targetId||null;playerCard.hidden=true;cityMessageComposer.hidden=false;const title=document.getElementById("cityMessageTitle"),desc=cityMessageComposer.querySelector("p"),input=document.getElementById("cityMessageInput"),send=document.getElementById("cityMessageSend");if(composerMode==="car"){title.textContent="Car chat";desc.textContent="Only the occupants of your car receive this message.";input.placeholder="Say something to your passengers…";send.textContent="Send ↗"}else if(composerMode==="garden-whisper"){title.textContent="Neon Garden · პირადი საუბარი";desc.textContent="ამ შეტყობინებას მხოლოდ არჩეული ახლომდებარე მოთამაშე ხედავს.";input.placeholder="რას ეტყვი ჩუმად?";send.textContent="ჩუმად გაგზავნა ↗"}else if(composerMode==="note"){title.textContent="საიდუმლო წერილი";desc.textContent="ქაღალდის თვითმფრინავს ნარიყალიდან ქვემოთ გაუშვებ.";input.placeholder="დატოვე ღამის საიდუმლო…";send.textContent="თვითმფრინავის გაშვება ↗"}else if(composerMode==="wine"){title.textContent="ღვინის შეთავაზება";desc.textContent="ეს პირადი შეტყობინება მხოლოდ ამ მოთამაშეს მიუვა.";input.placeholder="რა გინდა უთხრა?";send.textContent="პირადად გაგზავნა ↗"}else if(composerMode==="ride"){title.textContent="საბაგიროს პირადი ჩატი";desc.textContent="ამ შეტყობინებას მხოლოდ შენ და მგზავრი ხედავთ.";input.placeholder="რას ეტყვი მგზავრს?";send.textContent="მგზავრს გაგზავნა ↗"}else{title.textContent="ქალაქში თქვი რამე";desc.textContent="შენი სიტყვა რამდენიმე წამით პერსონაჟის თავზე გამოჩნდება.";input.placeholder="რას ეტყვი ღამის ქალაქს?";send.textContent="გაგზავნა ↗"}input.value="";updateCityMessageCount();setTimeout(()=>input.focus(),30)}
function closeCityMessageComposer(){cityMessageComposer.hidden=true;composerMode="city";messageTargetId=null}
function updateCityMessageCount(){const input=document.getElementById("cityMessageInput"),button=document.getElementById("cityMessageSend");document.getElementById("cityMessageCount").textContent=input.value.length+"/120";button.disabled=cityMessageSending||!input.value.trim()}
document.getElementById("playerSayButton").addEventListener("click",openCityMessageComposer);
document.getElementById("cityMessageClose").addEventListener("click",closeCityMessageComposer);
document.getElementById("cityMessageInput").addEventListener("input",updateCityMessageCount);
document.getElementById("cityMessageForm").addEventListener("submit",e=>{
 e.preventDefault();const input=document.getElementById("cityMessageInput"),text=input.value.trim();
 if(cityMessageSending||!text)return;if(!socket||!joined){toast("ქალაქთან კავშირი არ არის");return}
 const draft=input.value,mode=composerMode,targetId=messageTargetId,request=++cityMessageRequest;
 cityMessageSending=true;updateCityMessageCount();
 const done=r=>{
  if(request!==cityMessageRequest)return;
  cityMessageSending=false;updateCityMessageCount();
  if(!r||r.error){toast(r?.error||"შეტყობინება ვერ გაიგზავნა");return}
  if(input.value===draft&&composerMode===mode&&messageTargetId===targetId){input.value="";updateCityMessageCount();closeCityMessageComposer()}
  toast("შეტყობინება გაგზავნილია ✨");
 };
 if(mode==="car")socket.emit("city:vehicle:message",{text},done);
 else if(mode==="garden-whisper")socket.emit("city:garden:whisper",{targetId,text},done);
 else if(mode==="note")socket.emit("city:note:drop",{text},done);
 else if(mode==="wine")socket.emit("city:mother:message",{targetId,text},done);
 else if(mode==="ride")socket.emit("city:ride:message",{text},done);
 else socket.emit("city:message",{text},done);
});
document.getElementById("playerMessageButton").addEventListener("click",()=>{if(!selectedPlayerName||!friendNames.has(selectedPlayerName.toLowerCase()))return;window.location.href="/friend-chat.html?friend="+encodeURIComponent(selectedPlayerName)});
document.getElementById("playerAddFriendButton").addEventListener("click",()=>{const name=selectedPlayerName,lc=name.toLowerCase();if(!name||!socket||!joined||friendNames.has(lc))return;outgoingFriendRequests.add(lc);updatePlayerActions();socket.emit("friend:request",{toUsername:name});toast("მეგობრობის მოთხოვნა გაიგზავნა. პირად ჩატს მიღების შემდეგ გახსნი.",3600)});
document.getElementById("playerAcceptFriendButton").addEventListener("click",()=>{if(!selectedPlayerName||!socket)return;socket.emit("friend:accept",{fromUsername:selectedPlayerName});toast("მეგობრობის მოთხოვნას ვიღებ...")});
function selectPlayer(id){const p=remote.get(id),sameCasino=interior?.id==="neon-casino"&&p?.interiorId==="neon-casino";if(!p||p.vehicleId||self?.vehicleId||((p.interiorId||interior)&&!sameCasino)||p.rideId||!self||Math.hypot((sameCasino?p.casinoX:p.x)-(sameCasino?self.casinoX:self.x),(sameCasino?p.casinoY:p.y)-(sameCasino?self.casinoY:self.y))>126)return false;open({type:"player",object:p});return true}
function canvasPoint(e){const r=canvas.getBoundingClientRect(),insideCasino=interior?.id==="neon-casino",offsetX=insideCasino?Math.max(0,(r.width-W.casino.width)/2):0,offsetY=insideCasino?Math.max(0,(r.height-W.casino.height)/2):0;return{x:e.clientX-r.left+camera.x-offsetX,y:e.clientY-r.top+camera.y-offsetY}}
canvas.addEventListener("pointerdown",e=>{if(ride)return;const p=canvasPoint(e);if(interior){if(interior.id!=="neon-casino")return;let chosen=null,best=34;remote.forEach(o=>{if(o.interiorId!=="neon-casino"||!self||Math.hypot(o.casinoX-self.casinoX,o.casinoY-self.casinoY)>145)return;const d=Math.hypot(o.casinoX-p.x,o.casinoY-p.y);if(d<best){best=d;chosen=o}});if(chosen){selectPlayer(chosen.id);return}if(nearby&&nearby.distance<96){open(nearby);return}return}let noteHit=null;for(const n of notes)if(Math.hypot(n.x-p.x,n.y-p.y)<30){noteHit=n;break}if(noteHit){open({type:"note",object:noteHit});return}let chosen=null,best=34;remote.forEach(o=>{if(o.interiorId||o.rideId||o.vehicleId||!self||Math.hypot(o.x-self.x,o.y-self.y)>145)return;const d=Math.hypot(o.x-p.x,o.y-p.y);if(d<best){best=d;chosen=o}});if(chosen){selectPlayer(chosen.id);return}if(nearby&&nearby.distance<96){open(nearby);return}});
document.querySelectorAll("[data-emote]").forEach(b=>b.addEventListener("click",()=>{if(!socket||!joined)return;socket.emit("city:emote",{targetId:playerCard.dataset.targetId,emote:b.dataset.emote},r=>{if(r&&r.error){toast(r.error);return}playerCard.hidden=true;toast(b.dataset.emote==="wave"?"👋 მიესალმე მოთამაშეს":b.dataset.emote==="dance"?"♫ ცეკვავ ნეონის ქვეშ":"🖐 High-five!");cue(590)} )}));
function interact(){if(window.GaicaniCasinoUI?.blocksMovement)return;if(interior?.id==="arcade-palace"){window.GaicaniArcadeUI?.open();return}if(interior&&interior.id!=="neon-casino")return;open(target())}document.getElementById("touchInteract").addEventListener("click",interact);
const held=new Set(),codeDir={ArrowUp:[0,-1],KeyW:[0,-1],ArrowDown:[0,1],KeyS:[0,1],ArrowLeft:[-1,0],KeyA:[-1,0],ArrowRight:[1,0],KeyD:[1,0]};
const touchPad=document.getElementById("touchPad"),touchStickKnob=document.getElementById("touchStickKnob");
let touchPointerId=null,touchMetrics=null;
function resetTouchStick(){touchStickKnob.style.transform="translate(-50%, -50%)";touchMetrics=null}
function updateTouchStick(clientX,clientY){const metrics=touchMetrics||(touchMetrics={rect:touchPad.getBoundingClientRect(),knob:touchStickKnob.offsetWidth}),rect=metrics.rect,travel=Math.max(1,rect.width/2-metrics.knob/2-5);let dx=clientX-(rect.left+rect.width/2),dy=clientY-(rect.top+rect.height/2),length=Math.hypot(dx,dy);if(length>travel){dx=dx/length*travel;dy=dy/length*travel;length=travel}touchStickKnob.style.transform=`translate(-50%, -50%) translate(${dx}px, ${dy}px)`;const deadZone=.13;if(length<=travel*deadZone){keys.x=keys.y=0}else{const strength=Math.min(1,(length/travel-deadZone)/(1-deadZone));keys.x=dx/length*strength;keys.y=dy/length*strength}sendCityInputNow()}
function stopTouchStick(){if(touchPointerId!==null){const pointerId=touchPointerId;touchPointerId=null;try{if(touchPad.hasPointerCapture(pointerId))touchPad.releasePointerCapture(pointerId)}catch(_){}}touchHeld=false;resetTouchStick()}
function stopMovementInput(){if(!held)return;held.clear();stopTouchStick();keys.x=keys.y=0;sendCityInputNow()}
touchPad.addEventListener("pointerdown",e=>{e.preventDefault();if(touchPointerId!==null)return;touchPointerId=e.pointerId;touchHeld=true;try{touchPad.setPointerCapture(e.pointerId)}catch(_){}updateTouchStick(e.clientX,e.clientY)});
touchPad.addEventListener("pointermove",e=>{if(e.pointerId===touchPointerId){e.preventDefault();updateTouchStick(e.clientX,e.clientY)}});
function finishTouchStick(e){if(touchPointerId===null||e.pointerId!==touchPointerId)return;e.preventDefault();stopTouchStick();keys.x=keys.y=0;sendCityInputNow()}
touchPad.addEventListener("pointerup",finishTouchStick);touchPad.addEventListener("pointercancel",finishTouchStick);touchPad.addEventListener("lostpointercapture",finishTouchStick);
addEventListener("resize",()=>stopMovementInput(),{passive:true});
function updateKeys(){keys.x=(held.has("ArrowRight")||held.has("KeyD")?1:0)-(held.has("ArrowLeft")||held.has("KeyA")?1:0);keys.y=(held.has("ArrowDown")||held.has("KeyS")?1:0)-(held.has("ArrowUp")||held.has("KeyW")?1:0);sendCityInputNow()}
function sendCityInputNow(){
 if(!self||!joined)return;
 const active=movementAllowed(),x=active?keys.x:0,y=active?keys.y:0;
 if(Math.hypot(x,y)<=.001){
  if(Math.hypot(motionInput.x,motionInput.y)>.001)queueMotion(0,0,1);
  if(!(self.actionUntil>Date.now())&&!predictor.getState()?.blocked)self.action="idle";
  flushMotion(true);
 }else flushMotion(false);
}
document.addEventListener("keydown",e=>{if(e.target&&/INPUT|TEXTAREA|SELECT/.test(e.target.tagName))return;if(codeDir[e.code]){e.preventDefault();held.add(e.code);updateKeys()}else if(e.code==="KeyF"){e.preventDefault();if(!e.repeat)toggleVehicle()}else if(e.code==="KeyE"||e.code==="Space"){e.preventDefault();interact()}else if(e.code==="Escape"){closeDialog();playerCard.hidden=true;closeCityMessageComposer();if(interior)leaveInterior()}});
document.addEventListener("keyup",e=>{held.delete(e.code);updateKeys()});addEventListener("blur",()=>stopMovementInput());document.addEventListener("visibilitychange",()=>{if(document.hidden)stopMovementInput()});
function connect(){
 let token=safe(()=>localStorage.getItem("gaicani_auth_token"),null);const preferred=safe(()=>sessionStorage.getItem("gaicani_guest_username"),null);
 socket=window.io({transports:["websocket","polling"]});
 socket.on("connect",()=>{presence("","უერთდება...");if(token)socket.emit("auth:token",token);else socket.emit("auth:guest",{preferredUsername:preferred})});
 socket.on("auth:authenticated",u=>{selfName=u&&u.username||"ღამის მგზავრი";document.getElementById("selfName").textContent=selfName;replaceFriends(u&&u.friends||[]);incomingFriendRequests.clear();(u&&u.pendingRequests||[]).forEach(n=>incomingFriendRequests.add(String(n).toLowerCase()));updatePlayerActions();if(u&&u.isGuest&&u.username)safe(()=>sessionStorage.setItem("gaicani_guest_username",u.username),null);socket.emit("city:join",null,r=>{if(r&&r.error)toast(r.error)})});
 socket.on("auth:invalid",()=>{token=null;safe(()=>localStorage.removeItem("gaicani_auth_token"),null);safe(()=>localStorage.removeItem("gaicani_auth_user"),null);socket.emit("auth:guest",{preferredUsername:preferred})});
 socket.on("friend:incomingRequest",d=>{if(!d||!d.fromUsername)return;incomingFriendRequests.add(d.fromUsername.toLowerCase());updatePlayerActions();if(d.fromUsername.toLowerCase()===selectedPlayerName.toLowerCase())toast(d.fromUsername+" მეგობრობის მოთხოვნას გიგზავნის.")});
 socket.on("friend:accepted",d=>{replaceFriends(d&&d.friends||Array.from(friendNames));if(d&&d.username){incomingFriendRequests.delete(d.username.toLowerCase());outgoingFriendRequests.delete(d.username.toLowerCase())}toast("მეგობრობა დაემატა — ახლა პირადი ჩატის გახსნა შეგიძლია.")});
 socket.on("friend:acceptedByOther",d=>{if(d&&d.byUsername){friendNames.add(d.byUsername.toLowerCase());incomingFriendRequests.delete(d.byUsername.toLowerCase());outgoingFriendRequests.delete(d.byUsername.toLowerCase());updatePlayerActions();toast(d.byUsername+"-მა მეგობრობის მოთხოვნა მიიღო.")}});
 socket.on("friend:removed",d=>replaceFriends(d&&d.friends||[]));
 socket.on("friend:removedByOther",d=>{if(d&&d.byUsername)friendNames.delete(d.byUsername.toLowerCase());updatePlayerActions()});
 socket.on("friends:changed",()=>socket.emit("friends:details",null,d=>replaceFriends(d&&d.friends||[])));
 socket.on("friend:declinedByOther",d=>{if(d&&d.byUsername){outgoingFriendRequests.delete(d.byUsername.toLowerCase());updatePlayerActions();toast(d.byUsername+"-მა მეგობრობის მოთხოვნა უარყო.")}});
 socket.on("friend:error",d=>{const n=String(d&&d.targetUsername||selectedPlayerName).toLowerCase();outgoingFriendRequests.delete(n);updatePlayerActions();toast(d&&(d.message||d.msg)||"მოთხოვნა ვერ გაიგზავნა.")});
 socket.on("guest:registerRequired",()=>toast("მეგობრობისთვის საჭიროა რეგისტრაცია."));
 socket.on("connect_error",()=>presence("is-off","კავშირი ვერ მოხერხდა"));
 socket.on("disconnect",()=>{joined=false;cityMessageRequest++;cityMessageSending=false;updateCityMessageCount();predictor.clear();motionInput={x:0,y:0};held.clear();stopTouchStick();keys.x=keys.y=0;fleet.clear();vehiclePending=false;if(self)self.vehicleId=null;refreshVehicle();ride=null;document.getElementById("cityRideOverlay").hidden=true;signals=[];notes=[];renderSignalList();presence("is-off","კავშირი გაწყდა");remote.clear();onlineCount.textContent="1"});
 socket.on("city:vehicles",d=>{syncVehicles(d?.vehicles);refreshVehicle()});
 socket.on("city:joined",d=>{Garden.setState(d.garden);joined=true;self=d.self;predictor.clear();syncVehicles(d.vehicles);acceptMotion(self.motion);signals=d.signals||[];notes=d.notes||[];renderSignalList();remote.clear();(d.players||[]).forEach(p=>{if(p.id!==self.id)remote.set(p.id,Object.assign({},p,{targetX:p.x,targetY:p.y}))});presence("is-on","ქალაქში ხარ");refresh();drawMini();cue(760)});
 socket.on("city:casino:joined",d=>{if(!d||!self)return;self.casinoX=d.self.x;self.casinoY=d.self.y;acceptMotion(d.self.motion);self.interiorId="neon-casino";interior=W.buildings.find(b=>b.id==="neon-casino")||interior;document.getElementById("interiorExit").hidden=false;remote.forEach(p=>{if(p.interiorId==="neon-casino")p.interiorId=null});(d.players||[]).forEach(p=>{if(p.id===self.id)return;const old=remote.get(p.id)||{};old.id=p.id;old.name=p.name;old.color=p.color;old.dir=p.dir;old.action=p.action||"idle";old.interiorId="neon-casino";old.casinoX=p.x;old.casinoY=p.y;old.targetCasinoX=p.x;old.targetCasinoY=p.y;old.message=p.message||"";old.messageUntil=p.messageUntil||0;remote.set(p.id,old)});refresh()});
 socket.on("city:casino:snapshot",d=>{if(!d||!Array.isArray(d.players))return;const seen=new Set();d.players.forEach(p=>{if(p.id===self?.id){acceptMotion(p.motion);return}seen.add(p.id);let old=remote.get(p.id)||{};old.id=p.id;old.name=p.name;old.color=p.color;old.dir=p.dir;old.action=p.action||"idle";old.interiorId="neon-casino";old.casinoX=Number.isFinite(old.casinoX)?old.casinoX:p.x;old.casinoY=Number.isFinite(old.casinoY)?old.casinoY:p.y;old.targetCasinoX=p.x;old.targetCasinoY=p.y;old.message=p.message||"";old.messageUntil=p.messageUntil||0;remote.set(p.id,old)});remote.forEach(p=>{if(p.interiorId==="neon-casino"&&!seen.has(p.id))p.interiorId=null})});
 socket.on("city:casino:playerJoined",p=>{if(!p||p.id===self?.id)return;const old=remote.get(p.id)||{};old.id=p.id;old.name=p.name;old.color=p.color;old.dir=p.dir;old.action=p.action||"idle";old.interiorId="neon-casino";old.casinoX=p.x;old.casinoY=p.y;old.targetCasinoX=p.x;old.targetCasinoY=p.y;old.message=p.message||"";old.messageUntil=p.messageUntil||0;remote.set(p.id,old)});
 socket.on("city:casino:playerLeft",d=>{const p=d&&remote.get(d.id);if(p)p.interiorId=null});
 socket.on("city:error",d=>toast(d&&d.message||"ქალაქთან დაკავშირება ვერ მოხერხდა"));
 socket.on("city:snapshot",d=>{if(!self||!d||!Array.isArray(d.players))return;syncVehicles(d.vehicles);Garden.setState(d.garden);const seen=new Set();d.players.forEach(p=>{if(p.id===self.id){if(p.motion&&p.motion.epoch>=(predictor.getEpoch()||0)){self.vehicleId=p.vehicleId||null;self.vehicleSeat=p.vehicleSeat;self.vehicleAngle=p.vehicleAngle;self.vehicleSpeed=p.vehicleSpeed;self.gameId=p.gameId||null;self.gardenDance=p.gardenDance||null;self.gardenSeatId=p.gardenSeatId||null;self.gardenSeatKind=p.gardenSeatKind||null;acceptMotion(p.motion)}return}seen.add(p.id);let old=remote.get(p.id);if(!old)old=Object.assign({},p,{targetX:p.x,targetY:p.y});old.name=p.name;old.color=p.color;old.dir=p.dir;old.action=p.action||"idle";if((old.gardenSeatId||null)!==(p.gardenSeatId||null)){old.x=p.x;old.y=p.y}old.gardenDance=p.gardenDance||null;old.gardenSeatId=p.gardenSeatId||null;old.gardenSeatKind=p.gardenSeatKind||null;old.vehicleId=p.vehicleId||null;old.vehicleSeat=p.vehicleSeat;old.vehicleAngle=p.vehicleAngle;old.vehicleSpeed=p.vehicleSpeed;old.gameId=p.gameId||null;old.gameStartedAt=p.gameStartedAt||0;old.targetX=p.x;old.targetY=p.y;old.interiorId=p.interiorId||null;old.rideId=p.rideId||null;remote.set(p.id,old)});Array.from(remote.keys()).forEach(id=>{if(!seen.has(id))remote.delete(id)});onlineCount.textContent=String(remote.size+1)});
 socket.on("city:stopped",d=>{if(d?.motion)acceptMotion(d.motion)});
 socket.on("city:casino:stopped",d=>{if(d?.motion)acceptMotion(d.motion)});
 socket.on("city:signals",d=>{signals=Array.isArray(d)?d:[];renderSignalList()});
 socket.on("city:notes",d=>{notes=Array.isArray(d)?d:[]});
 socket.on("city:note:thrown",d=>{if(d)noteFlights.push({fromX:d.fromX,fromY:d.fromY,x:d.x,y:d.y,startAt:performance.now(),duration:1100})});
 socket.on("city:signal:wave",d=>{if(d&&d.targetId===self?.id)toast(d.name+" ანძის სიგნალიდან მოგესალმა 👋");if(d&&d.fromId===self?.id)toast("სიგნალთან ხელი დაუქნიე 👋")});
 socket.on("city:signal:followed",d=>{if(self&&d){acceptMotion(d.motion);self.action="wave";self.actionUntil=Date.now()+900}});
 socket.on("city:note:found",d=>{if(!d)return;showDialog("ნარიყალასთან იპოვე","საიდუმლო წერილი · "+d.name,d.text,[{label:"✉ ქალაქში პასუხი",run:()=>{closeDialog();openCityMessageComposer("city")}},{label:"ლამაზი საიდუმლოა",run:closeDialog}])});
 socket.on("city:note:claimed",d=>{if(d&&d.authorId===self?.id)toast(d.name+"-მა შენი საიდუმლო წერილი იპოვა ✨")});
 socket.on("city:mother:emote",d=>{if(!d)return;[d.fromId,d.targetId].forEach(id=>{const p=self&&self.id===id?self:remote.get(id);if(p){p.action="wine";p.actionUntil=Date.now()+1200}})});
 socket.on("city:mother:wine",d=>{if(!d||d.targetId!==self?.id)return;showDialog("🍷 ღვინო თუ ხმალი?","ბოკალზე გეპატიჟებიან",d.name+" გეპატიჟება ქართლის დედასთან საუბარზე.",[{label:"🍷 მიღება და პასუხი",run:()=>{closeDialog();openCityMessageComposer("wine",d.fromId)}},{label:"მოგვიანებით",run:closeDialog}])});
 socket.on("city:mother:message",d=>{if(!d||d.targetId!==self?.id)return;showDialog("პირადი შეტყობინება · 🍷",d.name,d.text,[{label:"პასუხი",run:()=>{closeDialog();openCityMessageComposer("wine",d.fromId)}},{label:"დახურვა",run:closeDialog}])});
 socket.on("city:duel:start",d=>{if(!d)return;activeDuels.push({id:d.fromId,targetId:d.targetId,endsAt:Date.now()+2100});cue(390)});
 socket.on("city:duel:result",d=>{if(!d)return;activeDuels=activeDuels.filter(x=>x.id!==d.fromId||x.targetId!==d.targetId);recentDuel=d;if(d.winnerId===self?.id)showDialog("⚔️ დუელი დასრულდა","შენ მოიგე!","აირჩიე მოკლე კითხვა თანამოსაუბრისთვის.",(d.questions||[]).map(q=>({label:q,run:()=>socket.emit("city:duel:question",{duelId:d.id,targetId:d.loserId,text:q},r=>{if(r&&r.error)toast(r.error);else{closeDialog();toast("კითხვა გაიგზავნა ✨")}})})));else if(d.loserId===self?.id)showDialog("⚔️ დუელი დასრულდა","შენ წააგე!","გამარჯვებული მალე ერთ მოკლე კითხვას დაგისვამს.",[{label:"ველოდები",run:closeDialog}])});
 socket.on("city:duel:question",d=>{if(d&&d.targetId===self?.id)showDialog("კითხვა დუელის შემდეგ",d.name,d.text,[{label:"ქალაქში პასუხი",run:()=>{closeDialog();openCityMessageComposer("city")}},{label:"დახურვა",run:closeDialog}])});
 socket.on("city:ride:waiting",d=>setRide(d,"waiting"));
 socket.on("city:ride:start",d=>setRide(Object.assign({},d,{startedAt:Date.now(),messages:[]}),"riding"));
 socket.on("city:ride:message",d=>{if(ride&&d){ride.messages=ride.messages||[];ride.messages.push(Object.assign({receivedAt:Date.now()},d));ride.messages=ride.messages.slice(-6)}});
 socket.on("city:ride:end",d=>{ride=null;document.getElementById("cityRideOverlay").hidden=true;if(self&&d&&Number.isFinite(d.x)){acceptMotion(d.motion)}if(d&&d.message)toast(d.message);sendCityInputNow()});
 socket.on("city:message",d=>{if(!d||!d.id||typeof d.text!=="string")return;const p=self&&d.id===self.id?self:remote.get(d.id);if(!p)return;p.message=String(d.text).slice(0,120);p.messageUntil=Date.now()+5000});
 socket.on("city:emote",d=>{if(!d||!d.from)return;if(self&&d.from.id===self.id){self.action=d.emote;self.actionUntil=Date.now()+1200}if(self&&d.to&&d.to.id===self.id){self.action=d.emote==="highfive"?"highfive":"wave";self.actionUntil=Date.now()+1200}const a=remote.get(d.from.id);if(a){a.action=d.emote;a.actionUntil=Date.now()+1200}const t=remote.get(d.to&&d.to.id);if(t){t.action=d.emote==="highfive"?"highfive":"wave";t.actionUntil=Date.now()+1200}if(d.to&&self&&d.to.id===self.id)toast(d.emote==="wave"?d.from.name+" მოგესალმა 👋":d.from.name+" გთავაზობს high-five-ს 🖐");cue(590)});
 socket.connect()
}
setInterval(()=>flushMotion(false),50);

document.getElementById("fullscreenButton").addEventListener("click",()=>{const root=document.getElementById("cityApp");if(!document.fullscreenElement&&root.requestFullscreen)root.requestFullscreen().catch(()=>{});else if(document.exitFullscreen)document.exitFullscreen().catch(()=>{})});
Audio.mountControls({button:document.getElementById("soundButton")});
addEventListener("pagehide",()=>{if(socket&&joined)socket.emit("city:leave")});
window.GaicaniCityGameBridge={getSocket:()=>socket,getSelf:()=>self,getVehicles:()=>Array.from(fleet.values()),getPlayer:id=>remote.get(id),getPlayers:()=>Array.from(remote.values()),getTargetId:()=>playerCard.dataset.targetId||null,toast:toast,cue:cue,stop:stopMovementInput,getMotionStats:()=>({epoch:predictor.getEpoch(),pending:predictor.pendingCount(),queued:predictor.queuedCount(),phone:phoneMode,pixelRatio:renderDpr})};
drawMini();requestAnimationFrame(draw);connect();
function acceptGardenSelf(data){
 if(!self||!data)return;if(data.motion&&data.motion.epoch<(predictor.getEpoch()||0))return;
 Object.assign(self,data);acceptMotion(data.motion);applyPredictedState();refresh();
}
let privatePanel=null;
function showGardenWhisper(message){
 if(!self||!message)return;
 if(!privatePanel){privatePanel=document.createElement("section");privatePanel.className="garden-private-message";privatePanel.setAttribute("aria-live","polite");privatePanel.innerHTML='<strong></strong><p></p><button type="button" data-private-reply>პასუხი</button> <button type="button" data-private-close>დახურვა</button>';stage.appendChild(privatePanel);privatePanel.querySelector("[data-private-close]").onclick=()=>privatePanel.hidden=true;}
 const other=message.fromId===self.id?message.targetId:message.fromId;
 privatePanel.hidden=false;privatePanel.querySelector("strong").textContent=message.fromId===self.id?"შენ → "+(remote.get(other)?.name||"მოთამაშე"):message.name+" · ჩუმად";
 privatePanel.querySelector("p").textContent=message.text;
 privatePanel.querySelector("[data-private-reply]").onclick=()=>{privatePanel.hidden=true;openCityMessageComposer("garden-whisper",other)};
}
window.GaicaniCityCarUI.mount({socket:()=>socket,self:()=>self,players:()=>Array.from(remote.values()),fleet:()=>Array.from(fleet.values()),nearest:nearestVehicle,stop:stopMovementInput,toast,sync:syncVehicles,accept:acceptGardenSelf,compose:openCityMessageComposer});
Garden.mount({socket:()=>socket,joined:()=>joined,self:()=>self,players:()=>Array.from(remote.values()),stop:stopMovementInput,toast,acceptSelf:acceptGardenSelf,compose:openCityMessageComposer,whisper:showGardenWhisper});
const casinoMarker=document.querySelector(".city-map-marker.casino"),arcadeMarker=document.querySelector(".city-map-marker.arcade");
if(casinoMarker)casinoMarker.style.top=(535/W.height*100)+"%";if(arcadeMarker)arcadeMarker.style.top=(970/W.height*100)+"%";

})();

