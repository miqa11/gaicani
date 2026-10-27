(function(root){
 'use strict';
 const box=(g,c,x,y,w,h)=>{g.fillStyle=c;g.fillRect(x,y,w,h);};
 function draw(g,W){
   W.roads.forEach(r=>box(g,'#50485c',r.x-12,r.y-12,r.w+24,r.h+24));
   W.roads.forEach(r=>box(g,'#242a3c',r.x,r.y,r.w,r.h));
   W.roads.forEach((r,index)=>{const horizontal=r.w>r.h;g.fillStyle='#d7bd8b88';
     for(let n=20;n<(horizontal?r.w:r.h);n+=70){const x=horizontal?r.x+n:r.x+r.w/2,y=horizontal?r.y+r.h/2:r.y+n;
       if(W.roads.some((o,i)=>i!==index&&x>o.x-16&&x<o.x+o.w+16&&y>o.y-16&&y<o.y+o.h+16))continue;g.fillRect(x,y,horizontal?30:2,horizontal?2:30);}
   });
   for(const x of [540,1080,1620,2160])for(const y of [360,780,1200,1620]){for(let i=-36;i<42;i+=12){box(g,'#b3a4b583',x+i,y-75,7,18);box(g,'#b3a4b583',x+i,y+57,7,18);}}
   W.parking.forEach(p=>{box(g,'#323047',p.x,p.y,p.w,p.h);g.strokeStyle='#c2a985';g.lineWidth=2;g.strokeRect(p.x,p.y,p.w,p.h);for(let x=p.x+60;x<p.x+p.w;x+=60){g.beginPath();g.moveTo(x,p.y);g.lineTo(x,p.y+p.h-8);g.stroke();}g.fillStyle='#8ee3df';g.font='bold 14px monospace';g.textAlign='left';g.fillText('P',p.x+8,p.y+22);});
   W.buildings.filter(b=>b.enterable).forEach(b=>{const x=b.x+b.w*.72+9,y=b.y+b.h;box(g,'#786375',x-21,y,42,46);for(let n=0;n<4;n++)box(g,'#e1c6a566',x-19,y+n*11,38,2);});
 }
 function bridge(g){box(g,'#50485c',2490,916,350,128);box(g,'#242a3c',2490,928,350,104);box(g,'#bdb1bd',2490,918,350,4);box(g,'#bdb1bd',2490,1038,350,4);for(let x=2500;x<2840;x+=60)box(g,'#d7bd8b88',x,979,30,2);}
 function furniture(g,o){
   if(o.kind==='tree'){root.GaicaniCityGarden.drawTree(g,o.x,o.y,0);return;}
   if(o.kind==='bench'){box(g,'#33243b',o.x-24,o.y-13,48,18);box(g,'#bd8b8e',o.x-22,o.y-12,44,4);box(g,'#8a6677',o.x-24,o.y-2,48,5);box(g,'#363346',o.x-19,o.y+5,4,7);box(g,'#363346',o.x+15,o.y+5,4,7);return;}
   box(g,'#151a2c',o.x-3,o.y-40,6,43);box(g,'#b3a09c',o.x-1,o.y-39,2,35);box(g,'#f7d79a',o.x-8,o.y-46,16,7);
 }
 root.GaicaniCityRoads={draw,bridge,furniture};
})(window);
