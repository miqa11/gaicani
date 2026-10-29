/* Re-render a photo from world layers so unconsenting players never enter the image. */
(function(root){
 'use strict';
 function create({map,buildings,world,getPlayers,getVehicles}){
  return function capturePhoto(options={}){
   const out=document.createElement('canvas');out.width=640;out.height=440;
   const g=out.getContext('2d');g.imageSmoothingEnabled=false;
   const x=Math.max(0,Math.min(world.width-600,(Number(options.x)||0)-300));
   const y=Math.max(0,Math.min(world.height-360,(Number(options.y)||0)-180));
   const frame=['neon','gold','mint'].includes(options.frame)?options.frame:'neon';
   const color={neon:'#f878d6',gold:'#ffe39a',mint:'#90ffcf'}[frame];
   g.fillStyle='#101325';g.fillRect(0,0,640,440);g.strokeStyle=color;g.lineWidth=3;g.strokeRect(8,8,624,424);
   g.save();g.beginPath();g.rect(20,20,600,360);g.clip();g.translate(20-x,20-y);g.drawImage(map,0,0);
   const allowed=new Set(Array.isArray(options.allowedPlayerIds)?options.allowedPlayerIds:[]);
   const people=getPlayers().filter(p=>allowed.has(p.id)&&!p.interiorId&&!p.rideId);
   const objects=buildings.map(b=>({y:b.b.y+b.b.h,kind:'building',value:b}));
   world.furniture.forEach(f=>objects.push({y:f.y,kind:'furniture',value:f}));
   (world.garden?.trees||[]).forEach(t=>objects.push({y:t.y,kind:'tree',value:t}));
   getVehicles().forEach(v=>objects.push({y:v.y,kind:'car',value:v}));
   [...world.npcs,...(world.garden?.npcs||[]),...(root.GaicaniCityActivitiesData?.npcs||[])].forEach(p=>objects.push({y:p.y,kind:'person',value:p}));
   people.filter(p=>!p.vehicleId).forEach(p=>objects.push({y:p.y,kind:'person',value:p}));
   for(const item of objects.sort((a,b)=>a.y-b.y)){
    const p=item.value;
    if(item.kind==='building'){g.drawImage(p.image,p.b.x-60,p.b.y-100);continue;}
    if(p.x<x-100||p.y<y-100||p.x>x+700||p.y>y+460)continue;
    if(item.kind==='furniture'){root.GaicaniCityRoads.furniture(g,p);continue;}
    if(item.kind==='tree'){root.GaicaniCityGarden.drawTree(g,p.x,p.y);continue;}
    if(item.kind==='car'){
     // Strip occupant names, faces, and transitions unless explicitly authorized.
     const clean={...p,transition:null,seats:p.seats.map(s=>allowed.has(s.playerId)?{...s}:{...s,playerId:null,name:'',color:''})};
     root.GaicaniCityVehicleArt.draw(g,clean,performance.now(),{x:p.x,y:p.y});continue;
    }
    const yellow=String(p.id||'').startsWith('g-');
    g.fillStyle='#07091880';g.fillRect(p.x-10,p.y+10,20,4);
    g.fillStyle=yellow?'#ffe16b':'#efc49d';g.fillRect(p.x-6,p.y-20,12,12);
    g.fillStyle=p.color||'#b69af1';g.fillRect(p.x-7,p.y-8,14,15);
    g.fillStyle='#28243e';g.fillRect(p.x-6,p.y+7,5,9);g.fillRect(p.x+1,p.y+7,5,9);
    g.fillStyle='#242137';g.fillRect(p.x-3,p.y-16,2,2);g.fillRect(p.x+2,p.y-16,2,2);
    if(options.pose==='wave'){g.fillStyle=yellow?'#ffe16b':'#efc49d';g.fillRect(p.x+7,p.y-17,4,14);}
    if(options.pose==='dance'){g.fillStyle=p.color||'#b69af1';g.fillRect(p.x-15,p.y-8,8,4);g.fillRect(p.x+7,p.y-8,8,4);}
   }
   g.restore();g.fillStyle=color;g.textAlign='center';g.font='bold 15px monospace';g.fillText('GAICANI • TBILISI 1999',320,402);
   g.font='11px monospace';g.fillStyle='#d0c7e4';g.fillText(String(options.title||'A night in the city').slice(0,70),320,422);
   if(options.sticker==='star'){g.fillStyle='#ffe16b';g.font='30px monospace';g.fillText('★',592,60);}
   return out;
  };
 }
 root.GaicaniCityPhoto={create};
})(window);
