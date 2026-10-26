(function () {
"use strict";
const W=window.GaicaniCityWorld, canvas=document.getElementById("cityCanvas"), ctx=canvas.getContext("2d",{alpha:false});
const mini=document.getElementById("miniMap"), mctx=mini.getContext("2d"), stage=document.querySelector(".city-world");
const dot=document.getElementById("connectionDot"), connection=document.getElementById("connectionLabel"), onlineCount=document.getElementById("onlineCount");
const locationPill=document.getElementById("locationPill"), cityToast=document.getElementById("cityToast"), cityDialog=document.getElementById("cityDialog"), playerCard=document.getElementById("playerCard"), cityMessageComposer=document.getElementById("cityMessageComposer");
const keys={x:0,y:0}, remote=new Map(), rain=[];
let socket=null, joined=false, self=null, selfName="ღამის მგზავრი", camera={x:0,y:0}, nearby=null, interior=null, signals=[], notes=[], noteFlights=[], activeDuels=[], ride=null, composerMode="city", messageTargetId=null;
let toastTimer=0,lastMiniAt=0,lastDistrict="",soundOn=false,audioCtx=null,selectedPlayerName="",recentDuel=null;
const friendNames=new Set(),incomingFriendRequests=new Set(),outgoingFriendRequests=new Set();
function safe(fn,fallback){try{return fn()}catch(_){return fallback}}
function presence(state,label){if(dot&&dot.parentElement)dot.parentElement.className="city-presence "+state;connection.textContent=label}
function toast(message,ms){cityToast.textContent=message;cityToast.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>cityToast.hidden=true,ms||2500)}
function cue(freq){if(!soundOn)return;try{const A=window.AudioContext||window.webkitAudioContext;if(!A)return;audioCtx=audioCtx||new A();if(audioCtx.state==="suspended")audioCtx.resume();const o=audioCtx.createOscillator(),g=audioCtx.createGain();o.type="square";o.frequency.value=freq||580;g.gain.setValueAtTime(.04,audioCtx.currentTime);g.gain.exponentialRampToValueAtTime(.001,audioCtx.currentTime+.12);o.connect(g);g.connect(audioCtx.destination);o.start();o.stop(audioCtx.currentTime+.13)}catch(_){}}
function resize(){const r=stage.getBoundingClientRect(),d=Math.min(2,devicePixelRatio||1);canvas.width=Math.max(1,Math.round(r.width*d));canvas.height=Math.max(1,Math.round(r.height*d));ctx.imageSmoothingEnabled=false}
addEventListener("resize",resize,{passive:true});resize();
function hash(x,y){let n=(x*374761393+y*668265263)|0;n=Math.imul(n^(n>>>13),1274126177);return ((n^(n>>>16))>>>0)/4294967295}
function label(c,s,x,y,size,color,align){c.fillStyle=color||"#fff";c.textAlign=align||"left";c.textBaseline="middle";c.font='700 '+size+'px "Noto Sans Georgian",sans-serif';c.fillText(s,x,y)}
function drawPixelBuilding(g,b,i){
 const palettes={
  apartment:{wall:"#493e52",roof:"#242239",side:"#29253a",trim:"#887088",lit:"#efb36b"},
  house:{wall:"#493d4d",roof:"#292236",side:"#2b2639",trim:"#a17b83",lit:"#ffbf72"},
  courtyard:{wall:"#58474b",roof:"#302538",side:"#322832",trim:"#af7969",lit:"#ffc477"},
  shop:{wall:"#44394b",roof:"#211f33",side:"#29243b",trim:"#906878",lit:"#ffd080"},
  cafe:{wall:"#4d3945",roof:"#272035",side:"#302338",trim:"#b3796b",lit:"#ffc47d"},
  bakery:{wall:"#594038",roof:"#2e222b",side:"#32262b",trim:"#c27c50",lit:"#ffd07c"},
  cinema:{wall:"#3b3653",roof:"#211e3a",side:"#27233b",trim:"#9c6da8",lit:"#f3a967"},
  music:{wall:"#39374f",roof:"#211f38",side:"#27243c",trim:"#866eb0",lit:"#f8b975"},
  radio:{wall:"#44364b",roof:"#242034",side:"#292338",trim:"#9c6d94",lit:"#ffd080"},
  internet:{wall:"#344354",roof:"#202538",side:"#252939",trim:"#668ca4",lit:"#d5f5ff"},
  arcade:{wall:"#343751",roof:"#1e2038",side:"#24263e",trim:"#667fbd",lit:"#70f4ff"},
  passage:{wall:"#40364d",roof:"#242136",side:"#29243a",trim:"#9073a8",lit:"#d6c0ff"}
 };
 const p=palettes[b.type]||palettes.apartment,x=b.x,y=b.y,w=b.w,h=b.h,seed=i*37+b.x;
 const shopY=y+h-58,signW=Math.max(68,Math.min(w-18,170)),signX=x+(w-signW)/2,signY=y+h-91;
 g.save();
 g.fillStyle="#080914";g.fillRect(x-9,y-5,w+18,h+16);
 g.fillStyle=p.side;g.fillRect(x+w-8,y+7,8,h+5);g.fillRect(x-4,y+h-7,w+11,8);
 g.fillStyle=p.wall;g.fillRect(x,y,w,h);
 g.fillStyle=p.roof;g.fillRect(x+5,y+5,w-13,h-61);
 g.fillStyle=p.trim;g.fillRect(x+5,y+5,w-13,5);g.fillRect(x+5,y+5,5,h-63);
 g.fillStyle="#171725";g.fillRect(x+10,y+12,w-23,7);
 for(let row=0;row<Math.max(2,Math.floor((h-70)/13));row++){
  const yy=y+22+row*13; if(yy>shopY-35)break;
  for(let col=0;col<w-24;col+=17){const n=hash(seed+col,row);g.fillStyle=n>.55?"#4b4051":n>.25?"#393348":"#302d40";g.fillRect(x+11+col,yy,12,2);if(n>.84){g.fillStyle="#70585c";g.fillRect(x+13+col,yy+2,2,2)}}
 }
 const cols=Math.max(1,Math.floor((w-28)/47)),gap=(w-26)/cols,rows=h>=205?3:2;
 for(let row=0;row<rows;row++){
  const wy=y+31+row*39;if(wy+32>=shopY-7)continue;
  for(let col=0;col<cols;col++){
   const ww=Math.min(27,gap-8),wx=x+13+col*gap+(gap-ww)/2,lit=hash(seed+col*9,row*17)>.27;
   g.fillStyle="#131322";g.fillRect(wx-3,wy-3,ww+6,32);
   g.fillStyle="#68506a";g.fillRect(wx-1,wy-1,ww+2,28);
   g.fillStyle=lit?(hash(col+seed,row)>.5?p.lit:"#a86e87"):"#27364a";g.fillRect(wx,wy,ww,25);
   if(lit){g.globalAlpha=.26;g.fillStyle="#fff0be";g.fillRect(wx+2,wy+2,ww-4,18);g.globalAlpha=1}
   g.fillStyle="#28253b";g.fillRect(wx+Math.floor(ww/2)-1,wy,2,25);
   g.fillStyle="#a894a5";g.fillRect(wx-4,wy+25,ww+8,3);
   if(w>155&&((col+row+i)%3!==0)){
    g.fillStyle="#302a3b";g.fillRect(wx-4,wy+29,ww+8,3);
    g.fillStyle="#897887";g.fillRect(wx-4,wy+32,2,7);g.fillRect(wx+ww+2,wy+32,2,7);
    g.fillStyle="#c4a4a6";g.fillRect(wx-5,wy+38,ww+10,2);
    for(let rail=0;rail<ww+8;rail+=5)g.fillRect(wx-4+rail,wy+34,1,5);
   }
  }
 }
 const signH=23;
 g.fillStyle="#11101e";g.fillRect(signX-4,signY-4,signW+8,signH+8);
 g.fillStyle="#171426";g.fillRect(signX,signY,signW,signH);
 g.shadowColor=b.color;g.shadowBlur=15;g.strokeStyle=b.color;g.lineWidth=2;g.strokeRect(signX+1,signY+1,signW-2,signH-2);
 g.shadowBlur=0;g.fillStyle="#fff2ef";g.textAlign="center";g.textBaseline="middle";g.font=(w<145?"700 7px":"700 9px")+' "Noto Sans Georgian",sans-serif';g.fillText(b.sign,signX+signW/2,signY+signH/2,signW-8);
 g.fillStyle="#141522";g.fillRect(x+8,shopY-11,w-16,13);
 for(let aw=x+8;aw<x+w-8;aw+=12){g.fillStyle=Math.floor((aw-x)/12)%2?"#f0a45d":b.color;g.fillRect(aw,shopY-10,9,11)}
 g.fillStyle="#171624";g.fillRect(x+7,shopY+1,w-14,h-(shopY-y)-9);
 const panes=Math.max(2,Math.floor((w-20)/43)),paneW=(w-20)/panes;
 for(let n=0;n<panes;n++){
  const px=x+10+n*paneW;
  g.fillStyle="#253446";g.fillRect(px,shopY+4,paneW-4,Math.max(18,h-(shopY-y)-23));
  g.fillStyle=hash(seed+n,73)>.22?p.lit:"#325066";g.fillRect(px+3,shopY+7,paneW-10,Math.max(12,h-(shopY-y)-32));
  g.fillStyle="#a58274";g.fillRect(px-1,shopY+2,2,Math.max(20,h-(shopY-y)-20));
  g.fillStyle="#ffcc82";g.fillRect(px+4,shopY+12,2,2);g.fillRect(px+10,shopY+17,3,3);
 }
 g.fillStyle="#815c56";g.fillRect(x+5,y+h-4,w-10,4);
 const doorX=x+Math.round(w*.72);
 g.fillStyle="#171321";g.fillRect(doorX,y+h-36,20,36);
 g.fillStyle=b.type==="arcade"?"#5269a6":"#72545b";g.fillRect(doorX+3,y+h-32,14,29);
 g.fillStyle="#f4c96e";g.fillRect(doorX+13,y+h-19,2,2);
 if(b.enterable){g.shadowColor="#6fffe0";g.shadowBlur=10;g.fillStyle="#a2fff0";g.fillRect(doorX+7,y+h-47,6,4);g.shadowBlur=0}
 const acX=x+w-34,acY=y+12;
 g.fillStyle="#171926";g.fillRect(acX,acY,24,16);g.fillStyle="#647080";g.fillRect(acX+3,acY+3,18,3);g.fillStyle="#32394b";g.fillRect(acX+4,acY+8,16,5);g.fillStyle="#9794a1";g.fillRect(acX+9,acY+10,7,1);
 g.fillStyle="#a5837d";g.fillRect(x+7,y+8,2,h-19);g.fillStyle="#736173";g.fillRect(x+7,y+Math.floor(h*.62),3,3);
 for(let pot=0;pot<2;pot++){const px=x+13+pot*(w-33);g.fillStyle="#5e393c";g.fillRect(px,y+h-3,14,6);g.fillStyle=pot?"#4b9c71":"#65965b";g.fillRect(px+3,y+h-10,2,7);g.fillRect(px+7,y+h-13,2,10);g.fillRect(px+10,y+h-9,2,6)}
 g.globalAlpha=.16;g.shadowColor=b.color;g.shadowBlur=16;g.fillStyle=b.color;g.fillRect(x+7,y+h+4,w-14,6);g.globalAlpha=1;g.shadowBlur=0;
 g.restore();
}
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
 [360,780,1200,1620].forEach((y,i)=>{g.fillStyle="#393548";g.fillRect(0,y-52,W.width,104);g.fillStyle="#22263b";g.fillRect(0,y-42,W.width,84);g.fillStyle="#555269";g.fillRect(0,y-46,W.width,3);g.fillRect(0,y+43,W.width,3);g.fillStyle=i%2?"#766779":"#656070";for(let x=20;x<W.width;x+=72)g.fillRect(x,y-2,34,3);g.fillStyle="#151929";for(let x=50;x<W.width;x+=241)g.fillRect(x,y-46,2,92)});
 [540,1080,1620,2160].forEach((x,i)=>{g.fillStyle="#393548";g.fillRect(x-52,0,104,W.height);g.fillStyle="#22263b";g.fillRect(x-42,0,84,W.height);g.fillStyle="#555269";g.fillRect(x-46,0,3,W.height);g.fillRect(x+43,0,3,W.height);g.fillStyle=i%2?"#766779":"#656070";for(let y=20;y<W.height;y+=72)g.fillRect(x-2,y,3,34)});
 const water=g.createLinearGradient(2510,0,2645,0);water.addColorStop(0,"#102c4b");water.addColorStop(1,"#09172f");g.fillStyle=water;g.fillRect(2510,0,135,W.height);drawEastBank(g);g.fillStyle="#9a637a";g.fillRect(2497,0,12,W.height);g.fillStyle="#d283a0";g.fillRect(2495,0,3,W.height);
 for(let y=15;y<W.height;y+=71){const n=hash(4,y);g.fillStyle=n>.5?"#286084":"#1b466c";g.fillRect(2540+n*35,y,75,2)}
 g.fillStyle="#665464";g.fillRect(2490,855,350,250);g.fillStyle="#34334c";g.fillRect(2498,870,348,218);g.fillStyle="#9b8193";g.fillRect(2498,870,348,8);g.fillRect(2498,1080,348,8);for(let x=2510;x<W.width;x+=42){g.fillStyle="#bc8da4";g.fillRect(x,870,4,218)}
 W.buildings.forEach((b,i)=>drawPixelBuilding(g,b,i));
 drawWetStreetDetails(g);
 const cars=[[130,715,"#a22d71"],[838,741,"#c45131"],[1810,710,"#265c91"],[2270,1158,"#8e2d78"],[1470,1565,"#225e76"],[2020,1636,"#9b6131"],[665,342,"#3c687c"],[1700,1146,"#c13a45"],[300,372,"#385d7b"],[1320,355,"#a6425f"],[2400,748,"#d08045"],[620,795,"#315c8a"],[1110,1188,"#98426f"],[1840,1230,"#4d7780"],[80,1590,"#bd6048"],[2340,1640,"#42627c"],[1565,350,"#6d4a92"]];
 cars.forEach((a,i)=>{const x=a[0],y=a[1];g.fillStyle="#0d101d";g.fillRect(x-4,y-4,63,34);g.fillStyle=a[2];g.fillRect(x,y,55,26);g.fillStyle="#27374a";g.fillRect(x+11,y+3,30,9);g.fillStyle="#f3c27c";g.fillRect(x+4,y+4,4,5);g.fillRect(x+47,y+4,4,5);g.fillStyle="#16131f";g.fillRect(x+7,y+23,10,5);g.fillRect(x+39,y+23,10,5);g.globalAlpha=.17;g.fillStyle=i%2?"#ff50bf":"#53dfff";g.fillRect(x-6,y+28,68,5);g.globalAlpha=1});
 for(let i=0;i<24;i++){const x=100+(i*397)%2310,y=420+(i*281)%1400,col=i%3===0?"#ffc363":i%3===1?"#ff55d0":"#44dfff";g.globalAlpha=.12;g.fillStyle=col;g.fillRect(x-25,y+9,55,4);g.globalAlpha=1;g.fillStyle="#151626";g.fillRect(x-2,y-16,4,22);g.fillStyle=col;g.fillRect(x-5,y-20,10,6);g.fillStyle="#111522";g.fillRect(x+20,y+28,33,4);g.fillStyle="#5d5265";g.fillRect(x+23,y+31,3,8);g.fillRect(x+47,y+31,3,8)}
 g.fillStyle="#10101e";g.fillRect(1478,738,45,58);g.fillStyle="#5c3c74";g.fillRect(1484,744,32,49);g.fillStyle="#f754b9";g.fillRect(1490,750,20,18);
 g.fillStyle="#0b1220";g.fillRect(1948,731,48,66);g.fillStyle="#37d9f4";g.fillRect(1954,737,36,35);g.fillStyle="#0d1b2a";g.fillRect(1959,741,26,25);for(let y=0;y<4;y++)for(let x=0;x<5;x++){g.fillStyle=["#e64cae","#5cdbfb","#ffbd56","#9d70ff"][(x+y*3)%4];g.fillRect(1962+x*5,744+y*5,3,3)}
 drawLandmarkStructures(g);
 W.districts.forEach(d=>{g.fillStyle="rgba(7,8,20,.72)";g.fillRect(d.x-100,d.y-48,200,27);g.strokeStyle=d.color;g.lineWidth=1;g.strokeRect(d.x-100,d.y-48,200,27);label(g,d.en,d.x,d.y-34,8,d.color,"center")});
 return map
}
const staticMap=makeMap();
for(let i=0;i<44;i++)rain.push({x:Math.random()*W.width,y:Math.random()*W.height,len:7+Math.random()*13,speed:170+Math.random()*180,alpha:.12+Math.random()*.2});

function drawMini(){const w=mini.width,h=mini.height,sx=w/W.width,sy=h/W.height;mctx.clearRect(0,0,w,h);mctx.fillStyle="#11152a";mctx.fillRect(0,0,w,h);mctx.fillStyle="#102a48";mctx.fillRect(2510*sx,0,135*sx,h);mctx.fillStyle="#36334b";mctx.fillRect(2645*sx,0,(W.width-2645)*sx,h);mctx.fillStyle="#34364d";[360,780,1200,1620].forEach(y=>mctx.fillRect(0,y*sy-2,w,4));[540,1080,1620,2160].forEach(x=>mctx.fillRect(x*sx-2,0,4,h));mctx.fillStyle="#746879";W.buildings.forEach(b=>mctx.fillRect(b.x*sx,b.y*sy,b.w*sx,b.h*sy));remote.forEach(p=>{if(!p.interiorId&&!p.rideId){mctx.fillStyle="#63f4d1";mctx.fillRect(p.x*sx-1,p.y*sy-1,3,3)}});if(self&&!interior&&!ride){mctx.fillStyle="#ff65d0";mctx.fillRect(self.x*sx-2,self.y*sy-2,5,5);mctx.strokeStyle="#ffeaff";mctx.strokeRect(self.x*sx-3,self.y*sy-3,7,7)}}
function drawAvatar(x,y,name,color,dir,action,isSelf,now,message,messageUntil){
 const moving=action==="walk",step=moving?Math.floor(now/155)%2:0,bob=moving?(step?-1:1):Math.sin(now/520)*.45;
 ctx.fillStyle="rgba(0,0,0,.52)";ctx.beginPath();ctx.ellipse(x,y+8,14,5,0,0,Math.PI*2);ctx.fill();
 if(moving){ctx.globalAlpha=.24;ctx.fillStyle="#ff62d0";ctx.fillRect(x-12,y+9,24,2);ctx.globalAlpha=1}
 ctx.fillStyle="#13131f";ctx.fillRect(x-8,y-21+bob,16,14);
 ctx.fillStyle="#f0bd99";ctx.fillRect(x-6,y-20+bob,12,10);
 ctx.fillStyle="#2d1c31";ctx.fillRect(x-7,y-22+bob,14,5);ctx.fillRect(x-7,y-18+bob,2,4);
 if(dir==="down"||dir==="left"||dir==="right"){const eyeX=dir==="left"?x-5:dir==="right"?x+3:x-4;ctx.fillStyle="#fff1d8";ctx.fillRect(eyeX,y-16+bob,2,2);if(dir==="down"){ctx.fillRect(x+2,y-16+bob,2,2);ctx.fillStyle="#4a2733";ctx.fillRect(x-1,y-12+bob,2,1)}}
 ctx.fillStyle=color||"#b77aff";ctx.fillRect(x-9,y-9+bob,18,15);
 ctx.fillStyle="rgba(255,255,255,.45)";ctx.fillRect(x-5,y-7+bob,3,2);ctx.fillRect(x+2,y-7+bob,3,2);
 const armSwing=moving?(step?2:-2):0;ctx.fillStyle="#eeb994";ctx.fillRect(x-11,y-7+bob+armSwing,3,9);ctx.fillRect(x+8,y-7+bob-armSwing,3,9);
 ctx.fillStyle="#242237";ctx.fillRect(x-7,y+6+bob,5,5);ctx.fillRect(x+2,y+6+bob,5,5);
 ctx.fillStyle="#28223a";ctx.fillRect(x-7-(step?2:0),y+10+bob+(step?0:1),5,4);ctx.fillRect(x+2+(step?2:0),y+10+bob+(step?1:0),5,4);
 const lw=Math.max(42,Math.min(112,name.length*7+15));ctx.fillStyle="rgba(9,8,24,.9)";ctx.fillRect(x-lw/2,y-45+bob,lw,15);ctx.strokeStyle=isSelf?"#ff71d5":"rgba(126,240,255,.55)";ctx.strokeRect(x-lw/2,y-45+bob,lw,15);label(ctx,name,x,y-37+bob,8,"#f8f4ff","center");
 if(action&&action!=="idle"&&action!=="walk")label(ctx,action==="wave"?"👋":action==="dance"?"♫":action==="wine"?"🍷":"✋",x,y-60+bob,13,"#fff","center");
 if(message&&messageUntil>Date.now())drawMessageBubble(x,y,message)
}
function drawNpc(n,now){const b=Math.sin(now/650+n.x)*.6;ctx.fillStyle="#20152a";ctx.fillRect(n.x-6,n.y-17+b,12,11);ctx.fillStyle=n.color;ctx.fillRect(n.x-7,n.y-7+b,14,13);ctx.fillStyle="#2c2437";ctx.fillRect(n.x-6,n.y+6+b,5,8);ctx.fillRect(n.x+1,n.y+6+b,5,8);ctx.fillStyle="#efc49d";ctx.fillRect(n.x-4,n.y-17+b,8,8);ctx.fillStyle="#20192b";ctx.fillRect(n.x-6,n.y-19+b,12,4)}
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
function drawPuddles(now){for(let i=0;i<19;i++){const x=(i*271+45)%W.width,y=(i*193+111)%W.height;ctx.globalAlpha=.1+(Math.sin(now/490+i)+1)*.035;ctx.fillStyle=Math.sin(now/700+i*1.9)>0?"#cb47b8":"#35bada";ctx.fillRect(x,y,22+(i%4)*8,2);ctx.fillRect(x+5,y+4,12,1)}ctx.globalAlpha=1}
function drawInterior(){const w=canvas.clientWidth,h=canvas.clientHeight,type=interior.type,warm=type==="bakery"?"#4a271f":type==="arcade"?"#201d3d":type==="internet"?"#1d3040":"#382336";ctx.fillStyle=warm;ctx.fillRect(0,0,w,h);ctx.fillStyle="#241a2a";ctx.fillRect(0,0,w,h*.63);ctx.fillStyle="#6d4550";ctx.fillRect(0,h*.63,w,h*.37);for(let x=0;x<w;x+=52){ctx.fillStyle=x%104?"#332537":"#3b2a3b";ctx.fillRect(x,h*.63,50,h*.37)}for(let i=0;i<5;i++){const x=w*(.12+i*.17);ctx.fillStyle="#130f20";ctx.fillRect(x,h*.16,75,108);ctx.globalAlpha=.7;ctx.fillStyle=i%2?"#bc5398":"#e9a95b";ctx.fillRect(x+7,h*.16+7,61,94);ctx.globalAlpha=1;ctx.fillStyle="#291e32";ctx.fillRect(x+34,h*.16+7,3,94)}const stuff=type==="arcade"?["🕹","👾","🎮","🕹"]:type==="bakery"?["🥖","☕","🥐","🍞"]:["☕","📻","📼","♫"];for(let i=0;i<4;i++){const x=w*(.18+i*.2),y=h*.52;ctx.fillStyle="#171322";ctx.fillRect(x,y,58,82);ctx.strokeStyle=i%2?"#71edff":"#ff58ce";ctx.lineWidth=2;ctx.strokeRect(x,y,58,82);label(ctx,stuff[i],x+29,y+32,23,"#fff","center");ctx.fillStyle="#79637b";ctx.fillRect(x+12,y+64,34,4)}label(ctx,interior.name,w/2,h*.11,17,interior.color,"center");label(ctx,"1999 · ღამე ჯერ არ მთავრდება",w/2,h*.11+26,10,"#dfd0ed","center");drawAvatar(w/2,h*.72,selfName,"#bd75ef","down","idle",true,performance.now())}
let lastFrameAt=0;
function stepLocalPlayer(dt,now){
 if(!self||!joined||interior||ride)return;
 const canMove=cityDialog.hidden&&playerCard.hidden&&cityMessageComposer.hidden;
 let dx=canMove?keys.x:0,dy=canMove?keys.y:0;
 const length=Math.hypot(dx,dy),moving=length>.001;let moved=false;
 if(moving){dx/=length;dy/=length;const step=165*dt,nx=self.x+dx*step,ny=self.y+dy*step,oldX=self.x,oldY=self.y;
  if(W.isWalkable(nx,self.y,11))self.x=nx;
  if(W.isWalkable(self.x,ny,11))self.y=ny;
  moved=Math.hypot(self.x-oldX,self.y-oldY)>.01;
  if(Math.abs(dx)>Math.abs(dy))self.dir=dx<0?"left":"right";else self.dir=dy<0?"up":"down";
 }
 if(!Number.isFinite(self.actionUntil)||self.actionUntil<=now)self.action=moved?"walk":"idle";
}
function draw(now){
 const w=canvas.clientWidth,h=canvas.clientHeight,d=Math.min(2,devicePixelRatio||1),dt=lastFrameAt?Math.min(.05,Math.max(0,(now-lastFrameAt)/1000)):.016;lastFrameAt=now;
 if(canvas.width!==Math.round(w*d)||canvas.height!==Math.round(h*d))resize();ctx.setTransform(d,0,0,d,0,0);ctx.imageSmoothingEnabled=false;
 if(interior){drawInterior();requestAnimationFrame(draw);return}
 stepLocalPlayer(dt,now);
 if(ride){drawRideScene(w,h,now);requestAnimationFrame(draw);return}
 if(self){camera.x=Math.round(Math.max(0,Math.min(W.width-w,self.x-w/2)));camera.y=Math.round(Math.max(0,Math.min(W.height-h,self.y-h/2)))}
 else{camera.x=Math.max(0,W.width/2-w/2);camera.y=Math.max(0,W.height/2-h/2)}
 ctx.fillStyle="#101020";ctx.fillRect(0,0,w,h);ctx.drawImage(staticMap,-camera.x,-camera.y);ctx.save();ctx.translate(-camera.x,-camera.y);drawPuddles(now);
 W.buildings.forEach((b,i)=>{const pulse=.035+(Math.sin(now/620+i*1.31)+1)*.018;ctx.globalAlpha=pulse;ctx.fillStyle=b.color;ctx.fillRect(b.x+4,b.y+b.h-57,b.w-8,11)});ctx.globalAlpha=1;
 rain.forEach(r=>{r.y+=r.speed*dt;r.x-=18*dt;if(r.y>W.height){r.y=0;r.x=Math.random()*W.width}if(r.x<0)r.x=W.width;ctx.globalAlpha=r.alpha;ctx.fillStyle="#a9d8ff";ctx.fillRect(r.x,r.y,1,r.len)});ctx.globalAlpha=1;
 W.npcs.forEach(n=>drawNpc(n,now));drawCitySignals(now);const chars=[];if(self)chars.push({x:self.x,y:self.y,name:selfName,color:"#bd75ef",dir:self.dir,action:self.action,self:true,message:self.message,messageUntil:self.messageUntil});
 remote.forEach(p=>{if(!p.interiorId&&!p.rideId){const follow=1-Math.exp(-dt*20);p.x+=(p.targetX-p.x)*follow;p.y+=(p.targetY-p.y)*follow;chars.push(p)}});
 chars.sort((a,b)=>a.y-b.y);chars.forEach(p=>{drawAvatar(Math.round(p.x),Math.round(p.y),p.name,p.color,p.dir,p.action,p.self,now,p.message,p.messageUntil);if(p.actionUntil&&p.actionUntil<Date.now())p.action="idle"});
 if(nearby&&nearby.type==="player"){ctx.strokeStyle="#ff6bd4";ctx.lineWidth=2;ctx.strokeRect(nearby.object.x-16,nearby.object.y-27,32,42)}
 ctx.restore();if(now-lastMiniAt>250){drawMini();lastMiniAt=now}requestAnimationFrame(draw)
}
function target(){if(!self||interior||ride)return null;let best=null,dist=102;function offer(type,o,x,y){const d=Math.hypot(x-self.x,y-self.y);if(d<dist){dist=d;best={type:type,object:o,distance:d}}}W.npcs.forEach(n=>offer("npc",n,n.x,n.y));W.props.forEach(p=>offer("prop",p,p.x,p.y));W.buildings.filter(b=>b.enterable).forEach(b=>offer("building",b,b.x+b.w*.72+9,b.y+b.h+15));(W.landmarks||[]).forEach(l=>offer("landmark",l,l.interactX,l.interactY));notes.forEach(n=>offer("note",n,n.x,n.y));remote.forEach(p=>{if(!p.interiorId&&!p.rideId&&p.id!==self.id)offer("player",p,p.x,p.y)});return best}
function refresh(){nearby=target();const tip=document.getElementById("cityTip");if(nearby){const o=nearby.object,n=nearby.type==="npc"?o.name:nearby.type==="player"?o.name:nearby.type==="building"?o.name:nearby.type==="landmark"?o.name:nearby.type==="note"?"საიდუმლო წერილი":o.label;tip.textContent="E / ✦  "+n}else tip.textContent="ქუჩის კუთხეში ძველი ტელეფონი რეკავს — იქნებ შენ გეძახის?";const d=self&&W.districtAt(self.x,self.y);if(d&&d.id!==lastDistrict){lastDistrict=d.id;locationPill.innerHTML="<b>"+d.name+"</b><span>2:17 AM · ყოველთვის ღამე</span>"}}
setInterval(refresh,160);
function closeDialog(){cityDialog.hidden=true}
function showDialog(k,title,message,actions){document.getElementById("dialogKicker").textContent=k||"ღამის ქალაქი";document.getElementById("dialogTitle").textContent=title||"";document.getElementById("dialogText").textContent=message||"";const box=document.getElementById("dialogActions");box.replaceChildren();(actions||[]).forEach(a=>{const b=document.createElement("button");b.type="button";b.textContent=a.label;b.addEventListener("click",a.run);box.appendChild(b)});cityDialog.hidden=false}
document.getElementById("dialogClose").addEventListener("click",closeDialog);document.getElementById("playerCardClose").addEventListener("click",()=>playerCard.hidden=true);
function leaveInterior(){if(!interior)return;interior=null;document.getElementById("interiorExit").hidden=true;locationPill.innerHTML="<b>"+W.districtAt(self?self.x:420,self?self.y:440).name+"</b><span>2:17 AM · ყოველთვის ღამე</span>";if(socket)socket.emit("city:interior",{buildingId:null})}
document.getElementById("interiorExit").addEventListener("click",leaveInterior);

function open(t){if(!t){toast("ახლოს არაფერია — ცოტა გაისეირნე.");return}if(t.type==="note"){socket&&socket.emit("city:note:claim",{id:t.object.id},r=>{if(r&&r.error)toast(r.error)});return}if(t.type==="landmark"){openLandmark(t.object);return}if(t.type==="player"){selectedPlayerName=t.object.name;document.getElementById("playerCardName").textContent=selectedPlayerName;playerCard.dataset.targetId=t.object.id;updatePlayerActions();playerCard.hidden=false;return}playerCard.hidden=true;if(t.type==="npc"){showDialog(t.object.role,t.object.name,t.object.line,[{label:"👋 მივესალმო",run:()=>{closeDialog();toast(t.object.name+" გიღიმის.");cue(560)}},{label:"კარგ საღამოს",run:closeDialog}]);cue(490);return}if(t.type==="prop"){showDialog("ქალაქის პატარა საიდუმლო",t.object.label,t.object.line,[{label:"კარგი ამბავია",run:()=>{closeDialog();toast("ქალაქმა პატარა მოგონება გაგიზიარა.");cue(680)}}]);return}if(t.type==="building"){const b=t.object;showDialog("ღიაა ამ ღამით",b.name,"ნეონის შუქი კარს ქვემოდან ანათებს. შეგიძლია ცოტა ხნით შეიხედო და მერე ისევ ქუჩაში დაბრუნდე.",[{label:"შიგნით შევიდე",run:()=>{interior=b;closeDialog();playerCard.hidden=true;locationPill.innerHTML="<b>"+b.name+"</b><span>1999 · ყოველთვის ღამე</span>";document.getElementById("interiorExit").hidden=false;if(socket)socket.emit("city:interior",{buildingId:b.id});cue(720)}},{label:"მოგვიანებით",run:closeDialog}])}}

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
 const note=document.getElementById("playerChatNote");note.hidden=isFriend;
 note.textContent=incoming?"ამ მოთამაშემ მეგობრობის მოთხოვნა გამოგიგზავნა.":outgoing?"მოთხოვნა გაგზავნილია — პირად ჩატს მიღების შემდეგ გახსნი.":"პირადი ჩატი მეგობრებს შორისაა. დაამატე მეგობრად, რომ მისწერო.";
}
function replaceFriends(list){friendNames.clear();(list||[]).forEach(f=>{const n=typeof f==="string"?f:f&&(f.lc||f.username);if(n)friendNames.add(String(n).toLowerCase())});updatePlayerActions()}
function openCityMessageComposer(mode,targetId){composerMode=mode||"city";messageTargetId=targetId||null;playerCard.hidden=true;cityMessageComposer.hidden=false;const title=document.getElementById("cityMessageTitle"),desc=cityMessageComposer.querySelector("p"),input=document.getElementById("cityMessageInput"),send=document.getElementById("cityMessageSend");if(composerMode==="note"){title.textContent="საიდუმლო წერილი";desc.textContent="ქაღალდის თვითმფრინავს ნარიყალიდან ქვემოთ გაუშვებ.";input.placeholder="დატოვე ღამის საიდუმლო…";send.textContent="თვითმფრინავის გაშვება ↗"}else if(composerMode==="wine"){title.textContent="ღვინის შეთავაზება";desc.textContent="ეს პირადი შეტყობინება მხოლოდ ამ მოთამაშეს მიუვა.";input.placeholder="რა გინდა უთხრა?";send.textContent="პირადად გაგზავნა ↗"}else if(composerMode==="ride"){title.textContent="საბაგიროს პირადი ჩატი";desc.textContent="ამ შეტყობინებას მხოლოდ შენ და მგზავრი ხედავთ.";input.placeholder="რას ეტყვი მგზავრს?";send.textContent="მგზავრს გაგზავნა ↗"}else{title.textContent="ქალაქში თქვი რამე";desc.textContent="შენი სიტყვა რამდენიმე წამით პერსონაჟის თავზე გამოჩნდება.";input.placeholder="რას ეტყვი ღამის ქალაქს?";send.textContent="გაგზავნა ↗"}held.clear();keys.x=keys.y=0;updateKeys();input.value="";updateCityMessageCount();setTimeout(()=>input.focus(),30)}
function closeCityMessageComposer(){cityMessageComposer.hidden=true;composerMode="city";messageTargetId=null}
function updateCityMessageCount(){const input=document.getElementById("cityMessageInput"),button=document.getElementById("cityMessageSend");document.getElementById("cityMessageCount").textContent=input.value.length+"/120";button.disabled=!input.value.trim()}
document.getElementById("playerSayButton").addEventListener("click",openCityMessageComposer);
document.getElementById("cityMessageClose").addEventListener("click",closeCityMessageComposer);
document.getElementById("cityMessageInput").addEventListener("input",updateCityMessageCount);
document.getElementById("cityMessageInput").addEventListener("keydown",e=>{if(e.key==="Enter"&&(e.ctrlKey||e.metaKey)){e.preventDefault();document.getElementById("cityMessageForm").requestSubmit()}});
document.getElementById("cityMessageForm").addEventListener("submit",e=>{e.preventDefault();const input=document.getElementById("cityMessageInput"),button=document.getElementById("cityMessageSend"),text=input.value.trim();if(!text)return;if(!socket||!joined){toast("ქალაქთან კავშირი არ არის");return}button.disabled=true;const done=r=>{button.disabled=false;if(!r||r.error){toast(r&&r.error||"შეტყობინება ვერ გაიგზავნა");updateCityMessageCount();return}input.value="";updateCityMessageCount();closeCityMessageComposer();toast("შეტყობინება გაგზავნილია ✨")};if(composerMode==="note")socket.emit("city:note:drop",{text},done);else if(composerMode==="wine")socket.emit("city:mother:message",{targetId:messageTargetId,text},done);else if(composerMode==="ride")socket.emit("city:ride:message",{text},done);else socket.emit("city:message",{text},done)});
document.getElementById("playerMessageButton").addEventListener("click",()=>{if(!selectedPlayerName||!friendNames.has(selectedPlayerName.toLowerCase()))return;window.location.href="/friend-chat.html?friend="+encodeURIComponent(selectedPlayerName)});
document.getElementById("playerAddFriendButton").addEventListener("click",()=>{const name=selectedPlayerName,lc=name.toLowerCase();if(!name||!socket||!joined||friendNames.has(lc))return;outgoingFriendRequests.add(lc);updatePlayerActions();socket.emit("friend:request",{toUsername:name});toast("მეგობრობის მოთხოვნა გაიგზავნა. პირად ჩატს მიღების შემდეგ გახსნი.",3600)});
document.getElementById("playerAcceptFriendButton").addEventListener("click",()=>{if(!selectedPlayerName||!socket)return;socket.emit("friend:accept",{fromUsername:selectedPlayerName});toast("მეგობრობის მოთხოვნას ვიღებ...")});
function selectPlayer(id){const p=remote.get(id);if(!p||p.interiorId||p.rideId||!self||Math.hypot(p.x-self.x,p.y-self.y)>126)return false;open({type:"player",object:p});return true}
function canvasPoint(e){const r=canvas.getBoundingClientRect();return{x:e.clientX-r.left+camera.x,y:e.clientY-r.top+camera.y}}
canvas.addEventListener("pointerdown",e=>{if(interior||ride)return;const p=canvasPoint(e);let noteHit=null;for(const n of notes)if(Math.hypot(n.x-p.x,n.y-p.y)<30){noteHit=n;break}if(noteHit){open({type:"note",object:noteHit});return}let chosen=null,best=34;remote.forEach(o=>{if(o.interiorId||o.rideId||!self||Math.hypot(o.x-self.x,o.y-self.y)>145)return;const d=Math.hypot(o.x-p.x,o.y-p.y);if(d<best){best=d;chosen=o}});if(chosen){selectPlayer(chosen.id);return}if(nearby&&nearby.distance<96){open(nearby);return}if(e.pointerType!=="mouse"&&self){const dx=p.x-self.x,dy=p.y-self.y,n=Math.hypot(dx,dy)||1;keys.x=dx/n;keys.y=dy/n;sendCityInputNow();window.setTimeout(()=>{if(!touchHeld){keys.x=0;keys.y=0;sendCityInputNow()}},420)}});
document.querySelectorAll("[data-emote]").forEach(b=>b.addEventListener("click",()=>{if(!socket||!joined)return;socket.emit("city:emote",{targetId:playerCard.dataset.targetId,emote:b.dataset.emote},r=>{if(r&&r.error){toast(r.error);return}playerCard.hidden=true;toast(b.dataset.emote==="wave"?"👋 მიესალმე მოთამაშეს":b.dataset.emote==="dance"?"♫ ცეკვავ ნეონის ქვეშ":"🖐 High-five!");cue(590)} )}));
function interact(){if(interior)return;open(target())}document.getElementById("touchInteract").addEventListener("click",interact);
const held=new Set(),codeDir={ArrowUp:[0,-1],KeyW:[0,-1],ArrowDown:[0,1],KeyS:[0,1],ArrowLeft:[-1,0],KeyA:[-1,0],ArrowRight:[1,0],KeyD:[1,0]};
function updateKeys(){keys.x=(held.has("ArrowRight")||held.has("KeyD")?1:0)-(held.has("ArrowLeft")||held.has("KeyA")?1:0);keys.y=(held.has("ArrowDown")||held.has("KeyS")?1:0)-(held.has("ArrowUp")||held.has("KeyW")?1:0);sendCityInputNow()}
function sendCityInputNow(){if(!socket||!joined||!self||interior||ride)return;const active=cityDialog.hidden&&playerCard.hidden&&cityMessageComposer.hidden;const x=active?keys.x:0,y=active?keys.y:0;socket.emit("city:input",{x:x,y:y},r=>{if(r&&Number.isFinite(r.x)&&Math.hypot(keys.x,keys.y)<.01){self.x=r.x;self.y=r.y;self.action="idle"}})}
document.addEventListener("keydown",e=>{if(e.target&&/INPUT|TEXTAREA|SELECT/.test(e.target.tagName))return;if(codeDir[e.code]){e.preventDefault();held.add(e.code);updateKeys()}else if(e.code==="KeyE"||e.code==="Space"){e.preventDefault();interact()}else if(e.code==="Escape"){closeDialog();playerCard.hidden=true;closeCityMessageComposer();if(interior)leaveInterior()}});
document.addEventListener("keyup",e=>{held.delete(e.code);updateKeys()});addEventListener("blur",()=>{held.clear();keys.x=keys.y=0;sendCityInputNow()});document.addEventListener("visibilitychange",()=>{if(document.hidden){held.clear();keys.x=keys.y=0;sendCityInputNow()}});
let touchHeld=false;document.querySelectorAll(".touch-pad [data-dir]").forEach(b=>{const vals={up:[0,-1],down:[0,1],left:[-1,0],right:[1,0]},start=e=>{e.preventDefault();touchHeld=true;b.classList.add("is-held");keys.x=vals[b.dataset.dir][0];keys.y=vals[b.dataset.dir][1];sendCityInputNow()},stop=e=>{e.preventDefault();touchHeld=false;b.classList.remove("is-held");keys.x=keys.y=0;sendCityInputNow()};b.addEventListener("pointerdown",start);b.addEventListener("pointerup",stop);b.addEventListener("pointercancel",stop);b.addEventListener("pointerleave",stop)});
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
 socket.on("disconnect",()=>{joined=false;ride=null;document.getElementById("cityRideOverlay").hidden=true;signals=[];notes=[];renderSignalList();presence("is-off","კავშირი გაწყდა");remote.clear();onlineCount.textContent="1"});
 socket.on("city:joined",d=>{joined=true;self=d.self;signals=d.signals||[];notes=d.notes||[];renderSignalList();remote.clear();(d.players||[]).forEach(p=>{if(p.id!==self.id)remote.set(p.id,Object.assign({},p,{targetX:p.x,targetY:p.y}))});presence("is-on","ქალაქში ხარ");refresh();drawMini();cue(760)});
 socket.on("city:error",d=>toast(d&&d.message||"ქალაქთან დაკავშირება ვერ მოხერხდა"));
 socket.on("city:snapshot",d=>{if(!self||!d||!Array.isArray(d.players))return;const seen=new Set();d.players.forEach(p=>{if(p.id===self.id){self.dir=p.dir;if(Math.hypot(keys.x,keys.y)<.01)self.action=p.action||"idle";return}seen.add(p.id);let old=remote.get(p.id);if(!old)old=Object.assign({},p,{targetX:p.x,targetY:p.y});old.name=p.name;old.color=p.color;old.dir=p.dir;old.action=p.action||"idle";old.targetX=p.x;old.targetY=p.y;old.interiorId=p.interiorId||null;old.rideId=p.rideId||null;remote.set(p.id,old)});Array.from(remote.keys()).forEach(id=>{if(!seen.has(id))remote.delete(id)});onlineCount.textContent=String(remote.size+1)});
 socket.on("city:stopped",d=>{if(self&&d&&Math.hypot(keys.x,keys.y)<.01){self.x=d.x;self.y=d.y;self.action="idle"}});
 socket.on("city:signals",d=>{signals=Array.isArray(d)?d:[];renderSignalList()});
 socket.on("city:notes",d=>{notes=Array.isArray(d)?d:[]});
 socket.on("city:note:thrown",d=>{if(d)noteFlights.push({fromX:d.fromX,fromY:d.fromY,x:d.x,y:d.y,startAt:performance.now(),duration:1100})});
 socket.on("city:signal:wave",d=>{if(d&&d.targetId===self?.id)toast(d.name+" ანძის სიგნალიდან მოგესალმა 👋");if(d&&d.fromId===self?.id)toast("სიგნალთან ხელი დაუქნიე 👋")});
 socket.on("city:signal:followed",d=>{if(self&&d){self.x=d.x;self.y=d.y;self.action="wave";self.actionUntil=Date.now()+900}});
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
 socket.on("city:ride:end",d=>{ride=null;document.getElementById("cityRideOverlay").hidden=true;if(self&&d&&Number.isFinite(d.x)){self.x=d.x;self.y=d.y}if(d&&d.message)toast(d.message);sendCityInputNow()});
 socket.on("city:message",d=>{if(!d||!d.id||typeof d.text!=="string")return;const p=self&&d.id===self.id?self:remote.get(d.id);if(!p)return;p.message=String(d.text).slice(0,120);p.messageUntil=Date.now()+5000});
 socket.on("city:emote",d=>{if(!d||!d.from)return;if(self&&d.from.id===self.id){self.action=d.emote;self.actionUntil=Date.now()+1200}if(self&&d.to&&d.to.id===self.id){self.action=d.emote==="highfive"?"highfive":"wave";self.actionUntil=Date.now()+1200}const a=remote.get(d.from.id);if(a){a.action=d.emote;a.actionUntil=Date.now()+1200}const t=remote.get(d.to&&d.to.id);if(t){t.action=d.emote==="highfive"?"highfive":"wave";t.actionUntil=Date.now()+1200}if(d.to&&self&&d.to.id===self.id)toast(d.emote==="wave"?d.from.name+" მოგესალმა 👋":d.from.name+" გთავაზობს high-five-ს 🖐");cue(590)});
 socket.connect()
}
setInterval(()=>{if(!socket||!joined||!self||interior||ride)return;const active=cityDialog.hidden&&playerCard.hidden&&cityMessageComposer.hidden;socket.emit("city:input",{x:active?keys.x:0,y:active?keys.y:0})},45);
document.getElementById("fullscreenButton").addEventListener("click",()=>{const root=document.getElementById("cityApp");if(!document.fullscreenElement&&root.requestFullscreen)root.requestFullscreen().catch(()=>{});else if(document.exitFullscreen)document.exitFullscreen().catch(()=>{})});
document.getElementById("soundButton").addEventListener("click",e=>{soundOn=!soundOn;e.currentTarget.setAttribute("aria-label",soundOn?"ხმოვანი ეფექტების გამორთვა":"ხმოვანი ეფექტების ჩართვა");e.currentTarget.title=soundOn?"ეფექტები ჩართულია":"ხმოვანი ეფექტები";e.currentTarget.textContent=soundOn?"♫":"♪";cue(660);toast(soundOn?"ხმოვანი ეფექტები ჩართულია":"ხმოვანი ეფექტები გამორთულია")});
addEventListener("pagehide",()=>{if(socket&&joined)socket.emit("city:leave")});
drawMini();requestAnimationFrame(draw);connect();
})();

